import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunStore } from "@frontflow/domain";
import { openDatabase, SqliteRunStore, WorkflowDefinitionError, type FrontflowDb } from "../src/index.js";
import { nodeRun, project, run, seedProjectAndRun } from "./helpers.js";

describe("SqliteRunStore", () => {
  let db: FrontflowDb;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });
  afterEach(() => db.close());

  it("implements the domain RunStore contract", () => {
    const store: RunStore = db.runStore;
    expect(store).toBeInstanceOf(SqliteRunStore);
  });

  it("round-trips runs and updates in place", () => {
    const r = seedProjectAndRun(db);
    expect(db.runStore.getRun(r.id)).toEqual(r);
    const finished = { ...r, status: "failed" as const, finishedAt: "2026-10-01T11:00:00.000Z", error: { code: "X", message: "boom" } };
    db.runStore.saveRun(finished);
    expect(db.runStore.getRun(r.id)).toEqual(finished);
    expect(db.runStore.getRun("nope")).toBeUndefined();
  });

  it("lists active runs only (queued/running/waiting/paused), oldest first", () => {
    db.projects.upsert(project());
    const statuses = ["queued", "running", "waiting", "paused", "completed", "failed", "cancelled", "blocked"] as const;
    statuses.forEach((status, i) =>
      db.runStore.saveRun(run(`run_${status}`, { status, createdAt: `2026-10-01T10:0${i}:00.000Z` })),
    );
    expect(db.runStore.listActiveRuns().map((r) => r.status)).toEqual(["queued", "running", "waiting", "paused"]);
    expect(db.runStore.listRuns({ projectId: "proj_1", limit: 2 }).map((r) => r.id)).toEqual(["run_blocked", "run_cancelled"]);
    expect(db.runStore.listRuns({ statuses: ["failed"] }).map((r) => r.id)).toEqual(["run_failed"]);
    expect(db.runStore.listRuns({ projectId: "other" })).toEqual([]);
  });

  it("keeps node run order stable across updates", () => {
    seedProjectAndRun(db);
    const a = nodeRun("nr_a");
    const b = nodeRun("nr_b", { nodeId: "A.EXTRACT_API" });
    db.runStore.saveNodeRun(a);
    db.runStore.saveNodeRun(b);
    const aDone = { ...a, status: "passed" as const, output: { ok: true }, attempt: 2 };
    db.runStore.saveNodeRun(aDone);
    expect(db.runStore.listNodeRuns("run_1")).toEqual([aDone, b]);
    expect(db.runStore.getNodeRun("nr_b")).toEqual(b);
  });

  it("returns the latest passed output for an idempotency key", () => {
    seedProjectAndRun(db);
    db.runStore.saveNodeRun(nodeRun("nr_1", { idempotencyKey: "key", status: "passed", output: { v: 1 }, finishedAt: "2026-10-01T10:01:00.000Z" }));
    db.runStore.saveNodeRun(
      nodeRun("nr_2", { idempotencyKey: "key", status: "passed", output: { v: 2 }, assumed: true, finishedAt: "2026-10-01T10:02:00.000Z" }),
    );
    db.runStore.saveNodeRun(nodeRun("nr_3", { idempotencyKey: "key", status: "failed", output: { v: 3 }, finishedAt: "2026-10-01T10:03:00.000Z" }));
    expect(db.runStore.getCachedOutput("key")).toEqual({ output: { v: 2 }, assumed: true });
    expect(db.runStore.getCachedOutput("other")).toBeUndefined();
  });

  it("appends events idempotently, redacts payloads and lists them in order with filters", () => {
    seedProjectAndRun(db);
    const base = { workflowRunId: "run_1", traceId: "trace_run_1" };
    db.runStore.appendEvent({ ...base, id: "e3", type: "node.completed", timestamp: "2026-10-01T10:00:03.000Z", nodeRunId: "nr_a", payload: { n: 3 } });
    db.runStore.appendEvent({ ...base, id: "e1", type: "node.started", timestamp: "2026-10-01T10:00:01.000Z", nodeRunId: "nr_a", payload: { n: 1 } });
    db.runStore.appendEvent({
      ...base,
      id: "e2",
      type: "message.delta",
      timestamp: "2026-10-01T10:00:01.000Z",
      sessionId: "sess_1",
      confidence: 0.6,
      payload: { text: "export API_TOKEN=abcdef123456", apiKey: "sk-ant-abcdefghijklmnopqrstuvwxyz" },
    });
    db.runStore.appendEvent({ ...base, id: "e1", type: "node.started", timestamp: "2026-10-01T10:00:09.000Z", payload: { dup: true } });

    const all = db.runStore.listEvents("run_1");
    expect(all.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(all[0]).toMatchObject({ type: "node.started", nodeRunId: "nr_a", payload: { n: 1 } });
    expect(all[1]).toMatchObject({ sessionId: "sess_1", confidence: 0.6 });
    expect(JSON.stringify(all[1]!.payload)).not.toContain("abcdef123456");
    expect(JSON.stringify(all[1]!.payload)).not.toContain("sk-ant-");

    expect(db.runStore.listEvents("run_1", { afterTimestamp: "2026-10-01T10:00:01.000Z" }).map((e) => e.id)).toEqual(["e3"]);
    expect(db.runStore.listEvents("run_1", { types: ["node.started", "node.completed"] }).map((e) => e.id)).toEqual(["e1", "e3"]);
    expect(db.runStore.listEvents("run_1", { limit: 2 }).map((e) => e.id)).toEqual(["e1", "e2"]);
    const cursor = all[1]!.seq;
    expect(db.runStore.listEvents("run_1", { afterSeq: cursor }).map((e) => e.id)).toEqual(
      all.filter((e) => e.seq > cursor).map((e) => e.id),
    );
  });

  it("cascades run deletion to node runs and events", () => {
    seedProjectAndRun(db);
    db.runStore.saveNodeRun(nodeRun("nr_a"));
    db.runStore.appendEvent({ id: "e1", type: "x", timestamp: "2026-10-01T10:00:00.000Z", workflowRunId: "run_1", traceId: "t", payload: {} });
    expect(db.runStore.deleteRun("run_1")).toBe(true);
    expect(db.runStore.listNodeRuns("run_1")).toEqual([]);
    expect(db.runStore.listEvents("run_1")).toEqual([]);
  });
});

describe("WorkflowDefinitionRepository", () => {
  it("saves immutable versions and returns latest by default", () => {
    const db = openDatabase(":memory:");
    try {
      const v1 = { nodes: ["A1", "A2"] };
      db.workflowDefinitions.save({ id: "workflow-a", version: 1, name: "BA/API", definition: v1 });
      db.workflowDefinitions.save({ id: "workflow-a", version: 1, name: "BA/API", definition: v1 });
      db.workflowDefinitions.save({ id: "workflow-a", version: 2, name: "BA/API", definition: { nodes: ["A1"] } });
      expect(db.workflowDefinitions.get("workflow-a", 1)?.definition).toEqual(v1);
      expect(db.workflowDefinitions.get("workflow-a")?.version).toBe(2);
      expect(db.workflowDefinitions.listVersions("workflow-a")).toEqual([1, 2]);
      expect(() => db.workflowDefinitions.save({ id: "workflow-a", version: 1, name: "BA/API", definition: { changed: true } })).toThrow(
        WorkflowDefinitionError,
      );
    } finally {
      db.close();
    }
  });
});
