import { describe, expect, test } from "bun:test";
import { taskCmd } from "../src/commands/task";
import { CliError } from "../src/errors";
import { EXIT_ARCHIVED, EXIT_ERROR } from "@agentparty-mini/shared";

const cfg = { server: "https://s.example", token: "ap_x", channel: "design", name: "me", kind: "human" as const };

function mockFetch(status: number, json: unknown, calls: any[] = []) {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
}

describe("party task", () => {
  test("create posts {title} to bound channel, prints created #id", async () => {
    const calls: any[] = [];
    const out: string[] = [];
    const w = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => (out.push(s), true);
    try {
      await taskCmd(["create", "fix", "the", "auth", "bug"], mockFetch(201, { id: 3, title: "fix the auth bug", state: "backlog" }, calls), cfg);
    } finally {
      (process.stdout as any).write = w;
    }
    expect(calls[0]).toMatchObject({ url: "https://s.example/api/channels/design/tasks", method: "POST", body: { title: "fix the auth bug" } });
    expect(out.join("")).toBe("created #3: fix the auth bug\n");
  });

  test("claim/done PATCH action; block PATCH {action,reason}", async () => {
    const calls: any[] = [];
    await taskCmd(["claim", "3"], mockFetch(200, { id: 3, state: "in_progress" }, calls), cfg);
    expect(calls[0]).toMatchObject({ url: "https://s.example/api/channels/design/tasks/3", method: "PATCH", body: { action: "claim" } });
    const calls2: any[] = [];
    await taskCmd(["block", "3", "waiting", "on", "CI"], mockFetch(200, { id: 3, state: "blocked" }, calls2), cfg);
    expect(calls2[0]).toMatchObject({ method: "PATCH", body: { action: "block", reason: "waiting on CI" } });
  });

  test("list formats rows and blocked reason", async () => {
    const out: string[] = [];
    const w = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => (out.push(s), true);
    try {
      await taskCmd(["list"], mockFetch(200, { tasks: [
        { id: 3, state: "in_progress", assignee: "alice", title: "ship", blocked_reason: null },
        { id: 4, state: "blocked", assignee: "bob", title: "wait", blocked_reason: "waiting on CI" },
        { id: 5, state: "done", assignee: null, title: "docs", blocked_reason: null },
      ] }), cfg);
    } finally {
      (process.stdout as any).write = w;
    }
    expect(out.join("")).toBe(
      "#3\tin_progress\talice\tship\n" +
      "#4\tblocked\tbob\twait（reason: waiting on CI）\n" +
      "#5\tdone\t-\tdocs\n",
    );
  });

  test("usage errors: missing title/id/reason → EXIT_ERROR", async () => {
    const f = mockFetch(200, {});
    await expect(taskCmd(["create"], f, cfg)).rejects.toMatchObject({ code: EXIT_ERROR });
    await expect(taskCmd(["claim"], f, cfg)).rejects.toMatchObject({ code: EXIT_ERROR });
    await expect(taskCmd(["claim", "abc"], f, cfg)).rejects.toMatchObject({ code: EXIT_ERROR });
    await expect(taskCmd(["block", "3"], f, cfg)).rejects.toMatchObject({ code: EXIT_ERROR });
  });

  test("410 from server maps to EXIT_ARCHIVED", async () => {
    await expect(
      taskCmd(["create", "x"], mockFetch(410, { error: "channel is archived" }), cfg),
    ).rejects.toMatchObject({ code: EXIT_ARCHIVED });
  });

  test("--channel overrides the bound channel", async () => {
    const calls: any[] = [];
    await taskCmd(["list", "--channel", "other"], mockFetch(200, { tasks: [] }, calls), cfg);
    expect(calls[0].url).toBe("https://s.example/api/channels/other/tasks");
  });
});
