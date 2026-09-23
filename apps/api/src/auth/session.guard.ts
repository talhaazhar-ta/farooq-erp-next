import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Role } from "@farooq/shared";
import { DB } from "../db/db.module.js";
import type { Db } from "@farooq/db";
import { sessions, users } from "@farooq/db";
import { PUBLIC_KEY } from "./permission.decorator.js";
import { SESSION_COOKIE_NAME } from "./constants.js";

export interface AuthenticatedUser {
  id: string;
  name: string;
  username: string;
  role: Role;
  sessionId: string;
  csrfToken: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (isPublic) return true;

    const sessionId = request.cookies?.[SESSION_COOKIE_NAME];
    if (!sessionId) throw new UnauthorizedException("Not signed in");

    const rows = await this.db
      .select({
        sessionId: sessions.id,
        csrfToken: sessions.csrfToken,
        expiresAt: sessions.expiresAt,
        userId: users.id,
        name: users.name,
        username: users.username,
        role: users.role,
        active: users.active,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.id, sessionId))
      .limit(1);

    const row = rows[0];
    if (!row || !row.active) throw new UnauthorizedException("Not signed in");
    if (row.expiresAt.getTime() <= Date.now()) throw new UnauthorizedException("Session expired");

    if (MUTATING_METHODS.has(request.method)) {
      const header = request.headers["x-csrf-token"];
      if (!header || header !== row.csrfToken) {
        throw new UnauthorizedException("Missing or invalid CSRF token");
      }
    }

    // No idle timeout (owner's deliberate request, ported from the old app's
    // `idle_ttl_min = 0`) — last_seen_at is informational only, not enforced.
    await this.db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.sessionId));

    request.user = {
      id: row.userId,
      name: row.name,
      username: row.username,
      role: row.role as Role,
      sessionId: row.sessionId,
      csrfToken: row.csrfToken,
    };
    return true;
  }
}
