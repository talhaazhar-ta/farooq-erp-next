import { ForbiddenException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { PermissionGuard } from "../src/auth/permission.guard.js";
import { ANY_PERMISSION_KEY, PERMISSION_KEY, PUBLIC_KEY, SESSION_ONLY_KEY } from "../src/auth/permission.decorator.js";
import type { AuthenticatedUser } from "../src/auth/session.guard.js";

function makeContext(user: AuthenticatedUser | undefined): ExecutionContext {
  const handler = () => undefined;
  const klass = class {};
  return {
    getHandler: () => handler,
    getClass: () => klass,
    switchToHttp: () => ({
      getRequest: () => ({ user }),
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

/** A guard whose Reflector returns `metadata[key]` instead of reading real
 * decorator metadata off the (undecorated) fake handler/class above. */
function makeGuard(metadata: Record<string, unknown>): PermissionGuard {
  const reflector = new Reflector();
  reflector.getAllAndOverride = ((key: string) => metadata[key]) as unknown as typeof reflector.getAllAndOverride;
  return new PermissionGuard(reflector);
}

describe("PermissionGuard (deny by default)", () => {
  it("denies a route with no @Public/@SessionOnly/@RequirePermission at all", () => {
    const guard = makeGuard({});
    const ctx = makeContext({ id: "u1", name: "A", username: "a", role: "OWNER", sessionId: "s1", csrfToken: "t" });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("allows a @Public() route even with no user", () => {
    const guard = makeGuard({ [PUBLIC_KEY]: true });
    const ctx = makeContext(undefined);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("denies INVENTORY (warehouse) role PAYMENT_CREATE — ported from legacy RBAC", () => {
    const guard = makeGuard({ [PERMISSION_KEY]: "PAYMENT_CREATE" });
    const ctx = makeContext({
      id: "u1",
      name: "Warehouse",
      username: "wh",
      role: "INVENTORY",
      sessionId: "s1",
      csrfToken: "t",
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("allows MANAGER PAYMENT_CREATE", () => {
    const guard = makeGuard({ [PERMISSION_KEY]: "PAYMENT_CREATE" });
    const ctx = makeContext({
      id: "u1",
      name: "Manager",
      username: "mgr",
      role: "MANAGER",
      sessionId: "s1",
      csrfToken: "t",
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("allows @SessionOnly() for any signed-in role without a specific permission", () => {
    const guard = makeGuard({ [SESSION_ONLY_KEY]: true });
    const ctx = makeContext({
      id: "u1",
      name: "Warehouse",
      username: "wh",
      role: "INVENTORY",
      sessionId: "s1",
      csrfToken: "t",
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});

describe("PermissionGuard — any-of routes (RequireAnyPermission)", () => {
  const user = (role: AuthenticatedUser["role"]): AuthenticatedUser => ({ id: "u1", name: "N", username: "n", role, sessionId: "s1", csrfToken: "t" });
  const readers = ["PAYMENT_CREATE", "COLLECTION_VIEW", "FINANCIAL_REPORT_VIEW"];

  it("lets a role through when it holds ANY ONE of the listed permissions", () => {
    const guard = makeGuard({ [ANY_PERMISSION_KEY]: readers });
    for (const role of ["OWNER", "MANAGER", "ACCOUNTANT", "SALES"] as const) {
      expect(guard.canActivate(makeContext(user(role))), role).toBe(true);
    }
  });

  it("refuses the warehouse role, which holds none of them", () => {
    const guard = makeGuard({ [ANY_PERMISSION_KEY]: readers });
    expect(() => guard.canActivate(makeContext(user("INVENTORY")))).toThrow(ForbiddenException);
  });

  it("an empty any-of list matches nobody (deny by default), not even OWNER", () => {
    const guard = makeGuard({ [ANY_PERMISSION_KEY]: [] });
    expect(() => guard.canActivate(makeContext(user("MANAGER")))).toThrow(ForbiddenException);
  });

  it("PAYMENT_PAYOUT is held by MANAGER/ACCOUNTANT/OWNER and refused to SALES", () => {
    const guard = makeGuard({ [PERMISSION_KEY]: "PAYMENT_PAYOUT" });
    for (const role of ["OWNER", "MANAGER", "ACCOUNTANT"] as const) expect(guard.canActivate(makeContext(user(role))), role).toBe(true);
    for (const role of ["SALES", "INVENTORY"] as const) expect(() => guard.canActivate(makeContext(user(role))), role).toThrow(ForbiddenException);
  });
});
