import { describe, expect, it } from "vitest";
import { REDACTED, redact, redactString, scrubEnv } from "../src/index.js";

describe("redaction", () => {
  it("scrubs bearer tokens, API keys, env assignments and URL credentials", () => {
    const input = [
      "Authorization: Bearer abc.def.ghi123456",
      "key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV",
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123",
      "MY_API_KEY='hello world'",
      "postgres://admin:hunter2@db:5432/x",
    ].join("\n");
    const out = redactString(input);
    expect(out).not.toContain("abc.def.ghi123456");
    expect(out).not.toContain("sk-ant-api03");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(out).not.toContain("hello world");
    expect(out).not.toContain("hunter2");
    expect(out).toContain(`Bearer ${REDACTED}`);
    expect(out).toContain(`GITHUB_TOKEN=${REDACTED}`);
    expect(out).toContain(`postgres://${REDACTED}@db`);
  });

  it("deep-redacts secret-looking keys and known secrets", () => {
    const out = redact(
      { user: "a", password: "p@ss", nested: { note: "value is s3cr3tvalue" }, list: [{ apiKey: "k" }] },
      { knownSecrets: ["s3cr3tvalue"] },
    );
    expect(out).toEqual({
      user: "a",
      password: REDACTED,
      nested: { note: `value is ${REDACTED}` },
      list: [{ apiKey: REDACTED }],
    });
  });

  it("matches secret keys by whole word, not by substring", () => {
    const out = redact({ passed: 3, failed: 0, outputTokens: 120, tokenCollections: 2, accessToken: "abc", clientSecret: "s", GITHUB_TOKEN: "t", pass: "p" });
    expect(out).toEqual({ passed: 3, failed: 0, outputTokens: 120, tokenCollections: 2, accessToken: REDACTED, clientSecret: REDACTED, GITHUB_TOKEN: REDACTED, pass: REDACTED });
  });

  it("masks secret env vars", () => {
    expect(scrubEnv({ PATH: "/bin", OPENAI_API_KEY: "x" })).toEqual({ PATH: "/bin", OPENAI_API_KEY: REDACTED });
  });
});
