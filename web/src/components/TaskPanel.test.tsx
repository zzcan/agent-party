import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TaskPanel } from "./TaskPanel";

const task = { id: 3, title: "ship", state: "backlog", assignee: null, created_by: "a", blocked_reason: null, created_at: 0, updated_at: 0 };

function api(over: Partial<any> = {}) {
  return {
    listTasks: vi.fn().mockResolvedValue({ tasks: [task] }),
    createTask: vi.fn().mockResolvedValue({ ...task, id: 4 }),
    updateTask: vi.fn().mockResolvedValue({ ...task, state: "in_progress", assignee: "me" }),
    ...over,
  } as any;
}

describe("TaskPanel", () => {
  it("loads and renders tasks with claim button for backlog", async () => {
    render(<TaskPanel api={api()} slug="c" messages={[]} />);
    await waitFor(() => expect(screen.getByText(/#3/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /认领|claim/i })).toBeInTheDocument();
  });

  it("claim calls updateTask", async () => {
    const a = api();
    render(<TaskPanel api={a} slug="c" messages={[]} />);
    await waitFor(() => screen.getByText(/#3/));
    fireEvent.click(screen.getByRole("button", { name: /认领|claim/i }));
    await waitFor(() => expect(a.updateTask).toHaveBeenCalledWith("c", 3, "claim", undefined));
  });
});
