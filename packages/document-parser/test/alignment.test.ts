import type { AlignmentPackage, ApiOperation, BusinessRequirement, RequirementApiMapping } from "@frontflow/domain";
import { describe, expect, it } from "vitest";
import {
  buildAlignmentPackage,
  buildTraceabilityMatrix,
  classifyAlignment,
  computeReadiness,
  escapeMarkdownText,
  generateAcceptanceScenarios,
  linkTraceability,
  mapRequirementsToApi,
  renderGapReport,
  runAlignment,
  TraceabilityError,
} from "../src/index.js";
import { FIXED_TIME, fixture } from "./helpers.js";

function run(ba: string, api: string, policy?: { allowAssumptions: boolean; optionalRequirementIds: string[] }) {
  return runAlignment({
    runId: "run_test",
    ba: { content: fixture(ba), sourceUri: `fixtures/${ba}` },
    api: { content: fixture(api), sourceUri: `fixtures/${api}` },
    createdAt: FIXED_TIME,
    ...(policy ? { policy } : {}),
  });
}

const statuses = (pkg: AlignmentPackage) => Object.fromEntries(pkg.mappings.map((m) => [m.requirementId, m.status]));

describe("runAlignment — cancel-order fixture", () => {
  it("is fully covered and ready (Markdown contract)", () => {
    const { alignmentPackage: pkg, snapshots } = run("cancel-order/ba.md", "cancel-order/api.md");
    expect(snapshots.map((s) => s.type)).toEqual(["ba_markdown", "api_markdown"]);
    expect(pkg.sourceSnapshots).toEqual(snapshots.map((s) => s.id));
    expect(statuses(pkg)).toEqual({ "BA-ORDER-001": "covered", "BA-ORDER-002": "covered" });
    expect(pkg.mappings.map((m) => m.apiOperationIds)).toEqual([["cancelOrder"], ["getOrder"]]);
    expect(pkg.summary).toEqual({ covered: 2, partial: 0, missing: 0, conflict: 0, ambiguous: 0, notRequired: 0, assumed: 0 });
    expect(pkg.readiness).toBe("ready");
    expect(pkg.issues).toEqual([]);
  });

  it("gives the same statuses from the standalone OpenAPI contract", () => {
    const { alignmentPackage: pkg, snapshots } = run("cancel-order/ba.md", "cancel-order/openapi.yaml");
    expect(snapshots[1]!.type).toBe("openapi");
    expect(statuses(pkg)).toEqual({ "BA-ORDER-001": "covered", "BA-ORDER-002": "covered" });
    expect(pkg.readiness).toBe("ready");
  });

  it("generates stable acceptance scenarios, explicit Given/When/Then first", () => {
    const { alignmentPackage: pkg } = run("cancel-order/ba.md", "cancel-order/api.md");
    expect(pkg.scenarios.map((s) => `${s.id}:${s.kind}`)).toEqual([
      "AS-BA-ORDER-001-01:happy_path",
      "AS-BA-ORDER-001-02:happy_path",
      "AS-BA-ORDER-001-03:error",
      "AS-BA-ORDER-001-04:error",
      "AS-BA-ORDER-001-05:validation",
      "AS-BA-ORDER-002-01:error",
      "AS-BA-ORDER-002-02:happy_path",
      "AS-BA-ORDER-002-03:error",
    ]);
    expect(pkg.scenarios[0]).toMatchObject({ given: ["a PENDING order owned by the customer"], when: ["the customer confirms cancellation"] });
    expect(pkg.scenarios[2]).toMatchObject({ then: ["The action is rejected with error ORDER_NOT_FOUND (HTTP 404)", "The error is shown to the actor"], apiOperationIds: ["cancelOrder"] });
    expect(pkg.scenarios.every((s) => !s.assumed)).toBe(true);
    expect(pkg.traceability).toEqual([
      expect.objectContaining({ requirementId: "BA-ORDER-001", status: "unverified", testIds: pkg.scenarios.slice(0, 5).map((s) => s.id), evidenceIds: [] }),
      expect.objectContaining({ requirementId: "BA-ORDER-002", status: "unverified", apiOperationIds: ["getOrder"] }),
    ]);
  });
});

describe("runAlignment — order-conflicts fixture", () => {
  const result = run("order-conflicts/ba.md", "order-conflicts/api.md");
  const pkg = result.alignmentPackage;
  const mapping = (id: string) => pkg.mappings.find((m) => m.requirementId === id)!;

  it("classifies every gap type", () => {
    expect(statuses(pkg)).toEqual({
      "BA-ORDER-001": "conflict",
      "BA-ORDER-002": "missing",
      "BA-ORDER-003": "partial",
      "BA-ORDER-004": "conflict",
      "BA-ORDER-005": "not_required",
      "BA-AUTO-001": "ambiguous",
    });
    expect(pkg.summary).toEqual({ covered: 0, partial: 1, missing: 1, conflict: 2, ambiguous: 1, notRequired: 1, assumed: 0 });
    expect(pkg.readiness).toBe("not_ready");
  });

  it("explains each finding", () => {
    expect(mapping("BA-ORDER-001").findings).toEqual([
      { kind: "conflicting_value", message: "BA result state CANCELLED conflicts with API value CANCELED.", assumed: false },
    ]);
    expect(mapping("BA-ORDER-002").findings.map((f) => f.kind)).toEqual(["missing_operation"]);
    expect(mapping("BA-ORDER-003")).toMatchObject({
      apiOperationIds: ["updateDeliveryAddress"],
      findings: [{ kind: "missing_error", assumed: false }],
    });
    expect(mapping("BA-ORDER-003").findings[0]!.message).toContain("ORDER_ALREADY_SHIPPED");
    expect(mapping("BA-ORDER-004").findings[0]).toMatchObject({ kind: "missing_role", assumed: false });
    expect(mapping("BA-ORDER-004").findings[0]!.message).toContain("Warehouse staff");
    expect(mapping("BA-ORDER-005")).toMatchObject({ apiOperationIds: [], findings: [] });
    expect(mapping("BA-AUTO-001").findings.map((f) => [f.kind, f.assumed])).toEqual([
      ["unclear", false],
      ["assumption", true],
    ]);
    for (const m of pkg.mappings) expect(m.rationale.length).toBeGreaterThan(10);
  });

  it("records the free-form requirement as a missing_id issue and blocks traceability", () => {
    expect(pkg.issues.map((i) => `${i.code}:${i.requirementId}`)).toEqual(["missing_id:BA-AUTO-001", "missing_outcome:BA-AUTO-001"]);
    const trace = Object.fromEntries(pkg.traceability.map((t) => [t.requirementId, t.status]));
    expect(trace).toEqual({
      "BA-ORDER-001": "blocked",
      "BA-ORDER-002": "blocked",
      "BA-ORDER-003": "unverified",
      "BA-ORDER-004": "blocked",
      "BA-ORDER-005": "unverified",
      "BA-AUTO-001": "blocked",
    });
  });

  it("creates permission scenarios for roles the API does not allow", () => {
    const permission = pkg.scenarios.filter((s) => s.requirementId === "BA-ORDER-004" && s.kind === "permission");
    expect(permission.map((s) => s.title)).toEqual([
      "Warehouse staff marks an order as shipped — Customer is not allowed",
      "Warehouse staff marks an order as shipped — Support agent is not allowed",
    ]);
    expect(pkg.scenarios.filter((s) => s.requirementId === "BA-ORDER-005" && s.kind === "permission")).toEqual([]);
    expect(pkg.scenarios.filter((s) => s.requirementId === "BA-AUTO-001").every((s) => s.assumed)).toBe(true);
  });

  it("is deterministic across runs", () => {
    const again = run("order-conflicts/ba.md", "order-conflicts/api.md");
    expect(again.alignmentPackage).toEqual(pkg);
    expect(again.links).toEqual(result.links);
    expect(renderGapReport(again.alignmentPackage)).toBe(renderGapReport(pkg));
  });

  it("allows optional requirements to be excluded from readiness", () => {
    const optional = ["BA-ORDER-001", "BA-ORDER-002", "BA-ORDER-003", "BA-ORDER-004", "BA-AUTO-001"];
    const relaxed = run("order-conflicts/ba.md", "order-conflicts/api.md", { allowAssumptions: false, optionalRequirementIds: optional });
    expect(relaxed.alignmentPackage.mappings.filter((m) => m.blocking).map((m) => m.requirementId)).toEqual(["BA-ORDER-005"]);
    expect(relaxed.alignmentPackage.readiness).toBe("ready");
  });
});

describe("source references", () => {
  for (const [ba, api] of [
    ["cancel-order/ba.md", "cancel-order/api.md"],
    ["cancel-order/ba.md", "cancel-order/openapi.yaml"],
    ["order-conflicts/ba.md", "order-conflicts/api.md"],
  ] as const) {
    it(`every requirement and operation points at valid lines (${ba} + ${api})`, () => {
      const { alignmentPackage: pkg, snapshots } = run(ba, api);
      const lineCount = new Map(snapshots.map((s) => [s.id, s.metadata.lineCount as number]));
      const items = [...pkg.requirements, ...pkg.operations];
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.sourceRefs.length).toBeGreaterThan(0);
        for (const ref of item.sourceRefs) {
          expect(lineCount.has(ref.snapshotId)).toBe(true);
          expect(ref.lineStart).toBeGreaterThanOrEqual(1);
          expect(ref.lineEnd).toBeGreaterThanOrEqual(ref.lineStart);
          expect(ref.lineEnd).toBeLessThanOrEqual(lineCount.get(ref.snapshotId)!);
        }
      }
      for (const issue of pkg.issues) expect(issue.sourceRefs.length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Classification edge cases on hand-built inputs
// ---------------------------------------------------------------------------

const ref = { snapshotId: "snap_x", lineStart: 1, lineEnd: 1 };

function req(overrides: Partial<BusinessRequirement>): BusinessRequirement {
  return {
    id: "BA-1",
    title: "Customer cancels an order",
    actor: "Customer",
    preconditions: [],
    actions: ["Cancel the order"],
    outcomes: ["Order status becomes CANCELLED"],
    validations: [],
    states: ["CANCELLED"],
    errors: [],
    sourceRefs: [ref],
    confidence: 0.95,
    ...overrides,
  };
}

function op(overrides: Partial<ApiOperation>): ApiOperation {
  return {
    id: "cancelOrder",
    method: "POST",
    path: "/orders/{orderId}/cancel",
    roles: ["CUSTOMER"],
    parameters: [],
    responses: [{ status: 200, schema: { type: "object", properties: { status: { type: "string", const: "CANCELLED" } } } }],
    sourceRefs: [ref],
    ...overrides,
  };
}

function classify(requirements: BusinessRequirement[], operations: ApiOperation[]) {
  return classifyAlignment(requirements, operations, mapRequirementsToApi(requirements, operations));
}

describe("classifyAlignment", () => {
  it("prefers explicit references over heuristics", () => {
    const requirement = req({ title: "Customer abandons a basket", actions: ["See refundOrder"], outcomes: ["Basket is ABANDONED"], states: [] });
    const links = mapRequirementsToApi([requirement], [op({}), op({ id: "refundOrder", path: "/orders/{orderId}/refund" })]);
    expect(links).toEqual([expect.objectContaining({ operationId: "refundOrder", explicit: true, score: 1 })]);
  });

  it("marks mid-score inferred mappings as assumed and flags every finding", () => {
    const requirement = req({ title: "Customer views an order", actions: ["Open it"], outcomes: ["Order summary is displayed"], states: [] });
    const [mapping] = classify([requirement], [op({ id: "getOrder", method: "GET", path: "/orders/{orderId}", responses: [{ status: 200 }] })]);
    expect(mapping).toMatchObject({ status: "assumed", apiOperationIds: ["getOrder"] });
    expect(mapping!.findings.every((f) => f.assumed)).toBe(true);
    expect(mapping!.findings[0]!.kind).toBe("assumption");
  });

  it("treats unspecified roles as partial and an open status field as an assumption", () => {
    const [unspecified] = classify([req({})], [op({ roles: [] })]);
    expect(unspecified).toMatchObject({ status: "partial", findings: [{ kind: "missing_role" }] });
    const [publicOp] = classify([req({})], [op({ roles: [], auth: "none" })]);
    expect(publicOp!.status).toBe("covered");
    const [open] = classify([req({})], [op({ responses: [{ status: 200, schema: { type: "object", properties: { status: { type: "string" } } } }] })]);
    expect(open).toMatchObject({ status: "assumed", findings: [{ kind: "assumption", assumed: true }] });
  });

  it("detects error-code spelling conflicts, missing states and ambiguous wording", () => {
    const [spelling] = classify(
      [req({ errors: ["ORDER_CANNOT_BE_CANCELLED"] })],
      [op({ responses: [...op({}).responses, { status: 409, errorCode: "ORDER_CANNOT_BE_CANCELED" }] })],
    );
    expect(spelling).toMatchObject({ status: "conflict", findings: [{ kind: "conflicting_value" }] });
    const [stateMissing] = classify([req({ outcomes: ["Order status becomes ARCHIVED"], states: ["ARCHIVED"] })], [op({})]);
    expect(stateMissing).toMatchObject({ status: "partial", findings: [{ kind: "missing_field" }] });
    const [vague] = classify([req({ outcomes: ["Order status becomes CANCELLED, maybe"] })], [op({})]);
    expect(vague!.status).toBe("ambiguous");
  });

  it("recognises FE-only markers in English and Vietnamese", () => {
    const en = req({ id: "BA-2", title: "Sort the table (UI only)" });
    const vi = req({ id: "BA-3", title: "Lọc danh sách", actions: ["Chọn bộ lọc — chỉ FE, không cần API"] });
    expect(classify([en, vi], [op({})]).map((m) => m.status)).toEqual(["not_required", "not_required"]);
  });
});

describe("readiness and traceability", () => {
  const mappingOf = (status: RequirementApiMapping["status"], blocking = true): RequirementApiMapping => ({
    requirementId: `BA-${status}`,
    apiOperationIds: [],
    status,
    confidence: 0.9,
    rationale: "",
    findings: status === "assumed" ? [{ kind: "assumption", message: "x", assumed: true }] : [],
    blocking,
  });
  const strict = { allowAssumptions: false, optionalRequirementIds: [] };
  const lenient = { allowAssumptions: true, optionalRequirementIds: [] };

  it("applies spec §12.3 readiness rules", () => {
    expect(computeReadiness([mappingOf("covered"), mappingOf("not_required")], [], strict)).toBe("ready");
    expect(computeReadiness([mappingOf("covered"), mappingOf("assumed")], [], lenient)).toBe("ready_with_assumptions");
    expect(computeReadiness([mappingOf("covered"), mappingOf("assumed")], [], strict)).toBe("not_ready");
    for (const status of ["missing", "conflict", "ambiguous", "partial"] as const) {
      expect(computeReadiness([mappingOf(status)], [], lenient)).toBe("not_ready");
      expect(computeReadiness([mappingOf(status, false)], [], lenient)).toBe("ready");
    }
    const errorIssue = { id: "iss", severity: "error" as const, code: "duplicate_id" as const, message: "dup", sourceRefs: [ref] };
    expect(computeReadiness([mappingOf("covered")], [errorIssue], lenient)).toBe("not_ready");
    const pkg = buildAlignmentPackage({
      runId: "r",
      snapshots: ["snap_a"],
      requirements: [],
      operations: [],
      issues: [errorIssue, errorIssue],
      mappings: [mappingOf("covered"), mappingOf("assumed")],
      scenarios: [],
      traceability: [],
      policy: lenient,
    });
    expect(pkg.issues).toHaveLength(1);
    expect(pkg.summary).toMatchObject({ covered: 1, assumed: 1 });
    expect(pkg.readiness).toBe("not_ready");
  });

  it("never marks an item verified without evidence", () => {
    const requirements = [req({ id: "BA-1" })];
    const mappings = [mappingOf("assumed")].map((m) => ({ ...m, requirementId: "BA-1" }));
    const scenarios = generateAcceptanceScenarios(requirements, mappings);
    const items = buildTraceabilityMatrix(requirements, mappings, scenarios);
    expect(items[0]).toMatchObject({ status: "assumed", testIds: ["AS-BA-1-01"], figmaNodeIds: [], sourceFiles: [], evidenceIds: [] });
    expect(scenarios[0]!.assumed).toBe(true);

    expect(() => linkTraceability(items, { requirementId: "BA-1", verified: true })).toThrow(TraceabilityError);
    expect(() => linkTraceability(items, { requirementId: "BA-404", sourceFiles: ["a.ts"] })).toThrow(TraceabilityError);
    const linked = linkTraceability(items, { requirementId: "BA-1", sourceFiles: ["src/Cancel.tsx"], figmaNodeIds: ["1:2"] });
    expect(linked[0]).toMatchObject({ status: "assumed", sourceFiles: ["src/Cancel.tsx"], figmaNodeIds: ["1:2"] });
    expect(items[0]!.sourceFiles).toEqual([]);
    const verified = linkTraceability(linked, { requirementId: "BA-1", evidenceIds: ["ev_1"], verified: true });
    expect(verified[0]).toMatchObject({ status: "verified", evidenceIds: ["ev_1"] });
  });
});

describe("renderGapReport", () => {
  it("renders summary, findings with source refs, issues and a labelled assumptions section", () => {
    const { alignmentPackage, snapshots } = run("order-conflicts/ba.md", "order-conflicts/api.md");
    const report = renderGapReport(alignmentPackage, { snapshots });
    expect(report).toContain("# Gap & Conflict Report");
    expect(report).toContain("| conflict | 2 |");
    expect(report).toContain("Readiness: **NOT READY**");
    expect(report).toContain("- Source: ba.md:L10-L17");
    expect(report).toContain("## Assumptions (inferred — not stated in the documents)");
    expect(report).toMatch(/assumption \[ASSUMED\]: Mapping to listOrders/);
  });

  it("neutralizes HTML and Markdown injection from uploaded documents", () => {
    const ba = [
      "### BA-XSS-001 — <script>alert(1)</script> [click](javascript:alert(1)) | col",
      "- Actor: <img src=x onerror=alert(1)>",
      "- Action: Do it",
      "- Result: Item is DONE",
    ].join("\n");
    const api = "## POST /items/{id}/done\n- Operation ID: markDone\n- Allowed roles: ADMIN\n";
    const { alignmentPackage } = runAlignment({ runId: "<b>run</b>", ba: { content: ba }, api: { content: api }, createdAt: FIXED_TIME });
    const report = renderGapReport(alignmentPackage);
    expect(report).not.toMatch(/<script|<img|<b>/i);
    expect(report).not.toContain("javascript:");
    expect(report).toContain("&lt;script&gt;");
    expect(report).toContain("- Actor: &lt;img src=x onerror=alert(1)&gt;");
    expect(report).toContain("\\| col");
    expect(escapeMarkdownText("[x](javascript:y) ![i](u)")).toBe("\\[x\\](javascript:y) \\!\\[i\\](u)");
    expect(escapeMarkdownText("a\n# b `c` *d*")).toBe("a \\# b \\`c\\` \\*d\\*");
  });
});
