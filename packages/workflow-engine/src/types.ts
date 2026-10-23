import type { NodeRun, RetryPolicy, RunStore, WorkflowRun } from "@frontflow/domain";
import type { AnyEvent } from "@frontflow/event-schema";
import type { NodeHandlerRegistry } from "./handlers.js";

/**
 * Branch condition evaluated against the output of a direct dependency.
 * Without a comparator the value at `path` is tested for truthiness.
 * A condition on a dependency that did not pass (e.g. skipped) is false.
 */
export interface NodeCondition {
  node: string;
  /** Dotted path into the dependency output, e.g. "provider.available". Omit for the whole output. */
  path?: string;
  equals?: unknown;
  notEquals?: unknown;
  in?: unknown[];
  exists?: boolean;
}

export type JoinMode = "all" | "any";

export interface WorkflowNodeSpec {
  id: string;
  type: string;
  label: string;
  group?: string;
  description?: string;
  dependencies: string[];
  retryPolicy: RetryPolicy;
  timeoutMs: number;
  /** Writes code: at most one mutation node runs per run at a time, since agents share the project folder (spec §19.2). */
  mutation: boolean;
  /** Output is a pure function of its inputs and may be reused by idempotency key (spec §17.3). */
  readOnly: boolean;
  when?: NodeCondition;
  joinMode?: JoinMode;
  requiresCapabilities?: string[];
  config?: Record<string, unknown>;
  version: number;
}

export interface WorkflowDefinition {
  id: string;
  version: number;
  name: string;
  description?: string;
  /** Node ids from other workflow files this definition depends on; resolved by composeWorkflows. */
  requires?: string[];
  /** Optional run-level timeout; exceeding it moves the run to `timed_out`. */
  timeoutMs?: number;
  /** Set by composeWorkflows. */
  composedFrom?: Array<{ id: string; version: number }>;
  nodes: WorkflowNodeSpec[];
}

export interface NodeInput {
  /** Run inputs (snapshot ids, git base SHA, ...). */
  inputs: WorkflowRun["inputs"];
  /** Outputs of every passed ancestor node (transitive), keyed by node id. */
  upstream: Record<string, unknown>;
  config: Record<string, unknown>;
  /** Data supplied through `provideInput` after the node returned `waiting_for_input`. */
  providedInput?: unknown;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ArtifactRef {
  artifactId: string;
  kind: string;
  label?: string;
}

export interface NodeExecutionContext {
  runId: string;
  projectId: string;
  nodeId: string;
  nodeRunId: string;
  nodeType: string;
  attempt: number;
  traceId: string;
  /** Aborted on cancel, pause, node timeout or run timeout. */
  signal: AbortSignal;
  log(level: LogLevel, message: string, data?: unknown): void;
  emitArtifact(artifact: ArtifactRef): void;
  /** Forwards an agent/engine event; run/trace/nodeRun ids are filled in by the engine. */
  emit(event: AnyEvent): void;
}

export interface NodeFailure {
  code: string;
  message: string;
  retryable?: boolean;
}

export type NodeResult =
  | { status: "passed"; output: unknown; assumed?: boolean }
  | { status: "blocked"; summary: string; output?: unknown }
  | { status: "waiting_for_input"; prompt: string; output?: unknown }
  | { status: "failed"; error: NodeFailure };

export interface NodeHandler {
  execute(ctx: NodeExecutionContext, input: NodeInput): Promise<NodeResult>;
}

export interface RunState {
  run: WorkflowRun;
  nodes: NodeRun[];
}

export interface BeforeMutationContext {
  run: WorkflowRun;
  node: WorkflowNodeSpec;
  nodeRun: NodeRun;
  signal: AbortSignal;
}

export interface WorkflowEngineOptions {
  store: RunStore;
  handlers: NodeHandlerRegistry;
  /** Max nodes executing concurrently per run. Default 4. A function is read on every scheduling pass. */
  maxConcurrency?: number | (() => number);
  clock?: () => Date;
  /** Used for retry backoff. Must reject or resolve promptly when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Runs before every mutation node attempt (e.g. verify git base SHA). May throw NodeError. */
  beforeMutation?: (ctx: BeforeMutationContext) => void | Promise<void>;
  /** Internal failures (store errors, throwing listeners). Defaults to console.error. */
  onError?: (error: unknown, runId: string) => void;
}

export interface StartRunInput {
  projectId: string;
  definition: WorkflowDefinition;
  inputs: WorkflowRun["inputs"];
}
