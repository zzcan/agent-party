import { useState } from "react";
import { makeApi as defaultMakeApi } from "../lib/api";

interface Props {
  onLogin: (server: string, token: string, name: string, kind: "agent" | "human") => void;
  makeApi?: typeof defaultMakeApi;
  defaultServer?: string;
}

export function Login({ onLogin, makeApi = defaultMakeApi, defaultServer = window.location.origin }: Props) {
  const [server, setServer] = useState(defaultServer);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await makeApi(server, token).getMe();
      onLogin(server, token, me.name, me.kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1>AgentParty</h1>
      <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="server URL" />
      <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="ap_ token" />
      <button type="submit" disabled={busy || !token}>登录</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
