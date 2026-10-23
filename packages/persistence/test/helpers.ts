import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeRun, Project, ProjectProfile, WorkflowRun } from "@frontflow/domain";
import type { FrontflowDb } from "../src/index.js";

export function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "frontflow-persistence-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function project(id = "proj_1", lastOpenedAt = "2026-10-01T00:00:00.000Z"): Project {
  return { id, name: `Project ${id}`, rootPath: `D:/work/${id}`, createdAt: "2026-09-01T00:00:00.000Z", lastOpenedAt };
}

export function profile(projectId = "proj_1", framework = "next"): ProjectProfile {
  return {
    schemaVersion: 1,
    projectId,
    rootPath: `D:/work/${projectId}`,
    framework,
    language: "typescript",
    packageManager: "pnpm",
    testFrameworks: ["vitest", "playwright"],
    commands: { install: "pnpm install", typecheck: "pnpm tsc --noEmit", unitTest: "pnpm vitest run" },
    qualityGates: { typecheck: "required", e2e: "optional" },
    git: { defaultBaseBranch: "main" },
    conventionDocs: ["CLAUDE.md"],
    detection: {
      framework: { value: framework, confidence: 0.95, evidence: ["package.json dependencies.next@14.2.0"] },
    },
  };
}

export function run(id = "run_1", overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id,
    projectId: "proj_1",
    workflowId: "workflow-a",
    workflowVersion: 1,
    status: "running",
    traceId: `trace_${id}`,
    inputs: { snapshotIds: ["snap_ba", "snap_api"], gitBaseSha: "abc123" },
    createdAt: "2026-10-01T10:00:00.000Z",
    startedAt: "2026-10-01T10:00:01.000Z",
    ...overrides,
  };
}

export function nodeRun(id: string, overrides: Partial<NodeRun> = {}): NodeRun {
  return {
    id,
    workflowRunId: "run_1",
    nodeId: "A.EXTRACT_BA",
    nodeType: "extract_business_requirements",
    nodeVersion: 1,
    status: "pending",
    attempt: 1,
    ...overrides,
  };
}

export function seedProjectAndRun(db: FrontflowDb, runOverrides: Partial<WorkflowRun> = {}): WorkflowRun {
  db.projects.upsert(project());
  const r = run("run_1", runOverrides);
  db.runStore.saveRun(r);
  return r;
}
