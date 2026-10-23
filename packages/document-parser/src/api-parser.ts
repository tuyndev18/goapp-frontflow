import type { ApiOperation, ApiParameter, ApiResponse, DocumentIssue, JsonSchema, SourceSnapshot } from "@frontflow/domain";
import { makeIssue } from "./issues.js";
import type { MdBlock, MdCode, MdListItem } from "./markdown.js";
import { sectionsOf, sourceRef, splitLines, tokenizeMarkdown } from "./markdown.js";
import type { ApiParseResult } from "./openapi.js";
import { fallbackOperationId, looksLikeOpenApi, normalizePath, parseOpenApi, pathParams, splitRoles } from "./openapi.js";
import { inferSchema, parseLoose, schemaFromFields } from "./schema.js";
import { collapseWhitespace, extractErrorCodes, foldLabel, stripInline, uniq } from "./text.js";

const OP_HEAD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)\s*(?:[—–:|-]\s*(.*))?$/i;
const LABEL_LINE = /^([^:：]{1,40}?)\s*[:：]\s*(.*)$/;

type OpField = "id" | "auth" | "roles" | "summary";
const OP_LABELS = new Map<string, OpField>([
  ["operation id", "id"],
  ["operationid", "id"],
  ["id", "id"],
  ["ma api", "id"],
  ["authentication", "auth"],
  ["auth", "auth"],
  ["authorization", "auth"],
  ["security", "auth"],
  ["xac thuc", "auth"],
  ["allowed roles", "roles"],
  ["roles", "roles"],
  ["role", "roles"],
  ["permissions", "roles"],
  ["vai tro", "roles"],
  ["quyen", "roles"],
  ["vai tro duoc phep", "roles"],
  ["summary", "summary"],
  ["description", "summary"],
  ["purpose", "summary"],
  ["mo ta", "summary"],
]);

type Sub =
  | { kind: "params"; location: ApiParameter["in"] }
  | { kind: "request" }
  | { kind: "response"; status: number; description?: string }
  | { kind: "errors" }
  | { kind: "other" };

function classifySubheading(text: string): Sub {
  const folded = foldLabel(text);
  if (/\b(?:path)\b.*\bparam/.test(folded) || /^tham so duong dan/.test(folded)) return { kind: "params", location: "path" };
  if (/\bquery\b/.test(folded) || /^tham so truy van/.test(folded)) return { kind: "params", location: "query" };
  if (/^headers?\b/.test(folded)) return { kind: "params", location: "header" };
  if (/^(?:request|body|payload|du lieu gui|yeu cau)/.test(folded)) return { kind: "request" };
  if (/^(?:errors?|error responses?|error codes?|loi|ma loi|cac loi)\b/.test(folded)) return { kind: "errors" };
  if (/^(?:responses?|success|phan hoi|ket qua tra ve)/.test(folded)) {
    const status = /\b([1-5]\d\d)\b/.exec(text);
    const description = collapseWhitespace(text.replace(/^[^\d]*[1-5]\d\d\s*[—–:-]?\s*/, ""));
    const sub: Sub = { kind: "response", status: status ? Number(status[1]) : 200 };
    if (status && description && description !== text) sub.description = description;
    return sub;
  }
  return { kind: "other" };
}

const TYPE_WORD = /\b(string|number|integer|int|boolean|bool|array|object|uuid|date-time|datetime|date|email|enum)\b/i;

interface FieldSpec {
  name: string;
  type: string;
  required: boolean;
}

function parseFieldItem(text: string, requiredByDefault: boolean): FieldSpec | undefined {
  const clean = stripInline(text);
  const m = /^([A-Za-z_$][\w.$-]*)\s*(?:[:：(—–-]\s*)?(.*)$/.exec(clean);
  if (!m) return undefined;
  const rest = m[2] ?? "";
  const literal = /^([A-Z][A-Z0-9_]*(?:\s*\|\s*[A-Z][A-Z0-9_]*)*)\b/.exec(rest);
  const type = literal?.[1] ?? TYPE_WORD.exec(rest)?.[1]?.toLowerCase() ?? "string";
  const optional = /\b(?:optional|not required|nullable)\b|không bắt buộc|tùy chọn/iu.test(rest);
  const required = /\b(?:required|mandatory)\b|bắt buộc/iu.test(rest) ? !optional : requiredByDefault && !optional;
  return { name: m[1]!, type, required };
}

function parseErrorItem(text: string): ApiResponse[] {
  const clean = stripInline(text);
  const status = /(?<!\d)([1-5]\d\d)(?!\d)/.exec(clean);
  const tokens = extractErrorCodes(clean, false).filter((c) => c.length >= 3 && !/^\d/.test(c));
  const snake = tokens.filter((c) => c.includes("_"));
  const codes = snake.length > 0 ? snake : tokens.slice(0, 1);
  let description = clean;
  if (status) description = description.replace(status[0], " ");
  for (const code of codes) description = description.replace(code, " ");
  description = collapseWhitespace(description.replace(/^[\s—–:()\-,]+|[\s—–:()\-,]+$/g, "").replace(/\(\s*\)/g, ""));
  const base: ApiResponse = { status: status ? Number(status[1]) : 0 };
  if (description) base.description = description;
  if (codes.length === 0) return status ? [base] : [];
  return codes.map((errorCode) => ({ ...base, errorCode }));
}

interface Draft {
  operation: ApiOperation;
  explicitId: boolean;
}

function parseOperationSection(
  snapshot: SourceSnapshot,
  method: string,
  rawPath: string,
  headingSummary: string,
  body: MdBlock[],
  headRef: ApiOperation["sourceRefs"][number],
  issues: DocumentIssue[],
): Draft {
  const path = normalizePath(rawPath);
  const operation: ApiOperation = {
    id: fallbackOperationId(method, path),
    method,
    path,
    roles: [],
    parameters: [],
    responses: [],
    sourceRefs: [headRef],
  };
  if (headingSummary) operation.summary = headingSummary;
  let explicitId = false;
  let sub: Sub | undefined;
  const requestFields: FieldSpec[] = [];
  const responseFields = new Map<number, FieldSpec[]>();

  const addParam = (location: ApiParameter["in"], spec: FieldSpec) => {
    const param: ApiParameter = { name: spec.name, in: location, required: spec.required };
    if (spec.type) param.type = /^[A-Z]/.test(spec.type) ? "string" : spec.type === "int" ? "integer" : spec.type === "bool" ? "boolean" : spec.type;
    operation.parameters.push(param);
  };

  const ensureResponse = (status: number, description?: string): ApiResponse => {
    let response = operation.responses.find((r) => r.status === status && !r.errorCode);
    if (!response) {
      response = { status };
      operation.responses.push(response);
    }
    if (description && !response.description) response.description = description;
    return response;
  };

  const handleCode = (block: MdCode) => {
    if (looksLikeOpenApi(block.content) || !sub || (sub.kind !== "request" && sub.kind !== "response")) return;
    if (block.lang && !/^(?:json|jsonc|json5|javascript|js|yaml|yml)$/.test(block.lang)) return;
    const parsed = parseLoose(block.content);
    if (!parsed.ok) {
      issues.push(
        makeIssue(
          "unparseable_operation",
          "warning",
          `${method} ${path}: example in "${block.section[block.section.length - 1] ?? ""}" is not valid JSON (${parsed.error.split("\n")[0]}).`,
          { operationId: operation.id, detail: `code:${block.lineStart}` },
          [sourceRef(snapshot.id, block.lineStart, block.lineEnd, block.section, block.content)],
        ),
      );
      return;
    }
    const schema = inferSchema(parsed.value);
    if (sub.kind === "request") {
      operation.requestSchema = schema;
      return;
    }
    const code =
      sub.status >= 400 && parsed.value && typeof parsed.value === "object" ? (parsed.value as Record<string, unknown>).code : undefined;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code)) {
      const status = sub.status;
      const placeholder = operation.responses.findIndex((r) => r.status === status && !r.errorCode && !r.schema);
      if (placeholder >= 0) operation.responses.splice(placeholder, 1);
      const response: ApiResponse = { status, errorCode: code, schema };
      if (sub.description) response.description = sub.description;
      operation.responses.push(response);
    } else {
      ensureResponse(sub.status, sub.description).schema = schema;
    }
  };

  const handleItem = (item: MdListItem) => {
    const clean = stripInline(item.text);
    if (!sub) {
      const label = LABEL_LINE.exec(clean);
      const field = label ? OP_LABELS.get(foldLabel(label[1]!)) : undefined;
      const value = collapseWhitespace(label?.[2] ?? "");
      const childValues = item.children.map((c) => stripInline(c.text));
      if (field === "id" && value) {
        operation.id = value.replace(/[`\s]/g, "");
        explicitId = true;
      } else if (field === "auth" && value) {
        operation.auth = /^(?:none|no|public|không|n\/a)$/iu.test(value) ? "none" : value;
      } else if (field === "roles") {
        operation.roles = uniq([...operation.roles, ...splitRoles([value, ...childValues].filter(Boolean).join(", "))]);
      } else if (field === "summary" && value && !operation.summary) {
        operation.summary = value;
      }
      return;
    }
    if (sub.kind === "params") {
      const spec = parseFieldItem(item.text, sub.location === "path");
      if (spec) addParam(sub.location, spec);
    } else if (sub.kind === "request") {
      const spec = parseFieldItem(item.text, false);
      if (spec) {
        requestFields.push(spec);
        addParam("body", spec);
      }
    } else if (sub.kind === "response") {
      const spec = parseFieldItem(item.text, false);
      if (spec) responseFields.set(sub.status, [...(responseFields.get(sub.status) ?? []), spec]);
    } else if (sub.kind === "errors") {
      operation.responses.push(...parseErrorItem(item.text));
      for (const child of item.children) operation.responses.push(...parseErrorItem(child.text));
    }
  };

  for (const block of body) {
    if (block.kind === "heading") {
      sub = classifySubheading(block.text);
      if (sub.kind === "response") ensureResponse(sub.status, sub.description);
      if (sub.kind === "errors" || sub.kind === "response") {
        operation.sourceRefs.push(sourceRef(snapshot.id, block.lineStart, block.lineEnd, block.section, block.text));
      }
    } else if (block.kind === "list") {
      for (const item of block.items) handleItem(item);
      if (sub?.kind === "errors") {
        operation.sourceRefs[operation.sourceRefs.length - 1]!.lineEnd = Math.max(operation.sourceRefs[operation.sourceRefs.length - 1]!.lineEnd, block.lineEnd);
      }
    } else if (block.kind === "code") {
      handleCode(block);
    } else if (block.kind === "paragraph" && !sub && !operation.summary) {
      operation.summary = collapseWhitespace(stripInline(block.text));
    } else if (block.kind === "paragraph" && sub?.kind === "errors") {
      for (const line of block.lines) operation.responses.push(...parseErrorItem(line.text));
    }
  }

  if (requestFields.length > 0 && !operation.requestSchema) operation.requestSchema = schemaFromFields(requestFields);
  for (const [status, fields] of responseFields) {
    const response = ensureResponse(status);
    if (!response.schema) response.schema = schemaFromFields(fields);
  }
  for (const name of pathParams(path)) {
    if (!operation.parameters.some((p) => p.in === "path" && p.name === name)) operation.parameters.push({ name, in: "path", required: true });
  }
  operation.responses.sort((a, b) => a.status - b.status);
  return { operation, explicitId };
}

function opKey(op: ApiOperation): string {
  return `${op.method} ${op.path.replace(/\{[^}]+\}/g, "{}")}`;
}

function mergeOperations(md: Draft, oa: ApiOperation, oaExplicit: boolean): ApiOperation {
  const responses = [...oa.responses];
  for (const r of md.operation.responses) {
    if (!responses.some((x) => x.status === r.status && x.errorCode === r.errorCode)) responses.push(r);
  }
  responses.sort((a, b) => a.status - b.status);
  const parameters = [...oa.parameters];
  for (const p of md.operation.parameters) if (!parameters.some((x) => x.in === p.in && x.name === p.name)) parameters.push(p);
  const merged: ApiOperation = {
    id: oaExplicit || !md.explicitId ? oa.id : md.operation.id,
    method: oa.method,
    path: oa.path,
    roles: uniq([...oa.roles, ...md.operation.roles]),
    parameters,
    responses,
    sourceRefs: [...md.operation.sourceRefs, ...oa.sourceRefs],
  };
  const summary = md.operation.summary ?? oa.summary;
  if (summary) merged.summary = summary;
  const auth = oa.auth ?? md.operation.auth;
  if (auth) merged.auth = auth;
  const requestSchema: JsonSchema | undefined = oa.requestSchema ?? md.operation.requestSchema;
  if (requestSchema) merged.requestSchema = requestSchema;
  return merged;
}

/** Spec §12.1 A3 — API operations from an API contract written in Markdown (embedded OpenAPI supported). */
export function parseApiMarkdown(snapshot: SourceSnapshot, text: string): ApiParseResult {
  const blocks = tokenizeMarkdown(text);
  const issues: DocumentIssue[] = [];
  const drafts: Draft[] = [];

  for (const section of sectionsOf(blocks)) {
    const m = OP_HEAD.exec(section.heading.text);
    if (!m) continue;
    const headRef = sourceRef(snapshot.id, section.heading.lineStart, section.lineEnd, section.heading.section, section.heading.text);
    drafts.push(
      parseOperationSection(snapshot, m[1]!.toUpperCase(), m[2]!, collapseWhitespace(m[3] ?? ""), section.body, headRef, issues),
    );
  }

  const embedded: { operation: ApiOperation; explicit: boolean }[] = [];
  for (const block of blocks) {
    if (block.kind !== "code" || !looksLikeOpenApi(block.content)) continue;
    if (block.lang && !/^(?:ya?ml|json|openapi)$/.test(block.lang)) continue;
    const result = parseOpenApi(snapshot, block.content, { lineOffset: block.lineStart, section: block.section });
    issues.push(...result.issues.filter((i) => i.code !== "missing_id"));
    const generatedIds = new Set(result.issues.filter((i) => i.code === "missing_id").map((i) => i.operationId));
    for (const operation of result.operations) embedded.push({ operation, explicit: !generatedIds.has(operation.id) });
  }

  const operations: ApiOperation[] = [];
  const consumed = new Set<number>();
  for (const draft of drafts) {
    const index = embedded.findIndex((e, i) => !consumed.has(i) && opKey(e.operation) === opKey(draft.operation));
    if (index >= 0) {
      consumed.add(index);
      operations.push(mergeOperations(draft, embedded[index]!.operation, embedded[index]!.explicit));
    } else {
      operations.push(draft.operation);
    }
  }
  embedded.forEach((e, i) => {
    if (!consumed.has(i)) operations.push(e.operation);
  });

  if (operations.length === 0) {
    const lines = splitLines(text);
    issues.push(
      makeIssue("empty_document", "error", "No API operations could be extracted from the API contract.", { detail: snapshot.id }, [
        sourceRef(snapshot.id, 1, lines.length, undefined, lines[0] ?? ""),
      ]),
    );
  }
  return { operations, issues };
}
