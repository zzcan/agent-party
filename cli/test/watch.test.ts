import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watch } from "../src/commands/watch";
import { openChannel } from "../src/ws";
import { startMockChannel } from "./mock-channel";
import { loadCursor } from "../src/config";
import { CliError } from "../src/errors";
import { EXIT_ARCHIVED } from "@agentparty-mini/shared";

let dir: string;
let stop: (() => void) | null = null;
const orig = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "party-watch-"));
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(() => {
  orig === undefined ? delete process.env.XDG_CONFIG_HOME : (process.env.XDG_CONFIG_HOME = orig);
  stop?.(); stop = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("watch", () => {
  test("--once：补拉历史，输出并推进游标后退出", async () => {
    const m = startMockChannel({ self: "me", history: [
      { seq: 1, sender: "x", body: "one" },
      { seq: 2, sender: "y", body: "two" },
    ] });
    stop = m.stop;
    const cfg = { server: m.url, token: "ap_me", channel: "mock", name: "me", kind: "human" as const };
    await watch(["--once"], { open: openChannel, cfg });
    // --once 收到第一条 msg（seq 1）即退，游标推进到 1
    expect(loadCursor(m.url, "mock")).toBe(1);
  });

  test("连接即 archived → 抛 CliError(EXIT_ARCHIVED)", async () => {
    const m = startMockChannel({ self: "me", connectError: { code: "archived", message: "channel is archived" } });
    stop = m.stop;
    const cfg = { server: m.url, token: "ap_me", channel: "mock", name: "me", kind: "human" as const };
    try {
      await watch(["--once"], { open: openChannel, cfg });
      throw new Error("should throw");
    } catch (e) {
      expect((e as CliError).code).toBe(EXIT_ARCHIVED);
    }
  });
});
