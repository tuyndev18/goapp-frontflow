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
    /** Claude Code steps run as this saved account (its own config folder) instead of the machine's login. */
    claudeAccountId: id.optional(),
    /** Claude Code `--model`: an alias (fable, opus, sonnet, haiku) or a full model id; default: Claude Code's own. */
    model: z.string().trim().max(80).regex(/^[A-Za-z0-9._\[\]-]+$/).optional(),
    /** Claude Code `--effort`; default: Claude Code's own. */
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
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
  "sessions:cancel": z.object({ sessionId: id }),
  "sessions:rawLog": z.object({ sessionId: id }),
  // Claude Code logins of this machine (Accounts screen). Tokens never cross IPC.
  "accounts:state": z.void(),
  /** Stores the login `claude` uses now as an account. */
  "accounts:captureCurrent": z.object({ label: z.string().trim().max(80).optional() }),
  /** Runs `claude auth login` in an isolated config folder, so the current login is untouched. */
  "accounts:startLogin": z.object({
    /** Claude subscription logins only: Console (API key) logins have no account to switch. */
    method: z.enum(["claudeai", "sso"]).default("claudeai"),
    email: z.string().trim().email().max(200).optional(),
    label: z.string().trim().max(80).optional(),
    cols: z.number().int().min(20).max(400).default(110),
    rows: z.number().int().min(5).max(200).default(28),
  }),
  "accounts:cancelLogin": z.object({ loginId: id }),
  /** Makes the account the machine-wide `claude` login. */
  "accounts:switch": z.object({ accountId: id }),
  "accounts:remove": z.object({ accountId: id }),
  "accounts:rename": z.object({ accountId: id, label: z.string().trim().max(80) }),
  /** Asks for fresh quota/profile data now (rate-limited per account). */
  "accounts:refresh": z.object({ accountId: id.optional() }),
  /** A claude-swap style command line (`list`, `switch 2`, `add --login` …), as the `ffswap` CLI takes. */
  "accounts:command": z.object({ line: z.string().max(500) }),
  /** Usage dashboard: local Claude transcripts of the last `days` days + quota history. */
  "accounts:usage": z.object({ days: z.number().int().min(1).max(30).default(30) }),
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
  // Every AI step is an editable prompt (workflows/prompts/<step id>.md); "_system" is the system prompt.
  "prompts:get": z.object({ name: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/) }),
  "prompts:save": z.object({ name: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/), text: z.string().max(200_000) }),
  "prompts:reset": z.object({ name: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/) }),
  "settings:get": z.void(),
  "settings:update": z.object({
    rawTerminalLogs: z.boolean().optional(),
    defaultAdapterId: z.string().max(64).optional(),
    maxConcurrentNodes: z.number().int().min(1).max(8).optional(),
    retentionDays: z.number().int().min(1).max(365).optional(),
    allowArbitraryShell: z.boolean().optional(),
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
/** An AI step's editable prompt. */
export interface PromptDto {
  name: string;
  text: string;
  /** The user changed it; `defaultText` is the version shipped with FrontFlow. */
  customized: boolean;
  defaultText: string;
  /** `{{name}}` placeholders the step fills in when it runs. */
  placeholders: string[];
}

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

export interface SessionDto {
  id: string;
  adapterId: string;
  externalSessionId?: string;
  status: string;
  cwd: string;
  startedAt: string;
  workflowRunId?: string;
  nodeRunId?: string;
}

/** Token counts read from this machine's Claude transcripts, attributed by which account was logged in. */
export interface LocalUsageDto {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  messages: number;
  /** Estimate from a versioned price table; a lower bound when `unpricedModels` is not empty. */
  estimatedCostUsd: number;
  unpricedModels: string[];
  last24h: { tokens: number; estimatedCostUsd: number };
  last7d: { tokens: number; estimatedCostUsd: number };
  lastMessageAt?: string;
}

export interface QuotaWindowDto {
  key: string;
  label: string;
  /** 0–100. */
  utilization: number;
  resetsAt?: string;
  /** Usage expected by now at an even pace through the window. */
  expectedPct?: number;
  aheadOfPace?: boolean;
  /** At the current rate the window runs out then, before it resets. */
  projectedExhaustionAt?: string;
  willLastToReset?: boolean;
  /** Its reset passed since the last reading: shown at 0%, not asked again. */
  resetSinceCheck?: boolean;
}

/** A stored Claude login. Never carries a token. */
export interface AccountDto {
  id: string;
  label?: string;
  email?: string;
  displayName?: string;
  organizationName?: string;
  organizationUuid?: string;
  subscriptionType?: string;
  rateLimitTier?: string;
  billingType?: string;
  /** The machine-wide `claude` login right now. */
  active: boolean;
  /** access_expired: refreshed on next use; needs_login: the refresh token is past its expiry. */
  status: "ok" | "access_expired" | "needs_login";
  /** live: Claude Code's own login; vault: parked; profile: in its own Claude config folder for runs; lost: replaced outside FrontFlow before it was parked. */
  location?: "live" | "vault" | "profile" | "lost";
  addedAt: string;
  lastActivatedAt?: string;
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
  /** Provider-reported quota (unofficial endpoint, may disappear). */
  /** source: api = FrontFlow asked Anthropic; statusline = a Claude Code session passed it (no request). */
  quota?: { windows: QuotaWindowDto[]; extra?: Record<string, string | number | boolean | null>; fetchedAt: string; source?: "api" | "statusline" };
  quotaError?: { code: string; message: string; at: string };
  profile?: Record<string, string | number | boolean | null>;
  localUsage?: LocalUsageDto;
  /** Claude processes started while this account was logged in. */
  runningProcesses: number;
}

export interface ClaudeProcessDto {
  pid: number;
  name: string;
  startedAt?: string;
  /** Shortened, redacted command line. */
  command: string;
  /** Account logged in when the process started (it keeps that login until restarted). */
  accountId?: string | null;
}

export interface AccountsStateDto {
  supported: boolean;
  unsupportedReason?: string;
  /** Saved logins are stored, but not as safely as they should be (e.g. Linux without a keyring). */
  vaultWarning?: string;
  /** Where Claude Code keeps the live login on this OS. */
  liveStore: "file" | "macos-keychain";
  configDir: string;
  accounts: AccountDto[];
  live: {
    loggedIn: boolean;
    accountId?: string;
    /** The live login is one of the stored accounts. */
    known: boolean;
    email?: string;
    organizationName?: string;
    subscriptionType?: string;
    /** Token and identity file disagree (e.g. a running claude wrote back an older login). */
    mismatch?: string;
  };
  processes: ClaudeProcessDto[];
  /** Quota read from Claude Code's status line instead of asking Anthropic. */
  statusLine?: { available: boolean; reason?: string; installed: boolean; chained?: string; settingsPath: string; lastReadingAt?: string; error?: string };
  /** Usage from before tracking began or while an unknown login was active. */
  unattributedUsage?: LocalUsageDto;
  trackingSince?: string;
  usageScannedAt?: string;
  logins: Array<{ loginId: string; terminalId: string; method: string; startedAt: string }>;
}

/** Token counts of a slice of messages. `tokens` = all input (cache included) + output. */
export interface UsageTotalsDto {
  tokens: number;
  freshInput: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  messages: number;
}

/** % used of each quota window (key → 0–100) at one successful poll. */
export interface QuotaPointDto {
  at: string;
  accountId: string;
  windows: Record<string, number>;
}

export interface UsageReportDto {
  generatedAt: string;
  days: number;
  totals: { today: UsageTotalsDto; last7d: UsageTotalsDto; period: UsageTotalsDto };
  /** Oldest first. Map keys: account id ("" = not attributed to a saved account) and model id. */
  daily: Array<{ date: string; total: UsageTotalsDto; byAccount: Record<string, number>; byModel: Record<string, number> }>;
  models: Array<UsageTotalsDto & { model: string }>;
  accounts: Array<UsageTotalsDto & { accountId: string | null }>;
  projects: Array<UsageTotalsDto & { project: string; lastAt: string }>;
  sessions: Array<UsageTotalsDto & { sessionId: string; project: string; model?: string; firstAt: string; lastAt: string }>;
  unpricedModels: string[];
  quotaHistory: QuotaPointDto[];
  trackingSince?: string;
}

export interface AccountSwitchResult {
  accountId: string;
  /** Running `claude` processes keep the previous login until restarted. */
  restartRequired: boolean;
  runningProcesses: number;
  warnings: string[];
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
  "sessions:cancel": void;
  "sessions:rawLog": string;
  "accounts:state": AccountsStateDto;
  "accounts:captureCurrent": AccountDto;
  "accounts:startLogin": { loginId: string; terminalId: string };
  "accounts:cancelLogin": void;
  "accounts:switch": AccountSwitchResult;
  "accounts:remove": void;
  "accounts:rename": void;
  "accounts:refresh": void;
  "accounts:command": { ok: boolean; output: string };
  "accounts:usage": UsageReportDto;
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
  "prompts:get": PromptDto;
  "prompts:save": PromptDto;
  "prompts:reset": PromptDto;
  "settings:get": SettingsDto;
  "settings:update": SettingsDto;
}

/** Push channels main → renderer. */
export interface IpcPushEvents {
  "run:event": EventDto;
  "run:state": RunStateDto;
  "session:event": EventDto;
  "session:raw": { sessionId: string; chunk: string };
  "accounts:changed": AccountsStateDto;
  /** End of an `accounts:startLogin` flow. */
  "accounts:login": { loginId: string; status: "succeeded" | "failed" | "cancelled"; accountId?: string; message?: string };
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
  "accounts:changed",
  "accounts:login",
  "figma:status",
  "approval:requested",
  "terminal:data",
  "terminal:exit",
];

export type { PolicyDecision, TestResult };
