import type { NodeRun, WorkflowRun } from "./workflow.js";

/**
 * Persistence contract used by the workflow engine. The engine ships an
 * in-memory implementation; @frontflow/persistence provides the SQLite one.
 * All methods may be sync or async.
 */
export interface RunStore {
  saveRun(run: WorkflowRun): void | Promise<void>;
  getRun(runId: string): WorkflowRun | undefined | Promise<WorkflowRun | undefined>;
  /** Runs whose status is not terminal (queued, running, waiting, paused) — used for restart recovery. */
  listActiveRuns(): WorkflowRun[] | Promise<WorkflowRun[]>;
  saveNodeRun(nodeRun: NodeRun): void | Promise<void>;
  listNodeRuns(runId: string): NodeRun[] | Promise<NodeRun[]>;
  /** Most recent passed node run output for an idempotency key (read-only node cache, spec §17.3). */
  getCachedOutput(idempotencyKey: string): { output: unknown; assumed?: boolean } | undefined | Promise<{ output: unknown; assumed?: boolean } | undefined>;
  /** Engine/agent events, already redacted by the caller. */
  appendEvent(event: { id: string; type: string; timestamp: string; workflowRunId: string; nodeRunId?: string; sessionId?: string; traceId: string; payload: unknown }): void | Promise<void>;
}
