import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { mintToken } from "./tokens.spec";
import { WsClient } from "./ws";

const ADMIN = { "x-admin-secret": "test-admin-secret" };

async function api(path: string, token: string, init: RequestInit = {}) {
  return SELF.fetch(`https://x${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("lifecycle", () => {
  it("吊销 token 后在线连接下一条消息收 error auth 并被断开", async () => {
    const t = await mintToken("t10-doomed", "agent");
    const keeper = await mintToken("t10-keeper", "human");
    await api("/api/channels", keeper, { method: "POST", body: JSON.stringify({ slug: "t10-rev" }) });
    const c = await WsClient.connect("t10-rev", t);
    await c.expect((f) => f.type === "hello");
    c.send({ type: "send", kind: "message", body: "before", idem_key: "t10-b" });
    await c.expect((f) => f.type === "sent");
    await SELF.fetch("https://x/api/tokens/t10-doomed", { method: "DELETE", headers: ADMIN });
    c.send({ type: "send", kind: "message", body: "after", idem_key: "t10-a" });
    await c.expect((f) => f.type === "error" && f.code === "auth");
  });

  it("归档后：在线连接被拒收，新升级 410", async () => {
    const t = await mintToken("t10-arch", "human");
    await api("/api/channels", t, { method: "POST", body: JSON.stringify({ slug: "t10-old" }) });
    const c = await WsClient.connect("t10-old", t);
    await c.expect((f) => f.type === "hello");
    await api("/api/channels/t10-old/archive", t, { method: "POST" });
    c.send({ type: "send", kind: "message", body: "too late", idem_key: "t10-l" });
    await c.expect((f) => f.type === "error" && f.code === "archived");
    const res = await SELF.fetch(`https://x/api/channels/t10-old/ws?token=${t}`, {
      headers: { upgrade: "websocket" },
    });
    expect(res.status).toBe(410);
  });

  it("onAlarm 把幽灵 presence 行标记 offline", async () => {
    const t = await mintToken("t10-ghost", "human");
    await api("/api/channels", t, { method: "POST", body: JSON.stringify({ slug: "t10-sweep" }) });
    const live = await WsClient.connect("t10-sweep", t);
    await live.expect((f) => f.type === "hello");
    const stub = (env.CHANNELS as unknown as DurableObjectNamespace<ChannelDO>).get(
      env.CHANNELS.idFromName("t10-sweep"),
    );
    await runInDurableObject(stub, async (instance: ChannelDO) => {
      // 伪造一个断电残留：connected=1 但没有对应存活连接
      (instance as any).db.exec(
        "INSERT INTO presence (name, kind, state, note, last_seen, connected) VALUES ('t10-zombie','agent','working',NULL,0,1)",
      );
      await (instance as any).onAlarm();
    });
    await live.expect(
      (f) => f.type === "presence" && f.entry.name === "t10-zombie" && f.entry.state === "offline",
    );
    live.close();
  });
});
