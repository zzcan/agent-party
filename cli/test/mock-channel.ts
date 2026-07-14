import type { PresenceEntry, ServerFrame } from "@agentparty-mini/shared";

export interface MockOpts {
  self: string; // 连接者身份（hello.self）
  kind?: "agent" | "human";
  presence?: PresenceEntry[]; // hello.presence
  mode?: "normal" | "party";
  guard?: number;
  history?: { seq: number; sender: string; body: string }[]; // 供 ?after= 补拉
  connectError?: { code: string; message: string }; // 若设，连接即发 error+close(1008)，不发 hello
  dropFirstConnection?: boolean; // 第一条连接发完 hello 后立即 close（测重连）
  errorAfterHello?: { code: string; message: string }; // 若设，hello 之后收到的第一条客户端消息回复 error 而非正常处理
}

export function startMockChannel(opts: MockOpts) {
  let seqCounter = opts.history?.length ? Math.max(...opts.history.map((h) => h.seq)) : 0;
  let connectionCount = 0;
  let sentErrorAfterHello = false;
  const kind = opts.kind ?? "human";
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
        for (const h of opts.history ?? []) {
          if (after !== null && h.seq > after) {
            ws.send(
              JSON.stringify({
                type: "msg",
                seq: h.seq,
                ts: 0,
                sender: h.sender,
                sender_kind: "human",
                body: h.body,
                mentions: [],
                reply_to: null,
              } satisfies ServerFrame),
            );
          }
        }
        if (opts.dropFirstConnection && connectionCount === 1) {
          setTimeout(() => ws.close(1006, "drop"), 20);
        }
      },
      message(ws, raw) {
        if (opts.errorAfterHello && !sentErrorAfterHello) {
          sentErrorAfterHello = true;
          ws.send(JSON.stringify({ type: "error", ...opts.errorAfterHello }));
          return;
        }
        const frame = JSON.parse(String(raw));
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
    stop: () => server.stop(true),
  };
}
