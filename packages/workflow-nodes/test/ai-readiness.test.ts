import { describe, expect, it } from "vitest";
import type { ApiOperation, BusinessRequirement } from "@frontflow/domain";
import {
  buildReadinessPackage,
  buildReadinessVerdict,
  buildTestPackage,
  computeFeReadiness,
  heuristicReadiness,
  ingestReadiness,
  ingestTestDesign,
  ingestUiFlow,
  renderReadinessReport,
  testDesignFromCriteria,
  uiFlowFromLayers,
} from "../src/ai-readiness.js";

const uiFlowAnswer = {
  screens: [
    {
      id: "SCR-order",
      name: "Order detail",
      kind: "screen",
      figmaNodeIds: ["1:1"],
      actions: [{ id: "ACT-cancel", label: "Cancel order", trigger: "click", figmaNodeId: "1:5" }],
      states: [
        { id: "ST-default", name: "default", kind: "default", designed: true },
        { id: "ST-error", name: "cannot cancel", kind: "error", designed: false },
        { name: "", kind: "loading" },
      ],
      transitions: [{ from: "SCR-order", to: "SCR-confirm", actionId: "ACT-cancel" }],
      confidence: 0.9,
    },
    { id: "SCR-confirm", name: "Confirm dialog", kind: "dialog", figmaNodeIds: ["1:9"], confidence: 0.8 },
    { id: "SCR-order", name: "duplicate" },
  ],
  requirements: [
    { id: "UIR-001", uiFlowNodeId: "SCR-order", kind: "query", description: "Show order status", requiredFields: ["status"], expectedOutcomes: ["status shown"] },
    { id: "UIR-002", uiFlowNodeId: "SCR-confirm", kind: "mutation", description: "Cancel the order", requiredFields: ["orderId"], expectedOutcomes: ["CANCELLED", "ORDER_CANNOT_BE_CANCELLED"] },
    { id: "UIR-003", uiFlowNodeId: "SCR-ghost", kind: "query", description: "nowhere" },
  ],
};

const operations: ApiOperation[] = [
  { id: "getOrder", method: "GET", path: "/orders/{orderId}", roles: [], parameters: [], responses: [{ status: 200 }], sourceRefs: [] },
  { id: "cancelOrder", method: "POST", path: "/orders/{orderId}/cancel", roles: ["CUSTOMER"], parameters: [], responses: [{ status: 200 }, { status: 409, errorCode: "ORDER_CANNOT_BE_CANCELLED" }], sourceRefs: [] },
];

describe("UI flow ingestion", () => {
  it("keeps valid screens, states and needs, and drops needs on unknown screens", () => {
    const { uiFlow, uiDataRequirements, warnings } = ingestUiFlow(uiFlowAnswer);
    expect(uiFlow.map((n) => n.id)).toEqual(["SCR-order", "SCR-confirm", "SCR-order#2"]);
    expect(uiFlow[0]?.states.map((s) => [s.name, s.designed])).toEqual([
      ["default", true],
      ["cannot cancel", false],
    ]);
    expect(uiFlow[0]?.transitions).toEqual([{ from: "SCR-order", to: "SCR-confirm", actionId: "ACT-cancel" }]);
    expect(uiDataRequirements.map((r) => r.id)).toEqual(["UIR-001", "UIR-002"]);
    expect(warnings.some((w) => w.includes("SCR-ghost"))).toBe(true);
    expect(warnings.some((w) => w.includes("Duplicate screen"))).toBe(true);
  });

  it("rejects an answer without screens and falls back to the selected layers", () => {
    expect(() => ingestUiFlow({ screens: [] })).toThrow(/no screens/);
    const fallback = uiFlowFromLayers([{ nodeId: "1:1", name: "Order" }]);
    expect(fallback.uiFlow[0]).toMatchObject({ name: "Order", figmaNodeIds: ["1:1"], confidence: 0.2 });
    expect(fallback.uiDataRequirements).toEqual([]);
  });
});

describe("FE readiness mapping", () => {
  const { uiFlow, uiDataRequirements } = ingestUiFlow(uiFlowAnswer);

  it("validates operation ids, classifies every UI need and adds owner-specific gaps", () => {
    const result = ingestReadiness(
      {
        summary: "Cancel is covered except one design state.",
        mappings: [
          { uiDataRequirementId: "UIR-001", apiOperationIds: ["getOrder", "ghostOp"], status: "ready", fieldMappings: { status: "response.status", bad: 3 }, rationale: "api.md L3" },
          { uiDataRequirementId: "UIR-002", apiOperationIds: ["cancelOrder"], status: "missing_design", uncoveredOutcomes: ["ORDER_CANNOT_BE_CANCELLED"], rationale: "no error state in Figma" },
          { uiDataRequirementId: "UIR-404", status: "ready" },
        ],
        gaps: [{ kind: "design_gap", message: "409 has no error state", uiDataRequirementId: "UIR-002", apiOperationIds: ["cancelOrder"], blocking: true }],
      },
      uiDataRequirements,
      operations,
    );
    expect(result.mappings.map((m) => [m.uiDataRequirementId, m.status, m.apiOperationIds])).toEqual([
      ["UIR-001", "ready", ["getOrder"]],
      ["UIR-002", "missing_design", ["cancelOrder"]],
    ]);
    expect(result.mappings[0]?.fieldMappings).toEqual({ status: "response.status" });
    expect(result.warnings.some((w) => w.includes("ghostOp"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("UIR-404"))).toBe(true);
    // The AI already reported the design gap: no duplicate, and the owner is design.
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ kind: "design_gap", owner: "design", uiFlowNodeId: "SCR-confirm", blocking: true });

    const pkg = buildReadinessPackage({ runId: "run1", sourceSnapshots: ["s1"], uiFlow, uiDataRequirements, operations, mappings: result.mappings, gaps: result.gaps, allowAssumptions: false });
    expect(pkg.readiness).toBe("not_ready");
    expect(pkg.summary).toMatchObject({ ready: 1, missingDesign: 1 });
    expect(pkg.traceability.find((t) => t.uiFlowNodeId === "SCR-confirm")?.status).toBe("blocked");
    expect(pkg.traceability.find((t) => t.uiFlowNodeId === "SCR-order")).toMatchObject({ status: "unverified", apiOperationIds: ["getOrder"] });

    const verdict = buildReadinessVerdict(pkg, "ai", result.summary);
    expect(verdict.score).toBe(50);
    expect(verdict.headline).toBe("1 of 2 UI needs ready to implement (50%) — 1 design gap");
    expect(verdict.issues.map((i) => i.status)).toEqual(["missing_design"]);
    expect(renderReadinessReport(pkg, verdict)).toContain("## Design gaps — owner: design");
  });

  it("never lets a data need be ready without an API operation from the contract", () => {
    const { mappings, gaps } = ingestReadiness({ mappings: [{ uiDataRequirementId: "UIR-002", apiOperationIds: [], status: "ready" }] }, uiDataRequirements, operations);
    expect(mappings.find((m) => m.uiDataRequirementId === "UIR-002")?.status).toBe("missing_api");
    // UIR-001 was not classified → ambiguous, and both get a gap for their owner.
    expect(mappings.find((m) => m.uiDataRequirementId === "UIR-001")?.status).toBe("ambiguous");
    expect(gaps.map((g) => [g.kind, g.owner])).toEqual([
      ["mapping_gap", "frontend"],
      ["api_gap", "backend"],
    ]);
  });

  it("applies the completion policy (spec §12.3)", () => {
    const ready = ingestReadiness(
      {
        mappings: [
          { uiDataRequirementId: "UIR-001", apiOperationIds: ["getOrder"], status: "ready" },
          { uiDataRequirementId: "UIR-002", apiOperationIds: ["cancelOrder"], status: "partial" },
        ],
      },
      uiDataRequirements,
      operations,
    );
    expect(computeFeReadiness(ready.mappings, ready.gaps, 2, false)).toBe("not_ready");
    expect(computeFeReadiness(ready.mappings, ready.gaps, 2, true)).toBe("ready_with_assumptions");
    expect(computeFeReadiness([], [], 0, true)).toBe("not_ready");
  });

  it("falls back to keyword heuristics that are never ready", () => {
    const { mappings } = heuristicReadiness(uiDataRequirements, operations);
    expect(mappings.every((m) => m.status !== "ready")).toBe(true);
    expect(mappings.find((m) => m.uiDataRequirementId === "UIR-002")).toMatchObject({ status: "assumed", apiOperationIds: ["cancelOrder"] });
  });
});

describe("BA-driven test design", () => {
  const { uiFlow, uiDataRequirements } = ingestUiFlow(uiFlowAnswer);
  const readiness = buildReadinessPackage({ runId: "run1", sourceSnapshots: [], uiFlow, uiDataRequirements, operations, mappings: [], gaps: [], allowAssumptions: false });
  const requirements: BusinessRequirement[] = [
    { id: "BA-1", title: "Customer cancels", preconditions: ["PENDING"], actions: ["Confirm"], outcomes: ["CANCELLED"], validations: [], states: [], errors: [], sourceRefs: [{ snapshotId: "ba", lineStart: 3, lineEnd: 9 }], confidence: 1 },
    { id: "BA-2", title: "Support cancels", preconditions: [], actions: [], outcomes: [], validations: [], states: [], errors: [], sourceRefs: [], confidence: 1 },
  ];

  it("grounds test cases in BA requirements, screens and operations", () => {
    const { testCases, testabilityGaps, warnings } = ingestTestDesign(
      {
        testCases: [
          {
            id: "TC-BA-1-01",
            requirementIds: ["BA-1", "BA-9"],
            title: "Customer cancels a pending order",
            preconditions: [{ description: "Order is PENDING", setup: "mock getOrder" }],
            steps: [{ action: "Click Cancel", uiFlowNodeId: "SCR-order" }, { action: "Confirm", uiFlowNodeId: "SCR-confirm", apiOperationId: "cancelOrder" }],
            expectedOutcomes: [{ description: "Status shows CANCELLED", kind: "ui" }],
            uiFlowNodeIds: ["SCR-order", "SCR-confirm", "SCR-x"],
            apiOperationIds: ["cancelOrder", "ghost"],
            level: "e2e",
          },
          { id: "TC-none", requirementIds: ["BA-404"], expectedOutcomes: [{ description: "x" }] },
          { id: "TC-no-outcome", requirementIds: ["BA-1"] },
        ],
        testabilityGaps: [{ requirementId: "BA-2", reason: "missing_design", message: "No screen for support agents", blocking: true }],
      },
      requirements,
      readiness,
    );
    expect(testCases).toHaveLength(1);
    expect(testCases[0]).toMatchObject({
      requirementIds: ["BA-1"],
      uiFlowNodeIds: ["SCR-order", "SCR-confirm"],
      figmaNodeIds: ["1:1", "1:9"],
      apiOperationIds: ["cancelOrder"],
      automationStatus: "planned",
    });
    expect(testCases[0]?.sourceRefs).toEqual(requirements[0]?.sourceRefs);
    expect(testabilityGaps).toEqual([{ id: "TGAP-001", requirementId: "BA-2", reason: "missing_design", message: "No screen for support agents", blocking: true }]);
    expect(warnings.some((w) => w.includes("TC-none"))).toBe(true);

    const pkg = buildTestPackage({ runId: "run1", baSnapshotId: "ba", readinessPackageId: "pkg", requirements, testCases, testabilityGaps });
    expect(pkg.status).toBe("blocked");
    expect(pkg.coverage).toEqual({ totalRequirements: 2, requirementsWithTests: 1, automatableRequirements: 1, blockedRequirements: 1 });
  });

  it("builds test cases from acceptance criteria and flags requirements without outcomes", () => {
    const { testCases, testabilityGaps } = testDesignFromCriteria(requirements, []);
    expect(testCases.map((t) => t.id)).toEqual(["TC-BA-1-01"]);
    expect(testCases[0]?.expectedOutcomes).toEqual([{ description: "CANCELLED", kind: "ui" }]);
    expect(testabilityGaps).toMatchObject([{ requirementId: "BA-2", reason: "missing_expected_outcome", blocking: true }]);
  });
});
