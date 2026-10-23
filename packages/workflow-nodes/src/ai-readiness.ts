import {
  READINESS_STATUSES,
  type AcceptanceTestCase,
  type AcceptanceTestCasePackage,
  type ApiOperation,
  type BusinessRequirement,
  type FeReadiness,
  type FeReadinessPackage,
  type ReadinessGap,
  type ReadinessStatus,
  type TestabilityGap,
  type UiAction,
  type UiApiMapping,
  type UiApiTraceabilityItem,
  type UiDataRequirement,
  type UiFlowNode,
  type UiState,
} from "@frontflow/domain";
import { escapeMarkdownText, type AcceptanceCriterion } from "@frontflow/document-parser";
import { asArray, asRecord, clamp, num, round, str, strings } from "./ai-ingest.js";

/**
 * Workflow A (spec §12) and C1 (spec §14.1) with an AI CLI: the agent answers
 * in JSON and this module grounds the answer against what the run already
 * knows (Figma layers, UI flow ids, API operation ids, BA requirement ids)
 * before anything downstream trusts it. Unknown ids are dropped, missing
 * classifications become `ambiguous`, and every inference stays visible.
 */

export const UI_FLOW_FILE = "ui-flow.json";
export const READINESS_FILE = "readiness.json";
export const TEST_DESIGN_FILE = "test-design.json";

export const UI_FLOW_SCHEMA = `{
  "screens": [{
    "id": string,                    // stable id, e.g. "SCR-cancel-order-modal"
    "name": string,
    "kind": "screen"|"dialog"|"component"|"interaction",
    "figmaNodeIds": string[],        // Figma node ids this screen is built from
    "actions": [{ "id": string, "label": string, "trigger": string, "figmaNodeId": string | null }],
    "states": [{ "id": string, "name": string,
                 "kind": "default"|"loading"|"empty"|"error"|"success"|"disabled"|"permission"|"validation"|"other",
                 "designed": boolean,  // true only when a frame/variant shows it
                 "figmaNodeId": string | null }],
    "transitions": [{ "from": string, "to": string, "actionId": string | null }],
    "confidence": number             // 0..1
  }],
  "requirements": [{                 // what each screen/action/state needs from data or the backend
    "id": string,                    // e.g. "UIR-001"
    "uiFlowNodeId": string,          // a screens[].id
    "kind": "query"|"mutation"|"validation"|"state"|"permission",
    "description": string,
    "requiredFields": string[],      // data the UI displays or sends
    "expectedOutcomes": string[]     // success, empty, error and permission outcomes the UI must represent
  }]
}`;

export const READINESS_SCHEMA = `{
  "summary": string,                 // 3–6 short sentences: can the feature be implemented, the most important gaps and who must fix them
  "mappings": [{
    "uiDataRequirementId": string,   // every requirement id from ui-flow.json exactly once
    "apiOperationIds": string[],     // operation ids from api-operations.json
    "fieldMappings": { [uiField: string]: string },  // UI field → API field path
    "coveredOutcomes": string[],
    "uncoveredOutcomes": string[],
    "status": "ready"|"partial"|"missing_api"|"missing_design"|"conflict"|"ambiguous"|"fe_only"|"assumed",
    "rationale": string,             // one or two sentences; cite API contract line numbers and Figma layer names
    "confidence": number             // 0..1
  }],
  "gaps": [{
    "kind": "api_gap"|"design_gap"|"mapping_gap"|"conflict",
    "message": string,
    "uiDataRequirementId": string | null,
    "apiOperationIds": string[],
    "blocking": boolean              // true when the feature cannot be implemented correctly without fixing it
  }]
}`;

export const TEST_DESIGN_SCHEMA = `{
  "testCases": [{
    "id": string,                    // e.g. "TC-BA-ORDER-001-01"
    "requirementIds": string[],      // BA requirement ids from ba-scenarios.json
    "title": string,
    "preconditions": [{ "description": string, "setup": string | null }],
    "steps": [{ "action": string, "uiFlowNodeId": string | null, "apiOperationId": string | null }],
    "expectedOutcomes": [{ "description": string, "kind": "ui"|"api"|"navigation"|"data" }],
    "testData": [{ "name": string, "description": string, "example": string | null }],
    "uiFlowNodeIds": string[],       // screens from ui-flow.json
    "apiOperationIds": string[],     // operations from readiness.json
    "level": "component"|"integration"|"e2e"
  }],
  "testabilityGaps": [{
    "requirementId": string,
    "reason": "missing_design"|"missing_api"|"missing_test_data"|"missing_expected_outcome"|"ambiguous",
    "message": string,
    "blocking": boolean
  }]
}`;

const UI_KINDS = new Set<UiFlowNode["kind"]>(["screen", "dialog", "component", "interaction"]);
const STATE_KINDS = new Set<UiState["kind"]>(["default", "loading", "empty", "error", "success", "disabled", "permission", "validation", "other"]);
const REQ_KINDS = new Set<UiDataRequirement["kind"]>(["query", "mutation", "validation", "state", "permission"]);
const GAP_KINDS = new Set<ReadinessGap["kind"]>(["api_gap", "design_gap", "mapping_gap", "conflict"]);
const LEVELS = new Set<AcceptanceTestCase["level"]>(["component", "integration", "e2e"]);
const OUTCOME_KINDS = new Set(["ui", "api", "navigation", "data"]);
const GAP_REASONS = new Set<TestabilityGap["reason"]>(["missing_design", "missing_api", "missing_test_data", "missing_expected_outcome", "ambiguous"]);
/** Statuses that block implementation when the requirement is mandatory (spec §12.3). */
const BLOCKING: ReadonlySet<ReadinessStatus> = new Set(["missing_api", "missing_design", "conflict", "ambiguous"]);

export interface UiFlowResult {
  uiFlow: UiFlowNode[];
  uiDataRequirements: UiDataRequirement[];
  warnings: string[];
}

// ---------------------------------------------------------------- A2/A4: UI flow

export function ingestUiFlow(raw: unknown): UiFlowResult {
  const warnings: string[] = [];
  const root = asRecord(raw);
  if (!root) throw new Error("AI UI flow is not a JSON object");

  const uiFlow: UiFlowNode[] = [];
  const seen = new Set<string>();
  for (const [index, item] of asArray(root["screens"]).entries()) {
    const s = asRecord(item);
    if (!s) continue;
    const id = unique(str(s["id"])?.trim() || `SCR-${pad(index + 1)}`, seen, warnings, "screen");
    const kind = UI_KINDS.has(str(s["kind"]) as UiFlowNode["kind"]) ? (str(s["kind"]) as UiFlowNode["kind"]) : "screen";
    const actions: UiAction[] = asArray(s["actions"]).flatMap((a, i) => {
      const x = asRecord(a);
      const label = x && str(x["label"]);
      if (!x || !label) return [];
      return [{ id: str(x["id"]) ?? `${id}-A${i + 1}`, label, trigger: str(x["trigger"]) ?? "click", ...(str(x["figmaNodeId"]) ? { figmaNodeId: str(x["figmaNodeId"])! } : {}) }];
    });
    const states: UiState[] = asArray(s["states"]).flatMap((a, i) => {
      const x = asRecord(a);
      const name = x && str(x["name"]);
      if (!x || !name) return [];
      const stateKind = STATE_KINDS.has(str(x["kind"]) as UiState["kind"]) ? (str(x["kind"]) as UiState["kind"]) : "other";
      return [{ id: str(x["id"]) ?? `${id}-S${i + 1}`, name, kind: stateKind, designed: x["designed"] === true, ...(str(x["figmaNodeId"]) ? { figmaNodeId: str(x["figmaNodeId"])! } : {}) }];
    });
    uiFlow.push({
      id,
      name: str(s["name"])?.trim() || id,
      kind,
      figmaNodeIds: strings(s["figmaNodeIds"]),
      actions,
      states,
      transitions: asArray(s["transitions"]).flatMap((t) => {
        const x = asRecord(t);
        const from = x && str(x["from"]);
        const to = x && str(x["to"]);
        return x && from && to ? [{ from, to, ...(str(x["actionId"]) ? { actionId: str(x["actionId"])! } : {}) }] : [];
      }),
      sourceRefs: [],
      confidence: round(clamp(num(s["confidence"]) ?? 0.7)),
    });
  }
  if (!uiFlow.length) throw new Error("AI UI flow returned no screens");

  const screenIds = new Set(uiFlow.map((n) => n.id));
  const reqIds = new Set<string>();
  const uiDataRequirements: UiDataRequirement[] = [];
  for (const [index, item] of asArray(root["requirements"]).entries()) {
    const r = asRecord(item);
    if (!r) continue;
    const screen = str(r["uiFlowNodeId"]);
    if (!screen || !screenIds.has(screen)) {
      warnings.push(`UI requirement #${index + 1} dropped: unknown screen ${screen ?? "(none)"}`);
      continue;
    }
    const description = str(r["description"])?.trim();
    if (!description) continue;
    uiDataRequirements.push({
      id: unique(str(r["id"])?.trim() || `UIR-${pad(index + 1)}`, reqIds, warnings, "UI requirement"),
      uiFlowNodeId: screen,
      kind: REQ_KINDS.has(str(r["kind"]) as UiDataRequirement["kind"]) ? (str(r["kind"]) as UiDataRequirement["kind"]) : "state",
      description,
      requiredFields: strings(r["requiredFields"]),
      expectedOutcomes: strings(r["expectedOutcomes"]),
      sourceRefs: [],
    });
  }
  return { uiFlow, uiDataRequirements, warnings };
}

/** Last resort when the AI could not read the design: one screen per selected Figma layer, nothing derived. */
export function uiFlowFromLayers(layers: Array<{ nodeId: string; name: string }>): UiFlowResult {
  return {
    uiFlow: layers.map((l, i) => ({
      id: `SCR-${pad(i + 1)}`,
      name: l.name,
      kind: "screen",
      figmaNodeIds: [l.nodeId],
      actions: [],
      states: [{ id: `SCR-${pad(i + 1)}-S1`, name: "default", kind: "default", designed: true, figmaNodeId: l.nodeId }],
      transitions: [],
      sourceRefs: [],
      confidence: 0.2,
    })),
    uiDataRequirements: [],
    warnings: ["UI flow built from the selected layers only; no data or action requirement could be derived"],
  };
}

// ---------------------------------------------------------------- A5–A8: readiness

export interface ReadinessResult {
  mappings: UiApiMapping[];
  gaps: ReadinessGap[];
  warnings: string[];
  summary?: string;
}

export function ingestReadiness(raw: unknown, requirements: UiDataRequirement[], operations: ApiOperation[]): ReadinessResult {
  const warnings: string[] = [];
  const root = asRecord(raw);
  if (!root) throw new Error("AI readiness mapping is not a JSON object");
  const opIds = new Set(operations.map((o) => o.id));
  const byReq = new Map<string, Record<string, unknown>>();
  for (const item of asArray(root["mappings"])) {
    const m = asRecord(item);
    const rid = m && str(m["uiDataRequirementId"]);
    if (!m || !rid) continue;
    if (!requirements.some((r) => r.id === rid)) {
      warnings.push(`Mapping mentions unknown UI requirement ${rid}; ignored`);
      continue;
    }
    byReq.set(rid, m);
  }

  const mappings = requirements.map((req, i): UiApiMapping => {
    const id = `MAP-${pad(i + 1)}`;
    const m = byReq.get(req.id);
    if (!m) {
      warnings.push(`${req.id} was not classified by the AI`);
      return { id, uiDataRequirementId: req.id, apiOperationIds: [], fieldMappings: {}, coveredOutcomes: [], uncoveredOutcomes: req.expectedOutcomes, status: "ambiguous", confidence: 0, rationale: "The AI did not classify this requirement.", blocking: true };
    }
    const requested = strings(m["apiOperationIds"]);
    const unknown = requested.filter((op) => !opIds.has(op));
    if (unknown.length) warnings.push(`${req.id}: unknown operation ids dropped (${unknown.join(", ")})`);
    const ids = requested.filter((op) => opIds.has(op));
    let status = (READINESS_STATUSES as readonly string[]).includes(str(m["status"]) ?? "") ? (str(m["status"]) as ReadinessStatus) : "ambiguous";
    let rationale = str(m["rationale"]) ?? "";
    // A requirement can't be "ready" through operations that do not exist in the contract.
    if (status === "ready" && (req.kind === "query" || req.kind === "mutation") && ids.length === 0) {
      status = requested.length ? "ambiguous" : "missing_api";
      rationale = `${rationale} (downgraded: no API operation from the contract was cited)`.trim();
    }
    const fieldMappings: Record<string, string> = {};
    for (const [k, v] of Object.entries(asRecord(m["fieldMappings"]) ?? {})) if (typeof v === "string" && v.trim()) fieldMappings[k] = v.trim();
    return {
      id,
      uiDataRequirementId: req.id,
      apiOperationIds: ids,
      fieldMappings,
      coveredOutcomes: strings(m["coveredOutcomes"]),
      uncoveredOutcomes: strings(m["uncoveredOutcomes"]),
      status,
      confidence: round(clamp(num(m["confidence"]) ?? 0.7)),
      rationale,
      blocking: true,
    };
  });

  const gaps: ReadinessGap[] = [];
  for (const item of asArray(root["gaps"])) {
    const g = asRecord(item);
    const message = g && str(g["message"]);
    if (!g || !message) continue;
    const kind = GAP_KINDS.has(str(g["kind"]) as ReadinessGap["kind"]) ? (str(g["kind"]) as ReadinessGap["kind"]) : "mapping_gap";
    const reqId = str(g["uiDataRequirementId"]);
    const req = reqId ? requirements.find((r) => r.id === reqId) : undefined;
    gaps.push({
      id: `GAP-${pad(gaps.length + 1)}`,
      kind,
      owner: ownerOf(kind),
      message,
      ...(req ? { uiDataRequirementId: req.id, uiFlowNodeId: req.uiFlowNodeId } : {}),
      apiOperationIds: strings(g["apiOperationIds"]).filter((op) => opIds.has(op)),
      blocking: g["blocking"] !== false,
    });
  }
  const summary = str(root["summary"])?.trim();
  return { mappings, gaps: withMappingGaps(gaps, mappings, requirements), warnings, ...(summary ? { summary } : {}) };
}

/**
 * Built-in heuristics when the AI keeps failing: link a requirement to the
 * operation whose id/path/summary shares the most words with it. Everything
 * it decides is `assumed` or `ambiguous`, never `ready`.
 */
export function heuristicReadiness(requirements: UiDataRequirement[], operations: ApiOperation[]): ReadinessResult {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
  const mappings = requirements.map((req, i): UiApiMapping => {
    const needsApi = req.kind === "query" || req.kind === "mutation";
    const reqWords = words(`${req.description} ${req.requiredFields.join(" ")}`);
    let best: ApiOperation | undefined;
    let bestScore = 0;
    for (const op of operations) {
      const opWords = words(`${op.id} ${op.path} ${op.summary ?? ""}`);
      const score = [...reqWords].filter((w) => opWords.has(w)).length;
      if (score > bestScore) [best, bestScore] = [op, score];
    }
    const status: ReadinessStatus = best ? "assumed" : needsApi ? "ambiguous" : "fe_only";
    return {
      id: `MAP-${pad(i + 1)}`,
      uiDataRequirementId: req.id,
      apiOperationIds: best ? [best.id] : [],
      fieldMappings: {},
      coveredOutcomes: [],
      uncoveredOutcomes: req.expectedOutcomes,
      status,
      confidence: best ? 0.3 : 0.1,
      rationale: best ? `Matched by keywords with ${best.method} ${best.path} (built-in heuristics).` : needsApi ? "No API operation matched (built-in heuristics)." : "Assumed to be handled in the frontend (built-in heuristics).",
      blocking: needsApi,
    };
  });
  return { mappings, gaps: withMappingGaps([], mappings, requirements), warnings: ["Mapped with built-in heuristics; results are approximate and marked as assumed"] };
}

/** Every blocking classification gets a gap with the owner who has to fix it, unless the AI already reported one. */
function withMappingGaps(gaps: ReadinessGap[], mappings: UiApiMapping[], requirements: UiDataRequirement[]): ReadinessGap[] {
  const out = [...gaps];
  for (const m of mappings) {
    const kind: ReadinessGap["kind"] | undefined =
      m.status === "missing_api" ? "api_gap" : m.status === "missing_design" ? "design_gap" : m.status === "conflict" ? "conflict" : m.status === "ambiguous" ? "mapping_gap" : undefined;
    if (!kind || out.some((g) => g.uiDataRequirementId === m.uiDataRequirementId && g.kind === kind)) continue;
    const req = requirements.find((r) => r.id === m.uiDataRequirementId);
    out.push({
      id: `GAP-${pad(out.length + 1)}`,
      kind,
      owner: ownerOf(kind),
      message: `${req?.description ?? m.uiDataRequirementId}: ${m.rationale || m.status}`,
      uiDataRequirementId: m.uiDataRequirementId,
      ...(req ? { uiFlowNodeId: req.uiFlowNodeId } : {}),
      apiOperationIds: m.apiOperationIds,
      blocking: m.blocking,
    });
  }
  return out;
}

function ownerOf(kind: ReadinessGap["kind"]): ReadinessGap["owner"] {
  return kind === "api_gap" ? "backend" : kind === "design_gap" ? "design" : kind === "conflict" ? "backend_and_design" : "frontend";
}

/** Spec §12.3 */
export function computeFeReadiness(mappings: UiApiMapping[], gaps: ReadinessGap[], requirementCount: number, allowAssumptions: boolean): FeReadiness {
  if (requirementCount === 0) return "not_ready";
  if (mappings.some((m) => m.blocking && BLOCKING.has(m.status)) || gaps.some((g) => g.blocking)) return "not_ready";
  if (mappings.some((m) => m.status === "partial" || m.status === "assumed")) return allowAssumptions ? "ready_with_assumptions" : "not_ready";
  return "ready";
}

export function buildReadinessPackage(input: {
  runId: string;
  sourceSnapshots: string[];
  uiFlow: UiFlowNode[];
  uiDataRequirements: UiDataRequirement[];
  operations: ApiOperation[];
  mappings: UiApiMapping[];
  gaps: ReadinessGap[];
  allowAssumptions: boolean;
}): FeReadinessPackage {
  const count = (s: ReadinessStatus) => input.mappings.filter((m) => m.status === s).length;
  const gaps = [...input.gaps];
  if (input.uiDataRequirements.length === 0) {
    gaps.push({ id: `GAP-${pad(gaps.length + 1)}`, kind: "mapping_gap", owner: "frontend", message: "No UI data or action requirement could be derived from the design.", apiOperationIds: [], blocking: true });
  }
  return {
    version: 1,
    runId: input.runId,
    sourceSnapshots: input.sourceSnapshots,
    uiFlow: input.uiFlow,
    uiDataRequirements: input.uiDataRequirements,
    operations: input.operations,
    mappings: input.mappings,
    gaps,
    traceability: input.uiFlow.map((node): UiApiTraceabilityItem => {
      const reqs = input.uiDataRequirements.filter((r) => r.uiFlowNodeId === node.id);
      const maps = input.mappings.filter((m) => reqs.some((r) => r.id === m.uiDataRequirementId));
      return {
        uiFlowNodeId: node.id,
        figmaNodeIds: node.figmaNodeIds,
        uiDataRequirementIds: reqs.map((r) => r.id),
        apiOperationIds: [...new Set(maps.flatMap((m) => m.apiOperationIds))],
        sourceFiles: [],
        testIds: [],
        evidenceIds: [],
        status: maps.some((m) => m.blocking && BLOCKING.has(m.status)) ? "blocked" : maps.some((m) => m.status === "partial" || m.status === "assumed") ? "assumed" : "unverified",
      };
    }),
    summary: {
      ready: count("ready"),
      partial: count("partial"),
      missingApi: count("missing_api"),
      missingDesign: count("missing_design"),
      conflict: count("conflict"),
      ambiguous: count("ambiguous"),
      feOnly: count("fe_only"),
      assumed: count("assumed"),
    },
    readiness: computeFeReadiness(input.mappings, gaps, input.uiDataRequirements.length, input.allowAssumptions),
  };
}

/** Short, human verdict on whether Figma × API is enough to build the feature (shown as the step result). */
export interface ReadinessVerdict {
  /** 0–100: ready and FE-only count fully, partial and assumed count half. */
  score: number;
  headline: string;
  summary: string;
  analyzedBy: "ai" | "heuristics";
  readiness: FeReadiness;
  counts: Record<ReadinessStatus, number>;
  gaps: { api: number; design: number; mapping: number; conflict: number };
  issues: Array<{ id: string; title: string; status: ReadinessStatus; reason: string }>;
}

const SEVERITY: ReadinessStatus[] = ["conflict", "missing_api", "missing_design", "partial", "ambiguous", "assumed"];

export function buildReadinessVerdict(pkg: FeReadinessPackage, analyzedBy: ReadinessVerdict["analyzedBy"], aiSummary?: string): ReadinessVerdict {
  const counts = Object.fromEntries(READINESS_STATUSES.map((s) => [s, 0])) as Record<ReadinessStatus, number>;
  for (const m of pkg.mappings) counts[m.status] += 1;
  const total = pkg.mappings.length;
  const score = total ? Math.round((100 * (counts.ready + counts.fe_only + 0.5 * (counts.partial + counts.assumed))) / total) : 0;
  const gaps = {
    api: pkg.gaps.filter((g) => g.kind === "api_gap").length,
    design: pkg.gaps.filter((g) => g.kind === "design_gap").length,
    mapping: pkg.gaps.filter((g) => g.kind === "mapping_gap").length,
    conflict: pkg.gaps.filter((g) => g.kind === "conflict").length,
  };
  const problems = [gaps.api ? `${gaps.api} API gap` : "", gaps.design ? `${gaps.design} design gap` : "", gaps.conflict ? `${gaps.conflict} conflict` : ""].filter(Boolean);
  const headline = total
    ? `${counts.ready + counts.fe_only} of ${total} UI needs ready to implement (${score}%)${problems.length ? ` — ${problems.join(", ")}` : ""}`
    : "No UI data or action need derived from the design";
  const issues = pkg.mappings
    .filter((m) => SEVERITY.includes(m.status))
    .sort((a, b) => SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status))
    .slice(0, 15)
    .map((m) => ({
      id: m.uiDataRequirementId,
      title: pkg.uiDataRequirements.find((r) => r.id === m.uiDataRequirementId)?.description ?? m.uiDataRequirementId,
      status: m.status,
      reason: m.rationale || m.uncoveredOutcomes.join("; ") || "No reason given",
    }));
  const summary =
    aiSummary ??
    `Ready ${counts.ready}, FE-only ${counts.fe_only}, partial ${counts.partial}, missing API ${counts.missing_api}, missing design ${counts.missing_design}, conflict ${counts.conflict}, ambiguous ${counts.ambiguous}.${
      analyzedBy === "heuristics" ? " Classified by built-in heuristics, not by the AI: treat as approximate." : ""
    }`;
  return { score, headline, summary, analyzedBy, readiness: pkg.readiness, counts, gaps, issues };
}

export function renderReadinessReport(pkg: FeReadinessPackage, verdict: ReadinessVerdict): string {
  const esc = escapeMarkdownText;
  const section = (title: string, kind: ReadinessGap["kind"], owner: string) => {
    const items = pkg.gaps.filter((g) => g.kind === kind);
    return [`## ${title} — owner: ${owner}`, "", ...(items.length ? items.map((g) => `- ${g.blocking ? "**blocking** " : ""}${g.uiDataRequirementId ? `\`${esc(g.uiDataRequirementId)}\` ` : ""}${esc(g.message)}${g.apiOperationIds.length ? ` (API: ${g.apiOperationIds.map(esc).join(", ")})` : ""}`) : ["- none"]), ""];
  };
  return [
    `# FE readiness: ${pkg.readiness}`,
    "",
    `**${esc(verdict.headline)}**`,
    "",
    esc(verdict.summary),
    "",
    ...section("API gaps", "api_gap", "backend"),
    ...section("Design gaps", "design_gap", "design"),
    ...section("Mapping gaps", "mapping_gap", "frontend"),
    ...section("Conflicts", "conflict", "backend & design"),
    "## UI ↔ API mapping",
    "",
    "| Screen | UI need | Kind | Status | API | Rationale |",
    "|---|---|---|---|---|---|",
    ...pkg.mappings.map((m) => {
      const req = pkg.uiDataRequirements.find((r) => r.id === m.uiDataRequirementId);
      const screen = pkg.uiFlow.find((n) => n.id === req?.uiFlowNodeId);
      return `| ${esc(screen?.name ?? "?")} | \`${esc(m.uiDataRequirementId)}\` ${esc(req?.description ?? "")} | ${req?.kind ?? "?"} | ${m.status} | ${m.apiOperationIds.map(esc).join(", ") || "—"} | ${esc(m.rationale)} |`;
    }),
  ].join("\n");
}

// ---------------------------------------------------------------- C1: test design

export interface TestDesignResult {
  testCases: AcceptanceTestCase[];
  testabilityGaps: TestabilityGap[];
  warnings: string[];
}

export function ingestTestDesign(raw: unknown, requirements: BusinessRequirement[], readiness: FeReadinessPackage): TestDesignResult {
  const warnings: string[] = [];
  const root = asRecord(raw);
  if (!root) throw new Error("AI test design is not a JSON object");
  const reqIds = new Set(requirements.map((r) => r.id));
  const screens = new Map(readiness.uiFlow.map((n) => [n.id, n]));
  const opIds = new Set(readiness.operations.map((o) => o.id));
  const known = <T extends string>(ids: string[], set: { has(id: string): boolean }, what: string, owner: string): T[] => {
    const unknown = ids.filter((id) => !set.has(id));
    if (unknown.length) warnings.push(`${owner}: unknown ${what} dropped (${unknown.join(", ")})`);
    return ids.filter((id) => set.has(id)) as T[];
  };

  const seen = new Set<string>();
  const testCases: AcceptanceTestCase[] = [];
  for (const [index, item] of asArray(root["testCases"]).entries()) {
    const t = asRecord(item);
    if (!t) continue;
    const id = unique(str(t["id"])?.trim() || `TC-${pad(index + 1)}`, seen, warnings, "test case");
    const requirementIds = known<string>(strings(t["requirementIds"]), reqIds, "requirements", id);
    if (!requirementIds.length) {
      warnings.push(`${id} dropped: it covers no known BA requirement`);
      continue;
    }
    const uiFlowNodeIds = known<string>(strings(t["uiFlowNodeIds"]), screens, "screens", id);
    const expectedOutcomes = asArray(t["expectedOutcomes"]).flatMap((o) => {
      const x = asRecord(o);
      const description = x && str(x["description"]);
      return x && description ? [{ description, kind: (OUTCOME_KINDS.has(str(x["kind"]) ?? "") ? str(x["kind"]) : "ui") as "ui" | "api" | "navigation" | "data" }] : [];
    });
    if (!expectedOutcomes.length) {
      warnings.push(`${id} dropped: no expected outcome`);
      continue;
    }
    testCases.push({
      id,
      requirementIds,
      title: str(t["title"])?.trim() || id,
      preconditions: asArray(t["preconditions"]).flatMap((p) => {
        const x = asRecord(p);
        const description = x && str(x["description"]);
        return x && description ? [{ description, ...(str(x["setup"]) ? { setup: str(x["setup"])! } : {}) }] : [];
      }),
      steps: asArray(t["steps"]).flatMap((s) => {
        const x = asRecord(s);
        const action = x && str(x["action"]);
        if (!x || !action) return [];
        const screen = str(x["uiFlowNodeId"]);
        const op = str(x["apiOperationId"]);
        return [{ action, ...(screen && screens.has(screen) ? { uiFlowNodeId: screen } : {}), ...(op && opIds.has(op) ? { apiOperationId: op } : {}) }];
      }),
      expectedOutcomes,
      testData: asArray(t["testData"]).flatMap((d) => {
        const x = asRecord(d);
        const name = x && str(x["name"]);
        return x && name ? [{ name, description: str(x["description"]) ?? "", ...(str(x["example"]) ? { example: str(x["example"])! } : {}) }] : [];
      }),
      uiFlowNodeIds,
      figmaNodeIds: [...new Set(uiFlowNodeIds.flatMap((s) => screens.get(s)?.figmaNodeIds ?? []))],
      apiOperationIds: known<string>(strings(t["apiOperationIds"]), opIds, "operations", id),
      level: LEVELS.has(str(t["level"]) as AcceptanceTestCase["level"]) ? (str(t["level"]) as AcceptanceTestCase["level"]) : "e2e",
      automationStatus: "planned",
      sourceRefs: requirements.filter((r) => requirementIds.includes(r.id)).flatMap((r) => r.sourceRefs),
    });
  }

  const testabilityGaps: TestabilityGap[] = [];
  for (const item of asArray(root["testabilityGaps"])) {
    const g = asRecord(item);
    const requirementId = g && str(g["requirementId"]);
    const message = g && str(g["message"]);
    if (!g || !requirementId || !message || !reqIds.has(requirementId)) continue;
    const reason = GAP_REASONS.has(str(g["reason"]) as TestabilityGap["reason"]) ? (str(g["reason"]) as TestabilityGap["reason"]) : "ambiguous";
    testabilityGaps.push({ id: `TGAP-${pad(testabilityGaps.length + 1)}`, requirementId, reason, message, blocking: g["blocking"] !== false });
  }
  return { testCases, testabilityGaps: withUncovered(testabilityGaps, requirements, testCases), warnings };
}

/** Built-in fallback: one E2E test case per acceptance criterion; requirements without one only get a case when they state an outcome. */
export function testDesignFromCriteria(requirements: BusinessRequirement[], criteria: AcceptanceCriterion[]): TestDesignResult {
  const testCases: AcceptanceTestCase[] = [];
  for (const req of requirements) {
    const own = criteria.filter((c) => c.requirementId === req.id);
    const sources = own.length
      ? own.map((c) => ({ given: c.given, when: c.when, then: c.then }))
      : req.outcomes.length
        ? [{ given: req.preconditions, when: req.actions, then: req.outcomes }]
        : [];
    sources.forEach((s, i) =>
      testCases.push({
        id: `TC-${req.id}-${pad(i + 1, 2)}`,
        requirementIds: [req.id],
        title: `${req.title}${sources.length > 1 ? ` (${i + 1})` : ""}`,
        preconditions: s.given.map((description) => ({ description })),
        steps: s.when.map((action) => ({ action })),
        expectedOutcomes: s.then.map((description) => ({ description, kind: "ui" as const })),
        testData: [],
        uiFlowNodeIds: [],
        figmaNodeIds: [],
        apiOperationIds: [],
        level: "e2e",
        automationStatus: "planned",
        sourceRefs: req.sourceRefs,
      }),
    );
  }
  return { testCases, testabilityGaps: withUncovered([], requirements, testCases), warnings: ["Test cases built from the acceptance criteria only (no UI flow or API mapping); marked as assumed"] };
}

function withUncovered(gaps: TestabilityGap[], requirements: BusinessRequirement[], testCases: AcceptanceTestCase[]): TestabilityGap[] {
  const out = [...gaps];
  for (const req of requirements) {
    if (testCases.some((t) => t.requirementIds.includes(req.id)) || out.some((g) => g.requirementId === req.id)) continue;
    out.push({ id: `TGAP-${pad(out.length + 1)}`, requirementId: req.id, reason: req.outcomes.length ? "ambiguous" : "missing_expected_outcome", message: "No test case could be designed for this requirement.", blocking: true });
  }
  return out;
}

export function buildTestPackage(input: {
  runId: string;
  baSnapshotId: string;
  readinessPackageId: string;
  requirements: BusinessRequirement[];
  testCases: AcceptanceTestCase[];
  testabilityGaps: TestabilityGap[];
}): AcceptanceTestCasePackage {
  const blocked = new Set(input.testabilityGaps.filter((g) => g.blocking).map((g) => g.requirementId));
  const withTests = input.requirements.filter((r) => input.testCases.some((t) => t.requirementIds.includes(r.id)));
  const testCases = input.testCases.map((t) => (t.requirementIds.every((r) => blocked.has(r)) ? { ...t, automationStatus: "blocked" as const } : t));
  return {
    version: 1,
    runId: input.runId,
    baSnapshotId: input.baSnapshotId,
    readinessPackageId: input.readinessPackageId,
    requirements: input.requirements,
    testCases,
    testabilityGaps: input.testabilityGaps,
    coverage: {
      totalRequirements: input.requirements.length,
      requirementsWithTests: withTests.length,
      automatableRequirements: withTests.filter((r) => !blocked.has(r.id)).length,
      blockedRequirements: blocked.size,
    },
    status: blocked.size ? "blocked" : input.testabilityGaps.length ? "ready_with_gaps" : "ready",
  };
}

export function renderTestDesignReport(pkg: AcceptanceTestCasePackage): string {
  const esc = escapeMarkdownText;
  const c = pkg.coverage;
  return [
    `# Acceptance test design: ${pkg.status}`,
    "",
    `- BA requirements: ${c.totalRequirements}, with test cases: ${c.requirementsWithTests}, automatable: ${c.automatableRequirements}, blocked: ${c.blockedRequirements}`,
    `- Test cases: ${pkg.testCases.length}`,
    "",
    "## Testability gaps",
    "",
    ...(pkg.testabilityGaps.length ? pkg.testabilityGaps.map((g) => `- ${g.blocking ? "**blocking** " : ""}\`${esc(g.requirementId)}\` *${g.reason}*: ${esc(g.message)}`) : ["- none"]),
    "",
    "## Test cases",
    "",
    "| Test case | Requirements | Level | Screens | API | Status |",
    "|---|---|---|---|---|---|",
    ...pkg.testCases.map((t) => `| \`${esc(t.id)}\` ${esc(t.title)} | ${t.requirementIds.map(esc).join(", ")} | ${t.level} | ${t.uiFlowNodeIds.map(esc).join(", ") || "—"} | ${t.apiOperationIds.map(esc).join(", ") || "—"} | ${t.automationStatus} |`),
  ].join("\n");
}

function unique(id: string, seen: Set<string>, warnings: string[], what: string): string {
  let out = id;
  if (seen.has(out)) {
    warnings.push(`Duplicate ${what} id ${id}; renamed`);
    let n = 2;
    while (seen.has(`${id}#${n}`)) n += 1;
    out = `${id}#${n}`;
  }
  seen.add(out);
  return out;
}

function pad(n: number, width = 3): string {
  return String(n).padStart(width, "0");
}
