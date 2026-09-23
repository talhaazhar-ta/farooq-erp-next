import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import fastifyCookie from "@fastify/cookie";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { createDb } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import { TEST_APP_URL } from "./setup/db-config.js";
import { eq } from "drizzle-orm";

describe("auth: login / lockout / session", () => {
  process.env.APP_DATABASE_URL = TEST_APP_URL;
  process.env.NODE_ENV = "test";

  let app: NestFastifyApplication;
  const { db, client } = createDb(TEST_APP_URL);
  const username = "auth-e2e-user";
  const password = "correct horse battery staple";

  beforeAll(async () => {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await db.insert(users).values({ name: "E2E Tester", username, passwordHash, role: "SALES" });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("rejects a bad password", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: "wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("logs in with the right password, sets a session cookie, and /auth/me works", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.username).toBe(username);
    expect(body.csrfToken).toBeTruthy();

    const cookie = res.cookies.find((c) => c.name === "fc_sid");
    expect(cookie).toBeTruthy();

    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { fc_sid: cookie!.value },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().username).toBe(username);
  });

  it("rejects a mutating request (logout) without a matching CSRF header", async () => {
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
    const cookie = login.cookies.find((c) => c.name === "fc_sid")!.value;

    const res = await app.inject({ method: "POST", url: "/auth/logout", cookies: { fc_sid: cookie } });
    expect(res.statusCode).toBe(401);
  });

  it("locks the account after 5 wrong passwords, from any request", async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: "still-wrong" } });
    }
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/locked/i);

    const [row] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    expect(row!.lockedUntil).not.toBeNull();
  });
});
