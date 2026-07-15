import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/index";

let dir: string;
const orig = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "party-mcp-"));
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(() => {
  if (orig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = orig;
  rmSync(dir, { recursive: true, force: true });
});

describe("party mcp dispatch", () => {
  test("未 init → EXIT_ERROR（不崩）", async () => {
    expect(await main(["mcp"])).toBe(1);
  });
});
