import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenCmd } from "../src/commands/token";
import { channelCmd } from "../src/commands/channel";
import { saveConfig, type Config } from "../src/config";
import { CliError } from "../src/errors";
import { EXIT_ERROR } from "@agentparty-mini/shared";

let dir: string;
const origXdg = process.env.XDG_CONFIG_HOME;
const origSecret = process.env.ADMIN_SECRET;
const cfg: Config = { server: "https://s.example", token: "ap_owner", channel: "design", name: "alice", kind: "human" };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "party-boot-"));
  process.env.XDG_CONFIG_HOME = dir;
  saveConfig(cfg);
});
afterEach(() => {
  origXdg === undefined ? delete process.env.XDG_CONFIG_HOME : (process.env.XDG_CONFIG_HOME = origXdg);
  origSecret === undefined ? delete process.env.ADMIN_SECRET : (process.env.ADMIN_SECRET = origSecret);
  rmSync(dir, { recursive: true, force: true });
});

interface Captured { url: string; method: string; headers: any; body: any }
function capturing(status: number, resBody: unknown): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch = (async (url: string, init: any) => {
    calls.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(resBody === undefined ? "" : JSON.stringify(resBody), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("token command", () => {
  test("create 带 admin secret 头和 kind", async () => {
    process.env.ADMIN_SECRET = "s3cret";
    const { fetch, calls } = capturing(201, { token: "ap_new", name: "ci", kind: "agent" });
    await tokenCmd(["create", "ci", "--kind", "agent"], fetch);
    expect(calls[0].url).toBe("https://s.example/api/tokens");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["x-admin-secret"]).toBe("s3cret");
    expect(calls[0].body).toEqual({ name: "ci", kind: "agent" });
  });
  test("缺 ADMIN_SECRET 抛 EXIT_ERROR", async () => {
    delete process.env.ADMIN_SECRET;
    const { fetch } = capturing(201, {});
    try {
      await tokenCmd(["create", "ci", "--kind", "agent"], fetch);
      throw new Error("should throw");
    } catch (e) {
      expect((e as CliError).code).toBe(EXIT_ERROR);
    }
  });
});

describe("channel command", () => {
  test("create --party 传 mode party，用 config 的 bearer token", async () => {
    const { fetch, calls } = capturing(201, { slug: "brainstorm", mode: "party" });
    await channelCmd(["create", "brainstorm", "--party"], fetch);
    expect(calls[0].url).toBe("https://s.example/api/channels");
    expect(calls[0].headers["authorization"]).toBe("Bearer ap_owner");
    expect(calls[0].body).toEqual({ slug: "brainstorm", mode: "party" });
  });
  test("guard off → limit 0；guard default → limit null；guard 50 → limit 50", async () => {
    const off = capturing(200, { ok: true });
    await channelCmd(["guard", "design", "off"], off.fetch);
    expect(off.calls[0].body).toEqual({ limit: 0 });
    const def = capturing(200, { ok: true });
    await channelCmd(["guard", "design", "default"], def.fetch);
    expect(def.calls[0].body).toEqual({ limit: null });
    const fifty = capturing(200, { ok: true });
    await channelCmd(["guard", "design", "50"], fifty.fetch);
    expect(fifty.calls[0].body).toEqual({ limit: 50 });
  });
  test("list 走 GET", async () => {
    const { fetch, calls } = capturing(200, { channels: [] });
    await channelCmd(["list"], fetch);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://s.example/api/channels");
  });
});
