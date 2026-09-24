import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCompanyDoc, ImportError, looksLikeCredentialName, prepareImport, runImport } from "../src/index.js";
import { IMPORT_OPTS, adminSql, fixture, mutate } from "./helpers.js";

/**
 * S4: the voucher snapshots (`partyNameSnapshot` …) are mapped into columns, and the `business` settings document is
 * loaded VERBATIM into company_profile — after a credential check, because a verbatim copy has no field-level net.
 */
const sql = adminSql();
beforeAll(async () => {
  await runImport(fixture(), IMPORT_OPTS);
});
afterAll(async () => {
  await sql.end();
});

describe("payment snapshots (what the voucher printed)", () => {
  it("are loaded from the legacy fields, empty strings becoming NULL", async () => {
    const rows = await sql`
      SELECT legacy_id, party_name_snapshot AS n, party_owner_snapshot AS o, region_snapshot AS r
      FROM payments WHERE legacy_id IN ('pay-1', 'pay-4', 'pay-6') ORDER BY legacy_id`;
    expect(rows.map((r) => [r.legacy_id, r.n, r.o, r.r])).toEqual([
      ["pay-1", "Al-Noor Traders", "Noor", "الفا بازار — Alpha Bazar"],
      ["pay-4", "Sunrise Mills Ltd", null, null], // a supplier: no owner line, no region
      ["pay-6", "Cash Counter", null, "الفا بازار — Alpha Bazar"],
    ]);
  });
  it("are 'mapped' now: only createdBy and description stay document-only", async () => {
    const backup = mutate((b) => { b.data.payments[0].partyNameSnapshot = 42; });
    expect(() => prepareImport(backup)).toThrow(ImportError);
    expect(() => prepareImport(backup)).toThrow(/payments\[id=pay-1\]\.partyNameSnapshot: expected a string/);
  });
});

describe("the business store → company_profile, verbatim", () => {
  it("loads the one document as-is (every key, nested values included) under its own id", async () => {
    const rows = await sql`SELECT id, doc, updated_at FROM company_profile`;
    expect(rows).toHaveLength(1);
    const source = fixture().data.business![0]!;
    expect(rows[0]!.id).toBe("biz");
    expect(rows[0]!.doc).toEqual(source);
    expect(rows[0]!.doc.categories).toEqual(["Flour", "Sugar"]);
    expect(rows[0]!.doc.requirePinOnSwitch).toBe(false);
  });
  it("is replaced (not appended) by a second import", async () => {
    await runImport(mutate((b) => { b.data.business[0].businessName = "Renamed & Co"; }), IMPORT_OPTS);
    const rows = await sql`SELECT doc->>'businessName' AS n FROM company_profile`;
    expect(rows.map((r) => r.n)).toEqual(["Renamed & Co"]);
    await runImport(fixture(), IMPORT_OPTS);
  });
  it("a new setting added in the old ERP does not abort the import (a settings bag has no field list)", () => {
    const backup = mutate((b) => { b.data.business[0].someBrandNewPreference = { nested: [1, 2, 3] }; });
    expect(() => prepareImport(backup)).not.toThrow();
  });
  it("a document without an id aborts naming the store", () => {
    expect(() => prepareImport(mutate((b) => { delete b.data.business[0].id; }))).toThrow(/business\[id=\?\]\.id: expected a non-empty string/);
  });
});

describe("the credential guard (fail loudly on a secret in the settings)", () => {
  it.each([
    ["smtpPassword", "hunter2"],
    ["adminPIN", "1234"],
    ["pin", 1234], // a numeric PIN is still a secret
    ["apiKey", "sk-live-abc"],
    ["api_key", "sk-live-abc"],
    ["smsApiToken", "t0k3n"],
    ["clientSecret", "shh"],
    ["webhook-secret", "shh"],
    ["privateKey", "-----BEGIN"],
    ["passwordHash", "$argon2id$..."],
    ["salt", "x"],
  ] as [string, unknown][])("a top-level '%s' holding a value aborts, naming the key", async (key, value) => {
    const backup = mutate((b) => { b.data.business[0][key] = value; });
    expect(() => prepareImport(backup)).toThrow(ImportError);
    expect(() => prepareImport(backup)).toThrow(`the setting '${key}' looks like a credential`);
    await expect(runImport(backup, IMPORT_OPTS)).rejects.toThrow(/looks like a credential/);
    const [n] = await sql`SELECT count(*)::int AS n FROM company_profile`;
    expect(n!.n).toBe(1); // nothing was written or wiped: the previous good import is intact
  });
  it("is checked at every depth: a nested object or an array of objects", () => {
    expect(() => prepareImport(mutate((b) => { b.data.business[0].sms = { provider: "x", authToken: "abc" }; }))).toThrow(/the setting 'sms\.authToken' looks like a credential/);
    expect(() => prepareImport(mutate((b) => { b.data.business[0].accounts = [{ name: "a" }, { password: "p" }]; }))).toThrow(/the setting 'accounts\[1\]\.password'/);
  });
  it("a value under a credential-looking name that is an object aborts too", () => {
    expect(() => prepareImport(mutate((b) => { b.data.business[0].secrets = { a: 1 }; }))).toThrow(/the setting 'secrets'/);
  });

  it("the real backup's `requirePinOnSwitch: false` is a switch, not a secret — it must NOT abort (deviation from the plan's /pin/i)", () => {
    // by name it looks like a credential ...
    expect(looksLikeCredentialName("requirePinOnSwitch")).toBe(true);
    // ... but its value is a boolean flag, so it passes
    expect(() => checkCompanyDoc({ id: "biz", requirePinOnSwitch: false })).not.toThrow();
    expect(() => checkCompanyDoc({ id: "biz", requirePinOnSwitch: true })).not.toThrow();
    expect(() => prepareImport(fixture())).not.toThrow(); // the fixture carries it, like the real file
  });
  it("an empty or null value under a credential name is not a secret", () => {
    expect(() => checkCompanyDoc({ id: "x", smtpPassword: "", apiKey: null })).not.toThrow();
  });
  it("names are matched by WORD, so ordinary settings that merely contain the letters are fine", () => {
    for (const k of ["shippingNotes", "mapping", "spinCount", "opinion", "compass", "hashtags", "passengerCount", "keyboardLayout", "monkey"]) {
      expect(looksLikeCredentialName(k), k).toBe(false);
      expect(() => checkCompanyDoc({ id: "x", [k]: "some value" }), k).not.toThrow();
    }
  });
  it("word splitting: camelCase, snake_case, kebab-case and acronyms", () => {
    for (const k of ["PIN", "userPin", "user_pin", "user-pin", "Pin", "PINCode", "pass_word", "accessKey", "api-key"]) {
      expect(looksLikeCredentialName(k), k).toBe(true);
    }
  });
});
