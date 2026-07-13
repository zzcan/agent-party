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

describe("catch-up + retention", () => {
  it("?after=1 回放 seq 2..3 后接实时流", async () => {
    const ta = await mintToken("t8-a", "human");
    const tb = await mintToken("t8-b", "human");
    await createChannel("t8-room", ta);
    const a = await WsClient.connect("t8-room", ta);
    await a.expect((f) => f.type === "hello");
    for (const [i, body] of ["one", "two", "three"].entries()) {
      a.send({ type: "send", kind: "message", body, idem_key: `t8-k${i}` });
      await a.expect((f) => f.type === "sent");
    }
    const b = await WsClient.connect("t8-room", tb, 1);
    const hello = await b.expect((f) => f.type === "hello");
    if (hello.type !== "hello") throw new Error("unreachable");
    expect(hello.seq_high).toBe(3);
    const m2 = await b.expect((f) => f.type === "msg");
    const m3 = await b.expect((f) => f.type === "msg");
    if (m2.type !== "msg" || m3.type !== "msg") throw new Error("unreachable");
    expect([m2.seq, m3.seq]).toEqual([2, 3]);
    // 回放完接实时
    a.send({ type: "send", kind: "message", body: "live", idem_key: "t8-live" });
    await b.expect((f) => f.type === "msg" && f.seq === 4);
    a.close();
    b.close();
  });

  it("超出 RETAIN_N(测试值 50) 的最老消息被修剪", async () => {
    const t = await mintToken("t8-c", "human");
    await createChannel("t8-prune", t);
    const c = await WsClient.connect("t8-prune", t);
    await c.expect((f) => f.type === "hello");
    for (let i = 1; i <= 55; i++) {
      c.send({ type: "send", kind: "message", body: `m${i}`, idem_key: `t8-p${i}` });
      await c.expect((f) => f.type === "sent" && f.seq === i);
    }
    const late = await WsClient.connect("t8-prune", t, 0);
    const hello = await late.expect((f) => f.type === "hello");
    if (hello.type !== "hello") throw new Error("unreachable");
    expect(hello.seq_high).toBe(55);
    const first = await late.expect((f) => f.type === "msg");
    if (first.type !== "msg") throw new Error("unreachable");
    expect(first.seq).toBe(6); // 1..5 已被修剪，seq 不复用
    c.close();
    late.close();
  });
});
