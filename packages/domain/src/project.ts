/** Spec §10.2 */
export type QualityGateRequirement = "required" | "optional" | "disabled";

export interface DetectedValue<T> {
  value: T;
  /** 0..1 */
  confidence: number;
  /** Human-readable evidence, e.g. "package.json dependencies.next@14.2.0". */
  evidence: string[];
  /** True when the user overrode the detected value. */
  overridden?: boolean;
}

export interface ProjectCommands {
  install?: string;
  dev?: string;
  build?: string;
  typecheck?: string;
  lint?: string;
  unitTest?: string;
  e2e?: string;
  [name: string]: string | undefined;
}

export interface ProjectProfile {
  schemaVersion: 1;
  projectId: string;
  rootPath: string;
  framework?: string;
  language?: string;
  packageManager?: string;
  uiLibrary?: string;
  apiClient?: string;
  stateManagement?: string;
  testFrameworks: string[];
  commands: ProjectCommands;
  qualityGates: Record<string, QualityGateRequirement | string>;
  /** AI agents always work in the project folder itself; checkpoints are hidden git snapshots. */
  git: {
    defaultBaseBranch: string;
  };
  conventionDocs: string[];
  /** Per-field detection metadata. Keys match the profile field names. */
  detection: Record<string, DetectedValue<unknown>>;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  lastOpenedAt: string;
}
