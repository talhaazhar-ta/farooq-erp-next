import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { corsOptions } from "../src/cors.js";

/**
 * The browser asks "may I PUT?" before an invoice edit. Found by the S10 browser tests: the default answer is GET / HEAD / POST
 * only, so editing an invoice from the web app (another origin) failed before it reached the server.
 */
describe("CORS preflight", () => {
  let app: NestFastifyApplication;
  const origin = "http://web.example.test";
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({}).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.enableCors(corsOptions(origin));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const preflight = (method: string, from = origin) =>
    app.inject({ method: "OPTIONS", url: "/invoices/x", headers: { origin: from, "access-control-request-method": method, "access-control-request-headers": "content-type,x-csrf-token" } });

  it.each(["GET", "POST", "PUT", "PATCH", "DELETE"])("allows %s from the web origin, with credentials", async (method) => {
    const res = await preflight(method);
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(String(res.headers["access-control-allow-methods"]).split(",").map((m) => m.trim())).toContain(method);
  });

  it("does not answer for another origin", async () => {
    const res = await preflight("PUT", "http://evil.example.test");
    expect(res.headers["access-control-allow-origin"]).not.toBe("http://evil.example.test");
  });

  it("defaults to the local dev origin when none is configured", () => {
    expect(corsOptions(undefined).origin).toBe(process.env.WEB_ORIGIN ?? "http://localhost:5173");
  });
});
