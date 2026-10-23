import fs from "node:fs";
import path from "node:path";

const MAX_TEXT_BYTES = 1024 * 1024;

/** Read-only, cached view of a project directory. All paths are POSIX-style and relative to the root. */
export class ProjectFs {
  private readonly dirCache = new Map<string, fs.Dirent[]>();

  constructor(readonly root: string) {}

  abs(rel: string): string {
    return rel ? path.join(this.root, ...rel.split("/")) : this.root;
  }

  entries(relDir = ""): fs.Dirent[] {
    const cached = this.dirCache.get(relDir);
    if (cached) return cached;
    let list: fs.Dirent[] = [];
    try {
      list = fs.readdirSync(this.abs(relDir), { withFileTypes: true });
    } catch {
      list = [];
    }
    this.dirCache.set(relDir, list);
    return list;
  }

  private stat(rel: string): fs.Stats | undefined {
    try {
      return fs.statSync(this.abs(rel));
    } catch {
      return undefined;
    }
  }

  isFile(rel: string): boolean {
    return this.stat(rel)?.isFile() ?? false;
  }

  isDir(rel: string): boolean {
    return this.stat(rel)?.isDirectory() ?? false;
  }

  exists(rel: string): boolean {
    return this.stat(rel) !== undefined;
  }

  readText(rel: string, maxBytes = MAX_TEXT_BYTES): string | undefined {
    const st = this.stat(rel);
    if (!st?.isFile() || st.size > maxBytes) return undefined;
    try {
      return fs.readFileSync(this.abs(rel), "utf8");
    } catch {
      return undefined;
    }
  }

  readJson(rel: string): { value?: unknown; error?: string } {
    const text = this.readText(rel);
    if (text === undefined) return {};
    try {
      return { value: JSON.parse(text.replace(/^﻿/, "")) };
    } catch (err) {
      return { error: `${rel} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** Files (not dirs) in `relDir` whose name matches `pattern`, as relative paths. */
  filesMatching(relDir: string, pattern: RegExp): string[] {
    return this.entries(relDir)
      .filter((e) => e.isFile() && pattern.test(e.name))
      .map((e) => join(relDir, e.name))
      .sort();
  }

  subdirs(relDir: string): string[] {
    return this.entries(relDir)
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => join(relDir, e.name))
      .sort();
  }

  /** Bounded recursive walk returning relative file paths. */
  walk(relDir: string, options: { maxFiles: number; maxDepth: number; include: RegExp }): string[] {
    const out: string[] = [];
    const visit = (dir: string, depth: number) => {
      if (out.length >= options.maxFiles || depth > options.maxDepth) return;
      for (const e of this.entries(dir)) {
        if (out.length >= options.maxFiles) return;
        if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === "build") continue;
        const rel = join(dir, e.name);
        if (e.isDirectory()) visit(rel, depth + 1);
        else if (e.isFile() && options.include.test(e.name)) out.push(rel);
      }
    };
    visit(relDir, 0);
    return out;
  }
}

export function join(...parts: string[]): string {
  return parts.filter((p) => p !== "").join("/");
}
