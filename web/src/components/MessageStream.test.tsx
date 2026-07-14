import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageStream } from "./MessageStream";
import type { Msg } from "../lib/frames";

const m = (over: Partial<Msg>): Msg => ({ type: "msg", seq: 1, ts: 0, sender: "a", sender_kind: "human", body: "b", mentions: [], reply_to: null, ...over });

describe("MessageStream", () => {
  it("renders sender and body, tags system messages", () => {
    render(<MessageStream messages={[m({ seq: 1, sender: "alice", body: "hello" }), m({ seq: 2, sender: "system", sender_kind: "agent", body: "alice 认领了 #3" })]} self="me" />);
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("alice 认领了 #3").closest(".msg")).toHaveClass("system");
  });
});
