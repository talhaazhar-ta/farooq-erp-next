/**
 * Cross-origin settings for the web app (it is served from a different origin from the API in dev and in the e2e stack).
 * `@fastify/cors` answers a preflight with GET, HEAD and POST only unless told otherwise — which silently refuses every
 * `PUT` (editing an invoice) in the browser, so the methods are spelled out. Content-Disposition is exposed so the browser
 * can read a CSV export's file name across origins.
 */
export function corsOptions(origin: string | undefined = process.env.WEB_ORIGIN) {
  return {
    origin: origin ?? "http://localhost:5173",
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposedHeaders: ["Content-Disposition"],
  };
}
