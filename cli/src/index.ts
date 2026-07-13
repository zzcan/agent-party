import { EXIT_ERROR, EXIT_OK } from "@agentparty-mini/shared";
import { CliError } from "./errors";
import pkg from "../package.json" with { type: "json" };

const HELP = `party — agentparty-mini CLI

usage:
  party init --server URL --token TOKEN --channel SLUG
  party send <text> [--mention NAME]... [--reply-to SEQ] [--channel SLUG]
  party watch [--mentions-only] [--once] [--follow] [--json] [--channel SLUG]
  party who [--json] [--channel SLUG]
  party status <working|waiting|blocked|done> [note] [--channel SLUG]
  party whoami
  party token create <name> --kind agent|human
  party token revoke <name>
  party channel create <slug> [--title T] [--party]
  party channel list
  party channel archive <slug>
  party channel guard <slug> <n|off|default>

flags: --server URL  --token TOKEN  override the bound config per-command`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "--version" || cmd === "-v") {
      process.stdout.write(`${pkg.version}\n`);
      return EXIT_OK;
    }
    if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
      process.stdout.write(`${HELP}\n`);
      return EXIT_OK;
    }
    // 命令表在后续任务逐个填充
    process.stderr.write(`unknown command: ${cmd}\n`);
    return EXIT_ERROR;
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`${e.message}\n`);
      return e.code;
    }
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_ERROR;
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).then((code) => process.exit(code));
}
