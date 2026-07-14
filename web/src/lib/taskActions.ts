export function actionsFor(state: string): ("claim" | "done" | "block")[] {
  switch (state) {
    case "backlog":
      return ["claim", "block", "done"];
    case "in_progress":
      return ["done", "block"];
    case "blocked":
      return ["claim", "done"];
    default:
      return [];
  }
}

export const ACTION_LABEL: Record<"claim" | "done" | "block", string> = {
  claim: "认领",
  done: "完成",
  block: "阻塞",
};
