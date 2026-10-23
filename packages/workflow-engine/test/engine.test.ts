import { fileURLToPath } from "node:url";
import type { AnyEvent } from "@frontflow/event-schema";
import { createAgentEvent } from "@frontflow/event-schema";
import { describe, expect, it } from "vitest";
import {
  InMemoryRunStore,
  NodeError,
  NodeHandlerRegistry,
  WorkflowEngine,
  backoffDelayMs,
  loadBuiltinWorkflows,
} from "../src/index.js";
import type { NodeHandler, NodeInput, RunState, WorkflowEngineOptions } from "../src/index.js";
import { deferred, hang, handler, pass, spec, waitUntil, workflow } from "./helpers.js";

const INPUTS = { snapshotIds: ["snap_1"] };

function setup(handlers: Record<string, NodeHandler>, options: Partial<WorkflowEngineOptions> = {}) {
  const store = options.store instanceof InMemoryRunStore ? options.store : new InMemoryRunStore();
  const delays: number[] = [];
  const engine = new WorkflowEngine({
    store,
    handlers: new NodeHandlerRegistry(handlers),
    sleep: async (ms) => {
      delays.push(ms);
    },
    ...options,
  });
  const events: AnyEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, store, delays, events };
}

function statusOf(state: RunState, nodeId: string) {
  return state.nodes.find((n) => n.nodeId === nodeId)?.status;
}

function nodeOf(state: RunState, nodeId: string) {
  const node = state.nodes.find((n) => n.nodeId === nodeId);
  if (!node) throw new Error(`missing node ${nodeId}`);
  return node;
}

describe("WorkflowEngine scheduling", () => {
  it("runs independent nodes in parallel and passes upstream outputs", async () => {
    let active = 0;
    let maxActive = 0;
    const gate = deferred();
    const branch = (name: string): NodeHandler =>
      handler(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active--;
        return { status: "passed", output: { name } };
      });
    let joinInput: NodeInput | undefined;
    const { engine } = setup({
      root: pass({ root: true }),
      b1: branch("b1"),
      b2: branch("b2"),
      b3: branch("b3"),
      join: handler((_ctx, input) => {
        joinInput = input;
        return { status: "passed", output: "done" };
      }),
    }, { maxConcurrency: 2 });
    const run = await engine.startRun({
      projectId: "p1",
      inputs: INPUTS,
      definition: workflow([
        spec("root"),
        spec("b1", { dependencies: ["root"] }),
        spec("b2", { dependencies: ["root"] }),
        spec("b3", { dependencies: ["root"] }),
        spec("join", { dependencies: ["b1", "b2", "b3"], config: { mode: "strict" } }),
      ]),
    });
    expect(run.status).toBe("queued");
    await waitUntil(() => active === 2);
    const mid = await engine.getRunState(run.id);
    expect(mid && statusOf(mid, "b3")).toBe("ready");
    expect(mid && nodeOf(mid, "join").waitingOn).toEqual(["b1", "b2", "b3"]);
    expect(mid && statusOf(mid, "join")).toBe("waiting_for_dependency");
    gate.resolve();
    const final = await engine.waitForRun(run.id);
    expect(final.run.status).toBe("completed");
    expect(maxActive).toBe(2);
    expect(joinInput?.upstream).toEqual({ root: { root: true }, b1: { name: "b1" }, b2: { name: "b2" }, b3: { name: "b3" } });
    expect(joinInput?.config).toEqual({ mode: "strict" });
    expect(joinInput?.inputs).toEqual(INPUTS);
    expect(final.run.startedAt).toBeDefined();
    expect(final.run.finishedAt).toBeDefined();
  });

  it("branches with `when` and joins with joinMode any", async () => {
    const definition = workflow([
      spec("check"),
      spec("verify", { dependencies: ["check"], when: { node: "check", path: "available", equals: true } }),
      spec("contractOnly", { dependencies: ["check"], when: { node: "check", path: "available", equals: false } }),
      spec("bind", { dependencies: ["verify", "contractOnly"], joinMode: "any" }),
      spec("afterVerify", { dependencies: ["verify"] }),
    ]);
    for (const available of [true, false]) {
      const { engine } = setup({
        check: pass({ available }),
        verify: pass(),
        contractOnly: pass(),
        bind: pass(),
        afterVerify: pass(),
      });
      const run = await engine.startRun({ projectId: "p", inputs: INPUTS, definition });
      const state = await engine.waitForRun(run.id);
      expect(state.run.status).toBe("completed");
      expect(statusOf(state, "verify")).toBe(available ? "passed" : "skipped");
      expect(statusOf(state, "contractOnly")).toBe(available ? "skipped" : "passed");
      expect(statusOf(state, "bind")).toBe("passed");
      expect(statusOf(state, "afterVerify")).toBe(available ? "passed" : "skipped");
      if (!available) {
        expect(nodeOf(state, "verify").blockerSummary).toBe("condition on check.available not met");
        expect(nodeOf(state, "afterVerify").blockerSummary).toBe("all dependencies were skipped");
      }
    }
  });

  it("joinMode any starts as soon as one dependency passed", async () => {
    const slow = deferred();
    const { engine } = setup({
      fast: pass("fast"),
      slow: handler(async () => {
        await slow.promise;
        return { status: "passed", output: "slow" };
      }),
      any: pass(),
    });
    const run = await engine.startRun({
      projectId: "p",
      inputs: INPUTS,
      definition: workflow([spec("fast"), spec("slow"), spec("any", { dependencies: ["fast", "slow"], joinMode: "any" })]),
    });
    await waitUntil(async () => statusOf((await engine.getRunState(run.id))!, "any") === "passed");
    expect(statusOf((await engine.getRunState(run.id))!, "slow")).toBe("running");
    slow.resolve();
    expect((await engine.waitForRun(run.id)).run.status).toBe("completed");
  });

  it("serializes mutation nodes while read-only nodes run alongside", async () => {
    let mutating = 0;
    let maxMutating = 0;
    let readerOverlappedMutation = false;
    const mutation = handler(async () => {
      mutating++;
      maxMutating = Math.max(maxMutating, mutating);
      await new Promise((r) => setTimeout(r, 15));
      mutating--;
      return { status: "passed", output: null };
    });
    const { engine } = setup({
      m1: mutation,
      m2: mutation,
      m3: mutation,
      r1: handler(async () => {
        if (mutating > 0) readerOverlappedMutation = true;
        await new Promise((r) => setTimeout(r, 5));
        return { status: "passed", output: null };
      }),
    });
    const run = await engine.startRun({
      projectId: "p",
      inputs: INPUTS,
      definition: workflow([spec("m1", { mutation: true }), spec("m2", { mutation: true }), spec("m3", { mutation: true }), spec("r1")]),
    });
    const state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("completed");
    expect(maxMutating).toBe(1);
    expect(readerOverlappedMutation).toBe(true);
  });

  it("derives completed_with_assumptions", async () => {
    const { engine } = setup({
      a: handler(() => ({ status: "passed", output: {}, assumed: true })),
      b: pass(),
    });
    const run = await engine.startRun({
      projectId: "p",
      inputs: INPUTS,
      definition: workflow([spec("a"), spec("b", { dependencies: ["a"] })]),
    });
    const state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("completed_with_assumptions");
    expect(nodeOf(state, "a").assumed).toBe(true);
  });

  it("refuses to start when a node type has no handler", async () => {
    const { engine } = setup({ a: pass() });
    await expect(
      engine.startRun({ projectId: "p", inputs: INPUTS, definition: workflow([spec("a"), spec("b")]) }),
    ).rejects.toThrow(/No handler registered for node type\(s\): b/);
  });
});

describe("WorkflowEngine retry, timeout and failure", () => {
  it("computes backoff delays", () => {
    const policy = { maxAttempts: 5, retryableErrors: [], baseDelayMs: 100 };
    expect([1, 2, 3].map((a) => backoffDelayMs({ ...policy, backoff: "none" }, a))).toEqual([0, 0, 0]);
    expect([1, 2, 3].map((a) => backoffDelayMs({ ...policy, backoff: "linear" }, a))).toEqual([100, 200, 300]);
    expect([1, 2, 3].map((a) => backoffDelayMs({ ...policy, backoff: "exponential" }, a))).toEqual([100, 200, 400]);
  });

  it("retries retryable errors with backoff and then passes", async () => {
    let calls = 0;
    const attempts: number[] = [];
    const { engine, delays, events } = setup({
      flaky: handler((ctx) => {
        calls++;
        attempts.push(ctx.attempt);
        if (calls < 3) throw new NodeError("AGENT_TIMEOUT", "agent timed out");
        return { status: "passed", output: "ok" };
      }),
    });
    const run = await engine.startRun({
      projectId: "p",
      inputs: INPUTS,
      definition: workflow([
        spec("flaky", { retryPolicy: { maxAttempts: 3, backoff: "exponential", baseDelayMs: 100, retryableErrors: ["AGENT_TIMEOUT"] } }),
      ]),
    });
    const state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("completed");
    expect(attempts).toEqual([1, 2, 3]);
    expect(delays).toEqual([100, 200]);
    expect(nodeOf(state, "flaky").attempt).toBe(3);
    const statuses = events.flatMap((e) => (e.type === "node.status_changed" ? [e.payload.status] : []));
    expect(statuses).toEqual(["ready", "running", "retrying", "ready", "running", "retrying", "ready", "running", "passed"]);
  });

  it("fails with RETRY_BUDGET_EXHAUSTED and blocks dependents", async () => {
    let calls = 0;
    const { engine } = setup({
      bad: handler(() => {
        calls++;
        return { status: "failed", error: { code: "COMMAND_FAILED", message: "tests failed" } };
      }),
      next: pass(),
      unrelated: pass(),
    });
    const run = await engine.startRun({
      projectId: "p",
      inputs: INPUTS,
      definition: workflow([
        spec("bad", { retryPolicy: { maxAttempts: 3, backoff: "linear", baseDelayMs: 10, retryableErrors: ["COMMAND_FAILED"] } }),
        spec("next", { dependencies: ["bad"] }),
        spec("unrelated"),
      ]),
    });
    const state = await engine.waitForRun(run.id);
    expect(calls).toBe(3);
    expect(state.run.status).toBe("failed");
    expect(state.run.error?.code).toBe("RETRY_BUDGET_EXHAUSTED");
    expect(nodeOf(state, "bad").error).toMatchObject({ code: "RETRY_BUDGET_EXHAUSTED", retryable: false });
    expect(nodeOf(state, "bad").error?.message).toContain("COMMAND_FAILED: tests failed");
    expect(nodeOf(state, "next")).toMatchObject({ status: "blocked", blockerSummary: "dependency bad failed" });
    expect(statusOf(state, "unrelated")).toBe("passed");
  });

  it("never retries NON_RETRYABLE_ERRORS or errors flagged retryable:false", async () => {
    let calls = 0;
    const { engine } = setup({
      denied: handler(() => {
        calls++;
        throw new NodeError("PERMISSION_DENIED", "no access");
      }),
      flagged: handler(() => {
        calls++;
        throw new NodeError("COMMAND_FAILED", "same root cause", { retryable: false });
      }),
    });
    const policy = { maxAttempts: 5, backoff: "none" as const, retryableErrors: ["PERMISSION_DENIED", "COMMAND_FAILED"] };
    const run = await engine.startRun({
      projectId: "p",
      inputs: INPUTS,
      definition: workflow([spec("denied", { retryPolicy: policy }), spec("flagged", { retryPolicy: policy })]),
    });
    const state = await engine.waitForRun(run.id);
    expect(calls).toBe(2);
    expect(nodeOf(state, "denied")).toMatchObject({ status: "failed", attempt: 1, error: { code: "PERMISSION_DENIED", retryable: false } });
    expect(nodeOf(state, "flagged")).toMatchObject({ status: "failed", attempt: 1, error: { code: "COMMAND_FAILED" } });
  });

  it("converts unknown thrown errors to HANDLER_ERROR", async () => {
    const { engine } = setup({ boom: handler(() => Promise.reject(new Error("kaboom"))) });
    const run = await engine.startRun({ projectId: "p", inputs: INPUTS, definition: workflow([spec("boom")]) });
    const state = await engine.waitForRun(run.id);
    expect(nodeOf(state, "boom").error).toMatchObject({ code: "HANDLER_ERROR", message: "kaboom" });
  });

  it("times out nodes, aborts their signal and retries only if NODE_TIMEOUT is listed", async () => {
    const signals: AbortSignal[] = [];
    const { engine } = setup({
      slow: handler((ctx) => {
        signals.push(ctx.signal);
        return new Promise(() => undefined);
      }),
    });
    const run = await engine.startRun({
      projectId: "p",
      inputs: INPUTS,
      definition: workflow([
        spec("slow", { timeoutMs: 20, retryPolicy: { maxAttempts: 2, backoff: "none", retryableErrors: ["NODE_TIMEOUT"] } }),
      ]),
    });
    const state = await engine.waitForRun(run.id);
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(nodeOf(state, "slow").error?.code).toBe("RETRY_BUDGET_EXHAUSTED");
    expect(nodeOf(state, "slow").error?.message).toContain("NODE_TIMEOUT");

    const { engine: engine2 } = setup({ slow: handler((ctx) => hang(ctx.signal)) });
    const run2 = await engine2.startRun({ projectId: "p", inputs: INPUTS, definition: workflow([spec("slow", { timeoutMs: 20 })]) });
    const state2 = await engine2.waitForRun(run2.id);
    expect(nodeOf(state2, "slow")).toMatchObject({ status: "failed", attempt: 1, error: { code: "NODE_TIMEOUT" } });
  });

  it("runs beforeMutation for mutation nodes; CHECKPOINT_INVALIDATED is not retried", async () => {
    let implementCalls = 0;
    const checked: string[] = [];
    const { engine } = setup(
      {
        read: pass(),
        implement: handler(() => {
          implementCalls++;
          return { status: "passed", output: null };
        }),
      },
      {
        beforeMutation: ({ node }) => {
          checked.push(node.id);
          throw new NodeError("CHECKPOINT_INVALIDATED", "base SHA changed");
        },
      },
    );
    const run = await engine.startRun({
      projectId: "p",
      inputs: INPUTS,
      definition: workflow([
        spec("read"),
        spec("implement", {
          dependencies: ["read"],
          mutation: true,
          retryPolicy: { maxAttempts: 3, backoff: "none", retryableErrors: ["CHECKPOINT_INVALIDATED"] },
        }),
      ]),
    });
    const state = await engine.waitForRun(run.id);
    expect(checked).toEqual(["implement"]);
    expect(implementCalls).toBe(0);
    expect(nodeOf(state, "implement")).toMatchObject({ status: "failed", attempt: 1, error: { code: "CHECKPOINT_INVALIDATED" } });
  });

  it("marks blocked results and derives a blocked run", async () => {
    const { engine } = setup({
      gate: handler(() => ({ status: "blocked", summary: "required gate lint failed", output: { lint: "failed" } })),
      report: pass(),
    });
    const run = await engine.startRun({
      projectId: "p",
      inputs: INPUTS,
      definition: workflow([spec("gate"), spec("report", { dependencies: ["gate"] })]),
    });
    const state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("blocked");
    expect(nodeOf(state, "gate")).toMatchObject({ status: "blocked", blockerSummary: "required gate lint failed", output: { lint: "failed" } });
    expect(nodeOf(state, "report").blockerSummary).toBe("dependency gate blocked");
  });

  it("times out the whole run", async () => {
    const { engine } = setup({ slow: handler((ctx) => hang(ctx.signal)) });
    const run = await engine.startRun({
      projectId: "p",
      inputs: INPUTS,
      definition: workflow([spec("slow"), spec("after", { type: "slow", dependencies: ["slow"] })], { timeoutMs: 30 }),
    });
    const state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("timed_out");
    expect(state.run.error?.code).toBe("RUN_TIMEOUT");
    expect(state.nodes.map((n) => n.status)).toEqual(["cancelled", "cancelled"]);
  });
});

describe("WorkflowEngine control operations", () => {
  it("pauses (aborting running nodes back to ready) and resumes", async () => {
    let calls = 0;
    const signals: AbortSignal[] = [];
    const release = deferred();
    const { engine } = setup({
      work: handler(async (ctx) => {
        calls++;
        signals.push(ctx.signal);
        if (calls === 1) return hang(ctx.signal);
        await release.promise;
        return { status: "passed", output: "done" };
      }),
      after: pass(),
    });
    const run = await engine.startRun({
      projectId: "p",
      inputs: INPUTS,
      definition: workflow([spec("work"), spec("after", { dependencies: ["work"] })]),
    });
    await waitUntil(() => calls === 1);
    const paused = await engine.pause(run.id);
    expect(paused.run.status).toBe("paused");
    expect(nodeOf(paused, "work")).toMatchObject({ status: "ready", attempt: 0 });
    expect(signals[0]?.aborted).toBe(true);
    expect((await engine.waitForRun(run.id)).run.status).toBe("paused");

    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);

    await engine.resume(run.id);
    await waitUntil(() => calls === 2);
    release.resolve();
    const state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("completed");
    expect(nodeOf(state, "work").attempt).toBe(1);
  });

  it("cancels running and pending nodes", async () => {
    const started = deferred();
    let signal: AbortSignal | undefined;
    const { engine } = setup({
      work: handler((ctx) => {
        signal = ctx.signal;
        started.resolve();
        return hang(ctx.signal);
      }),
      done: pass(),
      after: pass(),
    });
    const run = await engine.startRun({
      projectId: "p",
      inputs: INPUTS,
      definition: workflow([spec("done"), spec("work"), spec("after", { dependencies: ["work"] })]),
    });
    await started.promise;
    const state = await engine.cancel(run.id);
    expect(state.run.status).toBe("cancelled");
    expect(signal?.aborted).toBe(true);
    expect(statusOf(state, "work")).toBe("cancelled");
    expect(statusOf(state, "after")).toBe("cancelled");
    expect(statusOf(state, "done")).toBe("passed");
    await expect(engine.resume(run.id)).rejects.toThrow(/not paused/);
    expect((await engine.waitForRun(run.id)).run.status).toBe("cancelled");
  });

  it("resumes a waiting_for_input node with provideInput", async () => {
    const seen: unknown[] = [];
    const { engine } = setup({
      verify: handler((_ctx, input) => {
        seen.push(input.providedInput);
        if (input.providedInput === undefined) {
          return { status: "waiting_for_input", prompt: "Upload an updated BA document", output: { issues: 2 } };
        }
        return { status: "passed", output: { verified: input.providedInput } };
      }),
      map: pass(),
    });
    const run = await engine.startRun({
      projectId: "p",
      inputs: INPUTS,
      definition: workflow([spec("verify"), spec("map", { dependencies: ["verify"] })]),
    });
    const waiting = await engine.waitForRun(run.id);
    expect(waiting.run.status).toBe("waiting");
    expect(nodeOf(waiting, "verify")).toMatchObject({
      status: "waiting_for_input",
      blockerSummary: "Upload an updated BA document",
      output: { issues: 2 },
    });
    expect(statusOf(waiting, "map")).toBe("waiting_for_dependency");

    await expect(engine.provideInput(run.id, "map", {})).rejects.toThrow(/not waiting_for_input/);
    await engine.provideInput(run.id, "verify", { snapshotId: "snap_2" });
    const state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("completed");
    expect(seen).toEqual([undefined, { snapshotId: "snap_2" }]);
    expect(nodeOf(state, "verify").output).toEqual({ verified: { snapshotId: "snap_2" } });
  });

  it("retries a failed node manually and re-opens blocked dependents", async () => {
    let healthy = false;
    const { engine } = setup({
      api: handler(() =>
        healthy ? { status: "passed", output: "client" } : { status: "failed", error: { code: "DOCUMENT_CONFLICT", message: "BA vs API" } },
      ),
      tests: pass(),
      side: pass(),
    });
    const run = await engine.startRun({
      projectId: "p",
      inputs: INPUTS,
      definition: workflow([spec("api"), spec("tests", { dependencies: ["api"] }), spec("side")]),
    });
    const failed = await engine.waitForRun(run.id);
    expect(failed.run.status).toBe("failed");
    expect(statusOf(failed, "tests")).toBe("blocked");
    await expect(engine.retryNode(run.id, "side")).rejects.toThrow(/only failed or blocked/);

    healthy = true;
    await engine.retryNode(run.id, "api");
    const state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("completed");
    expect(state.run.error).toBeUndefined();
    expect(state.run.finishedAt).toBeDefined();
    expect(nodeOf(state, "api")).toMatchObject({ status: "passed", attempt: 1 });
    expect(nodeOf(state, "tests").blockerSummary).toBeUndefined();
  });
});

describe("WorkflowEngine persistence, idempotency and recovery", () => {
  it("reuses cached outputs for read-only nodes but never for mutation nodes", async () => {
    const calls: Record<string, number> = { read: 0, write: 0 };
    const store = new InMemoryRunStore();
    const definition = workflow([
      spec("read", { readOnly: true }),
      spec("write", { dependencies: ["read"], mutation: true }),
    ]);
    const handlers = {
      read: handler(() => {
        calls.read = (calls.read ?? 0) + 1;
        return { status: "passed", output: { parsed: 42 }, assumed: true };
      }),
      write: handler(() => {
        calls.write = (calls.write ?? 0) + 1;
        return { status: "passed", output: null };
      }),
    };
    const { engine, events } = setup(handlers, { store });
    const first = await engine.waitForRun((await engine.startRun({ projectId: "p", inputs: INPUTS, definition })).id);
    const second = await engine.waitForRun((await engine.startRun({ projectId: "p", inputs: INPUTS, definition })).id);
    expect(calls).toEqual({ read: 1, write: 2 });
    expect(nodeOf(second, "read")).toMatchObject({ status: "passed", output: { parsed: 42 }, assumed: true });
    expect(nodeOf(second, "read").idempotencyKey).toBe(nodeOf(first, "read").idempotencyKey);
    expect(second.run.status).toBe("completed_with_assumptions");
    const outputs = events.flatMap((e) => (e.type === "node.output" && e.payload.nodeId === "read" ? [e.payload.cached] : []));
    expect(outputs).toEqual([false, true]);

    await engine.waitForRun(
      (await engine.startRun({ projectId: "p", inputs: { snapshotIds: ["snap_changed"] }, definition })).id,
    );
    expect(calls.read).toBe(2);
  });

  it("persists state before emitting and redacts stored/delivered events", async () => {
    const store = new InMemoryRunStore();
    const secret = "sk-ant-" + "a".repeat(30);
    const { engine, events } = setup(
      {
        agent: handler((ctx) => {
          ctx.log("info", `calling with ${secret}`, { apiKey: "hunter2" });
          ctx.emitArtifact({ artifactId: "art_1", kind: "diff", label: "UI diff" });
          ctx.emit(
            createAgentEvent("message.delta", { traceId: "x", workflowRunId: "x" }, { role: "assistant", text: `token ${secret}` }),
          );
          return { status: "passed", output: { ok: true } };
        }),
      },
      { store },
    );
    const mismatches: string[] = [];
    engine.subscribe((event) => {
      if (event.type !== "node.status_changed") return;
      const stored = store.listNodeRuns(event.workflowRunId).find((n) => n.id === event.nodeRunId);
      if (stored?.status !== event.payload.status) mismatches.push(event.payload.status);
    });
    const run = await engine.startRun({ projectId: "p", inputs: INPUTS, definition: workflow([spec("agent")]) });
    await engine.waitForRun(run.id);
    await waitUntil(() => events.some((e) => e.type === "message.delta"));
    expect(mismatches).toEqual([]);

    const stored = store.listEvents(run.id);
    expect(stored.map((e) => e.id)).toEqual(expect.arrayContaining(events.map((e) => e.id)));
    const serialized = JSON.stringify(stored) + JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("hunter2");
    const delta = events.find((e) => e.type === "message.delta");
    const nodeRunId = (await engine.getRunState(run.id))?.nodes[0]?.id;
    expect(delta).toMatchObject({ workflowRunId: run.id, traceId: run.traceId, nodeRunId });
    expect(events.some((e) => e.type === "node.artifact" && e.payload.artifactId === "art_1")).toBe(true);
    expect(new Set(stored.map((e) => e.traceId))).toEqual(new Set([run.traceId]));
  });

  it("recovers a run after restart: passed nodes keep outputs, interrupted nodes re-run", async () => {
    const store = new InMemoryRunStore();
    const definition = workflow([
      spec("a"),
      spec("b", { dependencies: ["a"] }),
      spec("c", { dependencies: ["b"] }),
    ]);
    const firstCalls: string[] = [];
    const engine1 = setup(
      {
        a: handler(() => {
          firstCalls.push("a");
          return { status: "passed", output: "A" };
        }),
        b: handler(() => {
          firstCalls.push("b");
          return new Promise(() => undefined);
        }),
        c: pass(),
      },
      { store },
    ).engine;
    const run = await engine1.startRun({ projectId: "p", inputs: INPUTS, definition });
    await waitUntil(() => store.listNodeRuns(run.id).find((n) => n.nodeId === "b")?.status === "running");
    engine1.shutdown();

    const secondCalls: string[] = [];
    let bInput: NodeInput | undefined;
    const { engine: engine2 } = setup(
      {
        a: handler(() => {
          secondCalls.push("a");
          return { status: "passed", output: "A2" };
        }),
        b: handler((_ctx, input) => {
          secondCalls.push("b");
          bInput = input;
          return { status: "passed", output: "B" };
        }),
        c: handler(() => {
          secondCalls.push("c");
          return { status: "passed", output: "C" };
        }),
      },
      { store },
    );
    engine2.registerDefinition(definition);
    const result = await engine2.recover();
    expect(result).toEqual({ recovered: [run.id], missingDefinitions: [] });
    const state = await engine2.waitForRun(run.id);
    expect(state.run.status).toBe("completed");
    expect(firstCalls).toEqual(["a", "b"]);
    expect(secondCalls).toEqual(["b", "c"]);
    expect(bInput?.upstream).toEqual({ a: "A" });
    expect(nodeOf(state, "b").attempt).toBe(1);
    expect(store.getRun(run.id)?.status).toBe("completed");
  });

  it("keeps paused runs paused on recovery and reports missing definitions", async () => {
    const store = new InMemoryRunStore();
    const definition = workflow([spec("a"), spec("b", { dependencies: ["a"] })]);
    const { engine: engine1 } = setup({ a: pass("A"), b: handler((ctx) => hang(ctx.signal)) }, { store });
    const run = await engine1.startRun({ projectId: "p", inputs: INPUTS, definition });
    await waitUntil(() => store.listNodeRuns(run.id).find((n) => n.nodeId === "b")?.status === "running");
    await engine1.pause(run.id);
    engine1.shutdown();

    const { engine: blind } = setup({ a: pass(), b: pass() }, { store });
    expect(await blind.recover()).toEqual({
      recovered: [],
      missingDefinitions: [{ runId: run.id, workflowId: "test-wf", workflowVersion: 1 }],
    });

    const { engine: engine2 } = setup({ a: pass("A2"), b: pass("B") }, { store });
    engine2.registerDefinition(definition);
    await engine2.recover();
    const paused = await engine2.waitForRun(run.id);
    expect(paused.run.status).toBe("paused");
    expect(statusOf(paused, "b")).toBe("ready");
    await engine2.resume(run.id);
    const state = await engine2.waitForRun(run.id);
    expect(state.run.status).toBe("completed");
    expect(nodeOf(state, "a").output).toBe("A");
  });
});

describe("built-in feature-delivery workflow", () => {
  it("runs the composed A/B/C graph end to end with stub handlers", async () => {
    const definition = loadBuiltinWorkflows(fileURLToPath(new URL("../../../workflows", import.meta.url)));
    const handlers: Record<string, NodeHandler> = {};
    for (const node of definition.nodes) handlers[node.type] = pass({ node: node.id });
    let waitedOnce = false;
    handlers["readiness.map"] = handler((_ctx, input) => {
      if (!input.providedInput && !waitedOnce) {
        waitedOnce = true;
        return { status: "waiting_for_input", prompt: "UIR-002 has no API operation; update the API contract" };
      }
      return { status: "passed", output: { readiness: "ready" } };
    });
    handlers["tests.read_ba"] = handler((_ctx, input) =>
      input.providedInput ? { status: "passed", output: { requirements: [] } } : { status: "waiting_for_input", prompt: "Import the BA specification" },
    );
    const { engine } = setup(handlers, { maxConcurrency: 3 });
    const run = await engine.startRun({ projectId: "p", inputs: INPUTS, definition });

    const waiting = await engine.waitForRun(run.id);
    expect(waiting.run.status).toBe("waiting");
    // Project analysis runs in parallel with A; implementation waits for the readiness gate.
    expect(statusOf(waiting, "B.prepare_project")).toBe("passed");
    expect(nodeOf(waiting, "B.implement_ui").waitingOn).toEqual(["A.readiness"]);

    await engine.provideInput(run.id, "A.readiness", { accept: true });
    // Without a BA spec, B still completes and the run is only test_design_pending (spec §11.1).
    const pending = await engine.waitForRun(run.id);
    expect(pending.run.status).toBe("test_design_pending");
    expect(statusOf(pending, "B.quality_gates")).toBe("passed");
    expect(nodeOf(pending, "C2.generate_tests").waitingOn).toEqual(["C1.test_design"]);

    await engine.provideInput(run.id, "C1.ba_spec", { ba: { snapshotId: "s" } });
    const state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("completed");
    expect(statusOf(state, "C2.evidence_report")).toBe("passed");
  });
});
