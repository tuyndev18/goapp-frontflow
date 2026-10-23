import { readFileSync } from "node:fs";
import path from "node:path";
import { createAgentEvent, type AgentEvent, type AgentEventOf, type EventContext } from "@frontflow/event-schema";
import type { CliCapabilities } from "../types.js";
import { ProcessCliAdapter, type LaunchSpec, type ProcessAdapterOptions, type SessionRecord } from "./base.js";

export interface ClaudeParseContext extends EventContext {
  cwd: string;
  adapterId?: string;
}

export interface ClaudeParseState {
  tools: Map<string, { name: string; input: Record<string, unknown>; startedAt: number }>;
  externalSessionId?: string;
}

export function createClaudeParseState(): ClaudeParseState {
  return { tools: new Map() };
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const MAX_OUTPUT = 4000;

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Flattens a tool_result `content` (string or content blocks) to text. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isObj(b) && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}… [truncated ${text.length - MAX_OUTPUT} chars]` : text;
}

function toolFilePath(input: Json, cwd: string): string | undefined {
  const p = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  if (!p) return undefined;
  return path.isAbsolute(p) ? path.relative(cwd, p).split(path.sep).join("/") || p : p.split(path.sep).join("/");
}

/**
 * Pure mapping of one Claude Code `--output-format stream-json` line to
 * normalized events. Non-JSON or unknown lines yield [].
 */
export function parseClaudeStreamLine(line: string, ctx: ClaudeParseContext, state: ClaudeParseState): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return [];
  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return [];
  }
  return isObj(msg) ? parseClaudeMessage(msg, ctx, state) : [];
}

/** Maps one parsed Claude message (stream-json line or transcript entry of the same shape) to normalized events. */
export function parseClaudeMessage(msg: Record<string, unknown>, ctx: ClaudeParseContext, state: ClaudeParseState): AgentEvent[] {
  const { cwd, adapterId = "claude-code", ...eventCtx } = ctx;
  const ev = <T extends AgentEvent["type"]>(type: T, payload: AgentEventOf<T>["payload"]) =>
    createAgentEvent<T>(type, eventCtx, payload);
  const out: AgentEvent[] = [];
  const sessionId = str(msg.session_id);
  if (sessionId) state.externalSessionId = sessionId;

  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init") {
        const model = str(msg.model);
        out.push(
          ev("session.started", {
            adapterId,
            cwd: str(msg.cwd) ?? cwd,
            ...(sessionId ? { externalSessionId: sessionId } : {}),
            ...(model ? { model } : {}),
          }),
          ev("status.changed", { status: "thinking" }),
        );
      }
      break;
    }
    case "assistant": {
      const message = isObj(msg.message) ? msg.message : {};
      const content = Array.isArray(message.content) ? message.content : [];
      // One API message spans several lines that repeat its usage: report it per message id.
      const messageId = str(message.id);
      const model = str(message.model);
      if (messageId && isObj(message.usage)) {
        out.push(ev("usage.updated", { ...claudeUsage(message.usage), ...(model ? { model } : {}), scope: "message", messageId }));
      }
      for (const block of content) {
        if (!isObj(block)) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          out.push(ev("message.delta", { role: "assistant", text: block.text }));
        } else if (block.type === "tool_use") {
          const toolCallId = str(block.id) ?? `tool_${state.tools.size + 1}`;
          const name = str(block.name) ?? "unknown";
          const input = isObj(block.input) ? block.input : {};
          state.tools.set(toolCallId, { name, input, startedAt: Date.now() });
          out.push(ev("tool.started", { toolCallId, name, input }));
          out.push(ev("status.changed", { status: "running_tool", detail: name }));
          if (SHELL_TOOLS.has(name) && typeof input.command === "string") {
            out.push(ev("command.started", { commandId: toolCallId, command: input.command, cwd }));
          }
        }
      }
      break;
    }
    case "user": {
      const message = isObj(msg.message) ? msg.message : {};
      const content = Array.isArray(message.content) ? message.content : [];
      const meta = isObj(msg.tool_use_result) ? msg.tool_use_result : undefined;
      for (const block of content) {
        if (!isObj(block) || block.type !== "tool_result") continue;
        const toolCallId = str(block.tool_use_id) ?? "";
        const tool = state.tools.get(toolCallId);
        state.tools.delete(toolCallId);
        const name = tool?.name ?? "unknown";
        const ok = block.is_error !== true;
        const text = toolResultText(block.content);
        out.push(ev("tool.completed", { toolCallId, name, ok, output: truncate(text) }));
        if (tool && SHELL_TOOLS.has(name)) {
          const code = /exit code (\d+)/i.exec(text)?.[1];
          out.push(
            ev("command.completed", {
              commandId: toolCallId,
              command: str(tool.input.command) ?? "",
              exitCode: code !== undefined ? Number(code) : ok ? 0 : 1,
              durationMs: Date.now() - tool.startedAt,
            }),
          );
        }
        if (tool && ok && FILE_TOOLS.has(name)) {
          const p = toolFilePath(tool.input, cwd);
          if (p) {
            const created = name === "Write" && (meta === undefined || meta.type === "create");
            out.push(ev("file.changed", { path: p, change: created ? "created" : "modified" }));
          }
        }
      }
      if (out.length > 0) out.push(ev("status.changed", { status: "thinking" }));
      break;
    }
    case "result": {
      const cost = num(msg.total_cost_usd) ?? num(msg.cost_usd);
      if (isObj(msg.usage) || cost !== undefined) {
        out.push(
          ev("usage.updated", {
            ...(isObj(msg.usage) ? claudeUsage(msg.usage) : {}),
            ...(cost !== undefined ? { costUsd: cost } : {}),
            scope: "total",
          }),
        );
      }
      const subtype = str(msg.subtype) ?? "success";
      const resultText = str(msg.result);
      if (msg.is_error === true || subtype !== "success") {
        const errors = Array.isArray(msg.errors) ? msg.errors.filter((e) => typeof e === "string").join("; ") : "";
        out.push(
          ev("session.failed", {
            code: subtype === "success" ? "CLI_ERROR" : subtype.toUpperCase(),
            message: resultText || errors || subtype,
          }),
        );
      } else {
        out.push(
          ev("session.completed", {
            ...(sessionId ? { externalSessionId: sessionId } : {}),
            ...(resultText !== undefined ? { result: resultText } : {}),
          }),
        );
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/** Anthropic `usage` → normalized counters; input includes the cached tokens. */
function claudeUsage(usage: Json): { inputTokens: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } {
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const output = num(usage.output_tokens);
  return {
    inputTokens: (num(usage.input_tokens) ?? 0) + (cacheWrite ?? 0) + (cacheRead ?? 0),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

/** stream-json user message line for stdin (`--input-format stream-json`). */
export function claudeUserMessage(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
}

/**
 * argv for an interactive (TUI) session that starts working on `prompt` right away. The prompt
 * comes first because the tool-list options are variadic and would swallow a trailing positional.
 * `sessionId` (a UUID) pins the transcript file so the host can follow the session.
 */
export function buildClaudeInteractiveArgs(input: {
  prompt: string;
  sessionId: string;
  model?: string;
  /** low | medium | high | xhigh | max */
  effort?: string;
  systemPromptFile?: string;
  mcpConfigPath?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  /** e.g. "user": skip the project's own .claude/settings*.json (their warnings and permission rules). */
  settingSources?: string;
}): string[] {
  const args = [input.prompt, "--session-id", input.sessionId];
  if (input.settingSources) args.push("--setting-sources", input.settingSources);
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  if (input.mcpConfigPath) args.push("--mcp-config", input.mcpConfigPath);
  if (input.systemPromptFile) args.push("--append-system-prompt-file", input.systemPromptFile);
  if (input.permissionMode) args.push("--permission-mode", input.permissionMode);
  if (input.allowedTools && input.allowedTools.length > 0) args.push("--allowedTools", input.allowedTools.join(","));
  if (input.disallowedTools && input.disallowedTools.length > 0) args.push("--disallowedTools", input.disallowedTools.join(","));
  return args;
}

/** A folder's own Claude settings file that interactive Claude would stop on at startup. */
export interface ClaudeSettingsProblem {
  /** The `--setting-sources` name that loads the file. */
  source: "project" | "local";
  file: string;
  problem: string;
}

const PROJECT_SETTINGS_FILES = [
  { source: "project", name: "settings.json" },
  { source: "local", name: "settings.local.json" },
] as const;

/**
 * Claude Code skips an allow rule with a wildcard in its tool name unless the wildcard follows a
 * literal `mcp__<server>__` prefix: `*` and `mcp__*` are skipped, `Bash(npm run *)` is fine.
 */
function unsupportedAllowRule(rule: unknown): boolean {
  if (typeof rule !== "string") return true;
  const tool = rule.split("(")[0]!;
  const star = tool.indexOf("*");
  return star >= 0 && !/^mcp__[^*]+__/.test(tool.slice(0, star));
}

/**
 * Problems in `<cwd>/.claude/settings.json` and `settings.local.json` that make the interactive TUI
 * open a "Settings Warning" dialog and wait for a key before it takes the task: invalid JSON and
 * permission allow rules it does not support.
 */
export function claudeProjectSettingsProblems(cwd: string): ClaudeSettingsProblem[] {
  const out: ClaudeSettingsProblem[] = [];
  for (const { source, name } of PROJECT_SETTINGS_FILES) {
    const file = path.join(cwd, ".claude", name);
    let text: string;
    try {
      text = readFileSync(file, "utf8").replace(/^﻿/, "");
    } catch {
      continue;
    }
    if (!text.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      out.push({ source, file, problem: "invalid JSON" });
      continue;
    }
    const allow = isObj(json) && isObj(json.permissions) ? json.permissions.allow : undefined;
    const bad = Array.isArray(allow) ? allow.filter(unsupportedAllowRule) : [];
    if (bad.length) {
      out.push({ source, file, problem: `unsupported permissions.allow rule${bad.length === 1 ? "" : "s"} ${bad.map((r) => JSON.stringify(r)).join(", ")}` });
    }
  }
  return out;
}

/** Builds the headless streaming argv. Prompts go over stdin, secrets via env. */
export function buildClaudeArgs(input: {
  model?: string;
  effort?: string;
  systemPrompt?: string;
  mcpConfigPath?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  resumeId?: string;
}): string[] {
  const args = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];
  if (input.resumeId) args.push("--resume", input.resumeId);
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  if (input.mcpConfigPath) args.push("--mcp-config", input.mcpConfigPath);
  if (input.systemPrompt) args.push("--append-system-prompt", input.systemPrompt);
  if (input.allowedTools && input.allowedTools.length > 0) args.push("--allowedTools", input.allowedTools.join(","));
  if (input.disallowedTools && input.disallowedTools.length > 0) args.push("--disallowedTools", input.disallowedTools.join(","));
  if (input.permissionMode) args.push("--permission-mode", input.permissionMode);
  return args;
}

export const CLAUDE_CAPABILITIES: CliCapabilities = {
  structuredEvents: true,
  resumableSessions: true,
  mcp: true,
  // Headless mode has no interactive approval channel: tool permissions are
  // decided up-front by --permission-mode / --allowedTools from host policy.
  toolApprovals: false,
  modelSelection: true,
  usageReporting: true,
  imageInput: true,
};

/** Claude Code via `claude -p --output-format stream-json --input-format stream-json`. */
export class ClaudeCodeAdapter extends ProcessCliAdapter<ClaudeParseState> {
  readonly id: string = "claude-code";

  protected override interactiveArgs(externalSessionId?: string, newSessionId?: string): string[] | undefined {
    if (externalSessionId) return ["--resume", externalSessionId];
    return newSessionId ? ["--session-id", newSessionId] : [];
  }
  protected override readonly extraInheritKeys: readonly string[] = [
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "AWS_REGION",
    "AWS_PROFILE",
    "CLOUD_ML_REGION",
    "ANTHROPIC_VERTEX_PROJECT_ID",
  ];

  constructor(options: ProcessAdapterOptions = {}) {
    super("claude", options);
  }

  async capabilities(): Promise<CliCapabilities> {
    return { ...CLAUDE_CAPABILITIES };
  }

  protected createState(): ClaudeParseState {
    return createClaudeParseState();
  }

  protected buildLaunch(rec: SessionRecord<ClaudeParseState>): LaunchSpec {
    const input = rec.input;
    const resumeId = "externalSessionId" in input ? input.externalSessionId : undefined;
    const args = buildClaudeArgs({
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.mcpConfigPath ? { mcpConfigPath: input.mcpConfigPath } : {}),
      ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
      ...(input.disallowedTools ? { disallowedTools: input.disallowedTools } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(resumeId ? { resumeId } : {}),
    });
    const prompt = input.prompt;
    return {
      args,
      ...(prompt ? { initialInput: claudeUserMessage(prompt) } : {}),
      initialTurns: prompt ? 1 : 0,
    };
  }

  protected parseLine(rec: SessionRecord<ClaudeParseState>, line: string): AgentEvent[] {
    return parseClaudeStreamLine(line, { ...rec.ctx, cwd: rec.session.cwd, adapterId: this.id }, rec.state);
  }

  protected override formatUserMessage(_rec: SessionRecord<ClaudeParseState>, text: string): string {
    return claudeUserMessage(text);
  }
}
