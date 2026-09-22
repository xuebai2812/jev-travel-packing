import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from './server.mjs';

async function withServer(options, run) {
  const server = createAppServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await run(url); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('the root and travel entry points all serve the packing app', async () => {
  await withServer({}, async url => {
    let expected;
    for (const path of ['/travel/', '/', '/index.html', '/travel']) {
      const response = await fetch(url + path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type'), /text\/html/);
      const html = await response.text();
      assert.match(html, /<title>带什么/);
      assert.match(html, /id="tripInput"/);
      assert.match(html, /src="\/travel\/app\.mjs"/);
      expected ??= html;
      assert.equal(html, expected, path);
    }
  });
});

test('HEAD and allowlisted static assets are served with their expected content types', async () => {
  await withServer({}, async url => {
    for (const [path, type] of [
      ['/', /text\/html/],
      ['/index.html', /text\/html/],
      ['/travel/', /text\/html/],
      ['/travel/style.css', /text\/css/],
      ['/travel/app.mjs', /javascript/],
      ['/travel/physics.mjs', /javascript/],
      ['/travel/catalog.mjs', /javascript/],
      ['/travel/matter.min.js', /javascript/],
    ]) {
      const response = await fetch(url + path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type'), type);
      assert.ok((await response.text()).length > 0, path);
      const head = await fetch(url + path, { method: 'HEAD' });
      assert.equal(head.status, 200, path);
      assert.match(head.headers.get('content-type'), type);
      assert.equal(await head.text(), '');
    }
  });
});

test('removed conversation and game endpoints return 404 without invoking Jev', async () => {
  let calls = 0;
  await withServer({ key: 'secret-test', fetchImpl: async () => { calls++; throw Error('unexpected call'); } }, async url => {
    for (const path of ['/api/analyze', '/api/game/hint', '/api/game/reply']) {
      for (const method of ['GET', 'POST']) {
        const response = await fetch(url + path, {
          method,
          ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
        });
        assert.equal(response.status, 404, `${method} ${path}`);
      }
    }
    assert.equal(calls, 0);
  });
});

test('health reports configuration without exposing credentials', async () => {
  for (const key of ['', 'secret-test']) {
    await withServer({ key }, async url => {
      const response = await fetch(url + '/api/health');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { configured: Boolean(key), model: 'jev-latest' });
    });
  }
});
