import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** Crockford base32 alphabet (no I, L, O, U) — easy to read aloud and type. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** Constant-time comparison of two secret digests. */
export function digestEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

export function randomCode(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Uppercases, strips separators and maps Crockford look-alikes (O→0, I/L→1). */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function formatCode(code: string): string {
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return h === "::ffff:127.0.0.1";
}

export function assertBindHost(host: string, allowNonLocal: boolean | undefined, what: string): void {
  if (!isLoopbackHost(host) && !allowNonLocal) {
    throw new Error(
      `${what} refuses to bind non-loopback host "${host}". Pass allowNonLocal: true to override (not recommended).`,
    );
  }
}
