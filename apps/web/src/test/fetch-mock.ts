import { vi } from "vitest";

export interface MockCall {
  method: string;
  path: string;
  body: unknown;
}

/** A route that answers with a specific HTTP status. (A plain value is a 200 body.) */
export const respond = (status: number, body: unknown): Handler => () => ({ status, body });

type Handler = (call: MockCall) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;

/**
 * Replaces `fetch` with a router of `"METHOD /path"` (query string ignored) → handler. Unmatched requests fail the test
 * loudly instead of quietly returning nothing. `calls` records every request, in order.
 */
export function mockApi(routes: Record<string, Handler | unknown>): { calls: MockCall[] } {
  const calls: MockCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const call: MockCall = { method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const key = Object.keys(routes).find((k) => k === `${method} ${url.pathname}`);
      if (!key) throw new Error(`Unmocked request: ${method} ${url.pathname}${url.search}`);
      const route = routes[key];
      const out = typeof route === "function" ? await (route as Handler)(call) : { body: route };
      return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  return { calls };
}
