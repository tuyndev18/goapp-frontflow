import type { ArtifactKind, ArtifactRecord, GitCheckpoint, RetentionPolicy, TestResult } from "@frontflow/domain";
import type { SqlDriver, SqlParams, SqlRow } from "../driver.js";
import { compact, fromJsonOr, nowIso, nullable, num, str } from "../sql.js";

export interface StoredArtifact extends ArtifactRecord {
  /** Sanitized display name the file was written under. */
  name: string;
}

export interface ListArtifactsFilter {
  projectId?: string;
  workflowRunId?: string;
  nodeRunId?: string;
  kind?: ArtifactKind;
}

/** Artifact metadata only; content lives on disk (see ArtifactStore). */
export class ArtifactRepository {
  constructor(private readonly db: SqlDriver) {}

  insert(a: StoredArtifact): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, project_id, workflow_run_id, node_run_id, kind, name, relative_path, content_hash,
           mime_type, source, size_bytes, retention_policy, created_at)
         VALUES (@id, @projectId, @workflowRunId, @nodeRunId, @kind, @name, @relativePath, @contentHash,
           @mimeType, @source, @sizeBytes, @retentionPolicy, @createdAt)`,
      )
      .run({
        id: a.id,
        projectId: a.projectId,
        workflowRunId: nullable(a.workflowRunId),
        nodeRunId: nullable(a.nodeRunId),
        kind: a.kind,
        name: a.name,
        relativePath: a.relativePath,
        contentHash: a.contentHash,
        mimeType: a.mimeType,
        source: a.source,
        sizeBytes: a.sizeBytes,
        retentionPolicy: a.retentionPolicy,
        createdAt: a.createdAt,
      });
  }

  get(id: string): StoredArtifact | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = @id").get({ id });
    return row ? toArtifact(row) : undefined;
  }

  /** Oldest first. */
  list(filter: ListArtifactsFilter = {}): StoredArtifact[] {
    const where: string[] = [];
    const params: SqlParams = {};
    const add = (column: string, key: keyof ListArtifactsFilter) => {
      const v = filter[key];
      if (v !== undefined) {
        where.push(`${column} = @${key}`);
        params[key] = v;
      }
    };
    add("project_id", "projectId");
    add("workflow_run_id", "workflowRunId");
    add("node_run_id", "nodeRunId");
    add("kind", "kind");
    const sql = `SELECT * FROM artifacts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, rowid`;
    return this.db.prepare(sql).all(params).map(toArtifact);
  }

  listByRun(runId: string, kind?: ArtifactKind): StoredArtifact[] {
    return this.list(kind ? { workflowRunId: runId, kind } : { workflowRunId: runId });
  }

  listByNode(nodeRunId: string): StoredArtifact[] {
    return this.list({ nodeRunId });
  }

  /** Candidates for retention: time-based policies past their age, or run_lifetime whose run row is gone. */
  listExpired(now: string): StoredArtifact[] {
    const nowMs = Date.parse(now);
    const cutoff = (days: number) => new Date(nowMs - days * 86_400_000).toISOString();
    return this.db
      .prepare(
        `SELECT a.* FROM artifacts a
         WHERE (a.retention_policy = 'days_7' AND a.created_at <= @cutoff7)
            OR (a.retention_policy = 'days_30' AND a.created_at <= @cutoff30)
            OR (a.retention_policy = 'run_lifetime' AND a.workflow_run_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id = a.workflow_run_id))
         ORDER BY a.created_at, a.rowid`,
      )
      .all({ cutoff7: cutoff(7), cutoff30: cutoff(30) })
      .map(toArtifact);
  }

  remove(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM artifacts WHERE id = @id").run({ id }).changes) > 0;
  }
}

function toArtifact(row: SqlRow): StoredArtifact {
  return compact({
    id: String(row.id),
    projectId: String(row.project_id),
    workflowRunId: str(row.workflow_run_id),
    nodeRunId: str(row.node_run_id),
    kind: String(row.kind) as ArtifactKind,
    name: String(row.name),
    relativePath: String(row.relative_path),
    contentHash: String(row.content_hash),
    mimeType: String(row.mime_type),
    source: String(row.source),
    sizeBytes: num(row.size_bytes),
    createdAt: String(row.created_at),
    retentionPolicy: String(row.retention_policy) as RetentionPolicy,
  });
}

export class TestResultRepository {
  constructor(private readonly db: SqlDriver) {}

  save(r: TestResult, createdAt: string = nowIso()): void {
    this.db
      .prepare(
        `INSERT INTO test_results (id, workflow_run_id, node_run_id, suite, kind, passed, failed, skipped, duration_ms,
           scenario_ids_json, artifact_id, created_at)
         VALUES (@id, @workflowRunId, @nodeRunId, @suite, @kind, @passed, @failed, @skipped, @durationMs,
           @scenarioIds, @artifactId, @createdAt)
         ON CONFLICT(id) DO UPDATE SET node_run_id = excluded.node_run_id, suite = excluded.suite, kind = excluded.kind,
           passed = excluded.passed, failed = excluded.failed, skipped = excluded.skipped, duration_ms = excluded.duration_ms,
           scenario_ids_json = excluded.scenario_ids_json, artifact_id = excluded.artifact_id`,
      )
      .run({
        id: r.id,
        workflowRunId: r.workflowRunId,
        nodeRunId: nullable(r.nodeRunId),
        suite: r.suite,
        kind: r.kind,
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
        durationMs: r.durationMs,
        scenarioIds: JSON.stringify(r.scenarioIds),
        artifactId: nullable(r.artifactId),
        createdAt,
      });
  }

  get(id: string): TestResult | undefined {
    const row = this.db.prepare("SELECT * FROM test_results WHERE id = @id").get({ id });
    return row ? toTestResult(row) : undefined;
  }

  listByRun(runId: string): TestResult[] {
    return this.db
      .prepare("SELECT * FROM test_results WHERE workflow_run_id = @runId ORDER BY created_at, rowid")
      .all({ runId })
      .map(toTestResult);
  }
}

function toTestResult(row: SqlRow): TestResult {
  return compact({
    id: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    nodeRunId: str(row.node_run_id),
    suite: String(row.suite),
    kind: String(row.kind) as TestResult["kind"],
    passed: num(row.passed),
    failed: num(row.failed),
    skipped: num(row.skipped),
    durationMs: num(row.duration_ms),
    scenarioIds: fromJsonOr<string[]>(row.scenario_ids_json, []),
    artifactId: str(row.artifact_id),
  });
}

export class GitCheckpointRepository {
  constructor(private readonly db: SqlDriver) {}

  save(c: GitCheckpoint): void {
    this.db
      .prepare(
        `INSERT INTO git_checkpoints (id, workflow_run_id, node_run_id, project_path, branch, base_sha, head_sha, created_at)
         VALUES (@id, @workflowRunId, @nodeRunId, @projectPath, @branch, @baseSha, @headSha, @createdAt)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run({
        id: c.id,
        workflowRunId: c.workflowRunId,
        nodeRunId: nullable(c.nodeRunId),
        projectPath: c.projectPath,
        branch: c.branch,
        baseSha: c.baseSha,
        headSha: c.headSha,
        createdAt: c.createdAt,
      });
  }

  get(id: string): GitCheckpoint | undefined {
    const row = this.db.prepare("SELECT * FROM git_checkpoints WHERE id = @id").get({ id });
    return row ? toCheckpoint(row) : undefined;
  }

  /** Oldest first. */
  listByRun(runId: string): GitCheckpoint[] {
    return this.db
      .prepare("SELECT * FROM git_checkpoints WHERE workflow_run_id = @runId ORDER BY created_at, rowid")
      .all({ runId })
      .map(toCheckpoint);
  }

  latestForRun(runId: string): GitCheckpoint | undefined {
    return this.listByRun(runId).at(-1);
  }
}

function toCheckpoint(row: SqlRow): GitCheckpoint {
  return compact({
    id: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    nodeRunId: str(row.node_run_id),
    projectPath: String(row.project_path),
    branch: String(row.branch),
    baseSha: String(row.base_sha),
    headSha: String(row.head_sha),
    createdAt: String(row.created_at),
  });
}
