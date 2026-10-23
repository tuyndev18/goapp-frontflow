import { spawn } from "node:child_process";
import { AdapterError } from "../types.js";
import { buildChildEnv, secretValuesOf, type InheritEnv } from "./env.js";
import { killProcessTree } from "./kill.js";
import { resolveExecutable, toSpawnCommand } from "./resolve.js";
import { RawStreamRedactor } from "./streams.js";

export type OutputStream = "stdout" | "stderr" | "pty";

export interface ProcessRunOptions {
  /** Command name (resolved via PATH/PATHEXT) or absolute path. */
  command: string;
  args?: string[];
  cwd: string;
  /** Explicit env (secrets belong here, never in args). */
  env?: Record<string, string>;
  inheritEnv?: InheritEnv;
  extraInheritKeys?: readonly string[];
  usePty?: boolean;
  cols?: number;
  rows?: number;
  timeoutMs?: number;
  /** Unredacted output for in-process parsers. */
  onData?: (chunk: string, stream: OutputStream) => void;
  /** Redacted output for raw log sinks. */
  onRaw?: (chunk: string, stream: OutputStream) => void;
  /** Extra literal values to redact from raw output. */
  knownSecrets?: string[];
}

export interface ProcessExit {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  killed: boolean;
  error?: string;
}

export interface RunningProcess {
  readonly pid: number | undefined;
  readonly mode: "pty" | "pipe";
  readonly running: boolean;
  readonly exited: Promise<ProcessExit>;
  write(data: string): void;
  /** Closes stdin (no-op for PTY sessions). */
  endInput(): void;
  /** Kills the whole process tree; resolves once the process has exited. */
  kill(): Promise<ProcessExit>;
}

/** Minimal shape of the node-pty module we rely on. */
export interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: { name?: string; cols?: number; rows?: number; cwd?: string; env?: Record<string, string> },
  ): PtyProcess;
}
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  kill(signal?: string): void;
}

export type PtyLoader = () => Promise<PtyModule | undefined>;

let cachedPty: Promise<PtyModule | undefined> | undefined;

/** Lazily loads node-pty (optional dependency); undefined when unavailable. */
export const loadNodePty: PtyLoader = () => {
  cachedPty ??= (async () => {
    try {
      const name = "node-pty";
      const mod = (await import(/* @vite-ignore */ name)) as { default?: PtyModule } & Partial<PtyModule>;
      const api = typeof mod.spawn === "function" ? (mod as PtyModule) : mod.default;
      return api && typeof api.spawn === "function" ? api : undefined;
    } catch {
      return undefined;
    }
  })();
  return cachedPty;
};

export interface ProcessRunnerOptions {
  ptyLoader?: PtyLoader;
}

export interface CapturedRun extends ProcessExit {
  stdout: string;
  stderr: string;
}

export class ProcessRunner {
  private readonly ptyLoader: PtyLoader;

  constructor(options: ProcessRunnerOptions = {}) {
    this.ptyLoader = options.ptyLoader ?? loadNodePty;
  }

  async start(options: ProcessRunOptions): Promise<RunningProcess> {
    const env = buildChildEnv({
      inherit: options.inheritEnv ?? "minimal",
      ...(options.extraInheritKeys ? { extraInheritKeys: options.extraInheritKeys } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    const binary = resolveExecutable(options.command, env);
    if (!binary) throw new AdapterError("NOT_INSTALLED", `Executable not found: ${options.command}`);
    const cmd = toSpawnCommand(binary, options.args ?? [], env);
    const secrets = [...secretValuesOf(options.env), ...(options.knownSecrets ?? [])];

    const redactors = new Map<OutputStream, RawStreamRedactor>();
    const onRaw = options.onRaw;
    const emit = (chunk: string, stream: OutputStream): void => {
      options.onData?.(chunk, stream);
      if (!onRaw) return;
      let r = redactors.get(stream);
      if (!r) {
        r = new RawStreamRedactor((text) => onRaw(text, stream), secrets);
        redactors.set(stream, r);
      }
      r.push(chunk);
    };
    const flushRaw = (): void => {
      for (const r of redactors.values()) r.flush();
    };

    if (options.usePty) {
      const pty = await this.ptyLoader();
      if (pty) return startPty(pty, cmd, options, env, emit, flushRaw);
    }
    return startPiped(cmd, options, env, emit, flushRaw);
  }

  /** Runs to completion and captures output (used for `--version` probes). */
  async run(options: ProcessRunOptions & { input?: string }): Promise<CapturedRun> {
    let stdout = "";
    let stderr = "";
    const proc = await this.start({
      ...options,
      onData: (chunk, stream) => {
        if (stream === "stderr") stderr += chunk;
        else stdout += chunk;
        options.onData?.(chunk, stream);
      },
    });
    if (options.input !== undefined) proc.write(options.input);
    proc.endInput();
    const exit = await proc.exited;
    return { ...exit, stdout, stderr };
  }
}

type Emit = (chunk: string, stream: OutputStream) => void;

function startPiped(
  cmd: ReturnType<typeof toSpawnCommand>,
  options: ProcessRunOptions,
  env: Record<string, string>,
  emit: Emit,
  flushRaw: () => void,
): RunningProcess {
  const child = spawn(cmd.file, cmd.args, {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: cmd.windowsVerbatimArguments ?? false,
    detached: process.platform !== "win32",
  });
  let running = true;
  let timedOut = false;
  let killed = false;
  let spawnError: string | undefined;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => emit(c, "stdout"));
  child.stderr.on("data", (c: string) => emit(c, "stderr"));
  child.stdin.on("error", () => undefined);

  const exited = new Promise<ProcessExit>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      running = false;
      if (timer) clearTimeout(timer);
      flushRaw();
      resolve({
        exitCode: code,
        signal,
        timedOut,
        killed,
        ...(spawnError ? { error: spawnError } : {}),
      });
    };
    child.once("error", (err) => {
      spawnError = err.message;
      finish(null, null);
    });
    child.once("close", (code, signal) => finish(code, signal));
  });

  const kill = async (): Promise<ProcessExit> => {
    if (running && child.pid !== undefined) {
      killed = true;
      await killProcessTree(child.pid);
    }
    return exited;
  };

  const timer =
    options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          void kill();
        }, options.timeoutMs)
      : undefined;

  return {
    get pid() {
      return child.pid;
    },
    mode: "pipe",
    get running() {
      return running;
    },
    exited,
    write(data) {
      if (running && child.stdin.writable) child.stdin.write(data);
    },
    endInput() {
      if (child.stdin.writable) child.stdin.end();
    },
    kill,
  };
}

function startPty(
  pty: PtyModule,
  cmd: ReturnType<typeof toSpawnCommand>,
  options: ProcessRunOptions,
  env: Record<string, string>,
  emit: Emit,
  flushRaw: () => void,
): RunningProcess {
  const proc = pty.spawn(cmd.file, cmd.commandLine ?? cmd.args, {
    name: "xterm-256color",
    cols: options.cols ?? 160,
    rows: options.rows ?? 48,
    cwd: options.cwd,
    env,
  });
  let running = true;
  let timedOut = false;
  let killed = false;
  proc.onData((d) => emit(d, "pty"));

  const exited = new Promise<ProcessExit>((resolve) => {
    proc.onExit(({ exitCode, signal }) => {
      // ConPTY may deliver trailing output just after the exit notification.
      setTimeout(() => {
        running = false;
        if (timer) clearTimeout(timer);
        flushRaw();
        resolve({ exitCode, signal: signal ? String(signal) : null, timedOut, killed });
      }, 60);
    });
  });

  const kill = async (): Promise<ProcessExit> => {
    if (running) {
      killed = true;
      await killProcessTree(proc.pid);
      try {
        proc.kill();
      } catch {
        // already gone
      }
    }
    return exited;
  };

  const timer =
    options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          void kill();
        }, options.timeoutMs)
      : undefined;

  return {
    pid: proc.pid,
    mode: "pty",
    get running() {
      return running;
    },
    exited,
    write(data) {
      if (running) proc.write(data);
    },
    endInput() {
      // PTY has no separate stdin to close.
    },
    kill,
  };
}
