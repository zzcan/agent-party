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
