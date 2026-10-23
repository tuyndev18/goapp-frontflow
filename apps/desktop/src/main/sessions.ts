import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { newId, nowIso, PRICING_VERSION } from "@frontflow/domain";
import { createAgentEvent, redact, type AgentEvent } from "@frontflow/event-schema";
import type { ManagedSession, OpenTerminalInput, RunnerClient } from "@frontflow/cli-adapters";
import { preflight, type WorktreeManager } from "@frontflow/git-adapter";
import type { AiSessionRecord, FrontflowDb, UsageSummary } from "@frontflow/persistence";
import type { StandaloneSessionInfo } from "@frontflow/workflow-nodes";
import type { EventDto, IpcResponses, SessionDto, SessionEvidenceDto, SessionStateDto, UsageDto } from "../shared/ipc.js";
import { AppError, type IpcHandlers, type PushBus } from "./ipc-gateway.js";

/** Working with no event for this long reads as stalled. */
const STALL_MS = 5 * 60_000;
/** A terminal session counts as working while its TUI printed within this window. */
const PTY_ACTIVE_MS = 4000;
const TERMINAL_TOUCH_MS = 5000;

export interface SessionHubDeps {
  db: FrontflowDb;
  bus: PushBus;
  runner(): RunnerClient;
  openTerminal(input: OpenTerminalInput): Promise<{ command: string }>;
  closeTerminal(terminalId: string): Promise<void>;
  isTerminalOpen(terminalId: string): boolean;
  worktrees(projectId: string, rootPath: string): WorktreeManager;
}

type SessionHandlers = Pick<
  IpcHandlers,
  | "sessions:list"
  | "sessions:usage"
  | "sessions:create"
  | "sessions:events"
  | "sessions:send"
  | "sessions:close"
  | "sessions:resume"
  | "sessions:openTerminal"
  | "sessions:rename"
  | "sessions:delete"
>;

/**
 * The Sessions screen's control plane, in the main process (the single writer of session
 * records): starts chat and terminal sessions outside workflow runs, keeps their events,
 * resolves each session's state from its strongest evidence, and summarizes usage.
 * CLI processes live in the runner utility process; this module only tracks them.
 */
export function createSessionHub(deps: SessionHubDeps) {
  const { db, bus } = deps;
  /** Synthetic run id of a standalone chat session (or of one of its resumes) → its project. */
  const standaloneRuns = new Map<string, StandaloneSessionInfo>();
  /** Workflow-run sessions the user resumed by hand, identified by the CLI conversation they resume. */
  const manualResumes = new Set<string>();
  /** Their events are not stored by the engine, so they are stored here. */
  const manualSessions = new Set<string>();
  const contexts = new Map<string, { traceId: string; workflowRunId: string }>();
  const sessionTerminals = new Map<string, { terminalId: string; command: string }>();
  const terminalSessions = new Map<string, string>();
  const terminalOutputAt = new Map<string, number>();
  const terminalTouchedAt = new Map<string, number>();

  const changed = (projectId: string) => bus.send("sessions:changed", { projectId });

  function requireSession(sessionId: string): AiSessionRecord {
    const record = db.aiSessions.get(sessionId);
    if (!record) throw new AppError("NOT_FOUND", `Unknown session ${sessionId}`);
    return record;
  }

  function requireProject(projectId: string) {
    const project = db.projects.get(projectId);
    if (!project) throw new AppError("NOT_FOUND", `Unknown project ${projectId}`);
    return project;
  }

  const rootOf = (r: AiSessionRecord): string => (typeof r.metadata?.["rootSessionId"] === "string" ? (r.metadata["rootSessionId"] as string) : r.id);
  const isTerminalKind = (r: AiSessionRecord) => r.metadata?.["kind"] === "terminal";
  const openTerminalOf = (sessionId: string) => {
    const t = sessionTerminals.get(sessionId);
    return t && deps.isTerminalOpen(t.terminalId) ? t : undefined;
  };

  async function liveSessionIds(): Promise<Set<string>> {
    try {
      const sessions = await deps.runner().list();
      return new Set(sessions.filter((s) => s.status === "starting" || s.status === "running").map((s) => s.id));
    } catch {
      return new Set();
    }
  }

  /** Saves a placeholder for a session the runner just started, unless its first event already did. */
  function ensureRecord(session: ManagedSession, base: Pick<AiSessionRecord, "projectId"> & Partial<AiSessionRecord>): void {
    const existing = db.aiSessions.get(session.id);
    if (existing) {
      db.aiSessions.patch(session.id, { ...(base.title ? { title: base.title } : {}), ...(base.metadata ? { metadata: base.metadata } : {}) });
      return;
    }
    db.aiSessions.save({
      id: session.id,
      adapterId: session.adapterId,
      ...(session.externalSessionId ? { externalSessionId: session.externalSessionId } : {}),
      mode: "structured",
      status: "starting",
      cwd: session.cwd,
      lastActivityAt: nowIso(),
      startedAt: session.startedAt,
      ...base,
    });
  }

  /** The user's own message, stored like the agent's events so the conversation reads in order after a restart. */
  function recordUserMessage(sessionId: string, text: string, at?: string): void {
    const record = db.aiSessions.get(sessionId);
    const ctx = contexts.get(sessionId);
    const workflowRunId = record?.workflowRunId ?? ctx?.workflowRunId ?? "";
    const event = redact({
      ...createAgentEvent(
        "message.delta",
        { traceId: ctx?.traceId ?? newId("trace"), workflowRunId, sessionId, ...(record?.nodeRunId ? { nodeRunId: record.nodeRunId } : {}) },
        { role: "user", text },
      ),
      ...(at ? { timestamp: at } : {}),
    });
    const inRun = !!record?.workflowRunId && !!db.runStore.getRun(record.workflowRunId);
    db.runStore.appendEvent(event, { runless: !inRun });
    if (inRun) bus.send("run:event", toEventDto(event));
    bus.send("session:event", toEventDto(event));
  }

  function resolveState(r: AiSessionRecord, live: boolean, runActive: boolean): { state: SessionStateDto; evidence: SessionEvidenceDto; detail?: string } {
    const endReason = typeof r.metadata?.["endReason"] === "string" ? (r.metadata["endReason"] as string) : undefined;
    if (r.status === "completed" || r.status === "cancelled") {
      return { state: "ended", evidence: { source: "record", confidence: "high" }, ...(endReason ? { detail: endReason } : r.status === "cancelled" ? { detail: "Cancelled" } : {}) };
    }
    if (r.status === "failed") return { state: "error", evidence: { source: "record", confidence: "high" }, ...(endReason ? { detail: endReason } : {}) };
    if (isTerminalKind(r)) {
      if (!live) return { state: "unknown", evidence: { source: "record", confidence: "low" }, detail: "Its terminal is not open" };
      // Only output timing is known about a TUI: low confidence by design.
      const quietMs = Date.now() - (terminalOutputAt.get(r.id) ?? 0);
      return quietMs < PTY_ACTIVE_MS
        ? { state: "working", evidence: { source: "process", confidence: "low" }, detail: "Terminal output in the last seconds" }
        : { state: "waiting_user", evidence: { source: "process", confidence: "low" }, detail: "Terminal quiet — probably waiting for you" };
    }
    if (!live && !runActive) return { state: "unknown", evidence: { source: "record", confidence: "low" }, detail: "No CLI process holds this session" };
    const evidence: SessionEvidenceDto = live ? { source: "structured_log", confidence: "high" } : { source: "record", confidence: "medium" };
    switch (r.status) {
      case "starting":
        return { state: "starting", evidence };
      case "waiting_approval":
        return { state: "waiting_user", evidence, detail: "Waiting for an approval" };
      case "idle":
        return { state: "waiting_user", evidence, detail: "Turn finished — waiting for your next message" };
      default: {
        const last = Date.parse(r.lastActivityAt ?? r.startedAt);
        if (Number.isFinite(last) && Date.now() - last > STALL_MS) return { state: "stalled", evidence, detail: "No activity for over 5 minutes" };
        return { state: "working", evidence, detail: r.status === "running_tool" ? "Running a tool" : "Thinking" };
      }
    }
  }

  function toDto(r: AiSessionRecord, live: Set<string>, activeRuns: Set<string>, usage?: UsageSummary): SessionDto {
    const terminal = openTerminalOf(r.id);
    const isLive = isTerminalKind(r) ? !!terminal : live.has(r.id);
    const { state, evidence, detail } = resolveState(r, isLive, !!r.workflowRunId && activeRuns.has(r.workflowRunId));
    const worktreePath = typeof r.metadata?.["worktreePath"] === "string" ? (r.metadata["worktreePath"] as string) : undefined;
    return {
      id: r.id,
      adapterId: r.adapterId,
      ...(r.externalSessionId ? { externalSessionId: r.externalSessionId } : {}),
      status: r.status === "completed" || r.status === "failed" || r.status === "cancelled" ? r.status : "running",
      cwd: r.cwd,
      startedAt: r.startedAt,
      ...(r.workflowRunId ? { workflowRunId: r.workflowRunId } : {}),
      ...(r.nodeRunId ? { nodeRunId: r.nodeRunId } : {}),
      ...(r.title ? { title: r.title } : {}),
      mode: isTerminalKind(r) ? "pty" : "structured",
      ...(r.model ? { model: r.model } : {}),
      state,
      evidence,
      ...(detail ? { stateDetail: detail } : {}),
      ...(r.lastActivityAt ? { lastActivityAt: r.lastActivityAt } : {}),
      ...(r.endedAt ? { endedAt: r.endedAt } : {}),
      live: isLive,
      ...(terminal ? { terminalId: terminal.terminalId } : {}),
      rootSessionId: rootOf(r),
      ...(worktreePath ? { worktreePath } : {}),
      ...(usage ? { usage: toUsageDto(usage) } : {}),
    };
  }

  async function dtoOf(sessionId: string): Promise<SessionDto> {
    const record = requireSession(sessionId);
    const usage = db.usage.bySession(record.projectId).get(sessionId);
    return toDto(record, await liveSessionIds(), activeRunIds(), usage);
  }

  const activeRunIds = () => new Set(db.runStore.listActiveRuns().map((r) => r.id));

  function bindTerminal(sessionId: string, terminalId: string, command: string): void {
    sessionTerminals.set(sessionId, { terminalId, command });
    terminalSessions.set(terminalId, sessionId);
    terminalOutputAt.set(sessionId, Date.now());
  }

  /** Starts the CLI's TUI for a new terminal-kind session record. */
  async function startTerminal(input: {
    projectId: string;
    adapterId: string;
    cwd: string;
    cols: number;
    rows: number;
    title: string;
    metadata: Record<string, unknown>;
    resumeId?: string;
    model?: string;
    permissionMode?: string;
  }): Promise<IpcResponses["sessions:openTerminal"]> {
    const sessionId = newId("sess");
    const terminalId = newId("term");
    // Claude lets the caller name a fresh conversation, so it can be resumed later.
    const newSessionId = !input.resumeId && input.adapterId === "claude-code" ? randomUUID() : undefined;
    const externalSessionId = input.resumeId ?? newSessionId;
    const now = nowIso();
    db.aiSessions.save({
      id: sessionId,
      projectId: input.projectId,
      adapterId: input.adapterId,
      ...(externalSessionId ? { externalSessionId } : {}),
      mode: "pty",
      status: "idle",
      cwd: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      title: input.title,
      metadata: { ...input.metadata, kind: "terminal" },
      lastActivityAt: now,
      startedAt: now,
    });
    const claudeArgs =
      input.adapterId === "claude-code" && (input.model || input.permissionMode)
        ? [
            ...(input.resumeId ? ["--resume", input.resumeId] : newSessionId ? ["--session-id", newSessionId] : []),
            ...(input.model ? ["--model", input.model] : []),
            ...(input.permissionMode ? ["--permission-mode", input.permissionMode] : []),
          ]
        : undefined;
    try {
      const opened = await deps.openTerminal({
        terminalId,
        adapterId: input.adapterId,
        ...(input.resumeId ? { externalSessionId: input.resumeId } : {}),
        ...(newSessionId ? { newSessionId } : {}),
        ...(claudeArgs ? { args: claudeArgs } : {}),
        cwd: input.cwd,
        cols: input.cols,
        rows: input.rows,
      });
      bindTerminal(sessionId, terminalId, opened.command);
      changed(input.projectId);
      return { terminalId, command: opened.command, sessionId };
    } catch (err) {
      db.aiSessions.delete(sessionId);
      throw err;
    }
  }

  /** Marks sessions no process holds any more (app restart, runner crash) as interrupted. */
  function interruptOpenSessions(reason: string): void {
    const projects = new Set<string>();
    for (const r of db.aiSessions.listOpen()) {
      if (openTerminalOf(r.id)) continue;
      db.aiSessions.updateStatus(r.id, "failed", { endedAt: nowIso() });
      db.aiSessions.patch(r.id, { metadata: { endReason: reason } });
      projects.add(r.projectId);
    }
    for (const p of projects) changed(p);
  }

  const handlers: SessionHandlers = {
    "sessions:list": async ({ projectId }) => {
      const usage = db.usage.bySession(projectId);
      const live = await liveSessionIds();
      const activeRuns = activeRunIds();
      return db.aiSessions.listByProject(projectId, 300).map((r) => toDto(r, live, activeRuns, usage.get(r.id)));
    },
    "sessions:usage": ({ projectId }) => toUsageDto(db.usage.forProject(projectId).total),
    "sessions:events": ({ sessionIds, limit }) => db.runStore.listSessionEvents(sessionIds, limit).map(toEventDto),

    "sessions:create": async (req) => {
      const project = requireProject(req.projectId);
      const sessionKey = newId("sess");
      let cwd = project.rootPath;
      let worktree: { path: string; branch: string } | undefined;
      if (req.workspace === "worktree") {
        const pre = await preflight(project.rootPath);
        if (!pre.isRepo || !pre.baseSha) throw new AppError("NO_GIT", "A session worktree needs a git repository with at least one commit");
        const info = await deps.worktrees(project.id, project.rootPath).create({ runId: sessionKey, branchPrefix: "frontflow/session-" });
        worktree = { path: info.path, branch: info.branch };
        cwd = info.path;
      }
      if (!existsSync(cwd)) throw new AppError("NOT_FOUND", `Working directory ${cwd} does not exist`);
      const prompt = req.prompt?.trim();
      const title = req.title?.trim() || (prompt ? shortTitle(prompt) : req.mode === "terminal" ? "Terminal session" : "Chat session");
      const metadata: Record<string, unknown> = {
        origin: "sessions",
        ...(worktree ? { worktreePath: worktree.path, branch: worktree.branch } : {}),
        ...(req.permissionMode !== "acceptEdits" ? { permissionMode: req.permissionMode } : {}),
      };
      try {
        if (req.mode === "terminal") {
          const opened = await startTerminal({
            projectId: project.id,
            adapterId: req.adapterId,
            cwd,
            cols: req.cols,
            rows: req.rows,
            title,
            metadata,
            ...(req.model ? { model: req.model } : {}),
            ...(req.permissionMode !== "acceptEdits" ? { permissionMode: req.permissionMode } : {}),
          });
          return dtoOf(opened.sessionId);
        }
        const runId = newId("adhoc");
        const traceId = newId("trace");
        const chatMetadata = { ...metadata, kind: "chat" };
        standaloneRuns.set(runId, { projectId: project.id, title, metadata: chatMetadata });
        const askedAt = nowIso();
        const session = await deps.runner().start(req.adapterId, {
          cwd,
          prompt: prompt!,
          traceId,
          workflowRunId: runId,
          ...(req.model ? { model: req.model } : {}),
          permissionMode: req.permissionMode,
          keepAlive: true,
        });
        contexts.set(session.id, { traceId, workflowRunId: runId });
        ensureRecord(session, { projectId: project.id, title, metadata: chatMetadata, ...(req.model ? { model: req.model } : {}) });
        recordUserMessage(session.id, prompt!, askedAt);
        changed(project.id);
        return dtoOf(session.id);
      } catch (err) {
        // The worktree was created a moment ago for this session only and holds no work yet.
        if (worktree) await deps.worktrees(project.id, project.rootPath).remove(worktree.path, { force: true, deleteBranch: true }).catch(() => undefined);
        throw err;
      }
    },

    "sessions:send": async ({ sessionId, message }) => {
      await deps.runner().send(sessionId, message);
      recordUserMessage(sessionId, message);
    },

    "sessions:close": async ({ sessionId }) => {
      const record = requireSession(sessionId);
      const terminal = openTerminalOf(sessionId);
      if (terminal) await deps.closeTerminal(terminal.terminalId);
      else if ((await liveSessionIds()).has(sessionId)) await deps.runner().close(sessionId);
      changed(record.projectId);
    },

    "sessions:resume": async ({ sessionId, prompt }) => {
      const record = requireSession(sessionId);
      if (!record.externalSessionId) throw new AppError("NOT_RESUMABLE", "Session has no resumable CLI session id");
      if (!existsSync(record.cwd)) throw new AppError("NOT_FOUND", `Working directory ${record.cwd} no longer exists`);
      const run = record.workflowRunId ? db.runStore.getRun(record.workflowRunId) : undefined;
      const runId = run?.id ?? newId("adhoc");
      const traceId = run?.traceId ?? newId("trace");
      const lineage = { ...record.metadata, kind: "chat", rootSessionId: rootOf(record), resumedFrom: record.id };
      delete (lineage as Record<string, unknown>)["endReason"];
      if (run) manualResumes.add(record.externalSessionId);
      else standaloneRuns.set(runId, { projectId: record.projectId, ...(record.title ? { title: record.title } : {}), metadata: lineage });
      const askedAt = nowIso();
      const session = await deps.runner().resume(record.adapterId, {
        externalSessionId: record.externalSessionId,
        cwd: record.cwd,
        traceId,
        workflowRunId: runId,
        ...(record.nodeRunId ? { nodeRunId: record.nodeRunId } : {}),
        ...(record.model ? { model: record.model } : {}),
        ...(prompt ? { prompt } : {}),
        permissionMode: typeof record.metadata?.["permissionMode"] === "string" ? (record.metadata["permissionMode"] as string) : "acceptEdits",
        keepAlive: true,
      });
      if (run) manualSessions.add(session.id);
      contexts.set(session.id, { traceId, workflowRunId: runId });
      ensureRecord(session, {
        projectId: record.projectId,
        ...(run ? { workflowRunId: run.id } : {}),
        ...(record.nodeRunId ? { nodeRunId: record.nodeRunId } : {}),
        ...(record.title ? { title: record.title } : {}),
        ...(record.model ? { model: record.model } : {}),
        metadata: lineage,
      });
      if (prompt) recordUserMessage(session.id, prompt, askedAt);
      changed(record.projectId);
      return dtoOf(session.id);
    },

    "sessions:openTerminal": async ({ sessionId, cols, rows }) => {
      const record = requireSession(sessionId);
      const open = openTerminalOf(sessionId);
      if (open) return { ...open, sessionId };
      // Another conversation member may already have the TUI open.
      for (const [sid] of sessionTerminals) {
        const other = db.aiSessions.get(sid);
        const t = openTerminalOf(sid);
        if (t && other && rootOf(other) === rootOf(record)) return { ...t, sessionId: sid };
      }
      if ((await liveSessionIds()).has(sessionId)) {
        throw new AppError("SESSION_RUNNING", "End the chat session before taking it over in a terminal: two CLI processes must not write the same conversation");
      }
      if (!record.externalSessionId) throw new AppError("NOT_RESUMABLE", "This session has no CLI conversation id to resume in a terminal");
      if (!existsSync(record.cwd)) throw new AppError("NOT_FOUND", `Working directory ${record.cwd} no longer exists`);
      const metadata = { ...record.metadata, rootSessionId: rootOf(record), resumedFrom: record.id };
      delete (metadata as Record<string, unknown>)["endReason"];
      return startTerminal({
        projectId: record.projectId,
        adapterId: record.adapterId,
        cwd: record.cwd,
        cols,
        rows,
        title: record.title ?? "Terminal session",
        metadata,
        resumeId: record.externalSessionId,
      });
    },

    "sessions:rename": ({ sessionId, title }) => {
      const record = requireSession(sessionId);
      const root = rootOf(record);
      for (const r of db.aiSessions.listByProject(record.projectId)) if (rootOf(r) === root) db.aiSessions.patch(r.id, { title });
      changed(record.projectId);
    },

    "sessions:delete": async ({ sessionId, removeWorktree, force }) => {
      const record = requireSession(sessionId);
      const root = rootOf(record);
      const members = db.aiSessions.listByProject(record.projectId).filter((r) => rootOf(r) === root);
      if (members.some((r) => r.workflowRunId)) throw new AppError("NOT_STANDALONE", "Sessions of a workflow run are deleted with their run");
      const live = await liveSessionIds();
      if (members.some((r) => live.has(r.id) || openTerminalOf(r.id))) throw new AppError("SESSION_RUNNING", "End the session before deleting it");
      const worktreePath = members.map((r) => r.metadata?.["worktreePath"]).find((p): p is string => typeof p === "string");
      let worktree: IpcResponses["sessions:delete"]["worktree"] = "none";
      if (worktreePath && existsSync(worktreePath)) {
        worktree = "kept";
        if (removeWorktree) {
          const pre = await preflight(worktreePath);
          const changes = [...(pre.dirtyFiles ?? []), ...(pre.untrackedFiles ?? [])];
          if (pre.clean === false && !force) {
            throw new AppError(
              "WORKTREE_DIRTY",
              `The session worktree has ${changes.length} uncommitted change(s): ${changes.slice(0, 5).join(", ")}${changes.length > 5 ? "…" : ""}`,
            );
          }
          const project = requireProject(record.projectId);
          // The branch stays: commits made in the session are never deleted here.
          await deps.worktrees(project.id, project.rootPath).remove(worktreePath, { force: true });
          worktree = "removed";
        }
      }
      for (const r of members) db.aiSessions.delete(r.id);
      changed(record.projectId);
      return { deleted: members.length, worktree };
    },
  };

  return {
    handlers,
    standalone: (workflowRunId: string) => standaloneRuns.get(workflowRunId),
    /** Every agent event from the runner, after the session recorder saw it. */
    onAgentEvent(event: AgentEvent): void {
      if (event.type === "session.started" && event.sessionId && event.payload.externalSessionId && manualResumes.delete(event.payload.externalSessionId)) {
        manualSessions.add(event.sessionId);
      }
      if (standaloneRuns.has(event.workflowRunId)) {
        db.runStore.appendEvent(redact(event), { runless: true });
      } else if (event.sessionId && manualSessions.has(event.sessionId)) {
        const safe = redact(event);
        db.runStore.appendEvent(safe);
        bus.send("run:event", toEventDto(safe));
      }
    },
    onTerminalData(terminalId: string): void {
      const sessionId = terminalSessions.get(terminalId);
      if (!sessionId) return;
      const now = Date.now();
      terminalOutputAt.set(sessionId, now);
      if (now - (terminalTouchedAt.get(sessionId) ?? 0) >= TERMINAL_TOUCH_MS) {
        terminalTouchedAt.set(sessionId, now);
        db.aiSessions.touch(sessionId, new Date(now).toISOString());
      }
    },
    onTerminalExit(terminalId: string, exitCode: number | null): void {
      const sessionId = terminalSessions.get(terminalId);
      if (!sessionId) return;
      terminalSessions.delete(terminalId);
      sessionTerminals.delete(sessionId);
      terminalOutputAt.delete(sessionId);
      const record = db.aiSessions.get(sessionId);
      if (!record) return;
      const at = nowIso();
      db.aiSessions.updateStatus(sessionId, "completed", { endedAt: at });
      db.aiSessions.touch(sessionId, at);
      db.aiSessions.patch(sessionId, { metadata: { exitCode, endReason: `Terminal exited${exitCode !== null ? ` with code ${exitCode}` : ""}` } });
      changed(record.projectId);
    },
    interruptOpenSessions,
  };
}

export type SessionHub = ReturnType<typeof createSessionHub>;

function toUsageDto(u: UsageSummary): UsageDto {
  return { ...u, pricingVersion: PRICING_VERSION };
}

function shortTitle(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

export function toEventDto(event: { id: string; type: string; timestamp: string; workflowRunId: string; nodeRunId?: string; sessionId?: string; confidence?: number; payload: unknown }): EventDto {
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    workflowRunId: event.workflowRunId,
    ...(event.nodeRunId ? { nodeRunId: event.nodeRunId } : {}),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.confidence !== undefined ? { confidence: event.confidence } : {}),
    payload: event.payload,
  };
}
