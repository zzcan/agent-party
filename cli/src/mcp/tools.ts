import type { StatusState } from "@agentparty-mini/shared";
import { loadMcpCursor, saveMcpCursor } from "../config";
import { openChannel } from "../ws";
import { createTask, listTasks, updateTask, type RestOpts } from "../rest";

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
    const mentions = Array.isArray(args.mentions)
      ? (args.mentions as unknown[]).filter((m): m is string => typeof m === "string")
      : [];
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

export async function partyTaskList(ctx: ToolCtx, args: Record<string, unknown>, deps: ToolDeps = {}): Promise<ToolResult> {
  try {
    const f = deps.fetchImpl ?? fetch;
    const o: RestOpts = { server: ctx.server, token: ctx.token };
    const res = await listTasks(o, chan(ctx, args), f);
    return ok(JSON.stringify(res));
  } catch (e) {
    return err(msg(e));
  }
}

export async function partyTaskUpdate(ctx: ToolCtx, args: Record<string, unknown>, deps: ToolDeps = {}): Promise<ToolResult> {
  try {
    const f = deps.fetchImpl ?? fetch;
    const o: RestOpts = { server: ctx.server, token: ctx.token };
    const channel = chan(ctx, args);
    const action = args.action;
    if (action === "create") {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!title) return err("title is required for create");
      const t = (await createTask(o, channel, title, f)) as { id: number; title: string };
      return ok(`created #${t.id}: ${t.title}`);
    }
    if (action === "claim" || action === "done") {
      const id = typeof args.id === "number" ? args.id : NaN;
      if (!Number.isInteger(id) || id < 1) return err(`id is required for ${action}`);
      await updateTask(o, channel, id, action, undefined, f);
      return ok(action === "claim" ? `claimed #${id}` : `completed #${id}`);
    }
    if (action === "block") {
      const id = typeof args.id === "number" ? args.id : NaN;
      if (!Number.isInteger(id) || id < 1) return err("id is required for block");
      const reason = typeof args.reason === "string" ? args.reason.trim() : "";
      if (!reason) return err("reason is required for block");
      await updateTask(o, channel, id, "block", reason, f);
      return ok(`blocked #${id}`);
    }
    return err("action must be create|claim|done|block");
  } catch (e) {
    return err(msg(e));
  }
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (ctx: ToolCtx, args: Record<string, unknown>, deps?: ToolDeps) => Promise<ToolResult>;
}

const CHANNEL_PROP = { channel: { type: "string", description: "频道 slug，缺省用绑定频道" } };

export const TOOLS: ToolDef[] = [
  {
    name: "party_send",
    description: "在频道发一条消息，可 @mention、可回复某条 seq。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "消息正文" },
        mentions: { type: "array", items: { type: "string" }, description: "被 @ 的身份名列表" },
        reply_to: { type: "integer", minimum: 1, description: "回复的消息 seq" },
        ...CHANNEL_PROP,
      },
      required: ["text"],
    },
    handler: partySend,
  },
  {
    name: "party_read",
    description: "按游标读增量消息。缺省从 MCP 独立游标续读并推进；给 after 则一次性回看不改游标。返回 {messages, cursor}。",
    inputSchema: {
      type: "object",
      properties: {
        after: { type: "integer", minimum: 0, description: "一次性回看的起点 seq（不改持久游标）" },
        ...CHANNEL_PROP,
      },
    },
    handler: partyRead,
  },
  {
    name: "party_status",
    description: "更新自己在频道的状态（presence）。",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["working", "waiting", "blocked", "done"] },
        note: { type: "string", description: "可选备注" },
        ...CHANNEL_PROP,
      },
      required: ["state"],
    },
    handler: partyStatus,
  },
  {
    name: "party_who",
    description: "列出频道当前在线名单（presence）。",
    inputSchema: { type: "object", properties: { ...CHANNEL_PROP } },
    handler: partyWho,
  },
  {
    name: "party_task_list",
    description: "列出频道全部任务。",
    inputSchema: { type: "object", properties: { ...CHANNEL_PROP } },
    handler: partyTaskList,
  },
  {
    name: "party_task_update",
    description: "创建或流转任务：create 需 title；claim/done 需 id；block 需 id+reason。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "claim", "done", "block"] },
        title: { type: "string", description: "create 用" },
        id: { type: "integer", minimum: 1, description: "claim/done/block 用" },
        reason: { type: "string", description: "block 用" },
        ...CHANNEL_PROP,
      },
      required: ["action"],
    },
    handler: partyTaskUpdate,
  },
];
