import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { QuotaPointDto } from "../shared/ipc.js";

const KEEP_MS = 30 * 86_400_000;

/**
 * % used of each quota window after every successful poll, one JSON line per poll, so the
 * Usage screen can chart how the 5h and weekly windows filled up. Holds no token.
 */
export class QuotaHistory {
  private points: QuotaPointDto[];

  constructor(private readonly file: string) {
    const cutoff = Date.now() - KEEP_MS;
    this.points = read(file).filter((p) => Date.parse(p.at) >= cutoff);
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, this.points.map((p) => `${JSON.stringify(p)}\n`).join(""));
    } catch (err) {
      console.warn("[accounts] could not prune quota history:", (err as Error).message);
    }
  }

  record(accountId: string, windows: Array<{ key: string; utilization: number }>, at = new Date()): void {
    if (!windows.length) return;
    const point: QuotaPointDto = { at: at.toISOString(), accountId, windows: Object.fromEntries(windows.map((w) => [w.key, w.utilization])) };
    // The status line reports after every response: keep a point only when a number moved, or every 15 minutes.
    const last = this.points.findLast((p) => p.accountId === accountId);
    if (last && at.getTime() - Date.parse(last.at) < 15 * 60_000 && Object.entries(point.windows).every(([k, v]) => last.windows[k] === v)) return;
    this.points.push(point);
    try {
      appendFileSync(this.file, `${JSON.stringify(point)}\n`);
    } catch (err) {
      console.warn("[accounts] could not save quota history:", (err as Error).message);
    }
  }

  since(ms: number): QuotaPointDto[] {
    return this.points.filter((p) => Date.parse(p.at) >= ms);
  }
}

function read(file: string): QuotaPointDto[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: QuotaPointDto[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as QuotaPointDto;
      if (typeof p.at === "string" && typeof p.accountId === "string" && p.windows && typeof p.windows === "object") out.push(p);
    } catch {
      // A half-written last line.
    }
  }
  return out;
}
