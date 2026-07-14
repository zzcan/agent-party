import { EXIT_ERROR, isName } from "@agentparty-mini/shared";
import { parseArgs } from "../args";
import { loadConfig } from "../config";
import { CliError } from "../errors";
import { archiveChannel, createChannel, listChannels, setGuard, type RestOpts } from "../rest";

export async function channelCmd(argv: string[], fetchImpl: typeof fetch = fetch): Promise<void> {
  const { positionals, flags } = parseArgs(argv, { bool: ["party"], value: ["title"] });
  const [sub, arg1, arg2] = positionals;
  const cfg = loadConfig();
  const o: RestOpts = { server: cfg.server, token: cfg.token };
  if (sub === "create") {
    if (!isName(arg1)) throw new CliError(EXIT_ERROR, "usage: party channel create <slug> [--title T] [--party]");
    const body: { slug: string; title?: string; mode?: string } = { slug: arg1 };
    if (typeof flags.title === "string") body.title = flags.title;
    if (flags.party === true) body.mode = "party";
    await createChannel(o, body, fetchImpl);
    process.stdout.write(`created channel ${arg1}${flags.party ? " (party)" : ""}\n`);
    return;
  }
  if (sub === "list") {
    const res = (await listChannels(o, fetchImpl)) as { channels: { slug: string; title: string; mode: string }[] };
    for (const ch of res.channels) process.stdout.write(`${ch.slug}\t${ch.mode}\t${ch.title}\n`);
    return;
  }
  if (sub === "archive") {
    if (!isName(arg1)) throw new CliError(EXIT_ERROR, "usage: party channel archive <slug>");
    await archiveChannel(o, arg1, fetchImpl);
    process.stdout.write(`archived ${arg1}\n`);
    return;
  }
  if (sub === "guard") {
    if (!isName(arg1)) throw new CliError(EXIT_ERROR, "usage: party channel guard <slug> <n|off|default>");
    let limit: number | null;
    if (arg2 === "off") limit = 0;
    else if (arg2 === "default") limit = null;
    else {
      const n = Number(arg2);
      if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new CliError(EXIT_ERROR, "guard limit must be off, default, or 0..10000");
      limit = n;
    }
    await setGuard(o, arg1, limit, fetchImpl);
    process.stdout.write(`guard for ${arg1} set to ${arg2}\n`);
    return;
  }
  throw new CliError(EXIT_ERROR, "usage: party channel <create|list|archive|guard> ...");
}
