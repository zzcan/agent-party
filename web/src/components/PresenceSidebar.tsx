import type { PresenceEntry } from "@agentparty-mini/shared";

export function PresenceSidebar({ presence }: { presence: PresenceEntry[] }) {
  const sorted = [...presence].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="presence">
      <h3>在线</h3>
      <ul>
        {sorted.map((p) => (
          <li key={p.name}>
            <span className={`dot ${p.state}`} />
            <span>{p.name}</span>
            {p.note && <span className="note">{p.note}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
