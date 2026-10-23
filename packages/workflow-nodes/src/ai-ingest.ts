import type { ApiOperation, ApiParameter, ApiResponse, BusinessRequirement, SourceReference, SourceSnapshot } from "@frontflow/domain";
import type { AcceptanceCriterion } from "@frontflow/document-parser";

/**
 * Document reading with an AI CLI: the agent reads an uploaded document and
 * returns JSON; this module validates and grounds that JSON before anything
 * downstream trusts it. Ids must be unique, line ranges must exist in the
 * snapshot (the excerpt is re-read from the real text), enums must be valid.
 * Anything that cannot be grounded gets low confidence and is flagged instead
 * of trusted (spec §3 "Explicit uncertainty").
 */

export interface DocumentText {
  snapshot: SourceSnapshot;
  text: string;
}

export interface OperationsResult {
  operations: ApiOperation[];
  warnings: string[];
}

export interface RequirementsResult {
  actors: string[];
  requirements: BusinessRequirement[];
  acceptanceCriteria: AcceptanceCriterion[];
  warnings: string[];
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "WS"]);
const PARAM_IN = new Set(["path", "query", "header", "body"]);

export function ingestOperations(raw: unknown, api: DocumentText): OperationsResult {
  const warnings: string[] = [];
  const root = asRecord(raw);
  if (!root) throw new Error("AI extraction is not a JSON object");

  const operations: ApiOperation[] = [];
  const seenOp = new Set<string>();
  for (const [index, item] of asArray(root["operations"]).entries()) {
    const o = asRecord(item);
    if (!o) continue;
    const method = (str(o["method"]) ?? "").toUpperCase();
    const path = str(o["path"])?.trim();
    if (!METHODS.has(method) || !path) {
      warnings.push(`Operation #${index + 1} dropped: invalid method or path`);
      continue;
    }
    let id = str(o["id"])?.trim() || `${method.toLowerCase()}${path.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ""))}`;
    if (seenOp.has(id)) id = `${id}_${index + 1}`;
    seenOp.add(id);
    const { ref, grounded, relocated } = ground(api, o["lines"], `${method} ${path}`);
    if (!grounded) warnings.push(`${id}: line reference could not be verified in the API contract`);
    else if (relocated) warnings.push(`${id}: line reference corrected to L${ref.lineStart}`);
    const parameters: ApiParameter[] = asArray(o["parameters"]).flatMap((p) => {
      const x = asRecord(p);
      const name = x && str(x["name"]);
      if (!x || !name) return [];
      const where = str(x["in"]) ?? "query";
      return [{ name, in: (PARAM_IN.has(where) ? where : "query") as ApiParameter["in"], required: x["required"] === true, ...(str(x["type"]) ? { type: str(x["type"])! } : {}) }];
    });
    const responses: ApiResponse[] = asArray(o["responses"]).flatMap((p) => {
      const x = asRecord(p);
      const status = x ? num(x["status"]) : undefined;
      if (!x || status === undefined) return [];
      return [{ status: Math.round(status), ...(str(x["errorCode"]) ? { errorCode: str(x["errorCode"])! } : {}), ...(str(x["description"]) ? { description: str(x["description"])! } : {}) }];
    });
    operations.push({
      id,
      method,
      path,
      ...(str(o["summary"]) ? { summary: str(o["summary"])! } : {}),
      ...(str(o["auth"]) ? { auth: str(o["auth"])! } : {}),
      roles: strings(o["roles"]),
      parameters,
      responses,
      sourceRefs: [ref],
    });
  }

  if (!operations.length) throw new Error("AI extraction returned no API operations");
  return { operations, warnings };
}

export function ingestRequirements(raw: unknown, ba: DocumentText): RequirementsResult {
  const warnings: string[] = [];
  const root = asRecord(raw);
  if (!root) throw new Error("AI extraction is not a JSON object");

  const requirements: BusinessRequirement[] = [];
  const acceptanceCriteria: AcceptanceCriterion[] = [];
  const seenReq = new Set<string>();
  for (const [index, item] of asArray(root["requirements"]).entries()) {
    const r = asRecord(item);
    if (!r) continue;
    let id = str(r["id"])?.trim() || `REQ-${String(index + 1).padStart(3, "0")}`;
    if (seenReq.has(id)) {
      warnings.push(`Duplicate requirement id ${id}; renamed`);
      id = `${id}#${index + 1}`;
    }
    seenReq.add(id);
    const { ref, grounded, relocated } = ground(ba, r["lines"], `${id} ${str(r["title"]) ?? ""}`);
    if (!grounded) warnings.push(`${id}: line reference could not be verified in the BA document`);
    else if (relocated) warnings.push(`${id}: line reference corrected to L${ref.lineStart}`);
    const confidence = clamp(num(r["confidence"]) ?? 0.8) * (grounded ? 1 : 0.5);
    requirements.push({
      id,
      title: str(r["title"])?.trim() || id,
      ...(str(r["actor"]) ? { actor: str(r["actor"])! } : {}),
      preconditions: strings(r["preconditions"]),
      actions: strings(r["actions"]),
      outcomes: strings(r["outcomes"]),
      validations: strings(r["validations"]),
      states: strings(r["states"]),
      errors: strings(r["errors"]),
      sourceRefs: [ref],
      confidence: round(confidence),
    });
    for (const [i, ac] of asArray(r["acceptanceCriteria"]).entries()) {
      const a = asRecord(ac);
      if (!a) continue;
      const given = strings(a["given"]);
      const when = strings(a["when"]);
      const then = strings(a["then"]);
      if (!when.length && !then.length) continue;
      acceptanceCriteria.push({
        id: `AC-${id}-${String(i + 1).padStart(2, "0")}`,
        requirementId: id,
        given,
        when,
        then,
        text: [...given.map((g) => `Given ${g}`), ...when.map((w) => `When ${w}`), ...then.map((t) => `Then ${t}`)].join("\n"),
        sourceRef: ref,
      });
    }
  }

  if (!requirements.length) throw new Error("AI extraction returned no requirements");
  return { actors: strings(root["actors"]), requirements, acceptanceCriteria, warnings };
}

/** Builds a SourceReference from the AI's [start, end] and checks it against the real document. */
function ground(doc: DocumentText, lines: unknown, hint: string): { ref: SourceReference; grounded: boolean; relocated: boolean } {
  const all = doc.text.split("\n");
  const pair = asArray(lines).map((n) => num(n));
  let start = pair[0];
  let end = pair[1] ?? start;
  let grounded = start !== undefined && end !== undefined && start >= 1 && end >= start && end <= all.length;
  const relocated = !grounded;
  if (!grounded) {
    // Fall back to the first line that mentions the hint's leading token (e.g. "UC-01" or the path).
    const token = hint.split(/\s+/).find((t) => t.length >= 3) ?? "";
    const found = token ? all.findIndex((l) => l.includes(token)) : -1;
    start = found >= 0 ? found + 1 : 1;
    end = start;
    grounded = found >= 0;
  }
  const s = Math.max(1, Math.min(start!, all.length));
  const e = Math.max(s, Math.min(end!, all.length));
  const excerpt = all.slice(s - 1, Math.min(e, s + 2)).join(" ").trim().slice(0, 200);
  return { ref: { snapshotId: doc.snapshot.id, lineStart: s, lineEnd: e, ...(excerpt ? { excerpt } : {}) }, grounded, relocated };
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}
export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;
}
export function strings(v: unknown): string[] {
  return asArray(v).flatMap((x) => (typeof x === "string" && x.trim() ? [x.trim()] : []));
}
export function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}
export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
