import type { ApiOperation, JsonSchema } from "@frontflow/domain";
import { parse as parseYaml } from "yaml";
import { extractStateTokens } from "./text.js";

const TYPE_PLACEHOLDERS: Record<string, JsonSchema> = {
  string: { type: "string" },
  str: { type: "string" },
  text: { type: "string" },
  number: { type: "number" },
  float: { type: "number" },
  double: { type: "number" },
  decimal: { type: "number" },
  integer: { type: "integer" },
  int: { type: "integer" },
  long: { type: "integer" },
  boolean: { type: "boolean" },
  bool: { type: "boolean" },
  uuid: { type: "string", format: "uuid" },
  date: { type: "string", format: "date" },
  "date-time": { type: "string", format: "date-time" },
  datetime: { type: "string", format: "date-time" },
  timestamp: { type: "string", format: "date-time" },
  email: { type: "string", format: "email" },
  uri: { type: "string", format: "uri" },
  url: { type: "string", format: "uri" },
  object: { type: "object" },
  array: { type: "array" },
};

const LITERAL = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const LITERAL_UNION = /^[A-Z][A-Z0-9_]*(?:\s*\|\s*[A-Z][A-Z0-9_]*)+$/;

function stringSchema(value: string): JsonSchema {
  const trimmed = value.trim();
  const placeholder = TYPE_PLACEHOLDERS[trimmed.toLowerCase().replace(/[?!]$/, "")];
  if (placeholder) return { ...placeholder };
  if (LITERAL_UNION.test(trimmed)) return { type: "string", enum: trimmed.split("|").map((s) => s.trim()) };
  if (LITERAL.test(trimmed) && trimmed.length >= 2) return { type: "string", const: trimmed };
  return { type: "string", examples: [value] };
}

/** Infers a JSON Schema (2020-12) from a JSON example. String literals like "CANCELLED" become `const`. */
export function inferSchema(value: unknown): JsonSchema {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "string") return stringSchema(value);
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (Array.isArray(value)) {
    return value.length > 0 ? { type: "array", items: inferSchema(value[0]) } : { type: "array" };
  }
  if (typeof value === "object") {
    const properties: Record<string, JsonSchema> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) properties[key] = inferSchema(child);
    return { type: "object", properties };
  }
  return {};
}

/** Builds an object schema from "name: type" field descriptions. */
export function schemaFromFields(fields: { name: string; type: string; required: boolean }[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[field.name] = stringSchema(field.type);
    if (field.required) required.push(field.name);
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

export type LooseParse = { ok: true; value: unknown } | { ok: false; error: string };

/** JSON first, then YAML (tolerates trailing commas, comments and unquoted keys). */
export function parseLoose(text: string): LooseParse {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    try {
      const cleaned = text.replace(/,(\s*[}\]])/g, "$1").replace(/^\s*\/\/.*$/gm, "");
      return { ok: true, value: parseYaml(cleaned) as unknown };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Every string literal exposed by a schema through enum / const / example(s) / default. */
export function schemaLiterals(schema: unknown, depth = 0): string[] {
  if (depth > 32 || schema === null || typeof schema !== "object") return [];
  const out: string[] = [];
  const s = schema as Record<string, unknown>;
  const push = (v: unknown) => {
    if (typeof v === "string") out.push(v);
  };
  if (Array.isArray(s.enum)) s.enum.forEach(push);
  push(s.const);
  push(s.example);
  push(s.default);
  if (Array.isArray(s.examples)) s.examples.forEach(push);
  for (const key of ["properties", "patternProperties", "$defs", "definitions"]) {
    const map = s[key];
    if (map && typeof map === "object") for (const child of Object.values(map)) out.push(...schemaLiterals(child, depth + 1));
  }
  for (const key of ["items", "additionalProperties", "not"]) out.push(...schemaLiterals(s[key], depth + 1));
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const list = s[key];
    if (Array.isArray(list)) for (const child of list) out.push(...schemaLiterals(child, depth + 1));
  }
  return out;
}

/** State tokens (UPPER_SNAKE literals) an operation exposes in its success responses. */
export function operationStates(operation: ApiOperation): string[] {
  const states = new Set<string>();
  for (const response of operation.responses) {
    if (response.status >= 400 || response.status === 0) continue;
    for (const literal of schemaLiterals(response.schema)) {
      if (LITERAL.test(literal)) for (const token of extractStateTokens(literal)) states.add(token);
    }
  }
  return [...states];
}

/** True when a success response exposes a status-like property without enumerating its values. */
export function hasOpenStatusField(operation: ApiOperation): boolean {
  return operation.responses.some((r) => r.status < 400 && r.status !== 0 && hasOpenStatus(r.schema, 0));
}

function hasOpenStatus(schema: unknown, depth: number): boolean {
  if (depth > 16 || !schema || typeof schema !== "object") return false;
  const props = (schema as Record<string, unknown>).properties;
  if (props && typeof props === "object") {
    for (const [name, child] of Object.entries(props as Record<string, unknown>)) {
      if (/^(?:status|state)$/i.test(name) && child && typeof child === "object") {
        const c = child as Record<string, unknown>;
        if (!Array.isArray(c.enum) && c.const === undefined) return true;
      }
      if (hasOpenStatus(child, depth + 1)) return true;
    }
  }
  return hasOpenStatus((schema as Record<string, unknown>).items, depth + 1);
}
