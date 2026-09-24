import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { z } from "zod";
import { api, ApiError, NETWORK_MESSAGE, setUnauthorizedHandler } from "./api";
import { ErrorLines } from "../components/ui";
import { mockApi, respond } from "../test/fetch-mock";
import { balanceCell, balanceWords } from "./format";

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe("the API client", () => {
  it("keeps every line of a 422 {message, errors[]}", async () => {
    mockApi({ "POST /payments/receive": respond(422, { message: "Refused", errors: ["one", "two", "one"] }) });
    const err = await api.post("/payments/receive", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).lines).toEqual(["one", "two"]); // de-duplicated, none dropped
  });

  it("falls back to the message when there is no errors[]", async () => {
    mockApi({ "GET /x": respond(404, { message: "Payment not found." }) });
    const err = (await api.get("/x").catch((e: unknown) => e)) as ApiError;
    expect(err.lines).toEqual(["Payment not found."]);
  });

  it("a dropped connection is a plain retry message, status 0", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const err = (await api.get("/x").catch((e: unknown) => e)) as ApiError;
    expect(err.isNetwork).toBe(true);
    expect(err.message).toBe(NETWORK_MESSAGE);
  });

  it("a 401 from a business call ends the session; a 401 from sign-in is just a wrong password", async () => {
    const ended = vi.fn();
    setUnauthorizedHandler(ended);
    mockApi({ "GET /payments": respond(401, { message: "Unauthorized" }), "POST /auth/login": respond(401, { message: "Invalid username or password" }) });
    await api.get("/payments").catch(() => undefined);
    expect(ended).toHaveBeenCalledTimes(1);
    await api.post("/auth/login", {}).catch(() => undefined);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("sends the CSRF header on writes only, and the credentials cookie always", async () => {
    const { setCsrfToken } = await import("./api");
    setCsrfToken("tok-123");
    const seen: { method: string; csrf: string | null; creds: RequestCredentials | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        seen.push({ method: String(init?.method), csrf: new Headers(init?.headers).get("x-csrf-token"), creds: init?.credentials });
        return new Response("{}", { status: 200 });
      }),
    );
    await api.get("/a");
    await api.post("/b", {});
    setCsrfToken(null);
    expect(seen).toEqual([
      { method: "GET", csrf: null, creds: "include" },
      { method: "POST", csrf: "tok-123", creds: "include" },
    ]);
  });

  it("a response the shared schema does not accept fails loudly instead of reaching a component", async () => {
    mockApi({ "GET /y": { wrong: true } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const err = (await api.getParsed("/y", z.object({ ok: z.boolean() })).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toMatch(/does not understand/);
    spy.mockRestore();
  });
});

describe("the 422 error renderer", () => {
  it("lists all lines, verbatim", () => {
    render(<ErrorLines error={new ApiError(422, "Refused", ["Invoice A is more than outstanding.", "Invoice B does not belong to this shop."])} />);
    const box = screen.getByTestId("error-lines");
    expect(box).toHaveAttribute("role", "alert");
    expect(box).toHaveTextContent("Invoice A is more than outstanding.");
    expect(box).toHaveTextContent("Invoice B does not belong to this shop.");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("offers a retry only for a network failure", () => {
    const retry = vi.fn();
    const { unmount } = render(<ErrorLines error={new ApiError(0, NETWORK_MESSAGE)} onRetry={retry} />);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    unmount();
    render(<ErrorLines error={new ApiError(422, "Refused", ["No."])} onRetry={retry} />);
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("renders nothing without an error", () => {
    const { container } = render(<ErrorLines error={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("balances in words, never a bare negative", () => {
  it("customer", () => {
    expect(balanceWords("CUSTOMER", 150_000)).toBe("Shop owes us PKR 1,500.00");
    expect(balanceWords("CUSTOMER", -150_000)).toBe("We owe the shop PKR 1,500.00 (credit)");
    expect(balanceWords("CUSTOMER", 0)).toMatch(/Settled/);
    expect(balanceCell("CUSTOMER", -150_000)).toBe("1,500.00 Cr");
    expect(balanceCell("CUSTOMER", 150_000)).toBe("1,500.00");
    expect(balanceCell("CUSTOMER", 0)).toBe("0.00"); // a settled balance carries no mark
  });
  it("supplier", () => {
    expect(balanceWords("SUPPLIER", 150_000)).toBe("We owe supplier PKR 1,500.00");
    expect(balanceWords("SUPPLIER", -150_000)).toBe("Supplier owes us PKR 1,500.00 (advance paid)");
    expect(balanceCell("SUPPLIER", -150_000)).toBe("1,500.00 Dr");
  });
});
