import { newId, nowIso } from "@frontflow/domain";
import { createAgentEvent, redactString, type AgentEvent, type AgentEventOf, type EventContext } from "@frontflow/event-schema";
import type { InheritEnv } from "../process/env.js";
import { buildChildEnv } from "../process/env.js";
import { resolveExecutable } from "../process/resolve.js";
import {
  ProcessRunner,
  type OutputStream,
  type ProcessExit,
  type RunningProcess,
} from "../process/runner.js";
import { LineSplitter } from "../process/streams.js";
import {
  AdapterError,
  type AgentEventHandler,
  type AiCliAdapter,
  type AiSession,
  type CliCapabilities,
  type CliDetectionResult,
  type ProcessBackedAdapter,
  type RawChunkHandler,
  type ResumeSessionInput,
  type StartSessionInput,
  type Unsubscribe,
  type InteractiveLaunch,
  type InteractiveLaunchInput,
} from "../types.js";

export interface LaunchSpec {
  args: string[];
  /** Overrides the adapter's binary for this launch. */
  command?: string;
  env?: Record<string, string>;
  usePty?: boolean;
  inheritEnv?: InheritEnv;
  extraInheritKeys?: readonly string[];
  /** Written to stdin right after spawn. */
  initialInput?: string;
  /** Close stdin after the initial input (one-shot CLIs). */
  closeInputAfterInitial?: boolean;
  /** Number of turns the initial input opens (each turn ends with a result event). */
  initialTurns: number;
}

export interface ProcessAdapterOptions {
  /** Binary name or absolute path. */
  binary?: string;
  runner?: ProcessRunner;
  inheritEnv?: InheritEnv;
  /** Parent env used for PATH lookup during detect(). */
  env?: Record<string, string>;
}

export type LaunchKind = "start" | "resume";

export interface SessionRecord<TState = unknown> {
  session: AiSession;
  ctx: EventContext;
  input: StartSessionInput | ResumeSessionInput;
  kind: LaunchKind;
  state: TState;
  proc?: RunningProcess;
  handlers: Set<AgentEventHandler>;
  backlog: AgentEvent[];
  exitHandlers: Set<(exitCode: number | null) => void>;
  started: boolean;
  terminal: boolean;
  pendingTurns: number;
  lastTurnResult?: AgentEvent;
  closing: boolean;
  cancelled: boolean;
  keepAlive: boolean;
  pendingApprovals: Set<string>;
  splitter: LineSplitter;
  stderrTail: string;
}

const TURN_RESULT_TYPES = new Set(["session.completed", "session.failed"]);
const STDERR_TAIL = 2000;

/**
 * Shared lifecycle for CLI adapters backed by a child process: spawning,
 * line splitting, event context, backlog-until-subscribed, turn accounting,
 * approvals bookkeeping and exit → terminal event mapping.
 */
export abstract class ProcessCliAdapter<TState = unknown> implements AiCliAdapter, ProcessBackedAdapter {
  abstract readonly id: string;
  protected readonly binary: string;
  protected readonly runner: ProcessRunner;
  protected readonly inheritEnv: InheritEnv;
  protected readonly parentEnv: Record<string, string> | undefined;
  protected readonly versionArgs: string[] = ["--version"];
  protected readonly extraInheritKeys: readonly string[] = [];

  private readonly sessions = new Map<string, SessionRecord<TState>>();
  private readonly rawHandlers = new Set<RawChunkHandler>();

  protected constructor(defaultBinary: string, options: ProcessAdapterOptions = {}) {
    this.binary = options.binary ?? defaultBinary;
    this.runner = options.runner ?? new ProcessRunner();
    this.inheritEnv = options.inheritEnv ?? "minimal";
    this.parentEnv = options.env;
  }

  abstract capabilities(): Promise<CliCapabilities>;

  interactiveLaunch(input: InteractiveLaunchInput): InteractiveLaunch | undefined {
    const args = this.interactiveArgs(input.externalSessionId, input.newSessionId);
    return args ? { command: this.binary, args, inheritKeys: this.extraInheritKeys } : undefined;
  }

  /** Arguments for the CLI's interactive TUI; undefined when the CLI has none. */
  protected interactiveArgs(_externalSessionId?: string, _newSessionId?: string): string[] | undefined {
    return undefined;
  }
  protected abstract createState(rec: Omit<SessionRecord<TState>, "state">): TState;
  protected abstract buildLaunch(rec: SessionRecord<TState>): LaunchSpec | Promise<LaunchSpec>;
  /** Maps one complete output line to normalized events. */
  protected abstract parseLine(rec: SessionRecord<TState>, line: string): AgentEvent[];

  /** stdin payload for a follow-up prompt; undefined = not supported. */
  protected formatUserMessage(_rec: SessionRecord<TState>, _text: string): string | undefined {
    return undefined;
  }

  /** stdin payload answering an approval request; undefined = not supported. */
  protected formatApproval(
    _rec: SessionRecord<TState>,
    _requestId: string,
    _approved: boolean,
  ): string | undefined {
    return undefined;
  }

  /** Events emitted right after spawn (e.g. PTY adapters without an init line). */
  protected initialEvents(_rec: SessionRecord<TState>): AgentEvent[] {
    return [];
  }

  /** Terminal event when the process exits without a turn result. */
  protected exitEvent(rec: SessionRecord<TState>, exit: ProcessExit): AgentEvent {
    const tail = redactString(rec.stderrTail.trim());
    return this.event(rec, "session.failed", {
      code: "PROCESS_EXITED",
      message:
        `${this.id} exited (code ${exit.exitCode ?? "null"}${exit.signal ? `, signal ${exit.signal}` : ""}) before completing` +
        (exit.error ? `: ${exit.error}` : tail ? `: ${tail.slice(-500)}` : ""),
      exitCode: exit.exitCode,
    });
  }

  async detect(): Promise<CliDetectionResult> {
    const env = buildChildEnv({ inherit: "minimal", ...(this.parentEnv ? { source: this.parentEnv } : {}) });
    const binaryPath = resolveExecutable(this.binary, env);
    if (!binaryPath) return { installed: false, error: `${this.binary} not found on PATH` };
    try {
      const run = await this.runner.run({
        command: binaryPath,
        args: this.versionArgs,
        cwd: process.cwd(),
        timeoutMs: 15_000,
        ...(this.parentEnv ? { env: this.parentEnv, inheritEnv: "none" as const } : {}),
      });
      const text = `${run.stdout}\n${run.stderr}`;
      const version = /\d+\.\d+\.\d+(?:[-+.][\w.]+)?/.exec(text)?.[0];
      if (run.exitCode !== 0 && !version) {
        return { installed: false, binaryPath, error: run.error ?? `exit code ${run.exitCode}` };
      }
      return { installed: true, binaryPath, ...(version ? { version } : {}) };
    } catch (err) {
      return { installed: false, binaryPath, error: (err as Error).message };
    }
  }

  start(input: StartSessionInput): Promise<AiSession> {
    return this.launch(input, "start");
  }

  async resume(input: ResumeSessionInput): Promise<AiSession> {
    const caps = await this.capabilities();
    if (!caps.resumableSessions) throw new AdapterError("NOT_SUPPORTED", `${this.id} cannot resume sessions`);
    return this.launch(input, "resume");
  }

  async send(sessionId: string, message: string): Promise<void> {
    const rec = this.active(sessionId);
    const payload = this.formatUserMessage(rec, message);
    if (payload === undefined) throw new AdapterError("NOT_SUPPORTED", `${this.id} does not accept follow-up input`);
    rec.pendingTurns += 1;
    rec.proc?.write(payload);
    this.dispatch(rec, [this.event(rec, "message.delta", { role: "user", text: message })]);
  }

  approve(sessionId: string, requestId: string): Promise<void> {
    return this.answer(sessionId, requestId, true);
  }

  reject(sessionId: string, requestId: string): Promise<void> {
    return this.answer(sessionId, requestId, false);
  }

  async cancel(sessionId: string): Promise<void> {
    const rec = this.record(sessionId);
    if (rec.terminal || !rec.proc?.running) return;
    rec.cancelled = true;
    await rec.proc.kill();
    await this.settled(rec);
  }

  /** Gracefully ends a keepAlive session (closes stdin; PTY sessions are terminated). */
  async close(sessionId: string): Promise<void> {
    const rec = this.record(sessionId);
    if (rec.terminal || !rec.proc?.running) return;
    rec.closing = true;
    rec.keepAlive = false;
    if (rec.proc.mode === "pty") await rec.proc.kill();
    else rec.proc.endInput();
    await this.settled(rec);
  }

  subscribe(sessionId: string, handler: AgentEventHandler): Unsubscribe {
    const rec = this.record(sessionId);
    rec.handlers.add(handler);
    if (rec.backlog.length > 0) {
      const backlog = rec.backlog.splice(0);
      for (const ev of backlog) safeCall(handler, ev);
    }
    return () => {
      rec.handlers.delete(handler);
    };
  }

  onProcessExit(sessionId: string, handler: (exitCode: number | null) => void): Unsubscribe {
    const rec = this.record(sessionId);
    rec.exitHandlers.add(handler);
    return () => {
      rec.exitHandlers.delete(handler);
    };
  }

  onRaw(handler: RawChunkHandler): Unsubscribe {
    this.rawHandlers.add(handler);
    return () => {
      this.rawHandlers.delete(handler);
    };
  }

  getSession(sessionId: string): AiSession | undefined {
    const rec = this.sessions.get(sessionId);
    return rec ? { ...rec.session } : undefined;
  }

  /** Builds an event bound to the session's trace context. */
  protected event<T extends AgentEvent["type"]>(
    rec: SessionRecord<TState>,
    type: T,
    payload: AgentEventOf<T>["payload"],
    confidence?: number,
  ): AgentEventOf<T> {
    return createAgentEvent<T>(type, rec.ctx, payload, confidence);
  }

  /** Handles one raw output chunk. Default: line-split stdout/pty, keep a stderr tail. */
  protected handleOutput(rec: SessionRecord<TState>, chunk: string, stream: OutputStream): void {
    if (stream === "stderr") {
      rec.stderrTail = (rec.stderrTail + chunk).slice(-STDERR_TAIL);
      return;
    }
    for (const line of rec.splitter.push(chunk)) this.handleLine(rec, line);
  }

  protected handleLine(rec: SessionRecord<TState>, line: string): void {
    if (!line.trim()) return;
    let events: AgentEvent[];
    try {
      events = this.parseLine(rec, line);
    } catch {
      events = [];
    }
    this.dispatch(rec, events);
  }

  protected dispatch(rec: SessionRecord<TState>, events: AgentEvent[]): void {
    for (const ev of events) {
      if (rec.terminal) return;
      if (ev.type === "session.started") {
        if (ev.payload.externalSessionId) rec.session.externalSessionId = ev.payload.externalSessionId;
        if (rec.started) continue;
        rec.started = true;
        this.deliver(rec, ev);
        continue;
      }
      if (!rec.started && ev.type !== "session.failed") this.ensureStarted(rec);
      if (TURN_RESULT_TYPES.has(ev.type)) {
        this.onTurnResult(rec, ev);
        continue;
      }
      if (ev.type === "approval.required") rec.pendingApprovals.add(ev.payload.requestId);
      this.deliver(rec, ev);
    }
  }

  private onTurnResult(rec: SessionRecord<TState>, ev: AgentEvent): void {
    if (ev.type === "session.completed" && ev.payload.externalSessionId) {
      rec.session.externalSessionId = ev.payload.externalSessionId;
    }
    rec.pendingTurns = Math.max(0, rec.pendingTurns - 1);
    rec.lastTurnResult = ev;
    if (rec.pendingTurns === 0 && !rec.keepAlive) {
      rec.closing = true;
      rec.proc?.endInput();
      return;
    }
    this.deliver(
      rec,
      this.event(rec, "status.changed", {
        status: "idle",
        detail: ev.type === "session.failed" ? `turn failed: ${ev.payload.message}` : "turn completed",
      }),
    );
  }

  private ensureStarted(rec: SessionRecord<TState>): void {
    rec.started = true;
    this.deliver(
      rec,
      this.event(rec, "session.started", {
        adapterId: this.id,
        cwd: rec.session.cwd,
        ...(rec.session.externalSessionId ? { externalSessionId: rec.session.externalSessionId } : {}),
      }),
    );
  }

  private deliver(rec: SessionRecord<TState>, ev: AgentEvent): void {
    if (ev.type === "session.completed" || ev.type === "session.failed") {
      rec.terminal = true;
      rec.session.endedAt = nowIso();
      rec.session.status = rec.cancelled ? "cancelled" : ev.type === "session.completed" ? "completed" : "failed";
    }
    if (rec.handlers.size === 0) {
      rec.backlog.push(ev);
      return;
    }
    for (const h of [...rec.handlers]) safeCall(h, ev);
  }

  private async launch(input: StartSessionInput | ResumeSessionInput, kind: LaunchKind): Promise<AiSession> {
    const id = newId("ses");
    const base: Omit<SessionRecord<TState>, "state"> = {
      session: {
        id,
        adapterId: this.id,
        status: "starting",
        cwd: input.cwd,
        startedAt: nowIso(),
        ...("externalSessionId" in input ? { externalSessionId: input.externalSessionId } : {}),
      },
      ctx: {
        traceId: input.traceId,
        workflowRunId: input.workflowRunId,
        sessionId: id,
        ...(input.nodeRunId ? { nodeRunId: input.nodeRunId } : {}),
      },
      input,
      kind,
      handlers: new Set(),
      backlog: [],
      exitHandlers: new Set(),
      started: false,
      terminal: false,
      pendingTurns: 0,
      closing: false,
      cancelled: false,
      keepAlive: input.keepAlive ?? false,
      pendingApprovals: new Set(),
      splitter: new LineSplitter(),
      stderrTail: "",
    };
    const rec = { ...base, state: this.createState(base) } as SessionRecord<TState>;
    const spec = await this.buildLaunch(rec);

    const proc = await this.runner.start({
      command: spec.command ?? this.binary,
      args: spec.args,
      cwd: input.cwd,
      env: { ...(input.env ?? {}), ...(spec.env ?? {}) },
      inheritEnv: spec.inheritEnv ?? this.inheritEnv,
      extraInheritKeys: [...this.extraInheritKeys, ...(spec.extraInheritKeys ?? [])],
      usePty: spec.usePty ?? false,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      onData: (chunk, stream) => this.handleOutput(rec, chunk, stream),
      onRaw: (chunk) => {
        for (const h of [...this.rawHandlers]) {
          try {
            h(id, chunk);
          } catch {
            // sinks must not break the session
          }
        }
      },
    });
    rec.proc = proc;
    rec.session.status = "running";
    if (proc.pid !== undefined) rec.session.pid = proc.pid;
    this.sessions.set(id, rec);

    rec.pendingTurns = spec.initialTurns;
    this.dispatch(rec, this.initialEvents(rec));
    if (spec.initialInput !== undefined) proc.write(spec.initialInput);
    if (spec.closeInputAfterInitial) proc.endInput();
    if (spec.initialTurns === 0 && !rec.keepAlive && proc.mode === "pipe" && !spec.closeInputAfterInitial) {
      rec.closing = true;
      proc.endInput();
    }

    void proc.exited.then((exit) => this.onExit(rec, exit));
    return { ...rec.session };
  }

  private onExit(rec: SessionRecord<TState>, exit: ProcessExit): void {
    for (const line of rec.splitter.flush()) this.handleLine(rec, line);
    if (!rec.terminal) {
      let final: AgentEvent;
      if (rec.cancelled) {
        this.deliver(rec, this.event(rec, "status.changed", { status: "cancelled" }));
        final = this.event(rec, "session.failed", {
          code: "CANCELLED",
          message: "Session cancelled by user",
          exitCode: exit.exitCode,
        });
      } else if (exit.timedOut) {
        final = this.event(rec, "session.failed", {
          code: "TIMEOUT",
          message: `Session exceeded ${rec.input.timeoutMs}ms`,
          exitCode: exit.exitCode,
        });
      } else if (rec.lastTurnResult && rec.pendingTurns === 0) {
        final = { ...rec.lastTurnResult, payload: { ...rec.lastTurnResult.payload, exitCode: exit.exitCode } } as AgentEvent;
      } else if (rec.closing && rec.pendingTurns === 0 && exit.exitCode === 0) {
        final = this.event(rec, "session.completed", {
          ...(rec.session.externalSessionId ? { externalSessionId: rec.session.externalSessionId } : {}),
          exitCode: 0,
        });
      } else {
        final = this.exitEvent(rec, exit);
      }
      if (!rec.started && final.type === "session.completed") this.ensureStarted(rec);
      this.deliver(rec, final);
    }
    rec.session.endedAt ??= nowIso();
    for (const h of [...rec.exitHandlers]) {
      try {
        h(exit.exitCode);
      } catch {
        // ignore
      }
    }
    rec.exitHandlers.clear();
  }

  private async answer(sessionId: string, requestId: string, approved: boolean): Promise<void> {
    const rec = this.active(sessionId);
    if (!rec.pendingApprovals.has(requestId)) {
      throw new AdapterError("UNKNOWN_APPROVAL", `No pending approval ${requestId} in session ${sessionId}`);
    }
    const payload = this.formatApproval(rec, requestId, approved);
    if (payload === undefined) throw new AdapterError("NOT_SUPPORTED", `${this.id} does not support approvals`);
    rec.pendingApprovals.delete(requestId);
    rec.proc?.write(payload);
    this.dispatch(rec, [
      this.event(rec, "status.changed", {
        status: "thinking",
        detail: `${approved ? "approved" : "rejected"} ${requestId}`,
      }),
    ]);
  }

  private settled(rec: SessionRecord<TState>): Promise<void> {
    return (rec.proc?.exited ?? Promise.resolve()).then(() => new Promise<void>((r) => setImmediate(r)));
  }

  private record(sessionId: string): SessionRecord<TState> {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new AdapterError("SESSION_NOT_FOUND", `Unknown session ${sessionId}`);
    return rec;
  }

  private active(sessionId: string): SessionRecord<TState> {
    const rec = this.record(sessionId);
    if (rec.terminal || rec.closing || !rec.proc?.running) {
      throw new AdapterError("SESSION_NOT_ACTIVE", `Session ${sessionId} is not accepting input`);
    }
    return rec;
  }
}

function safeCall(handler: AgentEventHandler, ev: AgentEvent): void {
  try {
    handler(ev);
  } catch {
    // a faulty subscriber must not break the stream
  }
}
