import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, makeApi } from "./api";

describe("makeApi 401 handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls onAuthError and throws ApiError(401) on a 401 response", async () => {
    const onAuthError = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "revoked" }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = makeApi("http://h", "t", onAuthError);

    await expect(api.listChannels()).rejects.toBeInstanceOf(ApiError);
    expect(onAuthError).toHaveBeenCalledOnce();
  });

  it("does not call onAuthError on a successful response", async () => {
    const onAuthError = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ channels: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = makeApi("http://h", "t", onAuthError);

    await api.listChannels();
    expect(onAuthError).not.toHaveBeenCalled();
  });
});
