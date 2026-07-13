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
