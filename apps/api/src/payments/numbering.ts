import { sql } from "drizzle-orm";
import { sequences, type Tx } from "@farooq/db";

/**
 * Takes the next document number for (kind, year): `KIND-YYYY-000001`.
 *
 * One atomic statement — `INSERT ... ON CONFLICT (kind, year) DO UPDATE SET n = n + 1 RETURNING n` — so concurrent
 * takers serialise on the counter's row lock and each gets a distinct number. It runs inside the CALLER'S
 * transaction (as the legacy `FDB.nextNumber` did), so if the voucher's save rolls back the counter rolls back
 * with it: committed numbers are gap-free.
 *
 * The importer loads the live counters into `sequences`, so the first new receipt continues the live series.
 */
export async function nextNumber(tx: Tx, kind: string, year: number): Promise<string> {
  const [row] = await tx
    .insert(sequences)
    .values({ kind, year, n: 1 })
    .onConflictDoUpdate({
      target: [sequences.kind, sequences.year],
      set: { n: sql`${sequences.n} + 1`, updatedAt: sql`now()` },
    })
    .returning({ n: sequences.n });
  return formatNumber(kind, year, row!.n);
}

export const formatNumber = (kind: string, year: number, n: number): string => `${kind}-${year}-${String(n).padStart(6, "0")}`;
