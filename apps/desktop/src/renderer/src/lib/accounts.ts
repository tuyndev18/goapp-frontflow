import type { AccountDto, QuotaWindowDto } from "../../../shared/ipc.js";

/** claude-swap's severity cutoffs. */
export const WARN_PCT = 70;
export const CRIT_PCT = 90;

export type Severity = "unknown" | "ok" | "warn" | "crit";

export function severity(pct: number | undefined): Severity {
  if (pct === undefined) return "unknown";
  return pct >= CRIT_PCT ? "crit" : pct >= WARN_PCT ? "warn" : "ok";
}

/** The 5-hour session window, the limit a busy day runs into first. */
export function sessionWindow(a: AccountDto | undefined): QuotaWindowDto | undefined {
  return a?.quota?.windows.find((w) => w.key === "five_hour");
}

/** claude-swap's compact durations: "45s", "12m", "2h 13m", "3d 4h". */
export function durationText(ms: number, prefix = ""): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${prefix}${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${prefix}${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${prefix}${m % 60 ? `${h}h ${m % 60}m` : `${h}h`}`;
  const d = Math.floor(h / 24);
  return `${prefix}${h % 24 ? `${d}d ${h % 24}h` : `${d}d`}`;
}

export function resetText(iso: string, now: number): string {
  const remaining = Date.parse(iso) - now;
  if (!Number.isFinite(remaining)) return "";
  return remaining <= 0 ? "resets now" : `resets ${durationText(remaining)}`;
}

const DAY_MS = 24 * 3_600_000;

/** When the saved login (its refresh token) runs out and Claude Code asks to log in again. */
export function loginExpiry(a: AccountDto, now: number): { text: string; title: string; tone: Severity } | undefined {
  if (!a.refreshExpiresAt) return undefined;
  const left = Date.parse(a.refreshExpiresAt) - now;
  if (!Number.isFinite(left)) return undefined;
  const title = `Login valid until ${new Date(a.refreshExpiresAt).toLocaleString()}`;
  if (left <= 0) return { text: "login expired", title, tone: "crit" };
  return { text: `login expires ${durationText(left, "in ")}`, title, tone: left < 2 * DAY_MS ? "crit" : left < 7 * DAY_MS ? "warn" : "ok" };
}

/** Text class for a severity on the Accounts screen and bubble. */
export function toneClass(tone: Severity): string {
  return tone === "crit" ? "ff-wcrit" : tone === "warn" ? "ff-wwarn" : "ff-wmuted";
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

export function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString()}`;
}

export function nameOf(a: AccountDto | undefined): string {
  return a?.label ?? a?.displayName ?? a?.email ?? a?.id.slice(0, 8) ?? "account";
}
