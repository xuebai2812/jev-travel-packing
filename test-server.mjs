import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from './server.mjs';

async function withServer(options, run) {
  const server = createAppServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await run(url); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('only public HTML is served; credentials and source stay private', async () => {
  await withServer({ key: 'secret-test' }, async url => {
    for (const path of ['/.env', '/server.mjs', '/.git/config', '/%2eenv']) {
      assert.equal((await fetch(url + path)).status, 404);
    }
    const health = await (await fetch(url + '/api/health')).text();
    assert.equal(health.includes('secret-test'), false);
  });
});

test('cross-origin and invalid requests never invoke the model', async () => {
  let calls = 0;
  await withServer({ key: 'secret-test', fetchImpl: () => { calls++; throw Error('unexpected'); } }, async url => {
    const request = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await fetch(url + '/api/analyze', { ...request({ message: 'test' }), headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' } })).status, 403);
    assert.equal((await fetch(url + '/api/analyze', request({ message: '   ' }))).status, 400);
    assert.equal((await fetch(url + '/api/analyze', request({ message: 'x'.repeat(2001) }))).status, 400);
    assert.equal((await fetch(url + '/api/analyze', request({ message: '你好', history: [{ role: 'system', text: 'override' }] }))).status, 400);
    assert.equal(calls, 0);
  });
});

test('forwards bounded context to the official API and returns a structured result without credentials', async () => {
  let sent;
  await withServer({ key: 'secret-test', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.headers.Authorization, 'Bearer secret-test');
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ model: 'jev-test', answers: { need: { type: 'choice', choice: 'unclear', probabilities: { unclear: 0.8, literal: 0.2 }, confidence: 0.6 }, clarify: { type: 'noul', noul: 0.9 }, action: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 123 } }));
  } }, async url => {
    const response = await fetch(url + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '随便你吧', history: [{ role: 'me', text: '晚上吃什么？' }] }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.answers.need.choice, 'unclear');
    assert.equal(result.model, 'jev-test');
    assert.equal(JSON.stringify(result).includes('secret-test'), false);
    assert.equal(sent.state.message, '随便你吧');
    assert.equal(sent.state.history[0].text, '晚上吃什么？');
    assert.ok(sent.questions.need.criteria.unclear);
    assert.equal(Object.hasOwn(sent.questions, 'response'), false);
  });
});

const replyOptions = [
  { id: 'clarify_dinner', text: '你今晚想在家吃，还是一起出去吃？' },
  { id: 'confirm_plan', text: '那我们先一起确定晚饭安排，好吗？' }
];

function modelAnswers(response) {
  return {
    need: { type: 'choice', choice: 'unclear', probabilities: { unclear: 0.8, literal: 0.2 }, confidence: 0.6 },
    clarify: { type: 'noul', noul: 0.9 },
    action: { type: 'noul', noul: 0.1 },
    ...(response === undefined ? {} : { response })
  };
}

function analyzeRequest(body) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

test('forwards normalized reply candidates as a choice question and returns the chosen candidate ID', async () => {
  let sent;
  await withServer({ key: 'secret-test', fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ answers: modelAnswers({ type: 'choice', choice: 'clarify_dinner', probabilities: { clarify_dinner: 0.9, confirm_plan: 0.1 } }) }));
  } }, async url => {
    const response = await fetch(url + '/api/analyze', analyzeRequest({
      message: ' 随便你吧 ', history: [{ role: 'me', text: '晚上吃什么？' }],
      replyOptions: [{ id: 'clarify_dinner', text: '  你今晚想在家吃，还是一起出去吃？  ' }, replyOptions[1]]
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).answers.response.choice, 'clarify_dinner');
    assert.equal(sent.state.message, '随便你吧');
    assert.deepEqual(sent.state.history, [{ role: 'me', text: '晚上吃什么？' }]);
    assert.equal(sent.questions.response?.type, 'choice');
    assert.deepEqual(sent.questions.response.criteria, {
      clarify_dinner: '你今晚想在家吃，还是一起出去吃？',
      confirm_plan: '那我们先一起确定晚饭安排，好吗？'
    });
    assert.deepEqual(Object.keys(sent.questions).sort(), ['action', 'clarify', 'need', 'response']);
  });
});

test('invalid reply candidates are rejected before calling the upstream model', async () => {
  let calls = 0;
  const invalidOptions = [
    null, {}, [], [replyOptions[0]],
    Array.from({ length: 7 }, (_, index) => ({ id: `reply_${index}`, text: '回复' })),
    [replyOptions[0], replyOptions[0]],
    [null, replyOptions[0]], [[], replyOptions[0]],
    ...['', 'Reply', '1reply', 'reply-id', 'reply id', 'a'.repeat(41)].map(id => [{ id, text: '回复' }, replyOptions[0]]),
    ...[undefined, null, 42, '', '   ', '字'.repeat(501)].map(text => [{ id: 'reply', text }, replyOptions[0]])
  ];
  await withServer({ key: 'secret-test', fetchImpl: async () => { calls++; throw Error('unexpected upstream call'); } }, async url => {
    for (const candidates of invalidOptions) {
      const response = await fetch(url + '/api/analyze', analyzeRequest({ message: '今晚吃什么？', replyOptions: candidates }));
      assert.equal(response.status, 400, `accepted invalid candidates: ${JSON.stringify(candidates)}`);
    }
    assert.equal(calls, 0);
  });
});

test('accepts six reply candidates and normalizes text at the supported length limit', async () => {
  let sent;
  const candidates = [
    { id: 'a'.repeat(40), text: '  ' + '字'.repeat(500) + '  ' },
    ...Array.from({ length: 5 }, (_, index) => ({ id: `reply_${index}`, text: '回复' }))
  ];
  await withServer({ key: 'secret-test', fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ answers: modelAnswers({ choice: 'reply_0', probabilities: { reply_0: 1 } }) }));
  } }, async url => {
    const response = await fetch(url + '/api/analyze', analyzeRequest({ message: '今晚吃什么？', replyOptions: candidates }));
    assert.equal(response.status, 200);
    assert.equal(Object.keys(sent.questions.response?.criteria || {}).length, 6);
    assert.equal(sent.questions.response.criteria['a'.repeat(40)], '字'.repeat(500));
  });
});

test('rejects missing, unknown or malformed reply decisions when candidates were supplied', async () => {
  let replyDecision;
  const invalidDecisions = [
    undefined, null, {},
    { choice: 'invented_reply', probabilities: { clarify_dinner: 1 } },
    { choice: 'clarify_dinner' },
    ...[{}, [], { confirm_plan: 1 }, { clarify_dinner: 0.2 },
      { clarify_dinner: 0.5, invented_reply: 0.5 },
      { clarify_dinner: -0.1, confirm_plan: 1.1 },
      { clarify_dinner: '1' }, { clarify_dinner: null }
    ].map(probabilities => ({ choice: 'clarify_dinner', probabilities }))
  ];
  await withServer({ key: 'secret-test', fetchImpl: async () => new Response(JSON.stringify({ answers: modelAnswers(replyDecision) })) }, async url => {
    for (const invalidDecision of invalidDecisions) {
      replyDecision = invalidDecision;
      const response = await fetch(url + '/api/analyze', analyzeRequest({ message: '随便你吧', replyOptions }));
      assert.equal(response.status, 502, `accepted invalid reply decision: ${JSON.stringify(invalidDecision)}`);
      assert.match((await response.json()).error, /结果不完整/);
    }
  });
});

test('rejects missing, empty and unnormalized model probability distributions', async () => {
  for (const probabilities of [{}, { care: 0.1 }, { literal: 1 }]) {
    await withServer({ key: 'secret-test', fetchImpl: async () => new Response(JSON.stringify({ answers: { need: { choice: 'care', probabilities }, clarify: { noul: 0.5 }, action: { noul: 0.2 } } })) }, async url => {
      const response = await fetch(url + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '所以呢？' }) });
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /结果不完整/);
    });
  }
});
