import type { NodeRunStatus, WorkflowRunStatus } from "@frontflow/domain";
import type { BaseEvent } from "./agent-events.js";

export interface NodeStatusChangedPayload {
  nodeId: string;
  nodeRunId: string;
  status: NodeRunStatus;
  previous?: NodeRunStatus;
  attempt: number;
  waitingOn?: string[];
  error?: { code: string; message: string };
  assumed?: boolean;
  blockerSummary?: string;
}

/** Events emitted by the workflow engine itself (one trace per run, spec §21). */
export type EngineEvent =
  | BaseEvent<"run.status_changed", { status: WorkflowRunStatus; previous?: WorkflowRunStatus; reason?: string }>
  | BaseEvent<"node.status_changed", NodeStatusChangedPayload>
  | BaseEvent<"node.log", { nodeId: string; level: "debug" | "info" | "warn" | "error"; message: string; data?: unknown }>
  | BaseEvent<"node.artifact", { nodeId: string; artifactId: string; kind: string; label?: string }>
  | BaseEvent<"node.output", { nodeId: string; outputHash: string; cached: boolean }>;

export type EngineEventType = EngineEvent["type"];
export type EngineEventOf<T extends EngineEventType> = Extract<EngineEvent, { type: T }>;
