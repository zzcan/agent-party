import { EXIT_ERROR } from "@agentparty-mini/shared";
import { parseArgs } from "../args";
import { loadConfig, resolveChannel, type Config } from "../config";
import { CliError } from "../errors";
import { createTask, listTasks, updateTask, type RestOpts } from "../rest";

interface Task {
  id: number;
  title: string;
  state: string;
  assignee: string | null;
  blocked_reason: string | null;
}

const USAGE = "usage: party task <create <title> | list | claim <id> | done <id> | block <id> <reason>>";

function parseId(raw: string | undefined, verb: string): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < 1) throw new CliError(EXIT_ERROR, `usage: party task ${verb} <id>`);
  return n;
}

export async function taskCmd(argv: string[], fetchImpl: typeof fetch = fetch, cfgOverride?: Config): Promise<void> {
  const { positionals, flags } = parseArgs(argv, { value: ["channel", "server", "token"] });
  const [sub, ...rest] = positionals;
  const cfg = cfgOverride ?? loadConfig();
  const slug = resolveChannel(cfg, flags.channel as string | undefined);
  const o: RestOpts = {
    server: (flags.server as string | undefined) ?? cfg.server,
    token: (flags.token as string | undefined) ?? cfg.token,
  };

  if (sub === "create") {
    const title = rest.join(" ").trim();
    if (!title) throw new CliError(EXIT_ERROR, "usage: party task create <title>");
    const t = (await createTask(o, slug, title, fetchImpl)) as Task;
    process.stdout.write(`created #${t.id}: ${t.title}\n`);
    return;
  }
  if (sub === "list") {
    const { tasks } = (await listTasks(o, slug, fetchImpl)) as { tasks: Task[] };
    for (const t of tasks) {
      const assignee = t.assignee ?? "-";
      const reason = t.state === "blocked" && t.blocked_reason ? `（reason: ${t.blocked_reason}）` : "";
      process.stdout.write(`#${t.id}\t${t.state}\t${assignee}\t${t.title}${reason}\n`);
    }
    return;
  }
  if (sub === "claim") {
    const id = parseId(rest[0], "claim");
    await updateTask(o, slug, id, "claim", undefined, fetchImpl);
    process.stdout.write(`claimed #${id}\n`);
    return;
  }
  if (sub === "done") {
    const id = parseId(rest[0], "done");
    await updateTask(o, slug, id, "done", undefined, fetchImpl);
    process.stdout.write(`completed #${id}\n`);
    return;
  }
  if (sub === "block") {
    const id = parseId(rest[0], "block");
    const reason = rest.slice(1).join(" ").trim();
    if (!reason) throw new CliError(EXIT_ERROR, "usage: party task block <id> <reason>");
    await updateTask(o, slug, id, "block", reason, fetchImpl);
    process.stdout.write(`blocked #${id}\n`);
    return;
  }
  throw new CliError(EXIT_ERROR, USAGE);
}
