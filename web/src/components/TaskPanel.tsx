import { useEffect, useRef, useState } from "react";
import type { Api, Task } from "../lib/api";
import type { Msg } from "../lib/frames";
import { ACTION_LABEL, actionsFor } from "../lib/taskActions";

export function TaskPanel({ api, slug, messages }: { api: Api; slug: string; messages: Msg[] }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const lastSystemSeq = useRef(0);

  async function refresh() {
    try {
      setTasks((await api.listTasks(slug)).tasks);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }
  useEffect(() => {
    void refresh();
  }, [slug]);

  // 见到新的 system 消息即重取（plan 4 决策 6/A）
  useEffect(() => {
    const latestSystem = [...messages].reverse().find((m) => m.sender === "system");
    if (latestSystem && latestSystem.seq > lastSystemSeq.current) {
      lastSystemSeq.current = latestSystem.seq;
      void refresh();
    }
  }, [messages]);

  async function act(id: number, action: "claim" | "done" | "block") {
    try {
      let reason: string | undefined;
      if (action === "block") {
        reason = window.prompt("阻塞原因？") ?? undefined;
        if (!reason) return;
      }
      const updated = await api.updateTask(slug, id, action, reason);
      setTasks((ts) => ts.map((t) => (t.id === id ? updated : t)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "update failed");
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    try {
      const created = await api.createTask(slug, t);
      setTasks((ts) => [...ts, created]);
      setTitle("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "create failed");
    }
  }

  return (
    <div className="tasks">
      <h3>任务</h3>
      <form onSubmit={create}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="新任务标题" />
        <button type="submit">＋</button>
      </form>
      <ul>
        {tasks.map((t) => (
          <li key={t.id} className={`task ${t.state}`}>
            <span className="tid">#{t.id}</span>
            <span className={`badge ${t.state}`}>{t.state}</span>
            <span className="assignee">{t.assignee ?? "-"}</span>
            <span className="title">{t.title}</span>
            {t.state === "blocked" && t.blocked_reason && <span className="reason">（{t.blocked_reason}）</span>}
            <span className="actions">
              {actionsFor(t.state).map((a) => (
                <button key={a} onClick={() => act(t.id, a)}>{ACTION_LABEL[a]}</button>
              ))}
            </span>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
