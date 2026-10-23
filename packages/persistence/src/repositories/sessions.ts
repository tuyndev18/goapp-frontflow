import type { PermissionClass } from "@frontflow/domain";
import { redactString, type AgentSessionStatus } from "@frontflow/event-schema";
import type { SqlDriver, SqlRow } from "../driver.js";
import { boolToInt, compact, fromJson, intToBool, nowIso, nullable, str, toJson } from "../sql.js";

/** Result of detecting one AI CLI on this machine. Never holds credentials. */
export interface CliInstallationRecord {
  adapterId: string;
  available: boolean;
  executablePath?: string;
  version?: string;
  /** e.g. "authenticated" | "unauthenticated" | "unknown" — status only, never a token. */
  authStatus?: string;
  capabilities?: Record<string, boolean>;
  error?: string;
  detectedAt: string;
}

export class CliInstallationRepository {
  constructor(private readonly db: SqlDriver) {}

  upsert(rec: CliInstallationRecord): void {
    this.db
      .prepare(
        `INSERT INTO ai_cli_installations (adapter_id, available, executable_path, version, auth_status, capabilities_json, error, detected_at)
         VALUES (@adapterId, @available, @executablePath, @version, @authStatus, @capabilities, @error, @detectedAt)
         ON CONFLICT(adapter_id) DO UPDATE SET available = excluded.available, executable_path = excluded.executable_path,
           version = excluded.version, auth_status = excluded.auth_status, capabilities_json = excluded.capabilities_json,
           error = excluded.error, detected_at = excluded.detected_at`,
      )
      .run({
        adapterId: rec.adapterId,
        available: boolToInt(rec.available),
        executablePath: nullable(rec.executablePath),
        version: nullable(rec.version),
        authStatus: nullable(rec.authStatus),
        capabilities: toJson(rec.capabilities),
        error: nullable(rec.error),
        detectedAt: rec.detectedAt,
      });
  }

  get(adapterId: string): CliInstallationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM ai_cli_installations WHERE adapter_id = @adapterId").get({ adapterId });
    return row ? toInstallation(row) : undefined;
  }

  list(): CliInstallationRecord[] {
    return this.db.prepare("SELECT * FROM ai_cli_installations ORDER BY adapter_id").all().map(toInstallation);
  }
}

function toInstallation(row: SqlRow): CliInstallationRecord {
  return compact({
    adapterId: String(row.adapter_id),
    available: intToBool(row.available) ?? false,
    executablePath: str(row.executable_path),
    version: str(row.version),
    authStatus: str(row.auth_status),
    capabilities: fromJson<Record<string, boolean>>(row.capabilities_json),
    error: str(row.error),
    detectedAt: String(row.detected_at),
  });
}

export type AiSessionMode = "structured" | "pty";

export interface AiSessionRecord {
  id: string;
  projectId: string;
  workflowRunId?: string;
  nodeRunId?: string;
  adapterId: string;
  /** The CLI's own session id, used to resume. */
  externalSessionId?: string;
  mode: AiSessionMode;
  status: AgentSessionStatus;
  cwd: string;
  model?: string;
  /** Raw PTY/stdout log relative to the artifact root, when raw logging is enabled. */
  rawLogPath?: string;
  metadata?: Record<string, unknown>;
  /** Name shown in the Sessions screen (sessions started there). */
  title?: string;
  /** Last event or terminal output seen from the session. */
  lastActivityAt?: string;
  startedAt: string;
  endedAt?: string;
}

export class AiSessionRepository {
  constructor(private readonly db: SqlDriver) {}

  save(s: AiSessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO ai_sessions (id, project_id, workflow_run_id, node_run_id, adapter_id, external_session_id, mode, status,
           cwd, model, raw_log_path, metadata_json, title, last_activity_at, started_at, ended_at, updated_at)
         VALUES (@id, @projectId, @workflowRunId, @nodeRunId, @adapterId, @externalSessionId, @mode, @status,
           @cwd, @model, @rawLogPath, @metadata, @title, @lastActivityAt, @startedAt, @endedAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET workflow_run_id = excluded.workflow_run_id, node_run_id = excluded.node_run_id,
           adapter_id = excluded.adapter_id, external_session_id = excluded.external_session_id, mode = excluded.mode,
           status = excluded.status, cwd = excluded.cwd, model = excluded.model, raw_log_path = excluded.raw_log_path,
           metadata_json = excluded.metadata_json, title = excluded.title, last_activity_at = excluded.last_activity_at,
           ended_at = excluded.ended_at, updated_at = excluded.updated_at`,
      )
      .run({
        id: s.id,
        projectId: s.projectId,
        workflowRunId: nullable(s.workflowRunId),
        nodeRunId: nullable(s.nodeRunId),
        adapterId: s.adapterId,
        externalSessionId: nullable(s.externalSessionId),
        mode: s.mode,
        status: s.status,
        cwd: s.cwd,
        model: nullable(s.model),
        rawLogPath: nullable(s.rawLogPath),
        metadata: toJson(s.metadata),
        title: nullable(s.title),
        lastActivityAt: nullable(s.lastActivityAt),
        startedAt: s.startedAt,
        endedAt: nullable(s.endedAt),
        updatedAt: nowIso(),
      });
  }

  get(id: string): AiSessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM ai_sessions WHERE id = @id").get({ id });
    return row ? toSession(row) : undefined;
  }

  updateStatus(id: string, status: AgentSessionStatus, patch: { externalSessionId?: string; endedAt?: string } = {}): boolean {
    const res = this.db
      .prepare(
        `UPDATE ai_sessions SET status = @status,
           external_session_id = COALESCE(@externalSessionId, external_session_id),
           ended_at = COALESCE(@endedAt, ended_at), updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        status,
        externalSessionId: nullable(patch.externalSessionId),
        endedAt: nullable(patch.endedAt),
        updatedAt: nowIso(),
      });
    return Number(res.changes) > 0;
  }

  /** Records activity; never moves the timestamp backwards. */
  touch(id: string, at: string = nowIso()): void {
    this.db
      .prepare("UPDATE ai_sessions SET last_activity_at = @at WHERE id = @id AND (last_activity_at IS NULL OR last_activity_at < @at)")
      .run({ id, at });
  }

  /** Renames and/or merges metadata keys. Returns false for an unknown session. */
  patch(id: string, patch: { title?: string; metadata?: Record<string, unknown> }): boolean {
    const current = this.get(id);
    if (!current) return false;
    this.save({
      ...current,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.metadata ? { metadata: { ...current.metadata, ...patch.metadata } } : {}),
    });
    return true;
  }

  /** Deletes the record; its standalone events and usage rows go with it (trigger). */
  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM ai_sessions WHERE id = @id").run({ id }).changes) > 0;
  }

  /** Sessions not ended yet, in every project. */
  listOpen(): AiSessionRecord[] {
    return this.db
      .prepare("SELECT * FROM ai_sessions WHERE status NOT IN ('completed', 'failed', 'cancelled') ORDER BY started_at, rowid")
      .all()
      .map(toSession);
  }

  /** Newest first. */
  listByProject(projectId: string, limit = -1): AiSessionRecord[] {
    return this.db
      .prepare("SELECT * FROM ai_sessions WHERE project_id = @projectId ORDER BY started_at DESC, rowid DESC LIMIT @limit")
      .all({ projectId, limit })
      .map(toSession);
  }

  /** Oldest first. */
  listByRun(runId: string): AiSessionRecord[] {
    return this.db
      .prepare("SELECT * FROM ai_sessions WHERE workflow_run_id = @runId ORDER BY started_at, rowid")
      .all({ runId })
      .map(toSession);
  }
}

function toSession(row: SqlRow): AiSessionRecord {
  return compact({
    id: String(row.id),
    projectId: String(row.project_id),
    workflowRunId: str(row.workflow_run_id),
    nodeRunId: str(row.node_run_id),
    adapterId: String(row.adapter_id),
    externalSessionId: str(row.external_session_id),
    mode: String(row.mode) as AiSessionMode,
    status: String(row.status) as AgentSessionStatus,
    cwd: String(row.cwd),
    model: str(row.model),
    rawLogPath: str(row.raw_log_path),
    metadata: fromJson<Record<string, unknown>>(row.metadata_json),
    title: str(row.title),
    lastActivityAt: str(row.last_activity_at),
    startedAt: String(row.started_at),
    endedAt: str(row.ended_at),
  });
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalRecord {
  requestId: string;
  projectId?: string;
  workflowRunId?: string;
  nodeRunId?: string;
  sessionId?: string;
  permission: PermissionClass;
  action: string;
  detail?: string;
  status: ApprovalStatus;
  reason?: string;
  requestedAt: string;
  expiresAt?: string;
  decidedAt?: string;
  decidedBy?: string;
}

export class ApprovalRepository {
  constructor(private readonly db: SqlDriver) {}

  /** Inserts or replaces the full record. */
  save(a: ApprovalRecord): void {
    this.db
      .prepare(
        `INSERT INTO approvals (request_id, project_id, workflow_run_id, node_run_id, session_id, permission, action, detail,
           status, reason, requested_at, expires_at, decided_at, decided_by)
         VALUES (@requestId, @projectId, @workflowRunId, @nodeRunId, @sessionId, @permission, @action, @detail,
           @status, @reason, @requestedAt, @expiresAt, @decidedAt, @decidedBy)
         ON CONFLICT(request_id) DO UPDATE SET project_id = excluded.project_id, workflow_run_id = excluded.workflow_run_id,
           node_run_id = excluded.node_run_id, session_id = excluded.session_id, permission = excluded.permission,
           action = excluded.action, detail = excluded.detail, status = excluded.status, reason = excluded.reason,
           requested_at = excluded.requested_at, expires_at = excluded.expires_at, decided_at = excluded.decided_at,
           decided_by = excluded.decided_by`,
      )
      .run({
        requestId: a.requestId,
        projectId: nullable(a.projectId),
        workflowRunId: nullable(a.workflowRunId),
        nodeRunId: nullable(a.nodeRunId),
        sessionId: nullable(a.sessionId),
        permission: a.permission,
        action: a.action,
        detail: a.detail === undefined ? null : redactString(a.detail),
        status: a.status,
        reason: nullable(a.reason),
        requestedAt: a.requestedAt,
        expiresAt: nullable(a.expiresAt),
        decidedAt: nullable(a.decidedAt),
        decidedBy: nullable(a.decidedBy),
      });
  }

  get(requestId: string): ApprovalRecord | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE request_id = @requestId").get({ requestId });
    return row ? toApproval(row) : undefined;
  }

  /**
   * Transitions a pending request to a final status. Returns false when the request
   * is unknown or already decided (decisions are final).
   */
  decide(
    requestId: string,
    status: Exclude<ApprovalStatus, "pending">,
    options: { decidedAt?: string; decidedBy?: string; reason?: string } = {},
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE approvals SET status = @status, decided_at = @decidedAt, decided_by = @decidedBy,
           reason = COALESCE(@reason, reason)
         WHERE request_id = @requestId AND status = 'pending'`,
      )
      .run({
        requestId,
        status,
        decidedAt: options.decidedAt ?? nowIso(),
        decidedBy: nullable(options.decidedBy),
        reason: nullable(options.reason),
      });
    return Number(res.changes) > 0;
  }

  /** Marks pending requests whose expiresAt has passed as expired; returns their ids. */
  expireDue(now: string = nowIso()): string[] {
    return this.db.transaction(() => {
      const ids = this.db
        .prepare("SELECT request_id FROM approvals WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= @now")
        .all({ now })
        .map((r) => String(r.request_id));
      for (const id of ids) this.decide(id, "expired", { decidedAt: now });
      return ids;
    });
  }

  listPending(filter: { projectId?: string; workflowRunId?: string } = {}): ApprovalRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM approvals WHERE status = 'pending'
           AND (@projectId IS NULL OR project_id = @projectId)
           AND (@workflowRunId IS NULL OR workflow_run_id = @workflowRunId)
         ORDER BY requested_at, rowid`,
      )
      .all({ projectId: nullable(filter.projectId), workflowRunId: nullable(filter.workflowRunId) })
      .map(toApproval);
  }

  listByRun(runId: string): ApprovalRecord[] {
    return this.db
      .prepare("SELECT * FROM approvals WHERE workflow_run_id = @runId ORDER BY requested_at, rowid")
      .all({ runId })
      .map(toApproval);
  }
}

function toApproval(row: SqlRow): ApprovalRecord {
  return compact({
    requestId: String(row.request_id),
    projectId: str(row.project_id),
    workflowRunId: str(row.workflow_run_id),
    nodeRunId: str(row.node_run_id),
    sessionId: str(row.session_id),
    permission: String(row.permission) as PermissionClass,
    action: String(row.action),
    detail: str(row.detail),
    status: String(row.status) as ApprovalStatus,
    reason: str(row.reason),
    requestedAt: String(row.requested_at),
    expiresAt: str(row.expires_at),
    decidedAt: str(row.decided_at),
    decidedBy: str(row.decided_by),
  });
}
