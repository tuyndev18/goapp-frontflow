import path from "node:path";
import { createAgentEvent, type AgentEvent, type AgentEventOf, type EventContext } from "@frontflow/event-schema";
import type { CliCapabilities } from "../types.js";
import { ProcessCliAdapter, type LaunchSpec, type ProcessAdapterOptions, type SessionRecord } from "./base.js";

export interface CodexParseContext extends EventContext {
  cwd: string;
  adapterId?: string;
}

export interface CodexParseState {
  threadId?: string;
  lastAgentMessage?: string;
  lastError?: string;
  commandStarts: Map<string, number>;
  startedItems: Set<string>;
}

export function createCodexParseState(): CodexParseState {
  return { commandStarts: new Map(), startedItems: new Set() };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const CHANGE_KIND: Record<string, "created" | "modified" | "deleted"> = {
  add: "created",
  create: "created",
  update: "modified",
  modify: "modified",
  delete: "deleted",
  remove: "deleted",
};

function relPath(p: string, cwd: string): string {
  const rel = path.isAbsolute(p) ? path.relative(cwd, p) || p : p;
  return rel.split(path.sep).join("/");
}

/**
 * Pure mapping of one `codex exec --json` JSONL line to normalized events.
 * `turn.completed` closes the turn (usage + session.completed); `turn.failed`
 * fails it. Top-level `error` lines are reported as status (often transient).
 */
export function parseCodexJsonLine(line: string, ctx: CodexParseContext, state: CodexParseState): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return [];
  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!isObj(msg)) return [];
  const { cwd, adapterId = "codex", ...eventCtx } = ctx;
  const ev = <T extends AgentEvent["type"]>(type: T, payload: AgentEventOf<T>["payload"]) =>
    createAgentEvent<T>(type, eventCtx, payload);
  const out: AgentEvent[] = [];

  switch (msg.type) {
    case "thread.started": {
      const threadId = str(msg.thread_id);
      if (threadId) state.threadId = threadId;
      out.push(ev("session.started", { adapterId, cwd, ...(threadId ? { externalSessionId: threadId } : {}) }));
      break;
    }
    case "turn.started":
      out.push(ev("status.changed", { status: "thinking" }));
      break;
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = isObj(msg.item) ? msg.item : undefined;
      if (item) out.push(...mapItem(msg.type, item, cwd, state, ev));
      break;
    }
    case "turn.completed": {
      const usage = isObj(msg.usage) ? msg.usage : {};
      // Codex input_tokens already include cached_input_tokens, and output includes reasoning.
      const input = num(usage.input_tokens);
      const output = num(usage.output_tokens);
      const cached = num(usage.cached_input_tokens);
      out.push(
        ev("usage.updated", {
          ...(input !== undefined ? { inputTokens: input } : {}),
          ...(output !== undefined ? { outputTokens: output } : {}),
          ...(cached ? { cacheReadTokens: cached } : {}),
          scope: "turn",
        }),
        ev("session.completed", {
          ...(state.threadId ? { externalSessionId: state.threadId } : {}),
          ...(state.lastAgentMessage !== undefined ? { result: state.lastAgentMessage } : {}),
        }),
      );
      break;
    }
    case "turn.failed": {
      const err = isObj(msg.error) ? str(msg.error.message) : str(msg.message);
      out.push(ev("session.failed", { code: "TURN_FAILED", message: err ?? state.lastError ?? "turn failed" }));
      break;
    }
    case "error": {
      const message = str(msg.message) ?? "error";
      state.lastError = message;
      out.push(ev("status.changed", { status: "thinking", detail: `error: ${message}` }));
      break;
    }
    default:
      break;
  }
  return out;
}

type Ev = <T extends AgentEvent["type"]>(type: T, payload: AgentEventOf<T>["payload"]) => AgentEvent;

function mapItem(phase: string, item: Json, cwd: string, state: CodexParseState, ev: Ev): AgentEvent[] {
  if (phase === "item.updated") return [];
  const id = str(item.id) ?? `item_${state.startedItems.size}`;
  const type = str(item.type) ?? "unknown";
  const done = phase === "item.completed";
  // Some items only appear as item.completed: synthesize their start.
  const needStart = phase === "item.started" || !state.startedItems.has(id);
  if (done) state.startedItems.delete(id);
  else state.startedItems.add(id);
  const out: AgentEvent[] = [];

  switch (type) {
    case "agent_message": {
      if (done) {
        const text = str(item.text) ?? "";
        state.lastAgentMessage = text;
        if (text) out.push(ev("message.delta", { role: "assistant", text }));
      }
      break;
    }
    case "reasoning": {
      const text = str(item.text);
      if (done) out.push(ev("status.changed", { status: "thinking", ...(text ? { detail: text.slice(0, 200) } : {}) }));
      break;
    }
    case "command_execution": {
      const command = str(item.command) ?? "";
      if (needStart) {
        state.commandStarts.set(id, Date.now());
        out.push(
          ev("tool.started", { toolCallId: id, name: "command_execution", input: { command } }),
          ev("status.changed", { status: "running_tool", detail: "command_execution" }),
          ev("command.started", { commandId: id, command, cwd }),
        );
      }
      if (done) {
        const exitCode = num(item.exit_code) ?? null;
        const startedAt = state.commandStarts.get(id);
        state.commandStarts.delete(id);
        const ok = item.status !== "failed" && (exitCode === null || exitCode === 0);
        out.push(
          ev("command.completed", {
            commandId: id,
            command,
            exitCode,
            ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {}),
          }),
          ev("tool.completed", {
            toolCallId: id,
            name: "command_execution",
            ok,
            output: (str(item.aggregated_output) ?? "").slice(0, 4000),
          }),
        );
      }
      break;
    }
    case "file_change": {
      if (needStart) out.push(ev("tool.started", { toolCallId: id, name: "file_change", input: item.changes }));
      if (done) {
        const ok = item.status !== "failed";
        out.push(ev("tool.completed", { toolCallId: id, name: "file_change", ok }));
        if (ok && Array.isArray(item.changes)) {
          for (const c of item.changes) {
            if (!isObj(c) || typeof c.path !== "string") continue;
            out.push(
              ev("file.changed", { path: relPath(c.path, cwd), change: CHANGE_KIND[str(c.kind) ?? ""] ?? "modified" }),
            );
          }
        }
      }
      break;
    }
    case "mcp_tool_call": {
      const name = `mcp:${str(item.server) ?? "?"}/${str(item.tool) ?? "?"}`;
      if (needStart) {
        out.push(
          ev("tool.started", { toolCallId: id, name, input: item.arguments }),
          ev("status.changed", { status: "running_tool", detail: name }),
        );
      }
      if (done) {
        const ok = item.status !== "failed" && !item.error;
        out.push(ev("tool.completed", { toolCallId: id, name, ok, output: item.error ?? item.result }));
      }
      break;
    }
    case "web_search": {
      if (needStart) out.push(ev("tool.started", { toolCallId: id, name: "web_search", input: { query: item.query } }));
      if (done) out.push(ev("tool.completed", { toolCallId: id, name: "web_search", ok: true }));
      break;
    }
    case "error": {
      if (done) {
        const message = str(item.message) ?? "error";
        state.lastError = message;
        out.push(ev("status.changed", { status: "thinking", detail: `error: ${message}` }));
      }
      break;
    }
    default:
      break;
  }
  return out;
}

export function buildCodexArgs(input: {
  cwd: string;
  model?: string;
  sandbox?: string;
  resumeId?: string;
  configOverrides?: string[];
}): string[] {
  const args = ["exec", "--json", "--skip-git-repo-check", "-C", input.cwd];
  if (input.model) args.push("--model", input.model);
  if (input.sandbox) args.push("--sandbox", input.sandbox);
  for (const c of input.configOverrides ?? []) args.push("-c", c);
  if (input.resumeId) args.push("resume", input.resumeId);
  args.push("-");
  return args;
}

const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);

export const CODEX_CAPABILITIES: CliCapabilities = {
  structuredEvents: true,
  resumableSessions: true,
  mcp: true,
  toolApprovals: false,
  modelSelection: true,
  usageReporting: true,
  imageInput: true,
};

/**
 * OpenAI Codex CLI via `codex exec --json` (one turn per process; follow-ups
 * go through resume). `permissionMode` maps to `--sandbox`.
 */
export class CodexCliAdapter extends ProcessCliAdapter<CodexParseState> {
  readonly id: string = "codex";

  protected override interactiveArgs(externalSessionId?: string): string[] | undefined {
    return externalSessionId ? ["resume", externalSessionId] : [];
  }
  protected override readonly extraInheritKeys: readonly string[] = ["CODEX_HOME", "OPENAI_BASE_URL"];

  constructor(options: ProcessAdapterOptions = {}) {
    super("codex", options);
  }

  async capabilities(): Promise<CliCapabilities> {
    return { ...CODEX_CAPABILITIES };
  }

  protected createState(): CodexParseState {
    return createCodexParseState();
  }

  protected buildLaunch(rec: SessionRecord<CodexParseState>): LaunchSpec {
    const input = rec.input;
    const resumeId = "externalSessionId" in input ? input.externalSessionId : undefined;
    const sandbox = input.permissionMode && SANDBOX_MODES.has(input.permissionMode) ? input.permissionMode : undefined;
    const args = buildCodexArgs({
      cwd: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(resumeId ? { resumeId } : {}),
      ...(input.systemPrompt ? { configOverrides: [`developer_instructions=${JSON.stringify(input.systemPrompt)}`] } : {}),
    });
    return {
      args,
      initialInput: input.prompt ?? "",
      closeInputAfterInitial: true,
      initialTurns: 1,
    };
  }

  protected parseLine(rec: SessionRecord<CodexParseState>, line: string): AgentEvent[] {
    return parseCodexJsonLine(line, { ...rec.ctx, cwd: rec.session.cwd, adapterId: this.id }, rec.state);
  }
}
