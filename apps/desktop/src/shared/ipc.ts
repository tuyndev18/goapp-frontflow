import { z } from "zod";
import type {
  AcceptanceTestCasePackage,
  ArtifactRecord,
  FeReadinessPackage,
  TestTraceabilityItem,
  UiApiTraceabilityItem,
  NodeRun,
  PolicyDecision,
  Project,
  ProjectProfile,
  TestResult,
  WorkflowRun,
} from "@frontflow/domain";
import type { FigmaHandoff } from "@frontflow/figma-mcp-bridge";

/**
 * Typed IPC contract between renderer and main (spec §9). Every request payload
 * is validated with the zod schema in main before it reaches a service.
 */

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:\-]+$/);
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const skillName = z.string().trim().min(1).max(64);

export const uploadedDocumentSchema = z.object({
  name: z.string().min(1).max(260),
  content: z.string().min(1).max(MAX_DOC_BYTES),
});


export const requestSchemas = {
  "app:info": z.void(),
  "projects:list": z.void(),
  "projects:open": z.void(),
  "projects:get": z.object({ projectId: id }),
  "projects:analyze": z.object({ projectId: id }),
  "projects:overrideProfile": z.object({
    projectId: id,
    overrides: z.record(z.string().max(64), z.union([z.string().max(500), z.record(z.string().max(64), z.string().max(500))])),
  }),
  "projects:remove": z.object({ projectId: id }),
  "projects:gitStatus": z.object({ projectId: id }),
  "clis:detect": z.void(),
  // A feature run starts with a name only; documents and Figma frames are supplied to their workflow steps.
  "runs:create": z.object({
    projectId: id,
    title: z.string().trim().min(1).max(200),
  }),
  // One document per step: the API contract for A.api_contract, the BA specification for C1.ba_spec.
  "runs:importDocuments": z
    .object({
      runId: id,
      nodeId: id,
      ba: uploadedDocumentSchema.optional(),
      api: uploadedDocumentSchema.extend({ kind: z.enum(["markdown", "openapi"]).default("markdown") }).optional(),
    })
    .refine((v) => !!v.ba !== !!v.api, { message: "Import exactly one document: ba or api" }),
  "runs:list": z.object({ projectId: id }),
  "runs:delete": z.object({ runId: id }),
  "runs:get": z.object({ runId: id }),
  "runs:pause": z.object({ runId: id }),
  "runs:resume": z.object({ runId: id }),
  "runs:cancel": z.object({ runId: id }),
  "runs:retryNode": z.object({ runId: id, nodeId: id }),
  "runs:provideInput": z.object({ runId: id, nodeId: id, data: z.record(z.string(), z.unknown()) }),
  "runs:events": z.object({ runId: id, nodeRunId: id.optional(), limit: z.number().int().min(1).max(5000).default(500) }),
  "runs:traceability": z.object({ runId: id }),
  "runs:gapReport": z.object({ runId: id }),
  "runs:artifacts": z.object({ runId: id, nodeRunId: id.optional() }),
  "runs:readArtifact": z.object({ artifactId: id }),
  "sessions:list": z.object({ projectId: id }),
  "sessions:usage": z.object({ projectId: id }),
  // A session started from the Sessions screen, outside any workflow run.
  "sessions:create": z
    .object({
      projectId: id,
      adapterId: z.string().min(1).max(64),
      /** chat: headless structured session kept open for more prompts; terminal: the CLI's own TUI in a PTY. */
      mode: z.enum(["chat", "terminal"]),
      title: z.string().trim().max(120).optional(),
      prompt: z.string().max(100_000).optional(),
      model: z.string().trim().max(120).optional(),
      /** plan: Claude may read but not change files. */
      permissionMode: z.enum(["acceptEdits", "plan"]).default("acceptEdits"),
      /** worktree: a fresh git worktree and branch for this session only. */
      workspace: z.enum(["project", "worktree"]).default("project"),
      cols: z.number().int().min(20).max(400).default(120),
      rows: z.number().int().min(5).max(200).default(32),
    })
    .refine((v) => v.mode === "terminal" || !!v.prompt?.trim(), { message: "A chat session starts with a first message" }),
  "sessions:events": z.object({ sessionIds: z.array(id).min(1).max(50), limit: z.number().int().min(1).max(5000).default(2000) }),
  "sessions:send": z.object({ sessionId: id, message: z.string().min(1).max(100_000) }),
  "sessions:cancel": z.object({ sessionId: id }),
  /** Ends a chat session after its current turn, or closes a terminal session's CLI. */
  "sessions:close": z.object({ sessionId: id }),
  "sessions:resume": z.object({ sessionId: id, prompt: z.string().max(100_000).optional() }),
  /** Opens (or returns the already open) CLI TUI for a session; it stays open when the pane is closed. */
  "sessions:openTerminal": z.object({ sessionId: id, cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }),
  "sessions:rename": z.object({ sessionId: id, title: z.string().trim().min(1).max(120) }),
  /** Deletes a standalone conversation (every session resumed from it). */
  "sessions:delete": z.object({ sessionId: id, removeWorktree: z.boolean().default(false), force: z.boolean().default(false) }),
  "sessions:rawLog": z.object({ sessionId: id }),
  "terminal:open": z.object({ sessionId: id, cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }),
  "terminal:snapshot": z.object({ terminalId: id }),
  "terminal:write": z.object({ terminalId: id, data: z.string().max(65_536) }),
  "terminal:resize": z.object({ terminalId: id, cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }),
  "terminal:close": z.object({ terminalId: id }),
  "approvals:list": z.void(),
  "approvals:decide": z.object({ requestId: id, approved: z.boolean() }),
  "figma:status": z.void(),
  "skills:list": z.void(),
  "skills:get": z.object({ name: skillName }),
  "skills:save": z.object({
    previousName: skillName.optional(),
    name: skillName,
    description: z.string().max(1024),
    body: z.string().max(500_000),
  }),
  "skills:delete": z.object({ name: skillName }),
  "skills:import": z.void(),
  "skills:assign": z.object({ nodeId: id, skills: z.array(skillName).max(50) }),
  "skills:openFolder": z.object({ name: skillName.optional() }),
  "settings:get": z.void(),
  "settings:update": z.object({
    rawTerminalLogs: z.boolean().optional(),
    defaultAdapterId: z.string().max(64).optional(),
    maxConcurrentNodes: z.number().int().min(1).max(8).optional(),
    retentionDays: z.number().int().min(1).max(365).optional(),
    allowArbitraryShell: z.boolean().optional(),
    interactiveAgents: z.boolean().optional(),
    goFigmaServerPath: z.string().max(1024).optional(),
  }),
} as const;

export type IpcChannel = keyof typeof requestSchemas;
export type IpcRequest<C extends IpcChannel> = z.input<(typeof requestSchemas)[C]>;

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  dataDir: string;
}

export interface CliStatus {
  adapterId: string;
  label: string;
  installed: boolean;
  version?: string;
  binaryPath?: string;
  error?: string;
  capabilities?: Record<string, boolean>;
}

export interface ProjectSummary extends Project {
  framework?: string;
  packageManager?: string;
  lastRun?: { id: string; status: string; createdAt: string; title?: string };
  health: "ok" | "warning" | "unknown";
}

export interface GitStatusDto {
  isRepo: boolean;
  branch?: string;
  baseSha?: string;
  clean?: boolean;
  dirtyFiles?: string[];
  untrackedFiles?: string[];
  warnings: string[];
}

export interface GraphNodeDto {
  id: string;
  label: string;
  type: string;
  group?: string;
  description?: string;
  mutation?: boolean;
  /** The step runs an AI CLI agent. */
  ai?: boolean;
}
export interface GraphEdgeDto {
  id: string;
  source: string;
  target: string;
  conditional: boolean;
}

export interface RunSummary {
  id: string;
  title: string;
  status: WorkflowRun["status"];
  createdAt: string;
  finishedAt?: string;
}

/** Traceability Matrix data (spec §20.1 #6), read from the run's package artifacts. */
export interface TraceabilityDto {
  readiness: FeReadinessPackage | null;
  tests: AcceptanceTestCasePackage | null;
  /** Written by C2.evidence_report once the acceptance tests ran. */
  trace: {
    verificationLevel: string;
    ui: Array<UiApiTraceabilityItem & { name: string }>;
    tests: Array<TestTraceabilityItem & { title: string }>;
    sourceFiles: string[];
    evidenceIds: string[];
  } | null;
}

export interface RunStateDto {
  run: WorkflowRun & { title?: string };
  nodeRuns: NodeRun[];
  graph: { nodes: GraphNodeDto[]; edges: GraphEdgeDto[] };
}

export interface EventDto {
  id: string;
  type: string;
  timestamp: string;
  workflowRunId: string;
  nodeRunId?: string;
  sessionId?: string;
  confidence?: number;
  payload: unknown;
}

/**
 * Normalized state (orthogonal to how recent the activity is). "unknown": the record says
 * running but no runner process holds it; "stalled": working without activity for minutes.
 */
export type SessionStateDto = "starting" | "working" | "waiting_user" | "idle" | "stalled" | "ended" | "error" | "unknown";

export interface SessionEvidenceDto {
  /** structured_log: the CLI's own event stream; process: terminal output timing only. */
  source: "structured_log" | "process" | "record";
  confidence: "high" | "medium" | "low";
}

export interface UsageDto {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimate from token counts and a versioned price table; a lower bound when `unpricedModels` is not empty. */
  estimatedCostUsd: number;
  /** Cost the CLI reported itself, when it does. */
  sourceCostUsd?: number;
  pricingVersion: string;
  models: string[];
  unpricedModels: string[];
  basis: "fine" | "total";
}

export interface SessionDto {
  id: string;
  adapterId: string;
  externalSessionId?: string;
  /** Raw record status (running/completed/failed/cancelled for older screens). */
  status: string;
  cwd: string;
  startedAt: string;
  workflowRunId?: string;
  nodeRunId?: string;
  title?: string;
  /** structured: event stream (chat); pty: the CLI's TUI in a terminal. */
  mode: "structured" | "pty";
  model?: string;
  state: SessionStateDto;
  evidence: SessionEvidenceDto;
  /** Detail of the current state, e.g. the running tool or why the session ended. */
  stateDetail?: string;
  lastActivityAt?: string;
  endedAt?: string;
  /** A runner process currently holds this session (chat process or open terminal). */
  live: boolean;
  /** Open terminal of a terminal session, to attach a pane to. */
  terminalId?: string;
  /** First session of the conversation: resumes share it. */
  rootSessionId: string;
  /** Git worktree created for the session, when it has its own. */
  worktreePath?: string;
  usage?: UsageDto;
}

export interface SessionDeleteResult {
  deleted: number;
  worktree: "removed" | "kept" | "none";
}

export interface ApprovalDto {
  requestId: string;
  permission: string;
  action: string;
  detail?: string;
  source: string;
  createdAt: string;
}

/** GoApp Figma: the MCP server (go-figma dist/mcp.mjs) given to AI CLIs, and the selection pushed from the plugin. */
export interface FigmaStatusDto {
  serverPath?: string;
  /** settings: Settings path; detected: the goapp-figma entry in Claude Code / Codex / Cursor config. */
  source: "settings" | "detected" | "none";
  /** A path is set in Settings but the file isn't there. */
  error?: string;
  /** Connected to the GoApp Figma hub, so the plugin's FrontFlow button reaches this app. */
  listening: boolean;
  /** The latest selection pushed from the plugin. */
  handoff?: FigmaHandoff;
}

/** A skill of the library: a folder with SKILL.md, in the format Claude Code and Codex use. */
export interface SkillSummaryDto {
  name: string;
  description: string;
  /** Other files of the skill folder (templates, scripts, references). */
  files: string[];
  updatedAt: string;
}
export interface SkillDto extends SkillSummaryDto {
  /** SKILL.md without its frontmatter. */
  body: string;
  dir: string;
}
/** A workflow step that runs an AI CLI, so skills can be attached to it. */
export interface SkillNodeDto {
  id: string;
  label: string;
  group?: string;
  description?: string;
}
export interface SkillsStateDto {
  /** The library folder. */
  dir: string;
  skills: SkillSummaryDto[];
  nodes: SkillNodeDto[];
  /** nodeId → skill names. */
  assignments: Record<string, string[]>;
}

export interface SettingsDto {
  rawTerminalLogs: boolean;
  defaultAdapterId: string;
  /** Workflow nodes (so AI CLI sessions) running at once per run. Low keeps subscription usage paced. */
  maxConcurrentNodes: number;
  retentionDays: number;
  allowArbitraryShell: boolean;
  /** Claude Code steps open a real interactive session (shown in AI terminals) instead of `claude -p`. */
  interactiveAgents: boolean;
  /** Path of go-figma's dist/mcp.mjs; empty = use the goapp-figma entry of an agent config. */
  goFigmaServerPath: string;
}

export interface IpcResponses {
  "app:info": AppInfo;
  "projects:list": ProjectSummary[];
  "projects:open": ProjectSummary | null;
  "projects:get": { project: Project; profile?: ProjectProfile; warnings: string[] };
  "projects:analyze": { project: Project; profile: ProjectProfile; warnings: string[] };
  "projects:overrideProfile": { project: Project; profile: ProjectProfile; warnings: string[] };
  "projects:remove": void;
  "projects:gitStatus": GitStatusDto;
  "clis:detect": CliStatus[];
  "runs:create": RunStateDto;
  "runs:importDocuments": void;
  "runs:list": RunSummary[];
  "runs:delete": void;
  "runs:get": RunStateDto;
  "runs:pause": void;
  "runs:resume": void;
  "runs:cancel": void;
  "runs:retryNode": void;
  "runs:provideInput": void;
  "runs:events": EventDto[];
  "runs:traceability": TraceabilityDto;
  "runs:gapReport": string | null;
  "runs:artifacts": ArtifactRecord[];
  "runs:readArtifact": { record: ArtifactRecord; text?: string; dataUrl?: string };
  "sessions:list": SessionDto[];
  "sessions:usage": UsageDto;
  "sessions:create": SessionDto;
  "sessions:events": EventDto[];
  "sessions:send": void;
  "sessions:cancel": void;
  "sessions:close": void;
  "sessions:resume": SessionDto;
  /** `sessionId`: the terminal session (a new one in the same conversation unless it was already open). */
  "sessions:openTerminal": { terminalId: string; command: string; sessionId: string };
  "sessions:rename": void;
  "sessions:delete": SessionDeleteResult;
  "sessions:rawLog": string;
  "terminal:open": { terminalId: string; command: string };
  "terminal:snapshot": { data: string; open: boolean };
  "terminal:write": void;
  "terminal:resize": void;
  "terminal:close": void;
  "approvals:list": ApprovalDto[];
  "approvals:decide": void;
  "figma:status": FigmaStatusDto;
  "skills:list": SkillsStateDto;
  "skills:get": SkillDto;
  "skills:save": SkillDto;
  "skills:delete": void;
  /** null when the folder dialog was cancelled. */
  "skills:import": { imported: string[]; skipped: Array<{ path: string; reason: string }> } | null;
  "skills:assign": Record<string, string[]>;
  "skills:openFolder": void;
  "settings:get": SettingsDto;
  "settings:update": SettingsDto;
}

/** Push channels main → renderer. */
export interface IpcPushEvents {
  "run:event": EventDto;
  "run:state": RunStateDto;
  "session:event": EventDto;
  "session:raw": { sessionId: string; chunk: string };
  /** A project's session list changed outside the agent event stream (created, deleted, terminal exit). */
  "sessions:changed": { projectId: string };
  "figma:status": FigmaStatusDto;
  "approval:requested": ApprovalDto;
  "terminal:data": { terminalId: string; data: string };
  "terminal:exit": { terminalId: string; exitCode: number | null };
}
export type IpcPushChannel = keyof IpcPushEvents;

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export interface FrontflowApi {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcRequest<C> extends void ? [] : [IpcRequest<C>]): Promise<IpcResponses[C]>;
  on<C extends IpcPushChannel>(channel: C, listener: (payload: IpcPushEvents[C]) => void): () => void;
}

export const PUSH_CHANNELS: readonly IpcPushChannel[] = [
  "run:event",
  "run:state",
  "session:event",
  "session:raw",
  "sessions:changed",
  "figma:status",
  "approval:requested",
  "terminal:data",
  "terminal:exit",
];

export type { PolicyDecision, TestResult };
