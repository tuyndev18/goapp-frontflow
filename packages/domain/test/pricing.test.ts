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
    // Sonnet 5.5: $2 in, $10 out, $0.20 cache read, default write = 1.25 × input.
    const est = estimateCost("claude-sonnet-5-5", tokens(1_000_000, 100_000, 400_000, 100_000));
    expect(est.ok).toBe(true);
    if (!est.ok) return;
    // 500k uncached × $2 + 400k × $0.20 + 100k × $2.50 + 100k × $10, per million.
    expect(est.usd).toBeCloseTo(1 + 0.08 + 0.25 + 1, 6);
    expect(est.pricingVersion).toBe(PRICING_VERSION);
  });

  it("warns instead of reporting $0 for unknown or missing models", () => {
    expect(estimateCost("some-new-model", tokens(10, 10))).toMatchObject({ ok: false, warning: expect.stringContaining("No price for some-new-model") });
    expect(estimateCost(undefined, tokens(10, 10))).toMatchObject({ ok: false });
  });
});
