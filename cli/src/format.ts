import type { PresenceEntry, ServerFrame } from "@agentparty-mini/shared";

export function formatMsg(f: Extract<ServerFrame, { type: "msg" }>): string {
  const prefix = f.sender === "system" ? "**" : "";
  return `${prefix}[${f.sender}] ${f.body}`;
}

export function formatPresence(e: PresenceEntry): string {
  return `· ${e.name} is ${e.state}${e.note ? ` (${e.note})` : ""}`;
}

export function ndjson(f: ServerFrame): string {
  return JSON.stringify(f);
}
