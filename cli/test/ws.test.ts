import { afterEach, describe, expect, test } from "bun:test";
import { openChannel, toWsUrl } from "../src/ws";
import { startMockChannel } from "./mock-channel";
import { CliError } from "../src/errors";
import { EXIT_ARCHIVED } from "@agentparty-mini/shared";

describe("toWsUrl", () => {
  test("http→ws，after 有定义就带上（含 0），undefined 时省略", () => {
    // 全新观察者游标为 0：必须带 after=0，否则服务端「缺 after=不补拉」会吞掉全部历史
    expect(toWsUrl("http://h", "c", "ap_t", 0)).toBe("ws://h/api/channels/c/ws?token=ap_t&after=0");
    expect(toWsUrl("https://h", "c", "ap_t", 5)).toBe("wss://h/api/channels/c/ws?token=ap_t&after=5");
    expect(toWsUrl("http://h", "c", "ap_t")).toBe("ws://h/api/channels/c/ws?token=ap_t");
  });
});

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

  test("after=0 全新观察者补拉全部历史（缺 after 参数则不补拉，对齐真服务端）", async () => {
    const history = [
      { seq: 1, sender: "x", body: "one" },
      { seq: 2, sender: "y", body: "two" },
    ];
    // 传 after:0 → toWsUrl 带 after=0 → mock 补拉 seq>0
    const withCursor = startMockChannel({ self: "z", history });
    stopFn = withCursor.stop;
    const ch0 = await openChannel({ server: withCursor.url, token: "ap_z" }, "mock", { after: 0 });
    const seqs: number[] = [];
    for await (const f of ch0.frames) {
      if (f.type === "msg") {
        seqs.push(f.seq);
        if (seqs.length === 2) break;
      }
    }
    expect(seqs).toEqual([1, 2]);
    ch0.close();
    withCursor.stop();
    stopFn = null;

    // 不传 after（who/status/send 的路径）→ 省略参数 → mock 不补拉
    const noCursor = startMockChannel({ self: "z", history });
    stopFn = noCursor.stop;
    const ch1 = await openChannel({ server: noCursor.url, token: "ap_z" }, "mock");
    let sawMsg = false;
    ch1.send({ type: "send", kind: "message", body: "live", idem_key: "k-live" });
    for await (const f of ch1.frames) {
      if (f.type === "sent") break; // 收到自己的 sent 说明连接正常，且此前没有历史 msg 涌入
      if (f.type === "msg") sawMsg = true;
    }
    expect(sawMsg).toBe(false);
    ch1.close();
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
