export const TEST_PG_PORT = 55433;
export const TEST_DB_NAME = "farooq_erp_test";
export const TEST_ADMIN_USER = "postgres";
export const TEST_ADMIN_PASSWORD = "postgres";
export const TEST_APP_PASSWORD = "test-app-password";

/**
 * Local/default: a throwaway embedded-postgres instance (no Docker needed).
 * CI (S1's definition of done): set EXTERNAL_TEST_DATABASE_URL to point at
 * the Postgres service container instead — global-setup.ts skips spinning
 * up embedded-postgres when this is set. Either way tests connect through
 * the same farooq_app least-privilege role.
 */
export const TEST_ADMIN_URL =
  process.env.EXTERNAL_TEST_DATABASE_URL ??
  `postgresql://${TEST_ADMIN_USER}:${TEST_ADMIN_PASSWORD}@127.0.0.1:${TEST_PG_PORT}/${TEST_DB_NAME}`;

export const TEST_APP_URL = (() => {
  const url = new URL(TEST_ADMIN_URL);
  url.username = "farooq_app";
  url.password = TEST_APP_PASSWORD;
  return url.toString();
})();
