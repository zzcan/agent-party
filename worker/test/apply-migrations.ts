import { applyD1Migrations, env } from "cloudflare:test";

// TEST_MIGRATIONS is typed optional on Cloudflare.Env (see test/env.d.ts) but
// is always populated at runtime via vitest.config.ts miniflare bindings.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
