export type ArtifactKind =
  | "document"
  | "prompt"
  | "log"
  | "diff"
  | "screenshot"
  | "test_result"
  | "evidence"
  | "package"
  | "figma_snapshot";

export type RetentionPolicy = "keep" | "run_lifetime" | "days_30" | "days_7";

/** Spec §18.2 */
export interface ArtifactRecord {
  id: string;
  projectId: string;
  workflowRunId?: string;
  nodeRunId?: string;
  kind: ArtifactKind;
  /** Path relative to the app data root. */
  relativePath: string;
  contentHash: string;
  mimeType: string;
  source: string;
  sizeBytes: number;
  createdAt: string;
  retentionPolicy: RetentionPolicy;
}

export interface TestResult {
  id: string;
  workflowRunId: string;
  nodeRunId?: string;
  suite: string;
  kind: "unit" | "component" | "contract" | "integration" | "e2e" | "accessibility" | "visual";
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  scenarioIds: string[];
  artifactId?: string;
}

export interface GitCheckpoint {
  id: string;
  workflowRunId: string;
  nodeRunId?: string;
  /** The project folder the AI agents work in (the user's checkout). */
  projectPath: string;
  branch: string;
  baseSha: string;
  headSha: string;
  createdAt: string;
}
