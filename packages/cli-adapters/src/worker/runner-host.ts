import { SessionManager, type SessionManagerOptions } from "../session-manager.js";
import type { AiCliAdapter } from "../types.js";
import type { PtyLoader } from "../process/runner.js";
import { TerminalManager } from "../terminal.js";
import {
  isRunnerRequest,
  unwrapPortMessage,
  type RunnerMessage,
  type RunnerPort,
  type RunnerRequest,
} from "./protocol.js";

export interface RunnerWorkerOptions extends SessionManagerOptions {
  adapters?: AiCliAdapter[];
  manager?: SessionManager;
  ptyLoader?: PtyLoader;
}

export interface RunnerWorker {
  manager: SessionManager;
  dispose(): void;
}

/**
 * Serves the runner protocol on a port inside the PTY/CLI utility process
 * (spec §9.3: PTY never runs in Electron main).
 */
export function startRunnerWorker(port: RunnerPort, options: RunnerWorkerOptions = {}): RunnerWorker {
  const { adapters = [], manager: given, ptyLoader: _ptyLoader, ...managerOptions } = options;
  const manager = given ?? new SessionManager(adapters, managerOptions);
  if (given) for (const a of adapters) given.register(a);

  const post = (msg: RunnerMessage): void => {
    try {
      port.postMessage(msg);
    } catch {
      // port closed
    }
  };

  const terminals = new TerminalManager(
    (adapterId) => {
      try {
        return manager.getAdapter(adapterId);
      } catch {
        return undefined;
      }
    },
    {
      onData: (terminalId, data) => post({ type: "terminal.data", terminalId, data }),
      onExit: (terminalId, exitCode) => post({ type: "terminal.exit", terminalId, exitCode }),
      ...(options.ptyLoader ? { ptyLoader: options.ptyLoader } : {}),
    },
  );
  const offEvents = manager.subscribeAll((event) => post({ type: "event", event }));
  const offRaw = manager.onRaw((sessionId, chunk) => post({ type: "raw", sessionId, chunk }));

  const listener = (message: unknown): void => {
    const req = unwrapPortMessage(message);
    if (!isRunnerRequest(req)) {
      const requestId =
        typeof req === "object" && req !== null && typeof (req as { requestId?: unknown }).requestId === "string"
          ? (req as { requestId: string }).requestId
          : undefined;
      if (requestId) {
        post({ type: "response", requestId, ok: false, error: { code: "BAD_REQUEST", message: "Invalid runner request" } });
      }
      return;
    }
    void handle(manager, terminals, req).then(
      (result) => post({ type: "response", requestId: req.requestId, ok: true, result }),
      (err: unknown) => {
        const e = err as { code?: unknown; message?: unknown };
        post({
          type: "response",
          requestId: req.requestId,
          ok: false,
          error: {
            ...(typeof e?.code === "string" ? { code: e.code } : {}),
            message: typeof e?.message === "string" ? e.message : String(err),
          },
        });
      },
    );
  };
  port.on("message", listener);

  return {
    manager,
    dispose() {
      offEvents();
      offRaw();
      void terminals.closeAll();
      port.off?.("message", listener);
    },
  };
}

async function handle(manager: SessionManager, terminals: TerminalManager, req: RunnerRequest): Promise<unknown> {
  switch (req.type) {
    case "start":
      return manager.startSession(req.adapterId, req.input);
    case "resume":
      return manager.resumeSession(req.adapterId, req.input);
    case "send":
      return manager.send(req.sessionId, req.message);
    case "approve":
      return manager.approve(req.sessionId, req.approvalId);
    case "reject":
      return manager.reject(req.sessionId, req.approvalId);
    case "cancel":
      return manager.cancel(req.sessionId);
    case "close":
      return manager.close(req.sessionId);
    case "detect":
      return manager.detectAll();
    case "list":
      return manager.list();
    case "terminal.open":
      return terminals.open(req.input);
    case "terminal.write":
      return terminals.write(req.terminalId, req.data);
    case "terminal.resize":
      return terminals.resize(req.terminalId, req.cols, req.rows);
    case "terminal.close":
      return terminals.close(req.terminalId);
  }
}
