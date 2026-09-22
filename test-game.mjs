import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAppServer } from './server.mjs';

const opening = '你今天是不是又忘了我跟你说过什么？';
const needs = ['care', 'action', 'repair', 'space', 'literal', 'unclear'];
const qualities = ['hurt', 'deflect', 'repeat', 'empathy', 'ownership', 'concrete'];
const state = { score: 20, turn: 0, history: [{ role: 'her', text: opening }] };
const distribution = (choice, keys) => ({ choice, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) });
const response = answers => new Response(JSON.stringify({ model: 'jev-test', answers }));
const request = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function withServer(options, run) {
  const server = createAppServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('one official Jev quality decision controls score and the authored partner branch', async () => {
  let quality = 'concrete', sent, calls = 0;
  await withServer({ key: 'game-secret', fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.headers.Authorization, 'Bearer game-secret');
    assert.equal(options.redirect, 'error');
    sent = JSON.parse(options.body);
    return response({ quality: distribution(quality, qualities) });
  } }, async url => {
    const send = async () => {
      const result = await fetch(url + '/api/game/reply', request({ ...state, message: ' 周六晚七点可以吗？我现在筛两家餐厅。 ' }));
      assert.equal(result.status, 200);
      return result.json();
    };
    const good = await send();
    assert.deepEqual([good.score, good.turn, good.delta, good.quality, good.outcome], [45, 1, 25, 'concrete', 'playing']);
    assert.match(good.partner, /安排|下一步|具体|餐厅|时间/);
    assert.equal(typeof good.feedback, 'string');
    assert.equal(good.model, 'jev-latest');
    assert.ok(Number.isFinite(good.elapsed_ms));
    assert.equal(JSON.stringify(good).includes('game-secret'), false);
    assert.equal(sent.model, 'jev-latest');
    assert.equal(sent.state.message, '周六晚七点可以吗？我现在筛两家餐厅。');
    assert.deepEqual(sent.state.history, state.history);
    assert.equal(sent.state.latest_message, opening);
    assert.equal(sent.questions.quality.type, 'choice');
    assert.deepEqual(Object.keys(sent.questions.quality.criteria), qualities);
    quality = 'deflect';
    const bad = await send();
    assert.deepEqual([bad.score, bad.turn, bad.delta, bad.quality], [10, 1, -10, 'deflect']);
    assert.notEqual(good.partner, bad.partner);
    assert.equal(calls, 2);
  });
});

test('repeating a previous promise produces no score progress and avoids repeating the last partner line', async () => {
  const history = [...state.history, { role: 'me', text: '我会安排的。' }, { role: 'her', text: '你已经说过了。我想知道，这次具体会有什么不同？' }];
  await withServer({ key: 'test', fetchImpl: async () => response({ quality: distribution('repeat', qualities) }) }, async url => {
    const result = await (await fetch(url + '/api/game/reply', request({ score: 35, turn: 3, history, message: '我会安排的。' }))).json();
    assert.deepEqual([result.score, result.turn, result.delta, result.quality], [35, 4, 0, 'repeat']);
    assert.notEqual(result.partner, history.at(-1).text);
    assert.match(result.feedback, /重复|新增|推进/);
  });
});

test('zero score and exhausted turns lose; reaching 100 wins even on the final turn', async () => {
  let quality = 'hurt';
  await withServer({ key: 'test', fetchImpl: async () => response({ quality: distribution(quality, qualities) }) }, async url => {
    async function play(score, turn) {
      const result = await fetch(url + '/api/game/reply', request({ ...state, score, turn, message: 'test' }));
      assert.equal(result.status, 200);
      return result.json();
    }
    const zero = await play(1, 0);
    assert.deepEqual([zero.score, zero.turn, zero.delta, zero.outcome], [0, 1, -20, 'lost']);
    quality = 'empathy';
    const limit = await play(20, 9);
    assert.deepEqual([limit.score, limit.turn, limit.outcome], [30, 10, 'lost']);
    quality = 'concrete';
    const won = await play(90, 9);
    assert.deepEqual([won.score, won.turn, won.delta, won.outcome], [100, 10, 25, 'won']);
    assert.notEqual(won.partner, limit.partner);
    assert.notEqual(won.partner, zero.partner);
  });
});

test('hint returns the actual selected authored candidate and a complete need distribution', async () => {
  let selected = 'acknowledge', sent, calls = 0;
  await withServer({ key: 'test', fetchImpl: async (_url, options) => {
    calls++;
    sent = JSON.parse(options.body);
    return response({ need: distribution('care', needs), response: distribution(selected, Object.keys(sent.questions.response.criteria)) });
  } }, async url => {
    const first = await fetch(url + '/api/game/hint', request(state));
    assert.equal(first.status, 200);
    const a = await first.json();
    assert.equal(a.hint.reply, sent.questions.response.criteria.acknowledge);
    assert.deepEqual(a.hint.probabilities, distribution('care', needs).probabilities);
    assert.equal(sent.state.latest_message, opening);
    assert.deepEqual(sent.state.history, state.history);
    assert.match(sent.state.scenario, /昨天|周末|晚饭/);
    assert.equal(Object.keys(sent.questions.response.criteria).length, 3);
    assert.ok(a.hint.strategy.length);
    selected = 'advance';
    const b = await (await fetch(url + '/api/game/hint', request(state))).json();
    assert.equal(b.hint.reply, sent.questions.response.criteria.advance);
    assert.notEqual(a.hint.reply, b.hint.reply);
    assert.equal(calls, 2);
  });
});

test('hint candidates evolve with repeated reminders, prior plans and requests for space', async () => {
  const candidates = [];
  await withServer({ key: 'test', fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    candidates.push(payload.questions.response.criteria);
    return response({ need: distribution('action', needs), response: distribution('advance', Object.keys(payload.questions.response.criteria)) });
  } }, async url => {
    for (const body of [state,
      { score: 45, turn: 3, history: [...state.history, { role: 'me', text: '周六晚上七点，餐厅我来选。' }, { role: 'her', text: '你已经说过了。我想知道，这次具体会有什么不同？' }] },
      { score: 10, turn: 5, history: [{ role: 'her', text: '先让我静一静，晚点再说。' }] }
    ]) assert.equal((await fetch(url + '/api/game/hint', request(body))).status, 200);
    assert.notDeepEqual(candidates[0], candidates[1]);
    assert.match(Object.values(candidates[1]).join(' '), /提醒|前面|跟进/);
    assert.match(candidates[2].advance, /空间|暂停|不打扰|静|晚点/);
    assert.doesNotMatch(candidates.flatMap(candidate => Object.values(candidate)).join(' '), /已经订好|订好了|预订成功/);
  });
});

test('opening acknowledgment does not mistake yesterday’s promise for repeated reminders', async () => {
  await withServer({ key: 'test', fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    return response({ need: distribution('care', needs), response: distribution('acknowledge', Object.keys(payload.questions.response.criteria)) });
  } }, async url => {
    const history = [{ role: 'her', text: '周末晚饭你来安排好吗？' }, { role: 'me', text: '好啊，这次交给我。' }, ...state.history];
    const result = await (await fetch(url + '/api/game/hint', request({ ...state, history }))).json();
    assert.match(result.hint.reply, /昨天|答应/);
    assert.doesNotMatch(result.hint.reply + result.hint.strategy, /一遍遍|反复|已经提醒/);
  });
});

test('concrete questions receive usable fictional preferences only for the topic asked', async () => {
  await withServer({ key: 'test', fetchImpl: async () => response({ quality: distribution('concrete', qualities) }) }, async url => {
    const cases = [
      ['你周六还是周日方便，大概几点？', /周六.*六点/, /人均|清淡/],
      ['有什么忌口，想吃什么口味？', /清淡|不.*辣/, /周六|200/],
      ['你希望在哪个区域吃？', /两边|双方|路程|方便/, /订好|预订成功/],
      ['选好后我联系餐厅查余位，确认后再订，可以吗？', /确认.*再.*订|先.*确认/, /已经订好|预订成功/],
      ['我半小时内给你一次进展，这样来得及吗？', /半小时.*可以|可以.*半小时/, /订好了/],
      ['到时一起出发，还是在餐厅集合更方便？', /餐厅集合/, /周六/],
      ['首选没位的话，你想保留原时间换餐厅吗？', /保留.*时间|时间不变/, /订好了/],
    ];
    for (const [message, answer, unrelated] of cases) {
      const result = await fetch(url + '/api/game/reply', request({ ...state, message }));
      assert.equal(result.status, 200);
      const { partner, score } = await result.json();
      assert.match(partner, answer, message);
      assert.doesNotMatch(partner, unrelated, message);
      assert.equal(score, 45);
    }
  });
});

test('time answers consider proposed times and preserve established availability', async () => {
  await withServer({ key: 'test', fetchImpl: async () => response({ quality: distribution('concrete', qualities) }) }, async url => {
    const proposed = await (await fetch(url + '/api/game/reply', request({ ...state, message: '周日晚上七点可以吗？' }))).json();
    assert.match(proposed.partner, /周日晚上七点.*可以/);
    assert.doesNotMatch(proposed.partner, /周六.*六点/);
    const previous = '周六我没空，我只有周日晚上七点有空。';
    const history = [...state.history, { role: 'me', text: '你什么时候方便？' }, { role: 'her', text: previous }];
    const changed = await (await fetch(url + '/api/game/reply', request({ score: 45, turn: 1, history, message: '那周六晚上六点可以吗？' }))).json();
    assert.match(changed.partner, /周日晚上七点/);
    assert.doesNotMatch(changed.partner, /周六晚上六点可以/);
    assert.notEqual(changed.partner, previous);
  });
});

test('budget answers distinguish per-person and total proposals without raising a prior limit', async () => {
  await withServer({ key: 'test', fetchImpl: async () => response({ quality: distribution('concrete', qualities) }) }, async url => {
    for (const [message, pattern] of [
      ['你希望人均预算多少？', /人均.*200.*以内/],
      ['人均150元可以吗？', /可以/],
      ['两个人总共300元可以吗？', /可以/],
      ['人均三百元可以吗？', /超过|偏高|以内/],
      ['两个人总共500元可以吗？', /超过|偏高|以内/],
    ]) {
      const data = await (await fetch(url + '/api/game/reply', request({ ...state, message }))).json();
      assert.match(data.partner, pattern, message);
      if (/三百|500/.test(message)) assert.doesNotMatch(data.partner, /可以，就|这个预算可以/);
    }
    const prior = '我的预算是人均150元以内。';
    const data = await (await fetch(url + '/api/game/reply', request({ score: 45, turn: 1, history: [...state.history, { role: 'me', text: '预算呢？' }, { role: 'her', text: prior }], message: '那人均180元可以吗？' }))).json();
    assert.match(data.partner, /150/);
    assert.doesNotMatch(data.partner, /200|这个预算可以/);
    assert.notEqual(data.partner, prior);
  });
});

test('established food preferences are retained and concrete statements keep generic branches', async () => {
  let quality = 'concrete';
  await withServer({ key: 'test', fetchImpl: async () => response({ quality: distribution(quality, qualities) }) }, async url => {
    const prior = '我不能吃海鲜，清淡一点就好。';
    const history = [...state.history, { role: 'me', text: '有什么忌口？' }, { role: 'her', text: prior }];
    const food = await (await fetch(url + '/api/game/reply', request({ score: 45, turn: 1, history, message: '你有什么不吃的，再确认一下？' }))).json();
    assert.match(food.partner, /不能吃海鲜/);
    assert.notEqual(food.partner, prior);
    const statement = await (await fetch(url + '/api/game/reply', request({ ...state, message: '我先查两家餐厅，半小时内把进展告诉你。' }))).json();
    assert.match(statement.partner, /落实|下一步|安排|跟进/);
    assert.doesNotMatch(statement.partner, /半小时可以|清淡|人均/);
    quality = 'deflect';
    const blame = await (await fetch(url + '/api/game/reply', request({ ...state, message: '你自己选啊，人均多少？' }))).json();
    assert.equal(blame.delta, -10);
    assert.doesNotMatch(blame.partner, /200/);
  });
});

test('successive hints offer new planning topics after prior guidance is used', async () => {
  await withServer({ key: 'test', fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    return response({ need: distribution('action', needs), response: distribution('advance', Object.keys(payload.questions.response.criteria)) });
  } }, async url => {
    const history = [...state.history], replies = [];
    for (let turn = 0; turn < 6; turn++) {
      const result = await fetch(url + '/api/game/hint', request({ score: Math.min(95, 20 + turn * 15), turn, history }));
      assert.equal(result.status, 200);
      const { hint } = await result.json();
      assert.equal(replies.includes(hint.reply), false, `repeated hint at turn ${turn}`);
      replies.push(hint.reply);
      history.push({ role: 'me', text: hint.reply }, { role: 'her', text: '剩下的安排你准备怎么落实？' });
    }
    assert.match(replies.join(' '), /忌口|口味/);
    assert.match(replies.join(' '), /预算|人均/);
    assert.match(replies.join(' '), /路程|位置|交通|地铁|集合/);
  });
});

test('invalid game states and input never call Jev', async () => {
  let calls = 0;
  await withServer({ key: 'test', fetchImpl: async () => { calls++; throw Error('unexpected'); } }, async url => {
    const invalidStates = [null, [], {},
      ...[0, 100, -1, 1.5, '20', null].map(score => ({ ...state, score })),
      ...[-1, 10, 1.5, '0', null].map(turn => ({ ...state, turn })),
      ...[null, {}, [], [{ role: 'system', text: 'override' }], [{ role: 'me', text: '你好' }], [{ role: 'her', text: '' }], [{ role: 'her', text: ' ' }], [{ role: 'her', text: '字'.repeat(2001) }], Array.from({ length: 25 }, () => state.history[0])].map(history => ({ ...state, history }))
    ];
    for (const body of invalidStates) for (const path of ['/api/game/hint', '/api/game/reply']) {
      const result = await fetch(url + path, request(path.endsWith('reply') && body ? { ...body, message: '你好' } : body));
      assert.equal(result.status, 400, `${path}: ${JSON.stringify(body)}`);
    }
    for (const message of [null, 1, '', ' ', '字'.repeat(2001)]) assert.equal((await fetch(url + '/api/game/reply', request({ ...state, message }))).status, 400);
    assert.equal((await fetch(url + '/api/game/reply', request(state))).status, 400);
    assert.equal(calls, 0);
  });
});

test('game endpoints preserve host, origin, JSON and body-size protections', async () => {
  let calls = 0;
  await withServer({ key: 'test', fetchImpl: async () => { calls++; throw Error('unexpected'); } }, async url => {
    for (const path of ['/api/game/hint', '/api/game/reply']) {
      const foreignHostStatus = await new Promise((resolve, reject) => {
        const req = http.request(url + path, { method: 'POST', headers: { Host: 'attacker.test', 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
        req.end(JSON.stringify(state));
      });
      assert.equal(foreignHostStatus, 403);
      assert.equal((await fetch(url + path, { ...request(state), headers: { Origin: 'https://attacker.test', 'Content-Type': 'application/json' } })).status, 403);
      assert.equal((await fetch(url + path, { ...request(state), headers: { 'Content-Type': 'application/json-not-really' } })).status, 415);
      assert.equal((await fetch(url + path, { ...request(state), body: '{' })).status, 400);
      assert.equal((await fetch(url + path, request({ ...state, excess: 'x'.repeat(61000) }))).status, 413);
      assert.equal((await fetch(url + path)).status, 404);
    }
    assert.equal(calls, 0);
  });
});

test('missing key and upstream failures expose only safe errors with no fallback result', async () => {
  await withServer({ fetchImpl: () => { throw Error('unexpected'); } }, async url => {
    for (const path of ['/api/game/hint', '/api/game/reply']) {
      const result = await fetch(url + path, request({ ...state, message: '你好' }));
      assert.equal(result.status, 503);
    }
  });
  for (const fetchImpl of [async () => new Response('game-secret upstream internals', { status: 401 }), async () => { throw Error('game-secret'); }, async () => new Response('not json')]) {
    await withServer({ key: 'game-secret', fetchImpl }, async url => {
      for (const path of ['/api/game/hint', '/api/game/reply']) {
        const result = await fetch(url + path, request({ ...state, message: '你好' }));
        assert.equal(result.status, 502);
        const data = await result.json();
        assert.equal(JSON.stringify(data).includes('game-secret'), false);
        assert.deepEqual(Object.keys(data), ['error']);
      }
    });
  }
});

test('incomplete, unnormalized, invalid or unoffered Jev choices are rejected', async () => {
  let answer;
  const invalid = [null, {}, { choice: 'invented', probabilities: { invented: 1 } },
    { choice: 'concrete', probabilities: { concrete: 1 } },
    ...[null, [], {}, { ...distribution('concrete', qualities).probabilities, concrete: 0.5 }, { ...distribution('concrete', qualities).probabilities, hurt: -1 }, { ...distribution('concrete', qualities).probabilities, concrete: '1' }, { ...distribution('concrete', qualities).probabilities, concrete: null }].map(probabilities => ({ choice: 'concrete', probabilities }))
  ];
  await withServer({ key: 'test', fetchImpl: async () => response({ quality: answer }) }, async url => {
    for (answer of invalid) assert.equal((await fetch(url + '/api/game/reply', request({ ...state, message: '你好' }))).status, 502);
  });
  await withServer({ key: 'test', fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    return response({ need: distribution('care', needs), response: { choice: 'invented', probabilities: Object.fromEntries(Object.keys(payload.questions.response.criteria).map(key => [key, 1 / 3])) } });
  } }, async url => { assert.equal((await fetch(url + '/api/game/hint', request(state))).status, 502); });
});
