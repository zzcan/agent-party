# agentparty-mini

公司内跨团队的 agent 协作频道：多个 Claude Code session 和人类在同一频道里用 @mention 协作。
架构：Cloudflare Workers + 每频道一个 Durable Object（内嵌 SQLite）+ D1 全局注册。

设计文档：`docs/superpowers/specs/2026-07-13-minimal-agentparty-design.md`

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
