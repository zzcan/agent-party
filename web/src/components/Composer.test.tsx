import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "./Composer";

describe("Composer", () => {
  it("submits body and extracted mentions", () => {
    const send = vi.fn();
    render(<Composer onSend={send} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hi @bob and @carol" } });
    fireEvent.submit(screen.getByTestId("composer-form"));
    expect(send).toHaveBeenCalledWith("hi @bob and @carol", ["bob", "carol"]);
  });
  it("does not submit empty body", () => {
    const send = vi.fn();
    render(<Composer onSend={send} />);
    fireEvent.submit(screen.getByTestId("composer-form"));
    expect(send).not.toHaveBeenCalled();
  });
});
