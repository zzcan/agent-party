import { EXIT_ERROR } from "@agentparty-mini/shared";
import { parseArgs } from "../args";
import { saveConfig, type Config } from "../config";
import { CliError } from "../errors";
import { getMe } from "../rest";

export async function init(argv: string[], fetchImpl: typeof fetch = fetch): Promise<void> {
  const { flags } = parseArgs(argv, { value: ["server", "token", "channel"] });
  const server = flags.server as string | undefined;
  const token = flags.token as string | undefined;
  const channel = flags.channel as string | undefined;
  if (!server || !token || !channel) {
    throw new CliError(EXIT_ERROR, "init requires --server, --token, and --channel");
  }
  const me = (await getMe({ server, token }, fetchImpl)) as { name: string; kind: "agent" | "human" };
  const cfg: Config = { server, token, channel, name: me.name, kind: me.kind };
  saveConfig(cfg);
  process.stdout.write(`bound as ${cfg.name} (${cfg.kind}) → ${cfg.channel} @ ${cfg.server}\n`);
}
