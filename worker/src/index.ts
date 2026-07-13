import { Hono } from "hono";
import { isName, RESERVED_NAMES } from "@agentparty-mini/shared";
import { generateToken, identityFromRequest, sha256Hex, type Identity } from "./auth";
import { ChannelDO } from "./do";

export interface Env {
  DB: D1Database;
  CHANNELS: DurableObjectNamespace;
  ADMIN_SECRET: string;
  // 测试用覆盖，生产不设
  RETAIN_N?: string;
  RATE_LIMIT_PER_MIN?: string;
  AUTH_CACHE_TTL_MS?: string;
}

type Vars = { identity: Identity };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const requireAdmin = async (c: any, next: any) => {
  if (c.req.header("x-admin-secret") !== c.env.ADMIN_SECRET) {
    return c.json({ error: "admin secret required" }, 401);
  }
  await next();
};

const requireAuth = async (c: any, next: any) => {
  const identity = await identityFromRequest(c.env.DB, c.req.raw);
  if (!identity) return c.json({ error: "invalid or revoked token" }, 401);
  c.set("identity", identity);
  await next();
};

app.get("/api/health", (c) => c.json({ ok: true }));

app.post("/api/tokens", requireAdmin, async (c) => {
  const body = await c.req.json<{ name?: unknown; kind?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const { name, kind } = body;
  if (!isName(name) || RESERVED_NAMES.includes(name)) return c.json({ error: "invalid name" }, 400);
  if (kind !== "agent" && kind !== "human") return c.json({ error: "kind must be agent|human" }, 400);
  const token = generateToken();
  const hash = await sha256Hex(token);
  try {
    await c.env.DB.prepare("INSERT INTO tokens (name, hash, kind, created_at) VALUES (?, ?, ?, ?)")
      .bind(name, hash, kind, Date.now())
      .run();
  } catch {
    return c.json({ error: "name already exists" }, 409);
  }
  return c.json({ token, name, kind }, 201);
});

app.delete("/api/tokens/:name", requireAdmin, async (c) => {
  await c.env.DB.prepare("UPDATE tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL")
    .bind(Date.now(), c.req.param("name"))
    .run();
  return c.json({ ok: true });
});

app.get("/api/me", requireAuth, (c) => {
  const { name, kind } = c.get("identity");
  return c.json({ name, kind });
});

export { ChannelDO };
export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
