import type { ServerWebSocket } from "bun";
import type { PresenceEntry, ServerFrame } from "@agentparty-mini/shared";

export interface MockHistoryEntry {
  seq: number;
  sender: string;
  body: string;
  mentions?: string[];
  sender_kind?: "agent" | "human";
}

export interface MockOpts {
  self: string; // 连接者身份（hello.self）
  kind?: "agent" | "human";
  presence?: PresenceEntry[]; // hello.presence
  mode?: "normal" | "party";
  guard?: number;
  history?: MockHistoryEntry[]; // 供 ?after= 补拉
  connectError?: { code: string; message: string }; // 若设，连接即发 error+close(1008)，不发 hello
  dropFirstConnection?: boolean; // 第一条连接发完 hello 后立即 close（测重连）
  errorAfterHello?: { code: string; message: string }; // 若设，hello 之后收到的第一条客户端消息回复 error 而非正常处理
}

type Sock = ServerWebSocket<{ url: string }>;

export function startMockChannel(opts: MockOpts) {
  const history: MockHistoryEntry[] = [...(opts.history ?? [])];
  let seqCounter = history.length ? Math.max(...history.map((h) => h.seq)) : 0;
  let connectionCount = 0;
  let sentErrorAfterHello = false;
  const kind = opts.kind ?? "human";
  const sockets = new Set<Sock>();
  const received: unknown[] = [];

  const msgFrame = (h: MockHistoryEntry): ServerFrame => ({
    type: "msg",
    seq: h.seq,
    ts: 0,
    sender: h.sender,
    sender_kind: h.sender_kind ?? "human",
    body: h.body,
    mentions: h.mentions ?? [],
    reply_to: null,
  });

  const server = Bun.serve<{ url: string }, never>({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: { url: req.url } })) return;
      return new Response("expected websocket", { status: 426 });
    },
    websocket: {
      open(ws) {
        connectionCount++;
        const url = new URL((ws.data as { url: string }).url);
        // 对齐真实服务端语义：缺 after 参数 = 不补拉（用 null 标记）。绝不能默认成 0，
        // 否则 mock 会对「无 after」补拉全部，与真服务端相反，让协议 bug 被单测掩盖。
        const afterParam = url.searchParams.get("after");
        const after = afterParam === null ? null : Number(afterParam);
        if (opts.connectError) {
          ws.send(JSON.stringify({ type: "error", ...opts.connectError }));
          ws.close(1008, opts.connectError.code);
          return;
        }
        sockets.add(ws);
        const hello: ServerFrame = {
          type: "hello",
          channel: "mock",
          self: opts.self,
          seq_high: seqCounter,
          mode: opts.mode ?? "normal",
          guard: opts.guard ?? 30,
          presence: opts.presence ?? [{ name: opts.self, kind, state: "waiting", note: null, last_seen: 0 }],
        };
        ws.send(JSON.stringify(hello));
        for (const h of history) {
          if (after !== null && h.seq > after) ws.send(JSON.stringify(msgFrame(h)));
        }
        if (opts.dropFirstConnection && connectionCount === 1) {
          setTimeout(() => ws.close(1006, "drop"), 20);
        }
      },
      close(ws) {
        sockets.delete(ws as Sock);
      },
      message(ws, raw) {
        const frame = JSON.parse(String(raw));
        received.push(frame);
        if (opts.errorAfterHello && !sentErrorAfterHello) {
          sentErrorAfterHello = true;
          ws.send(JSON.stringify({ type: "error", ...opts.errorAfterHello }));
          return;
        }
        if (frame.kind === "message") {
          const seq = ++seqCounter;
          ws.send(JSON.stringify({ type: "sent", seq, idem_key: frame.idem_key } satisfies ServerFrame));
          ws.send(
            JSON.stringify({
              type: "msg",
              seq,
              ts: 0,
              sender: opts.self,
              sender_kind: kind,
              body: frame.body,
              mentions: [],
              reply_to: frame.reply_to ?? null,
            } satisfies ServerFrame),
          );
        } else if (frame.kind === "status") {
          ws.send(
            JSON.stringify({
              type: "presence",
              entry: { name: opts.self, kind, state: frame.state, note: frame.note ?? null, last_seen: 0 },
            } satisfies ServerFrame),
          );
        }
      },
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    received,
    injectMsg(m: { sender: string; body: string; mentions?: string[]; sender_kind?: "agent" | "human" }): number {
      const seq = ++seqCounter;
      const entry: MockHistoryEntry = { seq, ...m };
      history.push(entry); // 进 history：重连补拉可见
      const payload = JSON.stringify(msgFrame(entry));
      for (const s of sockets) s.send(payload);
      return seq;
    },
    injectFrame(frame: ServerFrame): void {
      const payload = JSON.stringify(frame);
      for (const s of sockets) s.send(payload);
    },
    stop: () => server.stop(true),
  };
}
