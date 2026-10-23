import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { newId, sha256, type ArtifactKind, type RetentionPolicy, type SourceSnapshot } from "@frontflow/domain";
import { redactString } from "@frontflow/event-schema";
import type { FrontflowDb } from "./database.js";
import type { StoredArtifact } from "./repositories/artifacts.js";

export interface ArtifactStoreOptions {
  /** `{appData}/goapp-frontflow` */
  rootDir: string;
  db: FrontflowDb;
  /** Raw PTY/stdout logging (spec §21.2). Default true. */
  rawLogs?: boolean;
  /** Age after which raw log files are pruned by applyRetention. Default 7. */
  rawLogRetentionDays?: number;
  /** Redact raw log chunks before appending. Default true. */
  redactRawLogs?: boolean;
  /** Extra literal secrets to scrub (e.g. values held in the credential vault). */
  knownSecrets?: () => readonly string[];
}

export interface WriteArtifactInput {
  projectId: string;
  runId?: string;
  nodeRunId?: string;
  kind: ArtifactKind;
  /** Display name; sanitized to a safe file name. */
  name: string;
  content: string | Uint8Array;
  mimeType: string;
  source: string;
  /** Default: run_lifetime when runId is set, otherwise keep. */
  retentionPolicy?: RetentionPolicy;
  /** Text content is redacted unless explicitly false (DoD #12). */
  redact?: boolean;
}

export interface AppendLogInput {
  projectId?: string;
  sessionId?: string;
  runId?: string;
  /** e.g. "pty", "stdout", "stderr". */
  stream?: string;
  chunk: string;
}

export class ArtifactPathError extends Error {
  override name = "ArtifactPathError";
}
export class ArtifactNotFoundError extends Error {
  override name = "ArtifactNotFoundError";
}
export class ArtifactIntegrityError extends Error {
  override name = "ArtifactIntegrityError";
}

const KIND_DIRS: Record<ArtifactKind, string> = {
  document: "documents",
  prompt: "prompts",
  log: "logs",
  diff: "diffs",
  screenshot: "screenshots",
  test_result: "test-results",
  evidence: "evidence",
  package: "documents",
  figma_snapshot: "documents",
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const RAW_LOG_SUFFIX = ".raw.log";
const DAY_MS = 86_400_000;

/**
 * Filesystem artifact storage (spec §18.2). SQLite holds metadata; content lives under rootDir:
 * projects/{projectId}/{snapshots|runs/{runId}/{documents|prompts|logs|diffs|screenshots|test-results|evidence}|sessions}/, logs/.
 */
export class ArtifactStore {
  readonly rootDir: string;
  private readonly db: FrontflowDb;
  private readonly rawLogs: boolean;
  private readonly rawLogRetentionDays: number;
  private readonly redactRawLogs: boolean;
  private readonly knownSecrets: () => readonly string[];

  constructor(options: ArtifactStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    this.db = options.db;
    this.rawLogs = options.rawLogs ?? true;
    this.rawLogRetentionDays = options.rawLogRetentionDays ?? 7;
    this.redactRawLogs = options.redactRawLogs ?? true;
    this.knownSecrets = options.knownSecrets ?? (() => []);
    mkdirSync(this.rootDir, { recursive: true });
  }

  write(input: WriteArtifactInput): StoredArtifact {
    const projectId = safeId(input.projectId, "projectId");
    const runId = input.runId === undefined ? undefined : safeId(input.runId, "runId");
    const id = newId("art");
    const name = sanitizeName(input.name);
    const dir = runId
      ? `projects/${projectId}/runs/${runId}/${KIND_DIRS[input.kind]}`
      : `projects/${projectId}/${input.kind === "figma_snapshot" ? "snapshots" : KIND_DIRS[input.kind]}`;
    const relativePath = `${dir}/${id}-${name}`;

    const shouldRedact = input.redact !== false && isTextMime(input.mimeType);
    const bytes = shouldRedact
      ? Buffer.from(this.redact(typeof input.content === "string" ? input.content : Buffer.from(input.content).toString("utf8")), "utf8")
      : typeof input.content === "string"
        ? Buffer.from(input.content, "utf8")
        : Buffer.from(input.content);

    const record: StoredArtifact = {
      id,
      projectId,
      ...(runId !== undefined ? { workflowRunId: runId } : {}),
      ...(input.nodeRunId !== undefined ? { nodeRunId: input.nodeRunId } : {}),
      kind: input.kind,
      name,
      relativePath,
      contentHash: sha256(bytes),
      mimeType: input.mimeType,
      source: input.source,
      sizeBytes: bytes.byteLength,
      createdAt: new Date().toISOString(),
      retentionPolicy: input.retentionPolicy ?? (runId ? "run_lifetime" : "keep"),
    };
    const fullPath = this.resolvePath(relativePath);
    writeAtomic(fullPath, bytes);
    try {
      this.db.artifacts.insert(record);
    } catch (err) {
      tryUnlink(fullPath);
      throw err;
    }
    return record;
  }

  /** Reads content and verifies it against the recorded hash. */
  read(id: string): { record: StoredArtifact; content: Uint8Array } {
    const record = this.db.artifacts.get(id);
    if (!record) throw new ArtifactNotFoundError(`Artifact ${id} not found`);
    const content = readFileSync(this.resolvePath(record));
    if (sha256(content) !== record.contentHash) {
      throw new ArtifactIntegrityError(`Artifact ${id} content does not match its recorded hash`);
    }
    return { record, content: new Uint8Array(content.buffer, content.byteOffset, content.byteLength) };
  }

  readText(id: string): string {
    return Buffer.from(this.read(id).content).toString("utf8");
  }

  /** Absolute path for a record or root-relative path; throws if it would escape rootDir. */
  resolvePath(target: { relativePath: string } | string): string {
    const rel = typeof target === "string" ? target : target.relativePath;
    if (!rel || rel.includes("\0") || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
      throw new ArtifactPathError(`Invalid artifact path: ${JSON.stringify(rel)}`);
    }
    const full = resolve(this.rootDir, rel);
    const back = relative(this.rootDir, full);
    if (!back || back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
      throw new ArtifactPathError(`Artifact path escapes the storage root: ${JSON.stringify(rel)}`);
    }
    return full;
  }

  /**
   * Appends a raw PTY/stdout chunk. Returns the root-relative log path, or undefined when raw
   * logging is disabled. Redaction is per chunk: a secret split across chunks may survive.
   */
  appendLog(input: AppendLogInput): string | undefined {
    if (!this.rawLogs) return undefined;
    const stream = sanitizeName(input.stream ?? "pty").replace(/\./g, "_");
    let dir: string;
    if (input.projectId !== undefined && input.sessionId !== undefined) {
      dir = `projects/${safeId(input.projectId, "projectId")}/sessions/${safeId(input.sessionId, "sessionId")}`;
    } else if (input.projectId !== undefined && input.runId !== undefined) {
      dir = `projects/${safeId(input.projectId, "projectId")}/runs/${safeId(input.runId, "runId")}/logs`;
    } else {
      const scope = input.sessionId ?? input.runId;
      dir = scope === undefined ? "logs" : `logs/${safeId(scope, "sessionId")}`;
    }
    const relativePath = `${dir}/${stream}${RAW_LOG_SUFFIX}`;
    const fullPath = this.resolvePath(relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    appendFileSync(fullPath, this.redactRawLogs ? this.redact(input.chunk) : input.chunk, "utf8");
    return relativePath;
  }

  /**
   * Deletes artifacts whose retention expired (days_7 / days_30 by age; run_lifetime once the run
   * row is deleted; keep never) and prunes raw logs older than rawLogRetentionDays.
   * Returns the removed artifact ids.
   */
  applyRetention(now: Date | string = new Date()): string[] {
    const nowDate = typeof now === "string" ? new Date(now) : now;
    const removed: string[] = [];
    for (const record of this.db.artifacts.listExpired(nowDate.toISOString())) {
      const fullPath = this.resolvePath(record);
      tryUnlink(fullPath);
      this.db.artifacts.remove(record.id);
      this.pruneEmptyDirs(dirname(fullPath));
      removed.push(record.id);
    }
    this.pruneRawLogs(nowDate);
    return removed;
  }

  /** Deletes raw log files last modified before the raw-log retention window. Returns removed relative paths. */
  pruneRawLogs(now: Date = new Date()): string[] {
    const cutoff = now.getTime() - this.rawLogRetentionDays * DAY_MS;
    const removed: string[] = [];
    for (const base of ["projects", "logs"]) {
      const baseDir = join(this.rootDir, base);
      if (!existsSync(baseDir)) continue;
      for (const entry of readdirSync(baseDir, { recursive: true, encoding: "utf8" })) {
        if (!entry.endsWith(RAW_LOG_SUFFIX)) continue;
        const full = join(baseDir, entry);
        const stat = statSync(full, { throwIfNoEntry: false });
        if (stat?.isFile() && stat.mtimeMs < cutoff) {
          tryUnlink(full);
          removed.push(relative(this.rootDir, full).split(sep).join("/"));
        }
      }
    }
    return removed;
  }

  /**
   * Stores immutable snapshot content as projects/{projectId}/snapshots/{contentHash}.{ext} and records
   * the snapshot row. Content is kept verbatim (not redacted) so it always matches snapshot.contentHash.
   */
  saveSnapshotContent(
    projectId: string,
    snapshot: SourceSnapshot,
    text: string,
    options: { sourceDocumentId?: string } = {},
  ): { relativePath: string; inserted: boolean } {
    const pid = safeId(projectId, "projectId");
    const bytes = Buffer.from(text, "utf8");
    const hash = sha256(bytes);
    if (hash !== snapshot.contentHash) {
      throw new ArtifactIntegrityError(`Snapshot ${snapshot.id} contentHash does not match its content`);
    }
    const relativePath = `projects/${pid}/snapshots/${hash}.${snapshotExtension(snapshot.type)}`;
    const fullPath = this.resolvePath(relativePath);
    if (existsSync(fullPath)) {
      if (sha256(readFileSync(fullPath)) !== hash) {
        throw new ArtifactIntegrityError(`Stored snapshot content at ${relativePath} was modified`);
      }
    } else {
      writeAtomic(fullPath, bytes);
    }
    const inserted = this.db.snapshots.insert(pid, snapshot, {
      contentPath: relativePath,
      ...(options.sourceDocumentId !== undefined ? { sourceDocumentId: options.sourceDocumentId } : {}),
    });
    return { relativePath, inserted };
  }

  readSnapshotContent(snapshotId: string): string {
    const rec = this.db.snapshots.getRecord(snapshotId);
    if (!rec?.contentPath) throw new ArtifactNotFoundError(`Snapshot ${snapshotId} has no stored content`);
    const bytes = readFileSync(this.resolvePath(rec.contentPath));
    if (sha256(bytes) !== rec.snapshot.contentHash) {
      throw new ArtifactIntegrityError(`Snapshot ${snapshotId} content does not match its hash`);
    }
    return bytes.toString("utf8");
  }

  /** Removes the project row (cascading metadata) and all of its files. */
  removeProject(projectId: string): void {
    const dir = this.resolvePath(`projects/${safeId(projectId, "projectId")}`);
    this.db.projects.remove(projectId);
    rmSync(dir, { recursive: true, force: true });
  }

  private redact(text: string): string {
    return redactString(text, { knownSecrets: [...this.knownSecrets()] });
  }

  private pruneEmptyDirs(dir: string): void {
    const stop = join(this.rootDir, "projects");
    let current = dir;
    while (current.startsWith(stop + sep) && dirname(current) !== stop) {
      try {
        rmdirSync(current);
      } catch {
        return;
      }
      current = dirname(current);
    }
  }
}

export function isTextMime(mimeType: string): boolean {
  const mime = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  return (
    mime.startsWith("text/") ||
    mime.includes("markdown") ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime === "application/x-ndjson" ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/yaml" ||
    mime === "application/x-yaml" ||
    mime === "application/javascript" ||
    mime === "application/typescript"
  );
}

/** Reduces an arbitrary display name to a single safe path segment. */
export function sanitizeName(name: string): string {
  const base = name.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[.\s_-]+/, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, 100);
  return cleaned || "artifact";
}

function safeId(value: string, label: string): string {
  if (!SAFE_ID.test(value) || value.includes("..")) {
    throw new ArtifactPathError(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function snapshotExtension(type: SourceSnapshot["type"]): string {
  switch (type) {
    case "ba_markdown":
    case "api_markdown":
      return "md";
    case "figma":
      return "json";
    default:
      return "txt";
  }
}

function writeAtomic(fullPath: string, bytes: Uint8Array): void {
  mkdirSync(dirname(fullPath), { recursive: true });
  const tmp = `${fullPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, bytes, { flag: "wx" });
  try {
    renameSync(tmp, fullPath);
  } catch (err) {
    tryUnlink(tmp);
    throw err;
  }
}

function tryUnlink(fullPath: string): void {
  try {
    unlinkSync(fullPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
