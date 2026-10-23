/**
 * Secret redaction (spec §21.2, DoD #12). Applied before any event, log or
 * artifact is persisted or sent to the renderer.
 */
export const REDACTED = "[REDACTED]";

/**
 * Matched against the key normalized to snake_case, as the last word, so that
 * `apiKey`, `GITHUB_TOKEN` and `client_secret` are secret but `passed`,
 * `outputTokens` and `tokenCollections` are not.
 */
const SECRET_KEY_PATTERN =
  /(^|_)(password|passwd|pass|pwd|secret|token|api_?key|access_?key|authorization|cookie|credentials?|private_?key|session_?key)$/;

function isSecretKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s.]+/g, "_")
    .toLowerCase();
  return SECRET_KEY_PATTERN.test(normalized);
}

type Replacer = (match: string, ...groups: string[]) => string;

const VALUE_RULES: Array<[RegExp, Replacer]> = [
  // PEM private keys
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => REDACTED],
  // Bearer / Basic auth headers
  [/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/g, (_m, scheme) => `${scheme} ${REDACTED}`],
  // KEY=value assignments for secret-looking env names
  [
    /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g,
    (_m, name) => `${name}=${REDACTED}`,
  ],
  // URL credentials: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, (_m, scheme) => `${scheme}${REDACTED}@`],
  // Anthropic / OpenAI / generic sk- keys
  [/\bsk-(?:ant-)?[A-Za-z0-9\-_]{16,}/g, () => REDACTED],
  // GitHub tokens
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, () => REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, () => REDACTED],
  // Google API keys
  [/\bAIza[0-9A-Za-z\-_]{30,}/g, () => REDACTED],
  // AWS access key ids
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => REDACTED],
  // Slack tokens
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, () => REDACTED],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => REDACTED],
];

export interface RedactOptions {
  /** Extra literal values to scrub (e.g. secrets loaded from the OS vault). */
  knownSecrets?: string[];
}

export function redactString(input: string, options: RedactOptions = {}): string {
  let out = input;
  for (const secret of options.knownSecrets ?? []) {
    if (secret && secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacer] of VALUE_RULES) {
    out = out.replace(pattern, replacer as (substring: string, ...args: unknown[]) => string);
  }
  return out;
}

/** Deep-redacts any JSON-like value. Secret-looking keys have their whole value replaced. */
export function redact<T>(value: T, options: RedactOptions = {}): T {
  return redactInner(value, options, new WeakSet()) as T;
}

function redactInner(value: unknown, options: RedactOptions, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value, options);
  if (Array.isArray(value)) return value.map((v) => redactInner(v, options, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key) && (typeof v === "string" || typeof v === "number")) {
        out[key] = REDACTED;
      } else {
        out[key] = redactInner(v, options, seen);
      }
    }
    return out;
  }
  return value;
}

/** Returns a copy of an env map with secret-looking variables masked. */
export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(env)) {
    if (v === undefined) continue;
    out[key] = isSecretKey(key) || /KEY$/i.test(key) ? REDACTED : v;
  }
  return out;
}
