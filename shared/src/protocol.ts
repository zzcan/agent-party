// agentparty-mini wire protocol — worker 与 cli 的单一事实来源

export const BODY_LIMIT = 100_000;
export const RATE_LIMIT_PER_MIN = 30;
export const LOOP_GUARD_N = 30;
export const LOOP_GUARD_PARTY_N = 200;
export const RETAIN_N = 10_000;
export const PRESENCE_TIMEOUT_MS = 60_000;
export const IDEMPOTENCY_WINDOW_MS = 10 * 60_000;
export const IDEMPOTENCY_KEY_MAX = 128;
// "system" 是 loop guard 熔断通告的发信名，不得铸成真实 token
export const RESERVED_NAMES: readonly string[] = ["system"];

export type SenderKind = "agent" | "human";
export type ChannelMode = "normal" | "party";
export type StatusState = "working" | "waiting" | "blocked" | "done";
export type PresenceState = StatusState | "offline";
export type ErrorCode = "auth" | "archived" | "loop_guard" | "rate_limited" | "bad_frame";

export interface PresenceEntry {
  name: string;
  kind: SenderKind;
  state: PresenceState;
  note: string | null;
  last_seen: number;
}

export type SendFrame =
  | { type: "send"; kind: "message"; body: string; reply_to?: number; idem_key: string }
  | { type: "send"; kind: "status"; state: StatusState; note?: string };

export type ServerFrame =
  | {
      type: "hello";
      channel: string;
      self: string;
      seq_high: number;
      mode: ChannelMode;
      guard: number; // 解析后的熔断阈值，0 = 关闭
      presence: PresenceEntry[];
    }
  | { type: "sent"; seq: number; idem_key: string }
  | {
      type: "msg";
      seq: number;
      ts: number;
      sender: string;
      sender_kind: SenderKind;
      body: string;
      mentions: string[];
      reply_to: number | null;
    }
  | { type: "presence"; entry: PresenceEntry }
  | { type: "error"; code: ErrorCode; message: string };

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isName(s: unknown): s is string {
  return typeof s === "string" && NAME_RE.test(s);
}

export function resolveGuardLimit(mode: ChannelMode, guard_limit: number | null): number {
  if (guard_limit !== null) return guard_limit;
  return mode === "party" ? LOOP_GUARD_PARTY_N : LOOP_GUARD_N;
}

export function extractMentions(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/@([a-z0-9][a-z0-9-]{0,31})/g)) out.add(m[1]);
  return [...out];
}

const STATUS_STATES: readonly string[] = ["working", "waiting", "blocked", "done"];

export function parseSendFrame(raw: string): { frame: SendFrame } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { error: "not valid JSON" };
  }
  if (typeof v !== "object" || v === null) return { error: "frame must be an object" };
  const f = v as Record<string, unknown>;
  if (f.type !== "send") return { error: "type must be 'send'" };
  if (f.kind === "message") {
    if (typeof f.body !== "string" || f.body.length === 0) return { error: "body required" };
    if (f.body.length > BODY_LIMIT) return { error: `body exceeds ${BODY_LIMIT}` };
    if (typeof f.idem_key !== "string" || f.idem_key.length === 0) return { error: "idem_key required" };
    if (f.idem_key.length > IDEMPOTENCY_KEY_MAX) return { error: "idem_key too long" };
    if (f.reply_to !== undefined && (!Number.isInteger(f.reply_to) || (f.reply_to as number) < 1))
      return { error: "reply_to must be a positive integer" };
    return {
      frame: {
        type: "send",
        kind: "message",
        body: f.body,
        idem_key: f.idem_key,
        ...(f.reply_to !== undefined ? { reply_to: f.reply_to as number } : {}),
      },
    };
  }
  if (f.kind === "status") {
    if (typeof f.state !== "string" || !STATUS_STATES.includes(f.state))
      return { error: "state must be working|waiting|blocked|done" };
    if (f.note !== undefined && (typeof f.note !== "string" || f.note.length > 500))
      return { error: "note must be a string ≤500 chars" };
    return {
      frame: {
        type: "send",
        kind: "status",
        state: f.state as StatusState,
        ...(f.note !== undefined ? { note: f.note as string } : {}),
      },
    };
  }
  return { error: "kind must be 'message' or 'status'" };
}
