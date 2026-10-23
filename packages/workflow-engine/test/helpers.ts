import type { NodeExecutionContext, NodeHandler, NodeInput, NodeResult, WorkflowDefinition, WorkflowNodeSpec } from "../src/index.js";

export function spec(id: string, extra: Partial<WorkflowNodeSpec> = {}): WorkflowNodeSpec {
  return {
    id,
    type: id,
    label: id,
    dependencies: [],
    retryPolicy: { maxAttempts: 1, backoff: "none", retryableErrors: [] },
    timeoutMs: 5000,
    mutation: false,
    readOnly: false,
    version: 1,
    ...extra,
  };
}

export function workflow(nodes: WorkflowNodeSpec[], extra: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return { id: "test-wf", version: 1, name: "Test workflow", nodes, ...extra };
}

export function handler(fn: (ctx: NodeExecutionContext, input: NodeInput) => NodeResult | Promise<NodeResult>): NodeHandler {
  return { execute: async (ctx, input) => fn(ctx, input) };
}

export const pass = (output: unknown = {}): NodeHandler => handler(() => ({ status: "passed", output }));

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Never resolves on its own; rejects when the signal aborts. */
export function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
