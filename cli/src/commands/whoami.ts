import { loadConfig } from "../config";

export function whoami(): void {
  const c = loadConfig();
  process.stdout.write(`${c.name} (${c.kind}) → ${c.channel} @ ${c.server}\n`);
}
