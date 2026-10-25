import { TERMINAL_NODE_STATUSES, TERMINAL_RUN_STATUSES, hashJson, newId } from "@frontflow/domain";
import type { NodeRun, NodeRunStatus, RetryPolicy, RunStore, WorkflowRun, WorkflowRunStatus } from "@frontflow/domain";
import { createEngineEvent, redact } from "@frontflow/event-schema";
import type { AnyEvent, NodeStatusChangedPayload } from "@frontflow/event-schema";
import { ancestorsOf, descendantsOf, evaluateCondition, topologicalOrder, validateWorkflowDefinition } from "./definition.js";
import { ERROR_CODES, NodeError, WorkflowEngineError, isNeverRetryable, toNodeFailure } from "./errors.js";
import type { NodeHandlerRegistry } from "./handlers.js";
import type {
  NodeExecutionContext,
  NodeFailure,
  NodeInput,
  NodeResult,
  RunState,
  StartRunInput,
  WorkflowDefinition,
  WorkflowEngineOptions,
  WorkflowNodeSpec,
} from "./types.js";

/**
 * Key inside `WorkflowRun.inputs` where data supplied through `provideInput` is persisted
 * (so it survives restarts). It is excluded from `NodeInput.inputs` and from input hashes.
 */
export const PROVIDED_INPUTS_KEY = "__providedInputs";

export type EngineListener = (event: AnyEvent) => void;

export interface RecoverResult {
  recovered: string[];
  /** Active runs whose definition (workflowId@version) was not registered. */
  missingDefinitions: Array<{ runId: string; workflowId: string; workflowVersion: number }>;
}

type AbortReason = "pause" | "cancel" | "timeout" | "run_timeout" | "shutdown";

interface Execution {
  controller: AbortController;
  abortReason?: AbortReason;
}

interface RunRuntime {
  run: WorkflowRun;
  definition: WorkflowDefinition;
  specs: Map<string, WorkflowNodeSpec>;
  order: string[];
  ancestors: Map<string, string[]>;
  nodes: Map<string, NodeRun>;
  executions: Map<string, Execution>;
  backoffs: Map<string, AbortController>;
  mutationHolder: string | undefined;
  queue: Promise<void>;
  pendingTasks: number;
  waiters: Array<(state: RunState) => void>;
  runTimer: ReturnType<typeof setTimeout> | undefined;
  disposed: boolean;
}

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_BASE_DELAY_MS = 1000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
const FAILED_LIKE: ReadonlySet<NodeRunStatus> = new Set(["failed", "blocked", "cancelled"]);
const RERUNNABLE: ReadonlySet<NodeRunStatus> = new Set(["failed", "blocked", "passed", "waiting_for_input"]);
const IN_FLIGHT: ReadonlySet<NodeRunStatus> = new Set(["running", "retrying"]);

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    if (ms <= 0) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Resolves/rejects with `promise`, or rejects as soon as `signal` aborts (for handlers that ignore the signal). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function backoffDelayMs(policy: RetryPolicy, failedAttempt: number): number {
  const base = policy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  let delay: number;
  switch (policy.backoff) {
    case "none":
      delay = 0;
      break;
    case "linear":
      delay = base * failedAttempt;
      break;
    case "exponential":
      delay = base * 2 ** (failedAttempt - 1);
      break;
  }
  return Math.min(delay, MAX_BACKOFF_MS);
}

function isResult(value: unknown): value is NodeResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  switch (v.status) {
    case "passed":
      return "output" in v;
    case "blocked":
      return typeof v.summary === "string";
    case "waiting_for_input":
      return typeof v.prompt === "string";
    case "failed":
      return !!v.error && typeof v.error === "object" && typeof (v.error as Record<string, unknown>).code === "string";
    default:
      return false;
  }
}

function definitionKey(id: string, version: number): string {
  return `${id}@${version}`;
}

/**
 * DAG workflow runtime (spec §17). All state transitions of a run are serialized through a
 * per-run task queue, persisted to the RunStore and only then published as events.
 *
 * Dependency semantics:
 * - joinMode "all" (default): runs once every dependency is passed or skipped and at least one passed.
 * - joinMode "any": runs as soon as one dependency passed.
 * - A node whose dependencies are all skipped, or whose `when` condition is false, is skipped.
 * - Dependents of failed/blocked nodes stay `waiting_for_dependency` while the run can still make
 *   progress; once nothing else can run (and no node waits for input) they become `blocked` with a
 *   blockerSummary naming the failed dependency. `retryNode` re-opens them.
 * `NodeRun.blockerSummary` carries the reason for blocked/skipped nodes and the prompt of
 * `waiting_for_input` nodes.
 */
export class WorkflowEngine {
  private readonly store: RunStore;
  private readonly handlers: NodeHandlerRegistry;
  private readonly concurrencyLimit: () => number;
  private readonly clock: () => Date;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly beforeMutation: WorkflowEngineOptions["beforeMutation"];
  private readonly onError: (error: unknown, runId: string) => void;
  private readonly runtimes = new Map<string, RunRuntime>();
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private readonly listeners = new Set<EngineListener>();

  constructor(options: WorkflowEngineOptions) {
    this.store = options.store;
    this.handlers = options.handlers;
    const limit = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.concurrencyLimit = () => Math.max(1, Math.floor(typeof limit === "function" ? limit() : limit) || 1);
    this.clock = options.clock ?? (() => new Date());
    this.sleep = options.sleep ?? defaultSleep;
    this.beforeMutation = options.beforeMutation;
    this.onError = options.onError ?? ((error, runId) => console.error(`[workflow-engine] run ${runId}:`, error));
  }

  // ---------------------------------------------------------------- public API

  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  registerDefinition(definition: WorkflowDefinition): void {
    validateWorkflowDefinition(definition);
    this.definitions.set(definitionKey(definition.id, definition.version), definition);
  }

  getDefinition(workflowId: string, version: number): WorkflowDefinition | undefined {
    return this.definitions.get(definitionKey(workflowId, version));
  }

  async startRun(input: StartRunInput): Promise<WorkflowRun> {
    const { definition } = input;
    this.registerDefinition(definition);
    const missing = [...new Set(definition.nodes.map((n) => n.type))].filter((type) => !this.handlers.has(type));
    if (missing.length > 0) {
      throw new WorkflowEngineError(ERROR_CODES.HANDLER_NOT_FOUND, `No handler registered for node type(s): ${missing.join(", ")}`);
    }

    const run: WorkflowRun = {
      id: newId("run"),
      projectId: input.projectId,
      workflowId: definition.id,
      workflowVersion: definition.version,
      status: "queued",
      traceId: newId("trace"),
      inputs: structuredClone(input.inputs),
      createdAt: this.now(),
    };
    const nodes = new Map<string, NodeRun>();
    for (const spec of definition.nodes) {
      nodes.set(spec.id, {
        id: newId("nr"),
        workflowRunId: run.id,
        nodeId: spec.id,
        nodeType: spec.type,
        nodeVersion: spec.version,
        status: "pending",
        attempt: 0,
      });
    }
    const rt = this.createRuntime(run, definition, nodes);

    await this.enqueue(rt, async () => {
      await this.store.saveRun(structuredClone(run));
      for (const id of rt.order) await this.store.saveNodeRun(structuredClone(this.node(rt, id)));
      await this.emit(rt, createEngineEvent("run.status_changed", this.eventCtx(rt), { status: "queued" }));
    });
    const snapshot = structuredClone(rt.run);
    void this.enqueue(rt, async () => {
      await this.setRunStatus(rt, "running", "started");
      this.armRunTimer(rt);
      await this.pump(rt);
    }).catch((error: unknown) => this.onError(error, run.id));
    return snapshot;
  }

  async pause(runId: string, reason = "paused by user"): Promise<RunState> {
    const rt = this.requireRuntime(runId);
    await this.enqueue(rt, async () => {
      if (rt.run.status === "paused") return;
      if (TERMINAL_RUN_STATUSES.has(rt.run.status)) {
        throw new WorkflowEngineError("INVALID_STATE", `Run ${runId} is ${rt.run.status} and cannot be paused`);
      }
      await this.setRunStatus(rt, "paused", reason);
      await this.stopActiveWork(rt, "pause");
    });
    return this.snapshot(rt);
  }

  async resume(runId: string): Promise<RunState> {
    const rt = this.requireRuntime(runId);
    await this.enqueue(rt, async () => {
      if (rt.run.status !== "paused") {
        throw new WorkflowEngineError("INVALID_STATE", `Run ${runId} is ${rt.run.status}, not paused`);
      }
      await this.setRunStatus(rt, "running", "resumed by user");
      await this.pump(rt);
    });
    return this.snapshot(rt);
  }

  async cancel(runId: string): Promise<RunState> {
    const rt = this.requireRuntime(runId);
    await this.enqueue(rt, async () => {
      if (TERMINAL_RUN_STATUSES.has(rt.run.status)) return;
      await this.terminate(rt, "cancel", "cancelled", "cancelled by user");
    });
    return this.snapshot(rt);
  }

  /**
   * Manually runs a node again with a fresh retry budget: a failed/blocked one, or a finished one
   * (passed, waiting for input) so it picks up an edited prompt. Its dependents were built from the
   * old output, so every one of them that already started is reset too, and what the user gave them
   * (an accepted gap, an answer) is dropped. `providedInput`, when given, replaces what the node
   * itself was given (a newer document, or `{}` to drop an earlier answer). A finished run is loaded
   * back from the store first.
   */
  async retryNode(runId: string, nodeId: string, providedInput?: Record<string, unknown>): Promise<RunState> {
    const rt = this.runtimes.get(runId) ?? (await this.loadFinishedRun(runId));
    await this.enqueue(rt, async () => {
      const node = this.requireNode(rt, nodeId);
      if (!RERUNNABLE.has(node.status)) {
        throw new WorkflowEngineError("INVALID_STATE", `Node ${nodeId} is ${node.status}; only failed, blocked, passed or waiting nodes can be run again`);
      }
      if (rt.run.status === "cancelled" || rt.run.status === "timed_out") {
        throw new WorkflowEngineError("INVALID_STATE", `Run ${runId} is ${rt.run.status} and cannot be retried`);
      }
      const descendants = descendantsOf(rt.definition, nodeId);
      const busy = rt.order.find((id) => descendants.has(id) && IN_FLIGHT.has(this.node(rt, id).status));
      if (busy) throw new WorkflowEngineError("INVALID_STATE", `Node ${busy} depends on ${nodeId} and is still running; wait for it to finish first`);
      await this.resetNode(rt, nodeId);
      for (const id of rt.order) {
        if (descendants.has(id) && this.node(rt, id).status !== "pending") await this.resetNode(rt, id);
      }
      const provided = { ...this.providedInputs(rt.run) };
      const stale = Object.keys(provided).filter((id) => descendants.has(id));
      for (const id of stale) delete provided[id];
      if (providedInput !== undefined) provided[nodeId] = structuredClone(providedInput);
      if (stale.length || providedInput !== undefined) {
        rt.run.inputs = { ...rt.run.inputs, [PROVIDED_INPUTS_KEY]: provided };
        await this.store.saveRun(structuredClone(rt.run));
      }
      if (rt.run.status !== "paused" && rt.run.status !== "running") {
        await this.setRunStatus(rt, "running", `manual retry of ${nodeId}`);
        this.armRunTimer(rt);
      }
      await this.pump(rt);
    });
    return this.snapshot(rt);
  }

  /** Supplies user data to a `waiting_for_input` node; the node is re-executed with `providedInput`. */
  async provideInput(runId: string, nodeId: string, data: unknown): Promise<RunState> {
    const rt = this.requireRuntime(runId);
    await this.enqueue(rt, async () => {
      const node = this.requireNode(rt, nodeId);
      if (node.status !== "waiting_for_input") {
        throw new WorkflowEngineError("INVALID_STATE", `Node ${nodeId} is ${node.status}, not waiting_for_input`);
      }
      if (TERMINAL_RUN_STATUSES.has(rt.run.status)) {
        throw new WorkflowEngineError("INVALID_STATE", `Run ${runId} is ${rt.run.status}`);
      }
      const provided = { ...this.providedInputs(rt.run), [nodeId]: structuredClone(data) };
      rt.run.inputs = { ...rt.run.inputs, [PROVIDED_INPUTS_KEY]: provided };
      await this.store.saveRun(structuredClone(rt.run));
      await this.updateNode(rt, nodeId, { status: "ready", attempt: 0, blockerSummary: undefined, error: undefined });
      if (rt.run.status === "waiting" || rt.run.status === "test_design_pending") await this.setRunStatus(rt, "running", `input provided for ${nodeId}`);
      await this.pump(rt);
    });
    return this.snapshot(rt);
  }

  /**
   * Restores active runs after a restart. Interrupted (`running`/`retrying`) nodes are re-queued as
   * `ready`; passed nodes keep their outputs; paused runs stay paused.
   */
  async recover(): Promise<RecoverResult> {
    const result: RecoverResult = { recovered: [], missingDefinitions: [] };
    for (const run of await this.store.listActiveRuns()) {
      if (this.runtimes.has(run.id)) continue;
      const rt = await this.loadRuntime(run);
      if (!rt) {
        result.missingDefinitions.push({ runId: run.id, workflowId: run.workflowId, workflowVersion: run.workflowVersion });
        continue;
      }
      await this.enqueue(rt, async () => {
        for (const id of rt.order) {
          const node = this.node(rt, id);
          if (node.status === "running") {
            await this.updateNode(rt, id, { status: "ready", attempt: Math.max(0, node.attempt - 1), startedAt: undefined });
          } else if (node.status === "retrying") {
            await this.updateNode(rt, id, { status: "ready" });
          }
        }
        if (rt.run.status !== "paused") {
          await this.setRunStatus(rt, "running", "recovered after restart", true);
          await this.pump(rt);
        }
        this.armRunTimer(rt);
      });
      result.recovered.push(run.id);
    }
    return result;
  }

  async getRunState(runId: string): Promise<RunState | undefined> {
    const rt = this.runtimes.get(runId);
    if (rt) return this.snapshot(rt);
    const run = await this.store.getRun(runId);
    if (!run) return undefined;
    return { run, nodes: await this.store.listNodeRuns(runId) };
  }

  /** Resolves once the run is terminal, waiting for input, or paused, with no transition in flight. */
  async waitForRun(runId: string): Promise<RunState> {
    const rt = this.runtimes.get(runId);
    if (!rt) {
      const state = await this.getRunState(runId);
      if (!state) throw new WorkflowEngineError("RUN_NOT_FOUND", `Unknown run ${runId}`);
      return state;
    }
    return new Promise<RunState>((resolve) => {
      rt.waiters.push(resolve);
      this.notifyWaiters(rt);
    });
  }

  /**
   * Detaches from all runs without changing persisted state (app shutdown). In-flight handlers are
   * aborted; `recover()` on a new engine resumes them.
   */
  shutdown(): void {
    for (const rt of this.runtimes.values()) {
      rt.disposed = true;
      if (rt.runTimer) clearTimeout(rt.runTimer);
      for (const exec of rt.executions.values()) {
        exec.abortReason = "shutdown";
        exec.controller.abort(new NodeError("ENGINE_SHUTDOWN", "Engine shut down"));
      }
      for (const backoff of rt.backoffs.values()) backoff.abort();
    }
    this.runtimes.clear();
  }

  // ---------------------------------------------------------------- runtime plumbing

  /** A finished run is not kept in memory (nor recovered after a restart) until a node of it is run again. */
  private async loadFinishedRun(runId: string): Promise<RunRuntime> {
    const run = await this.store.getRun(runId);
    if (!run) throw new WorkflowEngineError("RUN_NOT_FOUND", `Unknown run ${runId}`);
    if (run.status === "cancelled" || run.status === "timed_out") {
      throw new WorkflowEngineError("INVALID_STATE", `Run ${runId} is ${run.status} and cannot be retried`);
    }
    const rt = await this.loadRuntime(run);
    if (!rt) throw new WorkflowEngineError("RUN_NOT_FOUND", `Workflow ${run.workflowId} v${run.workflowVersion} of run ${runId} is no longer available`);
    return rt;
  }

  /** Rebuilds a persisted run's runtime; undefined when its workflow definition is no longer registered. */
  private async loadRuntime(run: WorkflowRun): Promise<RunRuntime | undefined> {
    const definition = this.getDefinition(run.workflowId, run.workflowVersion);
    if (!definition) return undefined;
    const stored = new Map((await this.store.listNodeRuns(run.id)).map((n) => [n.nodeId, n]));
    const nodes = new Map<string, NodeRun>();
    for (const spec of definition.nodes) {
      const node = stored.get(spec.id);
      if (node) {
        nodes.set(spec.id, node);
        continue;
      }
      const created: NodeRun = {
        id: newId("nr"),
        workflowRunId: run.id,
        nodeId: spec.id,
        nodeType: spec.type,
        nodeVersion: spec.version,
        status: "pending",
        attempt: 0,
      };
      nodes.set(spec.id, created);
      await this.store.saveNodeRun(structuredClone(created));
    }
    return this.createRuntime(run, definition, nodes);
  }

  private createRuntime(run: WorkflowRun, definition: WorkflowDefinition, nodes: Map<string, NodeRun>): RunRuntime {
    const order = topologicalOrder(definition);
    const rt: RunRuntime = {
      run,
      definition,
      specs: new Map(definition.nodes.map((n) => [n.id, n])),
      order,
      ancestors: new Map(order.map((id) => [id, order.filter((a) => ancestorsOf(definition, id).has(a))])),
      nodes,
      executions: new Map(),
      backoffs: new Map(),
      mutationHolder: undefined,
      queue: Promise.resolve(),
      pendingTasks: 0,
      waiters: [],
      runTimer: undefined,
      disposed: false,
    };
    this.runtimes.set(run.id, rt);
    return rt;
  }

  private enqueue<T>(rt: RunRuntime, task: () => Promise<T>): Promise<T> {
    rt.pendingTasks++;
    const result = rt.queue.then(() => (rt.disposed ? (undefined as T) : task()));
    rt.queue = result.then(
      () => undefined,
      () => undefined,
    );
    void rt.queue.then(() => {
      rt.pendingTasks--;
      this.notifyWaiters(rt);
    });
    return result;
  }

  /** Fire-and-forget variant for internal transitions. */
  private schedule(rt: RunRuntime, task: () => Promise<void>): void {
    this.enqueue(rt, task).catch((error: unknown) => this.onError(error, rt.run.id));
  }

  private notifyWaiters(rt: RunRuntime): void {
    if (rt.waiters.length === 0 || rt.pendingTasks > 0) return;
    const status = rt.run.status;
    const settled =
      TERMINAL_RUN_STATUSES.has(status) || ((status === "waiting" || status === "test_design_pending" || status === "paused") && rt.executions.size === 0);
    if (!settled) return;
    const waiters = rt.waiters.splice(0);
    const state = this.snapshot(rt);
    for (const resolve of waiters) resolve(state);
  }

  private snapshot(rt: RunRuntime): RunState {
    return { run: structuredClone(rt.run), nodes: rt.order.map((id) => structuredClone(this.node(rt, id))) };
  }

  private requireRuntime(runId: string): RunRuntime {
    const rt = this.runtimes.get(runId);
    if (!rt) throw new WorkflowEngineError("RUN_NOT_FOUND", `Run ${runId} is not loaded (call recover() after a restart)`);
    return rt;
  }

  private requireNode(rt: RunRuntime, nodeId: string): NodeRun {
    const node = rt.nodes.get(nodeId);
    if (!node) throw new WorkflowEngineError("NODE_NOT_FOUND", `Run ${rt.run.id} has no node ${nodeId}`);
    return node;
  }

  private node(rt: RunRuntime, nodeId: string): NodeRun {
    return this.requireNode(rt, nodeId);
  }

  private spec(rt: RunRuntime, nodeId: string): WorkflowNodeSpec {
    const spec = rt.specs.get(nodeId);
    if (!spec) throw new WorkflowEngineError("NODE_NOT_FOUND", `Definition ${rt.definition.id} has no node ${nodeId}`);
    return spec;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private eventCtx(rt: RunRuntime, nodeRunId?: string): { traceId: string; workflowRunId: string; nodeRunId?: string } {
    return nodeRunId === undefined
      ? { traceId: rt.run.traceId, workflowRunId: rt.run.id }
      : { traceId: rt.run.traceId, workflowRunId: rt.run.id, nodeRunId };
  }

  private async emit(rt: RunRuntime, event: AnyEvent): Promise<void> {
    const safe = redact(event);
    await this.store.appendEvent(safe);
    for (const listener of this.listeners) {
      try {
        listener(safe);
      } catch (error) {
        this.onError(error, rt.run.id);
      }
    }
  }

  private providedInputs(run: WorkflowRun): Record<string, unknown> {
    const value = run.inputs[PROVIDED_INPUTS_KEY];
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  }

  // ---------------------------------------------------------------- state transitions (run inside the queue)

  private async setRunStatus(
    rt: RunRuntime,
    status: WorkflowRunStatus,
    reason?: string,
    force = false,
    error?: { code: string; message: string },
  ): Promise<void> {
    const previous = rt.run.status;
    if (previous === status && !force) return;
    rt.run.status = status;
    if (status === "running" && !rt.run.startedAt) rt.run.startedAt = this.now();
    if (TERMINAL_RUN_STATUSES.has(status)) {
      rt.run.finishedAt = this.now();
      if (error) rt.run.error = error;
      if (rt.runTimer) clearTimeout(rt.runTimer);
      rt.runTimer = undefined;
    } else {
      delete rt.run.finishedAt;
      delete rt.run.error;
    }
    await this.store.saveRun(structuredClone(rt.run));
    const payload: { status: WorkflowRunStatus; previous?: WorkflowRunStatus; reason?: string } = { status, previous };
    if (reason !== undefined) payload.reason = reason;
    await this.emit(rt, createEngineEvent("run.status_changed", this.eventCtx(rt), payload));
  }

  private async updateNode(rt: RunRuntime, nodeId: string, patch: Partial<NodeRun>): Promise<void> {
    const node = this.node(rt, nodeId);
    const previous = node.status;
    const target = node as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete target[key];
      else target[key] = value;
    }
    await this.store.saveNodeRun(structuredClone(node));
    const payload: NodeStatusChangedPayload = {
      nodeId,
      nodeRunId: node.id,
      status: node.status,
      previous,
      attempt: node.attempt,
    };
    if (node.waitingOn) payload.waitingOn = node.waitingOn;
    if (node.error) payload.error = { code: node.error.code, message: node.error.message };
    if (node.assumed !== undefined) payload.assumed = node.assumed;
    if (node.blockerSummary !== undefined) payload.blockerSummary = node.blockerSummary;
    await this.emit(rt, createEngineEvent("node.status_changed", this.eventCtx(rt, node.id), payload));
  }

  private async resetNode(rt: RunRuntime, nodeId: string): Promise<void> {
    await this.updateNode(rt, nodeId, {
      status: "pending",
      attempt: 0,
      output: undefined,
      error: undefined,
      assumed: undefined,
      blockerSummary: undefined,
      waitingOn: undefined,
      resumeState: undefined,
      startedAt: undefined,
      finishedAt: undefined,
    });
  }

  private armRunTimer(rt: RunRuntime): void {
    const timeoutMs = rt.definition.timeoutMs;
    if (timeoutMs === undefined || rt.runTimer || TERMINAL_RUN_STATUSES.has(rt.run.status)) return;
    const started = Date.parse(rt.run.startedAt ?? rt.run.createdAt);
    const remaining = Math.max(0, started + timeoutMs - this.clock().getTime());
    rt.runTimer = setTimeout(() => {
      rt.runTimer = undefined;
      this.schedule(rt, async () => {
        if (TERMINAL_RUN_STATUSES.has(rt.run.status)) return;
        await this.terminate(rt, "run_timeout", "timed_out", `run exceeded timeout of ${timeoutMs}ms`, {
          code: ERROR_CODES.RUN_TIMEOUT,
          message: `Run exceeded timeout of ${timeoutMs}ms`,
        });
      });
    }, remaining);
  }

  /** Aborts executions and backoff timers. Paused work returns to `ready`. */
  private async stopActiveWork(rt: RunRuntime, reason: AbortReason): Promise<void> {
    const running = [...rt.executions.keys()];
    for (const exec of rt.executions.values()) {
      exec.abortReason = reason;
      exec.controller.abort(new NodeError(reason === "pause" ? "RUN_PAUSED" : "RUN_CANCELLED", `Run ${reason}`));
    }
    rt.executions.clear();
    rt.mutationHolder = undefined;
    const backingOff = [...rt.backoffs.keys()];
    for (const backoff of rt.backoffs.values()) backoff.abort();
    rt.backoffs.clear();
    if (reason !== "pause") return;
    for (const id of running) {
      const node = this.node(rt, id);
      await this.updateNode(rt, id, { status: "ready", attempt: Math.max(0, node.attempt - 1), startedAt: undefined });
    }
    for (const id of backingOff) {
      if (this.node(rt, id).status === "retrying") await this.updateNode(rt, id, { status: "ready" });
    }
  }

  private async terminate(
    rt: RunRuntime,
    reason: AbortReason,
    status: "cancelled" | "timed_out",
    message: string,
    error?: { code: string; message: string },
  ): Promise<void> {
    await this.stopActiveWork(rt, reason);
    const finishedAt = this.now();
    for (const id of rt.order) {
      if (!TERMINAL_NODE_STATUSES.has(this.node(rt, id).status)) {
        await this.updateNode(rt, id, { status: "cancelled", finishedAt, blockerSummary: message });
      }
    }
    await this.setRunStatus(rt, status, message, false, error);
  }

  /** Resolves dependencies, starts ready nodes and settles the run when nothing else can progress. */
  private async pump(rt: RunRuntime): Promise<void> {
    while (rt.run.status === "running" && !rt.disposed) {
      let progressed = await this.resolveWaitingNodes(rt);
      const maxConcurrency = this.concurrencyLimit();
      for (const id of rt.order) {
        if (rt.executions.size >= maxConcurrency) break;
        if (this.node(rt, id).status !== "ready") continue;
        const spec = this.spec(rt, id);
        if (spec.mutation && rt.mutationHolder !== undefined) continue;
        await this.startNode(rt, spec);
        progressed = true;
      }
      if (!progressed) break;
    }
    if (rt.run.status !== "running" || rt.disposed) return;
    const busy = rt.executions.size > 0 || rt.backoffs.size > 0 || rt.order.some((id) => this.node(rt, id).status === "ready");
    if (!busy) await this.settle(rt);
  }

  private async resolveWaitingNodes(rt: RunRuntime): Promise<boolean> {
    let progressed = false;
    for (const id of rt.order) {
      const node = this.node(rt, id);
      if (node.status !== "pending" && node.status !== "waiting_for_dependency") continue;
      const decision = this.decide(rt, this.spec(rt, id));
      if (decision.kind === "ready") {
        await this.updateNode(rt, id, { status: "ready", waitingOn: undefined });
        progressed = true;
      } else if (decision.kind === "skip") {
        await this.updateNode(rt, id, {
          status: "skipped",
          waitingOn: undefined,
          blockerSummary: decision.reason,
          finishedAt: this.now(),
        });
        progressed = true;
      } else if (node.status !== "waiting_for_dependency" || node.waitingOn?.join("\n") !== decision.waitingOn.join("\n")) {
        await this.updateNode(rt, id, { status: "waiting_for_dependency", waitingOn: decision.waitingOn });
      }
    }
    return progressed;
  }

  private decide(
    rt: RunRuntime,
    spec: WorkflowNodeSpec,
  ): { kind: "ready" } | { kind: "skip"; reason: string } | { kind: "wait"; waitingOn: string[] } {
    const deps = spec.dependencies.map((id) => ({ id, status: this.node(rt, id).status }));
    const passed = deps.filter((d) => d.status === "passed");
    const skipped = deps.filter((d) => d.status === "skipped");
    const failedLike = deps.filter((d) => FAILED_LIKE.has(d.status));
    const unresolved = deps.filter((d) => d.status !== "passed" && d.status !== "skipped");
    const waitingOn = unresolved.map((d) => d.id);

    if (deps.length > 0) {
      if ((spec.joinMode ?? "all") === "any") {
        if (passed.length === 0) {
          return skipped.length === deps.length ? { kind: "skip", reason: "all dependencies were skipped" } : { kind: "wait", waitingOn };
        }
      } else {
        if (unresolved.length > 0 || failedLike.length > 0) return { kind: "wait", waitingOn };
        if (passed.length === 0) return { kind: "skip", reason: "all dependencies were skipped" };
      }
    }

    if (spec.when) {
      const target = this.node(rt, spec.when.node);
      if (!TERMINAL_NODE_STATUSES.has(target.status)) return { kind: "wait", waitingOn: [spec.when.node] };
      if (target.status !== "passed") return { kind: "skip", reason: `condition source ${spec.when.node} did not pass` };
      if (!evaluateCondition(spec.when, target.output)) {
        const path = spec.when.path ? `${spec.when.node}.${spec.when.path}` : spec.when.node;
        return { kind: "skip", reason: `condition on ${path} not met` };
      }
    }
    return { kind: "ready" };
  }

  private buildInput(rt: RunRuntime, spec: WorkflowNodeSpec): NodeInput {
    const { [PROVIDED_INPUTS_KEY]: provided, ...inputs } = rt.run.inputs;
    const upstream: Record<string, unknown> = {};
    for (const id of rt.ancestors.get(spec.id) ?? []) {
      const node = this.node(rt, id);
      if (node.status === "passed") upstream[id] = node.output;
    }
    const input: NodeInput = {
      inputs: structuredClone(inputs) as WorkflowRun["inputs"],
      upstream: structuredClone(upstream),
      config: structuredClone(spec.config ?? {}),
    };
    const providedForNode = (provided as Record<string, unknown> | undefined)?.[spec.id];
    if (providedForNode !== undefined) input.providedInput = structuredClone(providedForNode);
    return input;
  }

  private async startNode(rt: RunRuntime, spec: WorkflowNodeSpec): Promise<void> {
    const input = this.buildInput(rt, spec);
    const inputHash = hashJson(input);
    const idempotencyKey = hashJson({ nodeId: spec.id, nodeType: spec.type, nodeVersion: spec.version, inputHash });

    if (spec.readOnly && !spec.mutation) {
      const cached = await this.store.getCachedOutput(idempotencyKey);
      if (cached) {
        const now = this.now();
        await this.updateNode(rt, spec.id, {
          status: "passed",
          inputHash,
          idempotencyKey,
          output: cached.output,
          assumed: cached.assumed,
          error: undefined,
          startedAt: now,
          finishedAt: now,
        });
        await this.emitOutput(rt, spec.id, cached.output, true);
        return;
      }
    }

    const node = this.node(rt, spec.id);
    const exec: Execution = { controller: new AbortController() };
    rt.executions.set(spec.id, exec);
    if (spec.mutation) rt.mutationHolder = spec.id;
    await this.updateNode(rt, spec.id, {
      status: "running",
      attempt: node.attempt + 1,
      inputHash,
      idempotencyKey,
      error: undefined,
      blockerSummary: undefined,
      startedAt: this.now(),
      finishedAt: undefined,
    });
    void this.execute(rt, spec, exec, input);
  }

  private async emitOutput(rt: RunRuntime, nodeId: string, output: unknown, cached: boolean): Promise<void> {
    await this.emit(
      rt,
      createEngineEvent("node.output", this.eventCtx(rt, this.node(rt, nodeId).id), {
        nodeId,
        outputHash: hashJson(output ?? null),
        cached,
      }),
    );
  }

  // ---------------------------------------------------------------- execution (outside the queue)

  private async execute(rt: RunRuntime, spec: WorkflowNodeSpec, exec: Execution, input: NodeInput): Promise<void> {
    const nodeRun = structuredClone(this.node(rt, spec.id));
    const { signal } = exec.controller;
    const timer =
      spec.timeoutMs > 0
        ? setTimeout(() => {
            exec.abortReason ??= "timeout";
            exec.controller.abort(new NodeError(ERROR_CODES.NODE_TIMEOUT, `Node ${spec.id} exceeded timeout of ${spec.timeoutMs}ms`));
          }, spec.timeoutMs)
        : undefined;

    const nodeCtx = this.eventCtx(rt, nodeRun.id);
    const ctx: NodeExecutionContext = {
      runId: rt.run.id,
      projectId: rt.run.projectId,
      workflowId: rt.run.workflowId,
      nodeId: spec.id,
      nodeRunId: nodeRun.id,
      nodeType: spec.type,
      attempt: nodeRun.attempt,
      traceId: rt.run.traceId,
      signal,
      log: (level, message, data) => {
        const payload = data === undefined ? { nodeId: spec.id, level, message } : { nodeId: spec.id, level, message, data };
        this.emitDetached(rt, createEngineEvent("node.log", nodeCtx, payload));
      },
      emitArtifact: (artifact) => {
        this.emitDetached(rt, createEngineEvent("node.artifact", nodeCtx, { nodeId: spec.id, ...artifact }));
      },
      emit: (event) => {
        this.emitDetached(rt, {
          ...event,
          workflowRunId: rt.run.id,
          traceId: rt.run.traceId,
          nodeRunId: event.nodeRunId ?? nodeRun.id,
        } as AnyEvent);
      },
      ...(nodeRun.resumeState ? { resumeState: structuredClone(nodeRun.resumeState) } : {}),
      saveResumeState: (state) =>
        this.enqueue(rt, async () => {
          // A stale attempt (paused, cancelled or reset meanwhile) must not bring old state back.
          if (rt.executions.get(spec.id) !== exec) return;
          const node = this.node(rt, spec.id);
          node.resumeState = structuredClone(state);
          await this.store.saveNodeRun(structuredClone(node));
        }),
    };

    let result: NodeResult | undefined;
    let failure: unknown;
    try {
      if (spec.mutation && this.beforeMutation) {
        await raceAbort(
          Promise.resolve().then(() => this.beforeMutation?.({ run: structuredClone(rt.run), node: spec, nodeRun, signal })),
          signal,
        );
      }
      const handler = this.handlers.get(spec.type);
      if (!handler) {
        throw new NodeError(ERROR_CODES.HANDLER_NOT_FOUND, `No handler registered for node type "${spec.type}"`, { retryable: false });
      }
      const value: unknown = await raceAbort(
        Promise.resolve().then(() => handler.execute(ctx, input)),
        signal,
      );
      if (!isResult(value)) {
        throw new NodeError(ERROR_CODES.INVALID_RESULT, `Handler for "${spec.type}" returned an invalid result`, { retryable: false });
      }
      result = value;
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
    }
    this.schedule(rt, () => this.completeNode(rt, spec, exec, result, failure));
  }

  private emitDetached(rt: RunRuntime, event: AnyEvent): void {
    if (rt.disposed) return;
    this.emit(rt, event).catch((error: unknown) => this.onError(error, rt.run.id));
  }

  private async completeNode(
    rt: RunRuntime,
    spec: WorkflowNodeSpec,
    exec: Execution,
    result: NodeResult | undefined,
    failure: unknown,
  ): Promise<void> {
    // Stale completion: the run was paused/cancelled/reset while this attempt was in flight.
    if (rt.executions.get(spec.id) !== exec) return;
    rt.executions.delete(spec.id);
    if (rt.mutationHolder === spec.id) rt.mutationHolder = undefined;

    const finishedAt = this.now();
    if (exec.abortReason === "timeout") {
      await this.handleFailure(rt, spec, {
        code: ERROR_CODES.NODE_TIMEOUT,
        message: `Node ${spec.id} exceeded timeout of ${spec.timeoutMs}ms`,
      });
    } else if (!result) {
      await this.handleFailure(rt, spec, toNodeFailure(failure));
    } else {
      switch (result.status) {
        case "passed":
          await this.updateNode(rt, spec.id, {
            status: "passed",
            output: result.output,
            assumed: result.assumed === true ? true : undefined,
            finishedAt,
          });
          await this.emitOutput(rt, spec.id, result.output, false);
          break;
        case "blocked":
          await this.updateNode(rt, spec.id, { status: "blocked", output: result.output, blockerSummary: result.summary, finishedAt });
          break;
        case "waiting_for_input":
          await this.updateNode(rt, spec.id, { status: "waiting_for_input", output: result.output, blockerSummary: result.prompt });
          break;
        case "failed":
          await this.handleFailure(rt, spec, result.error);
          break;
      }
    }
    await this.pump(rt);
  }

  private async handleFailure(rt: RunRuntime, spec: WorkflowNodeSpec, failure: NodeFailure): Promise<void> {
    const node = this.node(rt, spec.id);
    const policy = spec.retryPolicy;
    const neverRetry = isNeverRetryable(failure.code) || failure.retryable === false;
    const retryable = !neverRetry && policy.retryableErrors.includes(failure.code);
    const error = { code: failure.code, message: failure.message, retryable };

    if (retryable && node.attempt < policy.maxAttempts) {
      await this.updateNode(rt, spec.id, { status: "retrying", error });
      const controller = new AbortController();
      rt.backoffs.set(spec.id, controller);
      const delay = backoffDelayMs(policy, node.attempt);
      this.sleep(delay, controller.signal).then(
        () =>
          this.schedule(rt, async () => {
            if (rt.backoffs.get(spec.id) !== controller) return;
            rt.backoffs.delete(spec.id);
            if (this.node(rt, spec.id).status === "retrying") await this.updateNode(rt, spec.id, { status: "ready" });
            await this.pump(rt);
          }),
        () => undefined,
      );
      return;
    }

    const finishedAt = this.now();
    if (retryable) {
      await this.updateNode(rt, spec.id, {
        status: "failed",
        finishedAt,
        error: {
          code: ERROR_CODES.RETRY_BUDGET_EXHAUSTED,
          message: `Retry budget exhausted after ${node.attempt} attempt(s); last error ${failure.code}: ${failure.message}`,
          retryable: false,
        },
      });
    } else {
      await this.updateNode(rt, spec.id, { status: "failed", finishedAt, error });
    }
  }

  /** Called when nothing is executing or ready: derives the run status. */
  private async settle(rt: RunRuntime): Promise<void> {
    const statuses = rt.order.map((id) => this.node(rt, id).status);
    if (statuses.includes("waiting_for_input")) {
      // A node may name a softer run status for its own wait (spec §11.1: a missing BA spec only
      // leaves the run test_design_pending); any other waiting node makes the run "waiting".
      const waiting = rt.order.filter((id) => this.node(rt, id).status === "waiting_for_input");
      const declared = new Set(waiting.map((id) => this.spec(rt, id).config?.["waitingRunStatus"]));
      const status = declared.size === 1 && declared.has("test_design_pending") ? "test_design_pending" : "waiting";
      await this.setRunStatus(rt, status, status === "waiting" ? "waiting for user input" : "waiting for test design input");
      return;
    }

    for (const id of rt.order) {
      const node = this.node(rt, id);
      if (node.status !== "pending" && node.status !== "waiting_for_dependency") continue;
      const blockers = this.spec(rt, id)
        .dependencies.map((dep) => ({ dep, status: this.node(rt, dep).status }))
        .filter((d) => FAILED_LIKE.has(d.status));
      const summary =
        blockers.length > 0
          ? blockers.map((b) => `dependency ${b.dep} ${b.status}`).join("; ")
          : "dependencies could not complete";
      await this.updateNode(rt, id, { status: "blocked", blockerSummary: summary, finishedAt: this.now() });
    }

    const nodes = rt.order.map((id) => this.node(rt, id));
    const failed = nodes.find((n) => n.status === "failed");
    if (failed) {
      await this.setRunStatus(rt, "failed", `node ${failed.nodeId} failed`, false, {
        code: failed.error?.code ?? "NODE_FAILED",
        message: `Node ${failed.nodeId} failed: ${failed.error?.message ?? "unknown error"}`,
      });
      return;
    }
    const blocked = nodes.find((n) => n.status === "blocked");
    if (blocked) {
      await this.setRunStatus(rt, "blocked", `node ${blocked.nodeId} blocked`, false, {
        code: "NODE_BLOCKED",
        message: `Node ${blocked.nodeId} blocked: ${blocked.blockerSummary ?? "no summary"}`,
      });
      return;
    }
    const assumed = nodes.some((n) => n.status === "passed" && n.assumed === true);
    await this.setRunStatus(rt, assumed ? "completed_with_assumptions" : "completed", "all nodes finished");
  }
}
