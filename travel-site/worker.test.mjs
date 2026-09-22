import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from './worker.mjs';
import { ITEMS } from './travel/catalog.mjs';

const origin = 'https://travel.example';
const env = { TYPESAFE_API_KEY: 'test-only-secret' };
const post = (body, headers = {}) => new Request(origin + '/api/pack', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('HTTPS packing preserves the Jev contract and keeps its key server-side', async () => {
  let calls = 0;
  const worker = createWorker({ fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.headers.Authorization, 'Bearer test-only-secret');
    assert.equal(JSON.parse(options.body).state.trip, '去三亚五天');
    return Response.json({ answers: {
      valid_trip: { noul: 0.99 },
      ...Object.fromEntries(ITEMS.map(item => [item.id, { noul: item.id === 'swimsuit' ? 0.98 : 0.1 }])),
    } });
  } });
  const response = await worker.fetch(post({ trip: ' 去三亚五天 ' }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.trip, '去三亚五天');
  assert.deepEqual(body.selected, [{ id: 'swimsuit', probability: 0.98 }]);
  assert.equal(body.source, 'live');
  assert.equal(typeof body.assumed_month, 'number');
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(body).includes(env.TYPESAFE_API_KEY));
});

test('cross-origin, invalid and oversized requests do not call Jev', async () => {
  const worker = createWorker({ fetchImpl: () => { throw new Error('unexpected upstream call'); } });
  for (const [request, status] of [
    [post({ trip: '去三亚五天' }, { Origin: 'https://elsewhere.example' }), 403],
    [post({ trip: '去三亚五天' }, { 'Content-Type': 'text/plain' }), 415],
    [post('{'), 400], [post({ trip: '去' }), 400],
    [post({ trip: '去'.repeat(501) }), 400],
    [post(' '.repeat(8193)), 413],
    [new Request(origin + '/api/pack'), 404],
  ]) assert.equal((await worker.fetch(request, env)).status, status);
});

test('health and upstream errors return safe responses', async () => {
  const worker = createWorker({ fetchImpl: async () => new Response('private upstream detail', { status: 401 }) });
  const health = await worker.fetch(new Request(origin + '/api/health'), env);
  assert.deepEqual(await health.json(), { configured: true, model: 'jev-latest' });
  assert.equal((await worker.fetch(post({ trip: '去三亚五天' }), {})).status, 503);
  const failure = await worker.fetch(post({ trip: '去三亚五天' }), env);
  assert.equal(failure.status, 502);
  assert.ok(!(await failure.text()).includes('private upstream detail'));
});

test('only allowlisted assets can be read and HEAD has no body', async () => {
  const worker = createWorker({ assets: { '/': { type: 'text/html; charset=utf-8', body: '<h1>带什么</h1>' } } });
  assert.equal((await worker.fetch(new Request(origin + '/'))).status, 200);
  const head = await worker.fetch(new Request(origin + '/', { method: 'HEAD' }));
  assert.equal(head.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await head.text(), '');
  for (const path of ['/.env', '/packing.mjs', '/worker.mjs', '/server.mjs', '/toString', '/api/game/hint']) {
    assert.equal((await worker.fetch(new Request(origin + path))).status, 404);
  }
});
