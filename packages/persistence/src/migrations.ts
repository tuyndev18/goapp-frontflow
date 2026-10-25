import type { SqlDriver } from "./driver.js";

export interface Migration {
  version: number;
  name: string;
  up: string;
}

/**
 * Ordered, append-only. Never edit a released migration; add a new one.
 * Nested/complex fields are JSON text columns (`*_json`). Timestamps are ISO-8601 strings.
 * No table stores plaintext credentials (spec §22.3) — secrets live in the OS vault.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
);
CREATE INDEX idx_projects_root_path ON projects(root_path);
CREATE INDEX idx_projects_last_opened ON projects(last_opened_at);

CREATE TABLE project_profiles (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  profile_json TEXT NOT NULL,
  profile_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, version)
);

CREATE TABLE source_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  source_uri TEXT,
  latest_snapshot_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_source_documents_project ON source_documents(project_id);

CREATE TABLE source_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_document_id TEXT REFERENCES source_documents(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  source_uri TEXT,
  content_hash TEXT NOT NULL,
  content_path TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_source_snapshots_project_hash ON source_snapshots(project_id, content_hash);
CREATE INDEX idx_source_snapshots_document ON source_snapshots(source_document_id);

CREATE TABLE workflow_definitions (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  error_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_workflow_runs_project_created ON workflow_runs(project_id, created_at);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);

CREATE TABLE node_runs (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  node_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  idempotency_key TEXT,
  input_hash TEXT,
  output_json TEXT,
  error_json TEXT,
  waiting_on_json TEXT,
  assumed INTEGER,
  blocker_summary TEXT,
  started_at TEXT,
  finished_at TEXT,
  seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_node_runs_run ON node_runs(workflow_run_id);
CREATE INDEX idx_node_runs_idempotency ON node_runs(idempotency_key);

CREATE TABLE ai_cli_installations (
  adapter_id TEXT PRIMARY KEY,
  available INTEGER NOT NULL,
  executable_path TEXT,
  version TEXT,
  auth_status TEXT,
  capabilities_json TEXT,
  error TEXT,
  detected_at TEXT NOT NULL
);

CREATE TABLE ai_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  node_run_id TEXT,
  adapter_id TEXT NOT NULL,
  external_session_id TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model TEXT,
  raw_log_path TEXT,
  metadata_json TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_ai_sessions_project ON ai_sessions(project_id, started_at);
CREATE INDEX idx_ai_sessions_run ON ai_sessions(workflow_run_id);

CREATE TABLE agent_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_run_id TEXT,
  session_id TEXT,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  confidence REAL,
  payload_json TEXT NOT NULL
);
CREATE INDEX idx_agent_events_run_ts ON agent_events(workflow_run_id, timestamp);
CREATE INDEX idx_agent_events_session ON agent_events(session_id);

-- workflow_run_id / node_run_id are intentionally not FKs: files outlive rows until
-- ArtifactStore.applyRetention removes both (run_lifetime = run row deleted).
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_run_id TEXT,
  node_run_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  source TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  retention_policy TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_artifacts_run ON artifacts(workflow_run_id, kind);
CREATE INDEX idx_artifacts_node ON artifacts(node_run_id);
CREATE INDEX idx_artifacts_project ON artifacts(project_id, kind);

-- Alignment Package (spec §12.2): header + one table per collection, keyed by run.
CREATE TABLE alignment_packages (
  workflow_run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source_snapshots_json TEXT NOT NULL,
  issues_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  readiness TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE requirements (
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  confidence REAL NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (workflow_run_id, id)
);

CREATE TABLE api_operations (
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (workflow_run_id, id)
);

CREATE TABLE requirement_api_mappings (
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  blocking INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (workflow_run_id, requirement_id)
);
CREATE INDEX idx_mappings_status ON requirement_api_mappings(workflow_run_id, status);

CREATE TABLE acceptance_scenarios (
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  requirement_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  assumed INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (workflow_run_id, id)
);
CREATE INDEX idx_scenarios_requirement ON acceptance_scenarios(workflow_run_id, requirement_id);

CREATE TABLE traceability_items (
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workflow_run_id, requirement_id)
);

CREATE TABLE test_results (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_run_id TEXT,
  suite TEXT NOT NULL,
  kind TEXT NOT NULL,
  passed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  skipped INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  scenario_ids_json TEXT NOT NULL,
  artifact_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_test_results_run ON test_results(workflow_run_id);

CREATE TABLE git_checkpoints (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_run_id TEXT,
  worktree_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_git_checkpoints_run ON git_checkpoints(workflow_run_id, created_at);

CREATE TABLE approvals (
  request_id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_run_id TEXT,
  session_id TEXT,
  permission TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  requested_at TEXT NOT NULL,
  expires_at TEXT,
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX idx_approvals_status ON approvals(status, requested_at);
CREATE INDEX idx_approvals_run ON approvals(workflow_run_id);
`,
  },
  {
    version: 2,
    name: "standalone_sessions_and_usage",
    up: `
-- Sessions started from the Sessions screen belong to a project but to no workflow run:
-- their events keep workflow_run_id NULL (SQLite cannot relax NOT NULL in place).
CREATE TABLE agent_events_v2 (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_run_id TEXT,
  session_id TEXT,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  confidence REAL,
  payload_json TEXT NOT NULL
);
INSERT INTO agent_events_v2 (seq, id, workflow_run_id, node_run_id, session_id, type, timestamp, trace_id, confidence, payload_json)
  SELECT seq, id, workflow_run_id, node_run_id, session_id, type, timestamp, trace_id, confidence, payload_json FROM agent_events;
DROP TABLE agent_events;
ALTER TABLE agent_events_v2 RENAME TO agent_events;
CREATE INDEX idx_agent_events_run_ts ON agent_events(workflow_run_id, timestamp);
CREATE INDEX idx_agent_events_session ON agent_events(session_id);

ALTER TABLE ai_sessions ADD COLUMN title TEXT;
ALTER TABLE ai_sessions ADD COLUMN last_activity_at TEXT;

-- Normalized usage per API message / CLI turn (counts only: no prompt or output text).
CREATE TABLE usage_events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  account_id TEXT,
  model TEXT,
  scope TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  source_cost_usd REAL,
  estimated_cost_usd REAL,
  pricing_version TEXT,
  raw_source TEXT NOT NULL,
  parser_version INTEGER NOT NULL
);
CREATE INDEX idx_usage_events_session ON usage_events(session_id, scope);
CREATE INDEX idx_usage_events_project ON usage_events(project_id, occurred_at);

CREATE TRIGGER ai_sessions_cleanup AFTER DELETE ON ai_sessions BEGIN
  DELETE FROM agent_events WHERE session_id = OLD.id AND workflow_run_id IS NULL;
  DELETE FROM usage_events WHERE session_id = OLD.id;
END;
`,
  },
  {
    version: 3,
    name: "checkpoints_in_project_folder",
    up: `
-- AI agents work in the opened project folder; there are no per-run worktrees any more.
ALTER TABLE git_checkpoints RENAME COLUMN worktree_path TO project_path;
`,
  },
  {
    version: 4,
    name: "node_run_resume_state",
    up: `
-- What a node keeps for its next attempt (its Claude session to resume), cleared on reset.
ALTER TABLE node_runs ADD COLUMN resume_state_json TEXT;
`,
  },
];

export class MigrationError extends Error {
  override name = "MigrationError";
}

/** Applies pending migrations in order, each in its own transaction. Returns the resulting schema version. */
export function runMigrations(driver: SqlDriver, migrations: readonly Migration[] = MIGRATIONS): number {
  driver.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.version === sorted[i - 1]!.version) {
      throw new MigrationError(`Duplicate migration version ${sorted[i]!.version}`);
    }
  }
  const current = currentSchemaVersion(driver);
  const latestKnown = sorted.at(-1)?.version ?? 0;
  if (current > latestKnown) {
    throw new MigrationError(`Database schema version ${current} is newer than this app supports (${latestKnown})`);
  }
  for (const migration of sorted) {
    if (migration.version <= current) continue;
    driver.transaction(() => {
      driver.exec(migration.up);
      driver
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (@version, @name, @appliedAt)")
        .run({ version: migration.version, name: migration.name, appliedAt: new Date().toISOString() });
    });
  }
  return currentSchemaVersion(driver);
}

export function currentSchemaVersion(driver: SqlDriver): number {
  const row = driver.prepare("SELECT MAX(version) AS v FROM schema_migrations").get<{ v: number | null }>();
  return row?.v ?? 0;
}
