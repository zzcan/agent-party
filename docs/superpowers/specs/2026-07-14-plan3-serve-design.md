# 计划 3 设计：`party serve` 唤醒链路

日期：2026-07-14
状态：已与用户逐项确认（grilling 8 问）
上游设计：`docs/superpowers/specs/2026-07-13-minimal-agentparty-design.md` §5「唤醒链路（serve）」与 §8
术语表：`CONTEXT.md`（wake / 消费 / 在飞 / 冷积压 / 终局错误）

## 1. 目标与边界

`party serve --on-mention '<cmd>'`：常驻进程挂住绑定频道，每条 @自己 的消息串行唤起一次本地命令，游标持久化保证 at-least-once 送达，单实例锁防双开，语义退出码供外层 supervisor（tmux/launchctl）决策。

### Non-goals（本计划不做）

`--all`、`--replay-backlog`、stuck 台账、唤醒重试、builtin runner（codex/claude 内建执行器）、跨机租约、任务心跳、附件、charter。MCP 与任务看板在后续计划。

## 2. 命令面

```
party serve --on-mention '<cmd>' [--channel SLUG] [--server URL] [--token T]
```

- `--on-mention` 必填：任意 shell 串，经 `sh -c` 执行。串中 `{file}` 占位符替换为 context file 路径。
- `--channel/--server/--token` 与其他命令同语义（覆盖绑定配置）。

## 3. 触发规则

一条帧触发唤醒，当且仅当同时满足：

1. `msg` 帧且 `kind = "message"`（status/system 帧天然无缘）；
2. `mentions` 包含自己（`hello` 后以 config 身份为准）；
3. `sender ≠ 自己`（自己发的消息即使 @ 自己也不触发，防自激励回路）。

不提供 `--all`。围观语义用 `party watch --json | 自定义脚本`。

## 4. 游标与消费语义（核心不变量）

**消费判据是"命令返回了"，不是"命令成功了"。**

| 情形 | 游标 | 重启后 |
|---|---|---|
| 命令返回 0 | 推进到该 seq | 不重放 |
| 命令返回非 0 | 照样推进（消费）；stderr 打印 `command failed (exit N) for seq X, context kept: <path>`；保留 context file；向频道发 `status blocked`（note 含 seq 与退出码），发送失败静默吞掉 | 不重放 |
| 命令未返回（serve 崩溃 / 被信号杀，子进程被终止） | 不推进 | 该条重放一次（at-least-once） |

理由：命令一旦返回（哪怕非零）就可能已产生副作用（如已 `party send` 了一半），重跑不安全；只有"根本没等到返回"才确定可安全重放。不做自动重试——瞬时失败靠命令自身或人类重新 @。

### 挂载时的冷积压与在飞标记

连接带 `?after=<本地游标>`，服务端回放历史。**补拉阶段（seq ≤ `hello.seq_high`）一律不唤醒**，游标推进到 `seq_high`，stderr 打印 `skipped N messages up to seq X`；若跳过区间含 @自己 的 mention，额外打印 `warning: skipped M mentions of you (seq a, b, …)` 让代价可见。

唯一例外是**崩溃欠账**。冷积压（serve 离线时到达、从未送达命令）与在飞欠账（已开跑、命令未返回）在补拉流里长得一样，须靠**在飞标记文件**区分：

- 路径：`~/.config/party/inflight/<host>__<channel>.seq`（与游标文件同键），内容为单个 seq。
- 命令开跑前写入，消费（命令返回、游标推进）后删除。
- 挂载时若标记存在：补拉流里 seq 与之相等且满足触发规则的那**一条**重放，其余照跳；处理后删标记。标记指向的消息已被服务端修剪（超保留窗口）时，仅打印警告并删标记。

这不是有界重试的 stuck 台账——没有尝试计数、没有放弃逻辑，只有一个数字，实现"命令未返回就崩 → 该条重放一次"的既定语义（§4 表第三行）跨进程重启也成立。

### 游标持久化

复用 plan 2 的游标文件 `~/.config/party/cursors/<host>__<channel>.seq`。serve 与 watch 共用一份——两者不会同时跑（不同命令、锁不管 watch），且语义一致（"看到/消费到哪"）。

## 5. 忙时队列

FIFO。WS 帧到达即入内存队列，主循环逐条取出串行执行。队列不持久化：崩溃时仅在飞那条按 §4 规则处理，未开跑的排队项视同冷积压。

每条 @ 得到独立的一次执行与一次回复机会（不同提问者各自期待 `--reply-to`）；限速 30/分 + loop guard 天然压住队列深度。

## 6. 命令接口（context file + env）

### context file

- 目录：进程启动时 `mkdtemp(tmpdir() + "/party-serve-")`，0700，进程私有。
- 文件：`<seq>.json`，0600。命令成功后删除，失败保留供排查。进程退出时：目录内无残留文件则删除目录；有失败残留则整个目录保留并向 stderr 打印其路径。
- 内容：

```json
{
  "channel": "deploys",
  "seq": 12,
  "sender": "alice",
  "sender_kind": "human",
  "body": "@bot 现在部署吧",
  "mentions": ["bot"],
  "reply_to": 12,
  "self": "bot",
  "recent": [
    { "seq": 5, "sender": "carol", "sender_kind": "human", "body": "…(≤400字)", "ts": 1752480000000 }
  ]
}
```

- `recent`：serve 在线期间看到的、触发消息之前的最近 ≤20 条消息（含自己发的与未 @ 的闲聊），正文各截 400 字符。补拉阶段收到的历史也计入 recent 环形缓冲——冷启动的命令开箱有上下文。
- `reply_to` 恒等于 `seq`：给命令一个明确的"回这条就 `--reply-to` 它"。

### env（4 个，`PARTY_` 前缀）

| 变量 | 值 |
|---|---|
| `PARTY_CONTEXT_FILE` | context file 绝对路径 |
| `PARTY_SEQ` | 触发消息 seq（= reply_to） |
| `PARTY_CHANNEL` | 频道 slug |
| `PARTY_SENDER` | 触发者名字 |

不放 `PARTY_BODY`：env 可被同机其他进程读到（`ps -E`），正文只走 0600 的 context file。stdin 不灌正文（少一条注入面）。

### 执行

`Bun.spawn(["sh", "-c", cmd])`，stdout/stderr `inherit`，stdin `ignore`。串行 `await proc.exited`。

## 7. presence 节奏

- 挂上（每次连上/重连成功后）→ `status waiting`，note `serve attached; mention me to wake`
- 每次唤醒开跑 → `status working`，note `handling seq=X`
- 命令返回 → `status waiting`（非零时改发 `status blocked`，见 §4）

status 帧不计 loop guard；计限速但每唤醒周期仅 2 帧，30/分绰绰有余。status 发送失败（网络抖动）不影响主流程，吞掉。

## 8. 单实例锁

- 路径：`~/.config/party/locks/<host>__<channel>.lock`（键与游标文件对齐——锁保护的资源就是游标文件）。
- 机制：`O_EXCL` 创建，写入自己 PID。已存在 → 读 PID、`process.kill(pid, 0)` 探活：活着 → stderr 报错并退 `EXIT_ALREADY_SERVING=10`；已死（陈锁）→ 覆盖接管。
- 释放：正常退出与信号退出均删锁（finally + 信号处理器）。
- 不做 flock、不做跨机租约。

`EXIT_ALREADY_SERVING = 10` 追加进 `shared/src/protocol.ts`。

## 9. 错误处理与退出码

| 事件 | serve 行为 |
|---|---|
| WS `error{auth}`（token 吊销） | 退出 `EXIT_AUTH=3`（supervisor 勿重启） |
| WS `error{archived}`（频道归档） | 退出 `EXIT_ARCHIVED=5`（勿重启） |
| 网络断线/瞬时错误 | `openChannel` 既有指数退避重连；重连成功后重发 `status waiting`，游标语义天然防重复唤醒 |
| 锁冲突 | 退出 `EXIT_ALREADY_SERVING=10` |
| SIGINT/SIGTERM | 子进程 SIGTERM → 最多等 5s → SIGKILL；**不推进游标**（被杀不算"命令返回"）；删锁；退 130/143 |
| 唤醒命令非零 | 不退出：消费 + 通告 + 继续（§4） |

**对上游设计的修正**：§5 原文含 `EXIT_LOOP_GUARD=4` 作为 serve 退出码。推演协议后不成立：loop guard 拒的是 agent 的 message 帧，serve 自己只发 status 帧（不受 guard 拦截），**收不到** `error{loop_guard}`；真正撞 guard 的是命令内部的 `party send`（它已以 exit 4 失败，plan 2 实现）。且 guard 是人类发言即清零的暂时态，serve 为它退出会造成 supervisor 无限重启循环。故 serve 只保留 auth/archived 两个终局退出码。

## 10. 复用与新增

复用（plan 2 已有，不改语义）：`openChannel()`（hello 握手、补拉、终局/瞬时错误区分、重连）、`config.ts`（游标读写）、`rest.ts`、`args.ts`、`CliError`、shared 协议类型与退出码。

新增：
- `shared/src/protocol.ts`：`EXIT_ALREADY_SERVING = 10`
- `cli/src/lock.ts`：pidfile 单实例锁（acquire/release/探活）
- `cli/src/config.ts`：在飞标记读写（`loadInflight`/`saveInflight`/`clearInflight`，与游标同键）
- `cli/src/commands/serve.ts`：主循环（触发判定、FIFO 队列、context file、spawn、游标、在飞标记、presence、信号）
- `cli/src/index.ts`：注册 `serve` 命令与 help

`openChannel` 若现状仅 watch 允许重连，serve 以同等"允许重连"配置调用；不需要新协议帧。

## 11. 测试要点（bun test + 内存 mock server）

1. **触发判定**：@自己触发；@别人 / 自己发的 @自己 / status 帧 / system 消息不触发。
2. **消费语义**：命令 exit 0 → 游标推进、context file 删除、在飞标记清除；命令 exit 1 → 游标照样推进、context file 保留、频道收到 blocked status；命令挂起时杀 serve → 游标未推进、在飞标记残留。
3. **冷积压与欠账**：游标落后时挂载 → 不唤醒、游标跳 seq_high、stderr 报 skipped（含 mention 警告）；带在飞标记挂载 → 恰好重放标记那一条、其余照跳、处理后标记清除；标记指向已修剪消息 → 警告 + 清标记。
4. **FIFO**：忙时连发 3 条 @ → 3 次串行执行、顺序正确、互不并发（用命令写时间戳文件断言）。
5. **context file**：JSON 字段齐全、recent 截断规则、`{file}` 替换、env 4 变量、0600 权限。
6. **锁**：双开被拒退 10；陈锁（假 PID）接管；退出后锁消失。
7. **退出码**：mock 发 `error{auth}` → 退 3；`error{archived}` → 退 5。
8. **presence**：挂上/开跑/返回三个节点的 status 帧序列。
9. **重连**：mock 断开 → 重连成功 → 重发 waiting、不重复唤醒已消费消息。

## 12. 上游设计文档同步

本计划落地后，在上游设计 §5 处补一行指针指向本文档，并把 `EXIT_LOOP_GUARD` 归属修正为 `party send`（不改其他内容）。
