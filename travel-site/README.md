# 带什么 · 旅行打包

This directory contains the hosted travel packing app: the travel interface,
Matter.js animations, and the Jev packing API.

Run `npm test` to check the hosted HTTPS adapter and `npm run build` to generate
`dist/server/index.js`. The Worker bundles an explicit public-asset allowlist and
serves the travel app at both `/` and `/travel/`.

`TYPESAFE_API_KEY` is a production secret managed in Sites, never a client asset
or a value in `.openai/hosting.json`. The frontend sends requests to its own
`/api/pack` endpoint. The Worker contacts the official Jev API.

The Site identity is in `.openai/hosting.json`; reuse it for future deployments.
Update travel source in this checkout when publishing subsequent changes.
