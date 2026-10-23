import type { ApiOperation, BusinessRequirement } from "./alignment.js";
import type { SourceReference } from "./documents.js";
import type { FeReadiness, ReadinessStatus } from "./status.js";

/**
 * Workflow A — FE Readiness: Figma × API Contract (spec §12) and
 * Workflow C — BA-driven test design (spec §14). The Figma scope and the API
 * contract decide whether a feature can be implemented; the BA specification is
 * only the test oracle.
 */

export interface UiAction {
  id: string;
  label: string;
  /** What the user does: click, submit, input, navigate, … */
  trigger: string;
  /** Figma node the action starts from, when known. */
  figmaNodeId?: string;
}

export interface UiState {
  id: string;
  name: string;
  kind: "default" | "loading" | "empty" | "error" | "success" | "disabled" | "permission" | "validation" | "other";
  /** True when the design has a frame/variant for it; false when only implied. */
  designed: boolean;
  figmaNodeId?: string;
}

export interface UiTransition {
  from: string;
  to: string;
  actionId?: string;
}

/** Spec §12.1 A2 */
export interface UiFlowNode {
  id: string;
  name: string;
  kind: "screen" | "dialog" | "component" | "interaction";
  figmaNodeIds: string[];
  actions: UiAction[];
  states: UiState[];
  transitions: UiTransition[];
  sourceRefs: SourceReference[];
  /** 0..1 */
  confidence: number;
}

/** Spec §12.1 A4 */
export interface UiDataRequirement {
  id: string;
  uiFlowNodeId: string;
  kind: "query" | "mutation" | "validation" | "state" | "permission";
  description: string;
  requiredFields: string[];
  expectedOutcomes: string[];
  sourceRefs: SourceReference[];
}

/** Spec §12.1 A5/A6 */
export interface UiApiMapping {
  id: string;
  uiDataRequirementId: string;
  apiOperationIds: string[];
  /** UI field → API field (dot path), e.g. { "orderStatus": "response.status" }. */
  fieldMappings: Record<string, string>;
  coveredOutcomes: string[];
  uncoveredOutcomes: string[];
  status: ReadinessStatus;
  /** 0..1 */
  confidence: number;
  rationale: string;
  /** True when this requirement must be met for the feature to be ready. */
  blocking: boolean;
}

/** Spec §12.1 A7: issues split by the owner who has to fix them. */
export interface ReadinessGap {
  id: string;
  kind: "api_gap" | "design_gap" | "mapping_gap" | "conflict";
  owner: "backend" | "design" | "frontend" | "backend_and_design";
  message: string;
  uiDataRequirementId?: string;
  uiFlowNodeId?: string;
  apiOperationIds: string[];
  blocking: boolean;
}

/** Spec §12.1 A8 */
export interface UiApiTraceabilityItem {
  uiFlowNodeId: string;
  figmaNodeIds: string[];
  uiDataRequirementIds: string[];
  apiOperationIds: string[];
  sourceFiles: string[];
  testIds: string[];
  evidenceIds: string[];
  status: "unverified" | "verified" | "assumed" | "blocked";
}

/** Spec §12.2 */
export interface FeReadinessPackage {
  version: 1;
  runId: string;
  sourceSnapshots: string[];
  uiFlow: UiFlowNode[];
  uiDataRequirements: UiDataRequirement[];
  operations: ApiOperation[];
  mappings: UiApiMapping[];
  gaps: ReadinessGap[];
  traceability: UiApiTraceabilityItem[];
  summary: {
    ready: number;
    partial: number;
    missingApi: number;
    missingDesign: number;
    conflict: number;
    ambiguous: number;
    feOnly: number;
    assumed: number;
  };
  readiness: FeReadiness;
}

export interface TestPrecondition {
  description: string;
  /** Provider state or fixture that sets it up, when known. */
  setup?: string;
}

export interface TestStep {
  action: string;
  uiFlowNodeId?: string;
  apiOperationId?: string;
}

export interface ExpectedOutcome {
  description: string;
  kind: "ui" | "api" | "navigation" | "data";
}

export interface TestDataRequirement {
  name: string;
  description: string;
  example?: string;
}

/** Spec §14.1 */
export interface AcceptanceTestCase {
  id: string;
  requirementIds: string[];
  title: string;
  preconditions: TestPrecondition[];
  steps: TestStep[];
  expectedOutcomes: ExpectedOutcome[];
  testData: TestDataRequirement[];
  uiFlowNodeIds: string[];
  figmaNodeIds: string[];
  apiOperationIds: string[];
  level: "component" | "integration" | "e2e";
  automationStatus: "planned" | "generated" | "executed" | "manual" | "blocked";
  sourceRefs: SourceReference[];
}

/** A business scenario that cannot be tested yet, and why (spec §14.1). */
export interface TestabilityGap {
  id: string;
  requirementId: string;
  reason: "missing_design" | "missing_api" | "missing_test_data" | "missing_expected_outcome" | "ambiguous";
  message: string;
  blocking: boolean;
}

/** Spec §14.2 */
export interface AcceptanceTestCasePackage {
  version: 1;
  runId: string;
  baSnapshotId: string;
  readinessPackageId: string;
  requirements: BusinessRequirement[];
  testCases: AcceptanceTestCase[];
  testabilityGaps: TestabilityGap[];
  coverage: {
    totalRequirements: number;
    requirementsWithTests: number;
    automatableRequirements: number;
    blockedRequirements: number;
  };
  status: "ready" | "ready_with_gaps" | "blocked";
}

/** Spec §14.3: where a failing acceptance test points. */
export type TestFailureCause = "specification_gap" | "design_gap" | "api_gap" | "test_generation_gap" | "implementation_gap";

/** Spec §14.4 */
export interface TestTraceabilityItem {
  requirementId: string;
  testCaseIds: string[];
  uiFlowNodeIds: string[];
  figmaNodeIds: string[];
  apiOperationIds: string[];
  sourceFiles: string[];
  testIds: string[];
  evidenceIds: string[];
  status: "untested" | "passed" | "failed" | "assumed" | "blocked";
}
