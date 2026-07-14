import {
  extractMentions,
  IDEMPOTENCY_WINDOW_MS,
  LOOP_GUARD_N,
  PRESENCE_TIMEOUT_MS,
  RATE_LIMIT_PER_MIN,
  RETAIN_N,
  type PresenceEntry,
  type SendFrame,
  type SenderKind,
  type ServerFrame,
  parseSendFrame,
} from "@agentparty-mini/shared";
import { Server, type Connection, type ConnectionContext, type WSMessage } from "partyserver";
import type { Env } from "./index";

export interface ConnState {
  name: string;
  kind: SenderKind;
  hash: string;
}

type TaskState = "backlog" | "in_progress" | "blocked" | "done";
interface TaskObj {
  id: number;
  title: string;
  state: TaskState;
  assignee: string | null;
  created_by: string;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
}

export class ChannelDO extends Server<Env> {
  private get db() {
    return this.ctx.storage.sql;
  }

  // token 吊销即时生效：D1 查询 + 内存缓存，TTL 生产 60s、测试 0（AUTH_CACHE_TTL_MS 覆盖）
  private tokenCache = new Map<string, { ok: boolean; at: number }>();

  private async tokenActive(hash: string): Promise<boolean> {
    const ttl = Number(this.env.AUTH_CACHE_TTL_MS ?? 60_000);
    const cached = this.tokenCache.get(hash);
    if (cached && Date.now() - cached.at < ttl) return cached.ok;
    try {
      const row = await this.env.DB.prepare("SELECT 1 AS ok FROM tokens WHERE hash = ? AND revoked_at IS NULL")
        .bind(hash)
        .first();
      const ok = row !== null;
      this.tokenCache.set(hash, { ok, at: Date.now() });
      return ok;
    } catch (e) {
      // D1 抖了一下：onMessage 只 .catch(console.error)，这里若抛出会让客户端既收不到
      // sent 也收不到 error，卡到自己的超时。宁可失活即通（fail-open）：有旧缓存就信旧缓存
      // （哪怕已过期），没有就当作有效；绝不能把这次兜底结果当权威值写回缓存。
      console.error("tokenActive: D1 query failed, failing open", e);
      if (cached) return cached.ok;
      return true;
    }
  }

  async onAlarm() {
    const liveNames = new Set<string>();
    for (const conn of this.getConnections<ConnState>()) {
      if (conn.state?.name) liveNames.add(conn.state.name);
    }
    const ghosts = this.db
      .exec("SELECT name FROM presence WHERE connected = 1")
      .toArray()
      .map((r) => String(r.name))
      .filter((n) => !liveNames.has(n));
    for (const name of ghosts) {
      this.db.exec("UPDATE presence SET connected = 0 WHERE name = ?", name);
      this.broadcastFrame({ type: "presence", entry: this.presenceEntry(name) });
    }
    if (liveNames.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + PRESENCE_TIMEOUT_MS);
    }
  }

  onStart() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      sender TEXT NOT NULL,
      sender_kind TEXT NOT NULL,
      body TEXT NOT NULL,
      mentions TEXT NOT NULL,
      reply_to INTEGER,
      idem_key TEXT
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_idem ON messages(idem_key)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS presence (
      name TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      note TEXT,
      last_seen INTEGER NOT NULL,
      connected INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS rate (name TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)`,
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'backlog',
      assignee TEXT,
      created_by TEXT NOT NULL,
      blocked_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  protected getMeta(key: string): string | null {
    const row = this.db.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? String(row.value) : null;
  }

  protected setMeta(key: string, value: string) {
    this.db.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  protected seqHigh(): number {
    const row = this.db.exec("SELECT COALESCE(MAX(seq), 0) AS s FROM messages").toArray()[0];
    return Number(row.s);
  }

  protected sendFrame(conn: Connection, frame: ServerFrame) {
    conn.send(JSON.stringify(frame));
  }

  protected broadcastFrame(frame: ServerFrame) {
    this.broadcast(JSON.stringify(frame));
  }

  protected presenceEntry(name: string): PresenceEntry {
    const r = this.db
      .exec("SELECT name, kind, state, note, last_seen, connected FROM presence WHERE name = ?", name)
      .toArray()[0];
    return {
      name: String(r.name),
      kind: r.kind === "agent" ? "agent" : "human",
      state: Number(r.connected) === 1 ? (String(r.state) as PresenceEntry["state"]) : "offline",
      note: r.note === null ? null : String(r.note),
      last_seen: Number(r.last_seen),
    };
  }

  protected presenceList(): PresenceEntry[] {
    return this.db
      .exec("SELECT name FROM presence ORDER BY name")
      .toArray()
      .map((r) => this.presenceEntry(String(r.name)));
  }

  private rateLimited(name: string, now: number): boolean {
    const limit = Number(this.env.RATE_LIMIT_PER_MIN ?? RATE_LIMIT_PER_MIN);
    const row = this.db.exec("SELECT window_start, count FROM rate WHERE name = ?", name).toArray()[0];
    if (!row || now - Number(row.window_start) >= 60_000) {
      this.db.exec(
        `INSERT INTO rate (name, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(name) DO UPDATE SET window_start = excluded.window_start, count = 1`,
        name,
        now,
      );
      return false;
    }
    if (Number(row.count) >= limit) return true;
    this.db.exec("UPDATE rate SET count = count + 1 WHERE name = ?", name);
    return false;
  }

  private insertSystemMessage(body: string, now: number) {
    const seq = Number(
      this.db
        .exec(
          `INSERT INTO messages (ts, sender, sender_kind, body, mentions, reply_to, idem_key)
           VALUES (?, 'system', 'agent', ?, '[]', NULL, NULL) RETURNING seq`,
          now,
          body,
        )
        .toArray()[0].seq,
    );
    this.broadcastFrame({
      type: "msg",
      seq,
      ts: now,
      sender: "system",
      sender_kind: "agent",
      body,
      mentions: [],
      reply_to: null,
    });
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/config") {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return new Response("bad request", { status: 400 });
      }
      if (typeof raw !== "object" || raw === null) {
        return new Response("bad request", { status: 400 });
      }
      const patch = raw as { guard?: unknown; archived?: unknown };
      // 严格校验字段类型：非法 guard（如 NaN）绝不能静默关闭熔断
      if (typeof patch.guard === "number" && Number.isFinite(patch.guard)) {
        this.setMeta("guard", String(patch.guard));
      }
      if (typeof patch.archived === "boolean") {
        this.setMeta("archived", patch.archived ? "1" : "0");
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/internal/tasks") {
      if (request.method === "POST") return this.taskCreate(request);
      if (request.method === "GET") return this.taskList();
      return new Response("method not allowed", { status: 405 });
    }
    const taskMatch = url.pathname.match(/^\/internal\/tasks\/(\d+)$/);
    if (taskMatch && request.method === "PATCH") {
      return this.taskPatch(Number(taskMatch[1]), request);
    }
    return new Response("not found", { status: 404 });
  }

  private rowToMsg(r: Record<string, unknown>): ServerFrame {
    return {
      type: "msg",
      seq: Number(r.seq),
      ts: Number(r.ts),
      sender: String(r.sender),
      sender_kind: r.sender_kind === "agent" ? "agent" : "human",
      body: String(r.body),
      mentions: JSON.parse(String(r.mentions)) as string[],
      reply_to: r.reply_to === null ? null : Number(r.reply_to),
    };
  }

  onConnect(connection: Connection<ConnState>, ctx: ConnectionContext) {
    const h = ctx.request.headers;
    const state: ConnState = {
      name: h.get("x-ap-name") ?? "",
      kind: h.get("x-ap-kind") === "agent" ? "agent" : "human",
      hash: h.get("x-ap-hash") ?? "",
    };
    connection.setState(state);
    // 频道配置随升级头进来缓存进 meta；配置变更端点会 poke /internal/config 刷新（Task 9/10）
    const mode = h.get("x-ap-mode") === "party" ? "party" : "normal";
    this.setMeta("mode", mode);
    this.setMeta("guard", h.get("x-ap-guard") ?? String(LOOP_GUARD_N));
    if (h.get("x-ap-archived") === "1") this.setMeta("archived", "1");
    if (this.getMeta("archived") === "1") {
      this.sendFrame(connection, { type: "error", code: "archived", message: "channel is archived" });
      connection.close(1008, "archived");
      return;
    }
    this.db.exec(
      `INSERT INTO presence (name, kind, state, note, last_seen, connected) VALUES (?, ?, 'waiting', NULL, ?, 1)
       ON CONFLICT(name) DO UPDATE SET connected = 1, kind = excluded.kind, last_seen = excluded.last_seen`,
      state.name,
      state.kind,
      Date.now(),
    );
    this.sendFrame(connection, {
      type: "hello",
      channel: this.name,
      self: state.name,
      seq_high: this.seqHigh(),
      mode,
      guard: Number(this.getMeta("guard") ?? LOOP_GUARD_N),
      presence: this.presenceList(),
    });
    // 断线补拉：hello 之后、实时流之前回放历史
    const after = Number(new URL(ctx.request.url).searchParams.get("after") ?? NaN);
    if (Number.isInteger(after) && after >= 0) {
      const rows = this.db
        .exec(
          "SELECT seq, ts, sender, sender_kind, body, mentions, reply_to FROM messages WHERE seq > ? ORDER BY seq",
          after,
        )
        .toArray();
      for (const r of rows) this.sendFrame(connection, this.rowToMsg(r));
    }
    this.broadcastFrame({ type: "presence", entry: this.presenceEntry(state.name) });
    // presence 超时扫描自排：只前移不后移，避免推迟已存在的更早闹钟
    void this.ctx.storage.getAlarm().then((at) => {
      const next = Date.now() + PRESENCE_TIMEOUT_MS;
      if (at === null || at > next) void this.ctx.storage.setAlarm(next);
    });
  }

  onClose(connection: Connection<ConnState>) {
    const name = connection.state?.name;
    if (!name) return;
    // 同名可能多开连接，全下线才算离场
    for (const other of this.getConnections<ConnState>()) {
      if (other.id !== connection.id && other.state?.name === name) return;
    }
    this.db.exec("UPDATE presence SET connected = 0, last_seen = ? WHERE name = ?", Date.now(), name);
    this.broadcastFrame({ type: "presence", entry: this.presenceEntry(name) });
  }

  async onMessage(connection: Connection<ConnState>, message: WSMessage) {
    const state = connection.state;
    if (!state) return;
    const parsed = parseSendFrame(typeof message === "string" ? message : "");
    if ("error" in parsed) {
      this.sendFrame(connection, { type: "error", code: "bad_frame", message: parsed.error });
      return;
    }
    if (this.getMeta("archived") === "1") {
      this.sendFrame(connection, { type: "error", code: "archived", message: "channel is archived" });
      connection.close(1008, "archived");
      return;
    }
    if (!(await this.tokenActive(state.hash))) {
      this.sendFrame(connection, { type: "error", code: "auth", message: "token revoked" });
      connection.close(1008, "auth");
      return;
    }
    const now = Date.now();
    this.db.exec("UPDATE presence SET last_seen = ? WHERE name = ?", now, state.name);
    if (parsed.frame.kind === "status") {
      this.handleStatus(state, parsed.frame, now);
      return;
    }
    this.handleMessage(connection, state, parsed.frame, now);
  }

  private handleStatus(state: ConnState, frame: SendFrame & { kind: "status" }, now: number) {
    this.db.exec(
      "UPDATE presence SET state = ?, note = ?, last_seen = ? WHERE name = ?",
      frame.state,
      frame.note ?? null,
      now,
      state.name,
    );
    this.broadcastFrame({ type: "presence", entry: this.presenceEntry(state.name) });
  }

  private handleMessage(
    connection: Connection<ConnState>,
    state: ConnState,
    frame: SendFrame & { kind: "message" },
    now: number,
  ) {
    if (this.rateLimited(state.name, now)) {
      this.sendFrame(connection, {
        type: "error",
        code: "rate_limited",
        message: "rate limit exceeded, slow down",
      });
      return;
    }
    // loop guard：连续 agent 消息熔断，human 发言即人类锚点
    const guardLimit = Number(this.getMeta("guard") ?? 0);
    if (state.kind === "agent" && guardLimit > 0) {
      const streak = Number(this.getMeta("agent_streak") ?? "0");
      if (streak >= guardLimit) {
        if (this.getMeta("guard_tripped") !== "1") {
          this.setMeta("guard_tripped", "1");
          this.insertSystemMessage(
            `loop guard: ${guardLimit} consecutive agent messages, agents are paused until a human speaks`,
            now,
          );
        }
        this.sendFrame(connection, {
          type: "error",
          code: "loop_guard",
          message: `loop guard tripped (limit ${guardLimit}); a human must speak to reset`,
        });
        return;
      }
    }
    // 幂等：窗口内同 key 重发 sent（同 seq），不落新行不广播
    const dup = this.db
      .exec(
        "SELECT seq FROM messages WHERE idem_key = ? AND ts > ?",
        frame.idem_key,
        now - IDEMPOTENCY_WINDOW_MS,
      )
      .toArray()[0];
    if (dup) {
      this.sendFrame(connection, { type: "sent", seq: Number(dup.seq), idem_key: frame.idem_key });
      return;
    }
    const mentions = extractMentions(frame.body);
    const seq = Number(
      this.db
        .exec(
          `INSERT INTO messages (ts, sender, sender_kind, body, mentions, reply_to, idem_key)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
          now,
          state.name,
          state.kind,
          frame.body,
          JSON.stringify(mentions),
          frame.reply_to ?? null,
          frame.idem_key,
        )
        .toArray()[0].seq,
    );
    // 修剪超出保留窗口的最老消息（seq 不复用）
    const retainN = Number(this.env.RETAIN_N ?? RETAIN_N);
    this.db.exec("DELETE FROM messages WHERE seq <= ?", seq - retainN);
    // 自回声顺序：发送方先收 sent 再看到自己的广播
    this.sendFrame(connection, { type: "sent", seq, idem_key: frame.idem_key });
    this.broadcastFrame({
      type: "msg",
      seq,
      ts: now,
      sender: state.name,
      sender_kind: state.kind,
      body: frame.body,
      mentions,
      reply_to: frame.reply_to ?? null,
    });
    if (state.kind === "human") {
      this.setMeta("agent_streak", "0");
      this.setMeta("guard_tripped", "0");
    } else {
      this.setMeta("agent_streak", String(Number(this.getMeta("agent_streak") ?? "0") + 1));
    }
  }

  private taskErr(status: number, message: string): Response {
    return Response.json({ error: message }, { status });
  }

  private rowToTask(r: Record<string, unknown>): TaskObj {
    return {
      id: Number(r.id),
      title: String(r.title),
      state: String(r.state) as TaskState,
      assignee: r.assignee === null ? null : String(r.assignee),
      created_by: String(r.created_by),
      blocked_reason: r.blocked_reason === null ? null : String(r.blocked_reason),
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
    };
  }

  private getTask(id: number): TaskObj | null {
    const r = this.db
      .exec(
        "SELECT id, title, state, assignee, created_by, blocked_reason, created_at, updated_at FROM tasks WHERE id = ?",
        id,
      )
      .toArray()[0];
    return r ? this.rowToTask(r) : null;
  }

  private taskList(): Response {
    const rows = this.db
      .exec(
        "SELECT id, title, state, assignee, created_by, blocked_reason, created_at, updated_at FROM tasks ORDER BY id",
      )
      .toArray();
    return Response.json({ tasks: rows.map((r) => this.rowToTask(r)) });
  }

  private async taskCreate(request: Request): Promise<Response> {
    const name = request.headers.get("x-ap-name") ?? "";
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return this.taskErr(400, "invalid json");
    }
    const title = (raw as { title?: unknown })?.title;
    if (typeof title !== "string" || title.length === 0 || title.length > 200) {
      return this.taskErr(400, "title required, 1..200 chars");
    }
    const now = Date.now();
    const id = Number(
      this.db
        .exec(
          `INSERT INTO tasks (title, state, assignee, created_by, blocked_reason, created_at, updated_at)
           VALUES (?, 'backlog', NULL, ?, NULL, ?, ?) RETURNING id`,
          title,
          name,
          now,
          now,
        )
        .toArray()[0].id,
    );
    this.insertSystemMessage(`${name} 创建了 #${id}：${title}`, now);
    return Response.json(this.getTask(id), { status: 201 });
  }

  private async taskPatch(id: number, request: Request): Promise<Response> {
    const name = request.headers.get("x-ap-name") ?? "";
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return this.taskErr(400, "invalid json");
    }
    const { action, reason } = (raw ?? {}) as { action?: unknown; reason?: unknown };
    const task = this.getTask(id);
    if (!task) return this.taskErr(404, `task #${id} not found`);
    const now = Date.now();
    if (action === "claim") {
      if (task.state === "done") return this.taskErr(400, "cannot claim a completed task");
      this.db.exec(
        "UPDATE tasks SET state = 'in_progress', assignee = ?, blocked_reason = NULL, updated_at = ? WHERE id = ?",
        name,
        now,
        id,
      );
      this.insertSystemMessage(`${name} 认领了 #${id}`, now);
    } else if (action === "done") {
      if (task.state === "done") return this.taskErr(400, "task already completed");
      this.db.exec("UPDATE tasks SET state = 'done', blocked_reason = NULL, updated_at = ? WHERE id = ?", now, id);
      this.insertSystemMessage(`${name} 完成了 #${id}`, now);
    } else if (action === "block") {
      if (typeof reason !== "string" || reason.length === 0 || reason.length > 500) {
        return this.taskErr(400, "reason required, 1..500 chars");
      }
      if (task.state !== "backlog" && task.state !== "in_progress") {
        return this.taskErr(400, `cannot block a ${task.state} task`);
      }
      this.db.exec(
        "UPDATE tasks SET state = 'blocked', blocked_reason = ?, updated_at = ? WHERE id = ?",
        reason,
        now,
        id,
      );
      this.insertSystemMessage(`${name} 阻塞了 #${id}：${reason}`, now);
    } else {
      return this.taskErr(400, "action must be claim|done|block");
    }
    return Response.json(this.getTask(id));
  }
}
