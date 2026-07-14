import { useEffect, useRef } from "react";
import type { Msg } from "../lib/frames";

export function MessageStream({ messages, self }: { messages: Msg[]; self: string }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);
  return (
    <div className="messages">
      {messages.map((m) => {
        const cls = m.sender === "system" ? "system" : m.sender === self ? "self" : m.sender_kind === "agent" ? "agent" : "human";
        return (
          <div key={m.seq} className={`msg ${cls}`}>
            {m.sender !== "system" && <span className="sender">{m.sender}</span>}
            {m.reply_to !== null && <span className="reply">↳#{m.reply_to}</span>}
            <span className="body">{m.body}</span>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
