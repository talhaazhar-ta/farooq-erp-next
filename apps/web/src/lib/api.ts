import type { z } from "zod";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

/** Called once by the auth provider: a 401 from any non-auth call means the session ended. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

export const NETWORK_MESSAGE = "Can’t reach the server. Check the connection and try again.";

/**
 * A refused request. `errors` carries EVERY line the server sent (`{message, errors[]}` — allocation problems come as
 * several lines), `message` is the headline. `status` 0 means the request never got an answer.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public errors: string[] = [],
  ) {
    super(message);
  }
  get isNetwork(): boolean {
    return this.status === 0;
  }
  /** Every line worth showing, de-duplicated, headline first. */
  get lines(): string[] {
    const all = this.errors.length > 0 ? this.errors : [this.message];
    return [...new Set(all.filter(Boolean))];
  }
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  /** True for /auth/* calls, whose 401 is an answer (bad password), not an ended session. */
  auth?: boolean;
}

async function send(path: string, init: RequestOptions = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && csrfToken) {
    headers.set("x-csrf-token", csrfToken);
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      credentials: "include",
      ...(init.signal ? { signal: init.signal } : {}),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, NETWORK_MESSAGE);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: unknown; errors?: unknown };
    const errors = Array.isArray(body.errors) ? body.errors.filter((e): e is string => typeof e === "string") : [];
    const message = typeof body.message === "string" && body.message ? body.message : res.statusText || `Request failed (${res.status})`;
    if (res.status === 401 && !init.auth && !path.startsWith("/auth/")) onUnauthorized?.();
    throw new ApiError(res.status, message, errors);
  }
  return res;
}

async function request<T>(path: string, init?: RequestOptions): Promise<T> {
  const res = await send(path, init);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** GET + validate the answer against the shared Zod schema, so a drifting server fails loudly here, not in a component. */
async function getParsed<S extends z.ZodTypeAny>(path: string, schema: S, signal?: AbortSignal): Promise<z.infer<S>> {
  const json = await request<unknown>(path, signal ? { signal } : {});
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.error("Unexpected response shape from", path, parsed.error.issues);
    throw new ApiError(0, "The server sent something this screen does not understand. Reload the page; if it keeps happening, tell the developer.");
  }
  return parsed.data;
}

async function postParsed<S extends z.ZodTypeAny>(path: string, body: unknown, schema: S): Promise<z.infer<S>> {
  const json = await request<unknown>(path, { method: "POST", body });
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.error("Unexpected response shape from", path, parsed.error.issues);
    throw new ApiError(0, "The change may have been saved, but the answer was not understood. Check the Payments list before trying again.");
  }
  return parsed.data;
}

/** Downloads a file the API produces (the CSV export) with the session cookie, keeping the server's file name. */
async function download(path: string): Promise<{ blob: Blob; filename: string }> {
  const res = await send(path);
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  return { blob: await res.blob(), filename: match?.[1] ?? "download.csv" };
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, opts?: { auth?: boolean }) =>
    request<T>(path, { method: "POST", body, ...(opts?.auth ? { auth: true } : {}) }),
  getParsed,
  postParsed,
  download,
};
