import { nowIso } from "@frontflow/domain";
import {
  createAgentEvent,
  redact,
  redactString,
  type AgentEvent,
  type EventContext,
  type RedactOptions,
} from "@frontflow/event-schema";
import {
  AdapterError,
  isProcessBackedAdapter,
  type AgentEventHandler,
  type AiCliAdapter,
  type AiSession,
  type CliCapabilities,
  type CliDetectionResult,
  type RawChunkHandler,
  type ResumeSessionInput,
  type StartSessionInput,
  type Unsubscribe,
} from "./types.js";

/** Persistence hooks; implementations may be sync or async (failures go to `onError`). */
export interface SessionPersistence {
  saveSession(session: ManagedSession): void | Promise<void>;
  appendEvent(event: AgentEvent): void | Promise<void>;
  appendRaw(sessionId: string, chunk: string): void | Promise<void>;
}

export interface ManagedSession extends AiSession {
  traceId: string;
  workflowRunId: string;
  nodeRunId?: string;
}

export interface AdapterDetection {
  adapterId: string;
  detection: CliDetectionResult;
  capabilities?: CliCapabilities;
}

export interface SessionManagerOptions {
  persistence?: SessionPersistence;
  redactOptions?: RedactOptions;
  onError?: (error: unknown) => void;
  /** Grace period after process exit before declaring PROCESS_EXITED. */
  exitGraceMs?: number;
}

interface Entry {
  adapter: AiCliAdapter;
  session: ManagedSession;
  ctx: EventContext;
  terminal: boolean;
  handlers: Set<AgentEventHandler>;
  disposers: Unsubscribe[];
}

const TERMINAL = new Set<AgentEvent["type"]>(["session.completed", "session.failed"]);

/**
 * Registry and fan-out point for AI CLI sessions. Every event leaving the
 * manager is redacted (spec §21.2); sessions whose process dies without a
 * terminal event get `session.failed { code: "PROCESS_EXITED" }` (spec §23.2).
 */
export class SessionManager {
  private readonly adapters = new Map<string, AiCliAdapter>();
  private readonly adapterDisposers = new Map<string, Unsubscribe>();
  private readonly entries = new Map<string, Entry>();
  private readonly allHandlers = new Set<AgentEventHandler>();
  private readonly rawHandlers = new Set<RawChunkHandler>();

  constructor(
    adapters: AiCliAdapter[] = [],
    private readonly options: SessionManagerOptions = {},
  ) {
    for (const a of adapters) this.register(a);
  }

  register(adapter: AiCliAdapter): void {
    this.unregister(adapter.id);
    this.adapters.set(adapter.id, adapter);
    if (isProcessBackedAdapter(adapter)) {
      this.adapterDisposers.set(
        adapter.id,
        adapter.onRaw((sessionId, chunk) => this.handleRaw(sessionId, chunk)),
      );
    }
  }

  unregister(adapterId: string): void {
    this.adapterDisposers.get(adapterId)?.();
    this.adapterDisposers.delete(adapterId);
    this.adapters.delete(adapterId);
  }

  getAdapter(adapterId: string): AiCliAdapter {
    const a = this.adapters.get(adapterId);
    if (!a) throw new AdapterError("ADAPTER_NOT_FOUND", `No adapter registered as ${adapterId}`);
    return a;
  }

  adapterIds(): string[] {
    return [...this.adapters.keys()];
  }

  /** Spec §10.1 "Detect installed AI CLIs". */
  async detectAll(): Promise<AdapterDetection[]> {
    return Promise.all(
      [...this.adapters.values()].map(async (a): Promise<AdapterDetection> => {
        let detection: CliDetectionResult;
        try {
          detection = await a.detect();
        } catch (err) {
          detection = { installed: false, error: (err as Error).message };
        }
        let capabilities: CliCapabilities | undefined;
        try {
          capabilities = await a.capabilities();
        } catch {
          capabilities = undefined;
        }
        return { adapterId: a.id, detection, ...(capabilities ? { capabilities } : {}) };
      }),
    );
  }

  async startSession(adapterId: string, input: StartSessionInput): Promise<ManagedSession> {
    const adapter = this.getAdapter(adapterId);
    return this.track(adapter, await adapter.start(input), input);
  }

  async resumeSession(adapterId: string, input: ResumeSessionInput): Promise<ManagedSession> {
    const adapter = this.getAdapter(adapterId);
    return this.track(adapter, await adapter.resume(input), input);
  }

  send(sessionId: string, message: string): Promise<void> {
    return this.entry(sessionId).adapter.send(sessionId, message);
  }

  approve(sessionId: string, requestId: string): Promise<void> {
    return this.entry(sessionId).adapter.approve(sessionId, requestId);
  }

  reject(sessionId: string, requestId: string): Promise<void> {
    return this.entry(sessionId).adapter.reject(sessionId, requestId);
  }

  cancel(sessionId: string): Promise<void> {
    return this.entry(sessionId).adapter.cancel(sessionId);
  }

  /** Gracefully ends a keepAlive session when the adapter supports it. */
  async close(sessionId: string): Promise<void> {
    const { adapter } = this.entry(sessionId);
    if (isProcessBackedAdapter(adapter)) await adapter.close(sessionId);
    else await adapter.cancel(sessionId);
  }

  list(): ManagedSession[] {
    return [...this.entries.values()].map((e) => ({ ...e.session }));
  }

  get(sessionId: string): ManagedSession | undefined {
    const e = this.entries.get(sessionId);
    return e ? { ...e.session } : undefined;
  }

  subscribe(sessionId: string, handler: AgentEventHandler): Unsubscribe {
    const e = this.entry(sessionId);
    e.handlers.add(handler);
    return () => {
      e.handlers.delete(handler);
    };
  }

  subscribeAll(handler: AgentEventHandler): Unsubscribe {
    this.allHandlers.add(handler);
    return () => {
      this.allHandlers.delete(handler);
    };
  }

  /** Redacted raw output of every session. */
  onRaw(handler: RawChunkHandler): Unsubscribe {
    this.rawHandlers.add(handler);
    return () => {
      this.rawHandlers.delete(handler);
    };
  }

  /** Resolves when the session has emitted its terminal event. */
  waitForEnd(sessionId: string): Promise<ManagedSession> {
    const e = this.entry(sessionId);
    if (e.terminal) return Promise.resolve({ ...e.session });
    return new Promise((resolve) => {
      const off = this.subscribe(sessionId, (ev) => {
        if (TERMINAL.has(ev.type)) {
          off();
          resolve({ ...e.session });
        }
      });
    });
  }

  private track(
    adapter: AiCliAdapter,
    session: AiSession,
    input: StartSessionInput | ResumeSessionInput,
  ): ManagedSession {
    const managed: ManagedSession = {
      ...session,
      traceId: input.traceId,
      workflowRunId: input.workflowRunId,
      ...(input.nodeRunId ? { nodeRunId: input.nodeRunId } : {}),
    };
    const entry: Entry = {
      adapter,
      session: managed,
      ctx: {
        traceId: input.traceId,
        workflowRunId: input.workflowRunId,
        sessionId: session.id,
        ...(input.nodeRunId ? { nodeRunId: input.nodeRunId } : {}),
      },
      terminal: false,
      handlers: new Set(),
      disposers: [],
    };
    this.entries.set(session.id, entry);
    this.persist((p) => p.saveSession({ ...managed }));
    if (isProcessBackedAdapter(adapter)) {
      entry.disposers.push(
        adapter.onProcessExit(session.id, (exitCode) => {
          const grace = this.options.exitGraceMs ?? 50;
          setTimeout(() => this.onProcessExit(entry, exitCode), grace).unref?.();
        }),
      );
    }
    entry.disposers.push(adapter.subscribe(session.id, (ev) => this.handleEvent(entry, ev)));
    return { ...managed };
  }

  private onProcessExit(entry: Entry, exitCode: number | null): void {
    if (entry.terminal) return;
    this.handleEvent(
      entry,
      createAgentEvent("session.failed", entry.ctx, {
        code: "PROCESS_EXITED",
        message: `CLI process exited (code ${exitCode ?? "null"}) without completing the session`,
        exitCode,
      }),
    );
  }

  private handleEvent(entry: Entry, raw: AgentEvent): void {
    if (entry.terminal) return;
    const ev = this.redactEvent(raw);
    const s = entry.session;
    if (ev.type === "session.started" && ev.payload.externalSessionId) {
      s.externalSessionId = ev.payload.externalSessionId;
    }
    if (ev.type === "session.started" || ev.type === "status.changed") {
      if (s.status === "starting") s.status = "running";
    }
    if (TERMINAL.has(ev.type)) {
      entry.terminal = true;
      s.endedAt = nowIso();
      if (ev.type === "session.completed") {
        s.status = "completed";
        if (ev.payload.externalSessionId) s.externalSessionId = ev.payload.externalSessionId;
      } else {
        s.status = ev.type === "session.failed" && ev.payload.code === "CANCELLED" ? "cancelled" : "failed";
      }
    }
    this.persist((p) => p.appendEvent(ev));
    if (ev.type === "session.started" || entry.terminal) this.persist((p) => p.saveSession({ ...s }));
    for (const h of [...entry.handlers, ...this.allHandlers]) {
      try {
        h(ev);
      } catch (err) {
        this.options.onError?.(err);
      }
    }
    if (entry.terminal) {
      for (const d of entry.disposers.splice(0)) d();
    }
  }

  private handleRaw(sessionId: string, chunk: string): void {
    if (!this.entries.has(sessionId)) return;
    const text = this.options.redactOptions ? redactString(chunk, this.options.redactOptions) : chunk;
    this.persist((p) => p.appendRaw(sessionId, text));
    for (const h of [...this.rawHandlers]) {
      try {
        h(sessionId, text);
      } catch (err) {
        this.options.onError?.(err);
      }
    }
  }

  private redactEvent(ev: AgentEvent): AgentEvent {
    const out = redact(ev, this.options.redactOptions);
    // Token counters match the secret-key heuristic ("...Tokens") but are plain numbers.
    if (ev.type === "usage.updated") return { ...out, payload: { ...ev.payload } } as AgentEvent;
    return out;
  }

  private persist(fn: (p: SessionPersistence) => void | Promise<void>): void {
    const p = this.options.persistence;
    if (!p) return;
    try {
      const r = fn(p);
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch((err: unknown) => this.options.onError?.(err));
      }
    } catch (err) {
      this.options.onError?.(err);
    }
  }

  private entry(sessionId: string): Entry {
    const e = this.entries.get(sessionId);
    if (!e) throw new AdapterError("SESSION_NOT_FOUND", `Unknown session ${sessionId}`);
    return e;
  }
}
