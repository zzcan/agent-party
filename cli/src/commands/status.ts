import { EXIT_ERROR, type StatusState } from "@agentparty-mini/shared";
import { parseArgs } from "../args";
import { loadConfig, resolveChannel, type Config } from "../config";
import { CliError } from "../errors";
import { exitCodeFor, openChannel as defaultOpen } from "../ws";

interface Deps {
  open?: typeof defaultOpen;
  cfg?: Config;
}
const STATES: StatusState[] = ["working", "waiting", "blocked", "done"];

export async function status(argv: string[], deps: Deps = {}): Promise<void> {
  const { positionals, flags } = parseArgs(argv, { value: ["channel", "server", "token"] });
  const [state, note] = positionals;
  if (!STATES.includes(state as StatusState)) {
    throw new CliError(EXIT_ERROR, "usage: party status <working|waiting|blocked|done> [note]");
  }
  const cfg = deps.cfg ?? loadConfig();
  const open = deps.open ?? defaultOpen;
  const channel = resolveChannel(cfg, flags.channel as string | undefined);
  const server = (flags.server as string | undefined) ?? cfg.server;
  const token = (flags.token as string | undefined) ?? cfg.token;
  const ch = await open({ server, token }, channel);
  try {
    ch.send({ type: "send", kind: "status", state: state as StatusState, ...(note ? { note } : {}) });
    for await (const f of ch.frames) {
      if (f.type === "presence" && f.entry.name === ch.hello.self && f.entry.state === state) break;
      if (f.type === "error") throw new CliError(exitCodeFor(f.code), `status failed: ${f.message}`);
    }
    process.stdout.write(`status set: ${state}\n`);
  } finally {
    ch.close();
  }
}
