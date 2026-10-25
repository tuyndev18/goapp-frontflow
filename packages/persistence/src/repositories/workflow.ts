import { hashJson, type NodeRun, type RunStore, type WorkflowRun, type WorkflowRunStatus } from "@frontflow/domain";
import { redact } from "@frontflow/event-schema";
import type { SqlDriver, SqlParams, SqlRow } from "../driver.js";
import { boolToInt, compact, fromJson, fromJsonOr, intToBool, nowIso, nullable, num, str, toJson } from "../sql.js";

export interface StoredWorkflowDefinition<T = unknown> {
  id: string;
  version: number;
  name: string;
  definition: T;
  definitionHash: string;
  createdAt: string;
}

export class WorkflowDefinitionError extends Error {
  override name = "WorkflowDefinitionError";
}

/** Definitions are immutable per (id, version); re-saving identical content is a no-op. */
export class WorkflowDefinitionRepository {
  constructor(private readonly db: SqlDriver) {}

  save<T>(def: { id: string; version: number; name: string; definition: T; createdAt?: string }): StoredWorkflowDefinition<T> {
    const hash = hashJson(def.definition);
    return this.db.transaction(() => {
      const existing = this.get<T>(def.id, def.version);
      if (existing) {
        if (existing.definitionHash !== hash) {
          throw new WorkflowDefinitionError(
            `Workflow ${def.id}@${def.version} already exists with different content; bump the version`,
          );
        }
        return existing;
      }
      const createdAt = def.createdAt ?? nowIso();
      this.db
        .prepare(
          `INSERT INTO workflow_definitions (id, version, name, definition_json, definition_hash, created_at)
           VALUES (@id, @version, @name, @json, @hash, @createdAt)`,
        )
        .run({ id: def.id, version: def.version, name: def.name, json: JSON.stringify(def.definition), hash, createdAt });
      return { id: def.id, version: def.version, name: def.name, definition: structuredClone(def.definition), definitionHash: hash, createdAt };
    });
  }

  get<T = unknown>(id: string, version?: number): StoredWorkflowDefinition<T> | undefined {
    const row =
      version === undefined
        ? this.db.prepare("SELECT * FROM workflow_definitions WHERE id = @id ORDER BY version DESC LIMIT 1").get({ id })
        : this.db.prepare("SELECT * FROM workflow_definitions WHERE id = @id AND version = @version").get({ id, version });
    if (!row) return undefined;
    return {
      id: String(row.id),
      version: num(row.version),
      name: String(row.name),
      definition: JSON.parse(String(row.definition_json)) as T,
      definitionHash: String(row.definition_hash),
      createdAt: String(row.created_at),
    };
  }

  listVersions(id: string): number[] {
    return this.db
      .prepare("SELECT version FROM workflow_definitions WHERE id = @id ORDER BY version")
      .all({ id })
      .map((r) => num(r.version));
  }
}

export const ACTIVE_RUN_STATUSES: readonly WorkflowRunStatus[] = ["queued", "running", "waiting", "test_design_pending", "paused"];

export interface RunEventInput {
  id: string;
  type: string;
  timestamp: string;
  workflowRunId: string;
  nodeRunId?: string;
  sessionId?: string;
  traceId: string;
  confidence?: number;
  payload: unknown;
}

export interface StoredEvent extends RunEventInput {
  /** Monotonic insertion sequence; use as a cursor for incremental reads. */
  seq: number;
}

export interface ListRunsOptions {
  projectId?: string;
  statuses?: WorkflowRunStatus[];
  limit?: number;
}

export interface ListEventsOptions {
  /** Strictly after this ISO timestamp. */
  afterTimestamp?: string;
  /** Strictly after this sequence number (preferred cursor; stable for equal timestamps). */
  afterSeq?: number;
  types?: string[];
  nodeRunId?: string;
  sessionId?: string;
  limit?: number;
  /** With `limit`: return the most recent events (still in chronological order). */
  latest?: boolean;
}

/** SQLite-backed RunStore (spec §17, §18.1). All methods are synchronous. */
export class SqliteRunStore implements RunStore {
  constructor(private readonly db: SqlDriver) {}

  saveRun(run: WorkflowRun): void {
    this.db
      .prepare(
        `INSERT INTO workflow_runs (id, project_id, workflow_id, workflow_version, status, trace_id, inputs_json, error_json,
           created_at, started_at, finished_at, updated_at)
         VALUES (@id, @projectId, @workflowId, @workflowVersion, @status, @traceId, @inputs, @error,
           @createdAt, @startedAt, @finishedAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, workflow_version = excluded.workflow_version,
           trace_id = excluded.trace_id, inputs_json = excluded.inputs_json, error_json = excluded.error_json,
           started_at = excluded.started_at, finished_at = excluded.finished_at, updated_at = excluded.updated_at`,
      )
      .run({
        id: run.id,
        projectId: run.projectId,
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion,
        status: run.status,
        traceId: run.traceId,
        inputs: JSON.stringify(run.inputs),
        error: toJson(run.error),
        createdAt: run.createdAt,
        startedAt: nullable(run.startedAt),
        finishedAt: nullable(run.finishedAt),
        updatedAt: nowIso(),
      });
  }

  getRun(runId: string): WorkflowRun | undefined {
    const row = this.db.prepare("SELECT * FROM workflow_runs WHERE id = @runId").get({ runId });
    return row ? toRun(row) : undefined;
  }

  listActiveRuns(): WorkflowRun[] {
    return this.listRuns({ statuses: [...ACTIVE_RUN_STATUSES] }).reverse();
  }

  /** Newest first. */
  listRuns(options: ListRunsOptions = {}): WorkflowRun[] {
    const where: string[] = [];
    const params: SqlParams = {};
    if (options.projectId !== undefined) {
      where.push("project_id = @projectId");
      params.projectId = options.projectId;
    }
    if (options.statuses) {
      if (options.statuses.length === 0) return [];
      where.push(`status IN (${options.statuses.map((_, i) => `@s${i}`).join(", ")})`);
      options.statuses.forEach((s, i) => (params[`s${i}`] = s));
    }
    params.limit = options.limit ?? -1;
    const sql = `SELECT * FROM workflow_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, rowid DESC LIMIT @limit`;
    return this.db.prepare(sql).all(params).map(toRun);
  }

  /** Deletes the run and cascades node runs, events, alignment rows, results and checkpoints. */
  deleteRun(runId: string): boolean {
    return Number(this.db.prepare("DELETE FROM workflow_runs WHERE id = @runId").run({ runId }).changes) > 0;
  }

  saveNodeRun(nodeRun: NodeRun): void {
    this.db
      .prepare(
        `INSERT INTO node_runs (id, workflow_run_id, node_id, node_type, node_version, status, attempt, idempotency_key,
           input_hash, output_json, error_json, waiting_on_json, assumed, blocker_summary, resume_state_json, started_at, finished_at, seq, updated_at)
         VALUES (@id, @workflowRunId, @nodeId, @nodeType, @nodeVersion, @status, @attempt, @idempotencyKey,
           @inputHash, @output, @error, @waitingOn, @assumed, @blockerSummary, @resumeState, @startedAt, @finishedAt,
           (SELECT COALESCE(MAX(seq), 0) + 1 FROM node_runs WHERE workflow_run_id = @workflowRunId), @updatedAt)
         ON CONFLICT(id) DO UPDATE SET node_id = excluded.node_id, node_type = excluded.node_type,
           node_version = excluded.node_version, status = excluded.status, attempt = excluded.attempt,
           idempotency_key = excluded.idempotency_key, input_hash = excluded.input_hash, output_json = excluded.output_json,
           error_json = excluded.error_json, waiting_on_json = excluded.waiting_on_json, assumed = excluded.assumed,
           blocker_summary = excluded.blocker_summary, resume_state_json = excluded.resume_state_json,
           started_at = excluded.started_at, finished_at = excluded.finished_at, updated_at = excluded.updated_at`,
      )
      .run({
        id: nodeRun.id,
        workflowRunId: nodeRun.workflowRunId,
        nodeId: nodeRun.nodeId,
        nodeType: nodeRun.nodeType,
        nodeVersion: nodeRun.nodeVersion,
        status: nodeRun.status,
        attempt: nodeRun.attempt,
        idempotencyKey: nullable(nodeRun.idempotencyKey),
        inputHash: nullable(nodeRun.inputHash),
        output: toJson(nodeRun.output),
        error: toJson(nodeRun.error),
        waitingOn: toJson(nodeRun.waitingOn),
        assumed: boolToInt(nodeRun.assumed),
        blockerSummary: nullable(nodeRun.blockerSummary),
        resumeState: toJson(nodeRun.resumeState),
        startedAt: nullable(nodeRun.startedAt),
        finishedAt: nullable(nodeRun.finishedAt),
        updatedAt: nowIso(),
      });
  }

  getNodeRun(nodeRunId: string): NodeRun | undefined {
    const row = this.db.prepare("SELECT * FROM node_runs WHERE id = @nodeRunId").get({ nodeRunId });
    return row ? toNodeRun(row) : undefined;
  }

  /** In first-saved order. */
  listNodeRuns(runId: string): NodeRun[] {
    return this.db
      .prepare("SELECT * FROM node_runs WHERE workflow_run_id = @runId ORDER BY seq")
      .all({ runId })
      .map(toNodeRun);
  }

  getCachedOutput(idempotencyKey: string): { output: unknown; assumed?: boolean } | undefined {
    const row = this.db
      .prepare(
        `SELECT output_json, assumed FROM node_runs WHERE idempotency_key = @idempotencyKey AND status = 'passed'
         ORDER BY COALESCE(finished_at, updated_at) DESC, rowid DESC LIMIT 1`,
      )
      .get({ idempotencyKey });
    if (!row) return undefined;
    return compact({ output: fromJson<unknown>(row.output_json), assumed: intToBool(row.assumed) });
  }

  /** Idempotent by event id. Payload is redacted again as defense in depth (DoD #12). */
  appendEvent(event: RunEventInput): void {
    this.db
      .prepare(
        `INSERT INTO agent_events (id, workflow_run_id, node_run_id, session_id, type, timestamp, trace_id, confidence, payload_json)
         VALUES (@id, @workflowRunId, @nodeRunId, @sessionId, @type, @timestamp, @traceId, @confidence, @payload)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run({
        id: event.id,
        workflowRunId: event.workflowRunId,
        nodeRunId: nullable(event.nodeRunId),
        sessionId: nullable(event.sessionId),
        type: event.type,
        timestamp: event.timestamp,
        traceId: event.traceId,
        confidence: nullable(event.confidence),
        payload: JSON.stringify(redact(event.payload ?? null)),
      });
  }

  /** Ordered by timestamp, then insertion sequence. */
  listEvents(runId: string, options: ListEventsOptions = {}): StoredEvent[] {
    const where = ["workflow_run_id = @runId"];
    const params: SqlParams = { runId };
    if (options.afterTimestamp !== undefined) {
      where.push("timestamp > @afterTimestamp");
      params.afterTimestamp = options.afterTimestamp;
    }
    if (options.afterSeq !== undefined) {
      where.push("seq > @afterSeq");
      params.afterSeq = options.afterSeq;
    }
    if (options.nodeRunId !== undefined) {
      where.push("node_run_id = @nodeRunId");
      params.nodeRunId = options.nodeRunId;
    }
    if (options.sessionId !== undefined) {
      where.push("session_id = @sessionId");
      params.sessionId = options.sessionId;
    }
    if (options.types) {
      if (options.types.length === 0) return [];
      where.push(`type IN (${options.types.map((_, i) => `@t${i}`).join(", ")})`);
      options.types.forEach((t, i) => (params[`t${i}`] = t));
    }
    params.limit = options.limit ?? -1;
    const sql = options.latest
      ? `SELECT * FROM (SELECT * FROM agent_events WHERE ${where.join(" AND ")} ORDER BY timestamp DESC, seq DESC LIMIT @limit) ORDER BY timestamp, seq`
      : `SELECT * FROM agent_events WHERE ${where.join(" AND ")} ORDER BY timestamp, seq LIMIT @limit`;
    return this.db.prepare(sql).all(params).map(toEvent);
  }
}

function toRun(row: SqlRow): WorkflowRun {
  return compact({
    id: String(row.id),
    projectId: String(row.project_id),
    workflowId: String(row.workflow_id),
    workflowVersion: num(row.workflow_version),
    status: String(row.status) as WorkflowRunStatus,
    traceId: String(row.trace_id),
    inputs: fromJsonOr<WorkflowRun["inputs"]>(row.inputs_json, { snapshotIds: [] }),
    createdAt: String(row.created_at),
    startedAt: str(row.started_at),
    finishedAt: str(row.finished_at),
    error: fromJson<WorkflowRun["error"]>(row.error_json),
  });
}

function toNodeRun(row: SqlRow): NodeRun {
  return compact({
    id: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    nodeId: String(row.node_id),
    nodeType: String(row.node_type),
    nodeVersion: num(row.node_version),
    status: String(row.status) as NodeRun["status"],
    attempt: num(row.attempt),
    idempotencyKey: str(row.idempotency_key),
    inputHash: str(row.input_hash),
    output: fromJson<unknown>(row.output_json),
    error: fromJson<NodeRun["error"]>(row.error_json),
    waitingOn: fromJson<string[]>(row.waiting_on_json),
    assumed: intToBool(row.assumed),
    blockerSummary: str(row.blocker_summary),
    resumeState: fromJson<Record<string, unknown>>(row.resume_state_json),
    startedAt: str(row.started_at),
    finishedAt: str(row.finished_at),
  });
}

function toEvent(row: SqlRow): StoredEvent {
  return compact({
    seq: num(row.seq),
    id: String(row.id),
    type: String(row.type),
    timestamp: String(row.timestamp),
    workflowRunId: String(row.workflow_run_id),
    nodeRunId: str(row.node_run_id),
    sessionId: str(row.session_id),
    traceId: String(row.trace_id),
    confidence: row.confidence === null || row.confidence === undefined ? undefined : num(row.confidence),
    payload: fromJson<unknown>(row.payload_json),
  });
}
