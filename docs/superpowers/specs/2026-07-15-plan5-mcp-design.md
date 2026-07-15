# Plan 5 — MCP server（`party mcp`）设计

日期：2026-07-15
状态：已与用户逐段确认
上位文档：`docs/superpowers/specs/2026-07-13-minimal-agentparty-design.md` §5「MCP server」

## 1. 目标与边界

给 `party` CLI 加一条 `party mcp` 子命令：用 `@modelcontextprotocol/sdk` 起一个走 stdio 的 MCP server，向 Claude Code（或任意 MCP 客户端）暴露 6 个工具，让 agent 无需 shell 拼接即可在频道里收发消息、报状态、看在线、读增量、管任务。

### 已确认决策

| 维度 | 决定 |
|---|---|
| 传输 | stdio（`StdioServerTransport`） |
| 身份/频道 | 复用 `party init` 绑定的 config（server/token/channel）；每个工具可选 `channel` 覆盖 |
| 网络层 | 全部复用现有 `cli/src/ws.ts`(`openChannel`) 与 `cli/src/rest.ts`，不新增网络逻辑 |
| `party_read` 游标 | **MCP 独立命名空间** `~/.config/party/cursors-mcp/`，与 watch/serve 的 `cursors/` 隔离 |
| 错误 | 逐工具返回 `isError:true` + 文本 message；server 本身不因 auth/archived 退出 |

### Non-goals

不做：MCP resources / prompts（只做 tools）、SSE/HTTP transport、per-tool 独立鉴权（沿用单一 config token）、把 CLI 退出码语义透传给 MCP 客户端、频道订阅推送（`party_read` 是拉取式增量，不做长连接推流）。

## 2. 架构

```
cli/src/
├── commands/mcp.ts     # `party mcp` 入口：加载 config，组装 server，接 stdio transport，阻塞运行
└── mcp/
    ├── server.ts       # 组装 Server + 注册 6 个工具 + 错误映射
    └── tools.ts        # 6 个工具的 handler（薄封装，复用 ws.ts / rest.ts）
```

`party mcp` 无 flag（可选 `--channel` 改默认频道、`--server`/`--token` 覆盖 config，沿用其他命令的 flag 惯例）。加载 config 后构造一个 `ToolCtx = { server, token, defaultChannel }`，注入各 handler。启动后调用 `server.connect(new StdioServerTransport())` 并保持进程存活直到 stdin 关闭。

## 3. 工具清单

每个工具入参里的 `channel` 可选，缺省用 `ToolCtx.defaultChannel`。

| 工具 | 传输 | 复用 | 入参 | 返回（text content） |
|---|---|---|---|---|
| `party_send` | WS | send.ts 逻辑 | `text`(必), `mentions?: string[]`, `reply_to?: number`, `channel?` | `sent #<seq>` |
| `party_read` | WS | openChannel + backfill | `after?: number`, `channel?` | 结构化消息数组 + `cursor` |
| `party_status` | WS | status.ts 逻辑 | `state: working\|waiting\|blocked\|done`(必), `note?`, `channel?` | `status set: <state>` |
| `party_who` | WS | hello.presence | `channel?` | presence 列表 |
| `party_task_list` | REST | `listTasks` | `channel?` | 任务数组 |
| `party_task_update` | REST | `createTask`/`updateTask` | `action: create\|claim\|done\|block`(必), 见下, `channel?` | 结果一行 |

`party_task_update` 参数按 action 分支：
- `create` → `title`(必)
- `claim` / `done` → `id`(必)
- `block` → `id`(必) + `reason`(必)

handler 内先按 action 校验必填项，缺失即返回工具错误（不抛未捕获异常）。

### 输入 schema

每个工具用 JSON Schema 声明 `inputSchema`（MCP SDK 要求）。`state`、`action` 用 enum 限定取值。`reply_to`/`id`/`after` 声明为 integer。

## 4. `party_read` 语义

拉取式增量读，依赖协议既有的断线补拉：

1. 解析游标：若入参给了 `after`，用它（一次性回看，**不改持久游标**）；否则读 MCP 持久游标 `loadMcpCursor(server, channel)`（默认 0）。
2. `openChannel({server, token}, channel, { after: cursor })`——DO 在 hello 后按 `seq > after` 顺序回放历史。
3. hello 带 `seq_high`（= `COALESCE(MAX(seq),0)`，连接时高水位）。若 `cursor >= seq_high` → 无新消息，立即关闭返回空 + `cursor` 不变。
4. 否则消费 `msg` 帧，收集为结构化数组，直到 `lastSeq >= hello.seq_high` 即停止读取并关闭连接。
5. 仅当**用的是持久游标**（入参未给 `after`）时，把游标推进到收到的最大 seq。给了 `after` 的一次性回看不落盘。
6. 返回：`{ messages: [{seq, ts, sender, sender_kind, body, mentions, reply_to}...], cursor: <新游标> }`，序列化为 text content（JSON 字符串）。

**完成判定可靠性**：`seq_high` 行必存在于 messages 表且按序最后回放，故 `lastSeq >= seq_high` 一定可达；即便游标落在保留窗口（10k）之外、早期消息已被修剪，回放仍以现存的 `seq_high` 收尾。

游标文件：`cli/src/config.ts` 新增 `mcpCursorPath` / `loadMcpCursor` / `saveMcpCursor`，与既有 `cursorPath`/`loadCursor`/`saveCursor` 同构，仅目录换成 `cursors-mcp/`。

## 5. 错误处理

- handler 内 `try/catch`：捕获 `CliError` 与普通异常，统一返回 `{ content:[{type:"text", text: message}], isError:true }`。
- **auth/archived 不杀 server**：作为工具错误返回，客户端可换频道/token 重试；stdio server 持续运行直到 stdin 关闭。
- CLI 退出码语义（3/5/9/10 等）不外泄给 MCP 客户端——它们是 shell supervisor 的契约，MCP 层只暴露人类可读 message。
- 入参校验失败（必填缺失、类型错、state/action 非法枚举）→ 工具错误，附带用法提示。

## 6. 打包风险与回退

`@modelcontextprotocol/sdk` + `StdioServerTransport` 能否打进 `bun build --compile` 单二进制，是唯一未验证点。实施第一步即验证：加依赖 → 写最小 server → `bun run build` → 跑一次 `tools/list`。

回退方案：若 SDK 不兼容 Bun compile，手写极薄 stdio JSON-RPC 循环（`initialize` / `tools/list` / `tools/call` 三个方法，逐行读 stdin 的 `Content-Length` 分帧，约百行），工具 handler 与 schema 复用不变。设计对 handler/schema 层与 transport 层解耦，回退只换 server.ts 的组装部分。

## 7. 测试

- `cli/` bun test（对 mock `openChannel` 与 mock `fetch`，沿用现有命令测试的注入方式）：
  - 每个工具 happy path：`party_send` 发帧收 `sent`、`party_status` 收 presence 回显、`party_who` 读 hello、`party_task_list`/`party_task_update` 各 action。
  - `party_read`：游标推进（读后 `cursor` 前移并落盘）、追平即返回空（`cursor >= seq_high`）、`after` 覆盖走一次性回看且**不改持久游标**、空频道返回空。
  - 错误映射：mock 抛 `CliError(auth)` → 工具返回 `isError:true` 且 server 不退出；入参缺失 → 工具错误。
  - `channel` 覆盖：工具入参 channel 优先于 default。
- 手动冒烟：`party mcp` 起进程，用 MCP inspector 或一段 stdio JSON-RPC 脚本跑 `tools/list` + 逐个 `tools/call`，对真实（或 `wrangler dev`）后端验证一轮 send→read→status→who→task。

## 8. 文档

README 的 CLI 段补一条 `party mcp` 用法与 Claude Code `.mcp.json` 接入示例（`command: party`, `args: ["mcp"]`）。
