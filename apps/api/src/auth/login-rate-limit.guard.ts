import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

/**
 * Per-IP throttle on the login route, on top of the per-account lockout in
 * AuthService. The old app's known limits note (CLAUDE.md, old repo) says
 * account lockout is deliberately per-account only: "owner" is a guessable
 * username, so a stranger can lock the real owner out by repeatedly
 * guessing wrong passwords from any IP. Per-account lockout alone is kept
 * (matches old behaviour), and this per-IP cap is the improvement — an
 * attacker spraying many usernames from one IP is slowed down without
 * changing the account-lockout semantics an operator already understands.
 */
@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  private readonly attempts = new Map<string, { count: number; windowStart: number }>();
  private readonly maxAttempts = 20;
  private readonly windowMs = 15 * 60 * 1000;

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const ip = request.ip;
    const now = Date.now();
    const entry = this.attempts.get(ip);

    if (!entry || now - entry.windowStart > this.windowMs) {
      this.attempts.set(ip, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= this.maxAttempts) {
      throw new HttpException("Too many login attempts — try again later", HttpStatus.TOO_MANY_REQUESTS);
    }

    entry.count += 1;
    return true;
  }
}
