import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "../args";
import { loadConfig, resolveChannel } from "../config";
import { buildServer } from "../mcp/server";

export async function mcp(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv, { value: ["channel", "server", "token"] });
  const cfg = loadConfig(); // 未 init 抛 CliError(EXIT_ERROR)，由 main 捕获
  const ctx = {
    server: (flags.server as string | undefined) ?? cfg.server,
    token: (flags.token as string | undefined) ?? cfg.token,
    defaultChannel: resolveChannel(cfg, flags.channel as string | undefined),
  };
  const server = buildServer(ctx);
  await server.connect(new StdioServerTransport());
  // 保持进程存活，直到 stdin 关闭（MCP 客户端断开）
  await new Promise<void>((resolve) => {
    server.onclose = () => resolve();
    process.stdin.on("close", resolve);
  });
}
