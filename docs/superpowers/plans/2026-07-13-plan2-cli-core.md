# 计划 2：CLI 核心（cli/ workspace）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `party` CLI（Bun 编译单二进制，零运行时依赖）：绑定身份（init）、发消息（send）、围观频道（watch）、看在线（who）、上报状态（status），外加 whoami 与 token/channel 的 REST 包装，全部对接已合并到 `main` 的 worker。

**Architecture:** 新增 `cli/` workspace（monorepo 第三个包），只依赖 `@agentparty-mini/shared`。命令分派在 `index.ts`；`args.ts` 手写 flag 解析；`config.ts` 管单一绑定配置 + 分文件游标；`rest.ts` 封装 HTTP → `CliError`；`ws.ts` 提供单一 `openChannel()` 复用层（Bun 原生 WebSocket，等 hello、帧异步迭代器、终局/瞬时错误区分、仅 watch 重连）；`format.ts` 把帧渲染成人读行或 NDJSON。测试用 Bun 内存 mock server。

**Tech Stack:** Bun ≥1.2（运行时 + `bun test` + `bun build --compile`）、TypeScript strict、`@agentparty-mini/shared`。零第三方运行时依赖。

**设计文档：** `docs/superpowers/specs/2026-07-13-plan2-cli-core-design.md`
**权威协议类型：** `shared/src/protocol.ts`（`ServerFrame`/`SendFrame`/`PresenceEntry`/`isName`）。hello 帧扁平、presence 帧包在 `{entry}`。
**参考实现（只看语义不抄代码）：** `/private/tmp/claude-501/-Users-zzcan-Desktop-workspace-codes-zz-agents/72994498-ca71-4ff5-9984-8c55344d3ce5/scratchpad/agentparty`

## Global Constraints

- 零运行时依赖：只用 Bun 原生 `WebSocket`、`fetch`、`crypto.randomUUID()`、`Bun.serve`、`process`、`node:fs`/`node:os`/`node:path`。唯一 workspace 依赖是 `@agentparty-mini/shared`。
- WS URL：把 config 的 `server` 的 `http→ws`、`https→ws​s` 后拼 `/api/channels/<channel>/ws?token=<token>[&after=<seq>]`。WS 鉴权只能走 `?token=`（服务端对 WS 升级认 query token；REST 认 `Authorization: Bearer`）。
- 配置文件 `~/.config/party/config.json`（`XDG_CONFIG_HOME` 优先），权限 `0600`。游标文件 `~/.config/party/cursors/<host>__<channel>.seq`（纯数字）。
- 身份以服务端为准：`init` 用 `GET /api/me` 回填 `name`/`kind`，不让用户手填。
- 退出码 verbatim：`EXIT_OK=0`、`EXIT_ERROR=1`、`EXIT_AUTH=3`、`EXIT_LOOP_GUARD=4`、`EXIT_ARCHIVED=5`、`EXIT_RATE_LIMITED=9`。
- 完成信号（不 sleep 猜时间）：send 等自己的 `sent{idem_key}`；status 等自己的 presence 回显；who 读 `hello.presence` 即退。
- 正常结果 stdout，错误/诊断 stderr。
- name/slug 用 shared 的 `isName`（regex `/^[a-z0-9][a-z0-9-]{0,31}$/`）。
- TypeScript `strict: true`。Conventional-commits。每个任务只提交自己涉及的路径（永不提交 `.superpowers/`）。
- 不复制参考仓库代码；仅对照其 spec 与 API 用法。

---

### Task 1: shared 退出码 + cli 脚手架 + 命令分派骨架

**Files:**
- Modify: `shared/src/protocol.ts`（追加退出码常量）
- Modify: `package.json`（根：workspaces 加 `cli`，check 串上 `check:cli`）
- Create: `cli/package.json`
- Create: `cli/tsconfig.json`
- Create: `cli/src/index.ts`
- Create: `cli/src/errors.ts`
- Create: `cli/test/smoke.test.ts`

**Interfaces:**
- Produces（shared）：`EXIT_OK=0`、`EXIT_ERROR=1`、`EXIT_AUTH=3`、`EXIT_LOOP_GUARD=4`、`EXIT_ARCHIVED=5`、`EXIT_RATE_LIMITED=9`。
- Produces（`cli/src/errors.ts`）：`class CliError extends Error { constructor(public code: number, message: string) }`。
- Produces（`cli/src/index.ts`）：`async function main(argv: string[]): Promise<number>` — 返回退出码，不自己调 `process.exit`（便于测试）；顶层 `import.meta.main` 时调用并 `process.exit`。`party --version` 打印版本、`party --help` 打印用法、未知命令 → stderr + 返回 `EXIT_ERROR`。
- 后续任务：所有命令是 `async (ctx) => Promise<void>`，抛 `CliError` 由 `main` 捕获转退出码。

- [ ] **Step 1: 写 shared 退出码 + 失败测试**

在 `shared/src/protocol.ts` 末尾追加：

```ts
// cli 退出码（Plan 3 的 serve supervisor 复用）
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_AUTH = 3;
export const EXIT_LOOP_GUARD = 4;
export const EXIT_ARCHIVED = 5;
export const EXIT_RATE_LIMITED = 9;
```

在 `shared/test/protocol.test.ts` 追加：

```ts
import { EXIT_OK, EXIT_ERROR, EXIT_AUTH, EXIT_LOOP_GUARD, EXIT_ARCHIVED, EXIT_RATE_LIMITED } from "../src/protocol";

describe("exit codes", () => {
  test("语义退出码值固定", () => {
    expect([EXIT_OK, EXIT_ERROR, EXIT_AUTH, EXIT_LOOP_GUARD, EXIT_ARCHIVED, EXIT_RATE_LIMITED]).toEqual([0, 1, 3, 4, 5, 9]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd shared && bun test`
Expected: FAIL（`EXIT_OK` 未导出）

- [ ] **Step 3: 写 cli 脚手架**

`cli/package.json`：

```json
{
  "name": "@agentparty-mini/cli",
  "private": true,
  "type": "module",
  "version": "0.1.0",
  "bin": { "party": "./src/index.ts" },
  "scripts": {
    "build": "bun build src/index.ts --compile --outfile dist/party",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "@agentparty-mini/shared": "workspace:*" },
  "devDependencies": { "@types/bun": "^1.2.0", "typescript": "^5.9.0" }
}
```

`cli/tsconfig.json`（Bun 运行时类型；若 `@types/bun` 的 types 名不对导致 typecheck 失败，按安装版本最小调整并在报告记录——同 worker Task 3 的做法）：

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["bun"]
  },
  "include": ["src", "test"]
}
```

`cli/src/errors.ts`：

```ts
export class CliError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}
```

`cli/src/index.ts`：

```ts
import { EXIT_ERROR, EXIT_OK } from "@agentparty-mini/shared";
import { CliError } from "./errors";
import pkg from "../package.json" with { type: "json" };

const HELP = `party — agentparty-mini CLI

usage:
  party init --server URL --token TOKEN --channel SLUG
  party send <text> [--mention NAME]... [--reply-to SEQ] [--channel SLUG]
  party watch [--mentions-only] [--once] [--follow] [--json] [--channel SLUG]
  party who [--json] [--channel SLUG]
  party status <working|waiting|blocked|done> [note] [--channel SLUG]
  party whoami
  party token create <name> --kind agent|human
  party token revoke <name>
  party channel create <slug> [--title T] [--party]
  party channel list
  party channel archive <slug>
  party channel guard <slug> <n|off|default>

flags: --server URL  --token TOKEN  override the bound config per-command`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "--version" || cmd === "-v") {
      process.stdout.write(`${pkg.version}\n`);
      return EXIT_OK;
    }
    if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
      process.stdout.write(`${HELP}\n`);
      return EXIT_OK;
    }
    // 命令表在后续任务逐个填充
    process.stderr.write(`unknown command: ${cmd}\n`);
    return EXIT_ERROR;
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`${e.message}\n`);
      return e.code;
    }
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_ERROR;
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).then((code) => process.exit(code));
}
```

- [ ] **Step 4: 写 cli 冒烟测试**

`cli/test/smoke.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { main } from "../src/index";

describe("cli dispatch", () => {
  test("--version 返回 0", async () => {
    expect(await main(["--version"])).toBe(0);
  });
  test("--help 返回 0", async () => {
    expect(await main(["--help"])).toBe(0);
  });
  test("无参数打印 help 返回 0", async () => {
    expect(await main([])).toBe(0);
  });
  test("未知命令返回 1", async () => {
    expect(await main(["frobnicate"])).toBe(1);
  });
});
```

- [ ] **Step 5: 根 package.json 接线**

把根 `package.json` 的 `workspaces` 改为 `["shared", "worker", "cli"]`，`check` 脚本改为：

```json
"check": "bun run check:shared && bun run check:worker && bun run check:cli",
"check:cli": "cd cli && bun test && bunx tsc --noEmit",
```

- [ ] **Step 6: 安装 + 运行确认通过**

Run: `bun install && cd shared && bun test && cd ../cli && bun test && bunx tsc --noEmit`
Expected: shared 测试全过、cli 4/4 过、typecheck 干净。若 `tsc` 因 `@types/bun` 的 types 名报错，调整 `types` 项（试 `["@types/bun"]` 或移除 types 项让其自动加载 `node_modules/@types/bun`）直到干净，并在报告记录改了什么。

- [ ] **Step 7: Commit**

```bash
git add shared/ cli/ package.json bun.lock
git commit -m "feat(cli): scaffold party CLI with dispatch skeleton and exit codes"
```

---

### Task 2: args.ts flag 解析

**Files:**
- Create: `cli/src/args.ts`
- Create: `cli/test/args.test.ts`

**Interfaces:**
- Produces：`parseArgs(argv: string[], spec: ArgSpec): { positionals: string[]; flags: Record<string, string | boolean> }`
  - `ArgSpec = { bool?: string[]; value?: string[] }` — `bool` 里的 flag 是布尔（`--once`），`value` 里的 flag 吃下一个参数（`--channel design`）。
  - `--flag=value` 和 `--flag value` 都支持；重复的 `value` flag 后者覆盖，除非在 `multi` 里（`--mention` 可重复，收集成数组）。
  - 未知 flag → 抛 `CliError(EXIT_ERROR, ...)`。
- 扩展：`ArgSpec` 增加 `multi?: string[]`（可重复的 value flag，收集为 `string[]`）。返回类型的 flags 值可为 `string | boolean | string[]`。

- [ ] **Step 1: 写失败测试**

`cli/test/args.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/args";
import { CliError } from "../src/errors";

const spec = { bool: ["once", "json"], value: ["channel", "reply-to"], multi: ["mention"] };

describe("parseArgs", () => {
  test("位置参数与布尔 flag", () => {
    const r = parseArgs(["hello", "world", "--once"], spec);
    expect(r.positionals).toEqual(["hello", "world"]);
    expect(r.flags.once).toBe(true);
  });
  test("--flag value 与 --flag=value 都支持", () => {
    expect(parseArgs(["--channel", "design"], spec).flags.channel).toBe("design");
    expect(parseArgs(["--channel=design"], spec).flags.channel).toBe("design");
  });
  test("multi flag 收集成数组，保序", () => {
    const r = parseArgs(["--mention", "bob", "--mention", "carol"], spec);
    expect(r.flags.mention).toEqual(["bob", "carol"]);
  });
  test("value flag 缺值抛错", () => {
    expect(() => parseArgs(["--channel"], spec)).toThrow(CliError);
  });
  test("未知 flag 抛错", () => {
    expect(() => parseArgs(["--bogus"], spec)).toThrow(CliError);
  });
  test("-- 之后全当位置参数", () => {
    const r = parseArgs(["--", "--not-a-flag"], spec);
    expect(r.positionals).toEqual(["--not-a-flag"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cli && bun test test/args.test.ts`
Expected: FAIL（`parseArgs` 未定义）

- [ ] **Step 3: 实现**

`cli/src/args.ts`：

```ts
import { EXIT_ERROR } from "@agentparty-mini/shared";
import { CliError } from "./errors";

export interface ArgSpec {
  bool?: string[];
  value?: string[];
  multi?: string[];
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

export function parseArgs(argv: string[], spec: ArgSpec): ParsedArgs {
  const bool = new Set(spec.bool ?? []);
  const value = new Set(spec.value ?? []);
  const multi = new Set(spec.multi ?? []);
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inlineVal = eq === -1 ? undefined : arg.slice(eq + 1);
    if (bool.has(name)) {
      flags[name] = true;
      continue;
    }
    if (value.has(name) || multi.has(name)) {
      let v: string;
      if (inlineVal !== undefined) v = inlineVal;
      else {
        if (i + 1 >= argv.length) throw new CliError(EXIT_ERROR, `flag --${name} requires a value`);
        v = argv[++i];
      }
      if (multi.has(name)) {
        const cur = (flags[name] as string[] | undefined) ?? [];
        cur.push(v);
        flags[name] = cur;
      } else {
        flags[name] = v;
      }
      continue;
    }
    throw new CliError(EXIT_ERROR, `unknown flag: --${name}`);
  }
  return { positionals, flags };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd cli && bun test test/args.test.ts && bunx tsc --noEmit`
Expected: 全过，typecheck 干净

- [ ] **Step 5: Commit**

```bash
git add cli/src/args.ts cli/test/args.test.ts
git commit -m "feat(cli): flag parser with bool/value/multi and -- terminator"
```

---

### Task 3: config.ts（配置 + 游标）+ whoami 命令

**Files:**
- Create: `cli/src/config.ts`
- Create: `cli/src/commands/whoami.ts`
- Modify: `cli/src/index.ts`（接 whoami）
- Create: `cli/test/config.test.ts`

**Interfaces:**
- Produces（`config.ts`）：
  - `interface Config { server: string; token: string; channel: string; name: string; kind: "agent" | "human" }`
  - `configDir(): string` — `${XDG_CONFIG_HOME ?? ~/.config}/party`
  - `configPath(): string`、`saveConfig(cfg: Config): void`（写 0600）、`loadConfig(): Config`（缺文件抛 `CliError(EXIT_ERROR, "not initialized; run 'party init' first")`）
  - `cursorPath(server: string, channel: string): string`、`loadCursor(server, channel): number`（缺文件返回 0）、`saveCursor(server, channel, seq): void`
  - `resolveChannel(cfg, override?: string): string`（override 优先，否则 cfg.channel）
- Produces（whoami）：`whoami` 命令打印 `<name> (<kind>) → <channel> @ <server>`，无网络。
- Consumes：Task 1 的 `CliError`；Task 2 的 `parseArgs`（whoami 无 flag，但走统一分派）。

- [ ] **Step 1: 写失败测试**

`cli/test/config.test.ts`（用临时 `XDG_CONFIG_HOME` 隔离，绝不碰真实 home）：

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, cursorPath, loadConfig, loadCursor, resolveChannel, saveConfig, saveCursor, type Config } from "../src/config";
import { CliError } from "../src/errors";

let dir: string;
const orig = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "party-cfg-"));
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(() => {
  if (orig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = orig;
  rmSync(dir, { recursive: true, force: true });
});

const sample: Config = { server: "https://s.example", token: "ap_abc", channel: "design", name: "alice", kind: "human" };

describe("config", () => {
  test("save 后 load 往返一致", () => {
    saveConfig(sample);
    expect(loadConfig()).toEqual(sample);
  });
  test("config 文件权限 0600", () => {
    saveConfig(sample);
    const mode = statSync(configPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
  test("未 init 时 load 抛 CliError", () => {
    expect(() => loadConfig()).toThrow(CliError);
  });
  test("游标：缺文件为 0，保存后按 host+channel 分文件", () => {
    expect(loadCursor("https://s.example", "design")).toBe(0);
    saveCursor("https://s.example", "design", 42);
    expect(loadCursor("https://s.example", "design")).toBe(42);
    // 不同频道互不干扰
    expect(loadCursor("https://s.example", "other")).toBe(0);
    // cursorPath 含 host 与 channel
    expect(cursorPath("https://s.example", "design")).toContain("s.example__design");
  });
  test("resolveChannel：override 优先", () => {
    expect(resolveChannel(sample)).toBe("design");
    expect(resolveChannel(sample, "hotfix")).toBe("hotfix");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cli && bun test test/config.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 config.ts**

```ts
import { EXIT_ERROR } from "@agentparty-mini/shared";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors";

export interface Config {
  server: string;
  token: string;
  channel: string;
  name: string;
  kind: "agent" | "human";
}

export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "party");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function saveConfig(cfg: Config): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function loadConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) throw new CliError(EXIT_ERROR, "not initialized; run 'party init' first");
  return JSON.parse(readFileSync(p, "utf8")) as Config;
}

export function resolveChannel(cfg: Config, override?: string): string {
  return override && override.length > 0 ? override : cfg.channel;
}

function hostOf(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server.replace(/[^a-zA-Z0-9.-]/g, "_");
  }
}

export function cursorPath(server: string, channel: string): string {
  return join(configDir(), "cursors", `${hostOf(server)}__${channel}.seq`);
}

export function loadCursor(server: string, channel: string): number {
  const p = cursorPath(server, channel);
  if (!existsSync(p)) return 0;
  const n = Number(readFileSync(p, "utf8").trim());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export function saveCursor(server: string, channel: string, seq: number): void {
  mkdirSync(join(configDir(), "cursors"), { recursive: true });
  writeFileSync(cursorPath(server, channel), String(seq));
}
```

- [ ] **Step 4: 实现 whoami 命令 + 接线**

`cli/src/commands/whoami.ts`：

```ts
import { loadConfig } from "../config";

export function whoami(): void {
  const c = loadConfig();
  process.stdout.write(`${c.name} (${c.kind}) → ${c.channel} @ ${c.server}\n`);
}
```

在 `cli/src/index.ts` 的 imports 加 `import { whoami } from "./commands/whoami";`，并在 dispatch（未知命令的 `process.stderr` 之前）加：

```ts
    if (cmd === "whoami") {
      whoami();
      return EXIT_OK;
    }
```

- [ ] **Step 5: 加 whoami 的分派测试**

在 `cli/test/config.test.ts` 追加（复用上面的 XDG 隔离 fixture）：

```ts
import { main } from "../src/index";

describe("whoami dispatch", () => {
  test("已 init → whoami 返回 0", async () => {
    saveConfig(sample);
    expect(await main(["whoami"])).toBe(0);
  });
  test("未 init → whoami 返回 EXIT_ERROR", async () => {
    expect(await main(["whoami"])).toBe(1);
  });
});
```

- [ ] **Step 6: 运行确认通过**

Run: `cd cli && bun test test/config.test.ts && bunx tsc --noEmit`
Expected: 全过

- [ ] **Step 7: Commit**

```bash
git add cli/src/config.ts cli/src/commands/whoami.ts cli/src/index.ts cli/test/config.test.ts
git commit -m "feat(cli): config store with 0600, per-channel cursors, whoami"
```

---

### Task 4: errors 映射 + rest.ts（HTTP 封装）

**Files:**
- Create: `cli/src/rest.ts`
- Create: `cli/test/rest.test.ts`

**Interfaces:**
- Produces（`rest.ts`）：
  - `interface RestOpts { server: string; token?: string; adminSecret?: string }`
  - `async function restFetch(path: string, opts: RestOpts & { method?: string; body?: unknown }): Promise<any>` — 拼 `server+path`，带 `Authorization: Bearer <token>`（有 token 时）与 `x-admin-secret`（有 adminSecret 时），JSON body；非 2xx → `CliError`：401→`EXIT_AUTH`、410→`EXIT_ARCHIVED`、其他→`EXIT_ERROR`（消息取响应体 `error` 字段或状态文本）；2xx 返回解析后的 JSON（204/空体返回 `{}`）。
  - 便捷封装：`getMe(o)`、`mintToken(o, name, kind)`、`revokeToken(o, name)`、`createChannel(o, {slug,title?,mode?})`、`listChannels(o)`、`archiveChannel(o, slug)`、`setGuard(o, slug, limit)`。
- Consumes：Task 1 `CliError` 与退出码。
- 测试策略：`restFetch` 接收一个可选的 `fetchImpl` 参数（默认全局 `fetch`）以便注入 mock。签名实际为 `restFetch(path, opts, fetchImpl = fetch)`。

- [ ] **Step 1: 写失败测试**

`cli/test/rest.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { restFetch } from "../src/rest";
import { CliError } from "../src/errors";
import { EXIT_AUTH, EXIT_ARCHIVED, EXIT_ERROR } from "@agentparty-mini/shared";

function mockFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("restFetch", () => {
  test("2xx 返回解析后的 JSON", async () => {
    const r = await restFetch("/api/me", { server: "https://s", token: "ap_x" }, mockFetch(200, { name: "bob", kind: "agent" }));
    expect(r).toEqual({ name: "bob", kind: "agent" });
  });
  test("401 → CliError(EXIT_AUTH)", async () => {
    try {
      await restFetch("/api/me", { server: "https://s", token: "bad" }, mockFetch(401, { error: "invalid" }));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(EXIT_AUTH);
    }
  });
  test("410 → CliError(EXIT_ARCHIVED)", async () => {
    try {
      await restFetch("/api/channels/x/ws", { server: "https://s", token: "t" }, mockFetch(410, { error: "archived" }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CliError).code).toBe(EXIT_ARCHIVED);
    }
  });
  test("500 → CliError(EXIT_ERROR) 带服务端 error 文本", async () => {
    try {
      await restFetch("/api/channels", { server: "https://s", token: "t" }, mockFetch(500, { error: "internal error" }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CliError).code).toBe(EXIT_ERROR);
      expect((e as CliError).message).toContain("internal error");
    }
  });
  test("空体 2xx 返回 {}", async () => {
    const r = await restFetch("/api/channels/x/archive", { server: "https://s", token: "t", method: "POST" } as any, mockFetch(200, undefined));
    expect(r).toEqual({});
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cli && bun test test/rest.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`cli/src/rest.ts`：

```ts
import { EXIT_ARCHIVED, EXIT_AUTH, EXIT_ERROR } from "@agentparty-mini/shared";
import { CliError } from "./errors";

export interface RestOpts {
  server: string;
  token?: string;
  adminSecret?: string;
  method?: string;
  body?: unknown;
}

export async function restFetch(path: string, opts: RestOpts, fetchImpl: typeof fetch = fetch): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.adminSecret) headers["x-admin-secret"] = opts.adminSecret;
  const res = await fetchImpl(`${opts.server}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as any) : {};
  if (res.ok) return parsed;
  const msg = (parsed && parsed.error) || `HTTP ${res.status}`;
  if (res.status === 401) throw new CliError(EXIT_AUTH, `auth failed: ${msg}`);
  if (res.status === 410) throw new CliError(EXIT_ARCHIVED, `channel archived: ${msg}`);
  throw new CliError(EXIT_ERROR, `request failed: ${msg}`);
}

export const getMe = (o: RestOpts) => restFetch("/api/me", o);
export const mintToken = (o: RestOpts, name: string, kind: "agent" | "human") =>
  restFetch("/api/tokens", { ...o, method: "POST", body: { name, kind } });
export const revokeToken = (o: RestOpts, name: string) =>
  restFetch(`/api/tokens/${name}`, { ...o, method: "DELETE" });
export const createChannel = (o: RestOpts, body: { slug: string; title?: string; mode?: string }) =>
  restFetch("/api/channels", { ...o, method: "POST", body });
export const listChannels = (o: RestOpts) => restFetch("/api/channels", o);
export const archiveChannel = (o: RestOpts, slug: string) =>
  restFetch(`/api/channels/${slug}/archive`, { ...o, method: "POST" });
export const setGuard = (o: RestOpts, slug: string, limit: number | null) =>
  restFetch(`/api/channels/${slug}/guard`, { ...o, method: "PUT", body: { limit } });
```

- [ ] **Step 4: 运行确认通过**

Run: `cd cli && bun test test/rest.test.ts && bunx tsc --noEmit`
Expected: 全过

- [ ] **Step 5: Commit**

```bash
git add cli/src/rest.ts cli/test/rest.test.ts
git commit -m "feat(cli): REST wrapper with HTTP status to CliError mapping"
```

---

### Task 5: init 命令

**Files:**
- Create: `cli/src/commands/init.ts`
- Modify: `cli/src/index.ts`（接 init）
- Create: `cli/test/init.test.ts`

**Interfaces:**
- Produces：`async function init(argv: string[], fetchImpl?: typeof fetch): Promise<void>` — 解析 `--server`/`--token`/`--channel`（都必填，缺任一 → `CliError(EXIT_ERROR)`）；`getMe` 验证 token 并回填 `name`/`kind`；`saveConfig`；打印 `bound as <name> (<kind>) → <channel> @ <server>`。token 无效时 `getMe` 抛 `EXIT_AUTH`，不写 config。
- Consumes：Task 2 `parseArgs`、Task 3 `saveConfig`/`Config`、Task 4 `getMe`。
- index dispatch 传入 `fetchImpl` 默认 `fetch`；测试直接调 `init(argv, mockFetch)`。

- [ ] **Step 1: 写失败测试**

`cli/test/init.test.ts`（复用 XDG 隔离）：

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/commands/init";
import { loadConfig } from "../src/config";
import { CliError } from "../src/errors";
import { EXIT_AUTH, EXIT_ERROR } from "@agentparty-mini/shared";

let dir: string;
const orig = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "party-init-"));
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(() => {
  if (orig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = orig;
  rmSync(dir, { recursive: true, force: true });
});

function fetchOk(name: string, kind: string): typeof fetch {
  return (async () => new Response(JSON.stringify({ name, kind }), { status: 200 })) as unknown as typeof fetch;
}
function fetch401(): typeof fetch {
  return (async () => new Response(JSON.stringify({ error: "invalid" }), { status: 401 })) as unknown as typeof fetch;
}

describe("init", () => {
  test("验证 token 并回填身份写入 config", async () => {
    await init(["--server", "https://s.example", "--token", "ap_x", "--channel", "design"], fetchOk("alice", "human"));
    expect(loadConfig()).toEqual({ server: "https://s.example", token: "ap_x", channel: "design", name: "alice", kind: "human" });
  });
  test("缺 --channel 抛 EXIT_ERROR", async () => {
    try {
      await init(["--server", "https://s", "--token", "ap_x"], fetchOk("a", "human"));
      throw new Error("should throw");
    } catch (e) {
      expect((e as CliError).code).toBe(EXIT_ERROR);
    }
  });
  test("token 无效抛 EXIT_AUTH 且不写 config", async () => {
    try {
      await init(["--server", "https://s", "--token", "bad", "--channel", "design"], fetch401());
      throw new Error("should throw");
    } catch (e) {
      expect((e as CliError).code).toBe(EXIT_AUTH);
    }
    expect(() => loadConfig()).toThrow(CliError);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cli && bun test test/init.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`cli/src/commands/init.ts`：

```ts
import { EXIT_ERROR } from "@agentparty-mini/shared";
import { parseArgs } from "../args";
import { saveConfig, type Config } from "../config";
import { CliError } from "../errors";
import { getMe } from "../rest";

export async function init(argv: string[], fetchImpl: typeof fetch = fetch): Promise<void> {
  const { flags } = parseArgs(argv, { value: ["server", "token", "channel"] });
  const server = flags.server as string | undefined;
  const token = flags.token as string | undefined;
  const channel = flags.channel as string | undefined;
  if (!server || !token || !channel) {
    throw new CliError(EXIT_ERROR, "init requires --server, --token, and --channel");
  }
  const me = (await getMe({ server, token }, fetchImpl as any)) as { name: string; kind: "agent" | "human" };
  const cfg: Config = { server, token, channel, name: me.name, kind: me.kind };
  saveConfig(cfg);
  process.stdout.write(`bound as ${cfg.name} (${cfg.kind}) → ${cfg.channel} @ ${cfg.server}\n`);
}
```

注：`getMe(o)` 目前签名是 `restFetch(path, o)`，不透传 `fetchImpl`。改 `getMe` 为 `(o, f?) => restFetch("/api/me", o, f)`。同步把 rest.ts 里 `getMe` 改成：

```ts
export const getMe = (o: RestOpts, f?: typeof fetch) => restFetch("/api/me", o, f);
```

在 `cli/src/index.ts` imports 加 `import { init } from "./commands/init";`，dispatch 加：

```ts
    if (cmd === "init") {
      await init(rest);
      return EXIT_OK;
    }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd cli && bun test test/init.test.ts && bunx tsc --noEmit`
Expected: 全过

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/init.ts cli/src/rest.ts cli/src/index.ts cli/test/init.test.ts
git commit -m "feat(cli): init command validates token via /api/me and binds config"
```

---

### Task 6: token + channel 命令（REST 包装，bootstrap 可用）

**Files:**
- Create: `cli/src/commands/token.ts`
- Create: `cli/src/commands/channel.ts`
- Modify: `cli/src/index.ts`（接 token/channel）
- Create: `cli/test/bootstrap.test.ts`

**Interfaces:**
- Produces（token）：`async function tokenCmd(argv: string[], fetchImpl?): Promise<void>` — 子命令 `create <name> --kind agent|human` / `revoke <name>`；server 从 config 取（token 命令不需 config 的 token，但需 server；若无 config 用 `--server`）；`ADMIN_SECRET` 从环境变量取，缺则 `CliError(EXIT_ERROR)`；create 打印铸出的 `ap_…`（仅此一次），revoke 打印确认。
- Produces（channel）：`async function channelCmd(argv: string[], fetchImpl?): Promise<void>` — 子命令 `create <slug> [--title T] [--party]` / `list` / `archive <slug>` / `guard <slug> <n|off|default>`；用 config 的 server+token；`guard off`→limit 0、`guard <n>`→limit n、`guard default`→limit null。
- Consumes：Task 3 `loadConfig`、Task 4 `mintToken`/`revokeToken`/`createChannel`/`listChannels`/`archiveChannel`/`setGuard`。
- 便捷封装需支持 fetch 注入：把 rest.ts 的 7 个便捷封装都改成末位可选 `f?: typeof fetch` 并透传给 `restFetch`（与 getMe 一致）。测试对这些注入 mock。

- [ ] **Step 1: 写失败测试**

`cli/test/bootstrap.test.ts`（用 XDG 隔离并预置 config；mock fetch 记录请求）：

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenCmd } from "../src/commands/token";
import { channelCmd } from "../src/commands/channel";
import { saveConfig, type Config } from "../src/config";
import { CliError } from "../src/errors";
import { EXIT_ERROR } from "@agentparty-mini/shared";

let dir: string;
const origXdg = process.env.XDG_CONFIG_HOME;
const origSecret = process.env.ADMIN_SECRET;
const cfg: Config = { server: "https://s.example", token: "ap_owner", channel: "design", name: "alice", kind: "human" };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "party-boot-"));
  process.env.XDG_CONFIG_HOME = dir;
  saveConfig(cfg);
});
afterEach(() => {
  origXdg === undefined ? delete process.env.XDG_CONFIG_HOME : (process.env.XDG_CONFIG_HOME = origXdg);
  origSecret === undefined ? delete process.env.ADMIN_SECRET : (process.env.ADMIN_SECRET = origSecret);
  rmSync(dir, { recursive: true, force: true });
});

interface Captured { url: string; method: string; headers: any; body: any }
function capturing(status: number, resBody: unknown): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch = (async (url: string, init: any) => {
    calls.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(resBody === undefined ? "" : JSON.stringify(resBody), { status });
  }) as unknown as typeof fetch;
  return { fetch, calls };
}

describe("token command", () => {
  test("create 带 admin secret 头和 kind", async () => {
    process.env.ADMIN_SECRET = "s3cret";
    const { fetch, calls } = capturing(201, { token: "ap_new", name: "ci", kind: "agent" });
    await tokenCmd(["create", "ci", "--kind", "agent"], fetch);
    expect(calls[0].url).toBe("https://s.example/api/tokens");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["x-admin-secret"]).toBe("s3cret");
    expect(calls[0].body).toEqual({ name: "ci", kind: "agent" });
  });
  test("缺 ADMIN_SECRET 抛 EXIT_ERROR", async () => {
    delete process.env.ADMIN_SECRET;
    const { fetch } = capturing(201, {});
    try {
      await tokenCmd(["create", "ci", "--kind", "agent"], fetch);
      throw new Error("should throw");
    } catch (e) {
      expect((e as CliError).code).toBe(EXIT_ERROR);
    }
  });
});

describe("channel command", () => {
  test("create --party 传 mode party，用 config 的 bearer token", async () => {
    const { fetch, calls } = capturing(201, { slug: "brainstorm", mode: "party" });
    await channelCmd(["create", "brainstorm", "--party"], fetch);
    expect(calls[0].url).toBe("https://s.example/api/channels");
    expect(calls[0].headers["authorization"]).toBe("Bearer ap_owner");
    expect(calls[0].body).toEqual({ slug: "brainstorm", mode: "party" });
  });
  test("guard off → limit 0；guard default → limit null；guard 50 → limit 50", async () => {
    const off = capturing(200, { ok: true });
    await channelCmd(["guard", "design", "off"], off.fetch);
    expect(off.calls[0].body).toEqual({ limit: 0 });
    const def = capturing(200, { ok: true });
    await channelCmd(["guard", "design", "default"], def.fetch);
    expect(def.calls[0].body).toEqual({ limit: null });
    const fifty = capturing(200, { ok: true });
    await channelCmd(["guard", "design", "50"], fifty.fetch);
    expect(fifty.calls[0].body).toEqual({ limit: 50 });
  });
  test("list 走 GET", async () => {
    const { fetch, calls } = capturing(200, { channels: [] });
    await channelCmd(["list"], fetch);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://s.example/api/channels");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cli && bun test test/bootstrap.test.ts`
Expected: FAIL

- [ ] **Step 3: 先把 rest.ts 便捷封装改成可注入 fetch**

把 `cli/src/rest.ts` 的便捷封装全部加末位 `f?: typeof fetch` 并透传：

```ts
export const getMe = (o: RestOpts, f?: typeof fetch) => restFetch("/api/me", o, f);
export const mintToken = (o: RestOpts, name: string, kind: "agent" | "human", f?: typeof fetch) =>
  restFetch("/api/tokens", { ...o, method: "POST", body: { name, kind } }, f);
export const revokeToken = (o: RestOpts, name: string, f?: typeof fetch) =>
  restFetch(`/api/tokens/${name}`, { ...o, method: "DELETE" }, f);
export const createChannel = (o: RestOpts, body: { slug: string; title?: string; mode?: string }, f?: typeof fetch) =>
  restFetch("/api/channels", { ...o, method: "POST", body }, f);
export const listChannels = (o: RestOpts, f?: typeof fetch) => restFetch("/api/channels", o, f);
export const archiveChannel = (o: RestOpts, slug: string, f?: typeof fetch) =>
  restFetch(`/api/channels/${slug}/archive`, { ...o, method: "POST" }, f);
export const setGuard = (o: RestOpts, slug: string, limit: number | null, f?: typeof fetch) =>
  restFetch(`/api/channels/${slug}/guard`, { ...o, method: "PUT", body: { limit } }, f);
```

（`f` 为 undefined 时 `restFetch` 默认用全局 `fetch`。）

- [ ] **Step 4: 实现 token.ts 与 channel.ts**

`cli/src/commands/token.ts`：

```ts
import { EXIT_ERROR, isName } from "@agentparty-mini/shared";
import { parseArgs } from "../args";
import { loadConfig } from "../config";
import { CliError } from "../errors";
import { mintToken, revokeToken, type RestOpts } from "../rest";

export async function tokenCmd(argv: string[], fetchImpl: typeof fetch = fetch): Promise<void> {
  const { positionals, flags } = parseArgs(argv, { value: ["kind", "server"] });
  const [sub, name] = positionals;
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) throw new CliError(EXIT_ERROR, "token commands need ADMIN_SECRET in the environment");
  const server = (flags.server as string | undefined) ?? loadConfig().server;
  const o: RestOpts = { server, adminSecret };
  if (sub === "create") {
    if (!isName(name)) throw new CliError(EXIT_ERROR, "usage: party token create <name> --kind agent|human");
    const kind = flags.kind;
    if (kind !== "agent" && kind !== "human") throw new CliError(EXIT_ERROR, "--kind must be agent or human");
    const res = (await mintToken(o, name, kind, fetchImpl)) as { token: string };
    process.stdout.write(`${res.token}\n`);
    return;
  }
  if (sub === "revoke") {
    if (!isName(name)) throw new CliError(EXIT_ERROR, "usage: party token revoke <name>");
    await revokeToken(o, name, fetchImpl);
    process.stdout.write(`revoked ${name}\n`);
    return;
  }
  throw new CliError(EXIT_ERROR, "usage: party token <create|revoke> ...");
}
```

`cli/src/commands/channel.ts`：

```ts
import { EXIT_ERROR, isName } from "@agentparty-mini/shared";
import { parseArgs } from "../args";
import { loadConfig } from "../config";
import { CliError } from "../errors";
import { archiveChannel, createChannel, listChannels, setGuard, type RestOpts } from "../rest";

export async function channelCmd(argv: string[], fetchImpl: typeof fetch = fetch): Promise<void> {
  const { positionals, flags } = parseArgs(argv, { bool: ["party"], value: ["title"] });
  const [sub, arg1, arg2] = positionals;
  const cfg = loadConfig();
  const o: RestOpts = { server: cfg.server, token: cfg.token };
  if (sub === "create") {
    if (!isName(arg1)) throw new CliError(EXIT_ERROR, "usage: party channel create <slug> [--title T] [--party]");
    const body: { slug: string; title?: string; mode?: string } = { slug: arg1 };
    if (typeof flags.title === "string") body.title = flags.title;
    if (flags.party === true) body.mode = "party";
    await createChannel(o, body, fetchImpl);
    process.stdout.write(`created channel ${arg1}${flags.party ? " (party)" : ""}\n`);
    return;
  }
  if (sub === "list") {
    const res = (await listChannels(o, fetchImpl)) as { channels: { slug: string; title: string; mode: string }[] };
    for (const ch of res.channels) process.stdout.write(`${ch.slug}\t${ch.mode}\t${ch.title}\n`);
    return;
  }
  if (sub === "archive") {
    if (!isName(arg1)) throw new CliError(EXIT_ERROR, "usage: party channel archive <slug>");
    await archiveChannel(o, arg1, fetchImpl);
    process.stdout.write(`archived ${arg1}\n`);
    return;
  }
  if (sub === "guard") {
    if (!isName(arg1)) throw new CliError(EXIT_ERROR, "usage: party channel guard <slug> <n|off|default>");
    let limit: number | null;
    if (arg2 === "off") limit = 0;
    else if (arg2 === "default") limit = null;
    else {
      const n = Number(arg2);
      if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new CliError(EXIT_ERROR, "guard limit must be off, default, or 0..10000");
      limit = n;
    }
    await setGuard(o, arg1, limit, fetchImpl);
    process.stdout.write(`guard for ${arg1} set to ${arg2}\n`);
    return;
  }
  throw new CliError(EXIT_ERROR, "usage: party channel <create|list|archive|guard> ...");
}
```

在 `cli/src/index.ts` imports 加 `import { tokenCmd } from "./commands/token";` 与 `import { channelCmd } from "./commands/channel";`，dispatch 加：

```ts
    if (cmd === "token") {
      await tokenCmd(rest);
      return EXIT_OK;
    }
    if (cmd === "channel") {
      await channelCmd(rest);
      return EXIT_OK;
    }
```

- [ ] **Step 5: 运行确认通过**

Run: `cd cli && bun test && bunx tsc --noEmit`
Expected: 全部（含 Task 1-5 无回归）通过

- [ ] **Step 6: Commit**

```bash
git add cli/src/rest.ts cli/src/commands/token.ts cli/src/commands/channel.ts cli/src/index.ts cli/test/bootstrap.test.ts
git commit -m "feat(cli): token and channel REST wrapper commands for bootstrap"
```

---

### Task 7: ws.ts openChannel 复用层 + mock server 测试基建

**Files:**
- Create: `cli/src/ws.ts`
- Create: `cli/test/mock-channel.ts`（测试辅助，后续 Task 8-10 复用）
- Create: `cli/test/ws.test.ts`

**Interfaces:**
- Produces（`ws.ts`）：
  - `type HelloFrame = Extract<ServerFrame, { type: "hello" }>`
  - `interface OpenOpts { after?: number; reconnect?: boolean; reconnectDelaysMs?: number[] }`
  - `interface Channel { hello: HelloFrame; frames: AsyncIterable<ServerFrame>; send(frame: SendFrame): void; close(): void }`
  - `async function openChannel(cfg: { server: string; token: string }, channel: string, opts?: OpenOpts): Promise<Channel>` — 连 WS、等 hello 才 resolve；`frames` 吐 hello 之后的历史+实时帧；终局 `error`（auth/archived）在 hello 前 → reject `CliError`，在 hello 后 → push 后结束迭代；仅 `reconnect:true` 时非终局断线按 `reconnectDelaysMs`（默认 `[1000,2000,4000,8000,16000,30000]`）退避重连并带当前 lastSeq 补拉，重连的 hello 被吞掉不入队。
  - `function toWsUrl(server: string, channel: string, token: string, after?: number): string` — http→ws/https→wss + 路径 + `?token=`(+`&after=`)。
- Produces（`mock-channel.ts`）：`startMockChannel(opts): { url: string; stop(): void; ... }`（见实现）——一个用 `Bun.serve` 起的最小频道，行为贴近真实 DO（发 hello、消息回 sent+广播 msg、status 回 presence、按 `?after=` 补拉 history、可注入 connect 时的 error）。
- Consumes：Task 1 `CliError`/退出码，shared `ServerFrame`/`SendFrame`。

- [ ] **Step 1: 写 mock server 测试辅助**

`cli/test/mock-channel.ts`：

```ts
import type { PresenceEntry, ServerFrame } from "@agentparty-mini/shared";

export interface MockOpts {
  self: string;                         // 连接者身份（hello.self）
  kind?: "agent" | "human";
  presence?: PresenceEntry[];           // hello.presence
  mode?: "normal" | "party";
  guard?: number;
  history?: { seq: number; sender: string; body: string }[];  // 供 ?after= 补拉
  connectError?: { code: string; message: string };           // 若设，连接即发 error+close(1008)，不发 hello
  dropFirstConnection?: boolean;        // 第一条连接发完 hello 后立即 close（测重连）
}

export function startMockChannel(opts: MockOpts) {
  let seqCounter = opts.history?.length ? Math.max(...opts.history.map((h) => h.seq)) : 0;
  let connectionCount = 0;
  const kind = opts.kind ?? "human";
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: { url: req.url } })) return;
      return new Response("expected websocket", { status: 426 });
    },
    websocket: {
      open(ws) {
        connectionCount++;
        const url = new URL((ws.data as { url: string }).url);
        const after = Number(url.searchParams.get("after") ?? 0);
        if (opts.connectError) {
          ws.send(JSON.stringify({ type: "error", ...opts.connectError }));
          ws.close(1008, opts.connectError.code);
          return;
        }
        const hello: ServerFrame = {
          type: "hello",
          channel: "mock",
          self: opts.self,
          seq_high: seqCounter,
          mode: opts.mode ?? "normal",
          guard: opts.guard ?? 30,
          presence: opts.presence ?? [{ name: opts.self, kind, state: "waiting", note: null, last_seen: 0 }],
        };
        ws.send(JSON.stringify(hello));
        for (const h of opts.history ?? []) {
          if (h.seq > after) {
            ws.send(JSON.stringify({ type: "msg", seq: h.seq, ts: 0, sender: h.sender, sender_kind: "human", body: h.body, mentions: [], reply_to: null } satisfies ServerFrame));
          }
        }
        if (opts.dropFirstConnection && connectionCount === 1) ws.close(1006, "drop");
      },
      message(ws, raw) {
        const frame = JSON.parse(String(raw));
        if (frame.kind === "message") {
          const seq = ++seqCounter;
          ws.send(JSON.stringify({ type: "sent", seq, idem_key: frame.idem_key } satisfies ServerFrame));
          ws.send(JSON.stringify({ type: "msg", seq, ts: 0, sender: opts.self, sender_kind: kind, body: frame.body, mentions: [], reply_to: frame.reply_to ?? null } satisfies ServerFrame));
        } else if (frame.kind === "status") {
          ws.send(JSON.stringify({ type: "presence", entry: { name: opts.self, kind, state: frame.state, note: frame.note ?? null, last_seen: 0 } } satisfies ServerFrame));
        }
      },
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}
```

- [ ] **Step 2: 写失败测试**

`cli/test/ws.test.ts`：

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { openChannel } from "../src/ws";
import { startMockChannel } from "./mock-channel";
import { CliError } from "../src/errors";
import { EXIT_ARCHIVED } from "@agentparty-mini/shared";

let stopFn: (() => void) | null = null;
afterEach(() => {
  stopFn?.();
  stopFn = null;
});

describe("openChannel", () => {
  test("等 hello 才 resolve，携带 self/presence", async () => {
    const m = startMockChannel({ self: "alice", presence: [{ name: "alice", kind: "human", state: "working", note: null, last_seen: 0 }] });
    stopFn = m.stop;
    const ch = await openChannel({ server: m.url, token: "ap_alice" }, "mock");
    expect(ch.hello.self).toBe("alice");
    expect(ch.hello.presence[0].name).toBe("alice");
    ch.close();
  });

  test("send message → 收到自己的 sent{idem_key}", async () => {
    const m = startMockChannel({ self: "bob" });
    stopFn = m.stop;
    const ch = await openChannel({ server: m.url, token: "ap_bob" }, "mock");
    ch.send({ type: "send", kind: "message", body: "hi", idem_key: "k1" });
    let sentSeq = -1;
    for await (const f of ch.frames) {
      if (f.type === "sent" && f.idem_key === "k1") { sentSeq = f.seq; break; }
    }
    expect(sentSeq).toBeGreaterThan(0);
    ch.close();
  });

  test("status → 收到自己的 presence 回显", async () => {
    const m = startMockChannel({ self: "carol", kind: "agent" });
    stopFn = m.stop;
    const ch = await openChannel({ server: m.url, token: "ap_carol" }, "mock");
    ch.send({ type: "send", kind: "status", state: "blocked", note: "ci" });
    let got = false;
    for await (const f of ch.frames) {
      if (f.type === "presence" && f.entry.name === "carol" && f.entry.state === "blocked") { got = true; break; }
    }
    expect(got).toBe(true);
    ch.close();
  });

  test("?after= 补拉历史", async () => {
    const m = startMockChannel({ self: "dave", history: [
      { seq: 1, sender: "x", body: "one" },
      { seq: 2, sender: "y", body: "two" },
      { seq: 3, sender: "z", body: "three" },
    ] });
    stopFn = m.stop;
    const ch = await openChannel({ server: m.url, token: "ap_dave" }, "mock", { after: 1 });
    const seqs: number[] = [];
    for await (const f of ch.frames) {
      if (f.type === "msg") { seqs.push(f.seq); if (seqs.length === 2) break; }
    }
    expect(seqs).toEqual([2, 3]);
    ch.close();
  });

  test("连接即 archived → reject CliError(EXIT_ARCHIVED)", async () => {
    const m = startMockChannel({ self: "e", connectError: { code: "archived", message: "channel is archived" } });
    stopFn = m.stop;
    await expect(openChannel({ server: m.url, token: "ap_e" }, "mock")).rejects.toBeInstanceOf(CliError);
    try {
      await openChannel({ server: m.url, token: "ap_e" }, "mock");
    } catch (e) {
      expect((e as CliError).code).toBe(EXIT_ARCHIVED);
    }
  });

  test("reconnect：首连被 drop 后自动重连并拿到 hello", async () => {
    const m = startMockChannel({ self: "f", dropFirstConnection: true });
    stopFn = m.stop;
    const ch = await openChannel({ server: m.url, token: "ap_f" }, "mock", { reconnect: true, reconnectDelaysMs: [10, 10] });
    // 首连拿到 hello 后被 drop；重连后能正常 send 并收到 sent
    ch.send({ type: "send", kind: "message", body: "after-reconnect", idem_key: "kr" });
    let ok = false;
    for await (const fr of ch.frames) {
      if (fr.type === "sent" && fr.idem_key === "kr") { ok = true; break; }
    }
    expect(ok).toBe(true);
    ch.close();
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd cli && bun test test/ws.test.ts`
Expected: FAIL（`openChannel` 未定义）

- [ ] **Step 4: 实现 ws.ts**

`cli/src/ws.ts`：

```ts
import { EXIT_ARCHIVED, EXIT_AUTH, type SendFrame, type ServerFrame } from "@agentparty-mini/shared";
import { CliError } from "./errors";

export type HelloFrame = Extract<ServerFrame, { type: "hello" }>;

export interface OpenOpts {
  after?: number;
  reconnect?: boolean;
  reconnectDelaysMs?: number[];
}

export interface Channel {
  hello: HelloFrame;
  frames: AsyncIterable<ServerFrame>;
  send(frame: SendFrame): void;
  close(): void;
}

const DEFAULT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

export function toWsUrl(server: string, channel: string, token: string, after?: number): string {
  const base = server.replace(/^http/, "ws");
  const q = new URLSearchParams({ token });
  if (after !== undefined && after > 0) q.set("after", String(after));
  return `${base}/api/channels/${channel}/ws?${q.toString()}`;
}

function isTerminalCode(code: string): boolean {
  return code === "auth" || code === "archived";
}
function terminalError(frame: Extract<ServerFrame, { type: "error" }>): CliError {
  const code = frame.code === "archived" ? EXIT_ARCHIVED : EXIT_AUTH;
  return new CliError(code, frame.message);
}

class FrameQueue implements AsyncIterable<ServerFrame> {
  private items: ServerFrame[] = [];
  private resolvers: ((r: IteratorResult<ServerFrame>) => void)[] = [];
  private done = false;
  push(f: ServerFrame) {
    const r = this.resolvers.shift();
    if (r) r({ value: f, done: false });
    else this.items.push(f);
  }
  finish() {
    this.done = true;
    let r;
    while ((r = this.resolvers.shift())) r({ value: undefined as never, done: true });
  }
  async *[Symbol.asyncIterator](): AsyncIterator<ServerFrame> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.done) return;
      const r = await new Promise<IteratorResult<ServerFrame>>((res) => this.resolvers.push(res));
      if (r.done) return;
      yield r.value;
    }
  }
}

export async function openChannel(
  cfg: { server: string; token: string },
  channel: string,
  opts: OpenOpts = {},
): Promise<Channel> {
  const queue = new FrameQueue();
  const delays = opts.reconnectDelaysMs ?? DEFAULT_DELAYS;
  let ws: WebSocket;
  let lastSeq = opts.after ?? 0;
  let closedByCaller = false;
  let gotFirstHello = false;
  let swallowHello = false; // 重连后的 hello 不入队
  let attempt = 0;
  let helloResolve!: (h: HelloFrame) => void;
  let helloReject!: (e: unknown) => void;
  const helloPromise = new Promise<HelloFrame>((res, rej) => {
    helloResolve = res;
    helloReject = rej;
  });

  const connect = () => {
    ws = new WebSocket(toWsUrl(cfg.server, channel, cfg.token, lastSeq));
    ws.addEventListener("message", (ev: MessageEvent) => {
      const frame = JSON.parse(String(ev.data)) as ServerFrame;
      if (frame.type === "hello") {
        if (!gotFirstHello) {
          gotFirstHello = true;
          helloResolve(frame);
        }
        // 无论首连还是重连，hello 本身不进 frames
        swallowHello = false;
        return;
      }
      if (!gotFirstHello && frame.type === "error") {
        helloReject(terminalError(frame));
        return;
      }
      if (frame.type === "msg") lastSeq = frame.seq;
      if (frame.type === "error" && isTerminalCode(frame.code)) {
        queue.push(frame);
        queue.finish();
        closedByCaller = true; // 阻止重连
        return;
      }
      queue.push(frame);
    });
    ws.addEventListener("close", () => {
      if (closedByCaller) {
        queue.finish();
        return;
      }
      if (!gotFirstHello) {
        // 首个 hello 都没拿到就断：视为连接失败
        helloReject(new CliError(EXIT_AUTH, "connection closed before hello"));
        return;
      }
      if (opts.reconnect) {
        const delay = delays[Math.min(attempt, delays.length - 1)];
        attempt++;
        swallowHello = true;
        setTimeout(connect, delay);
        return;
      }
      queue.finish();
    });
    ws.addEventListener("error", () => {
      // close 事件会随后到来，统一在 close 里处理
    });
  };

  connect();
  const hello = await helloPromise;
  return {
    hello,
    frames: queue,
    send: (f: SendFrame) => ws.send(JSON.stringify(f)),
    close: () => {
      closedByCaller = true;
      ws.close();
    },
  };
}
```

（注：`swallowHello` 变量保留以表达意图，但 hello 分支已无条件不入队，逻辑正确。）

- [ ] **Step 5: 运行确认通过**

Run: `cd cli && bun test test/ws.test.ts && bunx tsc --noEmit`
Expected: 全过。若 reconnect 用例偶发时序不稳，确认 mock 的 `dropFirstConnection` 只在第一条连接触发、重连用小 delay；不要放宽断言。

- [ ] **Step 6: Commit**

```bash
git add cli/src/ws.ts cli/test/mock-channel.ts cli/test/ws.test.ts
git commit -m "feat(cli): openChannel WS layer with hello handshake, catch-up, reconnect"
```

---

### Task 8: format.ts + who + status 命令

**Files:**
- Create: `cli/src/format.ts`
- Create: `cli/src/commands/who.ts`
- Create: `cli/src/commands/status.ts`
- Modify: `cli/src/index.ts`（接 who/status）
- Create: `cli/test/who-status.test.ts`
- Create: `cli/test/format.test.ts`

**Interfaces:**
- Produces（`format.ts`）：
  - `formatMsg(f: Extract<ServerFrame,{type:"msg"}>): string` — 人读行 `[<sender>] <body>`（system 消息前缀 `**`）。
  - `formatPresence(e: PresenceEntry): string` — `· <name> is <state>`（有 note 加 ` (<note>)`）。
  - `ndjson(f: ServerFrame): string` — `JSON.stringify(f)`。
- Produces（who）：`async function who(argv, deps?): Promise<void>` — openChannel → 打印 `hello.presence`（`--json` 每条一行 ndjson，否则 formatPresence）→ close。
- Produces（status）：`async function status(argv, deps?): Promise<void>` — 校验 state ∈ {working,waiting,blocked,done} → openChannel → send status → 等自己的 presence 回显 → 打印 `status set: <state>` → close。
- `deps` = `{ open?: typeof openChannel; cfg?: Config }` 便于测试注入；默认 `open=openChannel`、`cfg=loadConfig()`。
- Consumes：Task 3 `loadConfig`/`resolveChannel`、Task 7 `openChannel`。

- [ ] **Step 1: 写失败测试**

`cli/test/format.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { formatMsg, formatPresence, ndjson } from "../src/format";

describe("format", () => {
  test("formatMsg 普通与 system", () => {
    expect(formatMsg({ type: "msg", seq: 1, ts: 0, sender: "bob", sender_kind: "human", body: "hi", mentions: [], reply_to: null })).toBe("[bob] hi");
    expect(formatMsg({ type: "msg", seq: 2, ts: 0, sender: "system", sender_kind: "agent", body: "loop guard", mentions: [], reply_to: null })).toBe("**[system] loop guard");
  });
  test("formatPresence 带/不带 note", () => {
    expect(formatPresence({ name: "a", kind: "human", state: "working", note: null, last_seen: 0 })).toBe("· a is working");
    expect(formatPresence({ name: "b", kind: "agent", state: "blocked", note: "ci", last_seen: 0 })).toBe("· b is blocked (ci)");
  });
  test("ndjson 是单行 JSON", () => {
    const line = ndjson({ type: "sent", seq: 5, idem_key: "k" });
    expect(line).toBe('{"type":"sent","seq":5,"idem_key":"k"}');
  });
});
```

`cli/test/who-status.test.ts`：

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { who } from "../src/commands/who";
import { status } from "../src/commands/status";
import { openChannel } from "../src/ws";
import { startMockChannel } from "./mock-channel";
import { CliError } from "../src/errors";
import { EXIT_ERROR } from "@agentparty-mini/shared";

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; });

const cfg = { server: "", token: "ap_x", channel: "mock", name: "me", kind: "human" as const };

describe("who", () => {
  test("打印 hello.presence（不抛错即通过基本路径）", async () => {
    const m = startMockChannel({ self: "me", presence: [
      { name: "me", kind: "human", state: "working", note: null, last_seen: 0 },
      { name: "bot", kind: "agent", state: "waiting", note: null, last_seen: 0 },
    ] });
    stop = m.stop;
    await who([], { open: openChannel, cfg: { ...cfg, server: m.url } });
  });
});

describe("status", () => {
  test("非法 state 抛 EXIT_ERROR", async () => {
    await expect(status(["zzz"], { open: openChannel, cfg })).rejects.toBeInstanceOf(CliError);
  });
  test("合法 state：发 status 并等到 presence 回显返回", async () => {
    const m = startMockChannel({ self: "me", kind: "human" });
    stop = m.stop;
    await status(["blocked", "waiting on CI"], { open: openChannel, cfg: { ...cfg, server: m.url } });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cli && bun test test/format.test.ts test/who-status.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 format.ts**

```ts
import type { PresenceEntry, ServerFrame } from "@agentparty-mini/shared";

export function formatMsg(f: Extract<ServerFrame, { type: "msg" }>): string {
  const prefix = f.sender === "system" ? "**" : "";
  return `${prefix}[${f.sender}] ${f.body}`;
}

export function formatPresence(e: PresenceEntry): string {
  return `· ${e.name} is ${e.state}${e.note ? ` (${e.note})` : ""}`;
}

export function ndjson(f: ServerFrame): string {
  return JSON.stringify(f);
}
```

- [ ] **Step 4: 实现 who.ts 与 status.ts**

`cli/src/commands/who.ts`：

```ts
import { parseArgs } from "../args";
import { loadConfig, resolveChannel, type Config } from "../config";
import { formatPresence, ndjson } from "../format";
import { openChannel as defaultOpen } from "../ws";

interface Deps {
  open?: typeof defaultOpen;
  cfg?: Config;
}

export async function who(argv: string[], deps: Deps = {}): Promise<void> {
  const { flags } = parseArgs(argv, { bool: ["json"], value: ["channel", "server", "token"] });
  const cfg = deps.cfg ?? loadConfig();
  const open = deps.open ?? defaultOpen;
  const channel = resolveChannel(cfg, flags.channel as string | undefined);
  const ch = await open({ server: cfg.server, token: cfg.token }, channel);
  try {
    for (const e of ch.hello.presence) {
      process.stdout.write(`${flags.json ? ndjson({ type: "presence", entry: e }) : formatPresence(e)}\n`);
    }
  } finally {
    ch.close();
  }
}
```

`cli/src/commands/status.ts`：

```ts
import { EXIT_ERROR, type StatusState } from "@agentparty-mini/shared";
import { parseArgs } from "../args";
import { loadConfig, resolveChannel, type Config } from "../config";
import { CliError } from "../errors";
import { openChannel as defaultOpen } from "../ws";

interface Deps {
  open?: typeof defaultOpen;
  cfg?: Config;
}
const STATES: StatusState[] = ["working", "waiting", "blocked", "done"];

export async function status(argv: string[], deps: Deps = {}): Promise<void> {
  const { positionals, flags } = parseArgs(argv, { value: ["channel", "server", "token"] });
  const [state, note] = positionals;
  if (!STATES.includes(state as StatusState)) {
    throw new CliError(EXIT_ERROR, "usage: party status <working|waiting|blocked|done> [note]");
  }
  const cfg = deps.cfg ?? loadConfig();
  const open = deps.open ?? defaultOpen;
  const channel = resolveChannel(cfg, flags.channel as string | undefined);
  const ch = await open({ server: cfg.server, token: cfg.token }, channel);
  try {
    ch.send({ type: "send", kind: "status", state: state as StatusState, ...(note ? { note } : {}) });
    for await (const f of ch.frames) {
      if (f.type === "presence" && f.entry.name === ch.hello.self && f.entry.state === state) break;
      if (f.type === "error") throw new CliError(EXIT_ERROR, `status failed: ${f.message}`);
    }
    process.stdout.write(`status set: ${state}\n`);
  } finally {
    ch.close();
  }
}
```

在 `cli/src/index.ts` 接线（imports + dispatch）：

```ts
import { who } from "./commands/who";
import { status } from "./commands/status";
// dispatch:
    if (cmd === "who") { await who(rest); return EXIT_OK; }
    if (cmd === "status") { await status(rest); return EXIT_OK; }
```

- [ ] **Step 5: 运行确认通过**

Run: `cd cli && bun test && bunx tsc --noEmit`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add cli/src/format.ts cli/src/commands/who.ts cli/src/commands/status.ts cli/src/index.ts cli/test/format.test.ts cli/test/who-status.test.ts
git commit -m "feat(cli): format helpers, who and status commands over openChannel"
```

---

### Task 9: send 命令

**Files:**
- Create: `cli/src/commands/send.ts`
- Modify: `cli/src/index.ts`（接 send）
- Create: `cli/test/send.test.ts`

**Interfaces:**
- Produces：`async function send(argv, deps?): Promise<void>` — 组装 body（位置参数文本；`text === "-"` 从 stdin 读；每个 `--mention name` 前置拼 `@name ` 到 body 前）；`--reply-to` 转数字；`crypto.randomUUID()` 作 idem_key；openChannel → send message → 等自己的 `sent{idem_key}` → 打印 `sent #<seq>` → 推进游标（只增不减）→ close。
- `deps = { open?; cfg?; stdin?: () => Promise<string> }`（stdin 注入便于测试）。
- Consumes：Task 3 `loadConfig`/`resolveChannel`/`loadCursor`/`saveCursor`、Task 7 `openChannel`。

- [ ] **Step 1: 写失败测试**

`cli/test/send.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { send } from "../src/commands/send";
import { openChannel } from "../src/ws";
import { startMockChannel } from "./mock-channel";
import { loadCursor } from "../src/config";

let dir: string;
let stop: (() => void) | null = null;
const orig = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "party-send-"));
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(() => {
  orig === undefined ? delete process.env.XDG_CONFIG_HOME : (process.env.XDG_CONFIG_HOME = orig);
  stop?.(); stop = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("send", () => {
  test("发消息收到 sent 并推进游标", async () => {
    const m = startMockChannel({ self: "me" });
    stop = m.stop;
    const cfg = { server: m.url, token: "ap_me", channel: "mock", name: "me", kind: "human" as const };
    await send(["hello world"], { open: openChannel, cfg });
    // mock 首条消息 seq=1，游标应推进到 1
    expect(loadCursor(m.url, "mock")).toBe(1);
  });

  test("--mention 前置拼到 body（服务端解析，mock 只回显 body）", async () => {
    const m = startMockChannel({ self: "me" });
    stop = m.stop;
    const cfg = { server: m.url, token: "ap_me", channel: "mock", name: "me", kind: "human" as const };
    let capturedBody = "";
    const open: typeof openChannel = async (c, ch, o) => {
      const real = await openChannel(c, ch, o);
      const origSend = real.send;
      real.send = (f) => { if (f.kind === "message") capturedBody = f.body; origSend(f); };
      return real;
    };
    await send(["please review", "--mention", "bob", "--mention", "carol"], { open, cfg });
    expect(capturedBody).toContain("@bob");
    expect(capturedBody).toContain("@carol");
    expect(capturedBody).toContain("please review");
  });

  test("text 为 - 从注入的 stdin 读", async () => {
    const m = startMockChannel({ self: "me" });
    stop = m.stop;
    const cfg = { server: m.url, token: "ap_me", channel: "mock", name: "me", kind: "human" as const };
    let captured = "";
    const open: typeof openChannel = async (c, ch, o) => {
      const real = await openChannel(c, ch, o);
      const origSend = real.send;
      real.send = (f) => { if (f.kind === "message") captured = f.body; origSend(f); };
      return real;
    };
    await send(["-"], { open, cfg, stdin: async () => "piped body\n" });
    expect(captured).toBe("piped body");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cli && bun test test/send.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`cli/src/commands/send.ts`：

```ts
import { EXIT_ERROR } from "@agentparty-mini/shared";
import { parseArgs } from "../args";
import { loadConfig, loadCursor, resolveChannel, saveCursor, type Config } from "../config";
import { CliError } from "../errors";
import { openChannel as defaultOpen } from "../ws";

interface Deps {
  open?: typeof defaultOpen;
  cfg?: Config;
  stdin?: () => Promise<string>;
}

async function readStdin(): Promise<string> {
  return await Bun.stdin.text();
}

export async function send(argv: string[], deps: Deps = {}): Promise<void> {
  const { positionals, flags } = parseArgs(argv, {
    value: ["reply-to", "channel", "server", "token"],
    multi: ["mention"],
  });
  let text = positionals.join(" ");
  if (text === "-") text = (await (deps.stdin ?? readStdin)()).trimEnd();
  if (!text) throw new CliError(EXIT_ERROR, "nothing to send (provide text or pipe via '-')");
  const mentions = (flags.mention as string[] | undefined) ?? [];
  const body = [...mentions.map((m) => `@${m}`), text].join(" ");
  let replyTo: number | undefined;
  if (typeof flags["reply-to"] === "string") {
    replyTo = Number(flags["reply-to"]);
    if (!Number.isInteger(replyTo) || replyTo < 1) throw new CliError(EXIT_ERROR, "--reply-to must be a positive integer");
  }
  const cfg = deps.cfg ?? loadConfig();
  const open = deps.open ?? defaultOpen;
  const channel = resolveChannel(cfg, flags.channel as string | undefined);
  const idem = crypto.randomUUID();
  const ch = await open({ server: cfg.server, token: cfg.token }, channel);
  try {
    ch.send({ type: "send", kind: "message", body, idem_key: idem, ...(replyTo ? { reply_to: replyTo } : {}) });
    for await (const f of ch.frames) {
      if (f.type === "sent" && f.idem_key === idem) {
        process.stdout.write(`sent #${f.seq}\n`);
        if (f.seq > loadCursor(cfg.server, channel)) saveCursor(cfg.server, channel, f.seq);
        return;
      }
      if (f.type === "error") throw new CliError(EXIT_ERROR, `send failed: ${f.message}`);
    }
    throw new CliError(EXIT_ERROR, "connection closed before send was acknowledged");
  } finally {
    ch.close();
  }
}
```

在 `cli/src/index.ts` 接线：`import { send } from "./commands/send";` + dispatch `if (cmd === "send") { await send(rest); return EXIT_OK; }`。

- [ ] **Step 4: 运行确认通过**

Run: `cd cli && bun test && bunx tsc --noEmit`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/send.ts cli/src/index.ts cli/test/send.test.ts
git commit -m "feat(cli): send command waits for sent ack and advances cursor"
```

---

### Task 10: watch 命令 + README + 全仓 check

**Files:**
- Create: `cli/src/commands/watch.ts`
- Modify: `cli/src/index.ts`（接 watch）
- Modify: `README.md`（补 CLI 用法）
- Create: `cli/test/watch.test.ts`

**Interfaces:**
- Produces：`async function watch(argv, deps?): Promise<void>` — 读游标 `after` → openChannel({after, reconnect: !once}) → 遍历 frames：`msg` 渲染（`--json`→ndjson，否则 formatMsg；`--mentions-only` 只输出 body 含 `@<self>` 的，但**游标对每个 msg 都推进**）；`presence` 渲染（`--mentions-only` 下不输出）；`--once` 在第一条命中后 return。终局 error → 抛 mapped CliError；瞬时 error → 常驻模式打印到 stderr 后继续，`--once` 模式抛 mapped CliError。
- `deps = { open?; cfg? }`。
- Consumes：Task 3 游标、Task 7 openChannel、Task 8 format。

- [ ] **Step 1: 写失败测试**

`cli/test/watch.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watch } from "../src/commands/watch";
import { openChannel } from "../src/ws";
import { startMockChannel } from "./mock-channel";
import { loadCursor } from "../src/config";
import { CliError } from "../src/errors";
import { EXIT_ARCHIVED } from "@agentparty-mini/shared";

let dir: string;
let stop: (() => void) | null = null;
const orig = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "party-watch-"));
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(() => {
  orig === undefined ? delete process.env.XDG_CONFIG_HOME : (process.env.XDG_CONFIG_HOME = orig);
  stop?.(); stop = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("watch", () => {
  test("--once：补拉历史，输出并推进游标后退出", async () => {
    const m = startMockChannel({ self: "me", history: [
      { seq: 1, sender: "x", body: "one" },
      { seq: 2, sender: "y", body: "two" },
    ] });
    stop = m.stop;
    const cfg = { server: m.url, token: "ap_me", channel: "mock", name: "me", kind: "human" as const };
    await watch(["--once"], { open: openChannel, cfg });
    // --once 收到第一条 msg（seq 1）即退，游标推进到 1
    expect(loadCursor(m.url, "mock")).toBe(1);
  });

  test("连接即 archived → 抛 CliError(EXIT_ARCHIVED)", async () => {
    const m = startMockChannel({ self: "me", connectError: { code: "archived", message: "channel is archived" } });
    stop = m.stop;
    const cfg = { server: m.url, token: "ap_me", channel: "mock", name: "me", kind: "human" as const };
    try {
      await watch(["--once"], { open: openChannel, cfg });
      throw new Error("should throw");
    } catch (e) {
      expect((e as CliError).code).toBe(EXIT_ARCHIVED);
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cli && bun test test/watch.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`cli/src/commands/watch.ts`：

```ts
import { EXIT_AUTH, EXIT_ARCHIVED, EXIT_ERROR, EXIT_LOOP_GUARD, EXIT_RATE_LIMITED, type ErrorCode } from "@agentparty-mini/shared";
import { parseArgs } from "../args";
import { loadConfig, loadCursor, resolveChannel, saveCursor, type Config } from "../config";
import { CliError } from "../errors";
import { formatMsg, formatPresence, ndjson } from "../format";
import { openChannel as defaultOpen } from "../ws";

interface Deps {
  open?: typeof defaultOpen;
  cfg?: Config;
}

function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case "auth": return EXIT_AUTH;
    case "archived": return EXIT_ARCHIVED;
    case "loop_guard": return EXIT_LOOP_GUARD;
    case "rate_limited": return EXIT_RATE_LIMITED;
    default: return EXIT_ERROR;
  }
}

export async function watch(argv: string[], deps: Deps = {}): Promise<void> {
  const { flags } = parseArgs(argv, {
    bool: ["mentions-only", "once", "follow", "json"],
    value: ["channel", "server", "token"],
  });
  const cfg = deps.cfg ?? loadConfig();
  const open = deps.open ?? defaultOpen;
  const channel = resolveChannel(cfg, flags.channel as string | undefined);
  const once = flags.once === true;
  const mentionsOnly = flags["mentions-only"] === true;
  const json = flags.json === true;
  const after = loadCursor(cfg.server, channel);
  const ch = await open({ server: cfg.server, token: cfg.token }, channel, { after, reconnect: !once });
  const selfTag = `@${ch.hello.self}`;
  try {
    for await (const f of ch.frames) {
      if (f.type === "msg") {
        const hit = !mentionsOnly || f.body.includes(selfTag);
        if (hit) process.stdout.write(`${json ? ndjson(f) : formatMsg(f)}\n`);
        if (f.seq > loadCursor(cfg.server, channel)) saveCursor(cfg.server, channel, f.seq);
        if (once && hit) return;
      } else if (f.type === "presence") {
        if (!mentionsOnly) process.stdout.write(`${json ? ndjson(f) : formatPresence(f.entry)}\n`);
      } else if (f.type === "error") {
        const code = exitCodeFor(f.code);
        if (once || f.code === "auth" || f.code === "archived") {
          throw new CliError(code, f.message);
        }
        process.stderr.write(`! ${f.code}: ${f.message}\n`);
      }
    }
  } finally {
    ch.close();
  }
}
```

在 `cli/src/index.ts` 接线：`import { watch } from "./commands/watch";` + dispatch `if (cmd === "watch") { await watch(rest); return EXIT_OK; }`。

- [ ] **Step 4: 运行确认通过 + 全仓 check**

Run: `cd cli && bun test && bunx tsc --noEmit && cd .. && bun run check`
Expected: cli 全绿；全仓 `check`（shared + worker + cli）全绿。

- [ ] **Step 5: 更新 README**

在 `README.md` 末尾追加 CLI 章节：

````markdown
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
```

退出码：0 成功、1 通用失败、3 认证失败（token 无效/吊销）、4 被 loop guard 熔断、5 频道已归档、9 被限速。
````

- [ ] **Step 6: Commit**

```bash
git add cli/src/commands/watch.ts cli/src/index.ts cli/test/watch.test.ts README.md
git commit -m "feat(cli): watch command with catch-up, mentions filter, --json, exit codes; README"
```

---

## Self-Review 记录

- **Spec 覆盖**：设计文档 §2（cli 结构+配置+游标+init 回填）→ Task 1/3/5；§3（openChannel 契约、等 hello、帧迭代、终局/瞬时、仅 watch 重连、idem_key）→ Task 7/9；§4（9 个命令逐条语义 + 完成信号）→ Task 3/5/6/8/9/10；§5（退出码、CliError 映射、测试、构建、根 check 接线）→ Task 1/4/10。均有对应任务。
- **占位符**：无 TBD/TODO；每个代码步骤给完整代码与命令。
- **类型一致性**：`CliError(code,message)`（T1 定义，全程消费）、`Config`/`resolveChannel`/`loadCursor`/`saveCursor`（T3 定义，T8/9/10 消费）、`restFetch(path,opts,fetchImpl?)` 与 7 个便捷封装的可注入 `f?`（T4 定义，T5 追加 getMe 的 f、T6 统一补齐并消费）、`openChannel(cfg,channel,opts)`/`Channel`/`HelloFrame`/`OpenOpts`（T7 定义，T8/9/10 消费）、`formatMsg`/`formatPresence`/`ndjson`（T8 定义，T10 消费）、mock helper `startMockChannel`（T7 定义，T8/9/10 复用）均一致。
- **执行期风险（实现时验证并记录）**：
  1. `@types/bun` 的 tsconfig `types` 名可能需从 `["bun"]` 调整（同 worker Task 3 的版本适配），Task 1 Step 6 已授权调整。
  2. `openChannel` 的 `swallowHello` 变量在最终逻辑里冗余（hello 分支无条件不入队），保留仅表意；若 typecheck 报未使用可删。
  3. Bun `WebSocket` 事件对象类型（`MessageEvent`）在 Bun 类型下应可用；若不可用改用 `(ev: any)` 并保持解析逻辑。
  4. reconnect 用例依赖 mock `dropFirstConnection` 的时序；若偶发 flaky，收紧 mock（仅第一连接 drop）而非放宽断言。
- **已知设计取舍（已在 spec 记录，非缺陷）**：`who` 会让自己短暂上线/下线；`send` 推进游标到自己的 sent seq（只增），可能跳过期间未看的消息——与参考实现一致，符合 spec。



