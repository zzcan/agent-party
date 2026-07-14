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
export const mintToken = (o: RestOpts, name: string, kind: "agent" | "human", f?: typeof fetch) =>
  restFetch("/api/tokens", { ...o, method: "POST", body: { name, kind } }, f);
export const revokeToken = (o: RestOpts, name: string, f?: typeof fetch) =>
  restFetch(`/api/tokens/${name}`, { ...o, method: "DELETE" }, f);
export const createChannel = (o: RestOpts, body: { slug: string; title?: string; mode?: string }, f?: typeof fetch) =>
  restFetch("/api/channels", { ...o, method: "POST", body }, f);
export const listChannels = (o: RestOpts, f?: typeof fetch) => restFetch("/api/channels", o, f);
export const archiveChannel = (o: RestOpts, slug: string, f?: typeof fetch) =>
  restFetch(`/api/channels/${slug}/archive`, { ...o, method: "POST" }, f);
export const setGuard = (o: RestOpts, slug: string, limit: number | null, f?: typeof fetch) =>
  restFetch(`/api/channels/${slug}/guard`, { ...o, method: "PUT", body: { limit } }, f);
export const createTask = (o: RestOpts, slug: string, title: string, f?: typeof fetch) =>
  restFetch(`/api/channels/${slug}/tasks`, { ...o, method: "POST", body: { title } }, f);
export const listTasks = (o: RestOpts, slug: string, f?: typeof fetch) =>
  restFetch(`/api/channels/${slug}/tasks`, o, f);
export const updateTask = (
  o: RestOpts,
  slug: string,
  id: number,
  action: "claim" | "done" | "block",
  reason?: string,
  f?: typeof fetch,
) =>
  restFetch(
    `/api/channels/${slug}/tasks/${id}`,
    { ...o, method: "PATCH", body: { action, ...(reason !== undefined ? { reason } : {}) } },
    f,
  );
