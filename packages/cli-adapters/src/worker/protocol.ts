import type { AgentEvent } from "@frontflow/event-schema";
import type { AdapterDetection, ManagedSession } from "../session-manager.js";
import type { ResumeSessionInput, StartSessionInput } from "../types.js";
import type { OpenTerminalInput } from "../terminal.js";

/**
 * Minimal message-port shape. Matches Electron's `process.parentPort`
 * (messages arrive as `{ data }`) and `UtilityProcess` (messages arrive raw).
 */
export interface RunnerPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  off?(event: "message", listener: (message: unknown) => void): unknown;
}

type Req<T extends string, P = object> = { requestId: string; type: T } & P;

export type RunnerRequest =
  | Req<"start", { adapterId: string; input: StartSessionInput }>
  | Req<"resume", { adapterId: string; input: ResumeSessionInput }>
  | Req<"send", { sessionId: string; message: string }>
  | Req<"approve", { sessionId: string; approvalId: string }>
  | Req<"reject", { sessionId: string; approvalId: string }>
  | Req<"cancel", { sessionId: string }>
  | Req<"close", { sessionId: string }>
  | Req<"detect">
  | Req<"list">
  | Req<"terminal.open", { input: OpenTerminalInput }>
  | Req<"terminal.write", { terminalId: string; data: string }>
  | Req<"terminal.resize", { terminalId: string; cols: number; rows: number }>
  | Req<"terminal.close", { terminalId: string }>;

export type RunnerRequestType = RunnerRequest["type"];

/** Result type for each request. */
export interface RunnerResults {
  start: ManagedSession;
  resume: ManagedSession;
  send: void;
  approve: void;
  reject: void;
  cancel: void;
  close: void;
  detect: AdapterDetection[];
  list: ManagedSession[];
  "terminal.open": { terminalId: string; pid: number; command: string };
  "terminal.write": void;
  "terminal.resize": void;
  "terminal.close": void;
}

export interface RunnerError {
  code?: string;
  message: string;
}

export type RunnerResponse =
  | { type: "response"; requestId: string; ok: true; result: unknown }
  | { type: "response"; requestId: string; ok: false; error: RunnerError };

export type RunnerMessage =
  | RunnerResponse
  | { type: "event"; event: AgentEvent }
  | { type: "raw"; sessionId: string; chunk: string }
  | { type: "terminal.data"; terminalId: string; data: string }
  | { type: "terminal.exit"; terminalId: string; exitCode: number | null };

export const RUNNER_REQUEST_TYPES: readonly RunnerRequestType[] = [
  "start",
  "resume",
  "send",
  "approve",
  "reject",
  "cancel",
  "close",
  "detect",
  "list",
  "terminal.open",
  "terminal.write",
  "terminal.resize",
  "terminal.close",
];

/** Unwraps `{ data }` envelopes (MessageEvent / parentPort) to the payload. */
export function unwrapPortMessage(message: unknown): unknown {
  if (
    typeof message === "object" &&
    message !== null &&
    "data" in message &&
    !("type" in message)
  ) {
    return (message as { data: unknown }).data;
  }
  return message;
}

export function isRunnerRequest(value: unknown): value is RunnerRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.requestId !== "string" || typeof v.type !== "string") return false;
  if (!(RUNNER_REQUEST_TYPES as readonly string[]).includes(v.type)) return false;
  switch (v.type) {
    case "start":
    case "resume":
      return typeof v.adapterId === "string" && typeof v.input === "object" && v.input !== null;
    case "send":
      return typeof v.sessionId === "string" && typeof v.message === "string";
    case "approve":
    case "reject":
      return typeof v.sessionId === "string" && typeof v.approvalId === "string";
    case "cancel":
    case "close":
      return typeof v.sessionId === "string";
    case "terminal.open": {
      const i = v.input as Record<string, unknown> | null;
      return !!i && typeof i === "object" && typeof i.terminalId === "string" && typeof i.adapterId === "string" && typeof i.cwd === "string";
    }
    case "terminal.write":
      return typeof v.terminalId === "string" && typeof v.data === "string";
    case "terminal.resize":
      return typeof v.terminalId === "string" && typeof v.cols === "number" && typeof v.rows === "number";
    case "terminal.close":
      return typeof v.terminalId === "string";
    default:
      return true;
  }
}

export function isRunnerMessage(value: unknown): value is RunnerMessage {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return t === "response" || t === "event" || t === "raw" || t === "terminal.data" || t === "terminal.exit";
}
