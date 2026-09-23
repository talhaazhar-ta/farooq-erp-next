import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { roleHasAnyPermission, roleHasPermission, type Permission } from "@farooq/shared";
import { ANY_PERMISSION_KEY, PERMISSION_KEY, PUBLIC_KEY, SESSION_ONLY_KEY } from "./permission.decorator.js";

/**
 * Deny by default: a route that is neither `@Public()` nor annotated with
 * `@RequirePermission(...)` is refused outright. There is no "protected but
 * uncontrolled" state — see CLAUDE.md / S1 auth requirements.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const user = request.user;
    if (!user) throw new ForbiddenException("Not signed in");

    const sessionOnly = this.reflector.getAllAndOverride<boolean>(SESSION_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (sessionOnly) return true;

    const anyOf = this.reflector.getAllAndOverride<Permission[] | undefined>(ANY_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (anyOf) {
      if (!roleHasAnyPermission(user.role, anyOf)) {
        throw new ForbiddenException(`Role ${user.role} lacks any of: ${anyOf.join(", ")}`);
      }
      return true;
    }

    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permission) {
      throw new ForbiddenException("Route has no declared permission requirement");
    }

    if (!roleHasPermission(user.role, permission)) {
      throw new ForbiddenException(`Role ${user.role} lacks permission ${permission}`);
    }
    return true;
  }
}
