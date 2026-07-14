import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Login } from "./Login";

describe("Login", () => {
  it("validates token via getMe and calls onLogin on success", async () => {
    const onLogin = vi.fn();
    const api = { getMe: vi.fn().mockResolvedValue({ name: "me", kind: "human" }) };
    render(<Login onLogin={onLogin} makeApi={() => api as any} defaultServer="http://h" />);
    fireEvent.change(screen.getByPlaceholderText(/token/i), { target: { value: "ap_x" } });
    fireEvent.click(screen.getByRole("button", { name: /登录|login/i }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith("http://h", "ap_x", "me", "human"));
  });

  it("shows error on invalid token", async () => {
    const api = { getMe: vi.fn().mockRejectedValue(new Error("invalid")) };
    render(<Login onLogin={vi.fn()} makeApi={() => api as any} defaultServer="http://h" />);
    fireEvent.change(screen.getByPlaceholderText(/token/i), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: /登录|login/i }));
    await waitFor(() => expect(screen.getByText(/invalid|失败/i)).toBeInTheDocument());
  });
});
