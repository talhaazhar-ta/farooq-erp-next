import { asc } from "drizzle-orm";
import { companyProfile } from "./schema.js";
import type { Executor } from "./client.js";

/**
 * Which per-bag cost the weighted average (and so every profit figure) is built from: the imported legacy setting `profitCostBasis`
 * (`company_profile.doc`, 17-profit.js `Cost.basis`). `LANDED` = goods + the supplier's freight / loading + landed-cost entries (what
 * the real data uses); `PURCHASE` = the goods price alone. Missing or anything else = `LANDED`, the legacy default.
 * The same rule as `costBasisOf` in @farooq/shared (a test ties the two together); it is repeated here because @farooq/db does not depend on it.
 */
export type ProfitCostBasis = "LANDED" | "PURCHASE";

export const costBasisFromDoc = (doc: unknown): ProfitCostBasis =>
  (doc as { profitCostBasis?: unknown } | null | undefined)?.profitCostBasis === "PURCHASE" ? "PURCHASE" : "LANDED";

/** Reads the setting from the imported company profile (works inside or outside a transaction). S12's purchase save reuses it. */
export async function readProfitCostBasis(db: Executor): Promise<ProfitCostBasis> {
  const [row] = await db.select({ doc: companyProfile.doc }).from(companyProfile).orderBy(asc(companyProfile.id)).limit(1);
  return costBasisFromDoc(row?.doc);
}
