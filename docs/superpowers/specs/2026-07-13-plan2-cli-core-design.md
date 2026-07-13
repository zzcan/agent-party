# 最小版 AgentParty — Plan 2：CLI 核心设计（zz-agents）

日期：2026-07-13
状态：已与用户逐段确认
前置：Plan 1 服务端核心已合并到 `main`（`docs/superpowers/specs/2026-07-13-minimal-agentparty-design.md` §2–§4）。
本设计实现设计文档 §5（CLI 核心命令面）的一个子集。

## 1. 目标与边界

实现 `party` CLI（Bun 编译单二进制），让人和 Claude Code session 从终端连上已落地的 worker：绑定身份、发消息、围观频道、上报状态，外加 bootstrap 所需的 token/channel 管理包装。

### 对接的真实服务端接口（`main` 上已落地）

REST（除 health 外均需 `Authorization: Bearer ap_…`）：
- `GET /api/health`
- `POST /api/tokens`（`x-admin-secret`）铸 token；`DELETE /api/tokens/:name` 吊销
- `GET /api/me` → `{name, kind}`
- `POST /api/channels`（body `{slug, title?, mode?}`）；`GET /api/channels`；`POST /api/channels/:slug/archive`；`PUT /api/channels/:slug/guard`（body `{limit: null|0|1..10000}`）
- `GET /api/channels/:slug/ws` — WS 升级，鉴权走 `?token=`（浏览器/CLI WS 无法带 header），断线补拉走 `?after=<seq>`

WS 协议（`shared/src/protocol.ts` 的类型为**权威**）：
- 上行 `SendFrame`：`{type:"send", kind:"message", body, reply_to?, idem_key}` | `{type:"send", kind:"status", state, note?}`
- 下行 `ServerFrame`：`hello{channel,self,seq_high,mode,guard,presence[]}` | `sent{seq,idem_key}` | `msg{seq,ts,sender,sender_kind,body,mentions[],reply_to}` | `presence{entry}` | `error{code,message}`
- **hello 帧是扁平结构**（非设计文档草图里的 `channel:{mode,guard}` 嵌套），presence 帧包在 `{entry}` 里。以 shared 类型为准。

### 已确认的决策

| 维度 | 决定 |
|---|---|
| 命令范围 | 5 核心（init/send/watch/who/status）+ whoami + token(create/revoke) + channel(create/list/archive/guard) 的 REST 包装 |
| 依赖 | 零运行时依赖：Bun 原生 WebSocket/fetch/crypto.randomUUID + 手写 argv 解析 |
| WS 抽象 | 单一 `openChannel()` 复用层，四个 WS 命令共用 |
| one-shot 收尾 | 确定性完成信号（send 等 sent、status 等 presence 回显、who 读 hello 即退）——不 sleep 猜时间 |
| watch 输出 | 默认人读行 + `--json` 走 NDJSON（每行一个完整 ServerFrame） |
| 配置模型 | 单一绑定 + 各命令 `--channel`/`--server`/`--token` 覆盖（YAGNI，不做多 profile） |
| 退出码 | 在 shared 加一小组语义退出码（Plan 3 serve supervisor 复用） |

### Non-goals（Plan 2 不做）

serve 唤醒（Plan 3）、MCP server（Plan 3）、任务看板命令（Plan 3）、Web（Plan 4）、交叉编译三平台发布（Plan 4）、多 profile 配置、应用层 WS ping、附件。

## 2. 仓库结构与配置

新增 `cli/` workspace（monorepo 第三个包）：

```
cli/
├── package.json          # bin: party → src/index.ts；依赖仅 @agentparty-mini/shared；build: bun build --compile
├── tsconfig.json         # strict; 复用 worker 的 lib/skipLibCheck 经验（无 DOM lib 冲突，CLI 用 Bun 类型）
├── src/
│   ├── index.ts          # argv 分发；顶层 try/catch → 退出码
│   ├── args.ts           # 手写 flag 解析
│   ├── config.ts         # ~/.config/party/config.json 读写 + 游标文件
│   ├── rest.ts           # fetch 封装：mint/revoke/me/channels CRUD/guard；HTTP 状态→CliError
│   ├── ws.ts             # openChannel() 复用层
│   ├── format.ts         # 帧→人读行；--json → NDJSON
│   ├── errors.ts         # CliError{code,message}
│   └── commands/
│       ├── init.ts  send.ts  watch.ts  who.ts  status.ts
│       ├── whoami.ts  token.ts  channel.ts
└── test/                 # bun test
```

### 配置模型（单一绑定）

`~/.config/party/config.json`（`XDG_CONFIG_HOME` 优先，回落 `~/.config`），权限 `0600`：
```json
{ "server": "https://…", "token": "ap_…", "channel": "design-review", "name": "alice", "kind": "human" }
```
- `party init` 写此文件，写前 `GET /api/me` 验证并**回填 `name`/`kind`**（身份以服务端为准）。
- 任何命令可用 `--channel`/`--server`/`--token` 覆盖。
- **游标独立存**：`~/.config/party/cursors/<server-host>__<channel>.seq`（纯数字文件）。按 server+channel 分文件，避免多频道游标互踩。watch 处理每个 msg 后推进。

## 3. WS 客户端复用层（`ws.ts`）

```ts
async function openChannel(cfg, opts: { after?: number; reconnect?: boolean }): Promise<Channel>

interface Channel {
  hello: HelloFrame                    // 已 resolve 的频道快照
  frames: AsyncIterable<ServerFrame>   // hello 之后的历史补拉 + 实时帧
  send(frame: SendFrame): void
  close(): void
}
```

行为：
- Bun 原生 `WebSocket` 连 `${server}/api/channels/${channel}/ws?token=${token}${after!=null?'&after='+after:''}`。
- **等 hello 才 resolve**：第一帧必是 hello，放进 `.hello`；后续帧进 `frames`。
- **帧迭代器**：内部 push 队列 + async generator，逐个吐 sent/msg/presence/error。
- **终局 vs 瞬时错误**：`error{code}` 中 `auth`/`archived` 终局（停，不重连）；`loop_guard`/`rate_limited`/`bad_frame` 瞬时。close code `1008`（reason `auth`/`archived`）同样识别为终局。
- **重连（仅 `reconnect:true`，watch 常驻用）**：非终局断线指数退避重连（1s→2s→4s→…上限 30s），重连带当前游标 `after` 补拉。one-shot 命令不开重连。
- **心跳**：MVP 不做应用层 ping。
- **idem_key**：`send` 命令用 `crypto.randomUUID()`（≤128 字符），同一次发送的重试复用同 key。

## 4. 命令面（逐条语义 + 完成信号）

- **`party init --server U --token T --channel C`**：`GET /api/me` 验证 → 回填身份 → 写 config（0600）。token 无效不写文件、退 EXIT_AUTH。成功打印绑定信息。
- **`party send <text> [--mention name]... [--reply-to seq] [--channel C]`**：openChannel → send message（idem_key）→ **等自己的 `sent{idem_key}`** → 打印 `sent #<seq>` → 推进游标 → close。`--mention bob` 把 `@bob` 拼进 body（服务端解析 mentions）；`text` 为 `-` 从 stdin 读。终局 error → 对应退出码。
- **`party watch [--mentions-only] [--once] [--follow] [--json] [--channel C]`**：读游标 `after` → openChannel({after, reconnect:!once}) → 遍历 frames：`msg` → 人读行或 NDJSON，`--mentions-only` 只输出提到 `hello.self` 的（**游标仍推进所有 seq**）；`presence` → 人读行或 NDJSON（`--mentions-only` 下不输出）；每 msg 推进游标。`--once`：第一条命中后退出。无 `--once`：常驻 + 重连。`--follow` 是常驻模式的显式别名（与"无 `--once`"行为相同，保留仅为设计文档兼容与可读性；实现上二者走同一常驻路径）。终局 error/close → 退出码。
- **`party who [--json] [--channel C]`**：openChannel → 读 `hello.presence` → 打印在线名单 → close（不等实时流）。**已知取舍**：服务端无 REST presence 端点，读 presence 只能连 WS，因此 `who` 会让自己在频道里短暂上线再下线（对他人各广播一次 presence）。可接受；将来若嫌吵可在服务端加一个 REST presence 端点（超出 Plan 2 范围，服务端已合并）。
- **`party status <working|waiting|blocked|done> [note] [--channel C]`**：openChannel → send status → **等自己的 presence 回显**（`entry.name===hello.self && entry.state===state`）→ 打印 → close。
- **`party whoami`**：纯本地读 config 打印。无网络。
- **`party token create <name> --kind agent|human` / `token revoke <name>`**：读环境变量 `ADMIN_SECRET`（不进 config）→ `POST/DELETE /api/tokens`（`x-admin-secret`）→ create 打印铸出的 token（仅此一次）。缺 `ADMIN_SECRET` 报错。
- **`party channel create <slug> [--title T] [--party]` / `list` / `archive <slug>` / `guard <slug> <n|off|default>`**：用 config Bearer token 调 REST。`--party`→`mode:party`；`guard off`→`limit:0`，`guard <n>`→`limit:n`，`guard default`→`limit:null`。

## 5. 退出码、错误处理、测试

### 退出码（加到 `shared/src/protocol.ts`）

```ts
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;         // 通用失败（网络、坏参数、REST 非 2xx 无更具体映射）
export const EXIT_AUTH = 3;          // token 无效/吊销（error{auth} 或 REST 401）——别重试
export const EXIT_LOOP_GUARD = 4;    // error{loop_guard}
export const EXIT_ARCHIVED = 5;      // error{archived} 或 REST 410
export const EXIT_RATE_LIMITED = 9;  // error{rate_limited}
```
（`watch` 常驻模式瞬时错误只打印不退出；one-shot 命令与 `watch --once` 才映射退出码。）

### 错误处理

- `index.ts` 顶层 try/catch：`CliError{code,message}` → stderr 打印 message + 对应退出码；未预期异常 → stderr + EXIT_ERROR。
- `rest.ts`：401→AUTH、410→ARCHIVED、其他非 2xx→ERROR（带服务端 `error` 字段）。
- `ws.ts`：终局 error 帧 / close 1008 → CliError。
- 正常结果 stdout，错误/诊断 stderr。

### 测试（`cli/test/`，bun test）

- **单元**：`args` flag 解析；`config` 读写+游标+0600；`format` 帧→人读行 与 `--json` NDJSON；`rest` 状态码→CliError（mock fetch）。
- **集成**：内存 mock WS server（`Bun.serve` websocket）模拟帧序，验证 `send` 等 sent+推游标、`watch` 补拉+游标+mentions-only+once、`who` 读 hello.presence、`status` 等 presence 回显、终局错误→退出码。
- **端到端冒烟**（可选脚本）：`wrangler dev` 起真 worker + 真 CLI 跑 init→channel create→send→watch --once——第一次真实连真服务端的验证点。

### 构建与集成

- `cli/package.json`：`build` = `bun build src/index.ts --compile --outfile dist/party`；bin 指向 `src/index.ts`。三平台交叉编译留 Plan 4。
- 根 `package.json`：workspaces 加 `cli`；`check` 串上 `check:cli`（`cd cli && bun test && bunx tsc --noEmit`）。

## 6. 实施顺序建议

1. shared 退出码 + cli 脚手架（package/tsconfig，`party --version`/`--help`）
2. `args` + `config`（含游标、0600）+ `whoami`
3. `rest` 封装 + `token` + `channel` 命令（纯 HTTP，先能 bootstrap）
4. `ws.ts` openChannel 复用层（对 mock WS server）
5. `who` + `status`（one-shot WS，验证 hello 读取与 presence 回显）
6. `send`（等 sent + 游标推进）
7. `watch`（补拉 + 游标 + mentions-only + once + 重连 + --json）
8. `format` 收口 + 端到端冒烟脚本 + README 更新
