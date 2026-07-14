import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintToken } from "./tokens.spec";
import { WsClient } from "./ws";

async function authed(path: string, token: string, init: RequestInit = {}) {
  return SELF.fetch(`https://x${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}
async function mkChannel(slug: string, token: string) {
  const r = await authed("/api/channels", token, { method: "POST", body: JSON.stringify({ slug }) });
  if (r.status !== 201) throw new Error(`create channel ${slug}: ${r.status}`);
}

describe("tasks REST", () => {
  it("POST creates, GET lists, PATCH claim — end to end", async () => {
    const t = await mintToken("t-rest-a", "human");
    await mkChannel("t-rest-1", t);
    const created = await authed("/api/channels/t-rest-1/tasks", t, { method: "POST", body: JSON.stringify({ title: "ship it" }) });
    expect(created.status).toBe(201);
    const task = (await created.json()) as any;
    expect(task).toMatchObject({ id: 1, title: "ship it", state: "backlog", created_by: "t-rest-a" });
    const claimed = await authed("/api/channels/t-rest-1/tasks/1", t, { method: "PATCH", body: JSON.stringify({ action: "claim" }) });
    expect((await claimed.json() as any)).toMatchObject({ state: "in_progress", assignee: "t-rest-a" });
    const list = await authed("/api/channels/t-rest-1/tasks", t);
    expect(((await list.json()) as { tasks: any[] }).tasks).toHaveLength(1);
  });

  it("auth/not-found/invalid-id: 401, 404 channel, 404 task, 404 non-numeric id", async () => {
    const t = await mintToken("t-rest-b", "human");
    await mkChannel("t-rest-2", t);
    expect((await SELF.fetch("https://x/api/channels/t-rest-2/tasks")).status).toBe(401);
    expect((await authed("/api/channels/nope/tasks", t)).status).toBe(404);
    expect((await authed("/api/channels/t-rest-2/tasks/99", t, { method: "PATCH", body: JSON.stringify({ action: "claim" }) })).status).toBe(404);
    expect((await authed("/api/channels/t-rest-2/tasks/abc", t, { method: "PATCH", body: JSON.stringify({ action: "claim" }) })).status).toBe(404);
  });

  it("archived channel: POST/PATCH → 410, GET → 200", async () => {
    const t = await mintToken("t-rest-c", "human");
    await mkChannel("t-rest-3", t);
    await authed("/api/channels/t-rest-3/tasks", t, { method: "POST", body: JSON.stringify({ title: "pre-archive" }) });
    await authed("/api/channels/t-rest-3/archive", t, { method: "POST" });
    expect((await authed("/api/channels/t-rest-3/tasks", t, { method: "POST", body: JSON.stringify({ title: "x" }) })).status).toBe(410);
    expect((await authed("/api/channels/t-rest-3/tasks/1", t, { method: "PATCH", body: JSON.stringify({ action: "claim" }) })).status).toBe(410);
    const list = await authed("/api/channels/t-rest-3/tasks", t);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { tasks: any[] }).tasks).toHaveLength(1);
  });

  it("task change broadcasts a Chinese system announcement to channel watchers", async () => {
    const t = await mintToken("t-rest-d", "human");
    await mkChannel("t-rest-4", t);
    const w = await WsClient.connect("t-rest-4", t);
    await w.expect((f) => f.type === "hello");
    await authed("/api/channels/t-rest-4/tasks", t, { method: "POST", body: JSON.stringify({ title: "deploy" }) });
    const ann = await w.expect((f) => f.type === "msg" && f.sender === "system");
    if (ann.type !== "msg") throw new Error("unreachable");
    expect(ann.body).toBe("t-rest-d 创建了 #1：deploy");
    w.close();
  });

  it("task announcement does NOT reset the agent loop-guard streak", async () => {
    const agent = await mintToken("t-rest-agent", "agent");
    const human = await mintToken("t-rest-human", "human");
    await mkChannel("t-rest-5", human);
    await authed("/api/channels/t-rest-5/guard", human, { method: "PUT", body: JSON.stringify({ limit: 2 }) });
    const a = await WsClient.connect("t-rest-5", agent);
    await a.expect((f) => f.type === "hello");
    a.send({ type: "send", kind: "message", body: "a1", idem_key: "lg1" });
    await a.expect((f) => f.type === "sent"); // streak 1
    a.send({ type: "send", kind: "message", body: "a2", idem_key: "lg2" });
    await a.expect((f) => f.type === "sent"); // streak 2
    // 任务变更插一条 system 消息——绝不能当作 human 锚点重置 streak
    await authed("/api/channels/t-rest-5/tasks", agent, { method: "POST", body: JSON.stringify({ title: "t" }) });
    a.send({ type: "send", kind: "message", body: "a3", idem_key: "lg3" });
    await a.expect((f) => f.type === "error" && f.code === "loop_guard"); // 仍触发 → streak 未被任务重置
    a.close();
  });
});
