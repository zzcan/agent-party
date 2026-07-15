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
  test("未 init → EXIT_ERROR 且经 loadConfig（证明 mcp 已 dispatch，非 unknown command）", async () => {
    const orig = process.stderr.write.bind(process.stderr);
    let errOut = "";
    process.stderr.write = ((c: string | Uint8Array) => {
      errOut += typeof c === "string" ? c : Buffer.from(c).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await main(["mcp"]);
    } finally {
      process.stderr.write = orig;
    }
    expect(code).toBe(1);
    expect(errOut).toContain("not initialized");
    expect(errOut).not.toContain("unknown command");
  });
});
