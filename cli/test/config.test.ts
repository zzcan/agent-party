import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, cursorPath, loadConfig, loadCursor, resolveChannel, saveConfig, saveCursor, type Config } from "../src/config";
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
