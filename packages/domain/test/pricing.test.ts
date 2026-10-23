import { describe, expect, it } from "vitest";
import { estimateCost, PRICING_VERSION, priceOf } from "../src/index.js";

const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });

describe("pricing", () => {
  it("prices exact ids, dated snapshots and provider-prefixed ids", () => {
    expect(priceOf("claude-opus-5-5")?.model).toBe("claude-opus-5-5");
    expect(priceOf("claude-sonnet-4-6-20260101")?.model).toBe("claude-sonnet-4-6");
    expect(priceOf("us.anthropic.claude-haiku-4-5")?.model).toBe("claude-haiku-4-5");
    expect(priceOf("gpt-5-codex")).toBeUndefined();
  });

  it("charges cache reads and writes at their own rates", () => {
    // Sonnet 5.5: $2 in, $10 out, $0.10 cache read (0.05×), default write = 1.25 × input.
    const est = estimateCost("claude-sonnet-5-5", tokens(1_000_000, 100_000, 400_000, 100_000));
    expect(est.ok).toBe(true);
    if (!est.ok) return;
    // 500k uncached × $2 + 400k × $0.10 + 100k × $2.50 + 100k × $10, per million.
    expect(est.usd).toBeCloseTo(1 + 0.04 + 0.25 + 1, 6);
    expect(est.pricingVersion).toBe(PRICING_VERSION);
  });

  it("charges 1-hour cache writes at twice the input price", () => {
    // Opus 5.5: $4 in → 5m write $5, 1h write $8.
    const est = estimateCost("claude-opus-5-5", { ...tokens(1_000_000, 0, 0, 1_000_000), cacheWrite1hTokens: 250_000 });
    expect(est.ok && est.usd).toBeCloseTo(0.75 * 5 + 0.25 * 8, 6);
  });

  it("prices a long Haiku 5.5 prompt at the higher rates as a whole", () => {
    expect(estimateCost("claude-haiku-5-5", tokens(100_000, 0)).ok && estimateCost("claude-haiku-5-5", tokens(100_000, 0))).toMatchObject({ usd: expect.closeTo(0.01, 6) });
    const long = estimateCost("claude-haiku-5-5", tokens(200_000, 10_000, 150_000));
    // 50k × $0.50 + 150k × $0.05 + 10k × $2.50, per million.
    expect(long.ok && long.usd).toBeCloseTo(0.025 + 0.0075 + 0.025, 6);
  });

  it("warns instead of reporting $0 for unknown or missing models", () => {
    expect(estimateCost("some-new-model", tokens(10, 10))).toMatchObject({ ok: false, warning: expect.stringContaining("No price for some-new-model") });
    expect(estimateCost(undefined, tokens(10, 10))).toMatchObject({ ok: false });
  });
});
