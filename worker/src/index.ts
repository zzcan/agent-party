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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) return c.json({ error: "name already exists" }, 409);
    return c.json({ error: "internal error" }, 500);
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

app.post("/api/channels", requireAuth, async (c) => {
  const body = await c.req.json<{ slug?: unknown; title?: unknown; mode?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const { slug, title, mode } = body;
  if (!isName(slug)) return c.json({ error: "invalid slug" }, 400);
  if (mode !== undefined && mode !== "normal" && mode !== "party") return c.json({ error: "mode must be normal|party" }, 400);
  const row = {
    slug,
    title: typeof title === "string" && title.length > 0 && title.length <= 200 ? title : slug,
    mode: (mode ?? "normal") as string,
    guard_limit: null,
    created_at: Date.now(),
    archived_at: null,
  };
  try {
    await c.env.DB.prepare("INSERT INTO channels (slug, title, mode, created_at) VALUES (?, ?, ?, ?)")
      .bind(row.slug, row.title, row.mode, row.created_at)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) return c.json({ error: "slug already exists" }, 409);
    return c.json({ error: "internal error" }, 500);
  }
  return c.json(row, 201);
});

app.get("/api/channels", requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT slug, title, mode, guard_limit, created_at FROM channels WHERE archived_at IS NULL ORDER BY created_at",
  ).all();
  return c.json({ channels: results });
});

app.post("/api/channels/:slug/archive", requireAuth, async (c) => {
  const r = await c.env.DB.prepare("UPDATE channels SET archived_at = ? WHERE slug = ? AND archived_at IS NULL")
    .bind(Date.now(), c.req.param("slug"))
    .run();
  if (r.meta.changes === 0) return c.json({ error: "channel not found" }, 404);
  return c.json({ ok: true });
});

app.put("/api/channels/:slug/guard", requireAuth, async (c) => {
  const body = await c.req.json<{ limit?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const limit = body.limit;
  const valid = limit === null || (Number.isInteger(limit) && (limit as number) >= 0 && (limit as number) <= 10_000);
  if (!valid) return c.json({ error: "limit must be null or 0..10000" }, 400);
  const r = await c.env.DB.prepare("UPDATE channels SET guard_limit = ? WHERE slug = ?")
    .bind(limit, c.req.param("slug"))
    .run();
  if (r.meta.changes === 0) return c.json({ error: "channel not found" }, 404);
  return c.json({ ok: true });
});

export { ChannelDO };
export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
