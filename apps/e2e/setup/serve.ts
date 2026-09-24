import globalSetup from "./global-setup";
import { API_URL, WEB_URL } from "./env";

/**
 * `pnpm --filter @farooq/e2e serve` — the same stack the specs run against (throwaway Postgres, imported e2e dataset, built API,
 * built web), left running so a person or a script can look at it. Passwords are in apps/e2e/.run/state.json. Ctrl+C stops it.
 */
const teardown = await globalSetup();
console.log(`\nWeb ${WEB_URL}   API ${API_URL}   (sign-ins: apps/e2e/.run/state.json)\nCtrl+C to stop.`);
const stop = async () => {
  await teardown();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => undefined, 1 << 30);
