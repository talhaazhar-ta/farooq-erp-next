import { SetMetadata } from "@nestjs/common";
import type { Permission } from "@farooq/shared";

export const PERMISSION_KEY = "permission";
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);

/** Explicit opt-out for routes with no business data at all (health check, login). */
export const PUBLIC_KEY = "public";
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Explicit opt-out from the *permission* check only, for the handful of
 * self-service account routes (logout, "who am I") that every signed-in
 * role must be able to call and that expose no business data. Still runs
 * through SessionGuard — a valid session cookie + CSRF token is required.
 * Everything else must declare `@RequirePermission(...)`.
 */
export const SESSION_ONLY_KEY = "sessionOnly";
export const SessionOnly = () => SetMetadata(SESSION_ONLY_KEY, true);
