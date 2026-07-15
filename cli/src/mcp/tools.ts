import type { ServerFrame, StatusState } from "@agentparty-mini/shared";
import { loadMcpCursor, saveMcpCursor } from "../config";
import { openChannel } from "../ws";

export interface ToolCtx {
  server: string;
  token: string;
  defaultChannel: string;
}
export interface ToolDeps {
  open?: typeof openChannel;
  fetchImpl?: typeof fetch;
  loadCursor?: typeof loadMcpCursor;
  saveCursor?: typeof saveMcpCursor;
}
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
export const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export function chan(ctx: ToolCtx, args: Record<string, unknown>): string {
  const c = args.channel;
  return typeof c === "string" && c.length > 0 ? c : ctx.defaultChannel;
}

const STATES: StatusState[] = ["working", "waiting", "blocked", "done"];

export async function partySend(ctx: ToolCtx, args: Record<string, unknown>, deps: ToolDeps = {}): Promise<ToolResult> {
  try {
    const open = deps.open ?? openChannel;
    const text = args.text;
    if (typeof text !== "string" || text.length === 0) return err("text is required");
    const mentions = Array.isArray(args.mentions) ? (args.mentions as string[]) : [];
    let replyTo: number | undefined;
    if (args.reply_to !== undefined) {
      replyTo = Number(args.reply_to);
      if (!Number.isInteger(replyTo) || replyTo < 1) return err("reply_to must be a positive integer");
    }
    const body = [...mentions.map((m) => `@${m}`), text].join(" ");
    const idem = crypto.randomUUID();
    const ch = await open({ server: ctx.server, token: ctx.token }, chan(ctx, args));
    try {
      ch.send({ type: "send", kind: "message", body, idem_key: idem, ...(replyTo ? { reply_to: replyTo } : {}) });
      for await (const f of ch.frames) {
        if (f.type === "sent" && f.idem_key === idem) return ok(`sent #${f.seq}`);
        if (f.type === "error") return err(`send failed: ${f.message}`);
      }
      return err("connection closed before send was acknowledged");
    } finally {
      ch.close();
    }
  } catch (e) {
    return err(msg(e));
  }
}

export async function partyStatus(ctx: ToolCtx, args: Record<string, unknown>, deps: ToolDeps = {}): Promise<ToolResult> {
  try {
    const open = deps.open ?? openChannel;
    const state = args.state as StatusState;
    if (!STATES.includes(state)) return err("state must be working|waiting|blocked|done");
    const note = typeof args.note === "string" ? args.note : undefined;
    const ch = await open({ server: ctx.server, token: ctx.token }, chan(ctx, args));
    try {
      ch.send({ type: "send", kind: "status", state, ...(note ? { note } : {}) });
      for await (const f of ch.frames) {
        if (f.type === "presence" && f.entry.name === ch.hello.self && f.entry.state === state) return ok(`status set: ${state}`);
        if (f.type === "error") return err(`status failed: ${f.message}`);
      }
      return err("connection closed before status was acknowledged");
    } finally {
      ch.close();
    }
  } catch (e) {
    return err(msg(e));
  }
}

export async function partyWho(ctx: ToolCtx, args: Record<string, unknown>, deps: ToolDeps = {}): Promise<ToolResult> {
  try {
    const open = deps.open ?? openChannel;
    const ch = await open({ server: ctx.server, token: ctx.token }, chan(ctx, args));
    try {
      return ok(JSON.stringify(ch.hello.presence));
    } finally {
      ch.close();
    }
  } catch (e) {
    return err(msg(e));
  }
}

export async function partyRead(ctx: ToolCtx, args: Record<string, unknown>, deps: ToolDeps = {}): Promise<ToolResult> {
  try {
    const open = deps.open ?? openChannel;
    const load = deps.loadCursor ?? loadMcpCursor;
    const save = deps.saveCursor ?? saveMcpCursor;
    const channel = chan(ctx, args);
    let usePersistent = true;
    let cursor: number;
    if (args.after !== undefined) {
      cursor = Number(args.after);
      if (!Number.isInteger(cursor) || cursor < 0) return err("after must be a non-negative integer");
      usePersistent = false;
    } else {
      cursor = load(ctx.server, channel);
    }
    const ch = await open({ server: ctx.server, token: ctx.token }, channel, { after: cursor });
    try {
      const seqHigh = ch.hello.seq_high;
      const messages: Array<Record<string, unknown>> = [];
      let last = cursor;
      if (cursor < seqHigh) {
        for await (const f of ch.frames) {
          if (f.type === "msg") {
            messages.push({
              seq: f.seq, ts: f.ts, sender: f.sender, sender_kind: f.sender_kind,
              body: f.body, mentions: f.mentions, reply_to: f.reply_to,
            });
            last = f.seq;
            if (last >= seqHigh) break;
          } else if (f.type === "error") {
            return err(`read failed: ${f.message}`);
          }
        }
      }
      if (usePersistent && last > cursor) save(ctx.server, channel, last);
      return ok(JSON.stringify({ messages, cursor: last }));
    } finally {
      ch.close();
    }
  } catch (e) {
    return err(msg(e));
  }
}
