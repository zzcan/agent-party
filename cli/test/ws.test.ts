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
