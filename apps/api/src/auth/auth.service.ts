import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Role } from "@farooq/shared";
import { DB } from "../db/db.module.js";
import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { LOGIN_LOCKOUT_MS, LOGIN_MAX_ATTEMPTS, SESSION_ABSOLUTE_TTL_MS } from "./constants.js";

export interface LoginResult {
  sessionId: string;
  csrfToken: string;
  expiresAt: Date;
  user: { id: string; name: string; username: string; role: Role };
}

@Injectable()
export class AuthService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async login(username: string, password: string): Promise<LoginResult> {
    const rows = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    const user = rows[0];

    // Constant-shape failure: unknown username still runs an argon2 hash so
    // timing doesn't reveal whether the account exists.
    const passwordHash = user?.passwordHash ?? "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new UnauthorizedException("Account locked — try again later");
    }

    const valid = await argon2.verify(passwordHash, password).catch(() => false);

    if (!user || !user.active || !valid) {
      if (user) await this.registerFailedAttempt(user.id, user.failedAttempts);
      throw new UnauthorizedException("Invalid username or password");
    }

    if (user.failedAttempts > 0 || user.lockedUntil) {
      await this.db.update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, user.id));
    }

    const csrfToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_TTL_MS);
    const [session] = await this.db
      .insert(sessions)
      .values({ userId: user.id, csrfToken, expiresAt })
      .returning();
    if (!session) throw new Error("Failed to create session");

    return {
      sessionId: session.id,
      csrfToken,
      expiresAt,
      user: { id: user.id, name: user.name, username: user.username, role: user.role as Role },
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, sessionId));
  }

  private async registerFailedAttempt(userId: string, currentAttempts: number): Promise<void> {
    const attempts = currentAttempts + 1;
    if (attempts >= LOGIN_MAX_ATTEMPTS) {
      await this.db
        .update(users)
        .set({ failedAttempts: 0, lockedUntil: new Date(Date.now() + LOGIN_LOCKOUT_MS) })
        .where(eq(users.id, userId));
    } else {
      await this.db.update(users).set({ failedAttempts: attempts }).where(eq(users.id, userId));
    }
  }
}
