import { describe, expect, test } from "bun:test";
import { partyTaskList, partyTaskUpdate, type ToolCtx } from "../src/mcp/tools";

const ctx: ToolCtx = { server: "https://s.example", token: "ap_x", defaultChannel: "design" };

function mockFetch(status: number, json: unknown, calls: any[] = []) {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
}

describe("party_task_list", () => {
  test("GET 绑定频道，回 {tasks} 的 JSON", async () => {
    const calls: any[] = [];
    const r = await partyTaskList(ctx, {}, { fetchImpl: mockFetch(200, { tasks: [{ id: 1, title: "x", state: "backlog" }] }, calls) });
    expect(calls[0]).toMatchObject({ url: "https://s.example/api/channels/design/tasks", method: "GET" });
    expect(JSON.parse(r.content[0].text).tasks).toHaveLength(1);
  });
  test("channel 入参覆盖默认频道", async () => {
    const calls: any[] = [];
    await partyTaskList(ctx, { channel: "other" }, { fetchImpl: mockFetch(200, { tasks: [] }, calls) });
    expect(calls[0].url).toBe("https://s.example/api/channels/other/tasks");
  });
});

describe("party_task_update", () => {
  test("create 需 title，POST，回 created #id", async () => {
    const calls: any[] = [];
    const r = await partyTaskUpdate(ctx, { action: "create", title: "fix bug" }, { fetchImpl: mockFetch(201, { id: 3, title: "fix bug" }, calls) });
    expect(calls[0]).toMatchObject({ url: "https://s.example/api/channels/design/tasks", method: "POST", body: { title: "fix bug" } });
    expect(r.content[0].text).toBe("created #3: fix bug");
  });
  test("claim/done PATCH action", async () => {
    const c1: any[] = [];
    const r1 = await partyTaskUpdate(ctx, { action: "claim", id: 3 }, { fetchImpl: mockFetch(200, { id: 3 }, c1) });
    expect(c1[0]).toMatchObject({ url: "https://s.example/api/channels/design/tasks/3", method: "PATCH", body: { action: "claim" } });
    expect(r1.content[0].text).toBe("claimed #3");
    const c2: any[] = [];
    const r2 = await partyTaskUpdate(ctx, { action: "done", id: 4 }, { fetchImpl: mockFetch(200, { id: 4 }, c2) });
    expect(r2.content[0].text).toBe("completed #4");
  });
  test("block 需 id+reason", async () => {
    const c: any[] = [];
    const r = await partyTaskUpdate(ctx, { action: "block", id: 5, reason: "on CI" }, { fetchImpl: mockFetch(200, { id: 5 }, c) });
    expect(c[0]).toMatchObject({ method: "PATCH", body: { action: "block", reason: "on CI" } });
    expect(r.content[0].text).toBe("blocked #5");
  });
  test("入参缺失 → 工具错误，不抛", async () => {
    const f = mockFetch(200, {});
    expect((await partyTaskUpdate(ctx, { action: "create" }, { fetchImpl: f })).isError).toBe(true);
    expect((await partyTaskUpdate(ctx, { action: "claim" }, { fetchImpl: f })).isError).toBe(true);
    expect((await partyTaskUpdate(ctx, { action: "block", id: 5 }, { fetchImpl: f })).isError).toBe(true);
    expect((await partyTaskUpdate(ctx, { action: "zzz" }, { fetchImpl: f })).isError).toBe(true);
  });
  test("REST 410 归档 → 工具错误（不抛、不退出）", async () => {
    const r = await partyTaskUpdate(ctx, { action: "create", title: "x" }, { fetchImpl: mockFetch(410, { error: "channel is archived" }) });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("archived");
  });
});
