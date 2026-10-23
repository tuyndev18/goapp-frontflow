import type {
  AcceptanceScenario,
  AlignmentPackage,
  ApiOperation,
  BusinessRequirement,
  RequirementApiMapping,
  TraceabilityItem,
} from "@frontflow/domain";
import type { SqlDriver } from "../driver.js";
import { boolToInt, nowIso } from "../sql.js";

/**
 * Persists an Alignment Package (spec §12.2) across the requirements / api_operations /
 * requirement_api_mappings / acceptance_scenarios / traceability_items tables, keyed by run.
 * Collection order is preserved via an ordinal column.
 */
export class AlignmentRepository {
  constructor(private readonly db: SqlDriver) {}

  /** Replaces any previously saved package for the same run, atomically. */
  saveAlignmentPackage(pkg: AlignmentPackage): void {
    const runId = pkg.runId;
    const now = nowIso();
    this.db.transaction(() => {
      this.deleteAlignmentPackage(runId);
      this.db
        .prepare(
          `INSERT INTO alignment_packages (workflow_run_id, version, source_snapshots_json, issues_json, summary_json, readiness, created_at)
           VALUES (@runId, @version, @sourceSnapshots, @issues, @summary, @readiness, @createdAt)`,
        )
        .run({
          runId,
          version: pkg.version,
          sourceSnapshots: JSON.stringify(pkg.sourceSnapshots),
          issues: JSON.stringify(pkg.issues),
          summary: JSON.stringify(pkg.summary),
          readiness: pkg.readiness,
          createdAt: now,
        });

      const insertReq = this.db.prepare(
        `INSERT INTO requirements (workflow_run_id, id, ordinal, title, confidence, data_json)
         VALUES (@runId, @id, @ordinal, @title, @confidence, @data)`,
      );
      pkg.requirements.forEach((r, ordinal) =>
        insertReq.run({ runId, id: r.id, ordinal, title: r.title, confidence: r.confidence, data: JSON.stringify(r) }),
      );

      const insertOp = this.db.prepare(
        `INSERT INTO api_operations (workflow_run_id, id, ordinal, method, path, data_json)
         VALUES (@runId, @id, @ordinal, @method, @path, @data)`,
      );
      pkg.operations.forEach((o, ordinal) =>
        insertOp.run({ runId, id: o.id, ordinal, method: o.method, path: o.path, data: JSON.stringify(o) }),
      );

      const insertMap = this.db.prepare(
        `INSERT INTO requirement_api_mappings (workflow_run_id, requirement_id, ordinal, status, confidence, blocking, data_json)
         VALUES (@runId, @requirementId, @ordinal, @status, @confidence, @blocking, @data)`,
      );
      pkg.mappings.forEach((m, ordinal) =>
        insertMap.run({
          runId,
          requirementId: m.requirementId,
          ordinal,
          status: m.status,
          confidence: m.confidence,
          blocking: boolToInt(m.blocking),
          data: JSON.stringify(m),
        }),
      );

      const insertScenario = this.db.prepare(
        `INSERT INTO acceptance_scenarios (workflow_run_id, id, ordinal, requirement_id, kind, assumed, data_json)
         VALUES (@runId, @id, @ordinal, @requirementId, @kind, @assumed, @data)`,
      );
      pkg.scenarios.forEach((s, ordinal) =>
        insertScenario.run({
          runId,
          id: s.id,
          ordinal,
          requirementId: s.requirementId,
          kind: s.kind,
          assumed: boolToInt(s.assumed),
          data: JSON.stringify(s),
        }),
      );

      const insertTrace = this.db.prepare(
        `INSERT INTO traceability_items (workflow_run_id, requirement_id, ordinal, status, data_json, updated_at)
         VALUES (@runId, @requirementId, @ordinal, @status, @data, @updatedAt)`,
      );
      pkg.traceability.forEach((t, ordinal) =>
        insertTrace.run({
          runId,
          requirementId: t.requirementId,
          ordinal,
          status: t.status,
          data: JSON.stringify(t),
          updatedAt: now,
        }),
      );
    });
  }

  loadAlignmentPackage(runId: string): AlignmentPackage | undefined {
    const header = this.db.prepare("SELECT * FROM alignment_packages WHERE workflow_run_id = @runId").get({ runId });
    if (!header) return undefined;
    return {
      version: Number(header.version) as AlignmentPackage["version"],
      runId,
      sourceSnapshots: JSON.parse(String(header.source_snapshots_json)) as string[],
      requirements: this.loadCollection<BusinessRequirement>("requirements", runId),
      operations: this.loadCollection<ApiOperation>("api_operations", runId),
      mappings: this.loadCollection<RequirementApiMapping>("requirement_api_mappings", runId),
      scenarios: this.loadCollection<AcceptanceScenario>("acceptance_scenarios", runId),
      traceability: this.listTraceability(runId),
      issues: JSON.parse(String(header.issues_json)) as AlignmentPackage["issues"],
      summary: JSON.parse(String(header.summary_json)) as AlignmentPackage["summary"],
      readiness: String(header.readiness) as AlignmentPackage["readiness"],
    };
  }

  listTraceability(runId: string): TraceabilityItem[] {
    return this.loadCollection<TraceabilityItem>("traceability_items", runId);
  }

  /** Merges a patch into one traceability row (e.g. linking source files, tests, evidence). */
  updateTraceabilityItem(
    runId: string,
    requirementId: string,
    patch: Partial<Omit<TraceabilityItem, "requirementId">>,
  ): TraceabilityItem | undefined {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT data_json FROM traceability_items WHERE workflow_run_id = @runId AND requirement_id = @requirementId")
        .get({ runId, requirementId });
      if (!row) return undefined;
      const current = JSON.parse(String(row.data_json)) as TraceabilityItem;
      const next: TraceabilityItem = { ...current };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
      this.db
        .prepare(
          `UPDATE traceability_items SET status = @status, data_json = @data, updated_at = @updatedAt
           WHERE workflow_run_id = @runId AND requirement_id = @requirementId`,
        )
        .run({ runId, requirementId, status: next.status, data: JSON.stringify(next), updatedAt: nowIso() });
      return next;
    });
  }

  deleteAlignmentPackage(runId: string): void {
    this.db.transaction(() => {
      for (const table of ALIGNMENT_TABLES) {
        this.db.prepare(`DELETE FROM ${table} WHERE workflow_run_id = @runId`).run({ runId });
      }
    });
  }

  private loadCollection<T>(table: (typeof ALIGNMENT_TABLES)[number], runId: string): T[] {
    return this.db
      .prepare(`SELECT data_json FROM ${table} WHERE workflow_run_id = @runId ORDER BY ordinal`)
      .all({ runId })
      .map((r) => JSON.parse(String(r.data_json)) as T);
  }
}

const ALIGNMENT_TABLES = [
  "alignment_packages",
  "requirements",
  "api_operations",
  "requirement_api_mappings",
  "acceptance_scenarios",
  "traceability_items",
] as const;
