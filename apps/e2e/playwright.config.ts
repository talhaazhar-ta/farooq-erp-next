import { defineConfig, devices } from "@playwright/test";
import { WEB_URL } from "./setup/env";

/**
 * `pnpm e2e` (repo root) runs everything; one spec: `pnpm --filter @farooq/e2e exec playwright test tests/receive.spec.ts`
 * (add `-g "part of a test name"` for one test, `--headed` to watch). Global setup needs `pnpm build` to have run and
 * Chromium installed once: `pnpm --filter @farooq/e2e exec playwright install chromium`.
 */
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./setup/global-setup.ts",
  // One shared database and specs that move money: strictly one test at a time, in file order.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    // CHROME_CHANNEL=chrome uses an installed Google Chrome instead of the downloaded Chromium
    ...(process.env.CHROME_CHANNEL ? { channel: process.env.CHROME_CHANNEL } : {}),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
