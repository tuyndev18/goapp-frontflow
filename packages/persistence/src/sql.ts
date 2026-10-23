import type { SqlValue } from "./driver.js";

export function toJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function fromJson<T>(text: SqlValue | undefined): T | undefined {
  return typeof text === "string" ? (JSON.parse(text) as T) : undefined;
}

export function fromJsonOr<T>(text: SqlValue | undefined, fallback: T): T {
  return typeof text === "string" ? (JSON.parse(text) as T) : fallback;
}

export function nullable<T extends SqlValue>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

export function boolToInt(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

export function intToBool(value: SqlValue | undefined): boolean | undefined {
  return value === null || value === undefined ? undefined : Number(value) !== 0;
}

export function str(value: SqlValue | undefined): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

export function num(value: SqlValue | undefined): number {
  return Number(value ?? 0);
}

/** Drops keys whose value is undefined so round-tripped records deep-equal their input. */
export function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as T;
}

export function nowIso(): string {
  return new Date().toISOString();
}
