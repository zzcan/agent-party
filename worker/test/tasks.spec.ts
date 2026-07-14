import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ChannelDO } from "../src/index";

function stubFor(slug: string) {
  return (env.CHANNELS as unknown as DurableObjectNamespace<ChannelDO>).get(env.CHANNELS.idFromName(slug));
}
function req(path: string, method: string, name: string, body?: unknown) {
  return new Request(`https://do${path}`, {
    method,
    headers: { "x-ap-name": name, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("DO tasks", () => {
  it("create → backlog task with created_by, then GET lists it", async () => {
    await runInDurableObject(stubFor("t-do-1"), async (do_) => {
      do_.onStart();
      const res = await do_.onRequest(req("/internal/tasks", "POST", "alice", { title: "fix auth" }));
      expect(res.status).toBe(201);
      const task = (await res.json()) as any;
      expect(task).toMatchObject({ id: 1, title: "fix auth", state: "backlog", assignee: null, created_by: "alice", blocked_reason: null });
      expect(task.created_at).toBeGreaterThan(0);
      const list = await do_.onRequest(req("/internal/tasks", "GET", "alice"));
      const body = (await list.json()) as { tasks: any[] };
      expect(body.tasks.map((t) => t.id)).toEqual([1]);
    });
  });

  it("title validation: empty and >200 → 400", async () => {
    await runInDurableObject(stubFor("t-do-2"), async (do_) => {
      do_.onStart();
      expect((await do_.onRequest(req("/internal/tasks", "POST", "a", { title: "" }))).status).toBe(400);
      expect((await do_.onRequest(req("/internal/tasks", "POST", "a", { title: "x".repeat(201) }))).status).toBe(400);
    });
  });

  it("claim: backlog→in_progress sets assignee; steal reassigns; done→claim 400", async () => {
    await runInDurableObject(stubFor("t-do-3"), async (do_) => {
      do_.onStart();
      await do_.onRequest(req("/internal/tasks", "POST", "alice", { title: "t" })); // #1
      const claimed = await do_.onRequest(req("/internal/tasks/1", "PATCH", "bob", { action: "claim" }));
      expect(claimed.status).toBe(200);
      expect((await claimed.json() as any)).toMatchObject({ state: "in_progress", assignee: "bob" });
      // 抢单：carol 认领 bob 正在做的 → 改派
      const stolen = await do_.onRequest(req("/internal/tasks/1", "PATCH", "carol", { action: "claim" }));
      expect((await stolen.json() as any).assignee).toBe("carol");
      // 标完成后再 claim → 400
      await do_.onRequest(req("/internal/tasks/1", "PATCH", "carol", { action: "done" }));
      expect((await do_.onRequest(req("/internal/tasks/1", "PATCH", "d", { action: "claim" }))).status).toBe(400);
    });
  });

  it("block: reason required 1..500; blocked→claim clears reason", async () => {
    await runInDurableObject(stubFor("t-do-4"), async (do_) => {
      do_.onStart();
      await do_.onRequest(req("/internal/tasks", "POST", "a", { title: "t" })); // #1 backlog
      expect((await do_.onRequest(req("/internal/tasks/1", "PATCH", "a", { action: "block" }))).status).toBe(400); // 缺 reason
      expect((await do_.onRequest(req("/internal/tasks/1", "PATCH", "a", { action: "block", reason: "" }))).status).toBe(400);
      expect((await do_.onRequest(req("/internal/tasks/1", "PATCH", "a", { action: "block", reason: "x".repeat(501) }))).status).toBe(400);
      const blocked = await do_.onRequest(req("/internal/tasks/1", "PATCH", "a", { action: "block", reason: "waiting CI" }));
      expect((await blocked.json() as any)).toMatchObject({ state: "blocked", blocked_reason: "waiting CI" });
      const reclaimed = await do_.onRequest(req("/internal/tasks/1", "PATCH", "b", { action: "claim" }));
      expect((await reclaimed.json() as any)).toMatchObject({ state: "in_progress", blocked_reason: null });
    });
  });

  it("done from each non-done state; done→done 400", async () => {
    await runInDurableObject(stubFor("t-do-5"), async (do_) => {
      do_.onStart();
      await do_.onRequest(req("/internal/tasks", "POST", "a", { title: "t" })); // #1 backlog
      expect((await do_.onRequest(req("/internal/tasks/1", "PATCH", "a", { action: "done" }))).status).toBe(200);
      expect((await do_.onRequest(req("/internal/tasks/1", "PATCH", "a", { action: "done" }))).status).toBe(400);
    });
  });

  it("id not found → 404; unknown action → 400", async () => {
    await runInDurableObject(stubFor("t-do-6"), async (do_) => {
      do_.onStart();
      expect((await do_.onRequest(req("/internal/tasks/99", "PATCH", "a", { action: "claim" }))).status).toBe(404);
      await do_.onRequest(req("/internal/tasks", "POST", "a", { title: "t" }));
      expect((await do_.onRequest(req("/internal/tasks/1", "PATCH", "a", { action: "frobnicate" }))).status).toBe(400);
    });
  });

  it("done from blocked clears blocked_reason (state-invariant)", async () => {
    await runInDurableObject(stubFor("t-do-7"), async (do_) => {
      do_.onStart();
      await do_.onRequest(req("/internal/tasks", "POST", "a", { title: "t" })); // #1 backlog
      await do_.onRequest(req("/internal/tasks/1", "PATCH", "a", { action: "block", reason: "waiting CI" }));
      const done = await do_.onRequest(req("/internal/tasks/1", "PATCH", "a", { action: "done" }));
      expect((await done.json() as any)).toMatchObject({ state: "done", blocked_reason: null });
    });
  });
});
