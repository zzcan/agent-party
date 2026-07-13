import { EXIT_AUTH, EXIT_ARCHIVED, EXIT_ERROR, EXIT_LOOP_GUARD, EXIT_RATE_LIMITED, type ErrorCode } from "@agentparty-mini/shared";
import { parseArgs } from "../args";
import { loadConfig, loadCursor, resolveChannel, saveCursor, type Config } from "../config";
import { CliError } from "../errors";
import { formatMsg, formatPresence, ndjson } from "../format";
import { openChannel as defaultOpen } from "../ws";

interface Deps {
  open?: typeof defaultOpen;
  cfg?: Config;
}

function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case "auth": return EXIT_AUTH;
    case "archived": return EXIT_ARCHIVED;
    case "loop_guard": return EXIT_LOOP_GUARD;
    case "rate_limited": return EXIT_RATE_LIMITED;
    default: return EXIT_ERROR;
  }
}

export async function watch(argv: string[], deps: Deps = {}): Promise<void> {
  const { flags } = parseArgs(argv, {
    bool: ["mentions-only", "once", "follow", "json"],
    value: ["channel", "server", "token"],
  });
  const cfg = deps.cfg ?? loadConfig();
  const open = deps.open ?? defaultOpen;
  const channel = resolveChannel(cfg, flags.channel as string | undefined);
  const once = flags.once === true;
  const mentionsOnly = flags["mentions-only"] === true;
  const json = flags.json === true;
  const after = loadCursor(cfg.server, channel);
  const ch = await open({ server: cfg.server, token: cfg.token }, channel, { after, reconnect: !once });
  const selfTag = `@${ch.hello.self}`;
  try {
    for await (const f of ch.frames) {
      if (f.type === "msg") {
        const hit = !mentionsOnly || f.body.includes(selfTag);
        if (hit) process.stdout.write(`${json ? ndjson(f) : formatMsg(f)}\n`);
        if (f.seq > loadCursor(cfg.server, channel)) saveCursor(cfg.server, channel, f.seq);
        if (once && hit) return;
      } else if (f.type === "presence") {
        if (!mentionsOnly) process.stdout.write(`${json ? ndjson(f) : formatPresence(f.entry)}\n`);
      } else if (f.type === "error") {
        const code = exitCodeFor(f.code);
        if (once || f.code === "auth" || f.code === "archived") {
          throw new CliError(code, f.message);
        }
        process.stderr.write(`! ${f.code}: ${f.message}\n`);
      }
    }
  } finally {
    ch.close();
  }
}
