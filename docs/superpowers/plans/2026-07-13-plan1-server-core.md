# 计划 1：服务端核心（shared 协议 + worker）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现最小版 AgentParty 的服务端核心：shared 协议包 + Cloudflare Worker（Hono 路由、每频道 ChannelDO、D1 token/频道注册），完成后可用 vitest 内的 WebSocket 客户端完整走通 连接→hello→发消息→广播→补拉→loop guard 全链路。

**Architecture:** Bun monorepo（本计划只建 `shared/` 和 `worker/` 两个 workspace）。Hono 在边缘做 REST 与 WS 鉴权，剥离客户端注入的 `x-ap-*` 头后以权威头转发给每频道一个的 ChannelDO（继承 partyserver `Server`，内嵌 SQLite）；D1 存 tokens 和 channels 两张全局表。频道配置（mode/guard/archived）随 WS 升级头进 DO 缓存进 meta，配置变更端点同步 poke DO 内部接口。

**Tech Stack:** Bun ≥1.2、TypeScript（strict）、hono ^4、partyserver ^0.5、wrangler ^4、vitest ~4.1 + @cloudflare/vitest-pool-workers ^0.18。

**设计文档：** `docs/superpowers/specs/2026-07-13-minimal-agentparty-design.md`（本计划实现其 §2–§4 与 §8 服务端部分）。
**参考实现（只看语义不抄代码）：** `/private/tmp/claude-501/-Users-zzcan-Desktop-workspace-codes-zz-agents/72994498-ca71-4ff5-9984-8c55344d3ce5/scratchpad/agentparty`

## Global Constraints

- 协议常量 verbatim：`BODY_LIMIT=100_000`、`RATE_LIMIT_PER_MIN=30`、`LOOP_GUARD_N=30`、`LOOP_GUARD_PARTY_N=200`、`RETAIN_N=10_000`、`PRESENCE_TIMEOUT_MS=60_000`、`IDEMPOTENCY_WINDOW_MS=600_000`、`IDEMPOTENCY_KEY_MAX=128`。
- 名字/slug 规则统一：`/^[a-z0-9][a-z0-9-]{0,31}$/`；保留名 `system` 不得铸 token。
- token 格式：`ap_` + 32 位 hex；D1 只存 SHA-256 hex 哈希。
- `compatibility_date: "2026-06-01"`；DO 用 `new_sqlite_classes`。
- 所有包 `"type": "module"`、`"private": true`；TypeScript `strict: true`。
- 测试可调参数一律走 env 覆盖（`RETAIN_N`、`RATE_LIMIT_PER_MIN`、`AUTH_CACHE_TTL_MS`），生产不设即用协议常量。
- 提交信息用 conventional commits；每个任务至少一个 commit。
- 不复制参考仓库代码；仅对照其 spec 与 API 用法。

---

### Task 1: Monorepo 脚手架 + shared 常量

**Files:**
- Create: `package.json`（根）
- Create: `.gitignore`
- Create: `shared/package.json`
- Create: `shared/tsconfig.json`
- Create: `shared/src/protocol.ts`

**Interfaces:**
- Produces: `@agentparty-mini/shared` 包，导出常量 `BODY_LIMIT` 等与类型 `SenderKind`、`ChannelMode`、`StatusState`、`PresenceState`、`ErrorCode`、`PresenceEntry`、`SendFrame`、`ServerFrame`（后续所有任务导入）。

- [ ] **Step 1: 写根 package.json 和 .gitignore**

`package.json`：

```json
{
  "name": "agentparty-mini",
  "private": true,
  "type": "module",
  "workspaces": ["shared", "worker"],
  "scripts": {
    "check": "bun run check:shared && bun run check:worker",
    "check:shared": "cd shared && bun test && bunx tsc --noEmit",
    "check:worker": "cd worker && bunx vitest run && bunx tsc --noEmit"
  }
}
```

`.gitignore`：

```
node_modules/
dist/
.wrangler/
.dev.vars
```

- [ ] **Step 2: 写 shared 包骨架**

`shared/package.json`：

```json
{
  "name": "@agentparty-mini/shared",
  "private": true,
  "type": "module",
  "version": "0.1.0",
  "exports": { ".": "./src/protocol.ts" },
  "devDependencies": { "typescript": "^5.9.0" }
}
```

`shared/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "types": []
  },
  "include": ["src", "test"]
}
```

`shared/src/protocol.ts`（本任务只放常量与类型，解析函数在 Task 2 加）：

```ts
// agentparty-mini wire protocol — worker 与 cli 的单一事实来源

export const BODY_LIMIT = 100_000;
export const RATE_LIMIT_PER_MIN = 30;
export const LOOP_GUARD_N = 30;
export const LOOP_GUARD_PARTY_N = 200;
export const RETAIN_N = 10_000;
export const PRESENCE_TIMEOUT_MS = 60_000;
export const IDEMPOTENCY_WINDOW_MS = 10 * 60_000;
export const IDEMPOTENCY_KEY_MAX = 128;
// "system" 是 loop guard 熔断通告的发信名，不得铸成真实 token
export const RESERVED_NAMES: readonly string[] = ["system"];

export type SenderKind = "agent" | "human";
export type ChannelMode = "normal" | "party";
export type StatusState = "working" | "waiting" | "blocked" | "done";
export type PresenceState = StatusState | "offline";
export type ErrorCode = "auth" | "archived" | "loop_guard" | "rate_limited" | "bad_frame";

export interface PresenceEntry {
  name: string;
  kind: SenderKind;
  state: PresenceState;
  note: string | null;
  last_seen: number;
}

export type SendFrame =
  | { type: "send"; kind: "message"; body: string; reply_to?: number; idem_key: string }
  | { type: "send"; kind: "status"; state: StatusState; note?: string };

export type ServerFrame =
  | {
      type: "hello";
      channel: string;
      self: string;
      seq_high: number;
      mode: ChannelMode;
      guard: number; // 解析后的熔断阈值，0 = 关闭
      presence: PresenceEntry[];
    }
  | { type: "sent"; seq: number; idem_key: string }
  | {
      type: "msg";
      seq: number;
      ts: number;
      sender: string;
      sender_kind: SenderKind;
      body: string;
      mentions: string[];
      reply_to: number | null;
    }
  | { type: "presence"; entry: PresenceEntry }
  | { type: "error"; code: ErrorCode; message: string };
```

- [ ] **Step 3: 安装依赖并验证 typecheck**

Run: `bun install && cd shared && bunx tsc --noEmit`
Expected: 无输出，退出码 0

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore shared/ bun.lock
git commit -m "feat: monorepo scaffold + shared protocol constants and types"
```

---

### Task 2: shared 帧解析、mention 提取、名字校验

**Files:**
- Modify: `shared/src/protocol.ts`（追加函数）
- Create: `shared/test/protocol.test.ts`

**Interfaces:**
- Produces:
  - `isName(s: unknown): s is string` — 名字/slug 统一校验
  - `extractMentions(body: string): string[]` — 去重、保序
  - `parseSendFrame(raw: string): { frame: SendFrame } | { error: string }` — worker 的 onMessage 与 CLI 复用

- [ ] **Step 1: 写失败测试**

`shared/test/protocol.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import {
  BODY_LIMIT,
  extractMentions,
  isName,
  parseSendFrame,
} from "../src/protocol";

describe("isName", () => {
  test("接受小写字母数字和连字符", () => {
    expect(isName("bob")).toBe(true);
    expect(isName("ci-bot-2")).toBe(true);
  });
  test("拒绝大写、下划线、超长、首连字符、非字符串", () => {
    expect(isName("Bob")).toBe(false);
    expect(isName("a_b")).toBe(false);
    expect(isName("-ab")).toBe(false);
    expect(isName("a".repeat(33))).toBe(false);
    expect(isName(42)).toBe(false);
    expect(isName("")).toBe(false);
  });
});

describe("extractMentions", () => {
  test("提取多个 mention 并去重保序", () => {
    expect(extractMentions("@bob look, @carol and @bob again")).toEqual(["bob", "carol"]);
  });
  test("无 mention 返回空数组", () => {
    expect(extractMentions("plain text")).toEqual([]);
  });
  test("邮箱里的 @ 不算 mention 的一部分只从 @ 后取合法名", () => {
    expect(extractMentions("mail a@b-c ok")).toEqual(["b-c"]);
  });
});

describe("parseSendFrame", () => {
  test("合法 message 帧", () => {
    const r = parseSendFrame(
      JSON.stringify({ type: "send", kind: "message", body: "hi @bob", idem_key: "k1" }),
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.frame.kind).toBe("message");
  });
  test("合法 status 帧", () => {
    const r = parseSendFrame(JSON.stringify({ type: "send", kind: "status", state: "working" }));
    if ("error" in r) throw new Error(r.error);
    expect(r.frame.kind).toBe("status");
  });
  test("拒绝非 JSON / 错误 type / 错误 kind", () => {
    expect("error" in parseSendFrame("not json")).toBe(true);
    expect("error" in parseSendFrame(JSON.stringify({ type: "x" }))).toBe(true);
    expect("error" in parseSendFrame(JSON.stringify({ type: "send", kind: "x" }))).toBe(true);
  });
  test("message 帧缺 body / 缺 idem_key / body 超限 / idem_key 超限被拒", () => {
    expect("error" in parseSendFrame(JSON.stringify({ type: "send", kind: "message", idem_key: "k" }))).toBe(true);
    expect("error" in parseSendFrame(JSON.stringify({ type: "send", kind: "message", body: "x" }))).toBe(true);
    expect(
      "error" in
        parseSendFrame(
          JSON.stringify({ type: "send", kind: "message", body: "x".repeat(BODY_LIMIT + 1), idem_key: "k" }),
        ),
    ).toBe(true);
    expect(
      "error" in
        parseSendFrame(
          JSON.stringify({ type: "send", kind: "message", body: "x", idem_key: "k".repeat(129) }),
        ),
    ).toBe(true);
  });
  test("status 帧非法 state 被拒", () => {
    expect("error" in parseSendFrame(JSON.stringify({ type: "send", kind: "status", state: "zzz" }))).toBe(true);
  });
  test("reply_to 必须是正整数", () => {
    expect(
      "error" in
        parseSendFrame(
          JSON.stringify({ type: "send", kind: "message", body: "x", idem_key: "k", reply_to: -1 }),
        ),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd shared && bun test`
Expected: FAIL，`extractMentions is not a function` 等

- [ ] **Step 3: 实现**

追加到 `shared/src/protocol.ts`：

```ts
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isName(s: unknown): s is string {
  return typeof s === "string" && NAME_RE.test(s);
}

export function extractMentions(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/@([a-z0-9][a-z0-9-]{0,31})/g)) out.add(m[1]);
  return [...out];
}

const STATUS_STATES: readonly string[] = ["working", "waiting", "blocked", "done"];

export function parseSendFrame(raw: string): { frame: SendFrame } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { error: "not valid JSON" };
  }
  if (typeof v !== "object" || v === null) return { error: "frame must be an object" };
  const f = v as Record<string, unknown>;
  if (f.type !== "send") return { error: "type must be 'send'" };
  if (f.kind === "message") {
    if (typeof f.body !== "string" || f.body.length === 0) return { error: "body required" };
    if (f.body.length > BODY_LIMIT) return { error: `body exceeds ${BODY_LIMIT}` };
    if (typeof f.idem_key !== "string" || f.idem_key.length === 0) return { error: "idem_key required" };
    if (f.idem_key.length > IDEMPOTENCY_KEY_MAX) return { error: "idem_key too long" };
    if (f.reply_to !== undefined && (!Number.isInteger(f.reply_to) || (f.reply_to as number) < 1))
      return { error: "reply_to must be a positive integer" };
    return {
      frame: {
        type: "send",
        kind: "message",
        body: f.body,
        idem_key: f.idem_key,
        ...(f.reply_to !== undefined ? { reply_to: f.reply_to as number } : {}),
      },
    };
  }
  if (f.kind === "status") {
    if (typeof f.state !== "string" || !STATUS_STATES.includes(f.state))
      return { error: "state must be working|waiting|blocked|done" };
    if (f.note !== undefined && (typeof f.note !== "string" || f.note.length > 500))
      return { error: "note must be a string ≤500 chars" };
    return {
      frame: {
        type: "send",
        kind: "status",
        state: f.state as StatusState,
        ...(f.note !== undefined ? { note: f.note as string } : {}),
      },
    };
  }
  return { error: "kind must be 'message' or 'status'" };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd shared && bun test && bunx tsc --noEmit`
Expected: 全部 PASS，typecheck 干净

- [ ] **Step 5: Commit**

```bash
git add shared/
git commit -m "feat(shared): frame parsing, mention extraction, name validation"
```

---

### Task 3: worker 脚手架 + vitest-pool-workers + /api/health

**Files:**
- Create: `worker/package.json`
- Create: `worker/tsconfig.json`
- Create: `worker/wrangler.jsonc`
- Create: `worker/vitest.config.ts`
- Create: `worker/test/apply-migrations.ts`
- Create: `worker/migrations/0001_init.sql`
- Create: `worker/src/index.ts`
- Create: `worker/src/do.ts`
- Create: `worker/test/health.spec.ts`

**Interfaces:**
- Produces:
  - `Env` 接口（`worker/src/index.ts` 导出）：`{ DB: D1Database; CHANNELS: DurableObjectNamespace; ADMIN_SECRET: string; RETAIN_N?: string; RATE_LIMIT_PER_MIN?: string; AUTH_CACHE_TTL_MS?: string }`
  - `ChannelDO` 类（`worker/src/do.ts` 导出，本任务是空壳，Task 6 起填充）
  - D1 表 `tokens(name, hash, kind, created_at, revoked_at)`、`channels(slug, title, mode, guard_limit, created_at, archived_at)`
  - 测试基建：`SELF.fetch` 可用、migration 自动应用

- [ ] **Step 1: 写包配置**

`worker/package.json`：

```json
{
  "name": "@agentparty-mini/worker",
  "private": true,
  "type": "module",
  "version": "0.1.0",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler d1 migrations apply agentparty-mini --remote && wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@agentparty-mini/shared": "workspace:*",
    "hono": "^4.12.0",
    "partyserver": "^0.5.8"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.18.4",
    "@cloudflare/workers-types": "^4.20260601.0",
    "typescript": "^5.9.0",
    "vitest": "~4.1.0",
    "wrangler": "^4.22.0"
  }
}
```

`worker/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 2: 写 wrangler 配置和 migration**

`worker/wrangler.jsonc`：

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "agentparty-mini",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "durable_objects": {
    "bindings": [{ "name": "CHANNELS", "class_name": "ChannelDO" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ChannelDO"] }],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "agentparty-mini",
      // 部署前运营执行 `wrangler d1 create agentparty-mini` 并回填真实 id；测试用 miniflare 不校验
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "migrations"
    }
  ]
}
```

`worker/migrations/0001_init.sql`：

```sql
CREATE TABLE tokens (
  name TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('agent','human')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE channels (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal','party')),
  guard_limit INTEGER,          -- NULL=按 mode 默认；0=关闭
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
```

- [ ] **Step 3: 写 vitest 配置和 migration setup**

`worker/vitest.config.ts`：

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const workerDir = path.dirname(fileURLToPath(import.meta.url));
  const migrations = await readD1Migrations(path.join(workerDir, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            ADMIN_SECRET: "test-admin-secret",
            TEST_MIGRATIONS: migrations,
            // 测试可调参数：吊销缓存关掉让吊销即时生效；限速抬高避免多发消息的 spec 误触
            AUTH_CACHE_TTL_MS: "0",
            RATE_LIMIT_PER_MIN: "100",
            RETAIN_N: "50",
          },
        },
      }),
    ],
    test: {
      testTimeout: 20_000,
      hookTimeout: 20_000,
      // WS/DO 状态跨 tick 存活，spec 文件并行会互相 invalidate DO，串行跑
      fileParallelism: false,
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
```

`worker/test/apply-migrations.ts`：

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 4: 写失败测试**

`worker/test/health.spec.ts`：

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("/api/health", () => {
  it("returns ok", async () => {
    const res = await SELF.fetch("https://x/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

另建 `worker/test/env.d.ts` 让测试文件里的 `env` 有类型：

```ts
declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    CHANNELS: DurableObjectNamespace;
    ADMIN_SECRET: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
```

- [ ] **Step 5: 运行确认失败**

Run: `bun install && cd worker && bunx vitest run`
Expected: FAIL（src/index.ts 不存在）

- [ ] **Step 6: 写最小实现**

`worker/src/do.ts`（空壳，Task 6 填充）：

```ts
import { Server } from "partyserver";
import type { Env } from "./index";

export class ChannelDO extends Server<Env> {}
```

`worker/src/index.ts`：

```ts
import { Hono } from "hono";
import { ChannelDO } from "./do";

export interface Env {
  DB: D1Database;
  CHANNELS: DurableObjectNamespace;
  ADMIN_SECRET: string;
  // 测试用覆盖，生产不设
  RETAIN_N?: string;
  RATE_LIMIT_PER_MIN?: string;
  AUTH_CACHE_TTL_MS?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

export { ChannelDO };
export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
```

- [ ] **Step 7: 运行确认通过**

Run: `cd worker && bunx vitest run && bunx tsc --noEmit`
Expected: health spec PASS，typecheck 干净

- [ ] **Step 8: Commit**

```bash
git add worker/ bun.lock
git commit -m "feat(worker): scaffold with wrangler, vitest-pool-workers, health endpoint"
```

---

### Task 4: token 铸造、认证、吊销

**Files:**
- Create: `worker/src/auth.ts`
- Modify: `worker/src/index.ts`
- Create: `worker/test/tokens.spec.ts`

**Interfaces:**
- Produces（`worker/src/auth.ts`）：
  - `interface Identity { name: string; kind: "agent" | "human"; hash: string }`
  - `sha256Hex(s: string): Promise<string>`
  - `generateToken(): string` — `"ap_" + 32 hex`
  - `identityFromRequest(db: D1Database, req: Request): Promise<Identity | null>` — 支持 `Authorization: Bearer ap_…` 与 `?token=`（Web WS 用），吊销的返回 null
- Produces（REST）：
  - `POST /api/tokens`（头 `x-admin-secret`）body `{name, kind}` → 201 `{token, name, kind}`；名字非法/保留/重复 → 400/409
  - `DELETE /api/tokens/:name`（头 `x-admin-secret`）→ 200
  - `GET /api/me`（Bearer）→ `{name, kind}`；无效/吊销 → 401
- 后续任务复用：`identityFromRequest` 是 WS 升级（Task 6）与所有需鉴权端点的唯一入口。

- [ ] **Step 1: 写失败测试**

`worker/test/tokens.spec.ts`：

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ADMIN = { "x-admin-secret": "test-admin-secret" };

export async function mintToken(name: string, kind: "agent" | "human"): Promise<string> {
  const res = await SELF.fetch("https://x/api/tokens", {
    method: "POST",
    headers: { ...ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ name, kind }),
  });
  if (res.status !== 201) throw new Error(`mint failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token: string };
  return body.token;
}

describe("tokens", () => {
  it("无 admin secret 铸 token 返回 401", async () => {
    const res = await SELF.fetch("https://x/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "t4-a", kind: "agent" }),
    });
    expect(res.status).toBe(401);
  });

  it("铸 token 返回 ap_ 前缀，/api/me 能换回身份", async () => {
    const token = await mintToken("t4-bob", "agent");
    expect(token).toMatch(/^ap_[0-9a-f]{32}$/);
    const me = await SELF.fetch("https://x/api/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ name: "t4-bob", kind: "agent" });
  });

  it("非法名 / 保留名 system / 重名被拒", async () => {
    const bad = await SELF.fetch("https://x/api/tokens", {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "Bad_Name", kind: "agent" }),
    });
    expect(bad.status).toBe(400);
    const reserved = await SELF.fetch("https://x/api/tokens", {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "system", kind: "agent" }),
    });
    expect(reserved.status).toBe(400);
    await mintToken("t4-dup", "human");
    const dup = await SELF.fetch("https://x/api/tokens", {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "t4-dup", kind: "human" }),
    });
    expect(dup.status).toBe(409);
  });

  it("吊销后 /api/me 返回 401", async () => {
    const token = await mintToken("t4-gone", "human");
    const del = await SELF.fetch("https://x/api/tokens/t4-gone", { method: "DELETE", headers: ADMIN });
    expect(del.status).toBe(200);
    const me = await SELF.fetch("https://x/api/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(401);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd worker && bunx vitest run test/tokens.spec.ts`
Expected: FAIL（404，路由不存在）

- [ ] **Step 3: 实现 auth.ts**

`worker/src/auth.ts`：

```ts
export interface Identity {
  name: string;
  kind: "agent" | "human";
  hash: string;
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return "ap_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function tokenFromRequest(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  // 浏览器 WebSocket 无法带 Authorization 头，Web 端 WS 走 query 参数
  const q = new URL(req.url).searchParams.get("token");
  return q || null;
}

export async function identityFromRequest(db: D1Database, req: Request): Promise<Identity | null> {
  const token = tokenFromRequest(req);
  if (!token?.startsWith("ap_")) return null;
  const hash = await sha256Hex(token);
  const row = await db
    .prepare("SELECT name, kind FROM tokens WHERE hash = ? AND revoked_at IS NULL")
    .bind(hash)
    .first<{ name: string; kind: "agent" | "human" }>();
  return row ? { name: row.name, kind: row.kind, hash } : null;
}
```

- [ ] **Step 4: 在 index.ts 加路由**

在 `worker/src/index.ts` 的 imports 后、`app.get("/api/health"...)` 前后加入：

```ts
import { isName, RESERVED_NAMES } from "@agentparty-mini/shared";
import { generateToken, identityFromRequest, sha256Hex, type Identity } from "./auth";

type Vars = { identity: Identity };
// 将 app 声明改为：
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const requireAdmin = async (c: any, next: any) => {
  if (c.req.header("x-admin-secret") !== c.env.ADMIN_SECRET) {
    return c.json({ error: "admin secret required" }, 401);
  }
  await next();
};

const requireAuth = async (c: any, next: any) => {
  const identity = await identityFromRequest(c.env.DB, c.req.raw);
  if (!identity) return c.json({ error: "invalid or revoked token" }, 401);
  c.set("identity", identity);
  await next();
};

app.post("/api/tokens", requireAdmin, async (c) => {
  const body = await c.req.json<{ name?: unknown; kind?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const { name, kind } = body;
  if (!isName(name) || RESERVED_NAMES.includes(name)) return c.json({ error: "invalid name" }, 400);
  if (kind !== "agent" && kind !== "human") return c.json({ error: "kind must be agent|human" }, 400);
  const token = generateToken();
  const hash = await sha256Hex(token);
  try {
    await c.env.DB.prepare("INSERT INTO tokens (name, hash, kind, created_at) VALUES (?, ?, ?, ?)")
      .bind(name, hash, kind, Date.now())
      .run();
  } catch {
    return c.json({ error: "name already exists" }, 409);
  }
  return c.json({ token, name, kind }, 201);
});

app.delete("/api/tokens/:name", requireAdmin, async (c) => {
  await c.env.DB.prepare("UPDATE tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL")
    .bind(Date.now(), c.req.param("name"))
    .run();
  return c.json({ ok: true });
});

app.get("/api/me", requireAuth, (c) => {
  const { name, kind } = c.get("identity");
  return c.json({ name, kind });
});
```

- [ ] **Step 5: 运行确认通过**

Run: `cd worker && bunx vitest run && bunx tsc --noEmit`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src worker/test
git commit -m "feat(worker): token minting, bearer auth, revocation"
```

---

### Task 5: channels REST API（D1 面）

**Files:**
- Modify: `shared/src/protocol.ts`（追加 `resolveGuardLimit`）
- Modify: `worker/src/index.ts`
- Create: `worker/test/channels.spec.ts`

**Interfaces:**
- Produces（shared）：`resolveGuardLimit(mode: ChannelMode, guard_limit: number | null): number` — `NULL→按 mode 默认（30/200），显式值原样（0=关）`
- Produces（REST，全部 `requireAuth`）：
  - `POST /api/channels` body `{slug, title?, mode?}` → 201 频道行；非法 slug 400、重复 409
  - `GET /api/channels` → `{channels: [...]}` 未归档列表
  - `POST /api/channels/:slug/archive` → 200（本任务只写 D1；Task 10 加 DO poke）
  - `PUT /api/channels/:slug/guard` body `{limit: number|null}`（null=按 mode 默认，0=关，1..10000）→ 200（Task 9 加 DO poke）
- Consumes: Task 4 的 `requireAuth` 中间件与 `mintToken` 测试辅助。

- [ ] **Step 1: 写失败测试**

`worker/test/channels.spec.ts`：

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintToken } from "./tokens.spec";

async function authed(path: string, token: string, init: RequestInit = {}) {
  return SELF.fetch(`https://x${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("channels", () => {
  it("创建、列出、重复创建 409、非法 slug 400、未认证 401", async () => {
    const token = await mintToken("t5-alice", "human");
    const created = await authed("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: "t5-design", title: "Design Review" }),
    });
    expect(created.status).toBe(201);
    const dup = await authed("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: "t5-design" }),
    });
    expect(dup.status).toBe(409);
    const bad = await authed("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: "Bad Slug" }),
    });
    expect(bad.status).toBe(400);
    const anon = await SELF.fetch("https://x/api/channels");
    expect(anon.status).toBe(401);
    const list = await authed("/api/channels", token);
    const body = (await list.json()) as { channels: { slug: string; mode: string }[] };
    expect(body.channels.some((ch) => ch.slug === "t5-design" && ch.mode === "normal")).toBe(true);
  });

  it("归档后不再出现在列表", async () => {
    const token = await mintToken("t5-bob", "human");
    await authed("/api/channels", token, { method: "POST", body: JSON.stringify({ slug: "t5-old" }) });
    const arch = await authed("/api/channels/t5-old/archive", token, { method: "POST" });
    expect(arch.status).toBe(200);
    const list = await authed("/api/channels", token);
    const body = (await list.json()) as { channels: { slug: string }[] };
    expect(body.channels.some((ch) => ch.slug === "t5-old")).toBe(false);
  });

  it("guard 设置校验：null/0/正整数合法，越界 400", async () => {
    const token = await mintToken("t5-carol", "human");
    await authed("/api/channels", token, { method: "POST", body: JSON.stringify({ slug: "t5-g", mode: "party" }) });
    for (const limit of [null, 0, 3]) {
      const res = await authed("/api/channels/t5-g/guard", token, {
        method: "PUT",
        body: JSON.stringify({ limit }),
      });
      expect(res.status).toBe(200);
    }
    const bad = await authed("/api/channels/t5-g/guard", token, {
      method: "PUT",
      body: JSON.stringify({ limit: 99999 }),
    });
    expect(bad.status).toBe(400);
    const missing = await authed("/api/channels/nope/guard", token, {
      method: "PUT",
      body: JSON.stringify({ limit: 1 }),
    });
    expect(missing.status).toBe(404);
  });
});
```

在 `shared/test/protocol.test.ts` 追加：

```ts
import { LOOP_GUARD_N, LOOP_GUARD_PARTY_N, resolveGuardLimit } from "../src/protocol";

describe("resolveGuardLimit", () => {
  test("NULL 按 mode 默认，显式值原样", () => {
    expect(resolveGuardLimit("normal", null)).toBe(LOOP_GUARD_N);
    expect(resolveGuardLimit("party", null)).toBe(LOOP_GUARD_PARTY_N);
    expect(resolveGuardLimit("party", 0)).toBe(0);
    expect(resolveGuardLimit("normal", 7)).toBe(7);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd worker && bunx vitest run test/channels.spec.ts && cd ../shared && bun test`
Expected: 双双 FAIL

- [ ] **Step 3: 实现**

`shared/src/protocol.ts` 追加：

```ts
export function resolveGuardLimit(mode: ChannelMode, guard_limit: number | null): number {
  if (guard_limit !== null) return guard_limit;
  return mode === "party" ? LOOP_GUARD_PARTY_N : LOOP_GUARD_N;
}
```

`worker/src/index.ts` 追加路由：

```ts
app.post("/api/channels", requireAuth, async (c) => {
  const body = await c.req.json<{ slug?: unknown; title?: unknown; mode?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const { slug, title, mode } = body;
  if (!isName(slug)) return c.json({ error: "invalid slug" }, 400);
  if (mode !== undefined && mode !== "normal" && mode !== "party") return c.json({ error: "mode must be normal|party" }, 400);
  const row = {
    slug,
    title: typeof title === "string" && title.length > 0 && title.length <= 200 ? title : slug,
    mode: (mode ?? "normal") as string,
    guard_limit: null,
    created_at: Date.now(),
    archived_at: null,
  };
  try {
    await c.env.DB.prepare("INSERT INTO channels (slug, title, mode, created_at) VALUES (?, ?, ?, ?)")
      .bind(row.slug, row.title, row.mode, row.created_at)
      .run();
  } catch {
    return c.json({ error: "slug already exists" }, 409);
  }
  return c.json(row, 201);
});

app.get("/api/channels", requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT slug, title, mode, guard_limit, created_at FROM channels WHERE archived_at IS NULL ORDER BY created_at",
  ).all();
  return c.json({ channels: results });
});

app.post("/api/channels/:slug/archive", requireAuth, async (c) => {
  const r = await c.env.DB.prepare("UPDATE channels SET archived_at = ? WHERE slug = ? AND archived_at IS NULL")
    .bind(Date.now(), c.req.param("slug"))
    .run();
  if (r.meta.changes === 0) return c.json({ error: "channel not found" }, 404);
  return c.json({ ok: true });
});

app.put("/api/channels/:slug/guard", requireAuth, async (c) => {
  const body = await c.req.json<{ limit?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const limit = body.limit;
  const valid = limit === null || (Number.isInteger(limit) && (limit as number) >= 0 && (limit as number) <= 10_000);
  if (!valid) return c.json({ error: "limit must be null or 0..10000" }, 400);
  const r = await c.env.DB.prepare("UPDATE channels SET guard_limit = ? WHERE slug = ?")
    .bind(limit, c.req.param("slug"))
    .run();
  if (r.meta.changes === 0) return c.json({ error: "channel not found" }, 404);
  return c.json({ ok: true });
});
```

- [ ] **Step 4: 运行确认通过**

Run: `bun run check`
Expected: shared 测试 + worker 测试 + 双 typecheck 全绿

- [ ] **Step 5: Commit**

```bash
git add shared/ worker/
git commit -m "feat(worker): channels CRUD, archive, guard settings"
```

---

### Task 6: WS 升级路由 + ChannelDO 连接生命周期 + hello

**Files:**
- Modify: `worker/src/index.ts`（WS 路由 + 头消毒转发）
- Modify: `worker/src/do.ts`（表、onConnect/onClose、hello、presence 广播）
- Create: `worker/test/ws.ts`（测试辅助）
- Create: `worker/test/ws-hello.spec.ts`

**Interfaces:**
- Produces（REST）：`GET /api/channels/:slug/ws` — Bearer 或 `?token=` 鉴权；无效 token 401、频道不存在 404、非 upgrade 请求 426。鉴权后剥离客户端 `x-ap-*` 头，写入权威头 `x-partykit-room`（slug）、`x-ap-name`、`x-ap-kind`、`x-ap-hash`、`x-ap-mode`、`x-ap-guard`（resolveGuardLimit 结果字符串）、`x-ap-archived`，转发给 DO stub。
- Produces（DO）：`ConnState { name, kind, hash }`；连接即发 `hello` 帧；presence 表 upsert 并广播 `presence` 帧；`onClose` 同名全下线才广播 offline；`getMeta/setMeta/seqHigh/sendFrame/broadcastFrame/presenceEntry/presenceList` 私有方法供 Task 7-10 复用。
- Produces（测试辅助 `worker/test/ws.ts`）：
  - `class WsClient { static connect(slug, token, after?): Promise<WsClient>; frames: ServerFrame[]; send(frame): void; expect(pred, ms?): Promise<ServerFrame>; close(): void }`
- Consumes: Task 4 `identityFromRequest`、Task 5 频道行与 `resolveGuardLimit`。

- [ ] **Step 1: 写测试辅助**

`worker/test/ws.ts`：

```ts
import { SELF } from "cloudflare:test";
import type { ServerFrame } from "@agentparty-mini/shared";

export class WsClient {
  frames: ServerFrame[] = [];
  private cursor = 0;

  private constructor(public ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (e) => {
      this.frames.push(JSON.parse(e.data as string) as ServerFrame);
    });
  }

  static async connect(slug: string, token: string, after?: number): Promise<WsClient> {
    const url =
      `https://x/api/channels/${slug}/ws?token=${token}` + (after !== undefined ? `&after=${after}` : "");
    const res = await SELF.fetch(url, { headers: { upgrade: "websocket" } });
    if (res.status !== 101 || !res.webSocket) {
      throw new Error(`ws upgrade failed: ${res.status} ${await res.text()}`);
    }
    return new WsClient(res.webSocket);
  }

  send(frame: unknown) {
    this.ws.send(JSON.stringify(frame));
  }

  /** 从上次消费位置起找第一个匹配帧（消费式，保证能断言顺序） */
  async expect(pred: (f: ServerFrame) => boolean, ms = 5000): Promise<ServerFrame> {
    const deadline = Date.now() + ms;
    for (;;) {
      while (this.cursor < this.frames.length) {
        const f = this.frames[this.cursor++];
        if (pred(f)) return f;
      }
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for frame; received: ${JSON.stringify(this.frames)}`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  close() {
    this.ws.close();
  }
}
```

- [ ] **Step 2: 写失败测试**

`worker/test/ws-hello.spec.ts`：

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintToken } from "./tokens.spec";
import { WsClient } from "./ws";

async function createChannel(slug: string, token: string, mode?: string) {
  const res = await SELF.fetch("https://x/api/channels", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ slug, ...(mode ? { mode } : {}) }),
  });
  if (res.status !== 201) throw new Error(`create channel failed: ${res.status}`);
}

describe("ws upgrade + hello", () => {
  it("无 token 401，不存在频道 404", async () => {
    const token = await mintToken("t6-a", "agent");
    const anon = await SELF.fetch("https://x/api/channels/whatever/ws", {
      headers: { upgrade: "websocket" },
    });
    expect(anon.status).toBe(401);
    const missing = await SELF.fetch(`https://x/api/channels/no-such/ws?token=${token}`, {
      headers: { upgrade: "websocket" },
    });
    expect(missing.status).toBe(404);
  });

  it("连接收到 hello：self/seq_high/mode/guard/presence 含自己", async () => {
    const token = await mintToken("t6-bob", "agent");
    await createChannel("t6-room", token, "party");
    const c = await WsClient.connect("t6-room", token);
    const hello = await c.expect((f) => f.type === "hello");
    if (hello.type !== "hello") throw new Error("unreachable");
    expect(hello.self).toBe("t6-bob");
    expect(hello.channel).toBe("t6-room");
    expect(hello.seq_high).toBe(0);
    expect(hello.mode).toBe("party");
    expect(hello.guard).toBe(200);
    expect(hello.presence.some((p) => p.name === "t6-bob" && p.state !== "offline")).toBe(true);
    c.close();
  });

  it("客户端注入的 x-ap-name 被剥离，身份以 token 为准", async () => {
    const token = await mintToken("t6-honest", "human");
    await createChannel("t6-sec", token);
    const res = await SELF.fetch(`https://x/api/channels/t6-sec/ws?token=${token}`, {
      headers: { upgrade: "websocket", "x-ap-name": "mallory", "x-ap-kind": "human" },
    });
    expect(res.status).toBe(101);
    const c = new (WsClient as any)(res.webSocket) as WsClient;
    const hello = await c.expect((f) => f.type === "hello");
    if (hello.type !== "hello") throw new Error("unreachable");
    expect(hello.self).toBe("t6-honest");
    c.close();
  });

  it("第二人连接与断开时，第一人收到 presence 帧", async () => {
    const ta = await mintToken("t6-p1", "human");
    const tb = await mintToken("t6-p2", "agent");
    await createChannel("t6-pres", ta);
    const a = await WsClient.connect("t6-pres", ta);
    await a.expect((f) => f.type === "hello");
    const b = await WsClient.connect("t6-pres", tb);
    await a.expect((f) => f.type === "presence" && f.entry.name === "t6-p2" && f.entry.state !== "offline");
    b.close();
    await a.expect((f) => f.type === "presence" && f.entry.name === "t6-p2" && f.entry.state === "offline");
    a.close();
  });
});
```

注：`WsClient` 的构造函数是 private，第三个用例里用 `new (WsClient as any)(res.webSocket)` 复用收帧逻辑——把构造函数改成 public 也可以，实现者任选其一并保持测试一致。

- [ ] **Step 3: 运行确认失败**

Run: `cd worker && bunx vitest run test/ws-hello.spec.ts`
Expected: FAIL（WS 路由 404）

- [ ] **Step 4: 实现 index.ts WS 路由**

`worker/src/index.ts` 追加：

```ts
import { resolveGuardLimit, type ChannelMode } from "@agentparty-mini/shared";

const AP_HEADERS = ["x-ap-name", "x-ap-kind", "x-ap-hash", "x-ap-mode", "x-ap-guard", "x-ap-archived"];

app.get("/api/channels/:slug/ws", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "websocket upgrade required" }, 426);
  }
  const identity = await identityFromRequest(c.env.DB, c.req.raw);
  if (!identity) return c.json({ error: "invalid or revoked token" }, 401);
  const slug = c.req.param("slug");
  const channel = await c.env.DB.prepare(
    "SELECT slug, mode, guard_limit, archived_at FROM channels WHERE slug = ?",
  )
    .bind(slug)
    .first<{ slug: string; mode: ChannelMode; guard_limit: number | null; archived_at: number | null }>();
  if (!channel) return c.json({ error: "channel not found" }, 404);
  // 客户端注入的 x-ap-* 一律剥离，再写 worker 权威值（DO 无条件信任这些头）
  const fwd = new Request(c.req.raw);
  for (const h of AP_HEADERS) fwd.headers.delete(h);
  fwd.headers.set("x-partykit-room", slug);
  fwd.headers.set("x-ap-name", identity.name);
  fwd.headers.set("x-ap-kind", identity.kind);
  fwd.headers.set("x-ap-hash", identity.hash);
  fwd.headers.set("x-ap-mode", channel.mode);
  fwd.headers.set("x-ap-guard", String(resolveGuardLimit(channel.mode, channel.guard_limit)));
  fwd.headers.set("x-ap-archived", channel.archived_at !== null ? "1" : "0");
  const stub = c.env.CHANNELS.get(c.env.CHANNELS.idFromName(slug));
  return stub.fetch(fwd);
});
```

- [ ] **Step 5: 实现 ChannelDO**

`worker/src/do.ts` 全量替换为：

```ts
import {
  LOOP_GUARD_N,
  type PresenceEntry,
  type SenderKind,
  type ServerFrame,
} from "@agentparty-mini/shared";
import { Server, type Connection, type ConnectionContext } from "partyserver";
import type { Env } from "./index";

export interface ConnState {
  name: string;
  kind: SenderKind;
  hash: string;
}

export class ChannelDO extends Server<Env> {
  private get sql() {
    return this.ctx.storage.sql;
  }

  onStart() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      sender TEXT NOT NULL,
      sender_kind TEXT NOT NULL,
      body TEXT NOT NULL,
      mentions TEXT NOT NULL,
      reply_to INTEGER,
      idem_key TEXT
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_messages_idem ON messages(idem_key)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS presence (
      name TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      note TEXT,
      last_seen INTEGER NOT NULL,
      connected INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS rate (name TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)`,
    );
  }

  protected getMeta(key: string): string | null {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? String(row.value) : null;
  }

  protected setMeta(key: string, value: string) {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  protected seqHigh(): number {
    const row = this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS s FROM messages").toArray()[0];
    return Number(row.s);
  }

  protected sendFrame(conn: Connection, frame: ServerFrame) {
    conn.send(JSON.stringify(frame));
  }

  protected broadcastFrame(frame: ServerFrame) {
    this.broadcast(JSON.stringify(frame));
  }

  protected presenceEntry(name: string): PresenceEntry {
    const r = this.sql
      .exec("SELECT name, kind, state, note, last_seen, connected FROM presence WHERE name = ?", name)
      .toArray()[0];
    return {
      name: String(r.name),
      kind: r.kind === "agent" ? "agent" : "human",
      state: Number(r.connected) === 1 ? (String(r.state) as PresenceEntry["state"]) : "offline",
      note: r.note === null ? null : String(r.note),
      last_seen: Number(r.last_seen),
    };
  }

  protected presenceList(): PresenceEntry[] {
    return this.sql
      .exec("SELECT name FROM presence ORDER BY name")
      .toArray()
      .map((r) => this.presenceEntry(String(r.name)));
  }

  onConnect(connection: Connection<ConnState>, ctx: ConnectionContext) {
    const h = ctx.request.headers;
    const state: ConnState = {
      name: h.get("x-ap-name") ?? "",
      kind: h.get("x-ap-kind") === "agent" ? "agent" : "human",
      hash: h.get("x-ap-hash") ?? "",
    };
    connection.setState(state);
    // 频道配置随升级头进来缓存进 meta；配置变更端点会 poke /internal/config 刷新（Task 9/10）
    const mode = h.get("x-ap-mode") === "party" ? "party" : "normal";
    this.setMeta("mode", mode);
    this.setMeta("guard", h.get("x-ap-guard") ?? String(LOOP_GUARD_N));
    if (h.get("x-ap-archived") === "1") this.setMeta("archived", "1");
    if (this.getMeta("archived") === "1") {
      this.sendFrame(connection, { type: "error", code: "archived", message: "channel is archived" });
      connection.close(1008, "archived");
      return;
    }
    this.sql.exec(
      `INSERT INTO presence (name, kind, state, note, last_seen, connected) VALUES (?, ?, 'waiting', NULL, ?, 1)
       ON CONFLICT(name) DO UPDATE SET connected = 1, kind = excluded.kind, last_seen = excluded.last_seen`,
      state.name,
      state.kind,
      Date.now(),
    );
    this.sendFrame(connection, {
      type: "hello",
      channel: this.name,
      self: state.name,
      seq_high: this.seqHigh(),
      mode,
      guard: Number(this.getMeta("guard") ?? LOOP_GUARD_N),
      presence: this.presenceList(),
    });
    this.broadcastFrame({ type: "presence", entry: this.presenceEntry(state.name) });
  }

  onClose(connection: Connection<ConnState>) {
    const name = connection.state?.name;
    if (!name) return;
    // 同名可能多开连接，全下线才算离场
    for (const other of this.getConnections<ConnState>()) {
      if (other.id !== connection.id && other.state?.name === name) return;
    }
    this.sql.exec("UPDATE presence SET connected = 0, last_seen = ? WHERE name = ?", Date.now(), name);
    this.broadcastFrame({ type: "presence", entry: this.presenceEntry(name) });
  }
}
```

- [ ] **Step 6: 运行确认通过**

Run: `cd worker && bunx vitest run && bunx tsc --noEmit`
Expected: 全部 PASS（含此前 spec 无回归）

- [ ] **Step 7: Commit**

```bash
git add worker/
git commit -m "feat(worker): websocket upgrade with header sanitization, ChannelDO hello + presence lifecycle"
```

---

### Task 7: 消息收发 —— seq、自回声、广播、幂等、状态帧

**Files:**
- Modify: `worker/src/do.ts`（onMessage）
- Create: `worker/test/messaging.spec.ts`

**Interfaces:**
- Produces（DO 行为，CLI/Web 依赖）：
  - message 帧 → 落库得 `seq` → **先**给发送方 `sent{seq, idem_key}`，**再**向全员（含发送方）广播 `msg`
  - `mentions` 由服务端 `extractMentions(body)` 解析进 msg 帧
  - 幂等窗口内同 `idem_key` 重发 → 只回 `sent`（同 seq），不产生新行不广播
  - status 帧 → 更新 presence 行（state/note/last_seen）→ 广播 `presence` 帧，不进消息历史
  - 坏帧 → `error{bad_frame}`
- Consumes: Task 2 `parseSendFrame/extractMentions`、Task 6 的 DO 基础方法与 `WsClient`。

- [ ] **Step 1: 写失败测试**

`worker/test/messaging.spec.ts`：

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintToken } from "./tokens.spec";
import { WsClient } from "./ws";

async function createChannel(slug: string, token: string) {
  const res = await SELF.fetch("https://x/api/channels", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  if (res.status !== 201) throw new Error(`create channel failed: ${res.status}`);
}

function msgFrame(body: string, idem: string, reply_to?: number) {
  return { type: "send", kind: "message", body, idem_key: idem, ...(reply_to ? { reply_to } : {}) };
}

describe("messaging", () => {
  it("发送方先收 sent 再收自己的 msg，其他人收到 msg，mentions 解析", async () => {
    const ta = await mintToken("t7-alice", "human");
    const tb = await mintToken("t7-bob", "agent");
    await createChannel("t7-room", ta);
    const a = await WsClient.connect("t7-room", ta);
    const b = await WsClient.connect("t7-room", tb);
    await a.expect((f) => f.type === "hello");
    await b.expect((f) => f.type === "hello");

    a.send(msgFrame("hi @t7-bob please review", "k1"));
    const sent = await a.expect((f) => f.type === "sent");
    if (sent.type !== "sent") throw new Error("unreachable");
    expect(sent.seq).toBe(1);
    // 消费式 expect 保证顺序：sent 之后才轮到自己的 msg 回声
    const echo = await a.expect((f) => f.type === "msg");
    if (echo.type !== "msg") throw new Error("unreachable");
    expect(echo.seq).toBe(1);
    expect(echo.sender).toBe("t7-alice");
    expect(echo.sender_kind).toBe("human");
    expect(echo.mentions).toEqual(["t7-bob"]);

    const got = await b.expect((f) => f.type === "msg" && f.seq === 1);
    if (got.type !== "msg") throw new Error("unreachable");
    expect(got.body).toBe("hi @t7-bob please review");
    a.close();
    b.close();
  });

  it("reply_to 原样回传，seq 递增", async () => {
    const t = await mintToken("t7-carol", "human");
    await createChannel("t7-reply", t);
    const c = await WsClient.connect("t7-reply", t);
    await c.expect((f) => f.type === "hello");
    c.send(msgFrame("first", "r1"));
    await c.expect((f) => f.type === "sent" && f.seq === 1);
    c.send(msgFrame("second", "r2", 1));
    const m = await c.expect((f) => f.type === "msg" && f.seq === 2);
    if (m.type !== "msg") throw new Error("unreachable");
    expect(m.reply_to).toBe(1);
    c.close();
  });

  it("同 idem_key 重发只回 sent 同 seq，不广播第二条", async () => {
    const ta = await mintToken("t7-dave", "human");
    const tb = await mintToken("t7-eve", "human");
    await createChannel("t7-idem", ta);
    const a = await WsClient.connect("t7-idem", ta);
    const b = await WsClient.connect("t7-idem", tb);
    await a.expect((f) => f.type === "hello");
    await b.expect((f) => f.type === "hello");
    a.send(msgFrame("once", "dup-key"));
    await a.expect((f) => f.type === "sent" && f.seq === 1);
    a.send(msgFrame("once", "dup-key"));
    const again = await a.expect((f) => f.type === "sent");
    if (again.type !== "sent") throw new Error("unreachable");
    expect(again.seq).toBe(1);
    // b 只该收到一条 msg；发一条哨兵确认没有第二条 "once"
    a.send(msgFrame("sentinel", "sk"));
    await b.expect((f) => f.type === "msg" && f.body === "sentinel");
    expect(b.frames.filter((f) => f.type === "msg" && (f as { body?: string }).body === "once").length).toBe(1);
    a.close();
    b.close();
  });

  it("status 帧更新 presence 并广播，不产生 msg", async () => {
    const ta = await mintToken("t7-fred", "agent");
    const tb = await mintToken("t7-gina", "human");
    await createChannel("t7-status", ta);
    const a = await WsClient.connect("t7-status", ta);
    const b = await WsClient.connect("t7-status", tb);
    await a.expect((f) => f.type === "hello");
    await b.expect((f) => f.type === "hello");
    a.send({ type: "send", kind: "status", state: "blocked", note: "waiting on CI" });
    const p = await b.expect(
      (f) => f.type === "presence" && f.entry.name === "t7-fred" && f.entry.state === "blocked",
    );
    if (p.type !== "presence") throw new Error("unreachable");
    expect(p.entry.note).toBe("waiting on CI");
    expect(b.frames.some((f) => f.type === "msg")).toBe(false);
    a.close();
    b.close();
  });

  it("坏帧收到 error bad_frame", async () => {
    const t = await mintToken("t7-hank", "human");
    await createChannel("t7-bad", t);
    const c = await WsClient.connect("t7-bad", t);
    await c.expect((f) => f.type === "hello");
    c.ws.send("not json");
    await c.expect((f) => f.type === "error" && f.code === "bad_frame");
    c.close();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd worker && bunx vitest run test/messaging.spec.ts`
Expected: FAIL（onMessage 未实现，expect 超时）

- [ ] **Step 3: 实现 onMessage**

`worker/src/do.ts` 追加 import 与方法：

```ts
import {
  extractMentions,
  IDEMPOTENCY_WINDOW_MS,
  parseSendFrame,
  type SendFrame,
} from "@agentparty-mini/shared";
import type { WSMessage } from "partyserver";
```

在 `ChannelDO` 内追加：

```ts
  async onMessage(connection: Connection<ConnState>, message: WSMessage) {
    const state = connection.state;
    if (!state) return;
    const parsed = parseSendFrame(typeof message === "string" ? message : "");
    if ("error" in parsed) {
      this.sendFrame(connection, { type: "error", code: "bad_frame", message: parsed.error });
      return;
    }
    const now = Date.now();
    this.sql.exec("UPDATE presence SET last_seen = ? WHERE name = ?", now, state.name);
    if (parsed.frame.kind === "status") {
      this.handleStatus(state, parsed.frame, now);
      return;
    }
    this.handleMessage(connection, state, parsed.frame, now);
  }

  private handleStatus(state: ConnState, frame: SendFrame & { kind: "status" }, now: number) {
    this.sql.exec(
      "UPDATE presence SET state = ?, note = ?, last_seen = ? WHERE name = ?",
      frame.state,
      frame.note ?? null,
      now,
      state.name,
    );
    this.broadcastFrame({ type: "presence", entry: this.presenceEntry(state.name) });
  }

  private handleMessage(
    connection: Connection<ConnState>,
    state: ConnState,
    frame: SendFrame & { kind: "message" },
    now: number,
  ) {
    // 幂等：窗口内同 key 重发 sent（同 seq），不落新行不广播
    const dup = this.sql
      .exec(
        "SELECT seq FROM messages WHERE idem_key = ? AND ts > ?",
        frame.idem_key,
        now - IDEMPOTENCY_WINDOW_MS,
      )
      .toArray()[0];
    if (dup) {
      this.sendFrame(connection, { type: "sent", seq: Number(dup.seq), idem_key: frame.idem_key });
      return;
    }
    const mentions = extractMentions(frame.body);
    const seq = Number(
      this.sql
        .exec(
          `INSERT INTO messages (ts, sender, sender_kind, body, mentions, reply_to, idem_key)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
          now,
          state.name,
          state.kind,
          frame.body,
          JSON.stringify(mentions),
          frame.reply_to ?? null,
          frame.idem_key,
        )
        .toArray()[0].seq,
    );
    // 自回声顺序：发送方先收 sent 再看到自己的广播
    this.sendFrame(connection, { type: "sent", seq, idem_key: frame.idem_key });
    this.broadcastFrame({
      type: "msg",
      seq,
      ts: now,
      sender: state.name,
      sender_kind: state.kind,
      body: frame.body,
      mentions,
      reply_to: frame.reply_to ?? null,
    });
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd worker && bunx vitest run && bunx tsc --noEmit`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add worker/
git commit -m "feat(worker): message send with seq, self-echo ordering, idempotency, status frames"
```

---

### Task 8: 断线补拉（?after=）+ 保留窗口修剪

**Files:**
- Modify: `worker/src/do.ts`（onConnect 回放 + 插入后修剪）
- Create: `worker/test/catchup.spec.ts`

**Interfaces:**
- Produces（DO 行为）：
  - 连接带 `?after=<seq>` → hello 之后、实时流之前按序回放 `seq > after` 的历史 msg 帧
  - 每次插入后按 `RETAIN_N`（env 可覆盖，测试值 50）修剪最老消息
- Consumes: Task 7 的 `rowToMsg` 数据形状（本任务引入该辅助方法）。

- [ ] **Step 1: 写失败测试**

`worker/test/catchup.spec.ts`：

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintToken } from "./tokens.spec";
import { WsClient } from "./ws";

async function createChannel(slug: string, token: string) {
  const res = await SELF.fetch("https://x/api/channels", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  if (res.status !== 201) throw new Error(`create channel failed: ${res.status}`);
}

describe("catch-up + retention", () => {
  it("?after=1 回放 seq 2..3 后接实时流", async () => {
    const ta = await mintToken("t8-a", "human");
    const tb = await mintToken("t8-b", "human");
    await createChannel("t8-room", ta);
    const a = await WsClient.connect("t8-room", ta);
    await a.expect((f) => f.type === "hello");
    for (const [i, body] of ["one", "two", "three"].entries()) {
      a.send({ type: "send", kind: "message", body, idem_key: `t8-k${i}` });
      await a.expect((f) => f.type === "sent");
    }
    const b = await WsClient.connect("t8-room", tb, 1);
    const hello = await b.expect((f) => f.type === "hello");
    if (hello.type !== "hello") throw new Error("unreachable");
    expect(hello.seq_high).toBe(3);
    const m2 = await b.expect((f) => f.type === "msg");
    const m3 = await b.expect((f) => f.type === "msg");
    if (m2.type !== "msg" || m3.type !== "msg") throw new Error("unreachable");
    expect([m2.seq, m3.seq]).toEqual([2, 3]);
    // 回放完接实时
    a.send({ type: "send", kind: "message", body: "live", idem_key: "t8-live" });
    await b.expect((f) => f.type === "msg" && f.seq === 4);
    a.close();
    b.close();
  });

  it("超出 RETAIN_N(测试值 50) 的最老消息被修剪", async () => {
    const t = await mintToken("t8-c", "human");
    await createChannel("t8-prune", t);
    const c = await WsClient.connect("t8-prune", t);
    await c.expect((f) => f.type === "hello");
    for (let i = 1; i <= 55; i++) {
      c.send({ type: "send", kind: "message", body: `m${i}`, idem_key: `t8-p${i}` });
      await c.expect((f) => f.type === "sent" && f.seq === i);
    }
    const late = await WsClient.connect("t8-prune", t, 0);
    const hello = await late.expect((f) => f.type === "hello");
    if (hello.type !== "hello") throw new Error("unreachable");
    expect(hello.seq_high).toBe(55);
    const first = await late.expect((f) => f.type === "msg");
    if (first.type !== "msg") throw new Error("unreachable");
    expect(first.seq).toBe(6); // 1..5 已被修剪，seq 不复用
    c.close();
    late.close();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd worker && bunx vitest run test/catchup.spec.ts`
Expected: FAIL（无回放，expect msg 超时）

- [ ] **Step 3: 实现**

`worker/src/do.ts`：import 追加 `RETAIN_N`；`ChannelDO` 追加辅助方法：

```ts
  private rowToMsg(r: Record<string, unknown>): ServerFrame {
    return {
      type: "msg",
      seq: Number(r.seq),
      ts: Number(r.ts),
      sender: String(r.sender),
      sender_kind: r.sender_kind === "agent" ? "agent" : "human",
      body: String(r.body),
      mentions: JSON.parse(String(r.mentions)) as string[],
      reply_to: r.reply_to === null ? null : Number(r.reply_to),
    };
  }
```

`onConnect` 中 `this.sendFrame(connection, { type: "hello", ... })` 之后、`this.broadcastFrame(...)` 之前插入：

```ts
    // 断线补拉：hello 之后、实时流之前回放历史
    const after = Number(new URL(ctx.request.url).searchParams.get("after") ?? NaN);
    if (Number.isInteger(after) && after >= 0) {
      const rows = this.sql
        .exec(
          "SELECT seq, ts, sender, sender_kind, body, mentions, reply_to FROM messages WHERE seq > ? ORDER BY seq",
          after,
        )
        .toArray();
      for (const r of rows) this.sendFrame(connection, this.rowToMsg(r));
    }
```

`handleMessage` 中 `INSERT ... RETURNING seq` 之后追加修剪：

```ts
    const retainN = Number(this.env.RETAIN_N ?? RETAIN_N);
    this.sql.exec("DELETE FROM messages WHERE seq <= ?", seq - retainN);
```

- [ ] **Step 4: 运行确认通过**

Run: `cd worker && bunx vitest run && bunx tsc --noEmit`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add worker/
git commit -m "feat(worker): cursor catch-up replay and RETAIN_N pruning"
```

---

### Task 9: 限速 + loop guard 熔断 + guard 配置 poke

**Files:**
- Modify: `worker/src/do.ts`（rateLimited、loop guard、onRequest 内部配置接口、insertSystemMessage）
- Modify: `worker/src/index.ts`（`pokeChannelConfig` + PUT guard 路由接 poke）
- Create: `worker/test/guard.spec.ts`

**Interfaces:**
- Produces（DO 行为）：
  - message 帧超过 `RATE_LIMIT_PER_MIN`（env 覆盖，测试 100）→ `error{rate_limited}`
  - 连续 agent message 达到 guard 阈值 → 拒收 `error{loop_guard}`；首次熔断插入一条 `sender="system"` 的通告消息（只插一次）；human message 清零计数并解除熔断；status 帧不计数；guard=0 关闭
  - `POST /internal/config`（仅 stub 可达）body `{guard?: number, archived?: boolean}` → 更新 meta
- Produces（edge）：`pokeChannelConfig(env, slug, patch): Promise<void>`；`PUT /api/channels/:slug/guard` 现在同步 poke DO
- Consumes: Task 5 的 guard 路由与 `resolveGuardLimit`。

- [ ] **Step 1: 写失败测试**

`worker/test/guard.spec.ts`：

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintToken } from "./tokens.spec";
import { WsClient } from "./ws";

async function api(path: string, token: string, init: RequestInit = {}) {
  return SELF.fetch(`https://x${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("loop guard", () => {
  it("guard=3：第 4 条 agent 消息被拒 + system 通告一次；human 发言解除", async () => {
    const agent = await mintToken("t9-agent", "agent");
    const human = await mintToken("t9-human", "human");
    await api("/api/channels", human, { method: "POST", body: JSON.stringify({ slug: "t9-room" }) });
    await api("/api/channels/t9-room/guard", human, { method: "PUT", body: JSON.stringify({ limit: 3 }) });
    const a = await WsClient.connect("t9-room", agent);
    const h = await WsClient.connect("t9-room", human);
    await a.expect((f) => f.type === "hello");
    await h.expect((f) => f.type === "hello");

    for (let i = 1; i <= 3; i++) {
      a.send({ type: "send", kind: "message", body: `a${i}`, idem_key: `t9-a${i}` });
      await a.expect((f) => f.type === "sent");
    }
    // 中间夹一个 status 帧不该计数、也不该被拒
    a.send({ type: "send", kind: "status", state: "working" });
    a.send({ type: "send", kind: "message", body: "a4", idem_key: "t9-a4" });
    await a.expect((f) => f.type === "error" && f.code === "loop_guard");
    // human 端收到 system 通告
    await h.expect((f) => f.type === "msg" && f.sender === "system");
    // 再拒一条不重复通告
    a.send({ type: "send", kind: "message", body: "a5", idem_key: "t9-a5" });
    await a.expect((f) => f.type === "error" && f.code === "loop_guard");
    // human 发言清零，agent 恢复
    h.send({ type: "send", kind: "message", body: "human here", idem_key: "t9-h1" });
    await h.expect((f) => f.type === "sent");
    a.send({ type: "send", kind: "message", body: "a6", idem_key: "t9-a6" });
    await a.expect((f) => f.type === "sent");
    expect(h.frames.filter((f) => f.type === "msg" && (f as { sender?: string }).sender === "system").length).toBe(1);
    a.close();
    h.close();
  });

  it("guard=0 关闭熔断", async () => {
    const agent = await mintToken("t9-free", "agent");
    await api("/api/channels", agent, { method: "POST", body: JSON.stringify({ slug: "t9-off" }) });
    await api("/api/channels/t9-off/guard", agent, { method: "PUT", body: JSON.stringify({ limit: 0 }) });
    const a = await WsClient.connect("t9-off", agent);
    await a.expect((f) => f.type === "hello");
    for (let i = 1; i <= 35; i++) {
      a.send({ type: "send", kind: "message", body: `x${i}`, idem_key: `t9-o${i}` });
      await a.expect((f) => f.type === "sent");
    }
    a.close();
  });

  it("PUT guard 对已运行的 DO 即时生效（poke）", async () => {
    const agent = await mintToken("t9-live", "agent");
    await api("/api/channels", agent, { method: "POST", body: JSON.stringify({ slug: "t9-poke" }) });
    const a = await WsClient.connect("t9-poke", agent);
    await a.expect((f) => f.type === "hello");
    a.send({ type: "send", kind: "message", body: "ok", idem_key: "t9-pk1" });
    await a.expect((f) => f.type === "sent");
    // 连接保持打开时收紧 guard 到 1：streak 已是 1，下一条即触发
    await api("/api/channels/t9-poke/guard", agent, { method: "PUT", body: JSON.stringify({ limit: 1 }) });
    a.send({ type: "send", kind: "message", body: "blocked?", idem_key: "t9-pk2" });
    await a.expect((f) => f.type === "error" && f.code === "loop_guard");
    a.close();
  });
});

describe("rate limit", () => {
  it("超过 RATE_LIMIT_PER_MIN(测试值 100) 收到 rate_limited", async () => {
    const human = await mintToken("t9-chatty", "human");
    await api("/api/channels", human, { method: "POST", body: JSON.stringify({ slug: "t9-rate" }) });
    const c = await WsClient.connect("t9-rate", human);
    await c.expect((f) => f.type === "hello");
    for (let i = 1; i <= 100; i++) {
      c.send({ type: "send", kind: "message", body: `r${i}`, idem_key: `t9-r${i}` });
      await c.expect((f) => f.type === "sent");
    }
    c.send({ type: "send", kind: "message", body: "overflow", idem_key: "t9-r101" });
    await c.expect((f) => f.type === "error" && f.code === "rate_limited");
    c.close();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd worker && bunx vitest run test/guard.spec.ts`
Expected: FAIL

- [ ] **Step 3: 实现 DO 侧**

`worker/src/do.ts`：import 追加 `RATE_LIMIT_PER_MIN`。`ChannelDO` 追加：

```ts
  private rateLimited(name: string, now: number): boolean {
    const limit = Number(this.env.RATE_LIMIT_PER_MIN ?? RATE_LIMIT_PER_MIN);
    const row = this.sql.exec("SELECT window_start, count FROM rate WHERE name = ?", name).toArray()[0];
    if (!row || now - Number(row.window_start) >= 60_000) {
      this.sql.exec(
        `INSERT INTO rate (name, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(name) DO UPDATE SET window_start = excluded.window_start, count = 1`,
        name,
        now,
      );
      return false;
    }
    if (Number(row.count) >= limit) return true;
    this.sql.exec("UPDATE rate SET count = count + 1 WHERE name = ?", name);
    return false;
  }

  private insertSystemMessage(body: string, now: number) {
    const seq = Number(
      this.sql
        .exec(
          `INSERT INTO messages (ts, sender, sender_kind, body, mentions, reply_to, idem_key)
           VALUES (?, 'system', 'agent', ?, '[]', NULL, NULL) RETURNING seq`,
          now,
          body,
        )
        .toArray()[0].seq,
    );
    this.broadcastFrame({
      type: "msg",
      seq,
      ts: now,
      sender: "system",
      sender_kind: "agent",
      body,
      mentions: [],
      reply_to: null,
    });
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/config") {
      const patch = (await request.json()) as { guard?: number; archived?: boolean };
      if (patch.guard !== undefined) this.setMeta("guard", String(patch.guard));
      if (patch.archived !== undefined) this.setMeta("archived", patch.archived ? "1" : "0");
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }
```

`handleMessage` 开头（幂等检查之前）插入：

```ts
    if (this.rateLimited(state.name, now)) {
      this.sendFrame(connection, {
        type: "error",
        code: "rate_limited",
        message: "rate limit exceeded, slow down",
      });
      return;
    }
    // loop guard：连续 agent 消息熔断，human 发言即人类锚点
    const guardLimit = Number(this.getMeta("guard") ?? 0);
    if (state.kind === "agent" && guardLimit > 0) {
      const streak = Number(this.getMeta("agent_streak") ?? "0");
      if (streak >= guardLimit) {
        if (this.getMeta("guard_tripped") !== "1") {
          this.setMeta("guard_tripped", "1");
          this.insertSystemMessage(
            `loop guard: ${guardLimit} consecutive agent messages, agents are paused until a human speaks`,
            now,
          );
        }
        this.sendFrame(connection, {
          type: "error",
          code: "loop_guard",
          message: `loop guard tripped (limit ${guardLimit}); a human must speak to reset`,
        });
        return;
      }
    }
```

`handleMessage` 末尾（broadcast 之后）追加计数推进：

```ts
    if (state.kind === "human") {
      this.setMeta("agent_streak", "0");
      this.setMeta("guard_tripped", "0");
    } else {
      this.setMeta("agent_streak", String(Number(this.getMeta("agent_streak") ?? "0") + 1));
    }
```

- [ ] **Step 4: 实现 edge poke**

`worker/src/index.ts` 追加：

```ts
export async function pokeChannelConfig(
  env: Env,
  slug: string,
  patch: { guard?: number; archived?: boolean },
): Promise<void> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await stub.fetch("https://do/internal/config", {
    method: "POST",
    headers: { "x-partykit-room": slug, "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}
```

`PUT /api/channels/:slug/guard` 路由的 `return c.json({ ok: true })` 之前追加：

```ts
  const ch = await c.env.DB.prepare("SELECT mode, guard_limit FROM channels WHERE slug = ?")
    .bind(c.req.param("slug"))
    .first<{ mode: ChannelMode; guard_limit: number | null }>();
  if (ch) await pokeChannelConfig(c.env, c.req.param("slug"), { guard: resolveGuardLimit(ch.mode, ch.guard_limit) });
```

- [ ] **Step 5: 运行确认通过**

Run: `cd worker && bunx vitest run && bunx tsc --noEmit`
Expected: 全部 PASS（注意 Task 6/7/8 spec 无回归——它们的频道 guard 走默认 30/200，消息量都在阈值内）

- [ ] **Step 6: Commit**

```bash
git add worker/
git commit -m "feat(worker): rate limiting, loop guard circuit breaker with human-anchor reset"
```

---

### Task 10: token 吊销即时生效 + 归档拒收 + presence 超时扫描

**Files:**
- Modify: `worker/src/do.ts`（tokenActive 缓存、archived 拒收、onAlarm）
- Modify: `worker/src/index.ts`（archive 路由接 poke、WS 升级拒绝已归档频道）
- Create: `worker/test/lifecycle.spec.ts`

**Interfaces:**
- Produces（DO 行为）：
  - 每条 message 帧校验 token 活性（D1 查询 + 内存缓存，TTL `AUTH_CACHE_TTL_MS` env 覆盖、测试 0、生产默认 60s）；已吊销 → `error{auth}` + close(1008)
  - meta `archived=1` 后 message/status 帧一律 `error{archived}` + close(1008)
  - `onAlarm`：把 `connected=1` 但无存活连接的 presence 行标记 offline 并广播；有连接存活时每 `PRESENCE_TIMEOUT_MS` 自排下一次
- Produces（edge）：`POST /api/channels/:slug/archive` 现在 poke DO；已归档频道 WS 升级直接 410
- Consumes: Task 9 的 `onRequest /internal/config` 与 `pokeChannelConfig`。

- [ ] **Step 1: 写失败测试**

`worker/test/lifecycle.spec.ts`：

```ts
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { mintToken } from "./tokens.spec";
import { WsClient } from "./ws";

const ADMIN = { "x-admin-secret": "test-admin-secret" };

async function api(path: string, token: string, init: RequestInit = {}) {
  return SELF.fetch(`https://x${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("lifecycle", () => {
  it("吊销 token 后在线连接下一条消息收 error auth 并被断开", async () => {
    const t = await mintToken("t10-doomed", "agent");
    const keeper = await mintToken("t10-keeper", "human");
    await api("/api/channels", keeper, { method: "POST", body: JSON.stringify({ slug: "t10-rev" }) });
    const c = await WsClient.connect("t10-rev", t);
    await c.expect((f) => f.type === "hello");
    c.send({ type: "send", kind: "message", body: "before", idem_key: "t10-b" });
    await c.expect((f) => f.type === "sent");
    await SELF.fetch("https://x/api/tokens/t10-doomed", { method: "DELETE", headers: ADMIN });
    c.send({ type: "send", kind: "message", body: "after", idem_key: "t10-a" });
    await c.expect((f) => f.type === "error" && f.code === "auth");
  });

  it("归档后：在线连接被拒收，新升级 410", async () => {
    const t = await mintToken("t10-arch", "human");
    await api("/api/channels", t, { method: "POST", body: JSON.stringify({ slug: "t10-old" }) });
    const c = await WsClient.connect("t10-old", t);
    await c.expect((f) => f.type === "hello");
    await api("/api/channels/t10-old/archive", t, { method: "POST" });
    c.send({ type: "send", kind: "message", body: "too late", idem_key: "t10-l" });
    await c.expect((f) => f.type === "error" && f.code === "archived");
    const res = await SELF.fetch(`https://x/api/channels/t10-old/ws?token=${t}`, {
      headers: { upgrade: "websocket" },
    });
    expect(res.status).toBe(410);
  });

  it("onAlarm 把幽灵 presence 行标记 offline", async () => {
    const t = await mintToken("t10-ghost", "human");
    await api("/api/channels", t, { method: "POST", body: JSON.stringify({ slug: "t10-sweep" }) });
    const live = await WsClient.connect("t10-sweep", t);
    await live.expect((f) => f.type === "hello");
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName("t10-sweep"));
    await runInDurableObject(stub, async (instance: ChannelDO) => {
      // 伪造一个断电残留：connected=1 但没有对应存活连接
      (instance as any).sql.exec(
        "INSERT INTO presence (name, kind, state, note, last_seen, connected) VALUES ('t10-zombie','agent','working',NULL,0,1)",
      );
      await (instance as any).onAlarm();
    });
    await live.expect(
      (f) => f.type === "presence" && f.entry.name === "t10-zombie" && f.entry.state === "offline",
    );
    live.close();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd worker && bunx vitest run test/lifecycle.spec.ts`
Expected: FAIL

- [ ] **Step 3: 实现 DO 侧**

`worker/src/do.ts`：import 追加 `PRESENCE_TIMEOUT_MS`。`ChannelDO` 追加字段与方法：

```ts
  private tokenCache = new Map<string, { ok: boolean; at: number }>();

  private async tokenActive(hash: string): Promise<boolean> {
    const ttl = Number(this.env.AUTH_CACHE_TTL_MS ?? 60_000);
    const cached = this.tokenCache.get(hash);
    if (cached && Date.now() - cached.at < ttl) return cached.ok;
    const row = await this.env.DB.prepare("SELECT 1 AS ok FROM tokens WHERE hash = ? AND revoked_at IS NULL")
      .bind(hash)
      .first();
    const ok = row !== null;
    this.tokenCache.set(hash, { ok, at: Date.now() });
    return ok;
  }

  async onAlarm() {
    const liveNames = new Set<string>();
    for (const conn of this.getConnections<ConnState>()) {
      if (conn.state?.name) liveNames.add(conn.state.name);
    }
    const ghosts = this.sql.exec("SELECT name FROM presence WHERE connected = 1").toArray()
      .map((r) => String(r.name))
      .filter((n) => !liveNames.has(n));
    for (const name of ghosts) {
      this.sql.exec("UPDATE presence SET connected = 0 WHERE name = ?", name);
      this.broadcastFrame({ type: "presence", entry: this.presenceEntry(name) });
    }
    if (liveNames.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + PRESENCE_TIMEOUT_MS);
    }
  }
```

`onMessage` 中 parse 成功之后、presence 心跳更新之前插入：

```ts
    if (this.getMeta("archived") === "1") {
      this.sendFrame(connection, { type: "error", code: "archived", message: "channel is archived" });
      connection.close(1008, "archived");
      return;
    }
    if (!(await this.tokenActive(state.hash))) {
      this.sendFrame(connection, { type: "error", code: "auth", message: "token revoked" });
      connection.close(1008, "auth");
      return;
    }
```

`onConnect` 末尾追加 alarm 自排（只前移不后移）：

```ts
    void this.ctx.storage.getAlarm().then((at) => {
      const next = Date.now() + PRESENCE_TIMEOUT_MS;
      if (at === null || at > next) void this.ctx.storage.setAlarm(next);
    });
```

- [ ] **Step 4: 实现 edge 侧**

`worker/src/index.ts`：

archive 路由 `return c.json({ ok: true })` 前追加：

```ts
  await pokeChannelConfig(c.env, c.req.param("slug"), { archived: true });
```

WS 路由的 `if (!channel) return ...404` 之后追加：

```ts
  if (channel.archived_at !== null) return c.json({ error: "channel is archived" }, 410);
```

- [ ] **Step 5: 运行确认通过**

Run: `cd worker && bunx vitest run && bunx tsc --noEmit`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add worker/
git commit -m "feat(worker): live token revocation, archive enforcement, presence sweep alarm"
```

---

### Task 11: 全仓 check 收口 + README + 部署说明

**Files:**
- Create: `README.md`
- Modify: 无代码变更（`bun run check` 已在 Task 1 定义）

**Interfaces:**
- Produces: `bun run check` 一条命令跑全部质量门（shared 测试 + typecheck、worker 测试 + typecheck）；README 记录部署与冒烟步骤。

- [ ] **Step 1: 跑全量 check**

Run: `bun run check`
Expected: 全绿。任何失败先修再继续。

- [ ] **Step 2: 写 README**

`README.md`：

````markdown
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
````

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with deploy and smoke instructions"
```

---

## Self-Review 记录

- **Spec 覆盖**：设计文档 §2（架构/认证/端点，除 tasks 端点归计划 3）、§3（协议全部语义）、§4（数据模型，tasks 表归计划 3）、§8（错误处理服务端部分）均有对应任务。§5–§7（CLI/看板/MCP/Web）按既定拆分归计划 2–4。
- **占位符**：无 TBD/TODO；所有步骤含完整代码与命令。
- **类型一致性**：`Identity{name,kind,hash}`（Task 4 定义，Task 6 消费）、`WsClient.expect` 消费式语义（Task 6 定义，Task 7–10 依赖其顺序断言）、`pokeChannelConfig` patch 形状（Task 9 定义，Task 10 复用）、env 覆盖键 `RETAIN_N/RATE_LIMIT_PER_MIN/AUTH_CACHE_TTL_MS`（Task 3 vitest 配置与 Task 8/9/10 实现一致）已核对。
- **已知风险（执行时验证）**：partyserver `0.5.x` 的 `onConnect/onMessage/broadcast/getConnections` 签名以安装版本的类型为准，若与本计划代码有出入，以通过 typecheck 的最小改动适配，语义不变；`x-partykit-room` 头是 partyserver 路由房间名的约定，Task 6 第一个用例即验证。


