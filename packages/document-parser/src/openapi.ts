import type { ApiOperation, ApiParameter, ApiResponse, DocumentIssue, JsonSchema, SourceReference, SourceSnapshot } from "@frontflow/domain";
import { isMap, isScalar, LineCounter, parseDocument } from "yaml";
import type { YAMLMap } from "yaml";
import { makeIssue } from "./issues.js";
import { sourceRef, splitLines } from "./markdown.js";
import { collapseWhitespace, uniq } from "./text.js";

export interface ApiParseResult {
  operations: ApiOperation[];
  issues: DocumentIssue[];
}

export interface OpenApiParseOptions {
  /** Added to every line number (for OpenAPI embedded in a Markdown code block). */
  lineOffset?: number;
  section?: string[];
}

export const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** camelCase operation id derived from method + path, e.g. POST /orders/{orderId}/cancel → postOrdersByOrderIdCancel. */
export function fallbackOperationId(method: string, path: string): string {
  const parts = path
    .split("/")
    .filter((s) => s.length > 0)
    .map((segment) => {
      const param = /^[{:]?([^{}:]+)\}?$/.exec(segment);
      const isParam = segment.startsWith("{") || segment.startsWith(":");
      const words = (param?.[1] ?? segment).split(/[^A-Za-z0-9]+/).filter(Boolean);
      const camel = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
      return isParam ? `By${camel}` : camel;
    });
  return `${method.toLowerCase()}${parts.join("")}`;
}

export function normalizePath(path: string): string {
  let p = path.trim().replace(/[?#].*$/, "");
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p.replace(/\/:([A-Za-z_][\w-]*)/g, "/{$1}");
}

export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

function unescapePointer(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolvePointer(root: Obj, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const token of ref.slice(2).split("/")) {
    if (!isObj(node) && !Array.isArray(node)) return undefined;
    node = (node as Obj)[unescapePointer(token)];
  }
  return node;
}

function deref(value: unknown, root: Obj, stack: string[] = []): unknown {
  if (stack.length > 32) return value;
  if (Array.isArray(value)) return value.map((v) => deref(v, root, stack));
  if (!isObj(value)) return value;
  const ref = value.$ref;
  if (typeof ref === "string") {
    if (stack.includes(ref)) return { $ref: ref };
    const target = resolvePointer(root, ref);
    return target === undefined ? { $ref: ref } : deref(target, root, [...stack, ref]);
  }
  const out: Obj = {};
  for (const [key, child] of Object.entries(value)) out[key] = deref(child, root, stack);
  return out;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string").map((s) => s.trim());
  return [];
}

export function splitRoles(value: string): string[] {
  const roles = value
    .split(/[,;/|]|\s+or\s+|\s+and\s+|\s+hoặc\s+|\s+và\s+/iu)
    .map((r) => r.replace(/[`*.]/g, "").trim())
    .filter(Boolean);
  if (roles.length === 1 && /^(?:any|all|everyone|public|anyone|all roles|any role|tất cả|mọi người)$/iu.test(roles[0]!)) return ["*"];
  if (roles.length === 1 && /^(?:none|n\/a|-|không|unspecified)$/iu.test(roles[0]!)) return [];
  return uniq(roles);
}

function describeAuth(security: unknown, schemes: Obj): string | undefined {
  if (!Array.isArray(security)) return undefined;
  if (security.length === 0) return "none";
  const alternatives = security.filter(isObj).map((requirement) => {
    const names = Object.keys(requirement);
    if (names.length === 0) return "none";
    return names
      .map((name) => {
        const scheme = schemes[name];
        if (!isObj(scheme)) return name;
        if (scheme.type === "http" && typeof scheme.scheme === "string") {
          return scheme.scheme.toLowerCase() === "bearer" ? "Bearer token" : `HTTP ${scheme.scheme}`;
        }
        if (scheme.type === "apiKey") return `API key (${String(scheme.in ?? "header")}: ${String(scheme.name ?? name)})`;
        if (scheme.type === "oauth2") return "OAuth2";
        if (scheme.type === "openIdConnect") return "OpenID Connect";
        return name;
      })
      .join(" + ");
  });
  return uniq(alternatives).join(" or ");
}

function rolesFrom(op: Obj): string[] {
  for (const key of ["x-roles", "x-allowed-roles", "x-permissions"]) {
    const roles = stringList(op[key]);
    if (roles.length > 0) return uniq(roles.flatMap(splitRoles));
  }
  const description = typeof op.description === "string" ? op.description : "";
  const m = /(?:allowed roles?|roles?)\s*[:：]\s*([^\n.]+)/i.exec(description);
  return m ? splitRoles(m[1]!) : [];
}

function errorCodesOf(response: Obj, content: Obj | undefined): string[] {
  const codes: string[] = [...stringList(response["x-error-code"]), ...stringList(response["x-error-codes"])];
  const schema = isObj(content?.schema) ? (content!.schema as Obj) : undefined;
  const codeProp = isObj(schema?.properties) ? ((schema!.properties as Obj).code as unknown) : undefined;
  if (isObj(codeProp)) {
    codes.push(...stringList(codeProp.enum), ...stringList(codeProp.const), ...stringList(codeProp.example));
  }
  if (isObj(content?.example)) codes.push(...stringList((content!.example as Obj).code));
  if (isObj(content?.examples)) {
    for (const example of Object.values(content!.examples as Obj)) {
      if (isObj(example) && isObj(example.value)) codes.push(...stringList((example.value as Obj).code));
    }
  }
  return uniq(codes.filter((c) => /^[A-Z][A-Z0-9_]+$/.test(c)));
}

function jsonContent(holder: unknown): Obj | undefined {
  if (!isObj(holder) || !isObj(holder.content)) return undefined;
  const content = holder.content;
  const preferred = Object.keys(content).find((type) => /json/i.test(type)) ?? Object.keys(content)[0];
  const value = preferred ? content[preferred] : undefined;
  return isObj(value) ? value : undefined;
}

function buildResponses(responses: unknown): ApiResponse[] {
  if (!isObj(responses)) return [];
  const out: ApiResponse[] = [];
  for (const code of Object.keys(responses).sort()) {
    if (!/^\d{3}$/.test(code)) continue;
    const response = responses[code];
    if (!isObj(response)) continue;
    const status = Number(code);
    const content = jsonContent(response);
    const base: ApiResponse = { status };
    if (typeof response.description === "string" && response.description.trim()) base.description = collapseWhitespace(response.description);
    if (isObj(content?.schema)) base.schema = content!.schema as JsonSchema;
    const codes = status >= 400 ? errorCodesOf(response, content) : [];
    if (codes.length === 0) out.push(base);
    else for (const errorCode of codes) out.push({ ...base, errorCode });
  }
  return out;
}

function buildParameters(list: unknown[], path: string): ApiParameter[] {
  const byKey = new Map<string, ApiParameter>();
  for (const raw of list) {
    if (!isObj(raw) || typeof raw.name !== "string") continue;
    const location = raw.in === "path" || raw.in === "query" ? raw.in : "header";
    const param: ApiParameter = { name: raw.name, in: location, required: raw.required === true || location === "path" };
    const schema = isObj(raw.schema) ? raw.schema : undefined;
    if (typeof schema?.type === "string") param.type = schema.type;
    byKey.set(`${location}:${raw.name}`, param);
  }
  for (const name of pathParams(path)) {
    if (!byKey.has(`path:${name}`)) byKey.set(`path:${name}`, { name, in: "path", required: true });
  }
  return [...byKey.values()];
}

function bodyParameters(schema: unknown): ApiParameter[] {
  if (!isObj(schema) || !isObj(schema.properties)) return [];
  const required = new Set(stringList(schema.required));
  return Object.entries(schema.properties).map(([name, prop]) => {
    const param: ApiParameter = { name, in: "body", required: required.has(name) };
    if (isObj(prop) && typeof prop.type === "string") param.type = prop.type;
    return param;
  });
}

function lineRange(doc: ReturnType<typeof parseDocument>, counter: LineCounter, path: string, method: string): { start: number; end: number } | undefined {
  const item = doc.getIn(["paths", path], true);
  if (!isMap(item)) return undefined;
  const pair = (item as YAMLMap).items.find((p) => isScalar(p.key) && p.key.value === method);
  if (!pair || !isScalar(pair.key) || !pair.key.range) return undefined;
  const start = counter.linePos(pair.key.range[0]).line;
  const value = pair.value as { range?: [number, number, number] } | null;
  const endOffset = value?.range ? Math.max(value.range[0], value.range[1] - 1) : pair.key.range[1];
  return { start, end: Math.max(start, counter.linePos(endOffset).line) };
}

/** Parses a standalone OpenAPI 3.x document (JSON or YAML). Line references are best effort. */
export function parseOpenApi(snapshot: SourceSnapshot, text: string, options: OpenApiParseOptions = {}): ApiParseResult {
  const offset = options.lineOffset ?? 0;
  const section = options.section ?? [];
  const lineCount = splitLines(text).length;
  const docRef = (excerptText: string): SourceReference => sourceRef(snapshot.id, offset + 1, offset + Math.max(1, lineCount), section, excerptText);
  const fail = (message: string): ApiParseResult => ({
    operations: [],
    issues: [makeIssue("unparseable_operation", "error", message, { detail: `${snapshot.id}:${offset}` }, [docRef(splitLines(text)[0] ?? "")])],
  });

  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, uniqueKeys: false });
  if (doc.errors.length > 0) return fail(`OpenAPI document could not be parsed: ${doc.errors[0]!.message.split("\n")[0]}`);
  let root: unknown;
  try {
    root = doc.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return fail(`OpenAPI document could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObj(root) || (typeof root.openapi !== "string" && typeof root.swagger !== "string")) {
    return fail("Document is not an OpenAPI description (missing `openapi` version field).");
  }
  if (!isObj(root.paths)) return fail("OpenAPI document has no `paths`.");

  const schemes = isObj(root.components) && isObj(root.components.securitySchemes) ? root.components.securitySchemes : {};
  const operations: ApiOperation[] = [];
  const issues: DocumentIssue[] = [];

  for (const rawPath of Object.keys(root.paths)) {
    const pathItem = deref(root.paths[rawPath], root);
    if (!isObj(pathItem)) continue;
    const path = normalizePath(rawPath);
    for (const method of HTTP_METHODS) {
      const rawOp = pathItem[method];
      if (!isObj(rawOp)) continue;
      const op = deref(rawOp, root) as Obj;
      const upper = method.toUpperCase();
      const lines = lineRange(doc, counter, rawPath, method);
      const ref = lines
        ? sourceRef(snapshot.id, offset + lines.start, offset + lines.end, [...section, "paths", rawPath, method], `${upper} ${rawPath}`)
        : docRef(`${upper} ${rawPath}`);

      const params = [
        ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
        ...(Array.isArray(op.parameters) ? op.parameters : []),
      ];
      const operation: ApiOperation = {
        id: typeof op.operationId === "string" && op.operationId.trim() ? op.operationId.trim() : fallbackOperationId(upper, path),
        method: upper,
        path,
        roles: rolesFrom(op),
        parameters: buildParameters(params, path),
        responses: buildResponses(op.responses),
        sourceRefs: [ref],
      };
      const summary = typeof op.summary === "string" ? op.summary : typeof op.description === "string" ? op.description.split("\n")[0] : undefined;
      if (summary?.trim()) operation.summary = collapseWhitespace(summary);
      const auth = describeAuth(op.security ?? root.security, schemes);
      if (auth) operation.auth = auth;
      const body = jsonContent(op.requestBody);
      if (isObj(body?.schema)) {
        operation.requestSchema = body!.schema as JsonSchema;
        operation.parameters.push(...bodyParameters(body!.schema));
      }
      if (typeof op.operationId !== "string") {
        issues.push(
          makeIssue(
            "missing_id",
            "info",
            `${upper} ${path} has no operationId; using generated id ${operation.id}.`,
            { operationId: operation.id, detail: `${upper} ${path}` },
            [ref],
          ),
        );
      }
      operations.push(operation);
    }
  }

  if (operations.length === 0) {
    issues.push(makeIssue("empty_document", "error", "OpenAPI document defines no operations.", { detail: snapshot.id }, [docRef("paths")]));
  }
  return { operations, issues };
}

/** True when text looks like an OpenAPI description. */
export function looksLikeOpenApi(text: string): boolean {
  return /^\s*["']?(?:openapi|swagger)["']?\s*:/m.test(text) || /^\s*\{[\s\S]*?"(?:openapi|swagger)"\s*:/.test(text);
}

