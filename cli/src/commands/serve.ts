// party serve — 常驻唤醒 supervisor：每条 @自己 的消息串行唤起一次本地命令。
// 消费判据 = 命令返回（含非零）；在飞标记保证"命令没返回就崩"的那条跨重启重放。
// 设计：docs/superpowers/specs/2026-07-14-plan3-serve-design.md
import type { ServerFrame } from "@agentparty-mini/shared";

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
