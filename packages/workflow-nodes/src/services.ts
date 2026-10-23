import type { ArtifactKind, GitCheckpoint, ProjectProfile, SourceSnapshot, TestResult } from "@frontflow/domain";
import type { AgentEvent } from "@frontflow/event-schema";
import type { ManagedSession, OpenTerminalInput, ResumeSessionInput, StartSessionInput } from "@frontflow/cli-adapters";
import type { FigmaHandoff } from "@frontflow/figma-mcp-bridge";
import type { ApprovalBroker, PolicyEngine } from "@frontflow/policy";
import type { PromptSource } from "./prompt-library.js";
import type { SkillSource } from "./skills.js";

/**
 * Everything the built-in node handlers need from the host. The desktop main
 * process wires these to SQLite, the artifact store, the CLI runner utility
 * process and the GoApp Figma MCP server; integration tests wire in-process fakes.
 */
export interface NodeServices {
  getProject(projectId: string): ProjectContext | Promise<ProjectContext>;
  saveProfile?(projectId: string, profile: ProjectProfile): void | Promise<void>;
  /** Immutable snapshot content pinned to the run (spec §3.4). */
  readSnapshot(projectId: string, snapshotId: string): StoredSnapshot | Promise<StoredSnapshot>;
  artifacts: ArtifactWriter;
  recordTestResult?(result: TestResult): void | Promise<void>;
  saveCheckpoint?(checkpoint: GitCheckpoint): void | Promise<void>;
  agents: AgentBackend;
  /** PTY terminals in the CLI runner; with it, Claude steps can run as visible interactive sessions. */
  terminals?: TerminalBackend;
  figma?: GoFigmaService;
  /** Skills the user attached to each workflow step; agent steps add them to the prompt. */
  skills?: SkillSource;
  /** The editable prompt of every AI step (workflows/prompts defaults + the user's edits). */
  prompts: PromptSource;
  policy: PolicyEngine;
  approvals: ApprovalBroker;
  settings(): HostSettings;
  /** Checks whether the real backend answers (provider verification, spec §15.1). */
  probeProvider?(baseUrl: string, signal: AbortSignal): Promise<boolean>;
  /**
   * The `CLAUDE_CONFIG_DIR` that runs Claude Code as a saved account (its own login, kept and
   * renewed there by Claude Code); undefined: the machine's login is that account already.
   */
  claudeProfileFor?(accountId: string): Promise<string | undefined>;
  /** Directory for per-session MCP config files. */
  mcpConfigDir: string;
  /** Per-run working directories for AI steps that must not touch the project (e.g. document analysis). */
  scratchDir: string;
}

export interface StoredSnapshot {
  snapshot: SourceSnapshot;
  text: string;
}

export interface ProjectContext {
  rootPath: string;
  profile?: ProjectProfile;
}

/** GoApp Figma: the go-figma plugin and its MCP server (see @frontflow/figma-mcp-bridge goapp-figma.ts). */
export interface GoFigmaService {
  /** dist/mcp.mjs, given to AI CLIs as the goapp-figma MCP server; undefined when not configured or found. */
  serverPath(): string | undefined;
}

export interface HostSettings {
  allowArbitraryShell: boolean;
  commandTimeoutMs: number;
  agentTimeoutMs: number;
  /** Times the quality-gate node may ask the AI to diagnose and fix before reporting blocked. */
  fixBudget: number;
}

export interface ArtifactWriter {
  write(input: {
    projectId: string;
    runId?: string;
    nodeRunId?: string;
    kind: ArtifactKind;
    name: string;
    content: string | Uint8Array;
    mimeType: string;
    source: string;
  }): { id: string } | Promise<{ id: string }>;
}

/** Common shape of the in-process SessionManager and the utility-process RunnerClient. */
export interface AgentBackend {
  start(adapterId: string, input: StartSessionInput): Promise<ManagedSession>;
  resume(adapterId: string, input: ResumeSessionInput): Promise<ManagedSession>;
  cancel(sessionId: string): Promise<void>;
  subscribeAll(handler: (event: AgentEvent) => void): () => void;
}

/** The runner's PTY terminals (the same ones used for human takeover). */
export interface TerminalBackend {
  open(input: OpenTerminalInput): Promise<{ terminalId: string; pid: number; command: string }>;
  close(terminalId: string): Promise<void>;
  onExit(handler: (terminalId: string, exitCode: number | null) => void): () => void;
  /** Claude Code's config directory; transcripts live under `projects/`. */
  claudeConfigDir: string;
}

/** provideInput payload for A.api_contract: a snapshot created by the host from the uploaded contract. */
export interface ImportedApiContract {
  api: { snapshotId: string; sourceUri?: string; kind: "markdown" | "openapi" };
}

/** provideInput payload for C1.ba_spec: a snapshot created by the host from the uploaded BA specification. */
export interface ImportedBaSpec {
  ba: { snapshotId: string; sourceUri?: string };
}

/** Run inputs recorded at run creation (see apps/desktop RunService). */
export interface FeatureRunInputs {
  snapshotIds: string[];
  gitBaseSha?: string;
  title?: string;
  /** Documents can be pinned at creation or imported later into C1.ba_spec / A.api_contract. */
  ba?: ImportedBaSpec["ba"];
  api?: ImportedApiContract["api"];
  /** Selection pinned at creation; otherwise A.figma_scope waits for one pushed from the plugin. */
  figma?: { handoff: FigmaHandoff };
  adapterId: string;
  /** Claude Code steps run as this saved account (its own config folder) instead of the machine's login. */
  claudeAccountId?: string;
  /** Model of every AI step (an alias such as `opus`, or a full model id); default: the CLI's own setting. */
  model?: string;
  /** Reasoning effort of every AI step: low | medium | high | xhigh | max; default: the CLI's own setting. */
  effort?: string;
  allowAssumptions: boolean;
  /** Optional base URL of a running backend for provider verification. */
  providerBaseUrl?: string;
  [key: string]: unknown;
}
