import { parseArgs } from "../args";
import { loadConfig, resolveChannel, type Config } from "../config";
import { formatPresence, ndjson } from "../format";
import { openChannel as defaultOpen } from "../ws";

interface Deps {
  open?: typeof defaultOpen;
  cfg?: Config;
}

export async function who(argv: string[], deps: Deps = {}): Promise<void> {
  const { flags } = parseArgs(argv, { bool: ["json"], value: ["channel", "server", "token"] });
  const cfg = deps.cfg ?? loadConfig();
  const open = deps.open ?? defaultOpen;
  const channel = resolveChannel(cfg, flags.channel as string | undefined);
  const server = (flags.server as string | undefined) ?? cfg.server;
  const token = (flags.token as string | undefined) ?? cfg.token;
  const ch = await open({ server, token }, channel);
  try {
    for (const e of ch.hello.presence) {
      process.stdout.write(`${flags.json ? ndjson({ type: "presence", entry: e }) : formatPresence(e)}\n`);
    }
  } finally {
    ch.close();
  }
}
