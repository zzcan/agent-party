import { EXIT_ARCHIVED, EXIT_AUTH, EXIT_ERROR } from "@agentparty-mini/shared";
import { CliError } from "./errors";

export interface RestOpts {
  server: string;
  token?: string;
  adminSecret?: string;
  method?: string;
  body?: unknown;
}

export async function restFetch(path: string, opts: RestOpts, fetchImpl: typeof fetch = fetch): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.adminSecret) headers["x-admin-secret"] = opts.adminSecret;
  const res = await fetchImpl(`${opts.server}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as any) : {};
  if (res.ok) return parsed;
  const msg = (parsed && parsed.error) || `HTTP ${res.status}`;
  if (res.status === 401) throw new CliError(EXIT_AUTH, `auth failed: ${msg}`);
  if (res.status === 410) throw new CliError(EXIT_ARCHIVED, `channel archived: ${msg}`);
  throw new CliError(EXIT_ERROR, `request failed: ${msg}`);
}

export const getMe = (o: RestOpts, f?: typeof fetch) => restFetch("/api/me", o, f);
export const mintToken = (o: RestOpts, name: string, kind: "agent" | "human") =>
  restFetch("/api/tokens", { ...o, method: "POST", body: { name, kind } });
export const revokeToken = (o: RestOpts, name: string) =>
  restFetch(`/api/tokens/${name}`, { ...o, method: "DELETE" });
export const createChannel = (o: RestOpts, body: { slug: string; title?: string; mode?: string }) =>
  restFetch("/api/channels", { ...o, method: "POST", body });
export const listChannels = (o: RestOpts) => restFetch("/api/channels", o);
export const archiveChannel = (o: RestOpts, slug: string) =>
  restFetch(`/api/channels/${slug}/archive`, { ...o, method: "POST" });
export const setGuard = (o: RestOpts, slug: string, limit: number | null) =>
  restFetch(`/api/channels/${slug}/guard`, { ...o, method: "PUT", body: { limit } });
