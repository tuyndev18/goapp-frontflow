import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "@frontflow/event-schema";
import type { AiCliAdapter } from "../src/index.js";

export interface EventCollector {
  events: AgentEvent[];
  waitFor(pred: (e: AgentEvent) => boolean, timeoutMs?: number): Promise<AgentEvent>;
  done(timeoutMs?: number): Promise<AgentEvent>;
  stop(): void;
}

export function collectFrom(
  subscribe: (handler: (e: AgentEvent) => void) => () => void,
): EventCollector {
  const events: AgentEvent[] = [];
  const waiters: Array<{ pred: (e: AgentEvent) => boolean; resolve: (e: AgentEvent) => void }> = [];
  const stop = subscribe((e) => {
    events.push(e);
    for (const w of [...waiters]) {
      if (w.pred(e)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(e);
      }
    }
  });
  const waitFor = (pred: (e: AgentEvent) => boolean, timeoutMs = 15_000): Promise<AgentEvent> => {
    const hit = events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for event; got: ${events.map((e) => e.type).join(", ")}`));
      }, timeoutMs);
      waiters.push({
        pred,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  };
  return {
    events,
    waitFor,
    done: (t) => waitFor((e) => e.type === "session.completed" || e.type === "session.failed", t),
    stop,
  };
}

export function collect(adapter: AiCliAdapter, sessionId: string): EventCollector {
  return collectFrom((h) => adapter.subscribe(sessionId, h));
}

export function tempDir(prefix = "ff-cli-"): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Windows may hold handles briefly
      }
    },
  };
}

export const ctxInput = {
  traceId: "trace_test",
  workflowRunId: "run_test",
  nodeRunId: "node_test",
};
