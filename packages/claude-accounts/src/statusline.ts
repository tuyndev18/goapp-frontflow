import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageSnapshot, UsageWindow } from "./types.js";

/**
 * Quota without asking Anthropic. After every response Claude Code runs its `statusLine`
 * command with the session as JSON on stdin, and that JSON holds `rate_limits.five_hour` and
 * `rate_limits.seven_day`, each `used_percentage` and `resets_at`, from the response's own
 * headers — for the login the session holds, whatever account that is (it names none).
 * FrontFlow's `ffswap statusline` files each reading here; the app picks them up.
 */
export interface StatusLineReading {
  /** When the session passed it. */
  at: string;
  sessionId?: string;
  /** The session's `CLAUDE_CONFIG_DIR`, when set: a profile folder names its account. */
  configDir?: string;
  windows: UsageWindow[];
}

const KEYS: Record<string, string> = { five_hour: "5h", seven_day: "7d" };
/** Readings older than this are deleted. */
const KEEP_MS = 2 * 86_400_000;

/** The windows of one status-line input, or undefined when it carries none. */
export function parseStatusLineInput(input: unknown, now: Date = new Date()): StatusLineReading | undefined {
  if (!isObject(input) || !isObject(input["rate_limits"])) return undefined;
  const limits = input["rate_limits"];
  const windows: UsageWindow[] = [];
  for (const [key, label] of Object.entries(KEYS)) {
    const w = limits[key];
    if (!isObject(w) || typeof w["used_percentage"] !== "number" || !Number.isFinite(w["used_percentage"])) continue;
    const resetsAt = toIso(w["resets_at"]);
    windows.push({ key, label, utilization: Math.max(0, Math.min(100, w["used_percentage"])), ...(resetsAt ? { resetsAt } : {}) });
  }
  if (!windows.length) return undefined;
  const sessionId = typeof input["session_id"] === "string" ? input["session_id"] : undefined;
  return { at: now.toISOString(), ...(sessionId ? { sessionId } : {}), windows };
}

/** One file per session, replaced on each response (atomic rename). */
export function writeStatusLineReading(dir: string, reading: StatusLineReading): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${(reading.sessionId ?? "session").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.json`;
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(reading), { mode: 0o600 });
  renameSync(tmp, join(dir, name));
}

/** Every reading newer than `sinceMs`, newest first; files older than two days are deleted. */
export function readStatusLineReadings(dir: string, sinceMs: number, now: number = Date.now()): StatusLineReading[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch {
    return [];
  }
  const out: StatusLineReading[] = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > KEEP_MS) {
        rmSync(file, { force: true });
        continue;
      }
      const r = JSON.parse(readFileSync(file, "utf8")) as StatusLineReading;
      if (typeof r.at === "string" && Array.isArray(r.windows) && Date.parse(r.at) > sinceMs) out.push(r);
    } catch {
      // Being replaced right now: the next pass reads it.
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Could this reading be the account's? A session passes the numbers of the login it holds,
 * which can lag a switch, so a reading whose 5-hour window resets at another time than the
 * account's last known, still running window is someone else's (Pitboard's "windows prove
 * whose" rule, simplified).
 */
export function readingFits(reading: StatusLineReading, usage: UsageSnapshot | undefined, now: number): boolean {
  const known = usage?.windows.find((w) => w.key === "five_hour");
  const seen = reading.windows.find((w) => w.key === "five_hour");
  if (!known?.resetsAt || !seen?.resetsAt) return true;
  const knownReset = Date.parse(known.resetsAt);
  if (!(knownReset > now)) return true; // that window is over: a new one starts anytime
  return Math.abs(Date.parse(seen.resetsAt) - knownReset) <= 15 * 60_000;
}

/** The account's snapshot with the reading's windows in place; per-model limits and spend stay. */
export function mergeReading(usage: UsageSnapshot | undefined, reading: StatusLineReading): UsageSnapshot {
  const keys = new Set(reading.windows.map((w) => w.key));
  const kept = (usage?.windows ?? []).filter((w) => !keys.has(w.key));
  const order = (k: string) => (k === "five_hour" ? 0 : k === "seven_day" ? 1 : 2);
  return {
    windows: [...reading.windows, ...kept].sort((a, b) => order(a.key) - order(b.key)),
    ...(usage?.extra ? { extra: usage.extra } : {}),
    fetchedAt: reading.at,
    source: "statusline",
  };
}

function toIso(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === "string" && Number.isFinite(Date.parse(v))) return new Date(v).toISOString();
  return undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
