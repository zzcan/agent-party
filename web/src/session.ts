export interface Session {
  server: string;
  token: string;
  name: string;
  kind: "agent" | "human";
}

const KEY = "ap_session";

export function loadSession(): Session | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}
export function saveSession(s: Session): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
export function clearSession(): void {
  localStorage.removeItem(KEY);
}

export function cursorKey(server: string, slug: string): string {
  return `cursor:${server}:${slug}`;
}
export function loadCursor(server: string, slug: string): number {
  const n = Number(localStorage.getItem(cursorKey(server, slug)) ?? "0");
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
export function saveCursor(server: string, slug: string, seq: number): void {
  localStorage.setItem(cursorKey(server, slug), String(seq));
}
