import { describe, expect, test } from "bun:test";
import { buildWakeContext, RECENT_BODY_MAX, RECENT_MAX, shouldWake, type MsgFrame } from "../src/commands/serve";

function msg(over: Partial<MsgFrame>): MsgFrame {
  return {
    type: "msg",
    seq: 1,
    ts: 100,
    sender: "alice",
    sender_kind: "human",
    body: "hi",
    mentions: [],
    reply_to: null,
    ...over,
  };
}

describe("shouldWake", () => {
  test("@自己 且非自己发 → 唤醒", () => {
    expect(shouldWake(msg({ mentions: ["bot"] }), "bot")).toBe(true);
  });
  test("没 @ 自己 → 不唤醒", () => {
    expect(shouldWake(msg({ mentions: ["other"] }), "bot")).toBe(false);
    expect(shouldWake(msg({ mentions: [] }), "bot")).toBe(false);
  });
  test("自己发的即使 @ 自己 → 不唤醒（防自激励）", () => {
    expect(shouldWake(msg({ sender: "bot", mentions: ["bot"] }), "bot")).toBe(false);
  });
  test("system 消息（无 mentions）→ 不唤醒", () => {
    expect(shouldWake(msg({ sender: "system", body: "loop guard tripped" }), "bot")).toBe(false);
  });
});

describe("buildWakeContext", () => {
  test("字段齐全，reply_to = seq", () => {
    const f = msg({ seq: 12, mentions: ["bot"], body: "@bot deploy" });
    const ctx = buildWakeContext(f, "bot", "deploys", []);
    expect(ctx).toEqual({
      channel: "deploys",
      seq: 12,
      sender: "alice",
      sender_kind: "human",
      body: "@bot deploy",
      mentions: ["bot"],
      reply_to: 12,
      self: "bot",
      recent: [],
    });
  });
  test("recent 保序、封顶 20 条、正文截 400 字", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      msg({ seq: i + 1, body: i === 24 ? "x".repeat(500) : `m${i + 1}` }),
    );
    const ctx = buildWakeContext(msg({ seq: 99 }), "bot", "c", many);
    expect(ctx.recent.length).toBe(RECENT_MAX);
    expect(ctx.recent[0].seq).toBe(6); // 掐头留最近 20
    expect(ctx.recent[19].body.length).toBe(RECENT_BODY_MAX);
  });
});
