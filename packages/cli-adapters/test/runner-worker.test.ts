import { afterAll, describe, expect, it } from "vitest";
import {
  FakeCliAdapter,
  RunnerClient,
  startRunnerWorker,
  type RunnerPort,
} from "../src/index.js";
import { collectFrom, ctxInput, tempDir } from "./helpers.js";

type Listener = (message: unknown) => void;

/**
 * In-memory port pair. The worker side mimics Electron's parentPort
 * (messages wrapped as `{ data }`), the main side mimics UtilityProcess (raw).
 * Messages are structured-cloned and delivered asynchronously like real IPC.
 */
function createPortPair(): { main: RunnerPort; worker: RunnerPort } {
  const mainListeners = new Set<Listener>();
  const workerListeners = new Set<Listener>();
  const deliver = (targets: Set<Listener>, msg: unknown) => {
    const copy = structuredClone(msg);
    setImmediate(() => {
      for (const l of [...targets]) l(copy);
    });
  };
  return {
    main: {
      postMessage: (msg) => deliver(workerListeners, { data: msg }),
      on: (_e, l) => mainListeners.add(l),
      off: (_e, l) => mainListeners.delete(l),
    },
    worker: {
      postMessage: (msg) => deliver(mainListeners, msg),
      on: (_e, l) => workerListeners.add(l),
      off: (_e, l) => workerListeners.delete(l),
    },
  };
}

describe("runner worker protocol", () => {
  const ws = tempDir("ff-worker-");
  afterAll(() => ws.cleanup());

  it("round-trips requests, events and raw output", async () => {
    const { main, worker } = createPortPair();
    const host = startRunnerWorker(worker, { adapters: [new FakeCliAdapter()] });
    const client = new RunnerClient(main, { requestTimeoutMs: 10_000 });
    const raw: string[] = [];
    client.onRaw((_id, chunk) => raw.push(chunk));

    const detections = await client.detect();
    expect(detections[0]).toMatchObject({ adapterId: "fake", detection: { installed: true } });

    const session = await client.start("fake", { ...ctxInput, cwd: ws.dir, prompt: "scenario:approval" });
    expect(session).toMatchObject({ adapterId: "fake", status: "running", traceId: ctxInput.traceId });
    const scoped = collectFrom((h) => client.subscribeSession(session.id, h));
    const all = collectFrom((h) => client.subscribe(h));

    const req = await scoped.waitFor((e) => e.type === "approval.required");
    const requestId = (req.payload as { requestId: string }).requestId;
    await expect(client.approve(session.id, "bogus")).rejects.toMatchObject({ code: "UNKNOWN_APPROVAL" });
    await client.approve(session.id, requestId);
    const end = await scoped.done();
    expect(end.type).toBe("session.completed");
    expect(all.events.length).toBeGreaterThanOrEqual(scoped.events.length);
    expect(scoped.events[0]?.type).toBe("session.started");

    const listed = await client.list();
    expect(listed.find((s) => s.id === session.id)?.status).toBe("completed");
    await new Promise((r) => setTimeout(r, 50));
    expect(raw.join("")).toContain('"type":"result"');

    await expect(client.start("missing", { ...ctxInput, cwd: ws.dir, prompt: "x" })).rejects.toMatchObject({
      code: "ADAPTER_NOT_FOUND",
    });
    await expect(client.send("ses_unknown", "x")).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });

    client.dispose();
    host.dispose();
    await expect(client.list()).rejects.toMatchObject({ code: "RUNNER_GONE" });
  });

  it("cancels through the worker and rejects malformed requests", async () => {
    const { main, worker } = createPortPair();
    const host = startRunnerWorker(worker, { adapters: [new FakeCliAdapter()] });
    const client = new RunnerClient(main);
    const session = await client.start("fake", { ...ctxInput, cwd: ws.dir, prompt: "scenario:slow" });
    const c = collectFrom((h) => client.subscribeSession(session.id, h));
    await c.waitFor((e) => e.type === "message.delta");
    await client.cancel(session.id);
    const end = await c.done();
    expect(end).toMatchObject({ type: "session.failed", payload: { code: "CANCELLED" } });

    const replies: unknown[] = [];
    main.on("message", (m) => replies.push(m));
    main.postMessage({ requestId: "r_bad", type: "send", sessionId: 42 });
    await new Promise((r) => setTimeout(r, 20));
    expect(replies).toContainEqual({
      type: "response",
      requestId: "r_bad",
      ok: false,
      error: { code: "BAD_REQUEST", message: "Invalid runner request" },
    });
    client.dispose();
    host.dispose();
  });

  it("times out requests the worker never answers", async () => {
    const { main } = createPortPair();
    const client = new RunnerClient(main, { requestTimeoutMs: 50 });
    await expect(client.list()).rejects.toMatchObject({ code: "TIMEOUT" });
    client.dispose();
  });
});
