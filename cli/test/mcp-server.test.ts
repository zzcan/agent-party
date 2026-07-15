import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server";
import type { ToolCtx } from "../src/mcp/tools";
import { startMockChannel } from "./mock-channel";

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; });

async function connect(ctx: ToolCtx) {
  const server = buildServer(ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

describe("mcp server", () => {
  test("tools/list 暴露全部 6 个工具且带 inputSchema", async () => {
    const client = await connect({ server: "http://unused", token: "ap_x", defaultChannel: "mock" });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "party_read", "party_send", "party_status", "party_task_list", "party_task_update", "party_who",
    ]);
    for (const t of tools) expect(t.inputSchema).toBeDefined();
    await client.close();
  });

  test("tools/call 路由到 handler（party_who 走真 mock channel）", async () => {
    const m = startMockChannel({ self: "me", presence: [
      { name: "me", kind: "human", state: "working", note: null, last_seen: 0 },
    ] });
    stop = m.stop;
    const client = await connect({ server: m.url, token: "ap_x", defaultChannel: "mock" });
    const res = await client.callTool({ name: "party_who", arguments: {} });
    const arr = JSON.parse((res.content as any)[0].text);
    expect(arr[0]).toMatchObject({ name: "me", state: "working" });
    await client.close();
  });

  test("未知工具 → isError", async () => {
    const client = await connect({ server: "http://unused", token: "ap_x", defaultChannel: "mock" });
    const res = await client.callTool({ name: "nope", arguments: {} });
    expect(res.isError).toBe(true);
    await client.close();
  });
});
