import { describe, expect, test } from "bun:test";
import { restFetch } from "../src/rest";
import { CliError } from "../src/errors";
import { EXIT_AUTH, EXIT_ARCHIVED, EXIT_ERROR } from "@agentparty-mini/shared";

function mockFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("restFetch", () => {
  test("2xx 返回解析后的 JSON", async () => {
    const r = await restFetch("/api/me", { server: "https://s", token: "ap_x" }, mockFetch(200, { name: "bob", kind: "agent" }));
    expect(r).toEqual({ name: "bob", kind: "agent" });
  });
  test("401 → CliError(EXIT_AUTH)", async () => {
    try {
      await restFetch("/api/me", { server: "https://s", token: "bad" }, mockFetch(401, { error: "invalid" }));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(EXIT_AUTH);
    }
  });
  test("410 → CliError(EXIT_ARCHIVED)", async () => {
    try {
      await restFetch("/api/channels/x/ws", { server: "https://s", token: "t" }, mockFetch(410, { error: "archived" }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CliError).code).toBe(EXIT_ARCHIVED);
    }
  });
  test("500 → CliError(EXIT_ERROR) 带服务端 error 文本", async () => {
    try {
      await restFetch("/api/channels", { server: "https://s", token: "t" }, mockFetch(500, { error: "internal error" }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CliError).code).toBe(EXIT_ERROR);
      expect((e as CliError).message).toContain("internal error");
    }
  });
  test("空体 2xx 返回 {}", async () => {
    const r = await restFetch("/api/channels/x/archive", { server: "https://s", token: "t", method: "POST" } as any, mockFetch(200, undefined));
    expect(r).toEqual({});
  });
});
