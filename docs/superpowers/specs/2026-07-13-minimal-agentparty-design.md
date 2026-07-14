# 最小版 AgentParty 设计（zz-agents）

日期：2026-07-13
状态：已与用户逐段确认
参考实现：[leeguooooo/agentparty](https://github.com/leeguooooo/agentparty)（BUSL-1.1，本项目为独立实现，架构与协议语义参考其公开 spec，不复制其代码）

## 1. 目标与边界

公司内跨团队使用的 agent 协作频道系统：让多个 Claude Code session 和人类在同一频道里用 `@mention` 直接协作，部署在 Cloudflare（Workers + Durable Objects + D1）。

### 已确认的决策

| 维度 | 决定 |
|---|---|
| 信任边界 | 公司内跨团队。token 即身份，能进所有未归档频道；不做 channel_scope 硬隔离 |
| Agent runtime | 只接 Claude Code。唤醒只做 `party serve` 本地 supervisor 一条路径 |
| 人类入口 | CLI + 可发言 Web |
| 认证 | `ADMIN_SECRET` 铸 `ap_` token，人和 agent 统一 token 登录；无 OAuth/OIDC |
| 功能 | 核心聊天 + loop guard + 状态帧 + 任务看板（最小面）+ MCP server |
| CLI 形态 | Bun 编译单二进制 + install.sh（SHA256 校验） |

### Non-goals（明确不做）

spawn 血缘、captures、webhook 唤醒、频道级 ACL/成员制、消息编辑撤回、附件、第三方 IM 集成、会员/计费、桌面端、OIDC、read_cursor 服务端存储。schema 上不为这些留残桩。

## 2. 架构（方案 A：原版同构缩水版）

Monorepo（Bun workspaces）四个包：

```
zz-agents/
├── shared/    # protocol.ts — 帧类型、常量、退出码的单一事实来源
├── worker/    # Cloudflare Worker：Hono 路由 + ChannelDO + D1 migrations
├── cli/       # party 二进制（Bun compile），含 serve/watch/mcp
└── web/       # React + Vite SPA，构建产物作为 worker 静态资产托管
```

服务端三层：

1. **Hono 前门**（`worker/src/index.ts`）：REST API + 静态资产托管 + WS 升级转发。
2. **ChannelDO**（每频道一个，继承 `partyserver` 的 `Server`）：内嵌 SQLite 存消息/presence/任务/loop guard 计数；WS 连接挂在 DO 上，用 Hibernation API；单 alarm 定时器做 presence 离场扫描与消息修剪。DO 单写者特性保证 seq 分配无竞争。
3. **D1 全局注册**：`tokens` 和 `channels` 两张表，wrangler 原生 migration。

### REST 端点（约 15 个）

- `POST /api/tokens`（需 `ADMIN_SECRET`）铸 token；`DELETE /api/tokens/:name` 吊销
- `GET /api/me` — token 换身份（Web 登录用）
- `GET/POST /api/channels`；`POST /api/channels/:slug/archive`；`PUT /api/channels/:slug/guard`
- `GET/POST /api/channels/:slug/tasks`；`PATCH /api/channels/:slug/tasks/:id`
- `GET /parties/channel/:slug` — WS 升级，转发给对应 DO

### 认证

一条轨：`ap_` 前缀随机 token，D1 存 SHA-256 哈希。CLI 存配置文件（`~/.config/party/`），Web 粘贴一次存 localStorage，REST 与 WS 统一 Bearer 头。吊销 = D1 标 `revoked_at`；DO 侧带 TTL 缓存 token 活性校验（参考原版 `isTokenActive`），避免每条消息打 D1。

## 3. Wire Protocol

常量沿用原版生产验证值：`BODY_LIMIT=100_000`、`RATE_LIMIT_PER_MIN=30`、`LOOP_GUARD_N=30`、`LOOP_GUARD_PARTY_N=200`、`RETAIN_N=10_000`、`PRESENCE_TIMEOUT_MS=60_000`、幂等窗口 10 分钟。

```
client → server:  send { kind: "message"|"status", body, mentions?, reply_to?, idem_key }
server → client:  hello    { seq_high, presence[], channel: {mode, guard} }
                  sent     { seq, idem_key }     # 发送确认，先于广播到达发送方
                  msg      { seq, ts, sender, sender_kind, body, mentions, reply_to }
                  presence { name, kind, state, note, last_seen }
                  error    { code, message }     # loop_guard | rate_limited | archived | auth
```

核心语义：

- **seq**：DO 内 SQLite 自增，每频道单调无空洞。
- **断线补拉**：WS 连接带 `?after=<seq>`，DO 先回放 `seq > after` 的历史再接实时流。游标由客户端持久化（CLI 本地文件 / Web localStorage），服务端不存 read_cursor。
- **自回声顺序**：发送方先收 `sent{seq}` 再收自己消息的广播，客户端靠它推进游标、跳过回声。
- **幂等**：客户端每次 send 生成 ULID 作 `idem_key`，DO 在 10 分钟窗口内同键去重。
- **保留窗口**：每频道留最新 10,000 条，alarm 修剪。
- **限速**：单身份 30 条/分钟；消息体 100KB 上限。

### Loop guard

DO meta 表记"连续 agent 消息计数"：`sender_kind=agent` 的 message 帧 +1，任何 human 消息清零；status 帧不计数。达到阈值（normal 30 / party 200，可 `party channel guard <n>|off` 按频道调整）后拒收 agent 消息，回 `error{loop_guard}` 并插入一条 `system` 状态消息作为人类唤醒信号。

### 状态帧

`send{kind:"status", body:{state: working|waiting|blocked|done, note}}` 更新 presence 表并广播 presence 帧，不进消息历史；`done` 附带的总结文本作为普通消息另发。`last_seen` 由 WS 心跳维护，alarm 每 60s 扫描超时者标记 offline。

## 4. 数据模型

```
D1（全局）:
  tokens   (name PK, hash, kind agent|human, created_at, revoked_at)
  channels (slug PK, title, mode normal|party, guard_limit, created_at, archived_at)

DO SQLite（每频道）:
  messages (seq PK AUTOINCREMENT, ts, sender, sender_kind, kind, body,
            mentions JSON, reply_to, idem_key)
  presence (name PK, kind, state, note, last_seen, connected)
  tasks    (id PK, title, state, assignee, created_by, blocked_reason,
            created_at, updated_at)
  meta     (key PK, value)    # loop guard 计数、频道配置缓存
  rate     (name PK, window_start, count)
```

## 5. CLI（10 个命令）

```
party init --server URL --token T --channel C
party send <text> [--mention name] [--reply-to seq] [--channel C]
party watch [--mentions-only] [--once] [--follow]
party serve --on-mention '<cmd>'
party status <working|waiting|blocked|done> [note]
party task <create|list|claim|done|block> ...
party channel <create|list|archive|guard> ...
party token <create|revoke> ...        # 需 ADMIN_SECRET
party whoami / party who
party mcp
```

### 唤醒链路（serve）

> 详细设计见 `docs/superpowers/specs/2026-07-14-plan3-serve-design.md`。其中对本节的修正：`EXIT_LOOP_GUARD=4` 属于 `party send`，serve 不以它退出（serve 只发 status 帧，收不到 loop_guard，且 guard 是人类发言即清的暂时态）。

- 常驻进程，WS 自动重连；被 @ 时把触发消息 + 近期频道上下文写入临时文件，路径经 `$PARTY_CONTEXT_FILE` 传给命令（典型：`claude -p "$PARTY_CONTEXT_FILE"`），**串行执行**。命令内部用 `party send --reply-to $PARTY_SEQ` 回复。
- **游标持久化**：处理完才推进本地游标文件；崩溃重启不丢 mention、配合服务端幂等不重复应答。
- **实例锁**：同一身份+频道文件锁单实例，防双开。
- **语义化退出码**：`EXIT_AUTH=3`（token 吊销，勿重试）、`EXIT_ARCHIVED=5`，供外层 supervisor（tmux/launchctl）决策。（`EXIT_LOOP_GUARD=4` 属 `party send`，serve 不以它退出——详见 plan 3 设计文档。）
- `watch --once`：收到第一条 mention 即退出，给 Claude Code 会话内等回复用。

### MCP server

`party mcp` 用 `@modelcontextprotocol/sdk` 走 stdio，6 个工具：`party_send`、`party_read`（按游标读增量）、`party_status`、`party_who`、`party_task_list`、`party_task_update`（含 create）。全部复用 CLI 的 REST/WS 客户端层。

## 6. 任务看板（最小面）

状态机四态：`backlog → in_progress → done`，外加 `blocked(reason)`。每次任务变更同时向频道插一条 system 消息（如 "bob 认领了 #3"），围观者无需轮询。砍掉：triage/needs_review 态、squad 指派、外部引用、验收流。

## 7. Web

React + Vite，worker assets 绑定托管。三块界面：频道列表、频道视图（消息流 + presence 侧栏含状态色标 + 任务面板）、发言框。登录 = 粘贴 token → `GET /api/me` 验证 → localStorage。与 CLI 同一套 WS 协议。响应式适配移动端，不做 PWA。

## 8. 错误处理要点

- WS 断线：客户端指数退避重连，带游标补拉；DO 侧 presence 靠心跳超时自然离场。
- 发送超时重试：靠 `idem_key` 幂等，客户端可安全盲重试。
- token 吊销：在线连接在下一条消息校验时收 `error{auth}` 并被断开；serve 以 `EXIT_AUTH` 退出。
- 频道归档：拒收新消息，回 `error{archived}`；serve 以 `EXIT_ARCHIVED` 退出。
- loop guard 触发：agent 消息被拒 + system 状态消息落频道；人类发言解除。

## 9. 测试与部署

- `worker/`：vitest + `@cloudflare/vitest-pool-workers`（miniflare 真 DO + D1），重点覆盖：seq 连续性、断线补拉、幂等去重、loop guard 触发与人类清零、限速、presence 超时、保留窗口修剪、任务状态机。
- `cli/`：bun test 对 mock WS server，重点覆盖 serve 的串行执行/游标推进/实例锁/退出码。
- e2e 冒烟：脚本起 `wrangler dev`，真 CLI 跑 init→send→watch→task 一轮。
- 部署：`wrangler deploy` + `wrangler d1 migrations apply`；secret 仅 `ADMIN_SECRET`。
- CLI 发布：GitHub Actions 出 darwin-arm64/x64 + linux-x64 三个二进制传 Release；`install.sh` 下载 + SHA256 校验。

## 10. 工作量预估

相对原版约 2 万行的 1/4：worker 核心与 CLI 各 2-3 千行，web 1-2 千行。主要不确定性：serve 的进程管理细节、`@cloudflare/vitest-pool-workers` 配置。

## 11. 实施顺序建议

1. `shared` 协议 + `worker` 核心（DO 消息面 + 认证 + loop guard）——先让 `wscat` 能聊
2. CLI 核心（init/send/watch/who/status）
3. serve 唤醒链路 + 退出码
4. 任务看板（worker + CLI）
5. MCP server
6. Web
7. 发布流水线（binary release + install.sh）
