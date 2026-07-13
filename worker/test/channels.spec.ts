import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintToken } from "./tokens.spec";

async function authed(path: string, token: string, init: RequestInit = {}) {
  return SELF.fetch(`https://x${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("channels", () => {
  it("创建、列出、重复创建 409、非法 slug 400、未认证 401", async () => {
    const token = await mintToken("t5-alice", "human");
    const created = await authed("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: "t5-design", title: "Design Review" }),
    });
    expect(created.status).toBe(201);
    const dup = await authed("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: "t5-design" }),
    });
    expect(dup.status).toBe(409);
    const bad = await authed("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: "Bad Slug" }),
    });
    expect(bad.status).toBe(400);
    const anon = await SELF.fetch("https://x/api/channels");
    expect(anon.status).toBe(401);
    const list = await authed("/api/channels", token);
    const body = (await list.json()) as { channels: { slug: string; mode: string }[] };
    expect(body.channels.some((ch) => ch.slug === "t5-design" && ch.mode === "normal")).toBe(true);
  });

  it("归档后不再出现在列表", async () => {
    const token = await mintToken("t5-bob", "human");
    await authed("/api/channels", token, { method: "POST", body: JSON.stringify({ slug: "t5-old" }) });
    const arch = await authed("/api/channels/t5-old/archive", token, { method: "POST" });
    expect(arch.status).toBe(200);
    const list = await authed("/api/channels", token);
    const body = (await list.json()) as { channels: { slug: string }[] };
    expect(body.channels.some((ch) => ch.slug === "t5-old")).toBe(false);
  });

  it("guard 设置校验：null/0/正整数合法，越界 400", async () => {
    const token = await mintToken("t5-carol", "human");
    await authed("/api/channels", token, { method: "POST", body: JSON.stringify({ slug: "t5-g", mode: "party" }) });
    for (const limit of [null, 0, 3]) {
      const res = await authed("/api/channels/t5-g/guard", token, {
        method: "PUT",
        body: JSON.stringify({ limit }),
      });
      expect(res.status).toBe(200);
    }
    const bad = await authed("/api/channels/t5-g/guard", token, {
      method: "PUT",
      body: JSON.stringify({ limit: 99999 }),
    });
    expect(bad.status).toBe(400);
    const missing = await authed("/api/channels/nope/guard", token, {
      method: "PUT",
      body: JSON.stringify({ limit: 1 }),
    });
    expect(missing.status).toBe(404);
  });
});
