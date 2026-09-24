import { ImportError, type Doc } from "./validate.js";

/**
 * The `business` store is loaded verbatim into `company_profile` (a settings bag the app reads whole), so nothing
 * field-by-field stops a secret that someone once typed into a setting from being copied into the new database.
 * This guard is the field check it does get: a setting whose NAME says credential and whose VALUE is a real value
 * aborts the import, naming the store and the key. Nothing is written.
 *
 * Name: the key is split into words (camelCase, snake_case, kebab-case, digits) and any word of {@link CREDENTIAL_WORDS}
 * — or the pairs api+key / private+key / access+key / secret+key — makes it credential-looking. Word-wise, so
 * `shipping` or `mapping` are not "pin"; but `requirePinOnSwitch` is, by name.
 *
 * Value: a boolean, null or empty string is a flag, not a secret. The REAL backup carries `requirePinOnSwitch: false`
 * (a switch: "ask for a PIN when switching user"), which must not stop the import — a naive `/pin/i` on the key name
 * would have (recorded as a deviation from the S4 plan's regex). A string, a number (a PIN can be numeric) or a
 * nested value under such a key still aborts. Keys are checked at every depth.
 */
export const CREDENTIAL_WORDS = new Set([
  "pass", "password", "passwd", "passcode", "passphrase", "secret", "secrets", "token", "tokens", "apikey", "pin",
  "pincode", "salt", "hash", "credential", "credentials", "privatekey",
]);
const CREDENTIAL_PAIRS = [["api", "key"], ["private", "key"], ["access", "key"], ["secret", "key"]] as const;

/** `requirePinOnSwitch` → ["require", "pin", "on", "switch"]; `api_key` → ["api", "key"]. */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z\d]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export const looksLikeCredentialName = (key: string): boolean => {
  const words = keyWords(key);
  if (words.some((w) => CREDENTIAL_WORDS.has(w))) return true;
  return CREDENTIAL_PAIRS.some(([a, b]) => words.some((w, i) => w === a && words[i + 1] === b));
};

/** A flag or an absent value carries no secret. */
const isFlagOrEmpty = (v: unknown): boolean => v === null || v === undefined || typeof v === "boolean" || v === "";

function findCredential(value: unknown, path: string): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findCredential(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const here = path ? `${path}.${k}` : k;
      if (looksLikeCredentialName(k) && !isFlagOrEmpty(v)) return here;
      const hit = findCredential(v, here);
      if (hit) return hit;
    }
  }
  return null;
}

/** Throws an ImportError naming the offending key; returns the document unchanged when it is clean. */
export function checkCompanyDoc(doc: Doc): Doc {
  const hit = findCredential(doc, "");
  if (hit) {
    throw new ImportError(
      `business[id=${String(doc.id ?? "?")}]: the setting '${hit}' looks like a credential (its name says so and it holds a value). ` +
        `The settings document is loaded verbatim into company_profile and must never carry a secret: remove it from the backup source. Nothing was written.`,
    );
  }
  return doc;
}
