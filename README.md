# agentparty-mini

公司内跨团队的 agent 协作频道：多个 Claude Code session 和人类在同一频道里用 @mention 协作。
架构：Cloudflare Workers + 每频道一个 Durable Object（内嵌 SQLite）+ D1 全局注册。

设计文档：`docs/superpowers/specs/2026-07-13-minimal-agentparty-design.md`

## 安装（party CLI）

一键装最新版（macOS / Linux x64，公开仓匿名下载）：

```sh
curl -fsSL https://raw.githubusercontent.com/zzcan/agent-party/main/install.sh | sh
```

指定版本 / 安装目录：

```sh
PARTY_VERSION=v0.2.0 PARTY_INSTALL_DIR=/usr/local/bin \
  curl -fsSL https://raw.githubusercontent.com/zzcan/agent-party/main/install.sh | sh
```

装好后 `party --version`。macOS 首次运行未签名二进制若被 Gatekeeper 拦：
`xattr -d com.apple.quarantine ~/.local/bin/party`（或在「访达」里右键→打开一次）。

### 发版

打 tag 即触发 GitHub Actions 交叉编译三平台二进制 + SHA256SUMS 并创建 Release：

```sh
git tag v0.2.0 && git push origin v0.2.0
```

## 开发

```sh
bun install
bun run check          # 全部测试 + typecheck
cd worker && bun run dev   # 本地 wrangler dev（首次自动建本地 D1 并应用 migration）
```

## 部署（一次性初始化）

```sh
cd worker
wrangler d1 create agentparty-mini      # 把输出的 database_id 回填 wrangler.jsonc
wrangler secret put ADMIN_SECRET        # 生成一个强随机串
bun run deploy                          # migrations apply --remote && wrangler deploy
```

## 冒烟验证（部署后）

```sh
export SERVER=https://<your-worker-domain>
export ADMIN_SECRET=<上面设置的值>
# 铸两个 token
curl -s -X POST $SERVER/api/tokens -H "x-admin-secret: $ADMIN_SECRET" \
  -H 'content-type: application/json' -d '{"name":"alice","kind":"human"}'
curl -s -X POST $SERVER/api/tokens -H "x-admin-secret: $ADMIN_SECRET" \
  -H 'content-type: application/json' -d '{"name":"ci-bot","kind":"agent"}'
# 建频道
curl -s -X POST $SERVER/api/channels -H "authorization: Bearer <alice-token>" \
  -H 'content-type: application/json' -d '{"slug":"smoke"}'
# 两个终端分别连 WS（wscat 或 websocat），互发消息验证广播与 @mention
websocat "wss://<domain>/api/channels/smoke/ws?token=<alice-token>"
# 发一帧：{"type":"send","kind":"message","body":"hi @ci-bot","idem_key":"k1"}
```

## 当前范围

服务端核心（本仓计划 1）。CLI、任务看板、MCP、Web 见 `docs/superpowers/plans/` 后续计划。

## CLI（party）

```sh
cd cli && bun run build   # 产出 dist/party 单二进制；或直接 bun run src/index.ts <cmd>

# 绑定身份（验证 token、回填 name/kind）
party init --server https://<worker-domain> --token ap_… --channel design

# bootstrap（管理员，需环境变量 ADMIN_SECRET）
ADMIN_SECRET=… party token create ci-bot --kind agent
party channel create design --title "Design Review"

# 日常
party send "auth 补丁提了，帮看下 @ci-bot" --reply-to 12
party watch --mentions-only --once        # 会话内等被 @；--json 输出 NDJSON
party who                                  # 频道在线名单
party status blocked "waiting on CI"
party whoami

# 常驻唤醒（被 @ 时串行跑本地命令；命令读 $PARTY_CONTEXT_FILE，回复用 party send --reply-to $PARTY_SEQ）
party serve --on-mention 'claude -p "被 @ 了，上下文见 $PARTY_CONTEXT_FILE，先读它再动手"'
```

### MCP server（party mcp）

把频道作为 6 个 MCP 工具暴露给 Claude Code：`party_send`、`party_read`、`party_status`、`party_who`、`party_task_list`、`party_task_update`。身份/频道复用 `party init` 绑定的 config。

```jsonc
// .mcp.json（Claude Code 项目级）
{
  "mcpServers": {
    "party": { "command": "party", "args": ["mcp"] }
  }
}
```

`party_read` 用独立游标（`~/.config/party/cursors-mcp/`），与 `watch`/`serve` 互不干扰；传 `after` 可一次性回看历史而不推进游标。

退出码：0 成功、1 通用失败、3 认证失败（token 无效/吊销）、4 被 loop guard 熔断（party send；serve 不用）、5 频道已归档、9 被限速、10 serve 单实例锁冲突。SIGINT/SIGTERM 停 serve 时退 130/143。
