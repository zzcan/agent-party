// NOTE: installed @cloudflare/vitest-pool-workers (0.18.4) types `env` from
// "cloudflare:test" as `Cloudflare.Env` (declaration-merged into the ambient
// `Cloudflare` namespace from @cloudflare/workers-types), not the older
// `ProvidedEnv` interface the brief assumed. Augmenting `ProvidedEnv` here is
// a no-op against this version, so we augment `Cloudflare.Env` instead to get
// typed `env.DB` / `env.TEST_MIGRATIONS` in test files.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    CHANNELS: DurableObjectNamespace;
    ADMIN_SECRET: string;
    // Optional: this augments the *global* Cloudflare.Env namespace (shared
    // with src/index.ts's own Env, which partyserver's `Server<Env>` must
    // satisfy), so a required TEST_MIGRATIONS here would break src/do.ts's
    // `Server<Env>` constraint. It's only ever populated by vitest.config.ts
    // miniflare bindings.
    TEST_MIGRATIONS?: D1Migration[];
  }
}
