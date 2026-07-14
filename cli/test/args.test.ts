import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/args";
import { CliError } from "../src/errors";

const spec = { bool: ["once", "json"], value: ["channel", "reply-to"], multi: ["mention"] };

describe("parseArgs", () => {
  test("位置参数与布尔 flag", () => {
    const r = parseArgs(["hello", "world", "--once"], spec);
    expect(r.positionals).toEqual(["hello", "world"]);
    expect(r.flags.once).toBe(true);
  });
  test("--flag value 与 --flag=value 都支持", () => {
    expect(parseArgs(["--channel", "design"], spec).flags.channel).toBe("design");
    expect(parseArgs(["--channel=design"], spec).flags.channel).toBe("design");
  });
  test("multi flag 收集成数组，保序", () => {
    const r = parseArgs(["--mention", "bob", "--mention", "carol"], spec);
    expect(r.flags.mention).toEqual(["bob", "carol"]);
  });
  test("value flag 缺值抛错", () => {
    expect(() => parseArgs(["--channel"], spec)).toThrow(CliError);
  });
  test("未知 flag 抛错", () => {
    expect(() => parseArgs(["--bogus"], spec)).toThrow(CliError);
  });
  test("-- 之后全当位置参数", () => {
    const r = parseArgs(["--", "--not-a-flag"], spec);
    expect(r.positionals).toEqual(["--not-a-flag"]);
  });
});
