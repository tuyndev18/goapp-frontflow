import fs from "node:fs";
import path from "node:path";

const isWin = process.platform === "win32";

function normalizeForCompare(p: string, caseInsensitive: boolean): string {
  const resolved = path.resolve(p);
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}

/**
 * Lexical containment check: true when `child` equals `parent` or lies below it.
 * Both paths are resolved first; comparison is case-insensitive on Windows.
 * Use {@link resolveRealPath} first when symlinks must not be able to escape.
 */
export function isPathInside(child: string, parent: string, options: { caseInsensitive?: boolean } = {}): boolean {
  const ci = options.caseInsensitive ?? isWin;
  const c = normalizeForCompare(child, ci);
  const p = normalizeForCompare(parent, ci);
  if (c === p) return true;
  const rel = path.relative(p, c);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false; // different drive / root
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/**
 * Resolves symlinks for the longest existing prefix of `target` and re-appends
 * the not-yet-existing tail, so new files are validated against the real
 * location of their parent directory.
 */
export function resolveRealPath(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** Rejects path syntax that should never reach the filesystem layer. */
export function suspiciousPathReason(raw: string): string | undefined {
  if (raw.includes("\0")) return "path contains a NUL byte";
  if (isWin || /^[a-zA-Z]:[\\/]/.test(raw)) {
    if (/^\\\\[?.]\\/.test(raw)) return "device/namespace paths are not allowed";
    // Alternate data streams: a colon anywhere except the drive designator.
    if (raw.slice(/^[a-zA-Z]:/.test(raw) ? 2 : 0).includes(":")) return "alternate data stream syntax is not allowed";
  }
  return undefined;
}

export interface ContainmentResult {
  inside: boolean;
  resolved: string;
  reason?: string;
}

/** Resolves `raw` (relative to `base`) through symlinks and checks it stays within `root`. */
export function checkContainment(raw: string, base: string, root: string): ContainmentResult {
  const bad = suspiciousPathReason(raw);
  if (bad) return { inside: false, resolved: raw, reason: bad };
  const lexical = path.resolve(base, raw);
  const realRoot = resolveRealPath(root);
  if (!isPathInside(lexical, path.resolve(root)) && !isPathInside(lexical, realRoot)) {
    return { inside: false, resolved: lexical, reason: `path escapes ${root}` };
  }
  const real = resolveRealPath(lexical);
  if (!isPathInside(real, realRoot)) {
    return { inside: false, resolved: real, reason: `path resolves outside ${root} (symlink or junction escape)` };
  }
  return { inside: true, resolved: real };
}
