import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/commands/init";
import { loadConfig } from "../src/config";
import { CliError } from "../src/errors";
import { EXIT_AUTH, EXIT_ERROR } from "@agentparty-mini/shared";

let dir: string;
const orig = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "party-init-"));
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(() => {
  if (orig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = orig;
  rmSync(dir, { recursive: true, force: true });
});

function fetchOk(name: string, kind: string): typeof fetch {
  return (async () => new Response(JSON.stringify({ name, kind }), { status: 200 })) as unknown as typeof fetch;
}
function fetch401(): typeof fetch {
  return (async () => new Response(JSON.stringify({ error: "invalid" }), { status: 401 })) as unknown as typeof fetch;
}

describe("init", () => {
  test("验证 token 并回填身份写入 config", async () => {
    await init(["--server", "https://s.example", "--token", "ap_x", "--channel", "design"], fetchOk("alice", "human"));
    expect(loadConfig()).toEqual({ server: "https://s.example", token: "ap_x", channel: "design", name: "alice", kind: "human" });
  });
  test("缺 --channel 抛 EXIT_ERROR", async () => {
    try {
      await init(["--server", "https://s", "--token", "ap_x"], fetchOk("a", "human"));
      throw new Error("should throw");
    } catch (e) {
      expect((e as CliError).code).toBe(EXIT_ERROR);
    }
  });
  test("token 无效抛 EXIT_AUTH 且不写 config", async () => {
    try {
      await init(["--server", "https://s", "--token", "bad", "--channel", "design"], fetch401());
      throw new Error("should throw");
    } catch (e) {
      expect((e as CliError).code).toBe(EXIT_AUTH);
    }
    expect(() => loadConfig()).toThrow(CliError);
  });
});
