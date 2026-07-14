// party serve — 常驻唤醒 supervisor：每条 @自己 的消息串行唤起一次本地命令。
// 消费判据 = 命令返回（含非零）；在飞标记保证"命令没返回就崩"的那条跨重启重放。
// 设计：docs/superpowers/specs/2026-07-14-plan3-serve-design.md
import { EXIT_ERROR, type ServerFrame } from "@agentparty-mini/shared";
import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../args";
import {
  clearInflight,
  loadConfig,
  loadCursor,
  loadInflight,
  resolveChannel,
  saveCursor,
  saveInflight,
  type Config,
} from "../config";
import { CliError } from "../errors";
import { acquireLock } from "../lock";
import { exitCodeFor, openChannel as defaultOpen } from "../ws";

export type MsgFrame = Extract<ServerFrame, { type: "msg" }>;

export const RECENT_MAX = 20;
export const RECENT_BODY_MAX = 400;

export interface RecentEntry {
  seq: number;
  sender: string;
  sender_kind: "agent" | "human";
  body: string;
  ts: number;
}

export interface WakeContext {
  channel: string;
  seq: number;
  sender: string;
  sender_kind: "agent" | "human";
  body: string;
  mentions: string[];
  reply_to: number;
  self: string;
  recent: RecentEntry[];
}

export function shouldWake(f: MsgFrame, self: string): boolean {
  return f.mentions.includes(self) && f.sender !== self;
}

export function buildWakeContext(f: MsgFrame, self: string, channel: string, recent: MsgFrame[]): WakeContext {
  return {
    channel,
    seq: f.seq,
    sender: f.sender,
    sender_kind: f.sender_kind,
    body: f.body,
    mentions: f.mentions,
    reply_to: f.seq,
    self,
    recent: recent.slice(-RECENT_MAX).map((m) => ({
      seq: m.seq,
      sender: m.sender,
      sender_kind: m.sender_kind,
      body: m.body.length > RECENT_BODY_MAX ? m.body.slice(0, RECENT_BODY_MAX) : m.body,
      ts: m.ts,
    })),
  };
}

export interface ServeControl {
  stop(): Promise<void>;
}

export interface ServeDeps {
  open?: typeof defaultOpen;
  cfg?: Config;
  /** 测试注入 context 目录；默认 mkdtemp 0700 */
  contextDir?: string;
  err?: (line: string) => void;
  onStart?: (ctl: ServeControl) => void;
}

const KILL_GRACE_MS = 5_000;

export async function serve(argv: string[], deps: ServeDeps = {}): Promise<void> {
  const { flags } = parseArgs(argv, { value: ["on-mention", "channel", "server", "token"] });
  const cmdTemplate = flags["on-mention"] as string | undefined;
  if (!cmdTemplate) throw new CliError(EXIT_ERROR, "serve requires --on-mention '<cmd>'");
  const cfg = deps.cfg ?? loadConfig();
  const open = deps.open ?? defaultOpen;
  const channel = resolveChannel(cfg, flags.channel as string | undefined);
  const server = (flags.server as string | undefined) ?? cfg.server;
  const token = (flags.token as string | undefined) ?? cfg.token;
  const err = deps.err ?? ((l: string) => process.stderr.write(`${l}\n`));
  // 用解析后的 server（含 --server 覆盖）给游标/在飞/锁键，避免连一个 server 却读另一个的游标
  const releaseLock = acquireLock(server, channel);
  const contextDir = deps.contextDir ?? mkdtempSync(join(tmpdir(), "party-serve-"));

  const st = {
    stopping: false,
    child: null as ReturnType<typeof Bun.spawn> | null,
    ch: null as Awaited<ReturnType<typeof defaultOpen>> | null,
  };

  let signal: NodeJS.Signals | null = null;
  const onSigint = () => {
    signal = "SIGINT";
    void stop();
  };
  const onSigterm = () => {
    signal = "SIGTERM";
    void stop();
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const recent: MsgFrame[] = [];
  const recentPush = (f: MsgFrame) => {
    recent.push(f);
    if (recent.length > RECENT_MAX) recent.shift();
  };

  const stop = async (): Promise<void> => {
    st.stopping = true;
    const child = st.child;
    if (child) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      await child.exited;
      clearTimeout(force);
    }
    st.ch?.close();
  };
  deps.onStart?.({ stop });

  const sendStatus = (state: "working" | "waiting" | "blocked", note?: string) => {
    // presence 尽力而为：发不出去（断线间隙）不影响主流程
    try {
      st.ch?.send({ type: "send", kind: "status", state, ...(note !== undefined ? { note } : {}) });
    } catch {
      /* 吞掉 */
    }
  };

  let self = cfg.name;

  const runWake = async (f: MsgFrame): Promise<void> => {
    saveInflight(server, channel, f.seq);
    sendStatus("working", `handling seq=${f.seq}`);
    const ctxPath = join(contextDir, `${f.seq}.json`);
    writeFileSync(ctxPath, `${JSON.stringify(buildWakeContext(f, self, channel, recent), null, 2)}\n`, {
      mode: 0o600,
    });
    const cmd = cmdTemplate.includes("{file}") ? cmdTemplate.replaceAll("{file}", ctxPath) : cmdTemplate;
    const proc = Bun.spawn(["sh", "-c", cmd], {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        PARTY_CONTEXT_FILE: ctxPath,
        PARTY_SEQ: String(f.seq),
        PARTY_CHANNEL: channel,
        PARTY_SENDER: f.sender,
      },
    });
    st.child = proc;
    const code = await proc.exited;
    st.child = null;
    // 被 stop 杀掉 ≠ 命令自己返回：不消费，游标与在飞标记原样留给重启重放
    if (st.stopping) return;
    if (f.seq > loadCursor(server, channel)) saveCursor(server, channel, f.seq);
    clearInflight(server, channel);
    if (code === 0) {
      try {
        unlinkSync(ctxPath);
      } catch {
        /* 清理失败无所谓 */
      }
      sendStatus("waiting");
    } else {
      err(`wake command failed (exit ${code}) for seq ${f.seq}, context kept: ${ctxPath}`);
      sendStatus("blocked", `wake command failed (exit ${code}) for seq ${f.seq}`);
    }
  };

  try {
    const ch = await open(
      { server, token },
      channel,
      {
        after: loadCursor(server, channel),
        reconnect: true,
        onReconnect: () => sendStatus("waiting", "serve attached; mention me to wake"),
      },
    );
    st.ch = ch;
    self = ch.hello.self;
    const seqHigh = ch.hello.seq_high;
    const cursor0 = loadCursor(server, channel);
    let inflightPending = loadInflight(server, channel);
    sendStatus("waiting", "serve attached; mention me to wake");
    if (seqHigh > cursor0) {
      err(`skipped ${seqHigh - cursor0} messages up to seq ${seqHigh}`);
      saveCursor(server, channel, seqHigh);
    }
    for await (const f of ch.frames) {
      if (st.stopping) break;
      if (f.type === "error") {
        if (f.code === "auth" || f.code === "archived") throw new CliError(exitCodeFor(f.code), f.message);
        err(`! ${f.code}: ${f.message}`);
        continue;
      }
      if (f.type !== "msg") continue;
      // 在飞欠账：标记指向的那条恰好重放；补拉第一条已越过它 = 被修剪，响亮放弃
      if (inflightPending !== null) {
        if (f.seq === inflightPending) {
          inflightPending = null;
          if (shouldWake(f, self)) {
            await runWake(f);
          } else {
            clearInflight(server, channel);
          }
          recentPush(f);
          continue;
        }
        if (f.seq > inflightPending) {
          err(`warning: in-flight seq ${inflightPending} was pruned; dropping`);
          clearInflight(server, channel);
          inflightPending = null;
        }
      }
      if (f.seq <= seqHigh) {
        // 冷积压：不唤醒，但 @自己 的要让人看见
        if (shouldWake(f, self)) err(`warning: skipped mention of you at seq ${f.seq}`);
      } else if (shouldWake(f, self)) {
        await runWake(f);
      }
      recentPush(f);
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    releaseLock();
    // context 目录：无残留则删；有失败残留则保留并报路径
    try {
      if (readdirSync(contextDir).length === 0) rmSync(contextDir, { recursive: true, force: true });
      else err(`kept failed wake contexts in ${contextDir}`);
    } catch {
      /* 目录可能已不存在 */
    }
  }
  if (signal !== null) process.exit(signal === "SIGINT" ? 130 : 143);
}
