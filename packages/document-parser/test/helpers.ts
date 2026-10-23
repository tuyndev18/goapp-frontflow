import { readFileSync } from "node:fs";
import type { SourceSnapshotType } from "@frontflow/domain";
import { snapshotDocument } from "../src/index.js";

export function fixture(path: string): string {
  return readFileSync(new URL(`../../../tests/fixtures/alignment/${path}`, import.meta.url), "utf8");
}

export const FIXED_TIME = "2026-01-01T00:00:00.000Z";

export function snap(type: SourceSnapshotType, content: string, sourceUri?: string) {
  return snapshotDocument({ type, content, createdAt: FIXED_TIME, ...(sourceUri ? { sourceUri } : {}) });
}
