import { spawn } from "node:child_process";
import { newId } from "@frontflow/domain";
import { createAgentEvent, redactString } from "@frontflow/event-schema";
import { killProcessTree } from "@frontflow/cli-adapters";
import { NodeError, type NodeExecutionContext } from "@frontflow/workflow-engine";
import type { NodeServices } from "./services.js";

const MAX_CAPTURE = 1_000_000;

export interface CommandOutcome {
  command: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunCommandOptions {
  command: string;
  cwd: string;
  projectRoot: string;
  activeRoot?: string;
  knownScripts: string[];
  timeoutMs: number;
  label: string;
}

/**
 * Runs a project command after the policy engine allowed it (spec §22.3).
 * Commands outside the project profile need explicit approval unless the
 * user enabled arbitrary shell commands; destructive ones always do.
 */
export async function runProjectCommand(ctx: NodeExecutionContext, services: NodeServices, options: RunCommandOptions): Promise<CommandOutcome> {
  await authorizeCommand(ctx, services, options);

  const commandId = newId("cmd");
  const eventCtx = { traceId: ctx.traceId, workflowRunId: ctx.runId, nodeRunId: ctx.nodeRunId };
  ctx.log("info", `${options.label}: running \`${options.command}\``);
  ctx.emit(createAgentEvent("command.started", eventCtx, { commandId, command: options.command, cwd: options.cwd }));
  const started = Date.now();
  const stream = new OutputStreamer((text) => ctx.log("debug", text, { kind: "output", commandId }));

  const outcome = await new Promise<CommandOutcome>((resolve) => {
    const child = spawn(options.command, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
      env: commandEnv(),
      detached: process.platform !== "win32",
    });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (output.length < MAX_CAPTURE) output += text;
      stream.push(text);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const stop = () => {
      if (child.pid) void killProcessTree(child.pid);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    ctx.signal.addEventListener("abort", stop, { once: true });
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      stream.close();
      ctx.signal.removeEventListener("abort", stop);
      resolve({ command: options.command, exitCode, output: redactString(output), durationMs: Date.now() - started, timedOut });
    };
    child.on("error", (err) => {
      output += `\n${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });

  ctx.emit(
    createAgentEvent("command.completed", eventCtx, {
      commandId,
      command: options.command,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
    }),
  );
  if (ctx.signal.aborted) throw new NodeError("CANCELLED", `${options.label} was interrupted`);
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  if (outcome.exitCode === 0 && !outcome.timedOut) ctx.log("info", `${options.label}: passed in ${seconds}s`);
  else ctx.log("warn", `${options.label}: ${outcome.timedOut ? "timed out" : `exit code ${outcome.exitCode}`} after ${seconds}s`);
  return outcome;
}

const STREAM_FLUSH_MS = 400;
const STREAM_MAX_LINES = 1500;

/** Batches live command output into log events so the UI can follow long builds without an event per byte. */
class OutputStreamer {
  private buffer = "";
  private lines = 0;
  private truncated = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly emit: (text: string) => void) {}

  push(text: string): void {
    if (this.truncated) return;
    this.buffer += text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
    this.timer ??= setTimeout(() => this.flush(), STREAM_FLUSH_MS);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.flush();
  }

  private flush(): void {
    this.timer = undefined;
    if (!this.buffer || this.truncated) return;
    let text = redactString(this.buffer.replace(/\r\n/g, "\n").replace(/\n$/, ""));
    this.buffer = "";
    const count = text.split("\n").length;
    if (this.lines + count > STREAM_MAX_LINES) {
      text = `${text.split("\n").slice(0, Math.max(0, STREAM_MAX_LINES - this.lines)).join("\n")}\n… output truncated in the live view (full log is saved as evidence)`;
      this.truncated = true;
    }
    this.lines += count;
    if (text.trim()) this.emit(text);
  }
}

async function authorizeCommand(ctx: NodeExecutionContext, services: NodeServices, options: RunCommandOptions): Promise<void> {
  const decision = services.policy.evaluate({
    permission: "run_project_command",
    action: options.label,
    command: options.command,
    projectRoot: options.projectRoot,
    ...(options.activeRoot ? { activeRoot: options.activeRoot } : {}),
    path: options.cwd,
    knownScripts: options.knownScripts,
    source: "system",
  });
  if (decision.effect === "allow") return;
  if (decision.effect === "deny") throw new NodeError("PERMISSION_DENIED", decision.reason);
  ctx.log("warn", `Approval required to run "${options.command}": ${decision.reason}`);
  const { promise } = services.approvals.request({
    permission: "run_project_command",
    action: `Run ${options.command}`,
    detail: `${options.label} in ${options.cwd}\n${decision.reason}`,
    source: "system",
  });
  const outcome = await promise;
  if (outcome !== "approved") throw new NodeError("PERMISSION_DENIED", `Command ${options.command} was ${outcome}`);
}

function commandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", FORCE_COLOR: "0" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("FRONTFLOW_") || key === "ELECTRON_RUN_AS_NODE") delete env[key];
  }
  return env;
}

export interface TestSummary {
  passed: number;
  failed: number;
  skipped: number;
  parsed: boolean;
}

/** Extracts pass/fail counts from vitest, jest, playwright or JSON-line summaries. */
export function parseTestSummary(output: string): TestSummary {
  for (const line of output.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.includes('"passed"')) {
      try {
        const json = JSON.parse(trimmed) as { passed?: number; failed?: number; skipped?: number };
        return { passed: json.passed ?? 0, failed: json.failed ?? 0, skipped: json.skipped ?? 0, parsed: true };
      } catch {
        // not JSON after all
      }
    }
  }
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
  const testsLine = clean.match(/^\s*Tests:?\s+(.+)$/im)?.[1];
  const scope = testsLine ?? clean;
  const count = (re: RegExp) => {
    const m = scope.match(re);
    return m ? Number(m[1]) : 0;
  };
  const passed = count(/(\d+)\s+passed/i);
  const failed = count(/(\d+)\s+failed/i);
  const skipped = count(/(\d+)\s+(?:skipped|todo|pending)/i);
  return { passed, failed, skipped, parsed: passed + failed + skipped > 0 };
}

export function tail(text: string, max = 4000): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}
