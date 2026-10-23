import type {
  AcceptanceScenario,
  AlignmentPackage,
  AlignmentPolicy,
  AlignmentReadiness,
  ApiOperation,
  BusinessRequirement,
  DocumentIssue,
  RequirementApiMapping,
  SourceSnapshot,
  TraceabilityItem,
} from "@frontflow/domain";
import type { AcceptanceCriterion } from "./ba-parser.js";
import { parseBaMarkdown } from "./ba-parser.js";
import { parseApiMarkdown } from "./api-parser.js";
import { classifyAlignment, DEFAULT_POLICY } from "./classify.js";
import { dedupeIssues } from "./issues.js";
import type { RequirementApiLink } from "./mapping.js";
import { mapRequirementsToApi } from "./mapping.js";
import { looksLikeOpenApi, parseOpenApi } from "./openapi.js";
import { generateAcceptanceScenarios } from "./scenarios.js";
import { normalizeText, snapshotDocument } from "./snapshot.js";
import { buildTraceabilityMatrix } from "./traceability.js";
import { verifyDocuments } from "./verify.js";

export interface BuildPackageInput {
  runId: string;
  snapshots: (SourceSnapshot | string)[];
  requirements: BusinessRequirement[];
  operations: ApiOperation[];
  issues: DocumentIssue[];
  mappings: RequirementApiMapping[];
  scenarios: AcceptanceScenario[];
  traceability: TraceabilityItem[];
  policy?: AlignmentPolicy;
}

const BLOCKER_STATUSES = new Set<RequirementApiMapping["status"]>(["missing", "conflict", "ambiguous", "partial"]);

/**
 * Spec §12.3:
 * - ready: every blocking requirement is covered or not_required, and no document issue has severity error;
 * - ready_with_assumptions: the only remaining gaps are `assumed` and the policy allows assumptions;
 * - not_ready: anything else (blocking missing / conflict / ambiguous / partial, or error issues).
 */
export function computeReadiness(mappings: RequirementApiMapping[], issues: DocumentIssue[], policy: AlignmentPolicy): AlignmentReadiness {
  const optional = new Set(policy.optionalRequirementIds);
  const blocking = mappings.filter((m) => m.blocking && !optional.has(m.requirementId));
  if (issues.some((i) => i.severity === "error")) return "not_ready";
  if (blocking.some((m) => BLOCKER_STATUSES.has(m.status))) return "not_ready";
  const assumed = blocking.some((m) => m.status === "assumed" || m.findings.some((f) => f.assumed));
  if (!assumed) return "ready";
  return policy.allowAssumptions ? "ready_with_assumptions" : "not_ready";
}

export function summarize(mappings: RequirementApiMapping[]): AlignmentPackage["summary"] {
  const count = (status: RequirementApiMapping["status"]) => mappings.filter((m) => m.status === status).length;
  return {
    covered: count("covered"),
    partial: count("partial"),
    missing: count("missing"),
    conflict: count("conflict"),
    ambiguous: count("ambiguous"),
    notRequired: count("not_required"),
    assumed: count("assumed"),
  };
}

/** Spec §12.2 — assembles the Alignment Package with summary counts and readiness. */
export function buildAlignmentPackage(input: BuildPackageInput): AlignmentPackage {
  const policy = input.policy ?? DEFAULT_POLICY;
  const issues = dedupeIssues(input.issues);
  return {
    version: 1,
    runId: input.runId,
    sourceSnapshots: input.snapshots.map((s) => (typeof s === "string" ? s : s.id)),
    requirements: input.requirements,
    operations: input.operations,
    mappings: input.mappings,
    scenarios: input.scenarios,
    traceability: input.traceability,
    issues,
    summary: summarize(input.mappings),
    readiness: computeReadiness(input.mappings, issues, policy),
  };
}

export interface RunAlignmentInput {
  runId: string;
  ba: { content: string | Uint8Array; sourceUri?: string };
  api: { content: string | Uint8Array; sourceUri?: string; kind?: "markdown" | "openapi" };
  policy?: AlignmentPolicy;
  /** Snapshot timestamp; does not affect the package. */
  createdAt?: string;
}

export interface RunAlignmentResult {
  alignmentPackage: AlignmentPackage;
  snapshots: SourceSnapshot[];
  links: RequirementApiLink[];
  acceptanceCriteria: AcceptanceCriterion[];
  actors: string[];
}

function detectApiKind(sourceUri: string | undefined, text: string): "markdown" | "openapi" {
  if (sourceUri && /\.(?:ya?ml|json)$/i.test(sourceUri)) return "openapi";
  const first = text.split("\n").find((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  if (!first) return "markdown";
  if (/^["']?(?:openapi|swagger)["']?\s*:/.test(first.trim())) return "openapi";
  return first.trim().startsWith("{") && looksLikeOpenApi(text) ? "openapi" : "markdown";
}

/** Workflow A end to end (A1–A8) for one BA document and one API contract. Throws DocumentError on unreadable input. */
export function runAlignment(input: RunAlignmentInput): RunAlignmentResult {
  const policy = input.policy ?? DEFAULT_POLICY;
  const ba = snapshotDocument(withOptional({ type: "ba_markdown", content: input.ba.content }, input.ba.sourceUri, input.createdAt));
  const kind = input.api.kind ?? detectApiKind(input.api.sourceUri, normalizeText(input.api.content));
  const apiType = kind === "openapi" ? "openapi" : "api_markdown";
  const api = snapshotDocument(withOptional({ type: apiType, content: input.api.content }, input.api.sourceUri, input.createdAt));

  const baResult = parseBaMarkdown(ba.snapshot, ba.text);
  const apiResult = kind === "openapi" ? parseOpenApi(api.snapshot, api.text) : parseApiMarkdown(api.snapshot, api.text);

  const issues = [...baResult.issues, ...apiResult.issues, ...verifyDocuments(baResult.requirements, apiResult.operations)];
  const links = mapRequirementsToApi(baResult.requirements, apiResult.operations);
  const mappings = classifyAlignment(baResult.requirements, apiResult.operations, links, policy);
  const scenarios = generateAcceptanceScenarios(baResult.requirements, mappings, {
    criteria: baResult.acceptanceCriteria,
    operations: apiResult.operations,
    actors: baResult.actors,
  });
  const traceability = buildTraceabilityMatrix(baResult.requirements, mappings, scenarios);
  const alignmentPackage = buildAlignmentPackage({
    runId: input.runId,
    snapshots: [ba.snapshot, api.snapshot],
    requirements: baResult.requirements,
    operations: apiResult.operations,
    issues,
    mappings,
    scenarios,
    traceability,
    policy,
  });
  return {
    alignmentPackage,
    snapshots: [ba.snapshot, api.snapshot],
    links,
    acceptanceCriteria: baResult.acceptanceCriteria,
    actors: baResult.actors,
  };
}

function withOptional<T extends object>(base: T, sourceUri: string | undefined, createdAt: string | undefined): T & { sourceUri?: string; createdAt?: string } {
  const out: T & { sourceUri?: string; createdAt?: string } = { ...base };
  if (sourceUri) out.sourceUri = sourceUri;
  if (createdAt) out.createdAt = createdAt;
  return out;
}
