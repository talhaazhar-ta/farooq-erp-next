export const APP_DB_ROLE = "farooq_app";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/**
 * `APP_DATABASE_URL`'s username must be `farooq_app` — it is the fixed name
 * of the least-privilege role created by migration 0001 (audit_log has no
 * UPDATE/DELETE grant for it). Only its password is environment-specific.
 */
export function parseAppDbPassword(appDatabaseUrl: string): string {
  const parsed = new URL(appDatabaseUrl);
  if (parsed.username !== APP_DB_ROLE) {
    throw new Error(
      `APP_DATABASE_URL must connect as role "${APP_DB_ROLE}", got "${parsed.username}"`,
    );
  }
  if (!parsed.password) throw new Error("APP_DATABASE_URL must include a password");
  return decodeURIComponent(parsed.password);
}
