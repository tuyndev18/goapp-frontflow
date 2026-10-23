import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAgentEvent, type AgentEvent } from "@frontflow/event-schema";
import type { CliCapabilities, CliDetectionResult, InteractiveLaunch, InteractiveLaunchInput } from "../types.js";
import type { LaunchSpec, ProcessAdapterOptions, SessionRecord } from "./base.js";
import {
  CLAUDE_CAPABILITIES,
  ClaudeCodeAdapter,
  parseClaudeStreamLine,
  type ClaudeParseContext,
  type ClaudeParseState,
} from "./claude-code.js";

export const DEFAULT_FAKE_CLI_SCRIPT = fileURLToPath(
  new URL("../../../../tests/fixtures/fake-cli/fake-cli.mjs", import.meta.url),
);

/**
 * Claude stream-json parser plus the fake CLI's approval extension:
 * `{"type":"approval_request","request_id","action","tool_name"}`.
 */
export function parseFakeCliLine(line: string, ctx: ClaudeParseContext, state: ClaudeParseState): AgentEvent[] {
  const trimmed = line.trim();
  if (trimmed.startsWith('{"type":"approval_request"')) {
    try {
      const msg = JSON.parse(trimmed) as { request_id?: string; action?: string; tool_name?: string };
      if (typeof msg.request_id === "string") {
        const { cwd: _cwd, adapterId: _a, ...eventCtx } = ctx;
        return [
          createAgentEvent("approval.required", eventCtx, {
            requestId: msg.request_id,
            action: msg.action ?? msg.tool_name ?? "tool",
            ...(msg.tool_name === "Write" ? { permissionClass: "write_project" } : {}),
          }),
          createAgentEvent("status.changed", eventCtx, { status: "waiting_approval", detail: msg.action }),
        ];
      }
    } catch {
      return [];
    }
  }
  return parseClaudeStreamLine(line, ctx, state);
}

export function fakeApprovalResponse(requestId: string, approved: boolean): string {
  return `${JSON.stringify({ type: "approval_response", request_id: requestId, approved })}\n`;
}

export interface FakeCliAdapterOptions extends Omit<ProcessAdapterOptions, "binary"> {
  scriptPath?: string;
  /** Env merged into every session (e.g. FAKE_CLI_STATE_DIR, FAKE_CLI_SCENARIO). */
  sessionEnv?: Record<string, string>;
}

/** Runs the fake CLI fixture through the real Claude stream-json pipeline. */
export class FakeCliAdapter extends ClaudeCodeAdapter {
  override readonly id: string = "fake";
  protected override readonly versionArgs: string[];
  private readonly scriptPath: string;
  private readonly sessionEnv: Record<string, string>;

  constructor(options: FakeCliAdapterOptions = {}) {
    const { scriptPath, sessionEnv, ...rest } = options;
    super({ ...rest, binary: process.execPath });
    this.scriptPath = scriptPath ?? DEFAULT_FAKE_CLI_SCRIPT;
    this.sessionEnv = sessionEnv ?? {};
    this.versionArgs = [this.scriptPath, "--version"];
  }

  override interactiveLaunch(input: InteractiveLaunchInput): InteractiveLaunch {
    // Electron in node mode cannot read a ConPTY stdin on Windows, so the interactive fake uses the system node.
    return {
      command: process.versions.electron ? "node" : process.execPath,
      args: [this.scriptPath, "--interactive", ...(input.externalSessionId ? ["--resume", input.externalSessionId] : [])],
      env: { ...this.sessionEnv },
    };
  }

  override async detect(): Promise<CliDetectionResult> {
    if (!existsSync(this.scriptPath)) return { installed: false, error: `fake CLI script missing: ${this.scriptPath}` };
    return super.detect();
  }

  override async capabilities(): Promise<CliCapabilities> {
    return { ...CLAUDE_CAPABILITIES, toolApprovals: true };
  }

  protected override buildLaunch(rec: SessionRecord<ClaudeParseState>): LaunchSpec {
    const spec = super.buildLaunch(rec) as LaunchSpec;
    return {
      ...spec,
      args: [this.scriptPath, ...spec.args],
      env: {
        ...this.sessionEnv,
        ...(spec.env ?? {}),
        ...(rec.input.env ?? {}),
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
    };
  }

  protected override parseLine(rec: SessionRecord<ClaudeParseState>, line: string): AgentEvent[] {
    return parseFakeCliLine(line, { ...rec.ctx, cwd: rec.session.cwd, adapterId: this.id }, rec.state);
  }

  protected override formatApproval(_rec: SessionRecord<ClaudeParseState>, requestId: string, approved: boolean): string {
    return fakeApprovalResponse(requestId, approved);
  }
}
