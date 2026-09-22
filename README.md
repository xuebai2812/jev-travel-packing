# 带什么 · 旅行打包

输入要去的目的地和旅行时长，Jev 会从旅行物品中挑选适合携带的东西，对应的 emoji 自动从底部物品堆浮起。

[打开网站](https://pack-for-your-next-trip.sand-ai-1216.chatgpt.site)（目前仅站点所有者可访问）。

## 怎么用

1. 输入行程，例如「去三亚 5 天，在海边度假游泳」。也可以补充月份、活动或不想带的物品。
2. 停顿片刻自动整理，按回车立即整理；下方三个示例可以直接点击。
3. 点一下物品，加入或移出清单；拖动物品可以玩耍，清空输入后物品落回底部。
4. 打开右上角「清单」，装好一件勾选一件，也可以复制打包清单。

修改行程时，当前物品会保持悬浮，新结果回来后再调整变化项。刷新页面会重置清单及勾选状态。

## 本地运行

需要 Node.js 20 或以上。

```sh
npm ci
cp .env.example .env
```

在 `.env` 中填入自己的 `TYPESAFE_API_KEY`，然后启动：

```sh
npm start
```

打开 [http://127.0.0.1:4173](http://127.0.0.1:4173)，首页就是旅行打包 app；`/travel/` 路径同样可用。

没有配置密钥时仍可手动点选和拖动，自动整理会提示尚未连接 Jev。更换端口可使用 `PORT=4180 npm start`。

## 实现

- 原生 HTML、CSS 和 ES modules 实现页面与清单交互。
- Matter.js 实现物品堆积、拖拽、弹簧吸附、旋转和回落碰撞，并支持减少动态效果设置。
- 服务端调用 TypeSafe 的 `jev-latest`，对固定目录中的 56 件物品做结构化判断，最多选出 24 件。
- 密钥仅在服务端使用。行程文本会发送给 Jev；调用失败时保留当前清单并显示错误，不生成假推荐。
- 未注明月份时按当前月份考虑常见季节情况；没有接入实时天气，出发前仍需核对天气及个人需要。

## 代码结构

| 路径 | 内容 |
| --- | --- |
| `travel/` | 页面、物品目录、物理动画与打包清单 |
| `packing.mjs` | Jev 请求、旅行信息校验与物品筛选 |
| `server.mjs` | 本地静态资源服务、`/api/health` 与 `/api/pack` |
| `test-*.mjs` | 服务端、推荐结果、输入交互和物理行为测试 |
| `travel-site/` | 线上版本：同一旅行 app 的前端、Worker 接口及构建脚本 |
| `docs/` | 旅行 app 的设计说明与实现记录 |

## 测试与线上构建

```sh
npm test
cd travel-site
npm ci
npm test
npm run build
node verify-build.mjs
```

测试使用模拟上游，不消耗真实 Jev 用量。线上构建输出 `travel-site/dist/server/index.js`，支持 Cloudflare Workers。

线上 `TYPESAFE_API_KEY` 由 Sites 的服务端 secret 管理。`travel-site/.openai/hosting.json` 只记录站点身份，不包含密钥；使用其他账号部署时应创建自己的站点配置。更多部署说明见 [travel-site/README.md](travel-site/README.md)。
