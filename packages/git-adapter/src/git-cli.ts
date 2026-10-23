import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type GitErrorCode =
  | "GIT_NOT_FOUND"
  | "NOT_A_REPO"
  | "TIMEOUT"
  | "COMMAND_FAILED"
  | "INVALID_ARGUMENT";

export class GitError extends Error {
  override readonly name = "GitError";
  constructor(
    readonly code: GitErrorCode,
    message: string,
    readonly details: { args?: string[]; exitCode?: number | null; stderr?: string; cwd?: string } = {},
  ) {
    super(message);
  }

  get stderr(): string {
    return this.details.stderr ?? "";
  }
}

export interface GitCliOptions {
  gitBinary?: string;
  /** Per-command timeout. Default 60s. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface GitRunOptions {
  /** Exit codes treated as success (default [0]). */
  okExitCodes?: number[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type StatusEntryKind = "changed" | "untracked" | "renamed" | "conflicted" | "ignored";

export interface StatusEntry {
  path: string;
  origPath?: string;
  /** Two-letter porcelain XY code ("??" for untracked). */
  xy: string;
  kind: StatusEntryKind;
  staged: boolean;
  unstaged: boolean;
}

export interface StatusResult {
  branch: {
    oid: string | null;
    head: string | null;
    detached: boolean;
    upstream?: string;
    ahead?: number;
    behind?: number;
  };
  entries: StatusEntry[];
  clean: boolean;
}

export type DiffChange = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange" | "unmerged" | "unknown";

export interface DiffFile {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
  change: DiffChange;
}

export interface DiffOptions {
  from?: string;
  to?: string;
  paths?: string[];
  staged?: boolean;
  /**
   * Include untracked (non-ignored) files when diffing against the working tree.
   * Uses a throwaway index file, so the real index is never touched.
   */
  includeUntracked?: boolean;
}

export interface DiffResult {
  patch: string;
  files: DiffFile[];
}

const MAX_BUFFER = 256 * 1024 * 1024;

export class GitCli {
  readonly cwd: string;
  private readonly gitBinary: string;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv | undefined;

  constructor(cwd: string, options: GitCliOptions = {}) {
    this.cwd = path.resolve(cwd);
    this.gitBinary = options.gitBinary ?? "git";
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.env = options.env;
  }

  /** Runs git with the given argument vector (no shell). */
  run(args: string[], options: GitRunOptions = {}): Promise<GitRunResult> {
    const fullArgs = ["-c", "core.quotepath=false", "-c", "color.ui=false", ...args];
    const ok = options.okExitCodes ?? [0];
    return new Promise((resolve, reject) => {
      execFile(
        this.gitBinary,
        fullArgs,
        {
          cwd: this.cwd,
          timeout: options.timeoutMs ?? this.timeoutMs,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
          encoding: "utf8",
          env: { ...process.env, ...this.env, ...options.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ stdout, stderr, exitCode: 0 });
          const err = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string };
          const details = { args, stderr, cwd: this.cwd, exitCode: typeof err.code === "number" ? err.code : null };
          if (err.code === "ENOENT") {
            return reject(new GitError("GIT_NOT_FOUND", `git binary not found: ${this.gitBinary}`, details));
          }
          if (err.killed || err.signal === "SIGTERM") {
            return reject(new GitError("TIMEOUT", `git ${args[0] ?? ""} timed out`, details));
          }
          if (typeof err.code === "number" && ok.includes(err.code)) {
            return resolve({ stdout, stderr, exitCode: err.code });
          }
          const code: GitErrorCode = /not a git repository/i.test(stderr) ? "NOT_A_REPO" : "COMMAND_FAILED";
          reject(new GitError(code, `git ${args.join(" ")} failed: ${stderr.trim() || err.message}`, details));
        },
      );
    });
  }

  async isRepo(): Promise<boolean> {
    try {
      const { stdout } = await this.run(["rev-parse", "--is-inside-work-tree"]);
      return stdout.trim() === "true";
    } catch (err) {
      if (err instanceof GitError && err.code === "GIT_NOT_FOUND") throw err;
      return false;
    }
  }

  async topLevel(): Promise<string> {
    const { stdout } = await this.run(["rev-parse", "--show-toplevel"]);
    return path.resolve(stdout.trim());
  }

  /** Short branch name, or null when HEAD is detached. */
  async currentBranch(): Promise<string | null> {
    const { stdout, exitCode } = await this.run(["symbolic-ref", "--quiet", "--short", "HEAD"], { okExitCodes: [0, 1] });
    return exitCode === 0 ? stdout.trim() || null : null;
  }

  async headSha(): Promise<string> {
    const { stdout } = await this.run(["rev-parse", "--verify", "HEAD^{commit}"]);
    return stdout.trim();
  }

  async revParse(rev: string): Promise<string> {
    assertRev(rev);
    const { stdout } = await this.run(["rev-parse", "--verify", `${rev}^{commit}`]);
    return stdout.trim();
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    assertRev(ancestor);
    assertRev(descendant);
    const { exitCode } = await this.run(["merge-base", "--is-ancestor", ancestor, descendant], { okExitCodes: [0, 1] });
    return exitCode === 0;
  }

  async commitExists(sha: string): Promise<boolean> {
    assertRev(sha);
    const { exitCode } = await this.run(["cat-file", "-e", `${sha}^{commit}`], { okExitCodes: [0, 1, 128] });
    return exitCode === 0;
  }

  /** Absolute path of a file inside the git dir (e.g. "index", "MERGE_HEAD"). */
  async gitPath(name: string): Promise<string> {
    const { stdout } = await this.run(["rev-parse", "--git-path", name]);
    return path.resolve(this.cwd, stdout.trim());
  }

  async status(): Promise<StatusResult> {
    const { stdout } = await this.run(["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]);
    return parseStatus(stdout);
  }

  async diff(options: DiffOptions = {}): Promise<DiffResult> {
    if (options.from) assertRev(options.from);
    if (options.to) assertRev(options.to);
    const useTempIndex = Boolean(options.includeUntracked && !options.staged && !options.to);
    let env: NodeJS.ProcessEnv | undefined;
    let tempIndex: string | undefined;
    if (useTempIndex) {
      tempIndex = path.join(os.tmpdir(), `frontflow-index-${randomUUID()}`);
      const realIndex = await this.gitPath("index");
      if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tempIndex);
      env = { GIT_INDEX_FILE: tempIndex };
      await this.run(["add", "-A", "--", "."], { env });
    }
    try {
      const base = ["diff", "--no-color", "--no-ext-diff", "--find-renames"];
      if (useTempIndex) {
        base.push("--cached", options.from ?? "HEAD");
      } else if (options.staged) {
        base.push("--cached");
        if (options.from) base.push(options.from);
      } else {
        if (options.from) base.push(options.from);
        if (options.to) base.push(options.to);
      }
      const tail = ["--", ...(options.paths ?? [])];
      const [numstat, nameStatus, patch] = await Promise.all([
        this.run([...base, "--numstat", "-z", ...tail], { ...(env ? { env } : {}) }),
        this.run([...base, "--name-status", "-z", ...tail], { ...(env ? { env } : {}) }),
        this.run([...base, ...tail], { ...(env ? { env } : {}) }),
      ]);
      return { patch: patch.stdout, files: mergeDiffFiles(parseNameStatus(nameStatus.stdout), parseNumstat(numstat.stdout)) };
    } finally {
      if (tempIndex) fs.rmSync(tempIndex, { force: true });
    }
  }

}

function assertRev(rev: string): void {
  if (!rev || rev.startsWith("-") || /[\s\0]/.test(rev)) {
    throw new GitError("INVALID_ARGUMENT", `invalid revision: ${JSON.stringify(rev)}`);
  }
}

export function parseStatus(raw: string): StatusResult {
  const records = raw.split("\0");
  const branch: StatusResult["branch"] = { oid: null, head: null, detached: false };
  const entries: StatusEntry[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    if (rec.startsWith("# ")) {
      const [, key, ...rest] = rec.split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") branch.oid = value === "(initial)" ? null : value;
      else if (key === "branch.head") {
        branch.detached = value === "(detached)";
        branch.head = branch.detached ? null : value;
      } else if (key === "branch.upstream") branch.upstream = value;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          branch.ahead = Number(m[1]);
          branch.behind = Number(m[2]);
        }
      }
      continue;
    }
    const type = rec[0];
    if (type === "?" || type === "!") {
      entries.push({
        path: rec.slice(2),
        xy: type === "?" ? "??" : "!!",
        kind: type === "?" ? "untracked" : "ignored",
        staged: false,
        unstaged: type === "?",
      });
      continue;
    }
    const fieldCount = type === "1" ? 8 : type === "2" ? 9 : type === "u" ? 10 : -1;
    if (fieldCount < 0) continue;
    const parts = splitN(rec, " ", fieldCount);
    const xy = parts[1] ?? "..";
    const p = parts[fieldCount] ?? "";
    const entry: StatusEntry = {
      path: p,
      xy,
      kind: type === "u" ? "conflicted" : type === "2" ? "renamed" : "changed",
      staged: xy[0] !== ".",
      unstaged: xy[1] !== ".",
    };
    if (type === "2") {
      const orig = records[++i];
      if (orig) entry.origPath = orig;
    }
    entries.push(entry);
  }
  return { branch, entries, clean: entries.every((e) => e.kind === "ignored") };
}

/** Splits into at most n+1 parts, keeping the remainder (paths may contain spaces). */
function splitN(s: string, sep: string, n: number): string[] {
  const out: string[] = [];
  let rest = s;
  for (let k = 0; k < n; k++) {
    const idx = rest.indexOf(sep);
    if (idx < 0) break;
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
  }
  out.push(rest);
  return out;
}

const CHANGE_MAP: Record<string, DiffChange> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
  U: "unmerged",
};

function parseNameStatus(raw: string): DiffFile[] {
  const tokens = raw.split("\0");
  const files: DiffFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (!status) continue;
    const letter = status[0] ?? "X";
    const change = CHANGE_MAP[letter] ?? "unknown";
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[++i] ?? "";
      const newPath = tokens[++i] ?? "";
      files.push({ path: newPath, oldPath, additions: 0, deletions: 0, binary: false, change });
    } else {
      files.push({ path: tokens[++i] ?? "", additions: 0, deletions: 0, binary: false, change });
    }
  }
  return files;
}

interface NumstatEntry {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

function parseNumstat(raw: string): NumstatEntry[] {
  const tokens = raw.split("\0");
  const out: NumstatEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const [add = "", del = "", p = ""] = tok.split("\t");
    let filePath = p;
    if (filePath === "") {
      // Rename/copy with -z: "add\tdel\t\0old\0new"
      i++;
      filePath = tokens[++i] ?? "";
    }
    const binary = add === "-" && del === "-";
    out.push({ path: filePath, additions: binary ? 0 : Number(add), deletions: binary ? 0 : Number(del), binary });
  }
  return out;
}

function mergeDiffFiles(files: DiffFile[], stats: NumstatEntry[]): DiffFile[] {
  const byPath = new Map(stats.map((s) => [s.path, s]));
  return files.map((f) => {
    const s = byPath.get(f.path);
    return s ? { ...f, additions: s.additions, deletions: s.deletions, binary: s.binary } : f;
  });
}
