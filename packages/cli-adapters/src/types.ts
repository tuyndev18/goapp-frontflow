import type { AgentEvent } from "@frontflow/event-schema";

/** Spec §16.1 */
export interface AiCliAdapter {
  readonly id: string;

  detect(): Promise<CliDetectionResult>;
  capabilities(): Promise<CliCapabilities>;
  start(input: StartSessionInput): Promise<AiSession>;
  resume(input: ResumeSessionInput): Promise<AiSession>;
  send(sessionId: string, message: string): Promise<void>;
  approve(sessionId: string, requestId: string): Promise<void>;
  reject(sessionId: string, requestId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  subscribe(sessionId: string, handler: AgentEventHandler): Unsubscribe;
  /** How to run the CLI's own interactive UI, optionally resuming a conversation (human takeover). */
  interactiveLaunch?(input: InteractiveLaunchInput): InteractiveLaunch | undefined;
}

export interface InteractiveLaunchInput {
  externalSessionId?: string;
  /** Start a fresh conversation under this id, when the CLI lets the caller choose it (so it can be resumed later). */
  newSessionId?: string;
  /** Folder the CLI starts in; Claude skips its broken project settings files (see claudeProjectSettingsProblems). */
  cwd?: string;
}

export interface InteractiveLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Parent variables the CLI needs on top of the minimal allow-list (config dirs, endpoints). */
  inheritKeys?: readonly string[];
}

export interface CliDetectionResult {
  installed: boolean;
  binaryPath?: string;
  version?: string;
  error?: string;
}

/** Spec §16.2 */
export interface CliCapabilities {
  structuredEvents: boolean;
  resumableSessions: boolean;
  mcp: boolean;
  toolApprovals: boolean;
  modelSelection: boolean;
  usageReporting: boolean;
  imageInput: boolean;
}

export interface StartSessionInput {
  cwd: string;
  prompt: string;
  traceId: string;
  workflowRunId: string;
  nodeRunId?: string;
  model?: string;
  /** Reasoning effort: low | medium | high | xhigh | max (Claude Code's `--effort`). */
  effort?: string;
  systemPrompt?: string;
  mcpConfigPath?: string;
  /** Extra env for the CLI. Secrets (API keys) go here — never in argv (spec §9.3). */
  env?: Record<string, string>;
  allowedTools?: string[];
  /** Tools the CLI must not use at all (e.g. shells for document-only steps). */
  disallowedTools?: string[];
  timeoutMs?: number;
  permissionMode?: string;
  /**
   * Keep the session open after the turn queue drains so more prompts can be
   * sent; the session then ends on `close()` (or cancel). Default false: the
   * session completes once every queued prompt has produced a result.
   */
  keepAlive?: boolean;
}

export interface ResumeSessionInput extends Omit<StartSessionInput, "prompt"> {
  externalSessionId: string;
  prompt?: string;
}

export type AiSessionStatus = "starting" | "running" | "completed" | "failed" | "cancelled";

export interface AiSession {
  id: string;
  adapterId: string;
  externalSessionId?: string;
  status: AiSessionStatus;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  pid?: number;
  rawLogPath?: string;
}

export type AgentEventHandler = (event: AgentEvent) => void;
export type Unsubscribe = () => void;

/** Raw (already redacted) output chunk from a CLI process (spec §16.4 "Lưu raw stream"). */
export type RawChunkHandler = (sessionId: string, chunk: string) => void;

/** Optional extension implemented by process-backed adapters. */
export interface ProcessBackedAdapter {
  onProcessExit(sessionId: string, handler: (exitCode: number | null) => void): Unsubscribe;
  onRaw(handler: RawChunkHandler): Unsubscribe;
  getSession(sessionId: string): AiSession | undefined;
  close(sessionId: string): Promise<void>;
}

export type AdapterErrorCode =
  | "NOT_INSTALLED"
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_ACTIVE"
  | "NOT_SUPPORTED"
  | "UNKNOWN_APPROVAL"
  | "ADAPTER_NOT_FOUND"
  | "SPAWN_FAILED"
  | "TERMINAL_ALREADY_OPEN"
  | "TERMINAL_NOT_FOUND"
  | "PTY_UNAVAILABLE";

export class AdapterError extends Error {
  constructor(
    readonly code: AdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export function isProcessBackedAdapter(a: AiCliAdapter): a is AiCliAdapter & ProcessBackedAdapter {
  const x = a as Partial<ProcessBackedAdapter>;
  return typeof x.onProcessExit === "function" && typeof x.onRaw === "function";
}
