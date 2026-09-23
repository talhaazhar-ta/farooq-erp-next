import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@farooq/db";
import { accounts, journalEntries, journalLines } from "@farooq/db";
import { TEST_APP_URL } from "./setup/db-config.js";

describe("journal balance trigger (0001_balance_trigger_and_grants.sql)", () => {
  const { db, client } = createDb(TEST_APP_URL);
  let cashAccountId: string;
  let salesAccountId: string;

  beforeAll(async () => {
    const [cash] = await db
      .insert(accounts)
      .values({ code: "CASH-BAL-TEST", name: "Cash", type: "ASSET" })
      .returning();
    const [sales] = await db
      .insert(accounts)
      .values({ code: "SALES-BAL-TEST", name: "Sales", type: "INCOME" })
      .returning();
    cashAccountId = cash!.id;
    salesAccountId = sales!.id;
  });

  afterAll(async () => {
    await client.end();
  });

  it("commits a balanced entry", async () => {
    await db.transaction(async (tx) => {
      const [entry] = await tx.insert(journalEntries).values({ date: "2026-01-01", memo: "balanced" }).returning();
      await tx.insert(journalLines).values([
        { entryId: entry!.id, accountId: cashAccountId, debitP: 1000, creditP: 0 },
        { entryId: entry!.id, accountId: salesAccountId, debitP: 0, creditP: 1000 },
      ]);
    });
  });

  it("fails at commit when an entry's lines don't sum debit == credit", async () => {
    await expect(
      db.transaction(async (tx) => {
        const [entry] = await tx
          .insert(journalEntries)
          .values({ date: "2026-01-01", memo: "unbalanced" })
          .returning();
        await tx.insert(journalLines).values([
          { entryId: entry!.id, accountId: cashAccountId, debitP: 1000, creditP: 0 },
          { entryId: entry!.id, accountId: salesAccountId, debitP: 0, creditP: 500 },
        ]);
      }),
    ).rejects.toThrow(/unbalanced/i);
  });
});
