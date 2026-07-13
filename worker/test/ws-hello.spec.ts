import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintToken } from "./tokens.spec";
import { WsClient } from "./ws";

async function createChannel(slug: string, token: string, mode?: string) {
  const res = await SELF.fetch("https://x/api/channels", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ slug, ...(mode ? { mode } : {}) }),
  });
  if (res.status !== 201) throw new Error(`create channel failed: ${res.status}`);
}

describe("ws upgrade + hello", () => {
  it("无 token 401，不存在频道 404", async () => {
    const token = await mintToken("t6-a", "agent");
    const anon = await SELF.fetch("https://x/api/channels/whatever/ws", {
      headers: { upgrade: "websocket" },
    });
    expect(anon.status).toBe(401);
    const missing = await SELF.fetch(`https://x/api/channels/no-such/ws?token=${token}`, {
      headers: { upgrade: "websocket" },
    });
    expect(missing.status).toBe(404);
  });

  it("连接收到 hello：self/seq_high/mode/guard/presence 含自己", async () => {
    const token = await mintToken("t6-bob", "agent");
    await createChannel("t6-room", token, "party");
    const c = await WsClient.connect("t6-room", token);
    const hello = await c.expect((f) => f.type === "hello");
    if (hello.type !== "hello") throw new Error("unreachable");
    expect(hello.self).toBe("t6-bob");
    expect(hello.channel).toBe("t6-room");
    expect(hello.seq_high).toBe(0);
    expect(hello.mode).toBe("party");
    expect(hello.guard).toBe(200);
    expect(hello.presence.some((p) => p.name === "t6-bob" && p.state !== "offline")).toBe(true);
    c.close();
  });

  it("客户端注入的 x-ap-name 被剥离，身份以 token 为准", async () => {
    const token = await mintToken("t6-honest", "human");
    await createChannel("t6-sec", token);
    const res = await SELF.fetch(`https://x/api/channels/t6-sec/ws?token=${token}`, {
      headers: { upgrade: "websocket", "x-ap-name": "mallory", "x-ap-kind": "human" },
    });
    expect(res.status).toBe(101);
    const c = new (WsClient as any)(res.webSocket) as WsClient;
    const hello = await c.expect((f) => f.type === "hello");
    if (hello.type !== "hello") throw new Error("unreachable");
    expect(hello.self).toBe("t6-honest");
    c.close();
  });

  it("第二人连接与断开时，第一人收到 presence 帧", async () => {
    const ta = await mintToken("t6-p1", "human");
    const tb = await mintToken("t6-p2", "agent");
    await createChannel("t6-pres", ta);
    const a = await WsClient.connect("t6-pres", ta);
    await a.expect((f) => f.type === "hello");
    const b = await WsClient.connect("t6-pres", tb);
    await a.expect((f) => f.type === "presence" && f.entry.name === "t6-p2" && f.entry.state !== "offline");
    b.close();
    await a.expect((f) => f.type === "presence" && f.entry.name === "t6-p2" && f.entry.state === "offline");
    a.close();
  });
});
