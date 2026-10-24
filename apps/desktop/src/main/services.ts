import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { app, dialog, shell, utilityProcess, type UtilityProcess } from "electron";
import {
  newId,
  nowIso,
  sha256,
  TERMINAL_RUN_STATUSES,
  type Project,
  type ProjectProfile,
  type WorkflowRun,
} from "@frontflow/domain";
import { redact, type AnyEvent } from "@frontflow/event-schema";
import { RunnerClient, type RunnerPort } from "@frontflow/cli-adapters";
import { DocumentError, snapshotDocument } from "@frontflow/document-parser";
import { GoFigmaListener, findGoFigmaServer, type FigmaHandoff } from "@frontflow/figma-mcp-bridge";
import { deleteSnapshots, preflight } from "@frontflow/git-adapter";
import { ArtifactStore, openDatabase } from "@frontflow/persistence";
import { ApprovalBroker, PolicyEngine } from "@frontflow/policy";
import { analyzeProject, applyOverrides, slugify, type ProfileOverrides } from "@frontflow/project-analyzer";
import { BUILTIN_WORKFLOW_FILES, loadBuiltinWorkflows, toGraph, WorkflowEngine, type WorkflowDefinition } from "@frontflow/workflow-engine";
import {
  createBuiltinHandlers,
  createPersistentServices,
  createSessionRecorder,
  SkillLibrary,
  PromptLibrary,
  promptPlaceholders,
  type FeatureRunInputs,
  type GoFigmaService,
  type ImportedApiContract,
  type ImportedBaSpec,
  type ImportedBatch,
  type ImportedOpsGuide,
} from "@frontflow/workflow-nodes";
import type {
  ApprovalDto,
  CliStatus,
  EventDto,
  FigmaStatusDto,
  ProjectSummary,
  RunStateDto,
  SessionDto,
  SkillNodeDto,
} from "../shared/ipc.js";
import { createAccountsService } from "./accounts.js";
import { AppError, type IpcHandlers, type PushBus } from "./ipc-gateway.js";
import { SettingsStore } from "./settings.js";

const TERMINAL_BUFFER = 256_000;
const TERMINAL_BUFFERS_KEPT = 24;

const CLI_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  fake: "Fake CLI (testing)",
};

export interface Services {
  handlers: IpcHandlers;
  recover(): Promise<void>;
  dispose(): Promise<void>;
}

export async function createServices(options: { dataDir: string; bus: PushBus; runnerEntry: string }): Promise<Services> {
  const { dataDir, bus } = options;
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, "database.sqlite"));
  const settingsStore = new SettingsStore(dataDir);
  // Logging/retention settings apply from the next app start.
  const artifactStore = new ArtifactStore({
    rootDir: dataDir,
    db,
    rawLogs: settingsStore.get().rawTerminalLogs,
    rawLogRetentionDays: settingsStore.get().retentionDays,
  });
  const recorder = createSessionRecorder(db, artifactStore);

  // --- AI CLI runner in a utility process (spec §9.3) ---
  const manualResumes = new Set<string>();
  const manualSessions = new Set<string>();
  // Recent PTY output per terminal, so a pane attaching late (or after the step ended) still shows the screen.
  const terminalBuffers = new Map<string, string>();
  const openTerminals = new Set<string>();
  const terminalExitHandlers = new Set<(terminalId: string, exitCode: number | null) => void>();
  const terminalExited = (terminalId: string, exitCode: number | null) => {
    openTerminals.delete(terminalId);
    bus.send("terminal:exit", { terminalId, exitCode });
    for (const handler of terminalExitHandlers) handler(terminalId, exitCode);
  };
  let runnerProcess: UtilityProcess | undefined;
  let runner: RunnerClient | undefined;
  const startRunner = () => {
    runnerProcess = utilityProcess.fork(options.runnerEntry, [], { serviceName: "FrontFlow CLI runner", stdio: "pipe" });
    runner = new RunnerClient(runnerProcess as unknown as RunnerPort, { requestTimeoutMs: 60_000 });
    runner.subscribe((event) => {
      recorder.onEvent(event);
      bus.send("session:event", toEventDto(event));
      // Follow-up chats started by the user are not driven by the engine: store and show them here.
      if (event.type === "session.started" && event.payload.externalSessionId && manualResumes.has(event.payload.externalSessionId) && event.sessionId) {
        manualSessions.add(event.sessionId);
        manualResumes.delete(event.payload.externalSessionId);
      }
      if (event.sessionId && manualSessions.has(event.sessionId)) {
        const safe = redact(event);
        db.runStore.appendEvent(safe);
        bus.send("run:event", toEventDto(safe));
      }
    });
    runner.onTerminal((msg) => {
      if (msg.type === "terminal.data") {
        const buffered = (terminalBuffers.get(msg.terminalId) ?? "") + msg.data;
        if (!terminalBuffers.has(msg.terminalId) && terminalBuffers.size >= TERMINAL_BUFFERS_KEPT) {
          terminalBuffers.delete(terminalBuffers.keys().next().value!);
        }
        terminalBuffers.set(msg.terminalId, buffered.length > TERMINAL_BUFFER ? buffered.slice(-TERMINAL_BUFFER) : buffered);
        bus.send("terminal:data", { terminalId: msg.terminalId, data: msg.data });
      } else terminalExited(msg.terminalId, msg.exitCode);
    });
    runner.onRaw((sessionId, chunk) => {
      recorder.onRaw(sessionId, chunk);
      bus.send("session:raw", { sessionId, chunk });
    });
    runnerProcess.once("exit", (code) => {
      console.error(`[runner] exited with code ${code}; restarting`);
      runner?.dispose("Runner process exited");
      // Its PTYs died with it; interactive steps waiting on them fail like headless sessions do.
      for (const terminalId of [...openTerminals]) terminalExited(terminalId, null);
      // Crash recovery: sessions fail with PROCESS_EXITED and nodes retry within their budget.
      if (!disposed) startRunner();
    });
  };
  startRunner();
  const requireRunner = () => {
    if (!runner) throw new AppError("RUNNER_UNAVAILABLE", "AI CLI runner is not running");
    return runner;
  };

  // --- Policy & approvals (spec §22) ---
  const approvals = new ApprovalBroker();
  const policy = new PolicyEngine({ networkAllowlist: ["figma-bridge", "ai-cli"] });
  approvals.subscribe((event) => {
    const r = event.request;
    if (event.type === "requested") {
      db.approvals.save({ requestId: r.id, permission: r.permission, action: r.action, ...(r.detail ? { detail: r.detail } : {}), status: "pending", requestedAt: r.createdAt });
      bus.send("approval:requested", toApprovalDto(r));
    } else {
      db.approvals.decide(r.id, event.outcome, { decidedBy: "user" });
    }
  });

  // --- Claude Code accounts of this machine (Accounts screen) ---
  const accounts = createAccountsService({
    dataDir,
    bus,
    openTerminal: async (input) => {
      openTerminals.add(input.terminalId);
      try {
        return await requireRunner().openTerminal(input);
      } catch (err) {
        openTerminals.delete(input.terminalId);
        throw err;
      }
    },
    closeTerminal: (terminalId) => (openTerminals.has(terminalId) ? requireRunner().closeTerminal(terminalId) : Promise.resolve()),
    onTerminalExit: (handler) => {
      terminalExitHandlers.add(handler);
      return () => terminalExitHandlers.delete(handler);
    },
  });

  // --- GoApp Figma (spec §11.3, §13) ---
  // The plugin's FrontFlow button pushes the selected frames through the go-figma MCP hub; FrontFlow
  // listens, shows the latest push in the waiting Figma step, and the AI CLI gets the same MCP server.
  let figmaHandoff: FigmaHandoff | undefined;
  function figmaServer(): Pick<FigmaStatusDto, "serverPath" | "source" | "error"> {
    const configured = settingsStore.get().goFigmaServerPath.trim();
    if (configured) {
      return existsSync(configured) ? { serverPath: configured, source: "settings" } : { serverPath: configured, source: "settings", error: `File not found: ${configured}` };
    }
    const detected = findGoFigmaServer();
    return detected ? { serverPath: detected, source: "detected" } : { source: "none" };
  }
  const goFigma: GoFigmaService = {
    serverPath: () => {
      const server = figmaServer();
      return server.error ? undefined : server.serverPath;
    },
  };
  const figmaListener = new GoFigmaListener({
    serverPath: () => goFigma.serverPath(),
    onHandoff: (handoff) => {
      figmaHandoff = handoff;
      console.info(`[figma] received ${handoff.id}: ${handoff.nodes.length} layer(s) of "${handoff.fileName}"`);
      bus.send("figma:status", figmaStatus());
    },
    onStatus: () => bus.send("figma:status", figmaStatus()),
    ...(process.env["FRONTFLOW_GO_FIGMA_PORT"] ? { port: Number(process.env["FRONTFLOW_GO_FIGMA_PORT"]) } : {}),
  });
  figmaListener.start();
  function figmaStatus(): FigmaStatusDto {
    return { ...figmaServer(), listening: figmaListener.listening, ...(figmaHandoff ? { handoff: figmaHandoff } : {}) };
  }

  // --- Skills: SKILL.md folders attached to workflow steps (Skills screen) ---
  const skillsDir = join(dataDir, "skills");
  const firstLaunch = !existsSync(skillsDir);
  const skills = new SkillLibrary(skillsDir);
  if (firstLaunch) seedSkills();

  // --- Prompts: every AI step is an editable prompt (shipped defaults + the user's edits) ---
  const workflowsDir = findWorkflowsDir();
  const prompts = new PromptLibrary({ defaultsDir: join(workflowsDir, "prompts"), userDir: join(dataDir, "prompts") });
  const promptDto = (name: string) => {
    const t = prompts.get(name);
    return { ...t, placeholders: promptPlaceholders(t.defaultText || t.text) };
  };

  // --- Workflow engine (spec §17) ---
  const nodeServices = createPersistentServices({
    db,
    artifactStore,
    agents: {
      start: (adapterId, input) => requireRunner().start(adapterId, input),
      resume: (adapterId, input) => requireRunner().resume(adapterId, input),
      cancel: (sessionId) => requireRunner().cancel(sessionId),
      subscribeAll: (handler) => {
        // Survives runner restarts: re-subscribe on whichever client is current.
        let current = runner;
        let off = current?.subscribe(handler);
        const timer = setInterval(() => {
          if (runner !== current) {
            off?.();
            current = runner;
            off = current?.subscribe(handler);
          }
        }, 1000);
        return () => {
          clearInterval(timer);
          off?.();
        };
      },
    },
    terminals: {
      open: async (input) => {
        openTerminals.add(input.terminalId);
        try {
          return await requireRunner().openTerminal(input);
        } catch (err) {
          openTerminals.delete(input.terminalId);
          throw err;
        }
      },
      close: (terminalId) => (openTerminals.has(terminalId) ? requireRunner().closeTerminal(terminalId) : Promise.resolve()),
      onExit: (handler) => {
        terminalExitHandlers.add(handler);
        return () => terminalExitHandlers.delete(handler);
      },
      claudeConfigDir: process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude"),
    },
    figma: goFigma,
    skills,
    prompts,
    policy,
    approvals,
    claudeProfileFor: (accountId) => accounts.claudeProfileFor(accountId),
    mcpConfigDir: join(dataDir, "mcp"),
    scratchDir: join(dataDir, "scratch"),
    // Removed with the run (deleteRun).
    runFilesDir,
    settings: () => {
      const s = settingsStore.get();
      return {
        allowArbitraryShell: s.allowArbitraryShell,
        commandTimeoutMs: 15 * 60_000,
        agentTimeoutMs: 30 * 60_000,
        fixBudget: 2,
      };
    },
    probeProvider: async (baseUrl, signal) => {
      try {
        const res = await fetch(baseUrl, { method: "HEAD", signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
        return res.status < 500;
      } catch {
        return false;
      }
    },
  });
  const definition = loadDefinition();
  const engine = new WorkflowEngine({
    store: db.runStore,
    handlers: createBuiltinHandlers(nodeServices),
    maxConcurrency: () => settingsStore.get().maxConcurrentNodes,
  });
  engine.registerDefinition(definition);
  try {
    db.workflowDefinitions.save({ id: definition.id, version: definition.version, name: definition.name, definition });
  } catch (err) {
    // Same id+version with different content: a workflow YAML changed without a version bump.
    console.warn("[engine]", err instanceof Error ? err.message : err);
  }

  const pendingStatePush = new Set<string>();
  engine.subscribe((event: AnyEvent) => {
    bus.send("run:event", toEventDto(event));
    // A throttled account fails every other AI node too: stop the run instead of letting it keep calling.
    if (event.type === "node.status_changed" && event.payload.status === "failed" && event.payload.error?.code === "RATE_LIMITED") {
      void engine
        .pause(event.workflowRunId, "AI usage limit reached — resume after the limit resets, then retry the failed node")
        .catch(() => undefined);
    }
    if (event.type === "run.status_changed" || event.type === "node.status_changed") {
      if (pendingStatePush.has(event.workflowRunId)) return;
      pendingStatePush.add(event.workflowRunId);
      setTimeout(() => {
        pendingStatePush.delete(event.workflowRunId);
        void runState(event.workflowRunId).then((s) => bus.send("run:state", s), () => undefined);
      }, 150);
    }
  });

  async function runState(runId: string): Promise<RunStateDto> {
    const state = await engine.getRunState(runId);
    const run = state?.run ?? db.runStore.getRun(runId);
    if (!run) throw new AppError("NOT_FOUND", `Unknown run ${runId}`);
    // A run made by an older workflow version keeps its own graph, so its node runs still line up.
    const def =
      engine.getDefinition(run.workflowId, run.workflowVersion) ??
      db.workflowDefinitions.get<WorkflowDefinition>(run.workflowId, run.workflowVersion)?.definition ??
      definition;
    const graph = toGraph(def);
    return {
      run: { ...run, ...(typeof run.inputs.title === "string" ? { title: run.inputs.title } : {}) },
      nodeRuns: state?.nodes ?? db.runStore.listNodeRuns(runId),
      graph: {
        nodes: graph.nodes.map((n) => {
          const spec = def.nodes.find((s) => s.id === n.id);
          return { id: n.id, label: n.label, type: n.type, mutation: n.mutation, ...(n.group ? { group: n.group } : {}), ...(spec?.description ? { description: spec.description } : {}), ...(spec?.config?.["ai"] === true ? { ai: true } : {}) };
        }),
        edges: graph.edges,
      },
    };
  }

  function requireProject(projectId: string): Project {
    const project = db.projects.get(projectId);
    if (!project) throw new AppError("NOT_FOUND", `Unknown project ${projectId}`);
    return project;
  }

  function summarize(project: Project): ProjectSummary {
    const profile = db.profiles.getLatest(project.id);
    const lastRun = db.runStore.listRuns({ projectId: project.id, limit: 1 })[0];
    return {
      ...project,
      ...(profile?.framework ? { framework: profile.framework } : {}),
      ...(profile?.packageManager ? { packageManager: profile.packageManager } : {}),
      ...(lastRun ? { lastRun: { id: lastRun.id, status: lastRun.status, createdAt: lastRun.createdAt, ...(typeof lastRun.inputs.title === "string" ? { title: lastRun.inputs.title } : {}) } } : {}),
      health: !profile ? "unknown" : profile.commands.build && profile.commands.typecheck ? "ok" : "warning",
    };
  }

  async function analyze(project: Project): Promise<{ project: Project; profile: ProjectProfile; warnings: string[] }> {
    const { profile, warnings } = await analyzeProject(project.rootPath, { projectId: project.id });
    const previous = db.profiles.getLatest(project.id);
    // Keep user overrides across re-analysis (spec §10.3).
    let merged = profile;
    if (previous) {
      const overrides: ProfileOverrides = {};
      const commands: Record<string, string> = {};
      for (const [field, meta] of Object.entries(previous.detection)) {
        if (!meta.overridden) continue;
        if (field.startsWith("commands.")) commands[field.slice(9)] = String(meta.value);
        else (overrides as Record<string, unknown>)[field] = meta.value;
      }
      if (Object.keys(commands).length) overrides.commands = commands;
      if (Object.keys(overrides).length) merged = applyOverrides(profile, overrides);
    }
    db.profiles.save(merged);
    return { project, profile: merged, warnings };
  }

  async function detectClis(): Promise<CliStatus[]> {
    const detections = await requireRunner().detect();
    return detections.map((d) => {
      db.cliInstallations.upsert({
        adapterId: d.adapterId,
        available: d.detection.installed,
        ...(d.detection.binaryPath ? { executablePath: d.detection.binaryPath } : {}),
        ...(d.detection.version ? { version: d.detection.version } : {}),
        ...(d.capabilities ? { capabilities: d.capabilities as unknown as Record<string, boolean> } : {}),
        ...(d.detection.error ? { error: d.detection.error } : {}),
        detectedAt: nowIso(),
      });
      return {
        adapterId: d.adapterId,
        label: CLI_LABELS[d.adapterId] ?? d.adapterId,
        installed: d.detection.installed,
        ...(d.detection.version ? { version: d.detection.version } : {}),
        ...(d.detection.binaryPath ? { binaryPath: d.detection.binaryPath } : {}),
        ...(d.detection.error ? { error: d.detection.error } : {}),
        ...(d.capabilities ? { capabilities: d.capabilities as unknown as Record<string, boolean> } : {}),
      };
    });
  }

  function sessionDto(record: NonNullable<ReturnType<typeof db.aiSessions.get>>): SessionDto {
    return {
      id: record.id,
      adapterId: record.adapterId,
      ...(record.externalSessionId ? { externalSessionId: record.externalSessionId } : {}),
      status: record.status === "completed" || record.status === "failed" || record.status === "cancelled" ? record.status : "running",
      cwd: record.cwd,
      startedAt: record.startedAt,
      ...(record.workflowRunId ? { workflowRunId: record.workflowRunId } : {}),
      ...(record.nodeRunId ? { nodeRunId: record.nodeRunId } : {}),
    };
  }

  const handlers: IpcHandlers = {
    "app:info": () => ({ name: "GoApp FrontFlow", version: app.getVersion(), platform: process.platform, dataDir }),

    "projects:list": () => db.projects.list().map(summarize),
    "projects:open": async () => {
      // Desktop E2E tests cannot drive the native dialog; the path still comes from the main process, never the renderer.
      const e2ePath = process.env["FRONTFLOW_E2E_OPEN_PATH"];
      const result = e2ePath ? { canceled: false, filePaths: [e2ePath] } : await dialog.showOpenDialog({ title: "Open frontend project", properties: ["openDirectory"] });
      const rootPath = result.filePaths[0];
      if (result.canceled || !rootPath) return null;
      const existing = db.projects.getByRootPath(rootPath);
      const now = nowIso();
      const id = existing?.id ?? uniqueProjectId(slugify(basename(rootPath)) || "project", rootPath);
      const project: Project = { id, name: existing?.name ?? basename(rootPath), rootPath, createdAt: existing?.createdAt ?? now, lastOpenedAt: now };
      db.projects.upsert(project);
      await analyze(project);
      return summarize(project);
    },
    "projects:get": ({ projectId }) => {
      const project = requireProject(projectId);
      db.projects.touch(projectId);
      const profile = db.profiles.getLatest(projectId);
      return { project, ...(profile ? { profile } : {}), warnings: [] };
    },
    "projects:analyze": ({ projectId }) => analyze(requireProject(projectId)),
    "projects:overrideProfile": ({ projectId, overrides }) => {
      const project = requireProject(projectId);
      const profile = db.profiles.getLatest(projectId);
      if (!profile) throw new AppError("NO_PROFILE", "Analyze the project first");
      const updated = applyOverrides(profile, overrides as ProfileOverrides);
      db.profiles.save(updated);
      return { project, profile: updated, warnings: [] };
    },
    "projects:remove": async ({ projectId }) => {
      requireProject(projectId);
      // Only FrontFlow's own data goes: runs, artifacts and the runs' hidden snapshots. Project files stay.
      for (const run of db.runStore.listRuns({ projectId })) await deleteRun(run);
      artifactStore.removeProject(projectId);
      // Left over from versions that ran each workflow in its own git worktree.
      rmSync(join(dataDir, "worktrees", projectId), { recursive: true, force: true });
    },
    "projects:gitStatus": async ({ projectId }) => {
      const pre = await preflight(requireProject(projectId).rootPath);
      return {
        isRepo: pre.isRepo,
        ...(pre.branch ? { branch: pre.branch } : {}),
        ...(pre.baseSha ? { baseSha: pre.baseSha } : {}),
        clean: pre.clean,
        dirtyFiles: pre.dirtyFiles,
        untrackedFiles: pre.untrackedFiles,
        warnings: pre.warnings,
      };
    },

    "clis:detect": () => detectClis(),

    "runs:create": async (req) => {
      const project = requireProject(req.projectId);
      if (!db.profiles.getLatest(project.id)) await analyze(project);
      const pre = await preflight(project.rootPath);
      const inputs: FeatureRunInputs = {
        snapshotIds: [],
        ...(pre.baseSha ? { gitBaseSha: pre.baseSha } : {}),
        title: req.title,
        // AI steps run only as interactive Claude Code sessions in a terminal (no headless CLI).
        adapterId: "claude-code",
        ...(req.claudeAccountId ? { claudeAccountId: req.claudeAccountId } : {}),
        ...(req.model ? { model: req.model } : {}),
        ...(req.effort ? { effort: req.effort } : {}),
        allowAssumptions: false,
      };
      const run = await engine.startRun({ projectId: project.id, definition, inputs });
      return runState(run.id);
    },
    "runs:importDocuments": async ({ runId, nodeId, ba, api, ops }) => {
      const run = db.runStore.getRun(runId);
      if (!run) throw new AppError("NOT_FOUND", `Unknown run ${runId}`);
      const snapshot = (type: "ba_markdown" | "api_markdown" | "ops_markdown" | "openapi", doc: { name: string; content: string }) => {
        try {
          const { snapshot: snap, text } = snapshotDocument({ type, content: doc.content, sourceUri: doc.name });
          artifactStore.saveSnapshotContent(run.projectId, snap, text);
          return snap;
        } catch (err) {
          if (err instanceof DocumentError) throw new AppError(err.code, `${doc.name}: ${err.message}`);
          throw err;
        }
      };
      // Every upload stays recorded (its snapshots are kept); the step only reads the latest one.
      const previous = toBatches((db.runStore.listNodeRuns(runId).find((n) => n.nodeId === nodeId)?.output as { history?: unknown } | undefined)?.history);
      const importedAt = nowIso();
      let imported: ImportedApiContract | ImportedBaSpec | ImportedOpsGuide;
      if (api) {
        const documents = api.map((doc) => ({ snapshotId: snapshot(doc.kind === "openapi" ? "openapi" : "api_markdown", doc).id, sourceUri: doc.name, kind: doc.kind }));
        imported = { api: documents, history: [...previous, { importedAt, documents: documents.map(({ snapshotId, sourceUri }) => ({ snapshotId, sourceUri })) }] };
      } else if (ba) {
        const documents = ba.map((doc) => ({ snapshotId: snapshot("ba_markdown", doc).id, sourceUri: doc.name }));
        imported = { ba: documents, history: [...previous, { importedAt, documents }] };
      } else if (ops) {
        const documents = ops.map((doc) => ({ snapshotId: snapshot("ops_markdown", doc).id, sourceUri: doc.name }));
        imported = { ops: documents, history: [...previous, { importedAt, documents }] };
      } else {
        throw new AppError("INVALID_INPUT", "No document to import");
      }
      // A waiting step continues with it; a finished one runs again, and so do the steps after it.
      await engine.retryNode(runId, nodeId, imported as unknown as Record<string, unknown>);
    },
    "runs:list": ({ projectId }) =>
      db.runStore.listRuns({ projectId, limit: 100 }).map((r: WorkflowRun) => ({
        id: r.id,
        title: typeof r.inputs.title === "string" ? r.inputs.title : r.workflowId,
        status: r.status,
        createdAt: r.createdAt,
        ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
      })),
    "runs:get": ({ runId }) => runState(runId),
    "runs:delete": async ({ runId }) => {
      const run = db.runStore.getRun(runId);
      if (!run) throw new AppError("NOT_FOUND", `Unknown run ${runId}`);
      await deleteRun(run);
    },
    "runs:pause": async ({ runId }) => void (await engine.pause(runId)),
    "runs:resume": async ({ runId }) => void (await engine.resume(runId)),
    "runs:cancel": async ({ runId }) => void (await engine.cancel(runId)),
    "runs:retryNode": async ({ runId, nodeId, input }) => void (await engine.retryNode(runId, nodeId, input)),
    "runs:provideInput": async ({ runId, nodeId, data }) => void (await engine.provideInput(runId, nodeId, data)),
    "runs:events": ({ runId, nodeRunId, limit }) =>
      db.runStore.listEvents(runId, { ...(nodeRunId ? { nodeRunId } : {}), limit, latest: true }).map((e) => toEventDto(e)),
    "runs:reports": ({ runId }) => {
      const run = db.runStore.getRun(runId);
      if (!run) throw new AppError("NOT_FOUND", `Unknown run ${runId}`);
      const artifacts = db.artifacts.listByRun(runId);
      return REPORT_FILES.flatMap(({ name, title }) => {
        const record = artifacts.filter((a) => a.relativePath.endsWith(name)).at(-1);
        return record ? [{ name, title, text: artifactStore.readText(record.id), path: join(runFilesDir(run.projectId, run.id), name) }] : [];
      });
    },
    "runs:revealFile": ({ runId, path, artifactId }) => {
      const run = db.runStore.getRun(runId);
      if (!run) throw new AppError("NOT_FOUND", `Unknown run ${runId}`);
      let file: string;
      if (artifactId) {
        const record = db.artifacts.listByRun(runId).find((a) => a.id === artifactId);
        if (!record) throw new AppError("NOT_FOUND", `Unknown artifact ${artifactId}`);
        file = artifactStore.resolvePath(record);
      } else {
        const root = runFilesDir(run.projectId, run.id);
        file = resolve(root, path ?? "");
        // Only the run's own workflow files: the path comes from the renderer.
        const back = relative(root, file);
        if (!back || back.startsWith("..") || isAbsolute(back)) throw new AppError("INVALID_PATH", `${path} is not one of the run's files`);
      }
      if (!existsSync(file)) throw new AppError("NOT_FOUND", `${file} no longer exists`);
      shell.showItemInFolder(file);
    },
    "runs:artifacts": ({ runId, nodeRunId }) => db.artifacts.list({ workflowRunId: runId, ...(nodeRunId ? { nodeRunId } : {}) }),
    "runs:readArtifact": ({ artifactId }) => {
      const { record, content } = artifactStore.read(artifactId);
      if (record.mimeType.startsWith("image/")) {
        return { record, dataUrl: `data:${record.mimeType};base64,${Buffer.from(content).toString("base64")}` };
      }
      const text = Buffer.from(content).toString("utf8");
      return { record, text: text.length > 500_000 ? `${text.slice(0, 500_000)}\n…truncated` : text };
    },

    "sessions:list": ({ projectId }) => db.aiSessions.listByProject(projectId, 200).map(sessionDto),
    "sessions:cancel": ({ sessionId }) => requireRunner().cancel(sessionId),
    // No `sessions:send` / `sessions:resume`: a session continues only in its interactive
    // terminal (`claude --resume` in a PTY, terminal:open), never as a headless `claude -p`.
    "sessions:rawLog": ({ sessionId }) => {
      const path = recorder.rawLogPath(sessionId);
      if (!path) return "";
      const full = artifactStore.resolvePath(path);
      if (!existsSync(full)) return "";
      const size = statSync(full).size;
      const text = readFileSync(full, "utf8");
      return size > 256_000 ? text.slice(-256_000) : text;
    },

    "terminal:open": async ({ sessionId, cols, rows }) => {
      const record = db.aiSessions.get(sessionId);
      if (!record) throw new AppError("NOT_FOUND", `Unknown session ${sessionId}`);
      if (!existsSync(record.cwd)) throw new AppError("NOT_FOUND", `Working directory ${record.cwd} no longer exists`);
      const terminalId = newId("term");
      const opened = await requireRunner().openTerminal({
        terminalId,
        adapterId: record.adapterId,
        ...(record.externalSessionId ? { externalSessionId: record.externalSessionId } : {}),
        cwd: record.cwd,
        cols,
        rows,
      });
      return { terminalId, command: opened.command };
    },
    "terminal:openFeature": async ({ runId, cols, rows }) => {
      const run = db.runStore.getRun(runId);
      if (!run) throw new AppError("NOT_FOUND", `Unknown run ${runId}`);
      const project = requireProject(run.projectId);
      if (!existsSync(project.rootPath)) throw new AppError("NOT_FOUND", `Project folder ${project.rootPath} no longer exists`);
      // Same Claude account as the run's AI steps, so its usage and login match theirs.
      const accountId = typeof run.inputs.claudeAccountId === "string" ? run.inputs.claudeAccountId : undefined;
      const configDir = accountId ? await accounts.claudeProfileFor(accountId) : undefined;
      const terminalId = newId("term");
      const opened = await requireRunner().openTerminal({
        terminalId,
        adapterId: typeof run.inputs.adapterId === "string" ? run.inputs.adapterId : "claude-code",
        cwd: project.rootPath,
        cols,
        rows,
        ...(configDir ? { env: { CLAUDE_CONFIG_DIR: configDir } } : {}),
      });
      return { terminalId, command: opened.command };
    },
    "terminal:snapshot": ({ terminalId }) => ({ data: terminalBuffers.get(terminalId) ?? "", open: openTerminals.has(terminalId) }),
    "terminal:write": ({ terminalId, data }) => requireRunner().writeTerminal(terminalId, data),
    "terminal:resize": ({ terminalId, cols, rows }) => requireRunner().resizeTerminal(terminalId, cols, rows),
    "terminal:close": ({ terminalId }) => requireRunner().closeTerminal(terminalId),

    "approvals:list": () => approvals.list().map(toApprovalDto),
    "approvals:decide": ({ requestId, approved }) => {
      const ok = approved ? approvals.approve(requestId) : approvals.reject(requestId);
      if (!ok) throw new AppError("NOT_FOUND", "Approval request is no longer pending");
    },

    "figma:status": () => figmaStatus(),

    "skills:list": () => ({ dir: skillsDir, skills: skills.list(), nodes: skillNodes(), assignments: skills.assignments() }),
    "skills:get": ({ name }) => {
      const skill = skills.get(name);
      if (!skill) throw new AppError("NOT_FOUND", `Unknown skill ${name}`);
      return skill;
    },
    "skills:save": ({ previousName, ...input }) => skills.save(input, previousName),
    "skills:delete": ({ name }) => skills.remove(name),
    "skills:import": async () => {
      const result = await dialog.showOpenDialog({
        title: "Import skills — a skill folder (with SKILL.md) or a folder of skills such as ~/.claude/skills",
        properties: ["openDirectory"],
      });
      const source = result.filePaths[0];
      if (result.canceled || !source) return null;
      const imported = skills.importFrom(source);
      if (!imported.imported.length && !imported.skipped.length) throw new AppError("NO_SKILLS", `No SKILL.md found in ${source}`);
      return imported;
    },
    "skills:assign": ({ nodeId, skills: names }) => {
      if (!skillNodes().some((n) => n.id === nodeId)) throw new AppError("NOT_FOUND", `${nodeId} is not an AI step`);
      return skills.setNodeSkills(nodeId, names);
    },
    "skills:openFolder": async ({ name }) => {
      const dir = name ? skills.get(name)?.dir : skillsDir;
      if (!dir) throw new AppError("NOT_FOUND", `Unknown skill ${name}`);
      mkdirSync(dir, { recursive: true });
      const error = await shell.openPath(dir);
      if (error) throw new AppError("OPEN_FAILED", error);
    },

    "prompts:get": ({ name }) => promptDto(name),
    "prompts:save": ({ name, text }) => {
      if (!text.trim()) throw new AppError("EMPTY_PROMPT", "A prompt cannot be empty; reset it to the default instead");
      prompts.save(name, text);
      return promptDto(name);
    },
    "prompts:reset": ({ name }) => {
      prompts.reset(name);
      return promptDto(name);
    },

    ...accounts.handlers,

    "settings:get": () => settingsStore.get(),
    "settings:update": (patch) => {
      const settings = settingsStore.update(patch);
      if (patch.goFigmaServerPath !== undefined) {
        figmaListener.reconnect();
        bus.send("figma:status", figmaStatus());
      }
      return settings;
    },
  };

  /** Cancels the run if active, drops its hidden git snapshots, its artifacts and its database rows. Project files stay. */
  async function deleteRun(run: WorkflowRun): Promise<void> {
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      await engine.cancel(run.id).catch(() => undefined);
    }
    const project = db.projects.get(run.projectId);
    if (project && existsSync(project.rootPath)) await deleteSnapshots(project.rootPath, run.id);
    db.runStore.deleteRun(run.id);
    artifactStore.applyRetention();
    rmSync(join(dataDir, "projects", run.projectId, "runs", run.id), { recursive: true, force: true });
  }

  /** A document step's upload history; runs imported before uploads held several files recorded one document per entry. */
  function toBatches(history: unknown): ImportedBatch[] {
    if (!Array.isArray(history)) return [];
    return history.flatMap((entry): ImportedBatch[] => {
      const e = entry as Partial<ImportedBatch> & { snapshotId?: string; sourceUri?: string };
      if (Array.isArray(e.documents) && typeof e.importedAt === "string") return [{ importedAt: e.importedAt, documents: e.documents }];
      if (typeof e.snapshotId === "string" && typeof e.importedAt === "string") return [{ importedAt: e.importedAt, documents: [{ snapshotId: e.snapshotId, ...(e.sourceUri ? { sourceUri: e.sourceUri } : {}) }] }];
      return [];
    });
  }

  /** The run's Markdown reports, in workflow order (written by the AI steps and the evidence report). */
  const REPORT_FILES = [
    { name: "api-review.md", title: "UI vs API review" },
    { name: "ba-scenarios.md", title: "BA scenarios" },
    { name: "test-design.md", title: "Test design" },
    { name: "acceptance-tests.md", title: "Acceptance tests" },
    { name: "evidence-report.md", title: "Evidence report" },
  ];

  /** The run's workflow files (documents, AI reports): inside the run's data folder, so deleteRun removes them. */
  function runFilesDir(projectId: string, runId: string): string {
    return join(dataDir, "projects", projectId, "runs", runId, "files");
  }

  function uniqueProjectId(base: string, rootPath: string): string {
    return db.projects.get(base) ? `${base}-${sha256(rootPath).slice(0, 6)}` : base;
  }

  /** Steps that run an AI CLI agent, in workflow order: the ones skills can be attached to. */
  function skillNodes(): SkillNodeDto[] {
    const graph = toGraph(definition);
    return definition.nodes
      .filter((n) => n.config?.["ai"] === true)
      .map((n) => {
        const group = graph.nodes.find((g) => g.id === n.id)?.group;
        return { id: n.id, label: n.label, ...(group ? { group } : {}), ...(n.description ? { description: n.description } : {}) };
      });
  }

  /** First launch: the skills shipped next to the workflows (repo `skill/`) start the library. */
  function seedSkills(): void {
    const candidates = [
      process.env["FRONTFLOW_SKILLS_SEED_DIR"],
      join(process.resourcesPath ?? "", "skill"),
      resolve(app.getAppPath(), "../../skill"),
      resolve(app.getAppPath(), "skill"),
    ].filter((p): p is string => !!p);
    const dir = candidates.find((p) => existsSync(p));
    mkdirSync(skillsDir, { recursive: true });
    if (!dir) return;
    try {
      const result = skills.importFrom(dir);
      console.info(`[skills] seeded ${result.imported.length} skill(s) from ${dir}`);
    } catch (err) {
      console.warn("[skills] could not seed the library:", err instanceof Error ? err.message : err);
    }
  }

  function loadDefinition(): WorkflowDefinition {
    return loadBuiltinWorkflows(workflowsDir);
  }

  function findWorkflowsDir(): string {
    const candidates = [
      process.env["FRONTFLOW_WORKFLOWS_DIR"],
      join(process.resourcesPath ?? "", "workflows"),
      resolve(app.getAppPath(), "../../workflows"),
      resolve(app.getAppPath(), "workflows"),
    ].filter((p): p is string => !!p);
    const dir = candidates.find((p) => existsSync(join(p, BUILTIN_WORKFLOW_FILES[0])));
    if (!dir) throw new Error(`Workflow definitions not found in ${candidates.join(", ")}`);
    return dir;
  }

  let disposed = false;
  return {
    handlers,
    async recover() {
      const result = await engine.recover();
      if (result.missingDefinitions.length) console.warn("[engine] runs with unknown definitions:", result.missingDefinitions);
      artifactStore.applyRetention();
    },
    async dispose() {
      disposed = true;
      engine.shutdown();
      approvals.expireAll();
      figmaListener.stop();
      accounts.dispose();
      runner?.dispose("App quitting");
      runnerProcess?.kill();
      db.close();
    },
  };
}

function toEventDto(event: { id: string; type: string; timestamp: string; workflowRunId: string; nodeRunId?: string; sessionId?: string; confidence?: number; payload: unknown }): EventDto {
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

function toApprovalDto(r: { id: string; permission: string; action: string; detail?: string; source: string; createdAt: string }): ApprovalDto {
  return { requestId: r.id, permission: r.permission, action: r.action, ...(r.detail ? { detail: r.detail } : {}), source: r.source, createdAt: r.createdAt };
}

