# 计划 4 设计：任务看板（worker DO + CLI）

日期：2026-07-14
状态：已与用户逐项确认（grilling 9 问）
上游设计：`docs/superpowers/specs/2026-07-13-minimal-agentparty-design.md` §6「任务看板（最小面）」、§2 端点、§4 数据模型、§5 CLI
术语表：`CONTEXT.md`（任务 / 认领 / 阻塞 / 任务通告）

## 1. 目标与边界

给每个频道一块最小任务看板：四态状态机（backlog / in_progress / blocked / done）、每次变更往频道播一条中文 system 通告让围观者无需轮询。worker 侧任务存每频道 DO SQLite、REST 端点代理转发给 DO；CLI 加 `party task <create|list|claim|done|block>`。

### Non-goals（本计划不做）

Web 任务面板（plan 6）、MCP `party_task_*`（plan 5）、`--json`、`?state=` 过滤、reopen 动词、triage/needs_review 态、squad 指派、外部引用、验收流、任务修剪、新增 `task` server 帧。

## 2. 架构落位

任务是每频道资源，且变更要往频道插 system 消息（只有 DO 拥有 messages/seq/broadcast），所以**任务必须活在 DO 里**，REST 端点是 DO 的鉴权代理：

```
CLI ──REST──▶ Hono (requireAuth + 剥离/注入 x-ap-* 身份头) ──stub.fetch──▶ ChannelDO.onRequest(/internal/tasks) ──▶ DO SQLite tasks 表 + insertSystemMessage()
```

- **Hono**（`worker/src/index.ts`）：3 个端点，`requireAuth` 后把身份随内部请求转发给 DO，**原样中继 DO 的 Response**（状态码 + JSON）。不在 Hono 做任务规则校验。
- **DO**（`worker/src/do.ts`）：`onStart` 建 `tasks` 表；`onRequest` 在现有 `/internal/config` 旁加任务内部路由；任务规则（转移合法性、字段校验、id 存在性）单点收口在此；每次成功变更复用 `insertSystemMessage()`。
- **CLI**（`cli/`）：`rest.ts` 加 `createTask/listTasks/updateTask` 包装；`commands/task.ts` 照 `channel.ts` 模式分派子命令；`index.ts` 注册 `task`。

## 3. 数据模型（DO SQLite）

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,   -- 每频道自增，展示 #N
  title          TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'backlog',     -- backlog|in_progress|blocked|done
  assignee       TEXT,                                -- 认领人身份名，未认领为 NULL
  created_by     TEXT NOT NULL,                       -- 创建者身份名
  blocked_reason TEXT,                                -- 仅 blocked 态非空
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
```

任务不修剪；`id` 永久稳定；done 任务保留。

## 4. 状态机

```
create ─────────────▶ backlog
backlog / blocked / in_progress ──claim──▶ in_progress   (assignee=调用者；清 blocked_reason)
backlog / in_progress ──block(reason)──▶ blocked          (存 blocked_reason)
backlog / in_progress / blocked ──done──▶ done            (终态)
```

合法源态表（DO 强制校验，非法转移回 400）：

| action | 合法源态 | 目标态 | 副作用 |
|---|---|---|---|
| （create） | — | backlog | `created_by`=身份，`assignee`=NULL |
| claim | backlog / blocked / in_progress | in_progress | `assignee`=身份；`blocked_reason`=NULL |
| block | backlog / in_progress | blocked | `blocked_reason`=reason |
| done | backlog / in_progress / blocked | done | — |

- **done 终态**：无 reopen；误关只能新建。
- **claim 抢单**：claim 别人的 in_progress 任务会改派 assignee，透明地播一条通告。
- 任意成功变更后 `updated_at`=now。

## 5. REST 端点（Hono）

三个都在 `requireAuth` 之后。身份经剥离/注入的 `x-ap-name`/`x-ap-kind` 头转发给 DO（复用 §index.ts 的 `AP_HEADERS` 套路）。Hono 原样中继 DO 返回的状态码与 JSON。

| 方法 | 路径 | body | 成功 | 说明 |
|---|---|---|---|---|
| POST | `/api/channels/:slug/tasks` | `{ title }` | 201 + task | 建 backlog 任务 |
| GET | `/api/channels/:slug/tasks` | — | 200 `{ tasks: [...] }` | 全部任务，按 id 升序 |
| PATCH | `/api/channels/:slug/tasks/:id` | `{ action, reason? }` | 200 + task | action ∈ claim/done/block |

- 频道不存在 → 404（Hono 查 D1 channels，同 ws 升级的前置检查）。
- **归档频道**：POST/PATCH → 410（变更类拒绝）；GET → 200（只读允许）。归档判定：Hono 查 D1 `archived_at`（同 ws 升级），或 DO meta——统一在 Hono 前置查 D1 `channels.archived_at`，归档则变更类直接 410、不转发；GET 照常转发。
- 任务对象形状：`{ id, title, state, assignee, created_by, blocked_reason, created_at, updated_at }`（assignee/blocked_reason 可为 null）。

## 6. DO 内部路由（`onRequest`）

现有 `onRequest` 处理 `POST /internal/config`。新增（URL path 解析分派）：

- `POST /internal/tasks`：读 `x-ap-name` 为 `created_by`，校验 title（非空、≤200），insert backlog 任务，播 `创建了 #id：title`，返回 201 + task。
- `GET /internal/tasks`：返回 `{ tasks }` 全部按 id 升序，200。
- `PATCH /internal/tasks/:id`：解析 id（正整数否则 404）；读该任务（不存在 404）；读 `x-ap-name`；按 `action` 校验合法源态（非法 400）与字段（block 需非空 reason ≤500，缺/超 400；未知 action 400）；更新 + `updated_at`；播对应通告；返回 200 + task。

DO 层不再重复查 archived（Hono 已在前置拦住变更类）；但 DO 是内部可信入口，archived 的权威拦截在 Hono。

## 7. system 通告文案（中文，复用 `insertSystemMessage`）

| 动作 | 文案 |
|---|---|
| create | `<name> 创建了 #<id>：<title>` |
| claim | `<name> 认领了 #<id>` |
| done | `<name> 完成了 #<id>` |
| block | `<name> 阻塞了 #<id>：<reason>` |

- sender=`system`、sender_kind=`agent`（`insertSystemMessage` 既定），**不涨 `agent_streak`**（该计数只在 `handleMessage` 真实发送时增减）——任务通告不触发也不推进 loop guard。
- title/reason 进通告前按 §5 上限已受约束；通告本身受 message 保留窗口（会随历史修剪，不影响任务表）。
- loop-guard 既有英文消息不动。

## 8. 实时传播

只播 system 通告，观察者据此重取——不新增 server 帧、协议零改动：

- 变更发起者（CLI）从 REST 响应直接拿到更新后的任务。
- 其他观察者（Web 面板 plan 6、别的 `party watch`）在消息流里看到 system 消息即重取 `GET /tasks` 刷新（任意 system 消息即重取，简单；system 消息本就稀少）。「无需轮询」= 事件驱动重取，非周期轮询。

## 9. CLI（`party task`）

```
party task create <title>
party task list
party task claim <id>
party task done <id>
party task block <id> <reason...>
```

- 照 `channel.ts` 模式：`loadConfig()` → `RestOpts{server,token}` → 调 `rest.ts` 包装 → 打印本地反馈。
- `rest.ts` 新增：
  - `createTask(o, slug, title)` → POST
  - `listTasks(o, slug)` → GET
  - `updateTask(o, slug, id, action, reason?)` → PATCH
- **list 输出**（tab 分隔，对齐 `channel list`）：`#<id>\t<state>\t<assignee|->\t<title>`，blocked 行尾附 `（reason: <reason>）`。
- **本地 stdout（英文，对齐现有 CLI 反馈）**：`created #<id>: <title>` / `claimed #<id>` / `completed #<id>` / `blocked #<id>`。
- **用法错误**（缺 title/id/reason、id 非正整数）→ `CliError(EXIT_ERROR, "usage: ...")`。
- 错误码映射由现有 `restFetch` 完成：401→EXIT_AUTH、410→EXIT_ARCHIVED、其余（400/404）→EXIT_ERROR（带 DO 的 `error` 文案）。channel/server 用 `resolveChannel`/config，与其他命令一致（本计划不引入 `--channel` 覆盖，除非顺带对齐——见下）。

> 频道解析：`party task` 作用于绑定频道（`cfg.channel`）。是否加 `--channel` 覆盖与其他命令对齐，作为实现时的小决定（低风险，加了不碍事）。

## 10. 复用与新增

复用（不改语义）：`insertSystemMessage`、`getMeta`/`setMeta`、`requireAuth`、`AP_HEADERS` 剥离/注入、`identityFromRequest`、D1 `channels` 查询（archived 前置）、CLI `restFetch`/`parseArgs`/`loadConfig`/`CliError`、`isName`。

新增：
- `worker/src/do.ts`：`tasks` 表（onStart）；`onRequest` 任务内部路由 + 任务规则/校验/转移 + 通告；一个 `rowToTask` 序列化辅助。
- `worker/src/index.ts`：3 个 REST 端点（POST/GET/PATCH），archived 前置，身份头转发，中继 DO Response。
- `cli/src/rest.ts`：`createTask/listTasks/updateTask`。
- `cli/src/commands/task.ts`：子命令分派 + list 格式化。
- `cli/src/index.ts`：注册 `task` + HELP。

不改 `shared/src/protocol.ts`（无新帧、无新退出码）。

## 11. 测试要点

**worker（vitest + `@cloudflare/vitest-pool-workers`，真 DO+D1）**：
1. 建表；POST 建 backlog→201+对象、`created_by`=身份、播 system 消息（广播+落历史）；title 空/超 200→400。
2. GET 返回全部按 id 升序、含 done；归档频道 GET 仍 200。
3. PATCH claim：backlog→in_progress+设 assignee+通告；blocked→in_progress 清 reason；抢单改派；非法（done→claim）→400。
4. PATCH block：缺/空/超 500 reason→400；in_progress→blocked 存 reason+通告；backlog→blocked 允许。
5. PATCH done：backlog/in_progress/blocked→done；done→再操作→400。
6. id 不存在→404；未知 action→400。
7. 归档频道 POST/PATCH→410、GET→200。
8. loop guard 不受扰：任务通告前后 `agent_streak` meta 不变。
9. 无 token→401（Hono requireAuth）。

**CLI（bun test，mock fetch，照 `rest.test`/`bootstrap.test`）**：
10. create/claim/done/block/list 构造正确 REST 调用（method/path/body）；list 输出格式（捕获 stdout）。
11. 错误码映射（410→EXIT_ARCHIVED、401→EXIT_AUTH、400/404→EXIT_ERROR 带消息）。
12. 用法错误（缺 title/id/reason、id 非正整数）→EXIT_ERROR；`index.ts` 分派注册 `task`。

## 12. 上游文档同步

落地后在上游设计 §6 处补一行指针指向本文档。
