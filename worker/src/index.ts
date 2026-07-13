import { Hono } from "hono";
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

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

export { ChannelDO };
export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
