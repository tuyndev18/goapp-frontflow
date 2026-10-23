import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const isWin = process.platform === "win32";

function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
  if (!isWin) return env[key];
  const hit = Object.keys(env).find((k) => k.toUpperCase() === key.toUpperCase());
  return hit === undefined ? undefined : env[hit];
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves a command name to an absolute path using PATH (and PATHEXT on
 * Windows). Returns undefined when not found.
 */
export function resolveExecutable(
  command: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const exts = isWin
    ? (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase())
    : [""];
  const candidatesFor = (base: string): string[] => {
    if (!isWin) return [base];
    const hasExt = exts.includes(path.extname(base).toLowerCase());
    // Prefer real executables over shell scripts without extension (e.g. npm's sh shim).
    return hasExt ? [base] : exts.map((e) => base + e);
  };
  if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) {
    return candidatesFor(path.resolve(command)).find(isFile);
  }
  const dirs = (envValue(env, "PATH") ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of candidatesFor(path.join(dir.replace(/^"(.*)"$/, "$1"), command))) {
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface SpawnCommand {
  file: string;
  args: string[];
  /** Pre-escaped command line (Windows cmd.exe route only). */
  commandLine?: string;
  windowsVerbatimArguments?: boolean;
}

/**
 * Turns a resolved binary + args into something spawnable without a shell.
 * Windows npm `.cmd` shims are unwrapped to their target (`.exe` or node + `.js`);
 * any other `.cmd`/`.bat` goes through `cmd.exe /d /s /c` with strict escaping.
 */
export function toSpawnCommand(
  binaryPath: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
): SpawnCommand {
  const ext = path.extname(binaryPath).toLowerCase();
  if (!isWin || (ext !== ".cmd" && ext !== ".bat")) return { file: binaryPath, args };

  const unwrapped = unwrapNpmShim(binaryPath, env);
  if (unwrapped) return { file: unwrapped.file, args: [...unwrapped.prefixArgs, ...args] };

  const comspec = envValue(env, "COMSPEC") ?? "cmd.exe";
  const line = [escapeCmdCommand(binaryPath), ...args.map((a) => escapeCmdArgument(a, true))].join(" ");
  return {
    file: comspec,
    args: ["/d", "/s", "/c", `"${line}"`],
    commandLine: `/d /s /c "${line}"`,
    windowsVerbatimArguments: true,
  };
}

function unwrapNpmShim(
  shimPath: string,
  env: Record<string, string | undefined>,
): { file: string; prefixArgs: string[] } | undefined {
  let text: string;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return undefined;
  }
  const dir = path.dirname(shimPath);
  const targets = [...text.matchAll(/"%(?:~)?dp0%\\?([^"%]+)"/gi)].map((m) => m[1] ?? "");
  const target = targets.find((t) => /\.(exe|js|cjs|mjs)$/i.test(t) && !/^node\.exe$/i.test(t));
  if (!target) return undefined;
  const full = path.join(dir, target);
  if (!existsSync(full)) return undefined;
  if (/\.exe$/i.test(full)) return { file: full, prefixArgs: [] };
  const localNode = path.join(dir, "node.exe");
  const node = existsSync(localNode) ? localNode : resolveExecutable("node", env);
  if (!node) return undefined;
  return { file: node, prefixArgs: [full] };
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(cmd: string): string {
  return cmd.replace(CMD_META, "^$1");
}

/** cross-spawn compatible escaping for arguments passed through cmd.exe. */
export function escapeCmdArgument(arg: string, doubleEscapeMeta: boolean): string {
  let out = arg.replace(/(\\*)"/g, '$1$1\\"');
  out = out.replace(/(\\*)$/, "$1$1");
  out = `"${out}"`;
  out = out.replace(CMD_META, "^$1");
  if (doubleEscapeMeta) out = out.replace(CMD_META, "^$1");
  return out;
}
