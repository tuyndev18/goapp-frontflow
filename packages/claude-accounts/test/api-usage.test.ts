import { describe, expect, it } from "vitest";
import {
  fetchProfile,
  fetchQuota,
  isPollDue,
  listClaudeProcesses,
  mayRequest,
  MIN_REQUEST_GAP_MS,
  nextPoll,
  parseTranscript,
  POLL_BASE_MS,
  POLL_HOT_MS,
  RATE_LIMITED_WAIT_MS,
  usageByAccount,
  type FetchLike,
} from "../src/index.js";

const NOW = Date.parse("2026-10-23T10:00:00.000Z");

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}): { fetch: FetchLike; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { status, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, json: async () => body };
    },
  };
}

describe("quota and profile endpoints", () => {
  it("maps quota windows, keeps extra usage, and sends the OAuth beta header", async () => {
    const { fetch, calls } = fakeFetch(200, {
      seven_day: { utilization: 41, resets_at: "2026-10-27T00:00:00Z" },
      five_hour: { utilization: 87.5, resets_at: "2026-10-23T12:00:00Z" },
      seven_day_opus: null,
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 120, secret_token: "x" },
    });
    const res = await fetchQuota("at-1", { fetch, now: () => new Date(NOW) });
    expect(res.ok && res.value.windows.map((w) => [w.key, w.label, w.utilization])).toEqual([
      ["five_hour", "5h", 87.5],
      ["seven_day", "7d", 41],
    ]);
    expect(res.ok && res.value.extra).toEqual({ is_enabled: true, monthly_limit: 5000, used_credits: 120 });
    expect(calls[0]).toMatchObject({ url: "https://api.anthropic.com/api/oauth/usage", headers: { Authorization: "Bearer at-1", "anthropic-beta": "oauth-2025-04-20" } });
  });

  it("types failures instead of throwing", async () => {
    expect(await fetchQuota("t", { fetch: fakeFetch(401, {}).fetch })).toMatchObject({ ok: false, code: "unauthorized" });
    expect(await fetchQuota("t", { fetch: fakeFetch(429, {}, { "retry-after": "120" }).fetch })).toMatchObject({ ok: false, code: "rate_limited", retryAfterMs: 120_000 });
    expect(await fetchQuota("t", { fetch: fakeFetch(200, { schema: "changed" }).fetch })).toMatchObject({ ok: false, code: "bad_response" });
    expect(await fetchQuota("t", { fetch: async () => Promise.reject(new Error("offline")) })).toMatchObject({ ok: false, code: "network" });
  });

  it("flattens the profile without secrets", async () => {
    const { fetch } = fakeFetch(200, {
      account: { uuid: "acc-a", email: "a@x.dev", has_claude_max: true, nested: { x: 1 } },
      organization: { uuid: "org-1", name: "Acme", rate_limit_tier: "default_claude_max_20x", api_key: "nope", payment_auth_hosted_invoice_url: "https://pay.example/abc?sig=1", note: "https://x" },
    });
    const res = await fetchProfile("t", { fetch });
    expect(res).toEqual({
      ok: true,
      value: {
        accountUuid: "acc-a",
        fields: { "account.uuid": "acc-a", "account.email": "a@x.dev", "account.has_claude_max": true, "organization.uuid": "org-1", "organization.name": "Acme", "organization.rate_limit_tier": "default_claude_max_20x" },
      },
    });
  });
});

describe("poll policy", () => {
  const usage = (u: number, resetsAt?: string) => ({ windows: [{ key: "five_hour", label: "", utilization: u, ...(resetsAt ? { resetsAt } : {}) }], fetchedAt: "" });
  const mid = () => 0.5;

  it("polls slowly, faster near a limit, never past a reset, never under 3 minutes", () => {
    expect(nextPoll(undefined, { ok: true, usage: usage(10) }, NOW, mid)).toEqual({ nextPollAt: NOW + POLL_BASE_MS, intervalMs: POLL_BASE_MS, failures: 0 });
    expect(nextPoll(undefined, { ok: true, usage: usage(85) }, NOW, mid).intervalMs).toBe(POLL_HOT_MS);
    expect(POLL_HOT_MS).toBeGreaterThanOrEqual(MIN_REQUEST_GAP_MS);
    const soon = new Date(NOW + 30_000).toISOString();
    expect(nextPoll(undefined, { ok: true, usage: usage(10, soon) }, NOW, mid).nextPollAt).toBe(NOW + MIN_REQUEST_GAP_MS);
    const later = new Date(NOW + 4 * 60_000).toISOString();
    expect(nextPoll(undefined, { ok: true, usage: usage(10, later) }, NOW, mid).nextPollAt).toBe(NOW + 5 * 60_000);
  });

  it("waits out a whole hour after a 429, longer when asked, and backs off on errors", () => {
    const first = nextPoll(undefined, { ok: false, code: "rate_limited", retryAfterMs: 20 * 60_000 }, NOW, mid);
    expect(first).toMatchObject({ intervalMs: RATE_LIMITED_WAIT_MS, failures: 1, lastError: "rate_limited" });
    expect(first.nextPollAt).toBeGreaterThanOrEqual(NOW + RATE_LIMITED_WAIT_MS);
    expect(nextPoll(undefined, { ok: false, code: "rate_limited", retryAfterMs: 90 * 60_000 }, NOW, mid).intervalMs).toBe(90 * 60_000);
    expect(nextPoll(first, { ok: false, code: "network" }, NOW, mid).intervalMs).toBe(POLL_BASE_MS * 2);
    expect(isPollDue(first, NOW)).toBe(false);
    expect(isPollDue(undefined, NOW)).toBe(true);
  });

  it("lets Refresh skip the cadence but never the floor or an error wait", () => {
    const ok = nextPoll(undefined, { ok: true, usage: usage(10) }, NOW, mid);
    expect(mayRequest(ok, NOW - 60_000, NOW, true)).toBe(false);
    expect(mayRequest(ok, NOW - MIN_REQUEST_GAP_MS, NOW, true)).toBe(true);
    expect(mayRequest(ok, NOW - MIN_REQUEST_GAP_MS, NOW, false)).toBe(false);
    const limited = nextPoll(undefined, { ok: false, code: "rate_limited" }, NOW, mid);
    expect(mayRequest(limited, undefined, NOW + 10 * 60_000, true)).toBe(false);
    expect(mayRequest(limited, undefined, limited.nextPollAt, false)).toBe(true);
  });
});

describe("local usage from transcripts", () => {
  const line = (id: string, at: string, usage: object, model = "claude-sonnet-5-5") => JSON.stringify({ type: "assistant", timestamp: at, message: { id, model, usage } });

  it("dedups re-reported messages and skips a half-written line", () => {
    const text = [
      line("m1", "2026-10-23T09:00:00Z", { input_tokens: 10, output_tokens: 1 }),
      line("m1", "2026-10-23T09:00:00Z", { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 90 }),
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      '{"type":"assistant","message":{"id":"m2","usage":{"input_t',
    ].join("\n");
    expect(parseTranscript(text)).toEqual([{ id: "m1", at: Date.parse("2026-10-23T09:00:00Z"), model: "claude-sonnet-5-5", input: 100, output: 50, cacheRead: 90, cacheWrite: 0 }]);
  });

  it("attributes usage to the account logged in at the time, never guessing before tracking", () => {
    const messages = [
      ...parseTranscript(line("old", "2026-10-20T08:00:00Z", { input_tokens: 5, output_tokens: 5 })),
      ...parseTranscript(line("a1", "2026-10-23T08:30:00Z", { input_tokens: 1000, output_tokens: 100 })),
      ...parseTranscript(line("b1", "2026-10-23T09:30:00Z", { input_tokens: 2000, output_tokens: 200 }, "future-model")),
    ];
    const timeline = [
      { accountId: "acc-a", at: "2026-10-23T08:00:00Z" },
      { accountId: "acc-b", at: "2026-10-23T09:00:00Z" },
    ];
    const { byAccount, unattributed } = usageByAccount(messages, timeline, NOW);
    expect(unattributed).toMatchObject({ messages: 1, inputTokens: 5 });
    expect(byAccount.get("acc-a")).toMatchObject({ messages: 1, inputTokens: 1000, outputTokens: 100, last24h: { tokens: 1100 } });
    expect(byAccount.get("acc-a")!.estimatedCostUsd).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6, 9);
    expect(byAccount.get("acc-b")).toMatchObject({ estimatedCostUsd: 0, unpricedModels: ["future-model"] });
  });
});

describe("running Claude processes", () => {
  it("reads Windows CIM output and redacts command lines", async () => {
    const out = JSON.stringify([
      { pid: 101, name: "claude.exe", start: "2026-10-23T08:00:00.0000000Z", cmd: "claude.exe --resume abc" },
      { pid: 202, name: "node.exe", start: null, cmd: "node C:/x/@anthropic-ai/claude-code/cli.js ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz" },
    ]);
    const list = await listClaudeProcesses(async () => out, "win32");
    expect(list.map((p) => p.pid)).toEqual([101, 202]);
    expect(list[0]).toMatchObject({ startedAt: "2026-10-23T08:00:00.0000000Z", command: "claude.exe --resume abc" });
    expect(list[1]!.command).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
  });

  it("reads ps output on unix and survives failures", async () => {
    const ps = ["  11 Thu Oct 23 10:00:00 2026 /usr/local/bin/claude --continue", "  12 Thu Oct 23 10:00:00 2026 vim notes-about-claude.txt"].join("\n");
    expect((await listClaudeProcesses(async () => ps, "linux")).map((p) => p.pid)).toEqual([11]);
    expect(await listClaudeProcesses(async () => Promise.reject(new Error("no ps")), "linux")).toEqual([]);
  });
});
