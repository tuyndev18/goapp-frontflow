import { newId, nowIso } from "@frontflow/domain";
import type { AgentEventOf, AgentEventType } from "./agent-events.js";
import type { EngineEventOf, EngineEventType } from "./engine-events.js";
import type { AgentEvent } from "./agent-events.js";
import type { EngineEvent } from "./engine-events.js";

export interface EventContext {
  traceId: string;
  workflowRunId: string;
  nodeRunId?: string;
  sessionId?: string;
}

export function createAgentEvent<T extends AgentEventType>(
  type: T,
  ctx: EventContext,
  payload: AgentEventOf<T>["payload"],
  confidence?: number,
): AgentEventOf<T> {
  const event = {
    id: newId("evt"),
    type,
    timestamp: nowIso(),
    ...ctx,
    payload,
    ...(confidence === undefined ? {} : { confidence }),
  };
  return event as unknown as AgentEventOf<T>;
}

export function createEngineEvent<T extends EngineEventType>(
  type: T,
  ctx: EventContext,
  payload: EngineEventOf<T>["payload"],
): EngineEventOf<T> {
  return { id: newId("evt"), type, timestamp: nowIso(), ...ctx, payload } as unknown as EngineEventOf<T>;
}

export type AnyEvent = AgentEvent | EngineEvent;
