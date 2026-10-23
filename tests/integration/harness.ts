import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { newId, nowIso } from "@frontflow/domain";
import { snapshotDocument } from "@frontflow/document-parser";
import { FakeCliAdapter, SessionManager } from "@frontflow/cli-adapters";
import type { FigmaHandoff } from "@frontflow/figma-mcp-bridge";
import { analyzeProject } from "@frontflow/project-analyzer";
import { ArtifactStore, openDatabase, type FrontflowDb } from "@frontflow/persistence";
import { ApprovalBroker, PolicyEngine } from "@frontflow/policy";
import { WorkflowEngine, loadBuiltinWorkflows, type WorkflowDefinition } from "@frontflow/workflow-engine";
import {
  createBuiltinHandlers,
  createPersistentServices,
  createSessionRecorder,
  PromptLibrary,
  type FeatureRunInputs,
  type ImportedApiContract,
  type ImportedBaSpec,
  type NodeServices,
} from "@frontflow/workflow-nodes";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
const FIXTURES = join(REPO_ROOT, "tests/fixtures");
/** What the GoApp Figma plugin pushes from its FrontFlow button (go-figma `Handoff`). */
export const FIGMA_HANDOFF: FigmaHandoff = {
  id: "GF-TEST42",
  projectName: "Cancel order",
  fileName: "Cancel order",
  fileKey: "FILEKEY123",
  target: "react-tailwind",
  nodes: [{ id: "123:456", name: "Cancel Order Modal", width: 480 }],
  prompt: 'Implement this Figma design in this codebase, using the goapp-figma MCP server.\n\nFigma file "Cancel order":\n- "Cancel Order Modal" (node id 123:456)',
  createdAt: "2026-10-22T08:00:00.000Z",
};

export interface Harness {
  dir: string;
  projectRoot: string;
  db: FrontflowDb;
  artifacts: ArtifactStore;
  services: NodeServices;
  sessions: SessionManager;
  approvals: ApprovalBroker;
  definition: WorkflowDefinition;
  projectId: string;
  newEngine(): WorkflowEngine;
  /** `importLater`: the documents are supplied to A.api_contract / C1.ba_spec instead of being pinned at creation. */
  createRunInputs(options?: { baFixture?: string; allowAssumptions?: boolean; importLater?: boolean }): FeatureRunInputs;
  importApi(fixture?: string): ImportedApiContract;
  importBa(fixture?: string): ImportedBaSpec;
  dispose(): Promise<void>;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
}

/** Wires every real package together around a temp git copy of the sample app. */
/** `aiFixture`: canned AI answers the fake CLI returns for the analysis steps (tests/fixtures/alignment/<name>/ai). */
export async function createHarness(options: { aiFixture?: string } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "frontflow-it-"));
  const projectRoot = join(dir, "sample-app");
  cpSync(join(FIXTURES, "sample-app"), projectRoot, { recursive: true });
  git(projectRoot, "init", "-q", "-b", "main");
  git(projectRoot, "add", "-A");
  git(projectRoot, "commit", "-q", "-m", "initial");

  const db = openDatabase(join(dir, "database.sqlite"));
  const artifacts = new ArtifactStore({ rootDir: join(dir, "appdata"), db });
  const projectId = "sample-app";
  db.projects.upsert({ id: projectId, name: "sample-app", rootPath: projectRoot, createdAt: nowIso(), lastOpenedAt: nowIso() });
  const { profile } = await analyzeProject(projectRoot, { projectId });
  db.profiles.save(profile);

  const approvals = new ApprovalBroker();
  const policy = new PolicyEngine({ networkAllowlist: ["figma-bridge"] });

  const recorder = createSessionRecorder(db, artifacts);
  const sessions = new SessionManager([
    new FakeCliAdapter({ scriptPath: join(FIXTURES, "fake-cli/fake-cli.mjs"), sessionEnv: {
      FAKE_CLI_STATE_DIR: join(dir, "fake-cli-state"),
      ...(options.aiFixture ? { FAKE_CLI_OUTPUTS_DIR: join(FIXTURES, "alignment", options.aiFixture, "ai") } : {}),
    } }),
  ]);
  sessions.subscribeAll((e) => recorder.onEvent(e));
  sessions.onRaw((sessionId, chunk) => recorder.onRaw(sessionId, chunk));

  const services = createPersistentServices({
    db,
    artifactStore: artifacts,
    agents: {
      start: (id, input) => sessions.startSession(id, input),
      resume: (id, input) => sessions.resumeSession(id, input),
      cancel: (id) => sessions.cancel(id),
      subscribeAll: (handler) => sessions.subscribeAll(handler),
    },
    figma: { serverPath: () => undefined },
    prompts: new PromptLibrary({ defaultsDir: join(REPO_ROOT, "workflows", "prompts"), userDir: join(dir, "prompts") }),
    policy,
    approvals,
    mcpConfigDir: join(dir, "mcp"),
    scratchDir: join(dir, "scratch"),
    settings: () => ({ allowArbitraryShell: false, commandTimeoutMs: 60_000, agentTimeoutMs: 60_000, fixBudget: 1 }),
  });
  const definition = loadBuiltinWorkflows(join(REPO_ROOT, "workflows"));
  const handlers = createBuiltinHandlers(services);
  const engines: WorkflowEngine[] = [];
  const snap = (fixture: string, type: "ba_markdown" | "api_markdown", file: string) => {
    const content = readFileSync(join(FIXTURES, "alignment", fixture, file), "utf8");
    const { snapshot, text } = snapshotDocument({ type, content, sourceUri: file });
    artifacts.saveSnapshotContent(projectId, snapshot, text);
    return snapshot;
  };
  function importApi(fixture = "cancel-order"): ImportedApiContract {
    return { api: { snapshotId: snap(fixture, "api_markdown", "api.md").id, sourceUri: "api.md", kind: "markdown" } };
  }
  function importBa(fixture = "cancel-order"): ImportedBaSpec {
    return { ba: { snapshotId: snap(fixture, "ba_markdown", "ba.md").id, sourceUri: "ba.md" } };
  }


  return {
    dir,
    projectRoot,
    db,
    artifacts,
    services,
    sessions,
    approvals,
    definition,
    projectId,
    newEngine() {
      const engine = new WorkflowEngine({
        store: db.runStore,
        handlers,
        sleep: async () => {},
      });
      engine.registerDefinition(definition);
      engines.push(engine);
      return engine;
    },
    importApi,
    importBa,
    createRunInputs(options = {}) {
      const docs = options.importLater ? undefined : { ...importApi(options.baFixture), ...importBa(options.baFixture) };
      return {
        snapshotIds: docs ? [docs.api.snapshotId, docs.ba.snapshotId] : [],
        gitBaseSha: git(projectRoot, "rev-parse", "HEAD").trim(),
        title: `Run ${newId("t")}`,
        ...(docs ?? {}),
        figma: { handoff: FIGMA_HANDOFF },
        adapterId: "fake",
        allowAssumptions: options.allowAssumptions ?? false,
      };
    },
    async dispose() {
      for (const engine of engines) engine.shutdown();
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
