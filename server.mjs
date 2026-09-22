import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzePacking, validTripBody } from './packing.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const model = 'jev-latest';
const travelAssets = new Map([
  ['/', ['travel/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['travel/index.html', 'text/html; charset=utf-8']],
  ['/travel', ['travel/index.html', 'text/html; charset=utf-8']],
  ['/travel/', ['travel/index.html', 'text/html; charset=utf-8']],
  ['/travel/style.css', ['travel/style.css', 'text/css; charset=utf-8']],
  ['/travel/app.mjs', ['travel/app.mjs', 'text/javascript; charset=utf-8']],
  ['/travel/physics.mjs', ['travel/physics.mjs', 'text/javascript; charset=utf-8']],
  ['/travel/catalog.mjs', ['travel/catalog.mjs', 'text/javascript; charset=utf-8']],
  ['/travel/matter.min.js', ['node_modules/matter-js/build/matter.min.js', 'text/javascript; charset=utf-8']],
]);

export async function loadKey() {
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
  try {
    const env = await readFile(root + '.env', 'utf8');
    const value = env.replace(/^\uFEFF/, '').split(/\r?\n/).find(line => /^\s*TYPESAFE_API_KEY\s*=/.test(line))?.split('=').slice(1).join('=').trim() || '';
    return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  } catch { return ''; }
}

export function createAppServer({ key = '', fetchImpl = fetch } = {}) {
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return json(403, { error: '仅支持本机访问。' });
    const path = new URL(req.url, 'http://' + host).pathname;
    if ((req.method === 'GET' || req.method === 'HEAD') && travelAssets.has(path)) {
      const [file, contentType] = travelAssets.get(path);
      try { const content = await readFile(root + file); res.writeHead(200, { 'Content-Type': contentType }); res.end(req.method === 'HEAD' ? undefined : content); }
      catch { json(500, { error: '页面暂时无法加载。' }); }
      return;
    }
    if (req.method === 'GET' && path === '/api/health') return json(200, { configured: Boolean(key), model });
    if (req.method !== 'POST' || path !== '/api/pack') return json(404, { error: '未找到此页面。' });
    if (req.headers.origin && req.headers.origin !== 'http://' + host) return json(403, { error: '请从本地页面发起打包请求。' });
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return json(415, { error: '请求格式不正确。' });
    let bytes = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 60000) { json(413, { error: '行程太长了，请缩短后再试。' }); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { error: '请求内容不是有效 JSON。' }); }
      if (!validTripBody(body)) return json(400, { error: '请用 2–500 字写下目的地和旅行天数。' });
      const result = await analyzePacking(body.trip.trim(), { key, fetchImpl });
      json(result.status, result.data);
    } catch (error) {
      json(502, { error: error?.name === 'TimeoutError' ? '这次整理等待太久了，请再试一次。' : '暂时连接不上 Jev，请检查网络后重试。' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4173);
  const server = createAppServer({ key: await loadKey() });
  server.listen(port, '127.0.0.1', () => console.log(`带什么: http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请使用 PORT 指定其他端口。` : '本地服务无法启动。'); process.exitCode = 1; });
}
