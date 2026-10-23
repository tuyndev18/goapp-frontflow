/**
 * Token prices for cost estimates. Versioned so stored estimates say which table
 * produced them; a model missing here yields a warning, never a silent $0.
 *
 * Source: platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-23 (global
 * routing, standard speed). Bedrock/Vertex pricing differs and is not covered; fast mode
 * and US-only inference (1.1x) are not applied.
 */
export const PRICING_VERSION = "anthropic-2026-10-23";

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million cache-read tokens; default 10% of input. */
  cacheRead?: number;
  /** USD per million 5-minute cache-write tokens; default 125% of input. */
  cacheWrite?: number;
  /** USD per million 1-hour cache-write tokens; default 200% of input. */
  cacheWrite1h?: number;
  /** Prices of a request whose prompt (all input, cache included) is over `tokens`. */
  longPrompt?: { tokens: number; price: ModelPrice };
}

const PRICES: Record<string, ModelPrice> = {
  // Cache hits: 0.025x input on Fable 5.1, 0.05x on Opus 5.5 / Sonnet 5.5, 0.1x elsewhere.
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, longPrompt: { tokens: 100_000, price: { input: 0.5, output: 2.5 } } },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export interface TokenCounts {
  /** All input tokens, cached ones included. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Part of cacheWriteTokens written to the 1-hour cache. */
  cacheWrite1hTokens?: number;
}

export type CostEstimate =
  | { ok: true; usd: number; model: string; pricingVersion: string }
  | { ok: false; warning: string };

/**
 * Exact model id first, then the id without a trailing date snapshot
 * (`claude-sonnet-4-6-20260101` → `claude-sonnet-4-6`) or provider prefix
 * (`anthropic.claude-opus-5-5`, `us.anthropic.…`).
 */
export function priceOf(model: string): { model: string; price: ModelPrice } | undefined {
  const candidates = new Set<string>();
  const lower = model.trim().toLowerCase();
  const bare = lower.replace(/^(?:[a-z]{2}\.)?anthropic\./, "").replace(/@.*$/, "");
  for (const id of [lower, bare]) {
    candidates.add(id);
    candidates.add(id.replace(/-\d{8}$/, ""));
  }
  for (const id of candidates) {
    const price = PRICES[id];
    if (price) return { model: id, price };
  }
  return undefined;
}

export function estimateCost(model: string | undefined, tokens: TokenCounts): CostEstimate {
  if (!model) return { ok: false, warning: "Model unknown — cost not estimated" };
  const found = priceOf(model);
  if (!found) return { ok: false, warning: `No price for ${model} in ${PRICING_VERSION} — cost not estimated` };
  // Per request: a long prompt is billed at the higher prices as a whole.
  const price = found.price.longPrompt && tokens.inputTokens > found.price.longPrompt.tokens ? found.price.longPrompt.price : found.price;
  const cacheRead = Math.max(0, tokens.cacheReadTokens);
  const cacheWrite = Math.max(0, tokens.cacheWriteTokens);
  const cacheWrite1h = Math.min(cacheWrite, Math.max(0, tokens.cacheWrite1hTokens ?? 0));
  const uncached = Math.max(0, tokens.inputTokens - cacheRead - cacheWrite);
  const usd =
    (uncached * price.input +
      cacheRead * (price.cacheRead ?? price.input * 0.1) +
      (cacheWrite - cacheWrite1h) * (price.cacheWrite ?? price.input * 1.25) +
      cacheWrite1h * (price.cacheWrite1h ?? price.input * 2) +
      Math.max(0, tokens.outputTokens) * price.output) /
    1_000_000;
  return { ok: true, usd, model: found.model, pricingVersion: PRICING_VERSION };
}
