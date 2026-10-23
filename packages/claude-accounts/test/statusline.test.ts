import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeReading, parseStatusLineInput, readingFits, readStatusLineReadings, writeStatusLineReading, type UsageSnapshot } from "../src/index.js";

const NOW = Date.parse("2026-10-23T10:00:00.000Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe("status line readings", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("takes the 5h and weekly windows of a status-line input, resets in seconds or ISO", () => {
    const r = parseStatusLineInput(
      { session_id: "s1", rate_limits: { five_hour: { used_percentage: 42.5, resets_at: (NOW + 3_600_000) / 1000 }, seven_day: { used_percentage: 120, resets_at: at(86_400_000) } } },
      new Date(NOW),
    );
    expect(r).toEqual({
      at: at(0),
      sessionId: "s1",
      windows: [
        { key: "five_hour", label: "5h", utilization: 42.5, resetsAt: at(3_600_000) },
        { key: "seven_day", label: "7d", utilization: 100, resetsAt: at(86_400_000) },
      ],
    });
    expect(parseStatusLineInput({ session_id: "s1" })).toBeUndefined();
    expect(parseStatusLineInput("nope")).toBeUndefined();
  });

  it("files one reading per session and reads the newest first, dropping old files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-sl-"));
    dirs.push(dir);
    writeStatusLineReading(dir, { at: at(-60_000), sessionId: "a", windows: [{ key: "five_hour", label: "5h", utilization: 10 }] });
    writeStatusLineReading(dir, { at: at(0), sessionId: "b/../x", windows: [{ key: "five_hour", label: "5h", utilization: 20 }] });
    writeFileSync(join(dir, "old.json"), JSON.stringify({ at: at(0), windows: [] }));
    const old = (NOW - 3 * 86_400_000) / 1000;
    utimesSync(join(dir, "old.json"), old, old);
    const readings = readStatusLineReadings(dir, NOW - 10 * 60_000, NOW);
    expect(readings.map((r) => r.windows[0]!.utilization)).toEqual([20, 10]);
    expect(readStatusLineReadings(dir, NOW - 30_000, NOW)).toHaveLength(1);
  });

  it("refuses a reading whose 5h window is another account's", () => {
    const usage: UsageSnapshot = { windows: [{ key: "five_hour", label: "5h", utilization: 30, resetsAt: at(2 * 3_600_000) }], fetchedAt: at(-60_000) };
    const reading = (resetIn: number) => ({ at: at(0), windows: [{ key: "five_hour", label: "5h", utilization: 35, resetsAt: at(resetIn) }] });
    expect(readingFits(reading(2 * 3_600_000 + 5 * 60_000), usage, NOW)).toBe(true);
    expect(readingFits(reading(4 * 3_600_000), usage, NOW)).toBe(false);
    // The known window is over: any new window may be this account's.
    const ended: UsageSnapshot = { ...usage, windows: [{ key: "five_hour", label: "5h", utilization: 90, resetsAt: at(-60_000) }] };
    expect(readingFits(reading(4 * 3_600_000), ended, NOW)).toBe(true);
    expect(readingFits(reading(4 * 3_600_000), undefined, NOW)).toBe(true);
  });

  it("replaces the 5h and weekly windows and keeps per-model limits and spend", () => {
    const usage: UsageSnapshot = {
      windows: [
        { key: "five_hour", label: "5h", utilization: 10 },
        { key: "model:opus", label: "Opus", utilization: 50 },
      ],
      extra: { is_enabled: true },
      fetchedAt: at(-600_000),
      source: "api",
    };
    const merged = mergeReading(usage, { at: at(0), windows: [{ key: "seven_day", label: "7d", utilization: 40 }, { key: "five_hour", label: "5h", utilization: 25 }] });
    expect(merged).toEqual({
      windows: [
        { key: "five_hour", label: "5h", utilization: 25 },
        { key: "seven_day", label: "7d", utilization: 40 },
        { key: "model:opus", label: "Opus", utilization: 50 },
      ],
      extra: { is_enabled: true },
      fetchedAt: at(0),
      source: "statusline",
    });
  });
});
