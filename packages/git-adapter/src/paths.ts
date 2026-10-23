import fs from "node:fs";
import path from "node:path";

const isWin = process.platform === "win32";

/** Real path of `p`, resolving symlinks/8.3 names on the longest existing prefix. */
export function realOrResolved(p: string): string {
  let current = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function key(p: string): string {
  const r = realOrResolved(p);
  return isWin ? r.toLowerCase() : r;
}

export function samePath(a: string, b: string): boolean {
  return key(a) === key(b);
}

/** True when `child` is strictly below `parent` (after resolving symlinks). */
export function isStrictlyInside(child: string, parent: string): boolean {
  const rel = path.relative(key(parent), key(child));
  return rel !== "" && !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/** Converts a native relative path to forward slashes (git pathspec style). */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
