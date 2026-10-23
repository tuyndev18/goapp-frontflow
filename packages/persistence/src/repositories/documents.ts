import type { SourceSnapshot, SourceSnapshotType } from "@frontflow/domain";
import type { SqlDriver, SqlRow } from "../driver.js";
import { compact, fromJsonOr, nullable, str } from "../sql.js";

/** A logical input document (e.g. an uploaded BA file); its content versions are immutable snapshots. */
export interface SourceDocument {
  id: string;
  projectId: string;
  type: SourceSnapshotType;
  name: string;
  sourceUri?: string;
  latestSnapshotId?: string;
  createdAt: string;
  updatedAt: string;
}

export class SourceDocumentRepository {
  constructor(private readonly db: SqlDriver) {}

  upsert(doc: SourceDocument): void {
    this.db
      .prepare(
        `INSERT INTO source_documents (id, project_id, type, name, source_uri, latest_snapshot_id, created_at, updated_at)
         VALUES (@id, @projectId, @type, @name, @sourceUri, @latestSnapshotId, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET type = excluded.type, name = excluded.name, source_uri = excluded.source_uri,
           latest_snapshot_id = excluded.latest_snapshot_id, updated_at = excluded.updated_at`,
      )
      .run({
        id: doc.id,
        projectId: doc.projectId,
        type: doc.type,
        name: doc.name,
        sourceUri: nullable(doc.sourceUri),
        latestSnapshotId: nullable(doc.latestSnapshotId),
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      });
  }

  get(id: string): SourceDocument | undefined {
    const row = this.db.prepare("SELECT * FROM source_documents WHERE id = @id").get({ id });
    return row ? toDocument(row) : undefined;
  }

  listByProject(projectId: string): SourceDocument[] {
    return this.db
      .prepare("SELECT * FROM source_documents WHERE project_id = @projectId ORDER BY updated_at DESC, id")
      .all({ projectId })
      .map(toDocument);
  }

  remove(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM source_documents WHERE id = @id").run({ id }).changes) > 0;
  }
}

function toDocument(row: SqlRow): SourceDocument {
  return compact({
    id: String(row.id),
    projectId: String(row.project_id),
    type: String(row.type) as SourceSnapshotType,
    name: String(row.name),
    sourceUri: str(row.source_uri),
    latestSnapshotId: str(row.latest_snapshot_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
}

export interface SnapshotRecord {
  projectId: string;
  sourceDocumentId?: string;
  /** Content file relative to the artifact root (set by ArtifactStore.saveSnapshotContent). */
  contentPath?: string;
  snapshot: SourceSnapshot;
}

/** Snapshots are immutable: inserting an existing id is a no-op. */
export class SnapshotRepository {
  constructor(private readonly db: SqlDriver) {}

  /** Returns true when a new row was written, false when the id already existed. */
  insert(
    projectId: string,
    snapshot: SourceSnapshot,
    options: { sourceDocumentId?: string; contentPath?: string } = {},
  ): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO source_snapshots (id, project_id, source_document_id, type, source_uri, content_hash, content_path, metadata_json, created_at)
         VALUES (@id, @projectId, @sourceDocumentId, @type, @sourceUri, @contentHash, @contentPath, @metadata, @createdAt)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run({
        id: snapshot.id,
        projectId,
        sourceDocumentId: nullable(options.sourceDocumentId),
        type: snapshot.type,
        sourceUri: nullable(snapshot.sourceUri),
        contentHash: snapshot.contentHash,
        contentPath: nullable(options.contentPath),
        metadata: JSON.stringify(snapshot.metadata ?? {}),
        createdAt: snapshot.createdAt,
      });
    return Number(res.changes) > 0;
  }

  get(id: string): SourceSnapshot | undefined {
    return this.getRecord(id)?.snapshot;
  }

  getRecord(id: string): SnapshotRecord | undefined {
    const row = this.db.prepare("SELECT * FROM source_snapshots WHERE id = @id").get({ id });
    return row ? toRecord(row) : undefined;
  }

  findByHash(projectId: string, contentHash: string): SourceSnapshot | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM source_snapshots WHERE project_id = @projectId AND content_hash = @contentHash ORDER BY created_at LIMIT 1",
      )
      .get({ projectId, contentHash });
    return row ? toRecord(row).snapshot : undefined;
  }

  /** Snapshots a run is pinned to (WorkflowRun.inputs.snapshotIds), in input order. */
  listByRun(runId: string): SourceSnapshot[] {
    const row = this.db.prepare("SELECT inputs_json FROM workflow_runs WHERE id = @runId").get({ runId });
    if (!row) return [];
    const ids = fromJsonOr<{ snapshotIds?: unknown }>(row.inputs_json, {}).snapshotIds;
    if (!Array.isArray(ids)) return [];
    const out: SourceSnapshot[] = [];
    for (const id of ids) {
      const snap = typeof id === "string" ? this.get(id) : undefined;
      if (snap) out.push(snap);
    }
    return out;
  }

  listByProject(projectId: string): SourceSnapshot[] {
    return this.db
      .prepare("SELECT * FROM source_snapshots WHERE project_id = @projectId ORDER BY created_at, id")
      .all({ projectId })
      .map((r) => toRecord(r).snapshot);
  }
}

function toRecord(row: SqlRow): SnapshotRecord {
  return compact({
    projectId: String(row.project_id),
    sourceDocumentId: str(row.source_document_id),
    contentPath: str(row.content_path),
    snapshot: compact({
      id: String(row.id),
      type: String(row.type) as SourceSnapshot["type"],
      sourceUri: str(row.source_uri),
      contentHash: String(row.content_hash),
      createdAt: String(row.created_at),
      metadata: fromJsonOr<Record<string, unknown>>(row.metadata_json, {}),
    }),
  });
}
