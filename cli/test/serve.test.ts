import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCursor, loadInflight, saveCursor, saveInflight, type Config } from "../src/config";
import { serve, type ServeControl } from "../src/commands/serve";
import { acquireLock } from "../src/lock";
import { openChannel } from "../src/ws";
import { startMockChannel } from "./mock-channel";

let dir: string;
let ctxDir: string;
let stopMock: (() => void) | null = null;
const orig = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "party-serve-test-"));
  ctxDir = mkdtempSync(join(tmpdir(), "party-serve-ctx-"));
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(() => {
  orig === undefined ? delete process.env.XDG_CONFIG_HOME : (process.env.XDG_CONFIG_HOME = orig);
  stopMock?.();
  stopMock = null;
  rmSync(dir, { recursive: true, force: true });
  rmSync(ctxDir, { recursive: true, force: true });
});

function cfgFor(url: string): Config {
  return { server: url, token: "ap_x", channel: "mock", name: "bot", kind: "agent" };
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 起 serve，返回 { done, ctl, errs }；测试注入 ctl.stop() 收尾。 */
function startServe(url: string, cmd: string, extra: string[] = []) {
  const errs: string[] = [];
  let ctl!: ServeControl;
  const done = serve(["--on-mention", cmd, ...extra], {
    open: openChannel,
    cfg: cfgFor(url),
    contextDir: ctxDir,
    err: (l) => errs.push(l),
    onStart: (c) => {
      ctl = c;
    },
  });
  return { done, ctl: () => ctl, errs };
}

describe("serve 实时唤醒", () => {
  test("被 @ → 命令执行一次，env 四件套 + context file 字段齐全，成功后游标推进、文件删除、waiting", async () => {
    const m = startMockChannel({ self: "bot" });
    stopMock = m.stop;
    const log = join(dir, "wake.log");
    const out = join(dir, "ctx.json");
    const s = startServe(
      m.url,
      `cat "$PARTY_CONTEXT_FILE" > ${out}; echo "$PARTY_SEQ $PARTY_CHANNEL $PARTY_SENDER" >> ${log}`,
    );
    await waitFor(() => m.received.some((f) => (f as { state?: string }).state === "waiting"));
    m.injectMsg({ sender: "carol", body: "chatter" }); // 闲聊：不唤醒，进 recent
    const seq = m.injectMsg({ sender: "alice", body: "@bot go", mentions: ["bot"] });
    await waitFor(() => existsSync(log));
    expect(readFileSync(log, "utf8").trim()).toBe(`${seq} mock alice`);
    const ctx = JSON.parse(readFileSync(out, "utf8"));
    expect(ctx.seq).toBe(seq);
    expect(ctx.sender).toBe("alice");
    expect(ctx.body).toBe("@bot go");
    expect(ctx.reply_to).toBe(seq);
    expect(ctx.self).toBe("bot");
    expect(ctx.recent.some((r: { body: string }) => r.body === "chatter")).toBe(true);
    expect(ctx.recent.some((r: { seq: number }) => r.seq === seq)).toBe(false); // 触发消息不进 recent
    await waitFor(() => loadCursor(m.url, "mock") === seq);
    expect(loadInflight(m.url, "mock")).toBeNull();
    await waitFor(() => readdirSync(ctxDir).length === 0); // 成功删 context file
    // presence 节奏：waiting → working(handling seq=N) → waiting
    // 最后一条 waiting 是 unlink 之后 fire-and-forget 发出的，未必已被 mock 收到；
    // 先等三条 status 帧都到齐，再断言顺序，避免在高负载下偶发失败。
    const statusStates = () =>
      m.received
        .filter((f): f is { kind: string; state: string } => (f as { kind?: string }).kind === "status")
        .map((f) => f.state);
    await waitFor(() => statusStates().length === 3);
    expect(statusStates()).toEqual(["waiting", "working", "waiting"]);
    await s.ctl().stop();
    await s.done;
  });

  test("{file} 占位符替换 + context file 权限 0600", async () => {
    const m = startMockChannel({ self: "bot" });
    stopMock = m.stop;
    const out = join(dir, "via-placeholder.json");
    const s = startServe(m.url, `cp {file} ${out}; stat -f %p {file} > ${join(dir, "mode.txt")} || stat -c %a {file} > ${join(dir, "mode.txt")}`);
    await waitFor(() => m.received.some((f) => (f as { state?: string }).state === "waiting"));
    m.injectMsg({ sender: "alice", body: "@bot x", mentions: ["bot"] });
    const modePath = join(dir, "mode.txt");
    await waitFor(() => existsSync(out) && existsSync(modePath) && readFileSync(modePath, "utf8").trim().length > 0);
    const mode = readFileSync(modePath, "utf8").trim();
    expect(mode.endsWith("600")).toBe(true);
    await s.ctl().stop();
    await s.done;
  });

  test("命令非零退出：游标照样推进（消费）、context file 保留、发 blocked status、serve 不退", async () => {
    const m = startMockChannel({ self: "bot" });
    stopMock = m.stop;
    const s = startServe(m.url, "exit 7");
    await waitFor(() => m.received.some((f) => (f as { state?: string }).state === "waiting"));
    const seq = m.injectMsg({ sender: "alice", body: "@bot x", mentions: ["bot"] });
    await waitFor(() => loadCursor(m.url, "mock") === seq);
    expect(loadInflight(m.url, "mock")).toBeNull(); // 消费掉了
    expect(readdirSync(ctxDir)).toEqual([`${seq}.json`]); // 失败保留
    expect(s.errs.some((l) => l.includes(`wake command failed (exit 7) for seq ${seq}`))).toBe(true);
    const blocked = m.received.find((f) => (f as { state?: string }).state === "blocked") as { note?: string };
    expect(blocked?.note).toBe(`wake command failed (exit 7) for seq ${seq}`);
    // 还活着：再来一条照样唤醒
    const seq2 = m.injectMsg({ sender: "alice", body: "@bot again", mentions: ["bot"] });
    await waitFor(() => loadCursor(m.url, "mock") === seq2);
    await s.ctl().stop();
    await s.done;
    expect(s.errs.some((l) => l.includes("kept failed wake contexts"))).toBe(true);
  });

  test("stop 杀死在飞命令：游标不推进、在飞标记残留（重启重放的欠账）", async () => {
    const m = startMockChannel({ self: "bot" });
    stopMock = m.stop;
    const s = startServe(m.url, "sleep 30");
    await waitFor(() => m.received.some((f) => (f as { state?: string }).state === "waiting"));
    const seq = m.injectMsg({ sender: "alice", body: "@bot x", mentions: ["bot"] });
    await waitFor(() => loadInflight(m.url, "mock") === seq); // 已开跑
    await s.ctl().stop();
    await s.done;
    expect(loadCursor(m.url, "mock")).toBeLessThan(seq); // 未消费
    expect(loadInflight(m.url, "mock")).toBe(seq); // 欠账留存
  });

  test("挂载跳过冷积压：游标跳 seq_high 并打印 skipped 行，不唤醒", async () => {
    const m = startMockChannel({
      self: "bot",
      history: [
        { seq: 1, sender: "a", body: "old1" },
        { seq: 2, sender: "a", body: "@bot old-mention", mentions: ["bot"] },
        { seq: 3, sender: "a", body: "old3" },
      ],
    });
    stopMock = m.stop;
    const log = join(dir, "wake.log");
    const s = startServe(m.url, `echo woke >> ${log}`);
    await waitFor(() => m.received.some((f) => (f as { state?: string }).state === "waiting"));
    await waitFor(() => loadCursor(m.url, "mock") === 3);
    expect(s.errs).toContain("skipped 3 messages up to seq 3");
    await new Promise((r) => setTimeout(r, 100)); // 给错误的唤醒一个发生窗口
    expect(existsSync(log)).toBe(false);
    await s.ctl().stop();
    await s.done;
  });

  test("缺 --on-mention → CliError(EXIT_ERROR)", async () => {
    const m = startMockChannel({ self: "bot" });
    stopMock = m.stop;
    await expect(serve([], { cfg: cfgFor(m.url) })).rejects.toMatchObject({ code: 1 });
  });
});

describe("serve 积压与欠账", () => {
  test("跳过的积压里有 @自己 → 每条打 warning 行", async () => {
    const m = startMockChannel({
      self: "bot",
      history: [
        { seq: 1, sender: "a", body: "@bot one", mentions: ["bot"] },
        { seq: 2, sender: "a", body: "plain" },
        { seq: 3, sender: "a", body: "@bot three", mentions: ["bot"] },
      ],
    });
    stopMock = m.stop;
    const s = startServe(m.url, "true");
    await waitFor(() => s.errs.filter((l) => l.startsWith("warning: skipped mention")).length === 2);
    expect(s.errs).toContain("warning: skipped mention of you at seq 1");
    expect(s.errs).toContain("warning: skipped mention of you at seq 3");
    await s.ctl().stop();
    await s.done;
  });

  test("在飞标记指向的那条恰好重放一次，其余积压照跳", async () => {
    const m = startMockChannel({
      self: "bot",
      history: [
        { seq: 1, sender: "a", body: "@bot one", mentions: ["bot"] },
        { seq: 2, sender: "a", body: "@bot two", mentions: ["bot"] },
        { seq: 3, sender: "a", body: "@bot three", mentions: ["bot"] },
      ],
    });
    stopMock = m.stop;
    saveInflight(m.url, "mock", 2); // 上次崩在 seq 2 在飞
    const log = join(dir, "wake.log");
    const s = startServe(m.url, `echo "$PARTY_SEQ" >> ${log}`);
    await waitFor(() => existsSync(log));
    await waitFor(() => loadInflight(m.url, "mock") === null); // 重放完成、标记清除
    expect(readFileSync(log, "utf8").trim()).toBe("2"); // 只重放 seq 2
    await s.ctl().stop();
    await s.done;
  });

  test("在飞标记指向已修剪消息（补拉第一条已越过它）→ 警告 + 清标记，不唤醒", async () => {
    const m = startMockChannel({
      self: "bot",
      history: [{ seq: 5, sender: "a", body: "later" }],
    });
    stopMock = m.stop;
    saveInflight(m.url, "mock", 2); // 2 已被修剪出保留窗口
    const log = join(dir, "wake.log");
    const s = startServe(m.url, `echo woke >> ${log}`);
    await waitFor(() => loadInflight(m.url, "mock") === null);
    expect(s.errs).toContain("warning: in-flight seq 2 was pruned; dropping");
    expect(existsSync(log)).toBe(false);
    await s.ctl().stop();
    await s.done;
  });

  test("在飞标记被修剪 + 同一帧本身是实时 @ → 既告警又照常唤醒该帧", async () => {
    const m = startMockChannel({
      self: "bot",
      history: [{ seq: 3, sender: "a", body: "old" }], // 撑高 seq_high=3、seqCounter=3
    });
    stopMock = m.stop;
    saveCursor(m.url, "mock", 3); // 游标已越过历史那条，attach 时不会重放它，实时消息就是第一帧
    saveInflight(m.url, "mock", 1); // 在飞标记指向早已作废的 seq 1（< 后面实时消息的 seq 4）
    const log = join(dir, "wake.log");
    const s = startServe(m.url, `echo "$PARTY_SEQ" >> ${log}`);
    await waitFor(() => m.received.some((f) => (f as { state?: string }).state === "waiting"));
    const seq = m.injectMsg({ sender: "alice", body: "@bot live", mentions: ["bot"] }); // seq=4 > seq_high=3
    await waitFor(() => existsSync(log));
    expect(readFileSync(log, "utf8").trim()).toBe(String(seq)); // 照常唤醒该帧
    expect(s.errs).toContain("warning: in-flight seq 1 was pruned; dropping");
    await waitFor(() => loadInflight(m.url, "mock") === null);
    await s.ctl().stop();
    await s.done;
  });
});

describe("serve FIFO 与连接生命周期", () => {
  test("忙时连发 3 条 @ → 严格串行、按序执行", async () => {
    const m = startMockChannel({ self: "bot" });
    stopMock = m.stop;
    const log = join(dir, "fifo.log");
    const s = startServe(m.url, `echo "start-$PARTY_SEQ" >> ${log}; sleep 0.15; echo "end-$PARTY_SEQ" >> ${log}`);
    await waitFor(() => m.received.some((f) => (f as { state?: string }).state === "waiting"));
    const s1 = m.injectMsg({ sender: "a", body: "@bot 1", mentions: ["bot"] });
    const s2 = m.injectMsg({ sender: "b", body: "@bot 2", mentions: ["bot"] });
    const s3 = m.injectMsg({ sender: "c", body: "@bot 3", mentions: ["bot"] });
    await waitFor(() => existsSync(log) && readFileSync(log, "utf8").trim().split("\n").length === 6, 10_000);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      `start-${s1}`, `end-${s1}`,
      `start-${s2}`, `end-${s2}`,
      `start-${s3}`, `end-${s3}`,
    ]);
    await s.ctl().stop();
    await s.done;
  });

  test("断线重连后重发 waiting status", async () => {
    const m = startMockChannel({ self: "bot", dropFirstConnection: true });
    stopMock = m.stop;
    const s = startServe(m.url, "true");
    await waitFor(
      () =>
        m.received.filter(
          (f) => (f as { state?: string; note?: string }).state === "waiting" &&
            (f as { note?: string }).note === "serve attached; mention me to wake",
        ).length >= 2,
      10_000,
    );
    await s.ctl().stop();
    await s.done;
  });

  test("终局 error{auth} → serve 抛 CliError(EXIT_AUTH)", async () => {
    const m = startMockChannel({ self: "bot" });
    stopMock = m.stop;
    const s = startServe(m.url, "true");
    await waitFor(() => m.received.some((f) => (f as { state?: string }).state === "waiting"));
    m.injectFrame({ type: "error", code: "auth", message: "token revoked" });
    await expect(s.done).rejects.toMatchObject({ code: 3 });
  });

  test("终局 error{archived} → serve 抛 CliError(EXIT_ARCHIVED)", async () => {
    const m = startMockChannel({ self: "bot" });
    stopMock = m.stop;
    const s = startServe(m.url, "true");
    await waitFor(() => m.received.some((f) => (f as { state?: string }).state === "waiting"));
    m.injectFrame({ type: "error", code: "archived", message: "channel archived" });
    await expect(s.done).rejects.toMatchObject({ code: 5 });
  });
});

describe("serve 单实例锁", () => {
  test("锁被活进程持有 → serve 立即抛 EXIT_ALREADY_SERVING", async () => {
    const m = startMockChannel({ self: "bot" });
    stopMock = m.stop;
    const release = acquireLock(m.url, "mock"); // 模拟已有 serve（本进程 pid，必然存活）
    try {
      await expect(serve(["--on-mention", "true"], { cfg: cfgFor(m.url) })).rejects.toMatchObject({ code: 10 });
    } finally {
      release();
    }
  });

  test("serve 正常结束后锁释放，可再次获取", async () => {
    const m = startMockChannel({ self: "bot" });
    stopMock = m.stop;
    const s = startServe(m.url, "true");
    await waitFor(() => m.received.some((f) => (f as { state?: string }).state === "waiting"));
    await s.ctl().stop();
    await s.done;
    const release = acquireLock(m.url, "mock"); // 锁已释放才拿得到
    release();
  });
});
