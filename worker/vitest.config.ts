import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const workerDir = path.dirname(fileURLToPath(import.meta.url));
  const migrations = await readD1Migrations(path.join(workerDir, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            ADMIN_SECRET: "test-admin-secret",
            TEST_MIGRATIONS: migrations,
            // 测试可调参数：吊销缓存关掉让吊销即时生效；限速抬高避免多发消息的 spec 误触
            AUTH_CACHE_TTL_MS: "0",
            RATE_LIMIT_PER_MIN: "100",
            RETAIN_N: "50",
          },
        },
      }),
    ],
    test: {
      testTimeout: 20_000,
      hookTimeout: 20_000,
      // WS/DO 状态跨 tick 存活，spec 文件并行会互相 invalidate DO，串行跑
      fileParallelism: false,
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
