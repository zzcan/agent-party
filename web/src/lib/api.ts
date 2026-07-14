export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Task {
  id: number;
  title: string;
  state: string;
  assignee: string | null;
  created_by: string;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface ChannelInfo {
  slug: string;
  title: string;
  mode: string;
}

async function req(server: string, token: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${server}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  return body;
}

export function makeApi(server: string, token: string) {
  return {
    getMe: () => req(server, token, "/api/me") as Promise<{ name: string; kind: "agent" | "human" }>,
    listChannels: () => req(server, token, "/api/channels") as Promise<{ channels: ChannelInfo[] }>,
    createChannel: (slug: string, title?: string) =>
      req(server, token, "/api/channels", { method: "POST", body: JSON.stringify({ slug, ...(title ? { title } : {}) }) }),
    listTasks: (slug: string) => req(server, token, `/api/channels/${slug}/tasks`) as Promise<{ tasks: Task[] }>,
    createTask: (slug: string, title: string) =>
      req(server, token, `/api/channels/${slug}/tasks`, { method: "POST", body: JSON.stringify({ title }) }) as Promise<Task>,
    updateTask: (slug: string, id: number, action: "claim" | "done" | "block", reason?: string) =>
      req(server, token, `/api/channels/${slug}/tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ action, ...(reason !== undefined ? { reason } : {}) }),
      }) as Promise<Task>,
  };
}

export type Api = ReturnType<typeof makeApi>;
