import { describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "@agentparty-mini/shared";
import { openChannel, wsUrl } from "./channel";

class FakeWS {
  static instances: FakeWS[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(s: string) { this.sent.push(s); }
  close() { this.closed = true; this.onclose?.(); }
  emit(frame: ServerFrame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

describe("wsUrl", () => {
  it("http→ws, https→wss, carries token+after", () => {
    expect(wsUrl("http://h", "c", "t", 3)).toBe("ws://h/api/channels/c/ws?token=t&after=3");
    expect(wsUrl("https://h", "c", "t", 0)).toBe("wss://h/api/channels/c/ws?token=t&after=0");
  });
});

describe("openChannel", () => {
  it("delivers frames to onFrame", () => {
    FakeWS.instances = [];
    const frames: ServerFrame[] = [];
    openChannel({ server: "http://h", token: "t", slug: "c", after: 0, onFrame: (f) => frames.push(f), wsFactory: (u) => new FakeWS(u) as any });
    const ws = FakeWS.instances[0];
    ws.onopen?.();
    ws.emit({ type: "hello", channel: "c", self: "me", seq_high: 0, mode: "normal", guard: 30, presence: [] });
    ws.emit({ type: "msg", seq: 1, ts: 0, sender: "a", sender_kind: "human", body: "hi", mentions: [], reply_to: null });
    expect(frames.map((f) => f.type)).toEqual(["hello", "msg"]);
  });

  it("terminal error (auth) does not reconnect", () => {
    FakeWS.instances = [];
    openChannel({ server: "http://h", token: "t", slug: "c", after: 0, onFrame: () => {}, reconnectDelaysMs: [1], wsFactory: (u) => new FakeWS(u) as any });
    const ws = FakeWS.instances[0];
    ws.onopen?.();
    ws.emit({ type: "hello", channel: "c", self: "me", seq_high: 0, mode: "normal", guard: 30, presence: [] });
    ws.emit({ type: "error", code: "auth", message: "revoked" });
    expect(FakeWS.instances).toHaveLength(1); // 没有第二次连接
  });

  it("plain close reconnects with after=last seq", async () => {
    FakeWS.instances = [];
    openChannel({ server: "http://h", token: "t", slug: "c", after: 0, onFrame: () => {}, reconnectDelaysMs: [1], wsFactory: (u) => new FakeWS(u) as any });
    const ws = FakeWS.instances[0];
    ws.onopen?.();
    ws.emit({ type: "hello", channel: "c", self: "me", seq_high: 0, mode: "normal", guard: 30, presence: [] });
    ws.emit({ type: "msg", seq: 4, ts: 0, sender: "a", sender_kind: "human", body: "x", mentions: [], reply_to: null });
    ws.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(FakeWS.instances).toHaveLength(2);
    expect(FakeWS.instances[1].url).toContain("after=4");
  });
});
