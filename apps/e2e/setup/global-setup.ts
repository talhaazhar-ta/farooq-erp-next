import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { createDb, users } from "@farooq/db";
import { startTestDatabase, TEST_ADMIN_URL, TEST_APP_URL } from "@farooq/db/testing";
import { checkEnvelope, exitCodeFor, formatReport, reconcile, runImport } from "@farooq/import";
import type { Role } from "@farooq/shared";
import { buildE2eBackup } from "./dataset";
import { API_PORT, API_URL, E2E_ROLES, REPO_DIR, RUN_DIR, STATE_FILE, WEB_PORT, WEB_URL, type E2eState } from "./env";

/**
 * Before the browser tests:
 *   1. a throwaway Postgres (embedded, or CI's service container), migrated
 *   2. the e2e dataset imported through the real importer, and reconciled (a wrong import must not reach a screen test)
 *   3. one user per role with a GENERATED password (kept only in .run/state.json, which is gitignored)
 *   4. the built API started, the web app built against it and served with `vite preview`
 *   5. a signed-in storage state per role, so specs do not spend the login throttle (20 / 15 min / IP) on setup
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const apiDist = path.join(REPO_DIR, "apps/api/dist/main.js");
  if (!existsSync(apiDist)) throw new Error("apps/api/dist/main.js is missing — run `pnpm build` before `pnpm e2e`.");

  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  const children: ChildProcess[] = [];

  const stopDb = await startTestDatabase();
  const teardown = async () => {
    for (const c of children) if (!c.killed) c.kill();
    await stopDb();
  };

  try {
    // 2. data
    const backup = checkEnvelope(buildE2eBackup());
    await runImport(backup, { databaseUrl: TEST_ADMIN_URL, sourceName: "e2e-dataset" });
    const report = await reconcile(backup, TEST_ADMIN_URL);
    if (exitCodeFor(report) !== 0) throw new Error(`The e2e dataset does not reconcile:\n${formatReport(report)}`);

    // 3. users
    const { db, client } = createDb(TEST_APP_URL);
    const state: E2eState = { apiUrl: API_URL, webUrl: WEB_URL, users: {} as E2eState["users"] };
    for (const role of E2E_ROLES) {
      const username = `e2e-${role.toLowerCase()}`;
      const password = randomBytes(18).toString("base64url");
      const name = `E2E ${role[0]}${role.slice(1).toLowerCase()}`;
      const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
      const existing = await db.select().from(users).where(eq(users.username, username)).limit(1);
      if (existing[0]) await db.update(users).set({ passwordHash, role, name, failedAttempts: 0, lockedUntil: null }).where(eq(users.username, username));
      else await db.insert(users).values({ name, username, passwordHash, role });
      state.users[role] = { username, password, name, storageState: path.join(RUN_DIR, `state-${role}.json`) };
    }
    await client.end();

    // 4. servers
    children.push(
      spawn(process.execPath, [apiDist], {
        cwd: path.join(REPO_DIR, "apps/api"),
        env: { ...process.env, APP_DATABASE_URL: TEST_APP_URL, PORT: String(API_PORT), WEB_ORIGIN: WEB_URL, NODE_ENV: "development" },
        stdio: ["ignore", "ignore", "inherit"], // Nest's start-up chatter is noise; errors still show
      }),
    );
    await waitFor(`${API_URL}/health`, "the API");

    const webDir = path.join(REPO_DIR, "apps/web");
    const vite = path.join(path.dirname(createRequire(path.join(webDir, "package.json")).resolve("vite/package.json")), "bin/vite.js");
    const webOut = path.join(RUN_DIR, "web");
    await run(process.execPath, [vite, "build", "--outDir", webOut, "--emptyOutDir", "--logLevel", "warn"], webDir, { VITE_API_URL: API_URL });
    children.push(
      spawn(process.execPath, [vite, "preview", "--outDir", webOut, "--host", "127.0.0.1", "--port", String(WEB_PORT), "--strictPort"], {
        cwd: webDir,
        stdio: ["ignore", "inherit", "inherit"],
      }),
    );
    await waitFor(WEB_URL, "the web app");

    // 5. signed-in states
    for (const role of E2E_ROLES) {
      const u = state.users[role as Role];
      const res = await fetch(`${API_URL}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: u.username, password: u.password }) });
      if (!res.ok) throw new Error(`E2E sign-in for ${role} failed: ${res.status} ${await res.text()}`);
      const cookie = /fc_sid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
      if (!cookie) throw new Error(`No session cookie for ${role}`);
      writeFileSync(u.storageState, JSON.stringify({ cookies: [{ name: "fc_sid", value: cookie, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }));
    }
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    await teardown();
    throw err;
  }
  return teardown;
}

async function waitFor(url: string, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${what} did not come up at ${url} within ${timeoutMs / 1000}s (${String(last)}). Is the port already in use?`);
}

function run(cmd: string, args: string[], cwd: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(args[0] ?? cmd)} ${args[1] ?? ""} exited with ${code}`))));
    child.on("error", reject);
  });
}
