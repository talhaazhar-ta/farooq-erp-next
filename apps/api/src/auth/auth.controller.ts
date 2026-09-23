import { Body, Controller, Get, Inject, Post, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { loginSchema } from "@farooq/shared";
import { AuthService } from "./auth.service.js";
import { Public, SessionOnly } from "./permission.decorator.js";
import { CurrentUser } from "./current-user.decorator.js";
import type { AuthenticatedUser } from "./session.guard.js";
import { SESSION_ABSOLUTE_TTL_MS, SESSION_COOKIE_NAME } from "./constants.js";
import { LoginRateLimitGuard } from "./login-rate-limit.guard.js";

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @UseGuards(LoginRateLimitGuard)
  @Post("login")
  async login(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const { username, password } = loginSchema.parse(body);
    const result = await this.auth.login(username, password);

    reply.setCookie(SESSION_COOKIE_NAME, result.sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_ABSOLUTE_TTL_MS / 1000,
    });

    return { user: result.user, csrfToken: result.csrfToken, expiresAt: result.expiresAt };
  }

  @SessionOnly()
  @Post("logout")
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.auth.logout(user.sessionId);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return { ok: true };
  }

  @SessionOnly()
  @Get("me")
  me(@CurrentUser() user: AuthenticatedUser) {
    return { id: user.id, name: user.name, username: user.username, role: user.role };
  }

  // GET is safe (no state change), so it needs no CSRF header itself — it
  // exists purely to re-hydrate the CSRF token in the browser's memory
  // after a page reload, since the token is deliberately never in a
  // JS-readable cookie.
  @SessionOnly()
  @Get("csrf")
  csrf(@CurrentUser() user: AuthenticatedUser) {
    return { csrfToken: user.csrfToken };
  }
}
