import { describe, expect, test } from "bun:test";
import { formatMsg, formatPresence, ndjson } from "../src/format";

describe("format", () => {
  test("formatMsg 普通与 system", () => {
    expect(formatMsg({ type: "msg", seq: 1, ts: 0, sender: "bob", sender_kind: "human", body: "hi", mentions: [], reply_to: null })).toBe("[bob] hi");
    expect(formatMsg({ type: "msg", seq: 2, ts: 0, sender: "system", sender_kind: "agent", body: "loop guard", mentions: [], reply_to: null })).toBe("**[system] loop guard");
  });
  test("formatPresence 带/不带 note", () => {
    expect(formatPresence({ name: "a", kind: "human", state: "working", note: null, last_seen: 0 })).toBe("· a is working");
    expect(formatPresence({ name: "b", kind: "agent", state: "blocked", note: "ci", last_seen: 0 })).toBe("· b is blocked (ci)");
  });
  test("ndjson 是单行 JSON", () => {
    const line = ndjson({ type: "sent", seq: 5, idem_key: "k" });
    expect(line).toBe('{"type":"sent","seq":5,"idem_key":"k"}');
  });
});
