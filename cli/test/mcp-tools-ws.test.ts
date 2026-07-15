import { afterEach, describe, expect, test } from "bun:test";
import { partySend, partyStatus, partyWho, partyRead, type ToolCtx } from "../src/mcp/tools";
import { openChannel } from "../src/ws";
import { startMockChannel } from "./mock-channel";

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; });

const baseCtx = (server: string): ToolCtx => ({ server, token: "ap_x", defaultChannel: "mock" });

describe("party_send", () => {
  test("发消息，拼 @mention，回 sent #seq", async () => {
    const m = startMockChannel({ self: "me" });
    stop = m.stop;
    const r = await partySend(baseCtx(m.url), { text: "hi", mentions: ["bot"] }, { open: openChannel });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe("sent #1");
    expect(m.received[0]).toMatchObject({ kind: "message", body: "@bot hi" });
  });
  test("缺 text → 工具错误，不抛", async () => {
    const r = await partySend(baseCtx("http://unused"), {}, { open: openChannel });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("text is required");
  });
  test("reply_to 非正整数 → 工具错误", async () => {
    const r = await partySend(baseCtx("http://unused"), { text: "x", reply_to: 0 }, { open: openChannel });
    expect(r.isError).toBe(true);
  });
});

describe("party_status", () => {
  test("合法 state 等 presence 回显", async () => {
    const m = startMockChannel({ self: "me" });
    stop = m.stop;
    const r = await partyStatus(baseCtx(m.url), { state: "blocked", note: "on CI" }, { open: openChannel });
    expect(r.content[0].text).toBe("status set: blocked");
  });
  test("非法 state → 工具错误", async () => {
    const r = await partyStatus(baseCtx("http://unused"), { state: "zzz" }, { open: openChannel });
    expect(r.isError).toBe(true);
  });
});

describe("party_who", () => {
  test("回 hello.presence 的 JSON", async () => {
    const m = startMockChannel({ self: "me", presence: [
      { name: "me", kind: "human", state: "working", note: null, last_seen: 0 },
      { name: "bot", kind: "agent", state: "waiting", note: null, last_seen: 0 },
    ] });
    stop = m.stop;
    const r = await partyWho(baseCtx(m.url), {}, { open: openChannel });
    const arr = JSON.parse(r.content[0].text);
    expect(arr).toHaveLength(2);
    expect(arr[0]).toMatchObject({ name: "me", state: "working" });
  });
});

describe("party_read", () => {
  test("从游标读增量，推进持久游标", async () => {
    const m = startMockChannel({ self: "me", history: [
      { seq: 1, sender: "a", body: "one" },
      { seq: 2, sender: "b", body: "two" },
    ] });
    stop = m.stop;
    const saved: Record<string, number> = {};
    const deps = {
      open: openChannel,
      loadCursor: () => 0,
      saveCursor: (_s: string, _c: string, seq: number) => { saved.v = seq; },
    };
    const r = await partyRead(baseCtx(m.url), {}, deps);
    const out = JSON.parse(r.content[0].text);
    expect(out.messages.map((x: any) => x.seq)).toEqual([1, 2]);
    expect(out.cursor).toBe(2);
    expect(saved.v).toBe(2); // 持久游标推进到 2
  });
  test("已追平（cursor>=seq_high）立即返回空，不阻塞", async () => {
    const m = startMockChannel({ self: "me", history: [{ seq: 1, sender: "a", body: "one" }] });
    stop = m.stop;
    let savedCalled = false;
    const r = await partyRead(baseCtx(m.url), {}, {
      open: openChannel, loadCursor: () => 1, saveCursor: () => { savedCalled = true; },
    });
    const out = JSON.parse(r.content[0].text);
    expect(out.messages).toEqual([]);
    expect(out.cursor).toBe(1);
    expect(savedCalled).toBe(false); // 无新消息不写游标
  });
  test("after 参数走一次性回看，不改持久游标", async () => {
    const m = startMockChannel({ self: "me", history: [
      { seq: 1, sender: "a", body: "one" },
      { seq: 2, sender: "b", body: "two" },
    ] });
    stop = m.stop;
    let savedCalled = false;
    const r = await partyRead(baseCtx(m.url), { after: 1 }, {
      open: openChannel, loadCursor: () => 999, saveCursor: () => { savedCalled = true; },
    });
    const out = JSON.parse(r.content[0].text);
    expect(out.messages.map((x: any) => x.seq)).toEqual([2]);
    expect(savedCalled).toBe(false); // 一次性回看不落盘
  });
});
