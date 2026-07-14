# 计划 6 设计：可发言 Web（含任务面板）

日期：2026-07-14
状态：/goal 自主交付模式——设计决策取自 grilling 中已陈述的推荐（用户可随时否决）
上游设计：`docs/superpowers/specs/2026-07-13-minimal-agentparty-design.md` §7「Web」+ §3 协议
依赖：plan 1（worker 核心）、plan 4（任务 REST 端点）均已合并到 main

## 1. 目标与边界

React + Vite SPA，构建产物由 worker 的 assets 绑定托管。三块界面：频道列表、频道视图（消息流 + presence 侧栏含状态色标 + 任务面板）、发言框。登录 = 粘贴 token → `GET /api/me` 验证 → localStorage。与 CLI 同一套 WS 协议。响应式适配移动端。

### Non-goals（本计划不做）

admin 面（铸 token 需 ADMIN_SECRET、guard/archive 归 CLI）、PWA、未读徽章、消息编辑撤回、附件、无限滚动分页、深色/浅色主题切换、i18n。

## 2. 架构与托管

新增第 4 个 workspace `web/`（React 19 + Vite + TypeScript strict），真实构建期依赖 `react`/`react-dom`/`vite`（CLI 的零运行时依赖约束只管 `cli/`）。`web/` import `@agentparty-mini/shared` 复用 `ServerFrame`/`SendFrame`/`PresenceEntry`/`isName` 等——全站与 CLI 同一套 wire protocol，单一事实来源。

### 托管（worker-first 路由）

- `worker/wrangler.jsonc` 加 assets 绑定：
  ```jsonc
  "assets": { "directory": "../web/dist", "binding": "ASSETS", "not_found_handling": "single-page-application", "run_worker_first": ["/api/*"] }
  ```
- Hono 保持所有 `/api/*` 端点不变；**末尾加 catch-all** `app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw))`，把非 API 请求交给 ASSETS（SPA fallback 返回 `index.html`）。`run_worker_first` 确保 `/api/*` 一定进 Hono、其余静态优先，路由由我们掌控。
- 构建链：`web` 的 `vite build` → `web/dist`；`wrangler deploy` 一次性发 worker + SPA。
- 根 `package.json`：workspaces 加 `web`，`check` 串上 `check:web`；`Env` 加 `ASSETS: Fetcher`。

## 3. 认证与会话

- 登录页：粘贴 `ap_` token → 调 `GET /api/me`（Bearer）→ 成功存 `localStorage["ap_token"]` + 回填 `{name, kind}`，进主界面；失败提示。
- 任何 REST 返回 401 → 清 token、回登录页。
- REST 一律带 `Authorization: Bearer <token>`；WS 用 `?token=<token>`（与 CLI/服务端一致，服务端对 WS 升级认 query token）。
- 无 OAuth；token 即身份。

## 4. 数据流

### WS（messages + presence）

`web/src/lib/channel.ts`：浏览器原生 `WebSocket` 的精简客户端（不复用 CLI 的 Bun 版 `ws.ts`，浏览器自带 WebSocket，web 自包含）。语义与协议一致：

- URL：`server(http→ws) + /api/channels/<slug>/ws?token=<t>&after=<cursor>`。
- 连接 → 等 `hello`（拿 `self`/`seq_high`/`presence`/`mode`/`guard`）→ 补拉历史（`seq>after`）→ 实时流。
- 帧回调喂 React：`hello`→初始化 presence + self；`msg`→追加消息、推进本地游标（localStorage）；`presence`→更新单条 presence；`sent`→标记自己发送成功；`error`→toast（auth/archived 断开并回登录/频道列表，loop_guard/rate_limited 提示）。
- 断线指数退避重连，带 `after=游标` 补拉；`error{auth|archived}` 不重连。

### REST（channels + tasks）

`web/src/lib/api.ts`：Bearer fetch 包装。`getMe`、`listChannels`、`createChannel`、`listTasks`、`createTask`、`updateTask`（对齐 plan 2/4 的端点与请求体）。

### 任务面板刷新（plan 4 决策 6/A）

进频道时 `GET /tasks` 载入；WS 流里**每见到一条 `sender==="system"` 的消息就重取 `GET /tasks`** 刷新面板（事件驱动，非轮询；system 消息稀少）。自己在面板点操作（PATCH）成功后也立即用响应更新本地任务态。

## 5. 组件结构

```
App                      # 读 localStorage token；无 token→<Login>；有→<Shell>
├── Login                # 粘贴 token 表单 → getMe 验证
└── Shell
    ├── ChannelList      # listChannels + 建频道输入框；选中进 ChannelView
    └── ChannelView(slug)
        ├── useChannel(slug)   # hook：开 WS、维护 messages/presence/self、暴露 send
        ├── MessageStream      # 消息列表（sender 色分：human/agent/system），reply_to 缩进提示
        ├── PresenceSidebar    # 在线名单 + 状态色标（waiting灰/working蓝/blocked红/done绿/offline暗）
        ├── TaskPanel          # 任务列表（按 state）+ 建任务输入 + 每条按状态给操作按钮
        └── Composer           # 文本框 → send{message}；@name 自动进 mentions（extractMentions）
```

- 状态提升到 `ChannelView`：`useChannel` 持 messages/presence/self；tasks 用独立 `useTasks(slug, onSystemMsg)`。
- `useChannel` 把 WS 帧 reduce 进 state；组件纯展示。

## 6. 任务面板操作面（全套）

- 顶部：建任务输入框 → `createTask`。
- 每条任务一行：`#id  state  assignee  title`（blocked 附 reason）。按当前 state 给按钮：
  - backlog → [认领]（claim）、[阻塞]（block，弹 reason 输入）、[完成]（done）
  - in_progress → [完成]、[阻塞]
  - blocked → [认领]（解阻塞）、[完成]
  - done → 无按钮（终态，✓）
- 操作即 `updateTask(...)`；成功用响应刷新该条（且服务端会播 system 消息，其他观察者据此重取）。
- 与 CLI 的 `party task` 能力对等。

## 7. 样式

手写 CSS，零 UI 库（依赖只有 react/react-dom/vite）。单一 `web/src/styles.css` 或按组件拆的小 CSS。响应式：桌面三栏（频道列表 | 消息流 | presence+任务侧栏），窄屏收成单列 + 顶部频道切换。状态色标用 CSS 变量。不做主题切换。

## 8. 历史加载与游标

- 每频道游标存 `localStorage["cursor:<host>:<slug>"]`（与 CLI 同语义，客户端持久）。
- 首次进某频道游标缺省 = 0 → WS `after=0` 加载保留窗口内历史（RETAIN_N≤10000 封顶；内部频道量不大，可接受）。
- 随 `msg` 到达推进游标。切频道/刷新页面据游标续拉，不重复。

## 9. 测试

`web/` 用 Vitest + React Testing Library（jsdom）。`check:web = tsc --noEmit && vitest run && vite build`。覆盖：

1. **帧 reducer**（纯函数）：`hello` 初始化、`msg` 追加去重、`presence` 更新单条、游标推进、`error` 分类。
2. **任务分组/操作映射**（纯函数）：按 state 给出的可用动作集合正确。
3. **auth 状态机**：无 token→Login；getMe 成功→Shell；401→清并回 Login。
4. **组件冒烟**：Login 提交调 getMe；TaskPanel 渲染任务行 + 正确按钮；Composer 提交产出带 mentions 的 send 帧；MessageStream 渲染 system/human/agent 分色。
5. **channel.ts WS 客户端**：对内存 mock WS（或注入 WebSocket）测 hello→补拉→帧流→重连——参照 cli `ws.ts` 的 mock 思路。

不引 Playwright（重、CI 复杂）；e2e 冒烟留给手工 `wrangler dev`。

## 10. 复用与新增

复用：`@agentparty-mini/shared`（协议类型/常量/`extractMentions`/`isName`）；worker 既有 `/api/*` 端点全部不变。

新增：
- `web/`：`package.json`、`vite.config.ts`、`tsconfig.json`、`index.html`、`src/main.tsx`、`src/App.tsx`、`src/lib/{api,channel,frames}.ts`、`src/components/{Login,ChannelList,ChannelView,MessageStream,PresenceSidebar,TaskPanel,Composer}.tsx`、`src/styles.css`、测试。
- `worker/src/index.ts`：catch-all → `env.ASSETS.fetch`；`Env` 加 `ASSETS: Fetcher`。
- `worker/wrangler.jsonc`：assets 绑定。
- 根 `package.json`：workspaces 加 `web` + `check:web` + `build:web`。

不改 `shared`、`cli`。

## 11. 部署

`bun run build:web`（vite build → web/dist）→ `cd worker && wrangler deploy`（带上 assets）。secret 仍仅 `ADMIN_SECRET`。Web 与 API 同源（同一 worker 域名），无 CORS。

## 12. 实施顺序（计划将拆成的任务）

1. web 脚手架 + 构建链 + worker assets 托管（空壳 SPA 能被 worker 服务）
2. api.ts（REST 包装）+ frames.ts（帧 reducer 纯函数）+ 测试
3. channel.ts 浏览器 WS 客户端 + 测试
4. Login + auth 门 + App 壳 + ChannelList
5. ChannelView：useChannel + MessageStream + PresenceSidebar + Composer
6. TaskPanel（useTasks + 操作）
7. 样式 + 响应式 + 根 check:web 全绿
