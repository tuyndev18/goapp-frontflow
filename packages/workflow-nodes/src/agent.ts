import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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
  prompt: string;
  systemPrompt?: string;
  /** Read-only steps run in plan/read-only mode; mutation steps may edit files inside `cwd` only. */
  readOnly: boolean;
  /** Give the CLI the goapp-figma MCP server for this step. */
  withFigma?: boolean;
  /** Commands the AI may run itself (exact project scripts) when the user allows shell access. */
  allowedCommands?: string[];
  /** Reading and writing files only: no shell, no network, no sub-agents (document analysis steps). */
  filesOnly?: boolean;
  /** `cwd` is the user's own project folder: an interactive session loads its .claude settings like a normal `claude` there. */
  projectSettings?: boolean;
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
  prompt: string;
  systemPrompt?: string;
  permissionMode?: string;
  mcpConfigPath?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  timeoutMs: number;
  env: Record<string, string>;
  projectSettings?: boolean;
}

interface SessionOutcome {
  sessionId: string;
  externalSessionId?: string;
  events: AgentEvent[];
  end: AgentEvent;
}

/**
 * Runs one AI CLI turn for a workflow node and waits for it to finish.
 * Events are forwarded to the engine so the node inspector shows them, file
 * writes outside the step's root are reported as policy violations, and the
 * Figma MCP config written for the step is removed afterwards.
 *
 * Claude Code steps run either headless (`claude -p`, stream-json) or, when the
 * host enables it, as a real interactive session in a PTY that the user can
 * watch and answer in the AI terminals view.
 */
export async function runAgentStep(ctx: NodeExecutionContext, services: NodeServices, input: AgentStepInput): Promise<AgentStepResult> {
  const settings = services.settings();
  const interactive = settings.interactiveAgents === true && input.adapterId === "claude-code" && services.terminals !== undefined;
  const modes = PERMISSION_MODES[input.adapterId] ?? {};
  // Interactive sessions use Claude's auto mode: its safety classifier approves routine commands so
  // the user is not asked about every `find` or `npm run build`, and still stops risky ones. (Plan
  // mode would end on an "exit plan mode?" prompt that lets the AI start editing, so read-only
  // interactive steps lose the edit tools instead.)
  const permissionMode = interactive ? "auto" : input.readOnly ? modes.readOnly : modes.write;

  let mcpConfigPath: string | undefined;
  const env: Record<string, string> = {};
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
    prompt,
    timeoutMs: settings.agentTimeoutMs,
    env,
    ...(input.projectSettings ? { projectSettings: true } : {}),
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

    const filesChanged = [
      ...new Set(
        events.flatMap((e) => (e.type === "file.changed" ? [isAbsolute(e.payload.path) ? e.payload.path : resolve(input.cwd, e.payload.path)] : [])),
      ),
    ];
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
    skills = await services.skills.forNode(ctx.nodeId);
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

const POLL_MS = 400;
/** After Claude ends its turn, the user has this long to keep chatting before the step completes. */
const SETTLE_MS = 8000;
const STALL_MS = 15_000;

/**
 * Claude Code's own interactive UI in a runner PTY: the AI terminals view shows it live and the
 * user can type into it (permission prompts, follow-ups). Progress is read from the session's
 * transcript; the step completes once Claude ends its turn and nobody keeps chatting.
 */
async function runInteractiveSession(ctx: NodeExecutionContext, terminals: TerminalBackend, workDir: string, options: SessionOptions): Promise<SessionOutcome> {
  const externalSessionId = randomUUID();
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
      prompt: `Your task is in ${taskFile}. Read the whole file, then carry it out.`,
      sessionId: externalSessionId,
      ...(settingSources ? { settingSources } : {}),
      ...(systemFile ? { systemPromptFile: systemFile } : {}),
      ...(options.mcpConfigPath ? { mcpConfigPath: options.mcpConfigPath } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
      ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
    }),
    "--add-dir",
    workDir,
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
  const complete = () => {
    if (done) return;
    const usage = transcriptUsage(state);
    if (usage.outputTokens) emit(createAgentEvent("usage.updated", evCtx, usage));
    finish(createAgentEvent("session.completed", evCtx, { externalSessionId, result: state.answer.join("\n") }));
  };
  const fail = (code: string, message: string) => finish(createAgentEvent("session.failed", evCtx, { code, message }));

  let transcript: string | undefined;
  let offset = 0;
  let partial = Buffer.alloc(0);
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const stopSettle = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = undefined;
  };
  const startedAt = Date.now();
  let stallWarned = false;
  const poll = () => {
    if (done) return;
    transcript ??= findClaudeTranscript(terminals.claudeConfigDir, options.cwd, externalSessionId);
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
      partial = Buffer.concat([partial, chunk]);
      for (let nl = partial.indexOf(0x0a); nl >= 0; nl = partial.indexOf(0x0a)) {
        const line = partial.subarray(0, nl).toString("utf8");
        partial = partial.subarray(nl + 1);
        if (!line.trim()) continue;
        const parsed = parseClaudeTranscriptLine(line, parseCtx, state);
        parsed.events.forEach(emit);
        if (parsed.humanPrompt) stopSettle();
      }
    }
    if (state.rateLimit) return fail("RATE_LIMITED", state.rateLimit);
    if (!state.turnEnded || state.tools.size > 0) stopSettle();
    else settleTimer ??= setTimeout(() => {
      settleTimer = undefined;
      if (state.turnEnded) complete();
    }, SETTLE_MS);
  };

  const offExit = terminals.onExit((id, exitCode) => {
    if (id !== terminalId || done) return;
    poll();
    if (state.turnEnded) complete();
    else fail("PROCESS_EXITED", `Claude exited (code ${exitCode ?? "null"}) before finishing the task`);
  });
  const timer = setInterval(poll, POLL_MS);
  const timeout = setTimeout(() => fail("TIMEOUT", `Session exceeded ${options.timeoutMs}ms`), options.timeoutMs);
  const onAbort = () => fail("CANCELLED", "Session cancelled by user");
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  try {
    emit(createAgentEvent("session.started", evCtx, { adapterId: "claude-code", cwd: options.cwd, externalSessionId }));
    // The AI terminals view attaches to this terminal; a new folder may first ask to be trusted.
    ctx.log("info", "Claude runs as an interactive session: watch it and answer its prompts in this step's AI chat tab", { kind: "terminal", terminalId, externalSessionId });
    try {
      await terminals.open({ terminalId, adapterId: "claude-code", cwd: options.cwd, cols: 120, rows: 36, args, env: options.env });
    } catch (err) {
      fail("SPAWN_FAILED", `Could not start interactive Claude: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (ctx.signal.aborted) onAbort();
    return { sessionId, externalSessionId, events, end: await ended };
  } finally {
    clearInterval(timer);
    clearTimeout(timeout);
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
