import { EXIT_ERROR, isName } from "@agentparty-mini/shared";
import { parseArgs } from "../args";
import { loadConfig } from "../config";
import { CliError } from "../errors";
import { mintToken, revokeToken, type RestOpts } from "../rest";

export async function tokenCmd(argv: string[], fetchImpl: typeof fetch = fetch): Promise<void> {
  const { positionals, flags } = parseArgs(argv, { value: ["kind", "server"] });
  const [sub, name] = positionals;
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) throw new CliError(EXIT_ERROR, "token commands need ADMIN_SECRET in the environment");
  const server = (flags.server as string | undefined) ?? loadConfig().server;
  const o: RestOpts = { server, adminSecret };
  if (sub === "create") {
    if (!isName(name)) throw new CliError(EXIT_ERROR, "usage: party token create <name> --kind agent|human");
    const kind = flags.kind;
    if (kind !== "agent" && kind !== "human") throw new CliError(EXIT_ERROR, "--kind must be agent or human");
    const res = (await mintToken(o, name, kind, fetchImpl)) as { token: string };
    process.stdout.write(`${res.token}\n`);
    return;
  }
  if (sub === "revoke") {
    if (!isName(name)) throw new CliError(EXIT_ERROR, "usage: party token revoke <name>");
    await revokeToken(o, name, fetchImpl);
    process.stdout.write(`revoked ${name}\n`);
    return;
  }
  throw new CliError(EXIT_ERROR, "usage: party token <create|revoke> ...");
}
