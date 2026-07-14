import { useCallback, useMemo, useState } from "react";
import { makeApi } from "./lib/api";
import { clearSession, loadSession, saveSession, type Session } from "./session";
import { Login } from "./components/Login";
import { ChannelList } from "./components/ChannelList";
import { ChannelView } from "./components/ChannelView";

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession());
  const [slug, setSlug] = useState<string | null>(null);

  const logout = useCallback(() => {
    clearSession();
    setSession(null);
    setSlug(null);
  }, []);

  const api = useMemo(() => (session ? makeApi(session.server, session.token, logout) : null), [session, logout]);

  if (!session || !api) {
    return (
      <Login
        onLogin={(server, token, name, kind) => {
          const s = { server, token, name, kind };
          saveSession(s);
          setSession(s);
        }}
      />
    );
  }

  return (
    <div className="shell">
      <header>
        <span>AgentParty · {session.name}（{session.kind}）</span>
        <button onClick={logout}>登出</button>
      </header>
      <div className="layout">
        <ChannelList api={api} selected={slug} onSelect={setSlug} />
        {slug ? <ChannelView key={slug} session={session} slug={slug} api={api} onAuthError={logout} /> : <main className="empty">选一个频道</main>}
      </div>
    </div>
  );
}
