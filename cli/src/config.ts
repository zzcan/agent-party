import { EXIT_ERROR } from "@agentparty-mini/shared";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors";

export interface Config {
  server: string;
  token: string;
  channel: string;
  name: string;
  kind: "agent" | "human";
}

export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "party");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function saveConfig(cfg: Config): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function loadConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) throw new CliError(EXIT_ERROR, "not initialized; run 'party init' first");
  return JSON.parse(readFileSync(p, "utf8")) as Config;
}

export function resolveChannel(cfg: Config, override?: string): string {
  return override && override.length > 0 ? override : cfg.channel;
}

export function hostOf(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server.replace(/[^a-zA-Z0-9.-]/g, "_");
  }
}

export function cursorPath(server: string, channel: string): string {
  return join(configDir(), "cursors", `${hostOf(server)}__${channel}.seq`);
}

export function loadCursor(server: string, channel: string): number {
  const p = cursorPath(server, channel);
  if (!existsSync(p)) return 0;
  const n = Number(readFileSync(p, "utf8").trim());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export function saveCursor(server: string, channel: string, seq: number): void {
  mkdirSync(join(configDir(), "cursors"), { recursive: true });
  writeFileSync(cursorPath(server, channel), String(seq));
}

export function inflightPath(server: string, channel: string): string {
  return join(configDir(), "inflight", `${hostOf(server)}__${channel}.seq`);
}

export function loadInflight(server: string, channel: string): number | null {
  const p = inflightPath(server, channel);
  if (!existsSync(p)) return null;
  const n = Number(readFileSync(p, "utf8").trim());
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function saveInflight(server: string, channel: string, seq: number): void {
  mkdirSync(join(configDir(), "inflight"), { recursive: true });
  writeFileSync(inflightPath(server, channel), String(seq));
}

export function clearInflight(server: string, channel: string): void {
  try {
    unlinkSync(inflightPath(server, channel));
  } catch {
    /* 不存在即目标态 */
  }
}
