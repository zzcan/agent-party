import { useEffect, useState } from "react";
import type { Api, ChannelInfo } from "../lib/api";
import { isName } from "@agentparty-mini/shared";

interface Props {
  api: Api;
  selected: string | null;
  onSelect: (slug: string) => void;
}

export function ChannelList({ api, selected, onSelect }: Props) {
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setChannels((await api.listChannels()).channels);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!isName(slug)) {
      setError("slug 需 a-z0-9- 开头小写字母数字");
      return;
    }
    try {
      await api.createChannel(slug);
      setSlug("");
      setError(null);
      await refresh();
      onSelect(slug);
    } catch (e) {
      setError(e instanceof Error ? e.message : "create failed");
    }
  }

  return (
    <nav className="channel-list">
      <h2>频道</h2>
      <ul>
        {channels.map((ch) => (
          <li key={ch.slug}>
            <button className={ch.slug === selected ? "active" : ""} onClick={() => onSelect(ch.slug)}>
              {ch.title} {ch.mode === "party" && "🎉"}
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={create}>
        <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="new-channel-slug" />
        <button type="submit">＋</button>
      </form>
      {error && <p className="error">{error}</p>}
    </nav>
  );
}
