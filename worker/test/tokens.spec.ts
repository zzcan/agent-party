import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ADMIN = { "x-admin-secret": "test-admin-secret" };

export async function mintToken(name: string, kind: "agent" | "human"): Promise<string> {
  const res = await SELF.fetch("https://x/api/tokens", {
    method: "POST",
    headers: { ...ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ name, kind }),
  });
  if (res.status !== 201) throw new Error(`mint failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token: string };
  return body.token;
}

describe("tokens", () => {
  it("无 admin secret 头铸 token 返回 401", async () => {
    const res = await SELF.fetch("https://x/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "t4-a", kind: "agent" }),
    });
    expect(res.status).toBe(401);
  });

  it("错误的 admin secret 头铸 token 返回 401", async () => {
    const res = await SELF.fetch("https://x/api/tokens", {
      method: "POST",
      headers: { "x-admin-secret": "wrong-secret", "content-type": "application/json" },
      body: JSON.stringify({ name: "t4-wrong", kind: "agent" }),
    });
    expect(res.status).toBe(401);
  });

  it("ADMIN_SECRET 绑定未设置（空/undefined）时必须一律拒绝，不能因 header 也缺失而 undefined===undefined 放行", async () => {
    const original = env.ADMIN_SECRET;
    try {
      // @ts-expect-error 测试内故意把 binding 置空，模拟未配置 ADMIN_SECRET 的部署
      env.ADMIN_SECRET = undefined;
      const noHeader = await SELF.fetch("https://x/api/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "t4-unset", kind: "agent" }),
      });
      expect(noHeader.status).toBe(401);

      const emptyHeader = await SELF.fetch("https://x/api/tokens", {
        method: "POST",
        headers: { "x-admin-secret": "", "content-type": "application/json" },
        body: JSON.stringify({ name: "t4-unset2", kind: "agent" }),
      });
      expect(emptyHeader.status).toBe(401);

      const del = await SELF.fetch("https://x/api/tokens/whatever", {
        method: "DELETE",
        headers: {},
      });
      expect(del.status).toBe(401);
    } finally {
      env.ADMIN_SECRET = original;
    }
  });

  it("铸 token 返回 ap_ 前缀，/api/me 能换回身份", async () => {
    const token = await mintToken("t4-bob", "agent");
    expect(token).toMatch(/^ap_[0-9a-f]{32}$/);
    const me = await SELF.fetch("https://x/api/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ name: "t4-bob", kind: "agent" });
  });

  it("非法名 / 保留名 system / 重名被拒", async () => {
    const bad = await SELF.fetch("https://x/api/tokens", {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "Bad_Name", kind: "agent" }),
    });
    expect(bad.status).toBe(400);
    const reserved = await SELF.fetch("https://x/api/tokens", {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "system", kind: "agent" }),
    });
    expect(reserved.status).toBe(400);
    await mintToken("t4-dup", "human");
    const dup = await SELF.fetch("https://x/api/tokens", {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "t4-dup", kind: "human" }),
    });
    expect(dup.status).toBe(409);
  });

  it("REST 端点仅接受 Bearer header，?token= 不生效（防止 URL 泄漏）", async () => {
    const token = await mintToken("t4-querytoken", "agent");
    const me = await SELF.fetch(`https://x/api/me?token=${token}`);
    expect(me.status).toBe(401);
  });

  it("吊销后 /api/me 返回 401", async () => {
    const token = await mintToken("t4-gone", "human");
    const del = await SELF.fetch("https://x/api/tokens/t4-gone", { method: "DELETE", headers: ADMIN });
    expect(del.status).toBe(200);
    const me = await SELF.fetch("https://x/api/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(401);
  });
});
