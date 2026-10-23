/** Spec §6.1 */
export const WORKFLOW_RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "test_design_pending",
  "paused",
  "completed",
  "completed_with_assumptions",
  "blocked",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  "completed",
  "completed_with_assumptions",
  "blocked",
  "failed",
  "cancelled",
  "timed_out",
]);

/** Spec §6.2 */
export const NODE_RUN_STATUSES = [
  "pending",
  "ready",
  "running",
  "waiting_for_dependency",
  "waiting_for_input",
  "retrying",
  "passed",
  "failed",
  "blocked",
  "skipped",
  "cancelled",
] as const;
export type NodeRunStatus = (typeof NODE_RUN_STATUSES)[number];

export const TERMINAL_NODE_STATUSES: ReadonlySet<NodeRunStatus> = new Set([
  "passed",
  "failed",
  "blocked",
  "skipped",
  "cancelled",
]);

/** Spec §6.3 */
export const ALIGNMENT_STATUSES = [
  "covered",
  "partial",
  "missing",
  "conflict",
  "ambiguous",
  "not_required",
  "assumed",
] as const;
export type AlignmentStatus = (typeof ALIGNMENT_STATUSES)[number];

/** Spec §6.3: FE readiness of one UI data/action requirement against the API contract. */
export const READINESS_STATUSES = [
  "ready",
  "partial",
  "missing_api",
  "missing_design",
  "conflict",
  "ambiguous",
  "fe_only",
  "assumed",
] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

/** Spec §12.3 */
export type FeReadiness = "ready" | "ready_with_assumptions" | "not_ready";

export type TraceabilityStatus = "unverified" | "verified" | "assumed" | "blocked";

export type AlignmentReadiness = "ready" | "ready_with_assumptions" | "not_ready";

/** Spec §15.1 */
export type VerificationLevel =
  | "fe_ready"
  | "test_designed"
  | "consumer_verified"
  | "provider_verified"
  | "contract_only"
  | "integration_verified"
  | "e2e_verified"
  | "business_verified";
