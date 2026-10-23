/**
 * Phrases AI CLIs print when the account's usage or rate limit is hit, e.g.
 * Claude "Claude AI usage limit reached", "5-hour limit reached ∙ resets 3pm",
 * "API Error: 429 … rate_limit_error"; Codex "You've hit your usage limit";
 * Gemini "Quota exceeded" / RESOURCE_EXHAUSTED.
 */
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /usage limit/i,
  /\blimit reached\b/i,
  /rate[ _-]?limit/i,
  /too many requests/i,
  /\b(?:api error|status|http)[:\s]*429\b/i,
  /quota exceeded/i,
  /resource[_ ]exhausted/i,
];

/** True when a CLI failure message means "stop calling, the account is throttled". */
export function isRateLimitMessage(message: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(message));
}
