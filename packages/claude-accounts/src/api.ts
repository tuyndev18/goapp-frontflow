import type { PollState, UsageSnapshot, UsageWindow } from "./types.js";

/**
 * Claude's OAuth account endpoints, the ones Claude Code itself uses for `/usage` and the
 * profile. They are not a public, stable API: every response is validated, failures are
 * typed, and the rest of the app keeps working without them (doc §4.5, §10).
 */
export const CLAUDE_API_BASE = "https://api.anthropic.com";
const OAUTH_BETA = "oauth-2025-04-20";

export interface HttpResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<HttpResponseLike>;

export type ApiFailureCode = "unauthorized" | "rate_limited" | "http_error" | "network" | "bad_response";
export type ApiResult<T> = { ok: true; value: T } | { ok: false; code: ApiFailureCode; message: string; retryAfterMs?: number };

export interface ApiOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export interface ProfileInfo {
  accountUuid?: string;
  /** Flat, non-secret fields: `account.email`, `organization.rate_limit_tier`, … */
  fields: Record<string, string | number | boolean | null>;
}

/** Short labels, as `/usage` and claude-swap show them; per-model limits use the model's name. */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_opus: "7d Opus",
  seven_day_sonnet: "7d Sonnet",
  seven_day_oauth_apps: "7d OAuth apps",
};

export async function fetchQuota(accessToken: string, options: ApiOptions = {}): Promise<ApiResult<UsageSnapshot>> {
  const res = await getJson("/api/oauth/usage", accessToken, options);
  if (!res.ok) return res;
  if (!isObject(res.value)) return { ok: false, code: "bad_response", message: "Usage response is not an object" };
  const windows: UsageWindow[] = [];
  let extra: UsageSnapshot["extra"];
  for (const [key, value] of Object.entries(res.value)) {
    if (key === "limits" && Array.isArray(value)) {
      // Per-model weekly limits: { scope: { model: { display_name } }, percent, resets_at }.
      for (const limit of value) {
        if (!isObject(limit) || typeof limit["percent"] !== "number" || !Number.isFinite(limit["percent"])) continue;
        const scope = isObject(limit["scope"]) ? limit["scope"] : undefined;
        const model = scope && isObject(scope["model"]) ? scope["model"] : undefined;
        const name = model && typeof model["display_name"] === "string" ? model["display_name"] : undefined;
        if (!name) continue;
        const resetsAt = typeof limit["resets_at"] === "string" ? limit["resets_at"] : undefined;
        windows.push({ key: `model:${name.toLowerCase()}`, label: name, utilization: Math.max(0, Math.min(100, limit["percent"])), ...(resetsAt ? { resetsAt } : {}) });
      }
      continue;
    }
    if (!isObject(value)) continue;
    if (key === "extra_usage") {
      extra = primitives(value);
      continue;
    }
    const utilization = typeof value["utilization"] === "number" ? value["utilization"] : undefined;
    if (utilization === undefined || !Number.isFinite(utilization)) continue;
    const resetsAt = typeof value["resets_at"] === "string" ? value["resets_at"] : undefined;
    windows.push({ key, label: WINDOW_LABELS[key] ?? humanize(key), utilization: Math.max(0, Math.min(100, utilization)), ...(resetsAt ? { resetsAt } : {}) });
  }
  if (!windows.length && !extra) return { ok: false, code: "bad_response", message: "Usage response has no known quota windows" };
  windows.sort((a, b) => order(a.key) - order(b.key));
  return { ok: true, value: { windows, ...(extra ? { extra } : {}), fetchedAt: (options.now?.() ?? new Date()).toISOString() } };
}

export async function fetchProfile(accessToken: string, options: ApiOptions = {}): Promise<ApiResult<ProfileInfo>> {
  const res = await getJson("/api/oauth/profile", accessToken, options);
  if (!res.ok) return res;
  if (!isObject(res.value)) return { ok: false, code: "bad_response", message: "Profile response is not an object" };
  const fields: ProfileInfo["fields"] = {};
  for (const section of ["account", "organization"] as const) {
    const value = res.value[section];
    if (isObject(value)) for (const [k, v] of Object.entries(primitives(value))) fields[`${section}.${k}`] = v;
  }
  const account = res.value["account"];
  const uuid = isObject(account) && typeof account["uuid"] === "string" ? account["uuid"] : undefined;
  return { ok: true, value: { ...(uuid ? { accountUuid: uuid } : {}), fields } };
}

async function getJson(path: string, accessToken: string, options: ApiOptions): Promise<ApiResult<unknown>> {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  let res: HttpResponseLike;
  try {
    res = await doFetch(`${options.baseUrl ?? CLAUDE_API_BASE}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        Accept: "application/json",
        "User-Agent": "GoApp-FrontFlow",
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (err) {
    return { ok: false, code: "network", message: (err as Error).message || "Network error" };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, code: "unauthorized", message: `HTTP ${res.status}: the access token was refused` };
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    return { ok: false, code: "rate_limited", message: "HTTP 429: asked to slow down", ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}) };
  }
  if (res.status < 200 || res.status >= 300) return { ok: false, code: "http_error", message: `HTTP ${res.status}` };
  try {
    return { ok: true, value: await res.json() };
  } catch {
    return { ok: false, code: "bad_response", message: "Response is not JSON" };
  }
}

// ---- Poll policy (doc §4.5): slow by default, faster near a limit, backs off on errors. ----
//
// The usage endpoint budgets clients other than Claude Code to ~28–30 requests per account per
// trailing hour, and a burst past it blocks the account for up to an hour (measured by
// claude-swap, poll_policy.py). So: never more than one request per account every 3 minutes
// (1% of the 5-hour window, as Pitboard asks), whatever asks for it, and a 429 waits out the
// whole hour.

export const POLL_BASE_MS = 5 * 60_000;
export const POLL_HOT_MS = 3 * 60_000;
export const POLL_MAX_MS = 30 * 60_000;
/** Floor between two requests about one account, a user's Refresh included. */
export const MIN_REQUEST_GAP_MS = 3 * 60_000;
/** After a 429: the endpoint's budget is a trailing hour, so a shorter wait only re-blocks. */
export const RATE_LIMITED_WAIT_MS = 60 * 60_000;

export function nextPoll(
  state: PollState | undefined,
  outcome: { ok: true; usage: UsageSnapshot } | { ok: false; code: ApiFailureCode; retryAfterMs?: number },
  now: number,
  random: () => number = Math.random,
): PollState {
  let intervalMs: number;
  let failures = 0;
  if (outcome.ok) {
    const max = Math.max(0, ...outcome.usage.windows.map((w) => w.utilization));
    intervalMs = max >= 80 ? POLL_HOT_MS : POLL_BASE_MS;
  } else {
    failures = (state?.failures ?? 0) + 1;
    if (outcome.code === "unauthorized") intervalMs = POLL_MAX_MS;
    else if (outcome.code === "rate_limited") intervalMs = Math.max(outcome.retryAfterMs ?? 0, RATE_LIMITED_WAIT_MS);
    else intervalMs = Math.min(POLL_MAX_MS, POLL_BASE_MS * 2 ** Math.min(failures - 1, 4));
  }
  // Jitter so several apps or accounts do not poll in lockstep; a 429 wait only ever grows.
  const jitter = !outcome.ok && outcome.code === "rate_limited" ? 1 + 0.1 * random() : 0.9 + 0.2 * random();
  let nextPollAt = now + Math.max(MIN_REQUEST_GAP_MS, Math.round(intervalMs * jitter));
  if (outcome.ok) {
    // Never sleep past a reset: the numbers change right then (but keep the floor).
    const resets = outcome.usage.windows.map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN)).filter((t) => Number.isFinite(t) && t > now);
    if (resets.length) nextPollAt = Math.max(now + MIN_REQUEST_GAP_MS, Math.min(nextPollAt, Math.min(...resets) + 60_000));
  }
  return { nextPollAt, intervalMs, failures, ...(outcome.ok ? {} : { lastError: outcome.code }) };
}

export function isPollDue(state: PollState | undefined, now: number): boolean {
  return !state || state.nextPollAt <= now;
}

/**
 * May a request about this account go out now? `asked`: the user pressed Refresh, which skips
 * the normal cadence but never the 3-minute floor or a wait after an error (Pitboard skips the
 * error wait; a 429 here can block the account for an hour, so FrontFlow does not).
 */
export function mayRequest(state: PollState | undefined, lastRequestAt: number | undefined, now: number, asked: boolean): boolean {
  if (lastRequestAt !== undefined && now - lastRequestAt < MIN_REQUEST_GAP_MS) return false;
  if (state?.failures && state.nextPollAt > now) return false;
  return asked || isPollDue(state, now);
}

function order(key: string): number {
  const i = Object.keys(WINDOW_LABELS).indexOf(key);
  return i === -1 ? (key.startsWith("model:") ? 50 : 99) : i;
}

// ---- Pace: is the account using its window faster than time passes? ----

export interface WindowPace {
  /** Usage expected by now if spread evenly over the window, 0–100. */
  expectedPct: number;
  aheadOfPace: boolean;
  /** At the current rate, when the window would hit 100% (only when before its reset). */
  projectedExhaustionAt?: string;
  willLastToReset: boolean;
}

/** Window length: the 5-hour session, else a week (weekly and per-model limits). */
export function windowLengthMs(key: string): number {
  return key === "five_hour" ? 5 * 3_600_000 : 7 * 86_400_000;
}

export function paceOf(window: UsageWindow, now: number): WindowPace | undefined {
  if (!window.resetsAt) return undefined;
  const reset = Date.parse(window.resetsAt);
  const length = windowLengthMs(window.key);
  if (!Number.isFinite(reset) || reset <= now) return undefined;
  const elapsed = Math.min(length, Math.max(0, length - (reset - now)));
  if (elapsed < length * 0.02) return undefined; // too early to tell
  const expectedPct = (elapsed / length) * 100;
  const ratePerMs = window.utilization / elapsed;
  const exhaustAt = ratePerMs > 0 ? now + (100 - window.utilization) / ratePerMs : Infinity;
  const willLast = window.utilization < 100 && exhaustAt >= reset;
  return {
    expectedPct: Math.round(expectedPct * 10) / 10,
    aheadOfPace: window.utilization > expectedPct,
    ...(Number.isFinite(exhaustAt) && !willLast ? { projectedExhaustionAt: new Date(Math.max(now, exhaustAt)).toISOString() } : {}),
    willLastToReset: willLast,
  };
}

function humanize(key: string): string {
  return key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Primitive fields only, minus anything that looks like a secret — including URLs, which can
 * carry auth (the profile has a signed invoice link).
 */
function primitives(obj: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/token|secret|password|api_?key|url|link/i.test(k) || (typeof v === "string" && /^https?:\/\//i.test(v))) continue;
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}
