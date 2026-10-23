import { estimateCost } from "@frontflow/domain";
import type { AgentEvent, AgentEventOf } from "@frontflow/event-schema";
import type { ArtifactStore, FrontflowDb } from "@frontflow/persistence";
import type { NodeServices } from "./services.js";

export type PersistentServicesInput = Omit<
  NodeServices,
  "getProject" | "saveProfile" | "readSnapshot" | "artifacts" | "recordTestResult" | "saveCheckpoint"
> & {
  db: FrontflowDb;
  artifactStore: ArtifactStore;
};

/** NodeServices backed by the SQLite database and artifact store (desktop app and integration tests). */
export function createPersistentServices(input: PersistentServicesInput): NodeServices {
  const { db, artifactStore, ...rest } = input;
  return {
    ...rest,
    getProject(projectId) {
      const project = db.projects.get(projectId);
      if (!project) throw new Error(`Unknown project ${projectId}`);
      const profile = db.profiles.getLatest(projectId);
      return { rootPath: project.rootPath, ...(profile ? { profile } : {}) };
    },
    saveProfile(_projectId, profile) {
      db.profiles.save(profile);
    },
    readSnapshot(_projectId, snapshotId) {
      const snapshot = db.snapshots.get(snapshotId);
      if (!snapshot) throw new Error(`Unknown snapshot ${snapshotId}`);
      return { snapshot, text: artifactStore.readSnapshotContent(snapshotId) };
    },
    artifacts: {
      write: (artifact) => artifactStore.write(artifact),
    },
    recordTestResult: (result) => db.testResults.save(result),
    saveCheckpoint: (checkpoint) => db.gitCheckpoints.save(checkpoint),
  };
}

export interface SessionRecorderOptions {
  /** Minimum gap between two activity timestamp writes for one session. Default 2000 ms. */
  activityWriteMs?: number;
}

/** Bump when the usage mapping below changes, so old rows can be told apart. */
export const USAGE_PARSER_VERSION = 1;

/**
 * Persists AI CLI sessions from their normalized events so they can be listed
 * and resumed after an app restart (spec §20.1 Sessions, DoD #9), with their
 * latest status, last activity and token usage.
 */
export function createSessionRecorder(db: FrontflowDb, artifactStore: ArtifactStore, options: SessionRecorderOptions = {}) {
  const projectOfRun = (runId: string): string | undefined => db.runStore.getRun(runId)?.projectId;
  const rawPaths = new Map<string, string>();
  const lastTouch = new Map<string, number>();
  const activityWriteMs = options.activityWriteMs ?? 2000;

  const touch = (sessionId: string, at: string, force = false) => {
    const now = Date.parse(at) || Date.now();
    if (!force && now - (lastTouch.get(sessionId) ?? 0) < activityWriteMs) return;
    lastTouch.set(sessionId, now);
    db.aiSessions.touch(sessionId, at);
  };

  const recordUsage = (projectId: string, event: AgentEventOf<"usage.updated">) => {
    const session = db.aiSessions.get(event.sessionId!);
    if (!session) return;
    const p = event.payload;
    const scope = p.scope ?? "total";
    const model = p.model ?? session.model;
    const tokens = {
      inputTokens: p.inputTokens ?? 0,
      outputTokens: p.outputTokens ?? 0,
      cacheReadTokens: p.cacheReadTokens ?? 0,
      cacheWriteTokens: p.cacheWriteTokens ?? 0,
    };
    const estimate = estimateCost(model, tokens);
    db.usage.record({
      eventId: scope === "message" && p.messageId ? `${event.sessionId}:${p.messageId}` : event.id,
      projectId,
      sessionId: event.sessionId!,
      provider: session.adapterId,
      ...(model ? { model } : {}),
      scope,
      occurredAt: event.timestamp,
      ...tokens,
      ...(p.costUsd !== undefined ? { sourceCostUsd: p.costUsd } : {}),
      ...(estimate.ok ? { estimatedCostUsd: estimate.usd, pricingVersion: estimate.pricingVersion } : {}),
      rawSource: `${session.adapterId}:${event.confidence !== undefined ? "pty" : "structured"}`,
      parserVersion: USAGE_PARSER_VERSION,
    });
  };

  return {
    onEvent(event: AgentEvent): void {
      if (!event.sessionId) return;
      const projectId = projectOfRun(event.workflowRunId);
      if (!projectId) return;
      if (event.type === "session.started") {
        const existing = db.aiSessions.get(event.sessionId);
        db.aiSessions.save({
          id: event.sessionId,
          projectId,
          workflowRunId: event.workflowRunId,
          ...(event.nodeRunId ? { nodeRunId: event.nodeRunId } : {}),
          adapterId: event.payload.adapterId,
          ...(event.payload.externalSessionId ? { externalSessionId: event.payload.externalSessionId } : {}),
          mode: event.confidence !== undefined ? "pty" : "structured",
          status: "thinking",
          cwd: event.payload.cwd,
          ...(event.payload.model ? { model: event.payload.model } : {}),
          ...(rawPaths.get(event.sessionId) ? { rawLogPath: rawPaths.get(event.sessionId)! } : {}),
          ...(existing?.metadata ? { metadata: existing.metadata } : {}),
          lastActivityAt: event.timestamp,
          startedAt: existing?.startedAt ?? event.timestamp,
        });
        lastTouch.set(event.sessionId, Date.parse(event.timestamp) || Date.now());
        return;
      }
      if (event.type === "status.changed") {
        db.aiSessions.updateStatus(event.sessionId, event.payload.status);
      } else if (event.type === "usage.updated") {
        recordUsage(projectId, event);
      } else if (event.type === "session.completed") {
        db.aiSessions.updateStatus(event.sessionId, "completed", {
          ...(event.payload.externalSessionId ? { externalSessionId: event.payload.externalSessionId } : {}),
          endedAt: event.timestamp,
        });
      } else if (event.type === "session.failed") {
        db.aiSessions.updateStatus(event.sessionId, event.payload.code === "CANCELLED" ? "cancelled" : "failed", { endedAt: event.timestamp });
      }
      touch(event.sessionId, event.timestamp, event.type === "session.completed" || event.type === "session.failed");
    },
    onRaw(sessionId: string, chunk: string, runId?: string): void {
      const projectId = runId ? projectOfRun(runId) : db.aiSessions.get(sessionId)?.projectId;
      if (!projectId) return;
      const path = artifactStore.appendLog({ projectId, sessionId, stream: "pty", chunk });
      if (path) rawPaths.set(sessionId, path);
    },
    rawLogPath(sessionId: string): string | undefined {
      return rawPaths.get(sessionId) ?? db.aiSessions.get(sessionId)?.rawLogPath;
    },
  };
}
