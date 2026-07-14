import { useChannel } from "../hooks/useChannel";
import type { Api } from "../lib/api";
import type { Session } from "../session";
import { MessageStream } from "./MessageStream";
import { PresenceSidebar } from "./PresenceSidebar";
import { Composer } from "./Composer";
import { TaskPanel } from "./TaskPanel";

export function ChannelView({ session, slug, api, onAuthError }: { session: Session; slug: string; api: Api; onAuthError: () => void }) {
  const { state, send } = useChannel(session, slug, { onAuthError });
  return (
    <main className="channel-view">
      <section className="stream">
        <MessageStream messages={state.messages} self={state.self || session.name} />
        <Composer onSend={(body) => send(body, [])} />
      </section>
      <aside className="side">
        <PresenceSidebar presence={state.presence} />
        <TaskPanel api={api} slug={slug} messages={state.messages} />
      </aside>
    </main>
  );
}
