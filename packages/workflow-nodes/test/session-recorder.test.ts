import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentEvent, type AgentEvent } from "@frontflow/event-schema";
import { ArtifactStore, openDatabase, type FrontflowDb } from "@frontflow/persistence";
import { createSessionRecorder } from "../src/index.js";

describe("session recorder", () => {
  let dir: string;
  let db: FrontflowDb;
  let recorder: ReturnType<typeof createSessionRecorder>;
  const ctx = { traceId: "trace_1", workflowRunId: "adhoc_1", sessionId: "sess_1" };
  const at = (event: AgentEvent, timestamp: string): AgentEvent => ({ ...event, timestamp });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ff-recorder-"));
    db = openDatabase(":memory:");
    db.projects.upsert({ id: "proj_1", name: "P", rootPath: dir, createdAt: "2026-10-01T00:00:00.000Z", lastOpenedAt: "2026-10-01T00:00:00.000Z" });
    const store = new ArtifactStore({ rootDir: dir, db, rawLogs: false });
    recorder = createSessionRecorder(db, store, {
      standalone: (runId) => (runId === "adhoc_1" ? { projectId: "proj_1", title: "Fix login", metadata: { kind: "chat", origin: "sessions" } } : undefined),
      activityWriteMs: 0,
    });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records a standalone session without a run, with its status, activity and usage", () => {
    recorder.onEvent(at(createAgentEvent("session.started", ctx, { adapterId: "claude-code", cwd: dir, externalSessionId: "ext-1", model: "claude-sonnet-5-5" }), "2026-10-20T10:00:00.000Z"));
    expect(db.aiSessions.get("sess_1")).toMatchObject({
      projectId: "proj_1",
      title: "Fix login",
      metadata: { kind: "chat", origin: "sessions" },
      externalSessionId: "ext-1",
      lastActivityAt: "2026-10-20T10:00:00.000Z",
    });
    expect(db.aiSessions.get("sess_1")?.workflowRunId).toBeUndefined();

    recorder.onEvent(at(createAgentEvent("status.changed", ctx, { status: "running_tool", detail: "Edit" }), "2026-10-20T10:00:05.000Z"));
    expect(db.aiSessions.get("sess_1")).toMatchObject({ status: "running_tool", lastActivityAt: "2026-10-20T10:00:05.000Z" });

    // Streaming re-reports one message; then the CLI's running total.
    const usage = (payload: Parameters<typeof createAgentEvent<"usage.updated">>[2]) => recorder.onEvent(createAgentEvent("usage.updated", ctx, payload));
    usage({ inputTokens: 1000, outputTokens: 3, scope: "message", messageId: "msg_1" });
    usage({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 600, scope: "message", messageId: "msg_1" });
    usage({ inputTokens: 5000, outputTokens: 5000, costUsd: 0.2, scope: "total" });

    const summary = db.usage.bySession("proj_1").get("sess_1");
    expect(summary).toMatchObject({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 600, sourceCostUsd: 0.2, models: ["claude-sonnet-5-5"], unpricedModels: [] });
    // 400 uncached × $2 + 600 × $0.20 + 200 × $10 per million.
    expect(summary?.estimatedCostUsd).toBeCloseTo((400 * 2 + 600 * 0.2 + 200 * 10) / 1_000_000, 9);

    recorder.onEvent(at(createAgentEvent("session.failed", ctx, { code: "CANCELLED", message: "stopped" }), "2026-10-20T10:01:00.000Z"));
    expect(db.aiSessions.get("sess_1")).toMatchObject({ status: "cancelled", endedAt: "2026-10-20T10:01:00.000Z" });
  });

  it("ignores events of unknown runs", () => {
    recorder.onEvent(createAgentEvent("session.started", { ...ctx, workflowRunId: "adhoc_other" }, { adapterId: "codex", cwd: dir }));
    expect(db.aiSessions.get("sess_1")).toBeUndefined();
  });
});
