import { sha256 } from "@frontflow/domain";

const EXCERPT_MAX = 160;

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function excerpt(text: string, max = EXCERPT_MAX): string {
  const flat = collapseWhitespace(text);
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Removes common inline Markdown decoration while keeping the readable text. */
export function stripInline(text: string): string {
  return collapseWhitespace(
    text
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|`/g, "")
      .replace(/(^|[\s(])__(\S.*?\S|\S)__(?=$|[\s).,;:!?])/g, "$1$2")
      .replace(/(^|[\s(])\*(\S.*?\S|\S)\*(?=$|[\s).,;:!?])/g, "$1$2"),
  );
}

/** Lowercase, diacritics removed (đ → d) — used for label matching only. */
export function foldLabel(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function shortHash(value: string, length = 12): string {
  return sha256(value).slice(0, length);
}

export function uniq<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Split a field value into multiple values on `;` (always) and `,` (when allowed). */
export function splitValues(value: string, splitComma: boolean): string[] {
  const parts = value.split(";").flatMap((p) => (splitComma ? p.split(",") : [p]));
  return parts.map((p) => collapseWhitespace(p)).filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------
// Codes and states
// ---------------------------------------------------------------------------

const UPPER_TOKEN = /(?<![\p{L}\p{N}_-])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*(?![\p{L}\p{N}_-])/gu;
const SNAKE_TOKEN = /(?<![\p{L}\p{N}_-])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![\p{L}\p{N}_-])/gu;

const NON_STATE_WORDS = new Set([
  "API", "ID", "IDS", "HTTP", "HTTPS", "URL", "URI", "JSON", "YAML", "XML", "UI", "UX", "FE", "BE", "BA", "QA",
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "OK", "AND", "OR", "NOT", "MUST", "SHALL",
  "SHOULD", "MAY", "TODO", "TBD", "NOTE", "N/A", "NA", "PDF", "CSV", "SMS", "OTP", "JWT", "UTC", "ISO", "UUID",
  "CRUD", "SLA", "VAT", "USD", "VND", "EUR", "THE", "FAQ", "CTA", "MVP",
]);

const ERROR_MARKERS =
  /(?:^|_)(?:NOT_FOUND|INVALID|ERROR|CANNOT|CANT|FORBIDDEN|DENIED|UNAUTHORI[SZ]ED|ALREADY|EXPIRED|FAILED|FAILURE|EXCEEDED|MISSING|REQUIRED|NOT_ALLOWED|TOO_MANY|TOO_LONG|TOO_SHORT|LIMIT|CONFLICT|DUPLICATE|UNAVAILABLE|TIMEOUT|INSUFFICIENT|MISMATCH|REJECTED|LOCKED|BLOCKED)(?:_|$)/;

export function isErrorLikeCode(token: string): boolean {
  return token.includes("_") && ERROR_MARKERS.test(token);
}

/** Requirement-style ids are removed first so BA-ORDER-001 does not leak ORDER as a state. */
function withoutIds(text: string): string {
  return text.replace(/\b[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*-\d+[A-Z]?\b/g, " ");
}

/** UPPER_SNAKE state tokens such as PENDING or IN_PROGRESS (error-like codes excluded). */
export function extractStateTokens(text: string): string[] {
  const out: string[] = [];
  for (const match of withoutIds(text).matchAll(UPPER_TOKEN)) {
    const token = match[0];
    if (token.length < 3 || NON_STATE_WORDS.has(token) || /^\d/.test(token) || isErrorLikeCode(token)) continue;
    out.push(token);
  }
  return uniq(out);
}

/** UPPER_SNAKE codes; `strict` keeps only error-looking codes (used for free text). */
export function extractErrorCodes(text: string, strict: boolean): string[] {
  const out: string[] = [];
  const source = withoutIds(text);
  const pattern = strict ? SNAKE_TOKEN : UPPER_TOKEN;
  for (const match of source.matchAll(pattern)) {
    const token = match[0];
    if (token.length < 3 || NON_STATE_WORDS.has(token)) continue;
    if (strict && !isErrorLikeCode(token)) continue;
    out.push(token);
  }
  return uniq(out);
}

const NEGATION_BEFORE = /(?:\bnot|\bnever|\bno longer|\bisn't|\bisnt|\bwon't|\bcannot|\bkhông|\bchưa|\bkhông còn|\bkhông được)\s+(?:\S+\s+){0,2}$/i;

/** True when the occurrence of `token` at `index` is negated by a nearby preceding word. */
export function isNegatedAt(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 40), index);
  return NEGATION_BEFORE.test(before);
}

/** Canonical form used to detect "same concept, different spelling" (CANCELLED vs CANCELED). */
export function canonicalToken(token: string): string {
  return token
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/([A-Z])\1+/g, "$1")
    .replace(/OUR/g, "OR")
    .replace(/ISE/g, "IZE");
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Same concept with a different spelling/value, but not identical. */
export function isVariantOf(a: string, b: string): boolean {
  if (a === b) return false;
  if (a.toUpperCase() === b.toUpperCase()) return true;
  const ca = canonicalToken(a);
  const cb = canonicalToken(b);
  if (ca === cb) return true;
  return Math.min(ca.length, cb.length) >= 6 && ca[0] === cb[0] && editDistance(ca, cb) <= 1;
}

// ---------------------------------------------------------------------------
// Word tokens (for heuristic matching)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "is", "are", "be", "been", "by", "for", "and", "or", "in", "on", "with", "as", "at",
  "from", "when", "then", "given", "that", "this", "it", "its", "their", "his", "her", "can", "will", "must",
  "shall", "should", "able", "into", "via", "per", "all", "any", "has", "have", "was", "were", "which", "who",
  "if", "not", "no", "only", "id", "api", "v1", "v2", "status", "becomes", "become",
  "của", "và", "là", "được", "có", "cho", "các", "những", "một", "khi", "thì", "với", "để", "trong", "này",
]);

const IRREGULAR: Record<string, string> = {
  cancellation: "cancel",
  canceled: "cancel",
  cancelled: "cancel",
  canceling: "cancel",
  cancelling: "cancel",
  shipment: "ship",
  details: "detail",
  approval: "approve",
  creation: "create",
  deletion: "delete",
  removal: "remove",
  submission: "submit",
  refunded: "refund",
  addresses: "address",
};

export function stem(word: string): string {
  const w = word.toLowerCase();
  const irregular = IRREGULAR[w];
  if (irregular) return irregular;
  if (!/^[a-z]+$/.test(w)) return w;
  let s = w;
  if (s.endsWith("ies") && s.length > 4) s = `${s.slice(0, -3)}y`;
  else if (s.endsWith("ing") && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith("ed") && s.length > 4) s = s.slice(0, -2);
  else if (s.endsWith("es") && s.length > 4 && /(?:ss|sh|ch|x|z)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith("s") && !s.endsWith("ss") && s.length > 3) s = s.slice(0, -1);
  if (/([b-df-hj-np-tv-z])\1$/.test(s) && s !== w && !s.endsWith("ss")) s = s.slice(0, -1);
  return s;
}

/** Splits camelCase / kebab / snake / path text into stemmed lowercase tokens. */
export function wordTokens(text: string): string[] {
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const out: string[] = [];
  for (const match of spaced.matchAll(/[\p{L}\p{N}]+/gu)) {
    const raw = match[0].toLowerCase();
    if (raw.length < 2 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    const stemmed = stem(raw);
    if (!STOPWORDS.has(stemmed)) out.push(stemmed);
  }
  return out;
}

export function wordSet(text: string): Set<string> {
  return new Set(wordTokens(text));
}

/** Normalizes an actor/role label for comparison: "Support agent" → ["SUPPORT", "AGENT"]. */
export function roleWords(role: string): string[] {
  return foldLabel(role)
    .split(" ")
    .filter((w) => w.length > 0)
    .map((w) => stem(w).toUpperCase());
}

export function rolesMatch(actor: string, role: string): boolean {
  const a = roleWords(actor);
  const r = roleWords(role);
  if (a.length === 0 || r.length === 0) return false;
  if (a.join("_") === r.join("_")) return true;
  const [shorter, longer] = a.length <= r.length ? [a, r] : [r, a];
  return shorter.every((w) => longer.includes(w));
}
