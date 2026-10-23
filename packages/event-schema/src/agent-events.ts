/** Spec §16.3 — normalized agent events emitted by every AI CLI adapter. */
export interface BaseEvent<TType extends string, TPayload> {
  id: string;
  type: TType;
  timestamp: string;
  traceId: string;
  workflowRunId: string;
  nodeRunId?: string;
  sessionId?: string;
  /**
   * 0..1. Present when the event was inferred from unstructured output
   * (PTY fallback, spec §16.4). Absent means the CLI reported it structurally.
   */
  confidence?: number;
  payload: TPayload;
}

export type AgentSessionStatus =
  | "starting"
  | "idle"
  | "thinking"
  | "running_tool"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface SessionStartedPayload {
  adapterId: string;
  /** The CLI's own session id, used to resume. */
  externalSessionId?: string;
  model?: string;
  cwd: string;
}
export interface StatusChangedPayload {
  status: AgentSessionStatus;
  detail?: string;
}
export interface MessageDeltaPayload {
  role: "assistant" | "user" | "system";
  text: string;
}
export interface ToolStartedPayload {
  toolCallId: string;
  name: string;
  input?: unknown;
}
export interface ToolCompletedPayload {
  toolCallId: string;
  name: string;
  ok: boolean;
  output?: unknown;
}
export interface ApprovalPayload {
  requestId: string;
  action: string;
  permissionClass?: string;
  detail?: string;
}
export interface FileChangedPayload {
  path: string;
  change: "created" | "modified" | "deleted";
}
export interface CommandStartedPayload {
  commandId: string;
  command: string;
  cwd?: string;
}
export interface CommandCompletedPayload {
  commandId: string;
  command: string;
  exitCode: number | null;
  durationMs?: number;
}
export interface TestResultPayload {
  suite: string;
  passed: number;
  failed: number;
  skipped: number;
}
/**
 * `inputTokens` counts every input token, cached ones included; the cache fields
 * are the parts of it read from / written to the prompt cache.
 */
export interface UsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Cost the CLI itself reported (Claude `total_cost_usd`). */
  costUsd?: number;
  model?: string;
  /**
   * What the numbers cover. "message": one API message (dedup by `messageId`, last
   * report wins); "turn": one CLI turn; "total" (default): everything so far, which
   * analytics only use when a session reported nothing finer.
   */
  scope?: "message" | "turn" | "total";
  messageId?: string;
}
export interface SessionCompletedPayload {
  externalSessionId?: string;
  result?: string;
  exitCode?: number | null;
}
export interface SessionFailedPayload {
  code: string;
  message: string;
  exitCode?: number | null;
}

export type AgentEvent =
  | BaseEvent<"session.started", SessionStartedPayload>
  | BaseEvent<"status.changed", StatusChangedPayload>
  | BaseEvent<"message.delta", MessageDeltaPayload>
  | BaseEvent<"tool.started", ToolStartedPayload>
  | BaseEvent<"tool.completed", ToolCompletedPayload>
  | BaseEvent<"approval.required", ApprovalPayload>
  | BaseEvent<"file.changed", FileChangedPayload>
  | BaseEvent<"command.started", CommandStartedPayload>
  | BaseEvent<"command.completed", CommandCompletedPayload>
  | BaseEvent<"test.result", TestResultPayload>
  | BaseEvent<"usage.updated", UsagePayload>
  | BaseEvent<"session.completed", SessionCompletedPayload>
  | BaseEvent<"session.failed", SessionFailedPayload>;

export type AgentEventType = AgentEvent["type"];

export const AGENT_EVENT_TYPES: readonly AgentEventType[] = [
  "session.started",
  "status.changed",
  "message.delta",
  "tool.started",
  "tool.completed",
  "approval.required",
  "file.changed",
  "command.started",
  "command.completed",
  "test.result",
  "usage.updated",
  "session.completed",
  "session.failed",
];

export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;
