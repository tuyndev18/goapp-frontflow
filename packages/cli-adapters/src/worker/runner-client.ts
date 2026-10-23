import type { OpenTerminalInput } from "../terminal.js";
import { newId } from "@frontflow/domain";
import type { AgentEvent } from "@frontflow/event-schema";
import type { AdapterDetection, ManagedSession } from "../session-manager.js";
import type { AgentEventHandler, RawChunkHandler, ResumeSessionInput, StartSessionInput, Unsubscribe } from "../types.js";
import {
  isRunnerMessage,
  unwrapPortMessage,
  type RunnerError,
  type RunnerPort,
  type RunnerRequest,
  type RunnerRequestType,
  type RunnerResults,
} from "./protocol.js";

export class RunnerRequestError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "RunnerRequestError";
  }
}

export interface RunnerClientOptions {
  /** Rejects requests that get no response in time (default 60s; 0 disables). */
  requestTimeoutMs?: number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer?: NodeJS.Timeout;
}

/** Main-process side of the runner protocol: promise-based calls + event fan-in. */
export type TerminalMessageHandler = (message: { type: "terminal.data"; terminalId: string; data: string } | { type: "terminal.exit"; terminalId: string; exitCode: number | null }) => void;

export class RunnerClient {
  private readonly pending = new Map<string, Pending>();
  private readonly eventHandlers = new Set<AgentEventHandler>();
  private readonly sessionHandlers = new Map<string, Set<AgentEventHandler>>();
  private readonly rawHandlers = new Set<RawChunkHandler>();
  private readonly terminalHandlers = new Set<TerminalMessageHandler>();
  private readonly listener: (message: unknown) => void;
  private disposed = false;

  constructor(
    private readonly port: RunnerPort,
    private readonly options: RunnerClientOptions = {},
  ) {
    this.listener = (message) => this.onMessage(unwrapPortMessage(message));
    port.on("message", this.listener);
  }

  start(adapterId: string, input: StartSessionInput): Promise<ManagedSession> {
    return this.request("start", { adapterId, input });
  }
  resume(adapterId: string, input: ResumeSessionInput): Promise<ManagedSession> {
    return this.request("resume", { adapterId, input });
  }
  send(sessionId: string, message: string): Promise<void> {
    return this.request("send", { sessionId, message });
  }
  approve(sessionId: string, approvalId: string): Promise<void> {
    return this.request("approve", { sessionId, approvalId });
  }
  reject(sessionId: string, approvalId: string): Promise<void> {
    return this.request("reject", { sessionId, approvalId });
  }
  cancel(sessionId: string): Promise<void> {
    return this.request("cancel", { sessionId });
  }
  close(sessionId: string): Promise<void> {
    return this.request("close", { sessionId });
  }
  detect(): Promise<AdapterDetection[]> {
    return this.request("detect", {});
  }
  list(): Promise<ManagedSession[]> {
    return this.request("list", {});
  }

  /** All events from the worker. */
  subscribe(handler: AgentEventHandler): Unsubscribe {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  subscribeSession(sessionId: string, handler: AgentEventHandler): Unsubscribe {
    let set = this.sessionHandlers.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionHandlers.set(sessionId, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.sessionHandlers.delete(sessionId);
    };
  }

  openTerminal(input: OpenTerminalInput): Promise<{ terminalId: string; pid: number; command: string }> {
    return this.request("terminal.open", { input });
  }
  writeTerminal(terminalId: string, data: string): Promise<void> {
    return this.request("terminal.write", { terminalId, data });
  }
  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
    return this.request("terminal.resize", { terminalId, cols, rows });
  }
  closeTerminal(terminalId: string): Promise<void> {
    return this.request("terminal.close", { terminalId });
  }
  onTerminal(handler: TerminalMessageHandler): Unsubscribe {
    this.terminalHandlers.add(handler);
    return () => {
      this.terminalHandlers.delete(handler);
    };
  }

  onRaw(handler: RawChunkHandler): Unsubscribe {
    this.rawHandlers.add(handler);
    return () => {
      this.rawHandlers.delete(handler);
    };
  }

  /** Rejects in-flight requests (e.g. when the utility process exits) and detaches. */
  dispose(reason = "Runner disposed"): void {
    if (this.disposed) return;
    this.disposed = true;
    this.port.off?.("message", this.listener);
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RunnerRequestError("RUNNER_GONE", reason));
      this.pending.delete(id);
    }
  }

  private request<T extends RunnerRequestType>(
    type: T,
    body: Omit<Extract<RunnerRequest, { type: T }>, "requestId" | "type">,
  ): Promise<RunnerResults[T]> {
    if (this.disposed) return Promise.reject(new RunnerRequestError("RUNNER_GONE", "Runner disposed"));
    const requestId = newId("req");
    return new Promise<RunnerResults[T]>((resolve, reject) => {
      const pending: Pending = { resolve: resolve as (v: unknown) => void, reject };
      const timeout = this.options.requestTimeoutMs ?? 60_000;
      if (timeout > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new RunnerRequestError("TIMEOUT", `Runner request ${type} timed out`));
        }, timeout);
        pending.timer.unref?.();
      }
      this.pending.set(requestId, pending);
      try {
        this.port.postMessage({ ...body, type, requestId });
      } catch (err) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(requestId);
        reject(err as Error);
      }
    });
  }

  private onMessage(msg: unknown): void {
    if (!isRunnerMessage(msg)) return;
    if (msg.type === "response") {
      const p = this.pending.get(msg.requestId);
      if (!p) return;
      this.pending.delete(msg.requestId);
      if (p.timer) clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new RunnerRequestError((msg.error as RunnerError).code, msg.error.message));
      return;
    }
    if (msg.type === "event") {
      this.emit(msg.event);
      return;
    }
    if (msg.type === "terminal.data" || msg.type === "terminal.exit") {
      for (const h of [...this.terminalHandlers]) {
        try {
          h(msg);
        } catch {
          // ignore subscriber errors
        }
      }
      return;
    }
    for (const h of [...this.rawHandlers]) {
      try {
        h(msg.sessionId, msg.chunk);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  private emit(event: AgentEvent): void {
    const scoped = event.sessionId ? this.sessionHandlers.get(event.sessionId) : undefined;
    for (const h of [...this.eventHandlers, ...(scoped ?? [])]) {
      try {
        h(event);
      } catch {
        // ignore subscriber errors
      }
    }
  }
}
