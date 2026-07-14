import { describe, expect, it } from "vitest";
import type { ServerFrame } from "@agentparty-mini/shared";
import { initialState, reduce } from "./frames";

const hello: ServerFrame = { type: "hello", channel: "c", self: "me", seq_high: 5, mode: "normal", guard: 30, presence: [{ name: "me", kind: "human", state: "waiting", note: null, last_seen: 0 }] };
function msg(seq: number, over: Partial<Extract<ServerFrame, { type: "msg" }>> = {}): ServerFrame {
  return { type: "msg", seq, ts: 0, sender: "a", sender_kind: "human", body: `m${seq}`, mentions: [], reply_to: null, ...over };
}

describe("frames.reduce", () => {
  it("hello initializes self/seqHigh/presence", () => {
    const s = reduce(initialState(), hello);
    expect(s.self).toBe("me");
    expect(s.seqHigh).toBe(5);
    expect(s.presence).toHaveLength(1);
  });
  it("msg appends and dedups by seq", () => {
    let s = reduce(initialState(), hello);
    s = reduce(s, msg(6));
    s = reduce(s, msg(6)); // 重复 seq 不追加
    s = reduce(s, msg(7));
    expect(s.messages.map((m) => m.seq)).toEqual([6, 7]);
  });
  it("presence upserts by name", () => {
    let s = reduce(initialState(), hello);
    s = reduce(s, { type: "presence", entry: { name: "me", kind: "human", state: "working", note: "x", last_seen: 1 } });
    expect(s.presence).toHaveLength(1);
    expect(s.presence[0].state).toBe("working");
    s = reduce(s, { type: "presence", entry: { name: "bob", kind: "agent", state: "waiting", note: null, last_seen: 2 } });
    expect(s.presence.map((p) => p.name).sort()).toEqual(["bob", "me"]);
  });
  it("sent/error do not mutate messages", () => {
    let s = reduce(initialState(), hello);
    const before = s.messages.length;
    s = reduce(s, { type: "sent", seq: 6, idem_key: "k" });
    s = reduce(s, { type: "error", code: "rate_limited", message: "slow" });
    expect(s.messages.length).toBe(before);
  });
});
