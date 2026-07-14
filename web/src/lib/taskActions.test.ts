import { describe, expect, it } from "vitest";
import { actionsFor } from "./taskActions";

describe("actionsFor", () => {
  it("maps state to available actions", () => {
    expect(actionsFor("backlog")).toEqual(["claim", "block", "done"]);
    expect(actionsFor("in_progress")).toEqual(["done", "block"]);
    expect(actionsFor("blocked")).toEqual(["claim", "done"]);
    expect(actionsFor("done")).toEqual([]);
  });
});
