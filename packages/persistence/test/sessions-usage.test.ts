import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, openDatabase, type AiSessionRecord, type FrontflowDb, type UsageEventRecord } from "../src/index.js";
import { makeTempDir, project, seedProjectAndRun } from "./helpers.js";

function session(id: string, overrides: Partial<AiSessionRecord> = {}): AiSessionRecord {
  return {
    id,
    projectId: "proj_1",
    adapterId: "claude-code",
    mode: "structured",
    status: "thinking",
    cwd: "D:/work/proj_1",
    startedAt: "2026-10-20T10:00:00.000Z",
    ...overrides,
  };
}

function usage(eventId: string, overrides: Partial<UsageEventRecord> = {}): UsageEventRecord {
  return {
    eventId,
    projectId: "proj_1",
    sessionId: "sess_a",
    provider: "claude-code",
    model: "claude-sonnet-5-5",
    scope: "message",
    occurredAt: "2026-10-20T10:01:00.000Z",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0.001,
    pricingVersion: "test",
    rawSource: "claude-code:structured",
    parserVersion: 1,
    ...overrides,
  };
}

const event = (id: string, sessionId: string, workflowRunId: string, timestamp: string) => ({
  id,
  type: "message.delta",
  timestamp,
  workflowRunId,
  sessionId,
  traceId: "trace_x",
  payload: { role: "assistant", text: id },
});

describe("session activity and usage", () => {
  let db: FrontflowDb;
  beforeEach(() => {
    db = openDatabase(":memory:");
    db.projects.upsert(project());
  });
  afterEach(() => db.close());

  it("touches activity forward only", () => {
    db.aiSessions.save(session("sess_a"));
    db.aiSessions.touch("sess_a", "2026-10-20T10:05:00.000Z");
    db.aiSessions.touch("sess_a", "2026-10-20T10:01:00.000Z");
    expect(db.aiSessions.get("sess_a")?.lastActivityAt).toBe("2026-10-20T10:05:00.000Z");
  });

  it("drops a deleted session's usage rows", () => {
    db.aiSessions.save(session("sess_a"));
    db.usage.record(usage("u1"));
    db.driver.prepare("DELETE FROM ai_sessions WHERE id = 'sess_a'").run();
    expect(db.usage.bySession("proj_1").size).toBe(0);
  });

  it("sums message and turn reports, dedups re-reported messages, and falls back to the latest total", () => {
    // Same API message reported twice while streaming: the last report wins.
    db.usage.record(usage("sess_a:msg_1", { inputTokens: 100, outputTokens: 1 }));
    db.usage.record(usage("sess_a:msg_1", { inputTokens: 100, outputTokens: 40, cacheReadTokens: 60 }));
    db.usage.record(usage("sess_a:msg_2", { inputTokens: 200, outputTokens: 20, model: "mystery-model", estimatedCostUsd: undefined }));
    // The running total of the same session is ignored for tokens, but its reported cost is kept.
    db.usage.record(usage("evt_total", { scope: "total", inputTokens: 999, outputTokens: 999, sourceCostUsd: 0.5 }));
    // A session with only running totals uses the latest one.
    db.usage.record(usage("t1", { sessionId: "sess_b", scope: "total", inputTokens: 50, outputTokens: 5, occurredAt: "2026-10-20T10:01:00.000Z" }));
    db.usage.record(usage("t2", { sessionId: "sess_b", scope: "total", inputTokens: 80, outputTokens: 8, occurredAt: "2026-10-20T10:02:00.000Z" }));

    const { total, sessions } = db.usage.forProject("proj_1");
    expect(sessions.get("sess_a")).toMatchObject({
      inputTokens: 300,
      outputTokens: 60,
      cacheReadTokens: 60,
      sourceCostUsd: 0.5,
      unpricedModels: ["mystery-model"],
      basis: "fine",
    });
    expect(sessions.get("sess_a")?.estimatedCostUsd).toBeCloseTo(0.001, 9);
    expect(sessions.get("sess_b")).toMatchObject({ inputTokens: 80, outputTokens: 8, basis: "total" });
    expect(total).toMatchObject({ inputTokens: 380, outputTokens: 68, basis: "total", unpricedModels: ["mystery-model"] });
  });
});

describe("migration 2 on an existing database", () => {
  let tmp: ReturnType<typeof makeTempDir>;
  beforeEach(() => (tmp = makeTempDir()));
  afterEach(() => tmp.cleanup());

  it("keeps v1 agent events and sessions through the agent_events rebuild", () => {
    const file = join(tmp.dir, "database.sqlite");
    const v1 = openDatabase(file, { migrations: MIGRATIONS.filter((m) => m.version === 1) });
    try {
      seedProjectAndRun(v1);
      v1.runStore.appendEvent(event("e_old", "sess_old", "run_1", "2026-10-01T10:00:00.000Z"));
      // The v1 schema has no title / last_activity_at: write the row as v1 did.
      v1.driver
        .prepare(
          `INSERT INTO ai_sessions (id, project_id, workflow_run_id, adapter_id, mode, status, cwd, started_at, updated_at)
           VALUES ('sess_old', 'proj_1', 'run_1', 'claude-code', 'structured', 'completed', 'D:/work/proj_1', '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z')`,
        )
        .run();
    } finally {
      v1.close();
    }

    const db = openDatabase(file);
    try {
      expect(db.schemaVersion).toBe(MIGRATIONS.at(-1)!.version);
      expect(db.runStore.listEvents("run_1").map((e) => e.id)).toEqual(["e_old"]);
      expect(db.aiSessions.get("sess_old")).toMatchObject({ workflowRunId: "run_1" });
      db.runStore.appendEvent(event("e_new", "sess_old", "run_1", "2026-10-02T10:00:00.000Z"));
      // Sequence keeps growing after the table rebuild.
      const [oldSeq, newSeq] = db.runStore.listEvents("run_1").map((e) => e.seq);
      expect(newSeq!).toBeGreaterThan(oldSeq!);
      // Run events still go with their run.
      db.runStore.deleteRun("run_1");
      expect(db.runStore.listEvents("run_1")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
