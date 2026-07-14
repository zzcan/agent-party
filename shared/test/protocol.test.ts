import { describe, expect, test } from "bun:test";
import {
  BODY_LIMIT,
  extractMentions,
  isName,
  LOOP_GUARD_N,
  LOOP_GUARD_PARTY_N,
  parseSendFrame,
  resolveGuardLimit,
  EXIT_OK,
  EXIT_ERROR,
  EXIT_AUTH,
  EXIT_LOOP_GUARD,
  EXIT_ARCHIVED,
  EXIT_RATE_LIMITED,
} from "../src/protocol";

describe("isName", () => {
  test("接受小写字母数字和连字符", () => {
    expect(isName("bob")).toBe(true);
    expect(isName("ci-bot-2")).toBe(true);
  });
  test("拒绝大写、下划线、超长、首连字符、非字符串", () => {
    expect(isName("Bob")).toBe(false);
    expect(isName("a_b")).toBe(false);
    expect(isName("-ab")).toBe(false);
    expect(isName("a".repeat(33))).toBe(false);
    expect(isName(42)).toBe(false);
    expect(isName("")).toBe(false);
  });
});

describe("extractMentions", () => {
  test("提取多个 mention 并去重保序", () => {
    expect(extractMentions("@bob look, @carol and @bob again")).toEqual(["bob", "carol"]);
  });
  test("无 mention 返回空数组", () => {
    expect(extractMentions("plain text")).toEqual([]);
  });
  test("邮箱里的 @ 不算 mention 的一部分只从 @ 后取合法名", () => {
    expect(extractMentions("mail a@b-c ok")).toEqual(["b-c"]);
  });
});

describe("parseSendFrame", () => {
  test("合法 message 帧", () => {
    const r = parseSendFrame(
      JSON.stringify({ type: "send", kind: "message", body: "hi @bob", idem_key: "k1" }),
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.frame.kind).toBe("message");
  });
  test("合法 status 帧", () => {
    const r = parseSendFrame(JSON.stringify({ type: "send", kind: "status", state: "working" }));
    if ("error" in r) throw new Error(r.error);
    expect(r.frame.kind).toBe("status");
  });
  test("拒绝非 JSON / 错误 type / 错误 kind", () => {
    expect("error" in parseSendFrame("not json")).toBe(true);
    expect("error" in parseSendFrame(JSON.stringify({ type: "x" }))).toBe(true);
    expect("error" in parseSendFrame(JSON.stringify({ type: "send", kind: "x" }))).toBe(true);
  });
  test("message 帧缺 body / 缺 idem_key / body 超限 / idem_key 超限被拒", () => {
    expect("error" in parseSendFrame(JSON.stringify({ type: "send", kind: "message", idem_key: "k" }))).toBe(true);
    expect("error" in parseSendFrame(JSON.stringify({ type: "send", kind: "message", body: "x" }))).toBe(true);
    expect(
      "error" in
        parseSendFrame(
          JSON.stringify({ type: "send", kind: "message", body: "x".repeat(BODY_LIMIT + 1), idem_key: "k" }),
        ),
    ).toBe(true);
    expect(
      "error" in
        parseSendFrame(
          JSON.stringify({ type: "send", kind: "message", body: "x", idem_key: "k".repeat(129) }),
        ),
    ).toBe(true);
  });
  test("status 帧非法 state 被拒", () => {
    expect("error" in parseSendFrame(JSON.stringify({ type: "send", kind: "status", state: "zzz" }))).toBe(true);
  });
  test("reply_to 必须是正整数", () => {
    expect(
      "error" in
        parseSendFrame(
          JSON.stringify({ type: "send", kind: "message", body: "x", idem_key: "k", reply_to: -1 }),
        ),
    ).toBe(true);
  });
});

describe("resolveGuardLimit", () => {
  test("NULL 按 mode 默认，显式值原样", () => {
    expect(resolveGuardLimit("normal", null)).toBe(LOOP_GUARD_N);
    expect(resolveGuardLimit("party", null)).toBe(LOOP_GUARD_PARTY_N);
    expect(resolveGuardLimit("party", 0)).toBe(0);
    expect(resolveGuardLimit("normal", 7)).toBe(7);
  });
});

describe("exit codes", () => {
  test("语义退出码值固定", () => {
    expect([EXIT_OK, EXIT_ERROR, EXIT_AUTH, EXIT_LOOP_GUARD, EXIT_ARCHIVED, EXIT_RATE_LIMITED]).toEqual([0, 1, 3, 4, 5, 9]);
  });
});
