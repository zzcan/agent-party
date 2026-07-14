import { useEffect, useReducer, useRef } from "react";
import type { SendFrame } from "@agentparty-mini/shared";
import { initialState, reduce, type ChannelState } from "../lib/frames";
import { openChannel, type ChannelConn } from "../lib/channel";
import { loadCursor, saveCursor, type Session } from "../session";

export function useChannel(
  session: Session,
  slug: string,
  hooks: { onSystemMsg?: () => void; onAuthError?: () => void } = {},
): { state: ChannelState; send: (body: string, mentions: string[], replyTo?: number) => void } {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const connRef = useRef<ChannelConn | null>(null);
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;

  useEffect(() => {
    const conn = openChannel({
      server: session.server,
      token: session.token,
      slug,
      after: loadCursor(session.server, slug),
      onFrame: (frame) => {
        dispatch(frame);
        if (frame.type === "msg") {
          saveCursor(session.server, slug, frame.seq);
          if (frame.sender === "system") hooksRef.current.onSystemMsg?.();
        }
        if (frame.type === "error" && (frame.code === "auth" || frame.code === "archived")) {
          hooksRef.current.onAuthError?.();
        }
      },
    });
    connRef.current = conn;
    return () => conn.close();
  }, [session.server, session.token, slug]);

  function send(body: string, mentions: string[], replyTo?: number) {
    void mentions; // 服务端从 body 自行解析 mentions；这里保留签名对齐
    const frame: SendFrame = {
      type: "send",
      kind: "message",
      body,
      idem_key: crypto.randomUUID(),
      ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
    };
    connRef.current?.send(frame);
  }

  return { state, send };
}
