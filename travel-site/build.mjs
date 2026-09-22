import { build } from 'esbuild';
import { readFile, mkdir, copyFile } from 'node:fs/promises';

const files = [
  ['/travel/', 'travel/index.html', 'text/html; charset=utf-8'],
  ['/travel/style.css', 'travel/style.css', 'text/css; charset=utf-8'],
  ['/travel/app.mjs', 'travel/app.mjs', 'text/javascript; charset=utf-8'],
  ['/travel/physics.mjs', 'travel/physics.mjs', 'text/javascript; charset=utf-8'],
  ['/travel/catalog.mjs', 'travel/catalog.mjs', 'text/javascript; charset=utf-8'],
  ['/travel/matter.min.js', 'vendor/matter.min.js', 'text/javascript; charset=utf-8'],
];
const assets = Object.fromEntries(await Promise.all(files.map(async ([route, file, type]) =>
  [route, { type, body: await readFile(new URL(file, import.meta.url), 'utf8') }]
)));
assets['/'] = assets['/travel/'];
assets['/index.html'] = assets['/travel/'];
assets['/travel'] = assets['/travel/'];

await build({
  entryPoints: ['entry.mjs'], bundle: true, format: 'esm', platform: 'browser',
  target: 'es2022', outfile: 'dist/server/index.js', minify: true,
  legalComments: 'inline',
  plugins: [{
    name: 'travel-assets',
    setup(build) {
      build.onResolve({ filter: /^travel:assets$/ }, () => ({ path: 'assets', namespace: 'travel' }));
      build.onLoad({ filter: /.*/, namespace: 'travel' }, () => ({
        contents: `export default ${JSON.stringify(assets)};`, loader: 'js',
      }));
    },
  }],
});
await mkdir('dist/.openai', { recursive: true });
await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
console.log('Built travel UI and Jev API as a Cloudflare Worker.');
