import { EXIT_ERROR } from "@agentparty-mini/shared";
import { parseArgs } from "../args";
import { loadConfig, loadCursor, resolveChannel, saveCursor, type Config } from "../config";
import { CliError } from "../errors";
import { openChannel as defaultOpen } from "../ws";

interface Deps {
  open?: typeof defaultOpen;
  cfg?: Config;
  stdin?: () => Promise<string>;
}

async function readStdin(): Promise<string> {
  return await Bun.stdin.text();
}

export async function send(argv: string[], deps: Deps = {}): Promise<void> {
  const { positionals, flags } = parseArgs(argv, {
    value: ["reply-to", "channel", "server", "token"],
    multi: ["mention"],
  });
  let text = positionals.join(" ");
  if (text === "-") text = (await (deps.stdin ?? readStdin)()).trimEnd();
  if (!text) throw new CliError(EXIT_ERROR, "nothing to send (provide text or pipe via '-')");
  const mentions = (flags.mention as string[] | undefined) ?? [];
  const body = [...mentions.map((m) => `@${m}`), text].join(" ");
  let replyTo: number | undefined;
  if (typeof flags["reply-to"] === "string") {
    replyTo = Number(flags["reply-to"]);
    if (!Number.isInteger(replyTo) || replyTo < 1) throw new CliError(EXIT_ERROR, "--reply-to must be a positive integer");
  }
  const cfg = deps.cfg ?? loadConfig();
  const open = deps.open ?? defaultOpen;
  const channel = resolveChannel(cfg, flags.channel as string | undefined);
  const idem = crypto.randomUUID();
  const ch = await open({ server: cfg.server, token: cfg.token }, channel);
  try {
    ch.send({ type: "send", kind: "message", body, idem_key: idem, ...(replyTo ? { reply_to: replyTo } : {}) });
    for await (const f of ch.frames) {
      if (f.type === "sent" && f.idem_key === idem) {
        process.stdout.write(`sent #${f.seq}\n`);
        if (f.seq > loadCursor(cfg.server, channel)) saveCursor(cfg.server, channel, f.seq);
        return;
      }
      if (f.type === "error") throw new CliError(EXIT_ERROR, `send failed: ${f.message}`);
    }
    throw new CliError(EXIT_ERROR, "connection closed before send was acknowledged");
  } finally {
    ch.close();
  }
}
