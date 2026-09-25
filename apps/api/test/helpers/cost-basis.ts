import type { Harness } from "./harness.js";

/**
 * Runs `fn` with the company setting `profitCostBasis` (and any other keys of the imported company profile) set as given, then puts the
 * profile back exactly as it was. The api tests share one database, so a test that changes a setting must never leave it changed.
 * With no company profile row (nothing imported yet) one is created and removed again.
 */
export async function withCostBasis(h: Harness, basis: "LANDED" | "PURCHASE", fn: () => Promise<void>, extra: Record<string, unknown> = {}): Promise<void> {
  const rows = await h.admin`SELECT id, doc FROM company_profile ORDER BY id LIMIT 1`;
  const patch = { profitCostBasis: basis, ...extra };
  if (rows.length) {
    const id = rows[0]!.id as string;
    const before = rows[0]!.doc as Record<string, unknown>;
    await h.admin`UPDATE company_profile SET doc = ${h.admin.json({ ...before, ...patch } as never)} WHERE id = ${id}`;
    try {
      await fn();
    } finally {
      await h.admin`UPDATE company_profile SET doc = ${h.admin.json(before as never)} WHERE id = ${id}`;
    }
  } else {
    const id = "000-s12-test";
    await h.admin`INSERT INTO company_profile (id, doc) VALUES (${id}, ${h.admin.json(patch as never)})`;
    try {
      await fn();
    } finally {
      await h.admin`DELETE FROM company_profile WHERE id = ${id}`;
    }
  }
}
