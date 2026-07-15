import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearInflight, configPath, cursorPath, inflightPath, loadConfig, loadCursor, loadInflight, mcpCursorPath, loadMcpCursor, saveMcpCursor, resolveChannel, saveConfig, saveCursor, saveInflight, type Config } from "../src/config";
import { CliError } from "../src/errors";
import { main } from "../src/index";

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
  test("MCP 游标：独立命名空间，缺文件为 0，与普通游标隔离", () => {
    expect(loadMcpCursor("https://s.example", "design")).toBe(0);
    saveMcpCursor("https://s.example", "design", 7);
    expect(loadMcpCursor("https://s.example", "design")).toBe(7);
    // 与 watch/serve 的普通游标互不干扰
    expect(loadCursor("https://s.example", "design")).toBe(0);
    // 路径落在 cursors-mcp/ 目录
    expect(mcpCursorPath("https://s.example", "design")).toContain("cursors-mcp");
    expect(mcpCursorPath("https://s.example", "design")).toContain("s.example__design");
  });
  test("resolveChannel：override 优先", () => {
    expect(resolveChannel(sample)).toBe("design");
    expect(resolveChannel(sample, "hotfix")).toBe("hotfix");
  });
});

describe("whoami dispatch", () => {
  test("已 init → whoami 返回 0", async () => {
    saveConfig(sample);
    expect(await main(["whoami"])).toBe(0);
  });
  test("未 init → whoami 返回 EXIT_ERROR", async () => {
    expect(await main(["whoami"])).toBe(1);
  });
});

describe("inflight marker", () => {
  test("默认 null；save 后可读回；clear 后回 null；clear 不存在的不炸", () => {
    expect(loadInflight("http://h:1", "c")).toBeNull();
    saveInflight("http://h:1", "c", 42);
    expect(loadInflight("http://h:1", "c")).toBe(42);
    clearInflight("http://h:1", "c");
    expect(loadInflight("http://h:1", "c")).toBeNull();
    clearInflight("http://h:1", "c"); // 幂等
  });
  test("坏内容视为无标记", () => {
    saveInflight("http://h:1", "c", 7);
    writeFileSync(inflightPath("http://h:1", "c"), "garbage");
    expect(loadInflight("http://h:1", "c")).toBeNull();
  });
});
