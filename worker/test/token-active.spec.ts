import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import type { ChannelDO } from "../src/do";
import { mintToken } from "./tokens.spec";

async function stubFor(slug: string) {
  return (env.CHANNELS as unknown as DurableObjectNamespace<ChannelDO>).get(env.CHANNELS.idFromName(slug));
}

describe("tokenActive", () => {
  it("happy path：合法 token 连续两次查询都返回 true（首查 + 缓存/复查）", async () => {
    const token = await mintToken("t11-happy", "agent");
    const hash = await sha256Hex(token);
    const stub = await stubFor("t11-room-happy");
    await runInDurableObject(stub, async (instance: ChannelDO) => {
      const first = await (instance as any).tokenActive(hash);
      expect(first).toBe(true);
      const second = await (instance as any).tokenActive(hash);
      expect(second).toBe(true);
    });
  });

  it("D1 查询抛错且无历史缓存：fail-open 返回 true，且不把兜底结果写成权威缓存", async () => {
    const token = await mintToken("t11-failopen", "agent");
    const hash = await sha256Hex(token);
    const stub = await stubFor("t11-room-failopen");
    await runInDurableObject(stub, async (instance: ChannelDO) => {
      const throwingDB = {
        prepare() {
          throw new Error("boom: D1 unavailable");
        },
      } as unknown as D1Database;
      (instance as any).env = { ...(instance as any).env, DB: throwingDB };

      const result = await (instance as any).tokenActive(hash);
      expect(result).toBe(true);
      // 兜底结果不能被当作权威值污染缓存：这个 hash 之前从未成功查询过，
      // 所以此刻缓存里不应该出现一条新鲜的 { ok: true } 记录。
      expect((instance as any).tokenCache.has(hash)).toBe(false);
    });
  });

  it("D1 查询抛错但有历史缓存：fail-open 返回上一次已知结果（哪怕已过期），不是无脑 true", async () => {
    const token = await mintToken("t11-stale", "human");
    const hash = await sha256Hex(token);
    const stub = await stubFor("t11-room-stale");
    // 撤销这个 token，让"上一次已知结果"是 false，用来区分 fail-open 到底是
    // 读的缓存值还是无脑返回 true。
    const del = await SELF.fetch("https://x/api/tokens/t11-stale", {
      method: "DELETE",
      headers: { "x-admin-secret": "test-admin-secret" },
    });
    expect(del.status).toBe(200);

    await runInDurableObject(stub, async (instance: ChannelDO) => {
      // 先用真实 DB 查一次，把 ok:false 写进缓存（token 已吊销）
      const firstReal = await (instance as any).tokenActive(hash);
      expect(firstReal).toBe(false);

      const throwingDB = {
        prepare() {
          throw new Error("boom: D1 unavailable");
        },
      } as unknown as D1Database;
      (instance as any).env = { ...(instance as any).env, DB: throwingDB };

      const result = await (instance as any).tokenActive(hash);
      expect(result).toBe(false);
    });
  });
});
