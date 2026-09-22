# Travel Packing Implementation Plan

**Goal:** 输入目的地与时长后，让 Jev 选择旅行物品并以吸附动画浮起。
**Architecture:** 共享物品目录、Node 后端、原生网页与独立物理模块。
**Tech Stack:** Node.js 20+, ES modules, HTML/CSS, Matter.js 0.20.
**Spec:** docs/superpowers/specs/2026-09-21-travel-packing-design.md

## Global constraints
- 不覆盖已有聊天页面与 API。
- 不暴露本地 key，不把模拟推荐标为 Jev 结果。
- /travel 路径与静态文件严格白名单。
- 月份默认当前月份，页面说明不接入实时天气。

## Review focus
- 中文输入法、连续改写、请求返回乱序。
- 清空或切换目的地后旧结果/已勾选状态不能污染新行程。
- 无效行程、空结果、接口失败均可恢复。
- 手机选中物品不能遮挡输入框或相互重叠。
- 静态文件服务和异常不能泄露凭证。

## Tasks
- [x] Backend: 新增 packing.mjs, travel/catalog.mjs, test-packing.mjs；修改 server.mjs 增加白名单资源和 POST /api/pack。请求 {trip:string}，成功结果 {source,model,trip,selected:[{id,probability}],elapsed_ms,assumed_month,month_source,usage}。先运行 API 断言确认 404，再实现并运行原有与新测试。
- [x] Physics: travel/physics.mjs 导出 PackingWorld(container,items,{onInspect,onToggle})，select(ids),reset(),shuffle(),destroy()。使用 Matter 进行底部碰撞和拖拽，选中项由弹簧移动至整齐网格。ResizeObserver 与 reduced-motion 均支持。
- [x] UI: travel/index.html/style.css/app.mjs。实现输入停顿/回车、示例、清空、请求取消与版本检查、状态说明、侧边清单勾选与复制、导览弹窗。使用 ITEMS 目录避免前后端名称偏差。
- [x] Integration: npm test 覆盖全部 API 测试；浏览器验证桌面与手机，真实 Jev 调用检查语义结果，检查错误和清空恢复；一次独立代码审查；补充 README 并打开预览。

## Progress
- 用户已明确授权制作，按给定视频交互与旅行用途执行。
- 当前目录不是 Git 仓库，直接在新增 travel 文件夹工作。

- 验证完成：23/23 自动检查通过；真实 Jev 冰岛与三亚行程成功；桌面1280×900和手机390×844渲染通过；拖拽不改清单、已装好勾选和复制成功。
- 独立审查修复：重复提交保留打包进度；手动编辑取消旧请求；BFCache 返回保持物理世界。对应回归测试先失败后通过。
