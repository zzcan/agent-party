// 单实例锁：防同一 (server host, channel) 双开 serve 互踩游标（设计 §8）。
// pidfile + kill(pid, 0) 探活；不做 flock、不做跨机租约。
import { EXIT_ALREADY_SERVING } from "@agentparty-mini/shared";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, hostOf } from "./config";
import { CliError } from "./errors";

export function lockPath(server: string, channel: string): string {
  return join(configDir(), "locks", `${hostOf(server)}__${channel}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程在但不属于我们，也算活
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireLock(server: string, channel: string, pid: number = process.pid): () => void {
  mkdirSync(join(configDir(), "locks"), { recursive: true });
  const p = lockPath(server, channel);
  const tryWrite = (): boolean => {
    try {
      writeFileSync(p, String(pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  };
  if (!tryWrite()) {
    const holder = Number(readFileSync(p, "utf8").trim());
    if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
      throw new CliError(EXIT_ALREADY_SERVING, `another serve is already running for this channel (pid ${holder})`);
    }
    // 陈锁：持有者已死，接管
    try {
      unlinkSync(p);
    } catch {
      /* 竞争窗口：对方刚好清理了 */
    }
    if (!tryWrite()) {
      throw new CliError(EXIT_ALREADY_SERVING, "lost lock takeover race; retry");
    }
  }
  return () => {
    try {
      unlinkSync(p);
    } catch {
      /* 已清理 */
    }
  };
}
