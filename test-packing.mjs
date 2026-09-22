import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAppServer } from './server.mjs';
import { analyzePacking, buildPackingPayload } from './packing.mjs';
import { ITEMS } from './travel/catalog.mjs';

async function withServer(options, run) {
  const server = createAppServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await run(url); } finally { await new Promise(resolve => server.close(resolve)); }
}

const request = trip => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trip }) });
const answerResponse = (payload, values = {}, extra = {}) => new Response(JSON.stringify({
  model: 'jev-latest',
  answers: Object.fromEntries(Object.keys(payload.questions).map(id => [id, { type: 'noul', noul: values[id] ?? (id === 'valid_trip' ? .98 : .1) }])),
  usage: { input_tokens: 123, output_tokens: 45 },
  ...extra,
}));

test('packing forwards the trip to Jev and only returns relevant known objects', async () => {
  let sent;
  await withServer({ key: 'secret-test', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.headers.Authorization, 'Bearer secret-test');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    sent = JSON.parse(options.body);
    return answerResponse(sent, { passport: .95, backpack: .62, swimsuit: .619 }, { other: 'secret-test' });
  } }, async url => {
    const response = await fetch(url + '/api/pack', request('  去东京玩五天，不带电脑  '));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.source, 'live');
    assert.equal(result.model, 'jev-latest');
    assert.equal(result.trip, '去东京玩五天，不带电脑');
    assert.deepEqual(result.selected, [{ id: 'passport', probability: .95 }, { id: 'backpack', probability: .62 }]);
    assert.equal(result.assumed_month, new Date().getMonth() + 1);
    assert.equal(result.month_source, 'current');
    assert.ok(Number.isFinite(result.elapsed_ms));
    assert.deepEqual(result.usage, { input_tokens: 123, output_tokens: 45 });
    assert.equal(JSON.stringify(result).includes('secret-test'), false);
    assert.equal(sent.model, 'jev-latest');
    assert.equal(sent.state.trip, '去东京玩五天，不带电脑');
    assert.equal(sent.state.current_month, new Date().getMonth() + 1);
    assert.equal(sent.state.current_year, new Date().getFullYear());
    assert.equal(typeof sent.state.assumptions, 'string');
    assert.ok(Object.keys(sent.questions).length >= 51 && Object.keys(sent.questions).length <= 61);
    assert.ok(Object.values(sent.questions).every(question => question.type === 'noul' && question.instructions));
    assert.match(sent.questions.passport.instructions, /护照/);
  });
});

test('packing rejects malformed input and unsafe requests before model invocation', async () => {
  let calls = 0;
  await withServer({ key: 'secret-test', fetchImpl: () => { calls++; throw Error('unexpected'); } }, async url => {
    for (const trip of [undefined, null, 3, {}, '', ' ', 'x', 'x'.repeat(501)]) {
      assert.equal((await fetch(url + '/api/pack', request(trip))).status, 400);
    }
    assert.equal((await fetch(url + '/api/pack', { ...request('去巴黎三天'), body: '{' })).status, 400);
    assert.equal((await fetch(url + '/api/pack', { ...request('去巴黎三天'), headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await fetch(url + '/api/pack', { ...request('去巴黎三天'), headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' } })).status, 403);
    const invalidHostStatus = await new Promise((resolve, reject) => {
      const req = http.request(url + '/api/pack', { method: 'POST', headers: { Host: 'attacker.example', 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end(JSON.stringify({ trip: '去巴黎三天' }));
    });
    assert.equal(invalidHostStatus, 403);
    assert.equal((await fetch(url + '/api/pack', request('x'.repeat(60001)))).status, 413);
    assert.equal(calls, 0);
  });
});

test('packing accepts only JSON media types and does not invoke Jev for JSON-like text', async () => {
  let calls = 0;
  await withServer({ key: 'secret-test', fetchImpl: () => { calls++; throw Error('unexpected'); } }, async url => {
    const response = await fetch(url + '/api/pack', { ...request('去杭州三天'), headers: { 'Content-Type': 'application/jsonp' } });
    assert.equal(response.status, 415);
    assert.equal(calls, 0);
  });
});

test('packing asks for both destination and duration when Jev finds the trip incomplete', async () => {
  await withServer({ key: 'secret-test', fetchImpl: async (_url, options) => answerResponse(JSON.parse(options.body), { valid_trip: .1 }) }, async url => {
    const response = await fetch(url + '/api/pack', request('随便出去走走'));
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /目的地.*天数|目的地.*多久/);
  });
});

test('packing keeps an empty selection instead of inventing fallback objects', async () => {
  await withServer({ key: 'secret-test', fetchImpl: async (_url, options) => answerResponse(JSON.parse(options.body)) }, async url => {
    const response = await fetch(url + '/api/pack', request('上海玩一周'));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).selected, []);
  });
});

test('packing caps large selections at the strongest 24 known objects in catalog order', async () => {
  await withServer({ key: 'secret-test', fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    const response = await answerResponse(payload, Object.fromEntries(Object.keys(payload.questions).map(id => [id, id === 'laptop' ? .99 : .8]))).json();
    response.answers.untrusted_object = { type: 'noul', noul: 1 };
    return new Response(JSON.stringify(response));
  } }, async url => {
    const result = await (await fetch(url + '/api/pack', request('东京工作一个星期'))).json();
    assert.equal(result.selected.length, 24);
    assert.ok(result.selected.some(item => item.id === 'laptop' && item.probability === .99));
    assert.equal(result.selected.some(item => item.id === 'untrusted_object'), false);
    const indices = result.selected.map(item => ITEMS.findIndex(candidate => candidate.id === item.id));
    assert.ok(indices.every((index, position) => index >= 0 && (position === 0 || index > indices[position - 1])));
  });
});

test('packing month metadata distinguishes the current season from explicit dates', async () => {
  const now = new Date(2026, 11, 15);
  for (const [trip, month, source] of [
    ['杭州三天', 12, 'current'], ['12月去杭州三天', 12, 'explicit'], ['十一月去杭州三天', 11, 'explicit'],
    ['2027-02-02 去杭州三天', 2, 'explicit'], ['2027/03/05 去杭州三天', 3, 'explicit'],
    ['Tokyo for five days in May', 5, 'explicit'], ['下个月去杭州三天', 1, 'explicit'], ['本月去杭州三天', 12, 'explicit'],
  ]) {
    const result = await analyzePacking(trip, { key: 'secret-test', now, fetchImpl: async (_url, options) => answerResponse(JSON.parse(options.body)) });
    assert.equal(result.status, 200);
    assert.equal(result.data.assumed_month, month, trip);
    assert.equal(result.data.month_source, source, trip);
    const payload = buildPackingPayload(trip, now);
    assert.equal(payload.state.current_month, 12);
    assert.equal(payload.state.current_year, 2026);
  }
});

test('packing rejects incomplete and invalid model probabilities', async () => {
  const corruptions = [
    answers => { delete answers.passport; },
    answers => { delete answers.valid_trip; },
    answers => { answers.passport.noul = -0.1; },
    answers => { answers.passport.noul = 1.1; },
    answers => { answers.passport.noul = null; },
    answers => { answers.passport.noul = '0.8'; },
  ];
  for (const corrupt of corruptions) {
    await withServer({ key: 'secret-test', fetchImpl: async (_url, options) => {
      const response = await answerResponse(JSON.parse(options.body)).json();
      corrupt(response.answers);
      return new Response(JSON.stringify(response));
    } }, async url => {
      const response = await fetch(url + '/api/pack', request('杭州玩三天'));
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /结果不完整/);
    });
  }
});

test('packing reports safe model and connection errors without exposing upstream text or secrets', async () => {
  for (const status of [400, 401, 402, 403, 429, 500]) {
    await withServer({ key: 'secret-test', fetchImpl: async () => new Response('private upstream secret-test', { status }) }, async url => {
      const response = await fetch(url + '/api/pack', request('去纽约五天'));
      assert.equal(response.status, 502);
      const text = await response.text();
      assert.equal(text.includes('secret-test'), false);
      assert.equal(text.includes('private upstream'), false);
    });
  }
  for (const fetchImpl of [async () => { throw new DOMException('secret-test', 'TimeoutError'); }, async () => { throw Error('secret-test'); }, async () => new Response('not JSON')]) {
    await withServer({ key: 'secret-test', fetchImpl }, async url => {
      const response = await fetch(url + '/api/pack', request('去纽约五天'));
      assert.equal(response.status, 502);
      assert.equal((await response.text()).includes('secret-test'), false);
    });
  }
  await withServer({}, async url => {
    const response = await fetch(url + '/api/pack', request('去纽约五天'));
    assert.equal(response.status, 503);
  });
});

test('travel serves allowlisted public files but keeps credentials and backend source private', async () => {
  await withServer({ key: 'secret-test' }, async url => {
    const response = await fetch(url + '/travel/catalog.mjs');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.match(await response.text(), /export const ITEMS/);
    const head = await fetch(url + '/travel/catalog.mjs', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    for (const path of ['/.env', '/server.mjs', '/packing.mjs', '/test-packing.mjs', '/travel/.env', '/travel/../.env', '/travel/%2e%2e/.env', '/travel/not-allowed.mjs', '/node_modules/matter-js/package.json']) {
      assert.equal((await fetch(url + path)).status, 404);
    }
  });
});
