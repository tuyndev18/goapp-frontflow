import { describe, expect, it } from "vitest";
import { isRateLimitMessage } from "../src/rate-limit.js";

describe("isRateLimitMessage", () => {
  it.each([
    "Claude AI usage limit reached|1760000000",
    "5-hour limit reached ∙ resets 3pm",
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
    "You've hit your usage limit. Upgrade to Pro or try again later.",
    "429 Too Many Requests",
    "Quota exceeded for quota metric 'Generate Content API requests'",
    "RESOURCE_EXHAUSTED",
  ])("detects %s", (message) => {
    expect(isRateLimitMessage(message)).toBe(true);
  });

  it.each([
    "Prompt is too long",
    "claude exited (code 1) before completing",
    "error_max_turns",
    "Session exceeded 600000ms",
    "Fixed bug on line 429 of parser.ts",
  ])("ignores %s", (message) => {
    expect(isRateLimitMessage(message)).toBe(false);
  });
});
