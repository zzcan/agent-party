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

// captures everything written via process.stdout.write for the duration of a run
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

describe("who", () => {
  test("打印 hello.presence（不抛错即通过基本路径）", async () => {
    const m = startMockChannel({ self: "me", presence: [
      { name: "me", kind: "human", state: "working", note: null, last_seen: 0 },
      { name: "bot", kind: "agent", state: "waiting", note: null, last_seen: 0 },
    ] });
    stop = m.stop;
    const out = await captureStdout(() => who([], { open: openChannel, cfg: { ...cfg, server: m.url } }));
    expect(out).toContain("me");
    expect(out).toContain("working");
    expect(out).toContain("bot");
    expect(out).toContain("waiting");
    expect(out).toContain("· me is working");
    expect(out).toContain("· bot is waiting");
  });
});

describe("status", () => {
  test("非法 state 抛 EXIT_ERROR", async () => {
    await expect(status(["zzz"], { open: openChannel, cfg })).rejects.toBeInstanceOf(CliError);
  });
  test("合法 state：发 status 并等到 presence 回显返回", async () => {
    const m = startMockChannel({ self: "me", kind: "human" });
    stop = m.stop;
    const out = await captureStdout(() => status(["blocked", "waiting on CI"], { open: openChannel, cfg: { ...cfg, server: m.url } }));
    expect(out).toContain("status set: blocked");
  });
});
