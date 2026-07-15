import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, type ToolCtx, type ToolDeps } from "./tools";

export function buildServer(ctx: ToolCtx, deps: ToolDeps = {}): Server {
  const server = new Server({ name: "party", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) return { content: [{ type: "text" as const, text: `unknown tool: ${req.params.name}` }], isError: true };
    return (await tool.handler(ctx, (req.params.arguments ?? {}) as Record<string, unknown>, deps)) as CallToolResult;
  });

  return server;
}
