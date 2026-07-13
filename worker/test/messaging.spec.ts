import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintToken } from "./tokens.spec";
import { WsClient } from "./ws";

async function createChannel(slug: string, token: string) {
  const res = await SELF.fetch("https://x/api/channels", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  if (res.status !== 201) throw new Error(`create channel failed: ${res.status}`);
}

function msgFrame(body: string, idem: string, reply_to?: number) {
  return { type: "send", kind: "message", body, idem_key: idem, ...(reply_to ? { reply_to } : {}) };
}

describe("messaging", () => {
  it("发送方先收 sent 再收自己的 msg，其他人收到 msg，mentions 解析", async () => {
    const ta = await mintToken("t7-alice", "human");
    const tb = await mintToken("t7-bob", "agent");
    await createChannel("t7-room", ta);
    const a = await WsClient.connect("t7-room", ta);
    const b = await WsClient.connect("t7-room", tb);
    await a.expect((f) => f.type === "hello");
    await b.expect((f) => f.type === "hello");

    a.send(msgFrame("hi @t7-bob please review", "k1"));
    const sent = await a.expect((f) => f.type === "sent");
    if (sent.type !== "sent") throw new Error("unreachable");
    expect(sent.seq).toBe(1);
    // 消费式 expect 保证顺序：sent 之后才轮到自己的 msg 回声
    const echo = await a.expect((f) => f.type === "msg");
    if (echo.type !== "msg") throw new Error("unreachable");
    expect(echo.seq).toBe(1);
    expect(echo.sender).toBe("t7-alice");
    expect(echo.sender_kind).toBe("human");
    expect(echo.mentions).toEqual(["t7-bob"]);

    const got = await b.expect((f) => f.type === "msg" && f.seq === 1);
    if (got.type !== "msg") throw new Error("unreachable");
    expect(got.body).toBe("hi @t7-bob please review");
    a.close();
    b.close();
  });

  it("reply_to 原样回传，seq 递增", async () => {
    const t = await mintToken("t7-carol", "human");
    await createChannel("t7-reply", t);
    const c = await WsClient.connect("t7-reply", t);
    await c.expect((f) => f.type === "hello");
    c.send(msgFrame("first", "r1"));
    await c.expect((f) => f.type === "sent" && f.seq === 1);
    c.send(msgFrame("second", "r2", 1));
    const m = await c.expect((f) => f.type === "msg" && f.seq === 2);
    if (m.type !== "msg") throw new Error("unreachable");
    expect(m.reply_to).toBe(1);
    c.close();
  });

  it("同 idem_key 重发只回 sent 同 seq，不广播第二条", async () => {
    const ta = await mintToken("t7-dave", "human");
    const tb = await mintToken("t7-eve", "human");
    await createChannel("t7-idem", ta);
    const a = await WsClient.connect("t7-idem", ta);
    const b = await WsClient.connect("t7-idem", tb);
    await a.expect((f) => f.type === "hello");
    await b.expect((f) => f.type === "hello");
    a.send(msgFrame("once", "dup-key"));
    await a.expect((f) => f.type === "sent" && f.seq === 1);
    a.send(msgFrame("once", "dup-key"));
    const again = await a.expect((f) => f.type === "sent");
    if (again.type !== "sent") throw new Error("unreachable");
    expect(again.seq).toBe(1);
    // b 只该收到一条 msg；发一条哨兵确认没有第二条 "once"
    a.send(msgFrame("sentinel", "sk"));
    await b.expect((f) => f.type === "msg" && f.body === "sentinel");
    expect(b.frames.filter((f) => f.type === "msg" && (f as { body?: string }).body === "once").length).toBe(1);
    a.close();
    b.close();
  });

  it("status 帧更新 presence 并广播，不产生 msg", async () => {
    const ta = await mintToken("t7-fred", "agent");
    const tb = await mintToken("t7-gina", "human");
    await createChannel("t7-status", ta);
    const a = await WsClient.connect("t7-status", ta);
    const b = await WsClient.connect("t7-status", tb);
    await a.expect((f) => f.type === "hello");
    await b.expect((f) => f.type === "hello");
    a.send({ type: "send", kind: "status", state: "blocked", note: "waiting on CI" });
    const p = await b.expect(
      (f) => f.type === "presence" && f.entry.name === "t7-fred" && f.entry.state === "blocked",
    );
    if (p.type !== "presence") throw new Error("unreachable");
    expect(p.entry.note).toBe("waiting on CI");
    expect(b.frames.some((f) => f.type === "msg")).toBe(false);
    a.close();
    b.close();
  });

  it("坏帧收到 error bad_frame", async () => {
    const t = await mintToken("t7-hank", "human");
    await createChannel("t7-bad", t);
    const c = await WsClient.connect("t7-bad", t);
    await c.expect((f) => f.type === "hello");
    c.ws.send("not json");
    await c.expect((f) => f.type === "error" && f.code === "bad_frame");
    c.close();
  });
});
