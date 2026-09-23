import "dotenv/config";
import argon2 from "argon2";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS } from "@farooq/shared";
import { requireEnv } from "@farooq/db";
import { rolePermissions, users } from "@farooq/db";
import { eq } from "drizzle-orm";

async function main() {
  const adminUrl = requireEnv("DATABASE_URL");
  const ownerUsername = requireEnv("OWNER_USERNAME");
  const ownerName = requireEnv("OWNER_NAME");
  const ownerPassword = requireEnv("OWNER_PASSWORD");

  const sql = postgres(adminUrl, { max: 1 });
  try {
    const db = drizzle(sql);

    const rows = (Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[]).flatMap(
      (role) => ROLE_PERMISSIONS[role].map((permission) => ({ role, permission })),
    );
    if (rows.length > 0) {
      await db.insert(rolePermissions).values(rows).onConflictDoNothing();
    }
    console.log(
      `role_permissions seeded: ${rows.length} rows across ${ROLES.length - 1} non-owner roles, ${PERMISSIONS.length} known permissions.`,
    );

    const existingRows = await db.select().from(users).where(eq(users.username, ownerUsername)).limit(1);
    const existing = existingRows[0];
    if (existing) {
      console.log(`Owner user "${ownerUsername}" already exists (id ${existing.id}) — leaving password untouched.`);
      return;
    }

    const passwordHash = await argon2.hash(ownerPassword, { type: argon2.argon2id });
    const [owner] = await db
      .insert(users)
      .values({ name: ownerName, username: ownerUsername, passwordHash, role: "OWNER" })
      .returning();
    console.log(`Owner user created: ${owner?.username} (id ${owner?.id}).`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
