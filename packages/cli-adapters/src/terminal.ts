import { buildChildEnv } from "./process/env.js";
import { killProcessTree } from "./process/kill.js";
import { resolveExecutable, toSpawnCommand } from "./process/resolve.js";
import { loadNodePty, type PtyLoader, type PtyProcess } from "./process/runner.js";
import { AdapterError, type AiCliAdapter, type InteractiveLaunch } from "./types.js";

export interface OpenTerminalInput {
  terminalId: string;
  adapterId: string;
  /** Resume this CLI conversation interactively; omit for a fresh session. */
  externalSessionId?: string;
  /** Fresh session only: the conversation id to create, when the CLI supports choosing it. */
  newSessionId?: string;
  /** Start the CLI with exactly these arguments instead of its interactive defaults (workflow steps). */
  args?: string[];
  /** Extra environment for this launch (e.g. MCP credentials). */
  env?: Record<string, string>;
  cwd: string;
  cols: number;
  rows: number;
}

interface ResizablePty extends PtyProcess {
  resize?(cols: number, rows: number): void;
}

export interface TerminalManagerOptions {
  onData(terminalId: string, data: string): void;
  onExit(terminalId: string, exitCode: number | null): void;
  ptyLoader?: PtyLoader;
}

/**
 * Interactive terminals for human takeover (spec §3 "Human control remains
 * available"): the AI CLI runs in its normal TUI inside a PTY and the user
 * types into it directly, like a tmux pane. Output is streamed live and not
 * persisted. Workflow steps in interactive mode run here too, with `args`
 * set, and are followed through the CLI's transcript file.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, ResizablePty>();
  private readonly ptyLoader: PtyLoader;

  constructor(
    private readonly adapterOf: (adapterId: string) => AiCliAdapter | undefined,
    private readonly options: TerminalManagerOptions,
  ) {
    this.ptyLoader = options.ptyLoader ?? loadNodePty;
  }

  async open(input: OpenTerminalInput): Promise<{ terminalId: string; pid: number; command: string }> {
    if (this.terminals.has(input.terminalId)) throw new AdapterError("TERMINAL_ALREADY_OPEN", `Terminal ${input.terminalId} is already open`);
    const adapter = this.adapterOf(input.adapterId);
    const defaults: InteractiveLaunch | undefined = adapter?.interactiveLaunch?.({
      ...(input.externalSessionId ? { externalSessionId: input.externalSessionId } : {}),
      ...(input.newSessionId ? { newSessionId: input.newSessionId } : {}),
    });
    const launch: InteractiveLaunch | undefined =
      defaults && (input.args || input.env) ? { ...defaults, args: input.args ?? defaults.args, env: { ...defaults.env, ...input.env } } : defaults;
    if (!launch) throw new AdapterError("NOT_SUPPORTED", `${input.adapterId} has no interactive mode`);
    const pty = await this.ptyLoader();
    if (!pty) throw new AdapterError("PTY_UNAVAILABLE", "node-pty is not available on this machine");

    // Same allow-list as headless sessions: the minimal set plus the CLI's own config variables.
    // Unrelated parent secrets (cloud keys, registry tokens) never reach the agent's shell.
    const env = buildChildEnv({ inherit: "minimal", extraInheritKeys: launch.inheritKeys ?? [], env: launch.env ?? {} });
    env["TERM"] = "xterm-256color";
    env["COLORTERM"] = "truecolor";
    const binary = resolveExecutable(launch.command, env);
    if (!binary) throw new AdapterError("NOT_INSTALLED", `Executable not found: ${launch.command}`);
    const cmd = toSpawnCommand(binary, launch.args, env);

    const proc = pty.spawn(cmd.file, cmd.commandLine ?? cmd.args, {
      name: "xterm-256color",
      cols: clampSize(input.cols, 20, 400),
      rows: clampSize(input.rows, 5, 200),
      cwd: input.cwd,
      env,
    }) as ResizablePty;
    this.terminals.set(input.terminalId, proc);
    proc.onData((data) => this.options.onData(input.terminalId, data));
    proc.onExit(({ exitCode }) => {
      this.terminals.delete(input.terminalId);
      this.options.onExit(input.terminalId, exitCode);
    });
    return { terminalId: input.terminalId, pid: proc.pid, command: [launch.command, ...launch.args].join(" ") };
  }

  write(terminalId: string, data: string): void {
    this.get(terminalId).write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.get(terminalId).resize?.(clampSize(cols, 20, 400), clampSize(rows, 5, 200));
  }

  async close(terminalId: string): Promise<void> {
    const proc = this.terminals.get(terminalId);
    if (!proc) return;
    this.terminals.delete(terminalId);
    await killProcessTree(proc.pid).catch(() => proc.kill());
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.terminals.keys()].map((id) => this.close(id)));
  }

  private get(terminalId: string): ResizablePty {
    const proc = this.terminals.get(terminalId);
    if (!proc) throw new AdapterError("TERMINAL_NOT_FOUND", `Terminal ${terminalId} is not open`);
    return proc;
  }
}

function clampSize(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(n) ? n : min)));
}
