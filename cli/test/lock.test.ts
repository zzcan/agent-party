import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_ALREADY_SERVING } from "@agentparty-mini/shared";
import { CliError } from "../src/errors";
import { acquireLock, lockPath } from "../src/lock";

let dir: string;
const orig = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "party-lock-"));
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(() => {
  orig === undefined ? delete process.env.XDG_CONFIG_HOME : (process.env.XDG_CONFIG_HOME = orig);
  rmSync(dir, { recursive: true, force: true });
});

describe("acquireLock", () => {
  test("获取后锁文件存在，释放后消失", () => {
    const release = acquireLock("http://h:1", "c");
    expect(existsSync(lockPath("http://h:1", "c"))).toBe(true);
    release();
    expect(existsSync(lockPath("http://h:1", "c"))).toBe(false);
  });

  test("持有者存活时二次获取抛 EXIT_ALREADY_SERVING", () => {
    const release = acquireLock("http://h:1", "c"); // 持有者 = 本进程，必然存活
    try {
      expect(() => acquireLock("http://h:1", "c")).toThrow(CliError);
      try {
        acquireLock("http://h:1", "c");
      } catch (e) {
        expect((e as CliError).code).toBe(EXIT_ALREADY_SERVING);
      }
    } finally {
      release();
    }
  });

  test("陈锁（持有者已死）被接管", async () => {
    const proc = Bun.spawn(["sh", "-c", "exit 0"]);
    await proc.exited; // 该 PID 已死
    const p = lockPath("http://h:1", "c");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(proc.pid));
    const release = acquireLock("http://h:1", "c");
    expect(existsSync(p)).toBe(true);
    release();
  });

  test("锁按 (host, channel) 隔离", () => {
    const r1 = acquireLock("http://h:1", "a");
    const r2 = acquireLock("http://h:1", "b"); // 不同频道互不影响
    r1();
    r2();
  });
});
