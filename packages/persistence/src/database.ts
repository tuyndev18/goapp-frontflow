import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createNodeSqliteDriver, type SqlDriver } from "./driver.js";
import { MIGRATIONS, runMigrations, type Migration } from "./migrations.js";
import { AlignmentRepository } from "./repositories/alignment.js";
import { ArtifactRepository, GitCheckpointRepository, TestResultRepository } from "./repositories/artifacts.js";
import { SnapshotRepository, SourceDocumentRepository } from "./repositories/documents.js";
import { ProfileRepository, ProjectRepository } from "./repositories/projects.js";
import { AiSessionRepository, ApprovalRepository, CliInstallationRepository } from "./repositories/sessions.js";
import { UsageRepository } from "./repositories/usage.js";
import { SqliteRunStore, WorkflowDefinitionRepository } from "./repositories/workflow.js";

export interface OpenDatabaseOptions {
  /** Milliseconds to wait on a locked database before failing. Default 5000. */
  busyTimeoutMs?: number;
  /** Override the migration list (tests). */
  migrations?: readonly Migration[];
  /** Inject a different driver implementation (e.g. better-sqlite3). */
  driverFactory?: (filePath: string) => SqlDriver;
}

export interface FrontflowDb {
  readonly filePath: string;
  readonly driver: SqlDriver;
  readonly schemaVersion: number;
  readonly projects: ProjectRepository;
  readonly profiles: ProfileRepository;
  readonly sourceDocuments: SourceDocumentRepository;
  readonly snapshots: SnapshotRepository;
  readonly workflowDefinitions: WorkflowDefinitionRepository;
  readonly runStore: SqliteRunStore;
  readonly cliInstallations: CliInstallationRepository;
  readonly aiSessions: AiSessionRepository;
  readonly usage: UsageRepository;
  readonly artifacts: ArtifactRepository;
  readonly alignment: AlignmentRepository;
  readonly testResults: TestResultRepository;
  readonly gitCheckpoints: GitCheckpointRepository;
  readonly approvals: ApprovalRepository;
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** Opens (creating if needed) the FrontFlow database and applies pending migrations. */
export function openDatabase(filePath: string, options: OpenDatabaseOptions = {}): FrontflowDb {
  const inMemory = filePath === ":memory:";
  if (!inMemory) mkdirSync(dirname(filePath), { recursive: true });
  const driver = (options.driverFactory ?? createNodeSqliteDriver)(filePath);
  try {
    if (!inMemory) driver.exec("PRAGMA journal_mode = WAL");
    driver.exec("PRAGMA foreign_keys = ON");
    driver.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
    driver.exec("PRAGMA synchronous = NORMAL");
    const schemaVersion = runMigrations(driver, options.migrations ?? MIGRATIONS);
    return {
      filePath,
      driver,
      schemaVersion,
      projects: new ProjectRepository(driver),
      profiles: new ProfileRepository(driver),
      sourceDocuments: new SourceDocumentRepository(driver),
      snapshots: new SnapshotRepository(driver),
      workflowDefinitions: new WorkflowDefinitionRepository(driver),
      runStore: new SqliteRunStore(driver),
      cliInstallations: new CliInstallationRepository(driver),
      aiSessions: new AiSessionRepository(driver),
      usage: new UsageRepository(driver),
      artifacts: new ArtifactRepository(driver),
      alignment: new AlignmentRepository(driver),
      testResults: new TestResultRepository(driver),
      gitCheckpoints: new GitCheckpointRepository(driver),
      approvals: new ApprovalRepository(driver),
      transaction: (fn) => driver.transaction(fn),
      close: () => driver.close(),
    };
  } catch (err) {
    driver.close();
    throw err;
  }
}
