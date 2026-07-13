import { EXIT_ERROR } from "@agentparty-mini/shared";
import { CliError } from "./errors";

export interface ArgSpec {
  bool?: string[];
  value?: string[];
  multi?: string[];
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

export function parseArgs(argv: string[], spec: ArgSpec): ParsedArgs {
  const bool = new Set(spec.bool ?? []);
  const value = new Set(spec.value ?? []);
  const multi = new Set(spec.multi ?? []);
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inlineVal = eq === -1 ? undefined : arg.slice(eq + 1);
    if (bool.has(name)) {
      flags[name] = true;
      continue;
    }
    if (value.has(name) || multi.has(name)) {
      let v: string;
      if (inlineVal !== undefined) v = inlineVal;
      else {
        if (i + 1 >= argv.length) throw new CliError(EXIT_ERROR, `flag --${name} requires a value`);
        v = argv[++i];
      }
      if (multi.has(name)) {
        const cur = (flags[name] as string[] | undefined) ?? [];
        cur.push(v);
        flags[name] = cur;
      } else {
        flags[name] = v;
      }
      continue;
    }
    throw new CliError(EXIT_ERROR, `unknown flag: --${name}`);
  }
  return { positionals, flags };
}
