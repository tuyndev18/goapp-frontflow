import type { AlignmentReadiness, AlignmentStatus, TraceabilityStatus } from "./status.js";
import type { SourceReference } from "./documents.js";

/** JSON Schema 2020-12 document (kept structural; validated at the edges). */
export type JsonSchema = { [key: string]: unknown };

/** Spec §12.1 A2 */
export interface BusinessRequirement {
  id: string;
  title: string;
  actor?: string;
  preconditions: string[];
  actions: string[];
  outcomes: string[];
  validations: string[];
  states: string[];
  errors: string[];
  sourceRefs: SourceReference[];
  /** 0..1 — lower when the parser had to infer structure from free-form Markdown. */
  confidence: number;
}

export interface ApiResponse {
  status: number;
  description?: string;
  /** Error code for non-2xx responses, e.g. ORDER_NOT_FOUND. */
  errorCode?: string;
  schema?: JsonSchema;
}

export interface ApiParameter {
  name: string;
  in: "path" | "query" | "header" | "body";
  type?: string;
  required: boolean;
}

/** Spec §12.1 A3 */
export interface ApiOperation {
  id: string;
  method: string;
  path: string;
  summary?: string;
  auth?: string;
  roles: string[];
  parameters: ApiParameter[];
  requestSchema?: JsonSchema;
  responses: ApiResponse[];
  sourceRefs: SourceReference[];
}

export interface DocumentIssue {
  id: string;
  severity: "error" | "warning" | "info";
  code:
    | "missing_id"
    | "duplicate_id"
    | "missing_actor"
    | "missing_action"
    | "missing_outcome"
    | "self_contradiction"
    | "not_verifiable"
    | "empty_document"
    | "unparseable_operation";
  message: string;
  requirementId?: string;
  operationId?: string;
  sourceRefs: SourceReference[];
}

export interface AlignmentFinding {
  kind: "missing_error" | "missing_role" | "missing_field" | "missing_operation" | "conflicting_value" | "unclear" | "assumption";
  message: string;
  /** Explicit uncertainty principle: anything inferred is flagged. */
  assumed: boolean;
}

/** Spec §12.1 A5/A6 */
export interface RequirementApiMapping {
  requirementId: string;
  apiOperationIds: string[];
  status: AlignmentStatus;
  /** 0..1 */
  confidence: number;
  rationale: string;
  findings: AlignmentFinding[];
  /** True when the requirement is mandatory for readiness. */
  blocking: boolean;
}

/** Spec §12.1 A7 */
export interface AcceptanceScenario {
  id: string;
  requirementId: string;
  title: string;
  kind: "happy_path" | "error" | "permission" | "validation" | "state";
  given: string[];
  when: string[];
  then: string[];
  apiOperationIds: string[];
  /** True when derived from assumptions rather than explicit statements. */
  assumed: boolean;
}

/** Spec §12.1 A8 */
export interface TraceabilityItem {
  requirementId: string;
  apiOperationIds: string[];
  figmaNodeIds: string[];
  sourceFiles: string[];
  testIds: string[];
  evidenceIds: string[];
  status: TraceabilityStatus;
}

/** Spec §12.2 */
export interface AlignmentPackage {
  version: 1;
  runId: string;
  sourceSnapshots: string[];
  requirements: BusinessRequirement[];
  operations: ApiOperation[];
  mappings: RequirementApiMapping[];
  scenarios: AcceptanceScenario[];
  traceability: TraceabilityItem[];
  issues: DocumentIssue[];
  summary: {
    covered: number;
    partial: number;
    missing: number;
    conflict: number;
    ambiguous: number;
    notRequired: number;
    assumed: number;
  };
  readiness: AlignmentReadiness;
}

/** Spec §12.3 — which assumptions the project allows to pass as ready_with_assumptions. */
export interface AlignmentPolicy {
  allowAssumptions: boolean;
  /** Requirement IDs that may stay non-blocking even when not covered. */
  optionalRequirementIds: string[];
}
