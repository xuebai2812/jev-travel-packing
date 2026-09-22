import assert from 'node:assert/strict';
import worker from './dist/server/index.js';

assert.equal(typeof worker.fetch, 'function');
const origin = 'https://travel.example';
for (const path of ['/', '/travel', '/travel/', '/travel/style.css', '/travel/app.mjs', '/travel/physics.mjs', '/travel/catalog.mjs', '/travel/matter.min.js']) {
  const response = await worker.fetch(new Request(origin + path));
  assert.equal(response.status, 200, path);
  const body = await response.text();
  assert.ok(body.length > 0, path);
  if (path.endsWith('.mjs') || path.endsWith('.js')) assert.ok(response.headers.get('content-type').includes('javascript'), path);
  if (path === '/') {
    assert.ok(body.includes('id="tripInput"'));
    assert.ok(body.includes('src="/travel/matter.min.js"'));
    assert.ok(body.includes('src="/travel/app.mjs"'));
  }
}
for (const path of ['/.env', '/server.mjs', '/worker.mjs', '/packing.mjs']) {
  assert.equal((await worker.fetch(new Request(origin + path))).status, 404);
}
const health = await worker.fetch(new Request(origin + '/api/health'), { TYPESAFE_API_KEY: 'test-only-secret' });
assert.equal((await health.json()).configured, true);
console.log('Verified built Worker, travel routes, module MIME types, and private-file exclusions.');
