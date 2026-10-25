import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  buildClaudeInteractiveArgs,
  claudeProjectSettingsProblems,
  createClaudeTranscriptState,
  findClaudeTranscript,
  isRateLimitMessage,
  parseClaudeTranscriptLine,
  transcriptUsage,
} from "@frontflow/cli-adapters";
import { newId, sha256 } from "@frontflow/domain";
import { createAgentEvent, type AgentEvent } from "@frontflow/event-schema";
import { GOAPP_FIGMA_SERVER_NAME, buildStdioServerMcpConfig, type SupportedCli } from "@frontflow/figma-mcp-bridge";
import { isPathInside } from "@frontflow/policy";
import { NodeError, type NodeExecutionContext } from "@frontflow/workflow-engine";
import type { AgentBackend, NodeServices, TerminalBackend } from "./services.js";
import { skillsPrompt, type Skill } from "./skills.js";

export interface AgentStepInput {
  projectId: string;
  adapterId: string;
  cwd: string;
  /** Folders outside `cwd` the agent may read and write too (the run's workflow files). */
  addDirs?: string[];
  prompt: string;
  systemPrompt?: string;
  /** Read-only steps run in plan/read-only mode; mutation steps may edit files inside `cwd` (and `addDirs`) only. */
  readOnly: boolean;
  /** Give the CLI the goapp-figma MCP server for this step. */
  withFigma?: boolean;
  /** Commands the AI may run itself (exact project scripts) when the user allows shell access. */
  allowedCommands?: string[];
  /** Reading and writing files only: no shell, no network, no sub-agents (document analysis steps). */
  filesOnly?: boolean;
  /** `cwd` is the user's own project folder: an interactive session loads its .claude settings like a normal `claude` there. */
  projectSettings?: boolean;
  /** The step's output is there (e.g. its report file): an interactive session that left work in the background is not done before. */
  outputReady?: () => boolean;
  /** Claude Code runs as this saved account (FeatureRunInputs.claudeAccountId). */
  claudeAccountId?: string;
  /** The run's model and reasoning effort (FeatureRunInputs.model / effort). */
  model?: string;
  effort?: string;
}

const FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];
const NON_FILE_TOOLS = ["Bash", "PowerShell", "WebFetch", "WebSearch", "Task", "NotebookEdit"];
const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

export interface AgentStepResult {
  sessionId: string;
  externalSessionId?: string;
  resultText: string;
  filesChanged: string[];
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

const PERMISSION_MODES: Record<string, { readOnly?: string; write?: string }> = {
  "claude-code": { readOnly: "plan", write: "acceptEdits" },
  fake: { readOnly: "plan", write: "acceptEdits" },
  codex: { readOnly: "read-only", write: "workspace-write" },
  gemini: { readOnly: "default", write: "auto_edit" },
};

interface SessionOptions {
  cwd: string;
  addDirs?: string[];
  prompt: string;
  systemPrompt?: string;
  permissionMode?: string;
  mcpConfigPath?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  timeoutMs: number;
  env: Record<string, string>;
  projectSettings?: boolean;
  /** Claude Code's config folder for this session (a saved account's profile), else the machine's. */
  configDir?: string;
  model?: string;
  effort?: string;
  outputReady?: () => boolean;
}

interface SessionOutcome {
  sessionId: string;
  externalSessionId?: string;
  events: AgentEvent[];
  end: AgentEvent;
}

/**
 * Claude Code gives every session its own scratchpad for temporary files
 * (`<tmp>/claude/<project>/<session>/scratchpad/…`) and tells the model to use it,
 * so a write there is not a write outside the step's folder.
 */
export function isClaudeScratchpad(file: string, tmpRoot: string = tmpdir()): boolean {
  const root = join(tmpRoot, "claude");
  if (!isPathInside(file, root)) return false;
  const parts = relative(root, resolve(file)).split(/[\\/]/);
  return parts.length > 3 && parts[2]?.toLowerCase() === "scratchpad";
}

/**
 * Runs one AI CLI turn for a workflow node and waits for it to finish.
 * Events are forwarded to the engine so the node inspector shows them, file
 * writes outside the step's root are reported as policy violations, and the
 * Figma MCP config written for the step is removed afterwards.
 *
 * Claude Code steps always run as a real interactive session in a runner PTY
 * (a tmux-style pane the user can watch and answer in the AI terminals view). Headless runs
 * (`claude -p`, other CLIs) are not allowed: only the `fake` test adapter runs headless.
 */
export async function runAgentStep(ctx: NodeExecutionContext, services: NodeServices, input: AgentStepInput): Promise<AgentStepResult> {
  const settings = services.settings();
  const interactive = input.adapterId === "claude-code" && services.terminals !== undefined;
  if (!interactive && input.adapterId !== "fake") {
    throw new NodeError(
      "HEADLESS_DISABLED",
      input.adapterId === "claude-code"
        ? "AI steps run only as an interactive Claude Code session in a terminal, and no terminal is available"
        : `AI steps run only with Claude Code in an interactive terminal session, not ${input.adapterId}`,
      { retryable: false },
    );
  }
  const modes = PERMISSION_MODES[input.adapterId] ?? {};
  // Interactive sessions use Claude's auto mode: its safety classifier approves routine commands so
  // the user is not asked about every `find` or `npm run build`, and still stops risky ones. (Plan
  // mode would end on an "exit plan mode?" prompt that lets the AI start editing, so read-only
  // interactive steps lose the edit tools instead.)
  const permissionMode = interactive ? "auto" : input.readOnly ? modes.readOnly : modes.write;

  let mcpConfigPath: string | undefined;
  const env: Record<string, string> = {};
  let configDir: string | undefined;
  if (input.adapterId === "claude-code" && input.claudeAccountId && services.claudeProfileFor) {
    configDir = await services.claudeProfileFor(input.claudeAccountId);
    if (configDir) {
      env["CLAUDE_CONFIG_DIR"] = configDir;
      ctx.log("info", "Claude Code runs as the account chosen for this run, from its own config folder");
    }
  }
  const serverPath = input.withFigma ? services.figma?.serverPath() : undefined;
  if (input.withFigma && !serverPath) {
    ctx.log("warn", "GoApp Figma MCP server not found (Settings → GoApp Figma); the AI only gets it if its own config has goapp-figma");
  }
  if (serverPath) {
    // The CLI starts go-figma's MCP server itself and reads the design on demand (get_design_context, …).
    const cli: SupportedCli = input.adapterId === "codex" ? "codex" : input.adapterId === "gemini" ? "gemini" : "claude-code";
    const config = buildStdioServerMcpConfig(cli, { command: "node", args: [serverPath] }, GOAPP_FIGMA_SERVER_NAME);
    mkdirSync(services.mcpConfigDir, { recursive: true });
    mcpConfigPath = join(services.mcpConfigDir, `${ctx.nodeRunId}-${config.fileName.replace(/[\\/]/g, "_")}`);
    writeFileSync(mcpConfigPath, config.content, { mode: 0o600 });
  }
  // Headless CLIs deny tools nobody allowed; the goapp-figma tools only read the design (and write assets into cwd).
  const figmaTools = input.withFigma ? [`mcp__${GOAPP_FIGMA_SERVER_NAME}`] : [];
  const tools: { allowedTools?: string[]; disallowedTools?: string[] } = input.filesOnly
    ? { allowedTools: [...FILE_TOOLS, ...figmaTools], disallowedTools: NON_FILE_TOOLS }
    : settings.allowArbitraryShell && input.allowedCommands?.length && !input.readOnly
      ? { allowedTools: [...FILE_TOOLS, ...input.allowedCommands.map((c) => `Bash(${c})`), ...figmaTools] }
      : figmaTools.length
        ? { allowedTools: figmaTools }
        : {};
  if (interactive && input.readOnly) tools.disallowedTools = [...new Set([...(tools.disallowedTools ?? []), ...EDIT_TOOLS])];

  const prompt = await withNodeSkills(ctx, services, input.prompt);
  ctx.log(
    "info",
    `Starting ${input.adapterId}${interactive ? " as an interactive session" : ""} in ${input.readOnly ? "read-only" : "edit"} mode${permissionMode ? ` (${permissionMode})` : ""}${mcpConfigPath ? " with Figma MCP" : ""}`,
  );
  const options: SessionOptions = {
    cwd: input.cwd,
    ...(input.addDirs?.length ? { addDirs: input.addDirs } : {}),
    prompt,
    timeoutMs: settings.agentTimeoutMs,
    env,
    ...(configDir ? { configDir } : {}),
    ...(input.model ? { model: input.model } : {}),
    // `--effort` is Claude Code's; other CLIs keep their own setting.
    ...(input.effort && (input.adapterId === "claude-code" || input.adapterId === "fake") ? { effort: input.effort } : {}),
    ...(input.projectSettings ? { projectSettings: true } : {}),
    ...(input.outputReady ? { outputReady: input.outputReady } : {}),
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(mcpConfigPath ? { mcpConfigPath } : {}),
    ...tools,
  };
  try {
    const { sessionId, externalSessionId, events, end } = interactive
      ? await runInteractiveSession(ctx, services.terminals!, services.mcpConfigDir, options)
      : await runHeadlessSession(ctx, services.agents, input.adapterId, options);

    if (ctx.signal.aborted) throw new NodeError("CANCELLED", "AI session interrupted");
    if (end.type === "session.failed") {
      // Retrying a throttled account only hammers it; the host pauses the run instead.
      if (end.payload.code === "RATE_LIMITED" || isRateLimitMessage(end.payload.message)) {
        throw new NodeError("RATE_LIMITED", `AI CLI hit its usage/rate limit: ${end.payload.message}`, { retryable: false });
      }
      const code = end.payload.code === "TIMEOUT" ? "AGENT_TIMEOUT" : "AGENT_SESSION_FAILED";
      throw new NodeError(code, `AI CLI session failed: ${end.payload.message}`, { retryable: end.payload.code !== "CANCELLED" });
    }

    const written = [
      ...new Set(
        events.flatMap((e) => (e.type === "file.changed" ? [isAbsolute(e.payload.path) ? e.payload.path : resolve(input.cwd, e.payload.path)] : [])),
      ),
    ];
    const scratch = written.filter((f) => !isPathInside(f, input.cwd) && isClaudeScratchpad(f));
    if (scratch.length) ctx.log("info", `AI wrote temporary files in its Claude Code scratchpad (outside the project): ${scratch.join(", ")}`);
    // The run's workflow files are FrontFlow's, not the project's code.
    const runFiles = written.filter((f) => !isPathInside(f, input.cwd) && (input.addDirs ?? []).some((d) => isPathInside(f, d)));
    if (runFiles.length) ctx.log("info", `AI wrote the run's workflow files: ${runFiles.join(", ")}`);
    const filesChanged = written.filter((f) => !scratch.includes(f) && !runFiles.includes(f));
    const outside = filesChanged.filter((f) => !isPathInside(f, input.cwd));
    if (outside.length) {
      throw new NodeError("PERMISSION_DENIED", `AI CLI wrote outside its working folder: ${outside.join(", ")}`);
    }
    if (input.readOnly && filesChanged.length) {
      ctx.log("warn", "Read-only AI step reported file changes", filesChanged);
    }

    const resultText =
      (end.type === "session.completed" ? end.payload.result : undefined) ??
      events
        .flatMap((e) => (e.type === "message.delta" && e.payload.role === "assistant" ? [e.payload.text] : []))
        .join("");
    const usageEvent = [...events].reverse().find((e) => e.type === "usage.updated" && e.payload.scope !== "message");
    const toolCalls = events.filter((e) => e.type === "tool.started").length;
    const usage = usageEvent?.type === "usage.updated" ? usageEvent.payload : undefined;
    ctx.log(
      "info",
      `AI finished: ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}, ${filesChanged.length} file${filesChanged.length === 1 ? "" : "s"} changed${
        usage?.outputTokens !== undefined ? `, ${usage.inputTokens ?? 0} in / ${usage.outputTokens} out tokens` : ""
      }${usage?.costUsd !== undefined ? `, $${usage.costUsd.toFixed(4)}` : ""}`,
    );
    const external = externalSessionId ?? (end.type === "session.completed" ? end.payload.externalSessionId : undefined);
    return {
      sessionId,
      ...(external ? { externalSessionId: external } : {}),
      resultText,
      filesChanged: filesChanged.map((f) => f.slice(input.cwd.length).replace(/^[\\/]+/, "").replace(/\\/g, "/")),
      ...(usage ? { usage } : {}),
    };
  } finally {
    if (mcpConfigPath) rmSync(mcpConfigPath, { force: true });
  }
}

/** Appends the skills attached to this step (Skills screen) to the task; the log names each with a content hash. */
async function withNodeSkills(ctx: NodeExecutionContext, services: NodeServices, prompt: string): Promise<string> {
  if (!services.skills) return prompt;
  let skills: Skill[];
  try {
    skills = await services.skills.forNode(ctx.workflowId, ctx.nodeId);
  } catch (err) {
    ctx.log("warn", `Could not load the skills of this step: ${err instanceof Error ? err.message : String(err)}`);
    return prompt;
  }
  if (!skills.length) return prompt;
  const section = skillsPrompt(skills);
  ctx.log("info", `Skills: ${skills.map((s) => `${s.name} (${sha256(s.body).slice(0, 8)})`).join(", ")}`, { skills: skills.map((s) => s.name) });
  if (section.truncated.length) ctx.log("warn", `Skill text shortened to fit the prompt: ${section.truncated.join(", ")}; the AI is told where to read the rest`);
  return `${prompt}\n\n${section.text}`;
}

/** `claude -p` / `codex exec` / … through the CLI runner, following the adapter's normalized events. */
async function runHeadlessSession(ctx: NodeExecutionContext, agents: AgentBackend, adapterId: string, options: SessionOptions): Promise<SessionOutcome> {
  const events: AgentEvent[] = [];
  let sessionId: string | undefined;
  let settle: ((e: AgentEvent) => void) | undefined;
  const terminal = new Promise<AgentEvent>((res) => (settle = res));
  const pending: AgentEvent[] = [];

  const accept = (event: AgentEvent) => {
    events.push(event);
    ctx.emit(event);
    if (event.type === "session.completed" || event.type === "session.failed") settle?.(event);
  };
  const off = agents.subscribeAll((event) => {
    if (event.nodeRunId !== ctx.nodeRunId) return;
    if (!sessionId) pending.push(event);
    else if (event.sessionId === sessionId) accept(event);
  });
  const onAbort = () => {
    if (sessionId) void agents.cancel(sessionId);
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const session = await agents.start(adapterId, {
      cwd: options.cwd,
      prompt: options.prompt,
      traceId: ctx.traceId,
      workflowRunId: ctx.runId,
      nodeRunId: ctx.nodeRunId,
      timeoutMs: options.timeoutMs,
      env: options.env,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
      ...(options.mcpConfigPath ? { mcpConfigPath: options.mcpConfigPath } : {}),
      ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
    });
    sessionId = session.id;
    for (const event of pending.splice(0)) if (event.sessionId === sessionId) accept(event);
    if (ctx.signal.aborted) onAbort();
    const end = await terminal;
    return { sessionId: session.id, ...(session.externalSessionId ? { externalSessionId: session.externalSessionId } : {}), events, end };
  } finally {
    off();
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** `resumeState` key of the node run's Claude session. */
const CLAUDE_SESSION_KEY = "claudeSessionId";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Claude Code session a node run kept, to reopen it (`claude --resume <id>`) after the step. */
export function claudeSessionOf(resumeState: Record<string, unknown> | undefined): string | undefined {
  const kept = resumeState?.[CLAUDE_SESSION_KEY];
  return typeof kept === "string" && UUID_RE.test(kept) ? kept : undefined;
}

const POLL_MS = 400;
/** After Claude ends its turn, the user has this long to keep chatting before the step completes. */
const SETTLE_MS = 8000;
const STALL_MS = 15_000;
/** No transcript activity this long: tell the user to look at the terminal (the session itself never times out). */
const IDLE_WARN_MS = 10 * 60_000;

/**
 * Claude Code's own interactive UI in a runner PTY: the AI terminals view shows it live and the
 * user can type into it (permission prompts, follow-ups). Progress is read from the session's
 * transcript; the step completes once Claude ends its turn and nobody keeps chatting. When Claude
 * left work in the background (Monitor, a `run_in_background` command, e.g. a long test run) and the
 * step's output is not there yet, the session stays open: Claude takes a new turn when that work
 * reports back, and the step goes on until the output is written. There is no time limit: a waiting
 * Claude costs nothing, so a quiet session is only reported and the user decides (answer or cancel).
 *
 * A node run keeps one Claude session, like a conversation in the Claude Code IDE extension: its id
 * is saved on the node run before Claude starts, and a retry, a resumed pause or a run recovered
 * after an app restart continues it with `--resume` instead of leaving a new session behind each
 * time. Only running the step again from scratch (a node reset) starts a new one.
 */
async function runInteractiveSession(ctx: NodeExecutionContext, terminals: TerminalBackend, workDir: string, options: SessionOptions): Promise<SessionOutcome> {
  const kept = ctx.resumeState?.[CLAUDE_SESSION_KEY];
  const externalSessionId = typeof kept === "string" && UUID_RE.test(kept) ? kept : randomUUID();
  // No transcript yet (Claude never took the task, or another account's config folder): start it under the same id.
  let transcript = externalSessionId === kept ? findClaudeTranscript(options.configDir ?? terminals.claudeConfigDir, options.cwd, externalSessionId) : undefined;
  const resume = transcript !== undefined;
  if (externalSessionId !== kept) await ctx.saveResumeState({ ...ctx.resumeState, [CLAUDE_SESSION_KEY]: externalSessionId });
  const sessionId = newId("ses");
  const terminalId = newId("term");
  const evCtx = { traceId: ctx.traceId, workflowRunId: ctx.runId, nodeRunId: ctx.nodeRunId, sessionId };
  const parseCtx = { ...evCtx, cwd: options.cwd, adapterId: "claude-code" };
  const events: AgentEvent[] = [];
  const emit = (event: AgentEvent) => {
    events.push(event);
    ctx.emit(event);
  };

  // Long prompts would overflow the command line (32K on Windows): they go through files.
  mkdirSync(workDir, { recursive: true });
  const taskFile = join(workDir, `${ctx.nodeRunId}-task.md`);
  writeFileSync(taskFile, options.prompt, { mode: 0o600 });
  const systemFile = options.systemPrompt ? join(workDir, `${ctx.nodeRunId}-system.md`) : undefined;
  if (systemFile) writeFileSync(systemFile, options.systemPrompt!, { mode: 0o600 });
  // Outside the user's project (scratch folders of analysis steps) only the user's own settings
  // apply; in the project folder a session loads its .claude settings like a normal `claude` there.
  const settingSources = options.projectSettings ? projectSettingSources(ctx, options.cwd) : "user";
  const args = [
    ...buildClaudeInteractiveArgs({
      prompt: resume
        ? `FrontFlow is running this step again in this session: it was interrupted, or ended without the step's output. Your task is in ${taskFile}. Read the whole file again (it may have changed), check what you already did, then finish the task.`
        : `Your task is in ${taskFile}. Read the whole file, then carry it out.`,
      sessionId: externalSessionId,
      resume,
      ...(settingSources ? { settingSources } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(systemFile ? { systemPromptFile: systemFile } : {}),
      ...(options.mcpConfigPath ? { mcpConfigPath: options.mcpConfigPath } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
      ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
    }),
    ...[workDir, ...(options.addDirs ?? [])].flatMap((dir) => ["--add-dir", dir]),
  ];

  let done = false;
  let settleEnd: (e: AgentEvent) => void = () => undefined;
  const ended = new Promise<AgentEvent>((res) => (settleEnd = res));
  const finish = (event: AgentEvent) => {
    if (done) return;
    done = true;
    emit(event);
    settleEnd(event);
  };
  const state = createClaudeTranscriptState();
  let background = false;
  let waitLogged = false;
  const watchBackground = (event: AgentEvent) => {
    if (event.type !== "tool.started") return;
    const input = event.payload.input as { run_in_background?: unknown } | undefined;
    if (event.payload.name === "Monitor" || input?.run_in_background === true) background = true;
  };
  const waitsForBackground = () => {
    if (!background || !options.outputReady || options.outputReady()) return false;
    if (!waitLogged) {
      waitLogged = true;
      ctx.log("info", "Claude is waiting for work it left in the background (e.g. a test run); the step goes on until it writes its output");
    }
    return true;
  };
  const complete = () => {
    if (done) return;
    const usage = transcriptUsage(state);
    if (usage.outputTokens) emit(createAgentEvent("usage.updated", evCtx, usage));
    finish(createAgentEvent("session.completed", evCtx, { externalSessionId, result: state.answer.join("\n") }));
  };
  const fail = (code: string, message: string) => finish(createAgentEvent("session.failed", evCtx, { code, message }));

  // A resumed session appends to its transcript: only what comes after this point belongs to this attempt.
  let offset = transcript ? fileSize(transcript) : 0;
  let partial = Buffer.alloc(0);
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const stopSettle = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = undefined;
  };
  const startedAt = Date.now();
  let stallWarned = false;
  let lastActivity = Date.now();
  let idleWarned = false;
  const poll = () => {
    if (done) return;
    transcript ??= findClaudeTranscript(options.configDir ?? terminals.claudeConfigDir, options.cwd, externalSessionId);
    if (!transcript) {
      // No transcript yet = Claude has not taken the task: it is waiting on a startup question.
      if (!stallWarned && Date.now() - startedAt > STALL_MS) {
        stallWarned = true;
        ctx.log("warn", "Claude is waiting for you: answer its question (e.g. trust this folder → Enter) in this step's AI chat tab");
      }
      return;
    }
    let size: number;
    try {
      size = statSync(transcript).size;
    } catch {
      return;
    }
    if (size > offset) {
      const chunk = Buffer.alloc(size - offset);
      const fd = openSync(transcript, "r");
      try {
        readSync(fd, chunk, 0, chunk.length, offset);
      } finally {
        closeSync(fd);
      }
      offset = size;
      lastActivity = Date.now();
      idleWarned = false;
      partial = Buffer.concat([partial, chunk]);
      for (let nl = partial.indexOf(0x0a); nl >= 0; nl = partial.indexOf(0x0a)) {
        const line = partial.subarray(0, nl).toString("utf8");
        partial = partial.subarray(nl + 1);
        if (!line.trim()) continue;
        const parsed = parseClaudeTranscriptLine(line, parseCtx, state);
        parsed.events.forEach(watchBackground);
        parsed.events.forEach(emit);
        if (parsed.humanPrompt) stopSettle();
      }
    }
    if (state.rateLimit) return fail("RATE_LIMITED", state.rateLimit);
    if (!idleWarned && Date.now() - lastActivity > IDLE_WARN_MS) {
      idleWarned = true;
      ctx.log("warn", `No activity from Claude for ${Math.round(IDLE_WARN_MS / 60_000)} minutes: check this step's AI terminal, or cancel the step`);
    }
    if (!state.turnEnded || state.tools.size > 0) stopSettle();
    else settleTimer ??= setTimeout(() => {
      settleTimer = undefined;
      if (state.turnEnded && !waitsForBackground()) complete();
    }, SETTLE_MS);
  };

  const offExit = terminals.onExit((id, exitCode) => {
    if (id !== terminalId || done) return;
    poll();
    if (state.turnEnded) complete();
    else fail("PROCESS_EXITED", `Claude exited (code ${exitCode ?? "null"}) before finishing the task`);
  });
  const timer = setInterval(poll, POLL_MS);
  const onAbort = () => fail("CANCELLED", "Session cancelled by user");
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  try {
    emit(createAgentEvent("session.started", evCtx, { adapterId: "claude-code", cwd: options.cwd, externalSessionId }));
    // The AI terminals view attaches to this terminal; a new folder may first ask to be trusted.
    ctx.log(
      "info",
      resume
        ? "Claude continues this step's earlier session (same conversation): watch it and answer its prompts in this step's AI chat tab"
        : "Claude runs as an interactive session: watch it and answer its prompts in this step's AI chat tab",
      { kind: "terminal", terminalId, externalSessionId },
    );
    try {
      await terminals.open({ terminalId, adapterId: "claude-code", cwd: options.cwd, cols: 120, rows: 36, args, env: options.env });
    } catch (err) {
      fail("SPAWN_FAILED", `Could not start interactive Claude: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (ctx.signal.aborted) onAbort();
    return { sessionId, externalSessionId, events, end: await ended };
  } finally {
    clearInterval(timer);
    stopSettle();
    offExit();
    ctx.signal.removeEventListener("abort", onAbort);
    await terminals.close(terminalId).catch(() => undefined);
    rmSync(taskFile, { force: true });
    if (systemFile) rmSync(systemFile, { force: true });
  }
}

/**
 * The user's own project loads its .claude settings like a normal `claude` there, except a file the
 * TUI would stop on with a "Settings Warning" dialog: nobody may be watching to press Enter.
 */
function projectSettingSources(ctx: NodeExecutionContext, cwd: string): string | undefined {
  const problems = claudeProjectSettingsProblems(cwd);
  if (!problems.length) return undefined;
  for (const p of problems) ctx.log("warn", `Claude runs without ${p.file} for this step (${p.problem}); fix the file to have it apply again`);
  const skipped = new Set(problems.map((p) => p.source));
  return ["user", ...(["project", "local"] as const).filter((s) => !skipped.has(s))].join(",");
}

/** Pulls the last fenced JSON block (or bare JSON object) out of an AI answer. */
export function extractJson<T>(text: string): T | undefined {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  const candidates = fences.length ? fences.reverse() : [text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}
