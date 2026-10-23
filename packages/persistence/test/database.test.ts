import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIGRATIONS,
  MigrationError,
  openDatabase,
  type AiSessionRecord,
  type FrontflowDb,
  type Migration,
} from "../src/index.js";
import { makeTempDir, nodeRun, profile, project, run } from "./helpers.js";

const SPEC_TABLES = [
  "projects",
  "project_profiles",
  "source_documents",
  "source_snapshots",
  "workflow_definitions",
  "workflow_runs",
  "node_runs",
  "ai_cli_installations",
  "ai_sessions",
  "agent_events",
  "artifacts",
  "requirements",
  "api_operations",
  "requirement_api_mappings",
  "acceptance_scenarios",
  "traceability_items",
  "test_results",
  "git_checkpoints",
  "approvals",
];

function tableNames(db: FrontflowDb): string[] {
  return db.driver
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>()
    .map((r) => r.name);
}

describe("openDatabase + migrations", () => {
  let tmp: ReturnType<typeof makeTempDir>;
  let file: string;
  beforeEach(() => {
    tmp = makeTempDir();
    file = join(tmp.dir, "nested", "database.sqlite");
  });
  afterEach(() => tmp.cleanup());

  it("creates all spec §18.1 tables with WAL and foreign keys on", () => {
    const db = openDatabase(file);
    try {
      const names = tableNames(db);
      for (const t of SPEC_TABLES) expect(names).toContain(t);
      expect(names).toContain("schema_migrations");
      expect(db.driver.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
      expect(db.driver.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
      expect(Number(db.driver.prepare("PRAGMA busy_timeout").get<{ timeout: number }>()?.timeout)).toBe(5000);
      expect(db.schemaVersion).toBe(MIGRATIONS.at(-1)!.version);
    } finally {
      db.close();
    }
  });

  it("is idempotent across reopen of a file database", () => {
    openDatabase(file).close();
    const db = openDatabase(file);
    try {
      const rows = db.driver.prepare("SELECT version FROM schema_migrations").all();
      expect(rows).toHaveLength(MIGRATIONS.length);
      expect(tableNames(db).filter((n) => SPEC_TABLES.includes(n))).toHaveLength(SPEC_TABLES.length);
    } finally {
      db.close();
    }
  });

  it("applies only new migrations on upgrade and rolls back a failing one", () => {
    openDatabase(file).close();
    const next = MIGRATIONS.at(-1)!.version + 1;
    const extra: Migration = { version: next, name: "add_notes", up: "CREATE TABLE notes (id TEXT PRIMARY KEY);" };
    const db2 = openDatabase(file, { migrations: [...MIGRATIONS, extra] });
    expect(db2.schemaVersion).toBe(next);
    db2.close();

    const broken: Migration = { version: next + 1, name: "broken", up: "CREATE TABLE half (id TEXT); CREATE TABLE oops (" };
    expect(() => openDatabase(file, { migrations: [...MIGRATIONS, extra, broken] })).toThrow();
    const db3 = openDatabase(file, { migrations: [...MIGRATIONS, extra] });
    try {
      expect(db3.schemaVersion).toBe(next);
      expect(tableNames(db3)).not.toContain("half");
    } finally {
      db3.close();
    }
  });

  it("refuses to open a database newer than the app", () => {
    openDatabase(file, { migrations: [...MIGRATIONS, { version: 99, name: "future", up: "SELECT 1;" }] }).close();
    expect(() => openDatabase(file)).toThrow(MigrationError);
  });

  it("has no column intended for plaintext secrets (spec §22.3)", () => {
    const db = openDatabase(":memory:");
    try {
      const secretish = /(secret|password|passwd|token|api_?key|credential|private_?key|cookie)/i;
      // Token *counts* of the usage table are integers, not credentials.
      const counters = new Set(["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]);
      for (const t of tableNames(db)) {
        const cols = db.driver.prepare(`PRAGMA table_info(${t})`).all<{ name: string; type: string }>();
        for (const c of cols) {
          if (t === "usage_events" && counters.has(c.name)) {
            expect(c.type).toBe("INTEGER");
            continue;
          }
          expect(`${t}.${c.name}`).not.toMatch(secretish);
        }
      }
    } finally {
      db.close();
    }
  });

  it("enforces foreign keys", () => {
    const db = openDatabase(":memory:");
    try {
      expect(() => db.runStore.saveRun(run("run_orphan", { projectId: "missing" }))).toThrow();
    } finally {
      db.close();
    }
  });

  it("restores project, profile, runs, node runs and sessions after restart", () => {
    const session: AiSessionRecord = {
      id: "sess_1",
      projectId: "proj_1",
      workflowRunId: "run_1",
      nodeRunId: "nr_impl",
      adapterId: "claude-code",
      externalSessionId: "ext-123",
      mode: "structured",
      status: "running_tool",
      cwd: "D:/work/proj_1",
      rawLogPath: "projects/proj_1/sessions/sess_1/pty.raw.log",
      startedAt: "2026-10-01T10:05:00.000Z",
    };
    const p = project();
    const prof = profile();
    const r = run("run_1", { status: "waiting" });
    const n1 = nodeRun("nr_ba", { status: "passed", output: { requirements: 3 }, idempotencyKey: "k1", finishedAt: "2026-10-01T10:01:00.000Z" });
    const n2 = nodeRun("nr_impl", { nodeId: "B.IMPLEMENT", status: "waiting_for_input", waitingOn: ["approval"], assumed: true });

    const db1 = openDatabase(file);
    db1.projects.upsert(p);
    db1.profiles.save(prof);
    db1.runStore.saveRun(r);
    db1.runStore.saveNodeRun(n1);
    db1.runStore.saveNodeRun(n2);
    db1.aiSessions.save(session);
    db1.close();

    const db2 = openDatabase(file);
    try {
      expect(db2.projects.list()).toEqual([p]);
      expect(db2.profiles.getLatest("proj_1")).toEqual(prof);
      expect(db2.runStore.getRun("run_1")).toEqual(r);
      expect(db2.runStore.listActiveRuns()).toEqual([r]);
      expect(db2.runStore.listNodeRuns("run_1")).toEqual([n1, n2]);
      expect(db2.aiSessions.get("sess_1")).toEqual(session);
      expect(db2.aiSessions.listByRun("run_1")).toEqual([session]);
    } finally {
      db2.close();
    }
  });
});
