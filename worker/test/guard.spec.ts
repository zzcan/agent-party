import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { mintToken } from "./tokens.spec";
import { WsClient } from "./ws";

async function api(path: string, token: string, init: RequestInit = {}) {
  return SELF.fetch(`https://x${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("loop guard", () => {
  it("guard=3：第 4 条 agent 消息被拒 + system 通告一次；human 发言解除", async () => {
    const agent = await mintToken("t9-agent", "agent");
    const human = await mintToken("t9-human", "human");
    await api("/api/channels", human, { method: "POST", body: JSON.stringify({ slug: "t9-room" }) });
    await api("/api/channels/t9-room/guard", human, { method: "PUT", body: JSON.stringify({ limit: 3 }) });
    const a = await WsClient.connect("t9-room", agent);
    const h = await WsClient.connect("t9-room", human);
    await a.expect((f) => f.type === "hello");
    await h.expect((f) => f.type === "hello");

    for (let i = 1; i <= 3; i++) {
      a.send({ type: "send", kind: "message", body: `a${i}`, idem_key: `t9-a${i}` });
      await a.expect((f) => f.type === "sent");
    }
    // 中间夹一个 status 帧不该计数、也不该被拒
    a.send({ type: "send", kind: "status", state: "working" });
    a.send({ type: "send", kind: "message", body: "a4", idem_key: "t9-a4" });
    await a.expect((f) => f.type === "error" && f.code === "loop_guard");
    // human 端收到 system 通告
    await h.expect((f) => f.type === "msg" && f.sender === "system");
    // 再拒一条不重复通告
    a.send({ type: "send", kind: "message", body: "a5", idem_key: "t9-a5" });
    await a.expect((f) => f.type === "error" && f.code === "loop_guard");
    // human 发言清零，agent 恢复
    h.send({ type: "send", kind: "message", body: "human here", idem_key: "t9-h1" });
    await h.expect((f) => f.type === "sent");
    a.send({ type: "send", kind: "message", body: "a6", idem_key: "t9-a6" });
    await a.expect((f) => f.type === "sent");
    expect(h.frames.filter((f) => f.type === "msg" && (f as { sender?: string }).sender === "system").length).toBe(1);
    a.close();
    h.close();
  });

  it("guard=0 关闭熔断", async () => {
    const agent = await mintToken("t9-free", "agent");
    await api("/api/channels", agent, { method: "POST", body: JSON.stringify({ slug: "t9-off" }) });
    await api("/api/channels/t9-off/guard", agent, { method: "PUT", body: JSON.stringify({ limit: 0 }) });
    const a = await WsClient.connect("t9-off", agent);
    await a.expect((f) => f.type === "hello");
    for (let i = 1; i <= 35; i++) {
      a.send({ type: "send", kind: "message", body: `x${i}`, idem_key: `t9-o${i}` });
      await a.expect((f) => f.type === "sent");
    }
    a.close();
  });

  it("PUT guard 对已运行的 DO 即时生效（poke）", async () => {
    const agent = await mintToken("t9-live", "agent");
    await api("/api/channels", agent, { method: "POST", body: JSON.stringify({ slug: "t9-poke" }) });
    const a = await WsClient.connect("t9-poke", agent);
    await a.expect((f) => f.type === "hello");
    a.send({ type: "send", kind: "message", body: "ok", idem_key: "t9-pk1" });
    await a.expect((f) => f.type === "sent");
    // 连接保持打开时收紧 guard 到 1：streak 已是 1，下一条即触发
    await api("/api/channels/t9-poke/guard", agent, { method: "PUT", body: JSON.stringify({ limit: 1 }) });
    a.send({ type: "send", kind: "message", body: "blocked?", idem_key: "t9-pk2" });
    await a.expect((f) => f.type === "error" && f.code === "loop_guard");
    a.close();
  });

  it("/internal/config 加固：非法 body 返回 400 不抛异常，非法类型字段被忽略、不静默关闭熔断", async () => {
    const slug = "t9-hardened";
    const agent = await mintToken("t9-hardened-agent", "agent");
    await api("/api/channels", agent, { method: "POST", body: JSON.stringify({ slug }) });
    await api(`/api/channels/${slug}/guard`, agent, { method: "PUT", body: JSON.stringify({ limit: 2 }) });
    const a = await WsClient.connect(slug, agent);
    await a.expect((f) => f.type === "hello");

    const stub = (env.CHANNELS as unknown as DurableObjectNamespace<ChannelDO>).get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance) => {
      // 非 JSON body 必须被 catch 住，返回 400 而不是把异常抛出 onRequest 之外
      const malformed = await instance.onRequest(
        new Request("https://do/internal/config", {
          method: "POST",
          headers: { "x-partykit-room": slug },
          body: "not json",
        }),
      );
      expect(malformed.status).toBe(400);

      // guard 字段类型非法（字符串而非 number）必须被忽略，不能写入 NaN 从而静默关闭熔断
      const invalidGuard = await instance.onRequest(
        new Request("https://do/internal/config", {
          method: "POST",
          headers: { "x-partykit-room": slug, "content-type": "application/json" },
          body: JSON.stringify({ guard: "abc" }),
        }),
      );
      expect(invalidGuard.status).toBe(200);
    });

    // guard 仍是原先设置的 2：连发 2 条 agent 消息后第 3 条应仍旧触发熔断
    a.send({ type: "send", kind: "message", body: "h1", idem_key: "t9-hard1" });
    await a.expect((f) => f.type === "sent");
    a.send({ type: "send", kind: "message", body: "h2", idem_key: "t9-hard2" });
    await a.expect((f) => f.type === "sent");
    a.send({ type: "send", kind: "message", body: "h3", idem_key: "t9-hard3" });
    await a.expect((f) => f.type === "error" && f.code === "loop_guard");
    a.close();
  });
});

describe("rate limit", () => {
  it("超过 RATE_LIMIT_PER_MIN(测试值 100) 收到 rate_limited", async () => {
    const human = await mintToken("t9-chatty", "human");
    await api("/api/channels", human, { method: "POST", body: JSON.stringify({ slug: "t9-rate" }) });
    const c = await WsClient.connect("t9-rate", human);
    await c.expect((f) => f.type === "hello");
    for (let i = 1; i <= 100; i++) {
      c.send({ type: "send", kind: "message", body: `r${i}`, idem_key: `t9-r${i}` });
      await c.expect((f) => f.type === "sent");
    }
    c.send({ type: "send", kind: "message", body: "overflow", idem_key: "t9-r101" });
    await c.expect((f) => f.type === "error" && f.code === "rate_limited");
    c.close();
  });
});
