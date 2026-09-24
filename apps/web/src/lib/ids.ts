/**
 * A fresh idempotency key for one Save (the API accepts 8-100 letters, digits, "-" and "_"). `crypto.randomUUID` only
 * exists in secure contexts (https / localhost); an office PC opening the ERP over plain http on the LAN would not
 * have it, so fall back to `getRandomValues`.
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
