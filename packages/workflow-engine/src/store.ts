import { TERMINAL_RUN_STATUSES } from "@frontflow/domain";
import type { NodeRun, RunStore, WorkflowRun } from "@frontflow/domain";

export type StoredEvent = Parameters<RunStore["appendEvent"]>[0];

/** RunStore kept in process memory. Values are deep-copied on the way in and out. */
export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly nodeRuns = new Map<string, Map<string, NodeRun>>();
  private readonly events: StoredEvent[] = [];
  /** idempotencyKey -> last passed output, insertion ordered so the newest wins. */
  private readonly cache = new Map<string, { output: unknown; assumed?: boolean }>();

  saveRun(run: WorkflowRun): void {
    this.runs.set(run.id, structuredClone(run));
  }

  getRun(runId: string): WorkflowRun | undefined {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  listRuns(): WorkflowRun[] {
    return [...this.runs.values()].map((r) => structuredClone(r));
  }

  listActiveRuns(): WorkflowRun[] {
    return this.listRuns().filter((r) => !TERMINAL_RUN_STATUSES.has(r.status));
  }

  saveNodeRun(nodeRun: NodeRun): void {
    let byId = this.nodeRuns.get(nodeRun.workflowRunId);
    if (!byId) {
      byId = new Map();
      this.nodeRuns.set(nodeRun.workflowRunId, byId);
    }
    byId.set(nodeRun.id, structuredClone(nodeRun));
    if (nodeRun.status === "passed" && nodeRun.idempotencyKey) {
      this.cache.delete(nodeRun.idempotencyKey);
      this.cache.set(
        nodeRun.idempotencyKey,
        structuredClone(nodeRun.assumed === undefined ? { output: nodeRun.output } : { output: nodeRun.output, assumed: nodeRun.assumed }),
      );
    }
  }

  listNodeRuns(runId: string): NodeRun[] {
    return [...(this.nodeRuns.get(runId)?.values() ?? [])].map((n) => structuredClone(n));
  }

  getCachedOutput(idempotencyKey: string): { output: unknown; assumed?: boolean } | undefined {
    const hit = this.cache.get(idempotencyKey);
    return hit ? structuredClone(hit) : undefined;
  }

  appendEvent(event: StoredEvent): void {
    this.events.push(structuredClone(event));
  }

  listEvents(runId?: string): StoredEvent[] {
    const events = runId === undefined ? this.events : this.events.filter((e) => e.workflowRunId === runId);
    return events.map((e) => structuredClone(e));
  }
}
