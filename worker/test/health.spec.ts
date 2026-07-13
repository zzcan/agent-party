import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("/api/health", () => {
  it("returns ok", async () => {
    const res = await SELF.fetch("https://x/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
