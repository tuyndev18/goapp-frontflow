import type { NodeRunStatus, WorkflowRunStatus } from "./status.js";

/** Spec §17.2 */
export interface RetryPolicy {
  maxAttempts: number;
  backoff: "none" | "linear" | "exponential";
  /** Error codes that may be retried. Empty = nothing is retried automatically. */
  retryableErrors: string[];
  /** Base delay for linear/exponential backoff. */
  baseDelayMs?: number;
}

/** Error codes that must never be retried automatically (spec §17.2). */
export const NON_RETRYABLE_ERRORS = [
  "PERMISSION_DENIED",
  "DOCUMENT_CONFLICT",
  "DESTRUCTIVE_APPROVAL_REQUIRED",
  "RETRY_BUDGET_EXHAUSTED",
  "CHECKPOINT_INVALIDATED",
  "RATE_LIMITED",
] as const;

export interface WorkflowRun {
  id: string;
  projectId: string;
  workflowId: string;
  workflowVersion: number;
  status: WorkflowRunStatus;
  traceId: string;
  /** SourceSnapshot ids + git base SHA the run is pinned to (spec §3.4). */
  inputs: {
    snapshotIds: string[];
    gitBaseSha?: string;
    [key: string]: unknown;
  };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: { code: string; message: string };
}

export interface NodeRun {
  id: string;
  workflowRunId: string;
  nodeId: string;
  nodeType: string;
  nodeVersion: number;
  status: NodeRunStatus;
  attempt: number;
  idempotencyKey?: string;
  inputHash?: string;
  output?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
  /** Label shown on waiting nodes, e.g. "waiting for A.ALIGN". */
  waitingOn?: string[];
  /** True when the node output relies on assumptions (spec §20.2 "Assumed"). */
  assumed?: boolean;
  blockerSummary?: string;
  /**
   * What the handler keeps for its next attempt (e.g. the AI session to resume): it survives
   * retries, pauses and app restarts, and is dropped when the node is reset to run from scratch.
   */
  resumeState?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
}
