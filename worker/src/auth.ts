export interface Identity {
  name: string;
  kind: "agent" | "human";
  hash: string;
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return "ap_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function tokenFromRequest(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  // 浏览器 WebSocket 无法带 Authorization 头，仅 WS upgrade 请求允许走 query 参数；
  // 普通 REST 请求不接受 ?token=，避免 token 经代理/CDN 日志、浏览器历史、Referer 泄漏。
  const isWsUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (!isWsUpgrade) return null;
  const q = new URL(req.url).searchParams.get("token");
  return q || null;
}

export async function identityFromRequest(db: D1Database, req: Request): Promise<Identity | null> {
  const token = tokenFromRequest(req);
  if (!token?.startsWith("ap_")) return null;
  const hash = await sha256Hex(token);
  const row = await db
    .prepare("SELECT name, kind FROM tokens WHERE hash = ? AND revoked_at IS NULL")
    .bind(hash)
    .first<{ name: string; kind: "agent" | "human" }>();
  return row ? { name: row.name, kind: row.kind, hash } : null;
}
