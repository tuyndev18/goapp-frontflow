import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export class AccountFsError extends Error {
  constructor(
    readonly code: "SYMLINK_REFUSED" | "LOCKED" | "MALFORMED" | "WRITE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "AccountFsError";
  }
}

/** Credential paths must be regular files: a symlink there could redirect a write (spec §4.12). */
export function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new AccountFsError("SYMLINK_REFUSED", `Refusing to use symlinked path ${path}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/** Parsed JSON object, undefined when the file does not exist; throws MALFORMED otherwise. */
export function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  assertNotSymlink(path);
  const text = readFileSync(path, "utf8");
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AccountFsError("MALFORMED", `${path} is not a JSON object`);
}

export function mtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Temp file in the same directory (exclusive create, owner-only mode), fsync, then rename over
 * the target. Windows can refuse the rename while another process has the file open: retried briefly.
 */
export function atomicWriteFile(path: string, data: string, mode = 0o600): void {
  assertNotSymlink(path);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      renameSync(tmp, path);
      if (process.platform !== "win32") fsyncDir(dirname(path));
      return;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
      sleepSync(50);
    }
  }
  try {
    unlinkSync(tmp);
  } catch {
    // already gone
  }
  throw new AccountFsError("WRITE_FAILED", `Could not replace ${path}: ${(lastError as Error)?.message ?? lastError}`);
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not supported everywhere; the rename itself is atomic.
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface DirLockOptions {
  timeoutMs?: number;
  /** A lock untouched for this long belongs to a crashed holder and is taken over. */
  staleMs?: number;
  /** How often the holder refreshes the lock's mtime so others don't think it stale. */
  touchMs?: number;
}

/**
 * Cross-process lock in the `proper-lockfile` style Claude Code uses: a directory created
 * exclusively, its mtime kept fresh while held, taken over when stale. Takeovers are
 * serialized through a sibling `.takeover` directory so two waiters never both break it.
 */
export async function acquireDirLock(lockDir: string, options: DirLockOptions = {}): Promise<() => void> {
  const timeoutMs = options.timeoutMs ?? 9_000;
  const staleMs = options.staleMs ?? 30_000;
  const started = Date.now();
  mkdirSync(dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = Date.now() - (mtimeMs(lockDir) ?? Date.now());
      if (age > staleMs && takeOver(lockDir)) continue;
      if (Date.now() - started > timeoutMs) throw new AccountFsError("LOCKED", `Lock ${lockDir} is held by another process`);
      await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
    }
  }
  const toucher = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lockDir, now, now);
    } catch {
      // lost: release below tolerates it
    }
  }, options.touchMs ?? 3_000);
  toucher.unref?.();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(toucher);
    rmSync(lockDir, { recursive: true, force: true });
  };
}

function takeOver(lockDir: string): boolean {
  const guard = `${lockDir}.takeover`;
  try {
    mkdirSync(guard);
  } catch {
    // Another waiter is taking over; a guard left by a crash expires after 5 s.
    if (Date.now() - (mtimeMs(guard) ?? Date.now()) > 5_000) rmSync(guard, { recursive: true, force: true });
    return false;
  }
  try {
    rmSync(lockDir, { recursive: true, force: true });
    return true;
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}

/** Runs `fn` holding the lock. Never hold one across network calls. */
export async function withLock<T>(lockDir: string, fn: () => Promise<T> | T, options: DirLockOptions = {}): Promise<T> {
  const release = await acquireDirLock(lockDir, { timeoutMs: 10_000, ...options });
  try {
    return await fn();
  } finally {
    release();
  }
}
