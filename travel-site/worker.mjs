import { analyzePacking, validTripBody, PACKING_MODEL } from './packing.mjs';

const responseHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'",
};
const json = (status, data) => new Response(JSON.stringify(data), {
  status, headers: { ...responseHeaders, 'Content-Type': 'application/json; charset=utf-8' },
});

async function readJSON(request) {
  const maxBytes = 8192;
  if (Number(request.headers.get('content-length')) > maxBytes) return { tooLarge: true };
  const reader = request.body?.getReader();
  if (!reader) return { invalid: true };
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); return { tooLarge: true }; }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { body: JSON.parse(text) };
  } catch { return { invalid: true }; }
  finally { reader.releaseLock(); }
}

export function createWorker({ assets = {}, fetchImpl = fetch } = {}) {
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      const path = url.pathname;
      const asset = Object.hasOwn(assets, path) ? assets[path] : undefined;
      if (asset && ['GET', 'HEAD'].includes(request.method)) {
        return new Response(request.method === 'HEAD' ? null : asset.body, {
          headers: { ...responseHeaders, 'Content-Type': asset.type },
        });
      }
      const key = typeof env.TYPESAFE_API_KEY === 'string' ? env.TYPESAFE_API_KEY.trim() : '';
      if (request.method === 'GET' && path === '/api/health') {
        return json(200, { configured: Boolean(key), model: PACKING_MODEL });
      }
      if (path !== '/api/pack' || request.method !== 'POST') return json(404, { error: '未找到此页面。' });
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return json(403, { error: '请从本站页面发起整理。' });
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return json(415, { error: '请求格式不正确。' });
      }
      const input = await readJSON(request);
      if (input.tooLarge) return json(413, { error: '行程太长了，请缩短后再试。' });
      if (input.invalid) return json(400, { error: '请求内容不是有效 JSON。' });
      if (!validTripBody(input.body)) return json(400, { error: '请用 2–500 字写下目的地和旅行天数。' });
      const result = await analyzePacking(input.body.trip.trim(), { key, fetchImpl });
      return json(result.status, result.data);
    },
  };
}
