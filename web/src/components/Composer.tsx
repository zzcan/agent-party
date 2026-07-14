import { useState } from "react";
import { extractMentions } from "@agentparty-mini/shared";

export function Composer({ onSend }: { onSend: (body: string, mentions: string[]) => void }) {
  const [text, setText] = useState("");
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    onSend(body, extractMentions(body));
    setText("");
  }
  return (
    <form className="composer" data-testid="composer-form" onSubmit={submit}>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="说点什么…（@名字 提及）" />
      <button type="submit">发送</button>
    </form>
  );
}
