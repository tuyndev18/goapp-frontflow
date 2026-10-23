import { createAgentEvent, type AgentEvent, type AgentEventOf, type EventContext } from "@frontflow/event-schema";
import type { ProcessExit } from "../process/runner.js";
import type { CliCapabilities, ResumeSessionInput, StartSessionInput } from "../types.js";
import { ProcessCliAdapter, type LaunchKind, type LaunchSpec, type ProcessAdapterOptions, type SessionRecord } from "./base.js";

/** Confidence levels for events inferred from terminal text (spec §16.4). */
export const PTY_CONFIDENCE = {
  toolMarker: 0.7,
  command: 0.6,
  approval: 0.6,
  error: 0.5,
  text: 0.3,
} as const;

export interface PtyParseState {
  approvalSeq: number;
  /** Prompt text of the approval currently awaiting a user decision (dedupes TUI redraws). */
  pendingApprovalText?: string;
  commandSeq: number;
  toolSeq: number;
}

export function createPtyParseState(): PtyParseState {
  return { approvalSeq: 0, commandSeq: 0, toolSeq: 0 };
}

// CSI, OSC and single-char escape sequences.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

const FILE_TOOL_NAMES = /^(WriteFile|Write|Edit|EditFile|Replace|MultiEdit|CreateFile|DeleteFile)$/;
const TOOL_OK = /^\s*[✔✓√]\s+([A-Za-z][\w.-]*)\s*(.*)$/u;
const TOOL_FAIL = /^\s*[✗✘✖x×]\s+([A-Z][\w.-]*)\s*(.*)$/u;
const RUNNING = /^\s*(?:Running|Executing|Shell)(?: command)?:\s+(.+)$/i;
const ERROR_LINE = /^\s*(?:Error|ERROR|Fatal|FATAL)\b[:!]?\s*(.*)$/;
const APPROVAL =
  /(\(y\/n\)|\[y\/N\]|\[Y\/n\]|allow (?:execution|this|once)|do you want to (?:proceed|allow|make this edit|run)|apply (?:this )?change\?|approve\?|waiting for (?:user )?(?:confirmation|approval))/i;

export interface PtyParseContext extends EventContext {
  cwd: string;
}

/**
 * Maps one line of terminal output to inferred events. Every event carries
 * `confidence` < 1. Approval prompts become `approval.required` only — they
 * are never answered automatically (spec §16.4 rule 5).
 */
export function parsePtyLine(rawLine: string, ctx: PtyParseContext, state: PtyParseState): AgentEvent[] {
  // Carriage returns redraw the same row: keep only the last visible segment.
  const segment = rawLine.split("\r").filter((s) => stripAnsi(s).trim()).pop() ?? "";
  const line = stripAnsi(segment).replace(/\s+$/, "");
  if (!line.trim()) return [];
  const { cwd, ...eventCtx } = ctx;
  const ev = <T extends AgentEvent["type"]>(
    type: T,
    payload: AgentEventOf<T>["payload"],
    confidence: number,
  ) => createAgentEvent<T>(type, eventCtx, payload, confidence);

  if (APPROVAL.test(line)) {
    const text = line.trim();
    if (state.pendingApprovalText === text) return [];
    state.pendingApprovalText = text;
    state.approvalSeq += 1;
    const requestId = `pty_approval_${state.approvalSeq}`;
    return [
      ev("approval.required", { requestId, action: text, detail: "Detected from terminal output" }, PTY_CONFIDENCE.approval),
      ev("status.changed", { status: "waiting_approval", detail: text }, PTY_CONFIDENCE.approval),
    ];
  }

  const ok = TOOL_OK.exec(line);
  const fail = ok ? null : TOOL_FAIL.exec(line);
  const toolMatch = ok ?? fail;
  if (toolMatch) {
    const name = toolMatch[1] ?? "unknown";
    const arg = (toolMatch[2] ?? "").trim();
    state.toolSeq += 1;
    const toolCallId = `pty_tool_${state.toolSeq}`;
    const out: AgentEvent[] = [
      ev("tool.started", { toolCallId, name, input: arg ? { arg } : undefined }, PTY_CONFIDENCE.toolMarker),
      ev("tool.completed", { toolCallId, name, ok: Boolean(ok) }, PTY_CONFIDENCE.toolMarker),
    ];
    if (ok && FILE_TOOL_NAMES.test(name) && arg) {
      const filePath = arg.split(/\s+/)[0] ?? arg;
      const change = /^Delete/.test(name) ? "deleted" : /^(WriteFile|Write|CreateFile)$/.test(name) ? "created" : "modified";
      out.push(ev("file.changed", { path: filePath.replace(/\\/g, "/"), change }, PTY_CONFIDENCE.toolMarker * 0.8));
    }
    return out;
  }

  const running = RUNNING.exec(line);
  if (running) {
    state.commandSeq += 1;
    return [
      ev(
        "command.started",
        { commandId: `pty_cmd_${state.commandSeq}`, command: (running[1] ?? "").trim(), cwd },
        PTY_CONFIDENCE.command,
      ),
    ];
  }

  if (ERROR_LINE.test(line)) {
    return [ev("message.delta", { role: "system", text: line.trim() }, PTY_CONFIDENCE.error)];
  }

  return [ev("message.delta", { role: "assistant", text: line }, PTY_CONFIDENCE.text)];
}

export interface PtyFallbackConfig {
  id: string;
  binary: string;
  /** argv for start/resume; return `promptViaInput: true` semantics via `promptVia`. */
  buildArgs(input: StartSessionInput | ResumeSessionInput, kind: LaunchKind): string[];
  /** "argv": prompt is part of buildArgs; "input": typed into the terminal after spawn. */
  promptVia: "argv" | "input";
  /** Keystrokes sent only when the user explicitly approves/rejects. */
  approveKeys?: string;
  rejectKeys?: string;
  capabilities?: Partial<CliCapabilities>;
  extraInheritKeys?: readonly string[];
  versionArgs?: string[];
}

const PTY_BASE_CAPABILITIES: CliCapabilities = {
  structuredEvents: false,
  resumableSessions: false,
  mcp: false,
  toolApprovals: true,
  modelSelection: false,
  usageReporting: false,
  imageInput: false,
};

/** Generic adapter for CLIs without structured output: runs in a PTY and infers events from text. */
export class PtyFallbackAdapter extends ProcessCliAdapter<PtyParseState> {
  readonly id: string;
  protected override readonly versionArgs: string[];
  protected override readonly extraInheritKeys: readonly string[];

  constructor(
    protected readonly config: PtyFallbackConfig,
    options: ProcessAdapterOptions = {},
  ) {
    super(config.binary, options);
    this.id = config.id;
    this.versionArgs = config.versionArgs ?? ["--version"];
    this.extraInheritKeys = config.extraInheritKeys ?? [];
  }

  async capabilities(): Promise<CliCapabilities> {
    return { ...PTY_BASE_CAPABILITIES, ...this.config.capabilities };
  }

  protected createState(): PtyParseState {
    return createPtyParseState();
  }

  protected buildLaunch(rec: SessionRecord<PtyParseState>): LaunchSpec {
    const args = this.config.buildArgs(rec.input, rec.kind);
    const prompt = rec.input.prompt;
    return {
      args,
      usePty: true,
      ...(this.config.promptVia === "input" && prompt ? { initialInput: `${prompt}\r` } : {}),
      initialTurns: 0,
    };
  }

  protected override initialEvents(rec: SessionRecord<PtyParseState>): AgentEvent[] {
    return [
      this.event(rec, "session.started", { adapterId: this.id, cwd: rec.session.cwd }),
      this.event(rec, "status.changed", { status: "thinking" }),
    ];
  }

  protected parseLine(rec: SessionRecord<PtyParseState>, line: string): AgentEvent[] {
    return parsePtyLine(line, { ...rec.ctx, cwd: rec.session.cwd }, rec.state);
  }

  protected override formatUserMessage(_rec: SessionRecord<PtyParseState>, text: string): string {
    return `${text}\r`;
  }

  protected override formatApproval(rec: SessionRecord<PtyParseState>, _requestId: string, approved: boolean): string {
    rec.state.pendingApprovalText = undefined;
    return approved ? (this.config.approveKeys ?? "y\r") : (this.config.rejectKeys ?? "n\r");
  }

  protected override exitEvent(rec: SessionRecord<PtyParseState>, exit: ProcessExit): AgentEvent {
    if (exit.exitCode === 0 || (rec.closing && exit.killed)) {
      return this.event(rec, "session.completed", { exitCode: exit.exitCode }, PTY_CONFIDENCE.command);
    }
    return super.exitEvent(rec, exit);
  }
}

const GEMINI_APPROVAL_MODES = new Set(["default", "auto_edit", "yolo"]);

/**
 * Gemini CLI through the PTY fallback (`gemini -p <prompt>`). `permissionMode`
 * maps to `--approval-mode`. Approval keystrokes target its confirmation menu
 * (Enter = first option "allow once", Esc = cancel).
 */
export class GeminiCliAdapter extends PtyFallbackAdapter {
  protected override interactiveArgs(): string[] | undefined {
    return [];
  }

  constructor(options: ProcessAdapterOptions = {}) {
    super(
      {
        id: "gemini",
        binary: "gemini",
        promptVia: "argv",
        approveKeys: "\r",
        rejectKeys: "\x1b",
        extraInheritKeys: ["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_GENAI_USE_VERTEXAI"],
        capabilities: { mcp: true, modelSelection: true },
        buildArgs: (input) => {
          const args: string[] = [];
          if (input.model) args.push("--model", input.model);
          if (input.permissionMode && GEMINI_APPROVAL_MODES.has(input.permissionMode)) {
            args.push("--approval-mode", input.permissionMode);
          }
          if (input.allowedTools?.length) args.push("--allowed-tools", input.allowedTools.join(","));
          if (input.prompt) args.push("--prompt", input.prompt);
          return args;
        },
      },
      options,
    );
  }
}
