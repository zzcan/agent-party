import { describe, expect, test } from "bun:test";
import { main } from "../src/index";

describe("cli dispatch", () => {
  test("--version 返回 0", async () => {
    expect(await main(["--version"])).toBe(0);
  });
  test("--help 返回 0", async () => {
    expect(await main(["--help"])).toBe(0);
  });
  test("无参数打印 help 返回 0", async () => {
    expect(await main([])).toBe(0);
  });
  test("未知命令返回 1", async () => {
    expect(await main(["frobnicate"])).toBe(1);
  });
});
