import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256, type SourceSnapshot } from "@frontflow/domain";
import {
  ArtifactIntegrityError,
  ArtifactPathError,
  ArtifactStore,
  InMemoryCredentialVault,
  openDatabase,
  sanitizeName,
  type FrontflowDb,
} from "../src/index.js";
import { makeTempDir, seedProjectAndRun } from "./helpers.js";

describe("ArtifactStore", () => {
  let tmp: ReturnType<typeof makeTempDir>;
  let db: FrontflowDb;
  let store: ArtifactStore;
  beforeEach(() => {
    tmp = makeTempDir();
    db = openDatabase(join(tmp.dir, "database.sqlite"));
    seedProjectAndRun(db);
    store = new ArtifactStore({ rootDir: tmp.dir, db });
  });
  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("writes into the spec layout with hash, size and metadata, and reads back", () => {
    const rec = store.write({
      projectId: "proj_1",
      runId: "run_1",
      nodeRunId: "nr_1",
      kind: "test_result",
      name: "junit report.xml",
      content: "<testsuite tests='1'/>",
      mimeType: "application/xml",
      source: "vitest",
    });
    expect(rec.relativePath).toMatch(/^projects\/proj_1\/runs\/run_1\/test-results\/art_[a-z0-9]+-junit_report\.xml$/);
    expect(rec.contentHash).toBe(sha256("<testsuite tests='1'/>"));
    expect(rec.sizeBytes).toBe(22);
    expect(rec.retentionPolicy).toBe("run_lifetime");
    expect(db.artifacts.get(rec.id)).toEqual(rec);
    expect(store.readText(rec.id)).toBe("<testsuite tests='1'/>");
    expect(db.artifacts.listByRun("run_1", "test_result").map((a) => a.id)).toEqual([rec.id]);
    expect(db.artifacts.listByNode("nr_1").map((a) => a.id)).toEqual([rec.id]);
  });

  it("stores binary content verbatim", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    const rec = store.write({ projectId: "proj_1", runId: "run_1", kind: "screenshot", name: "shot.png", content: png, mimeType: "image/png", source: "playwright" });
    expect(rec.relativePath).toContain("/runs/run_1/screenshots/");
    expect(Array.from(store.read(rec.id).content)).toEqual(Array.from(png));
    expect(rec.contentHash).toBe(sha256(png));
  });

  it("redacts text artifacts by default, including vault secrets, unless redact:false", () => {
    const vault = new InMemoryCredentialVault();
    void vault.set("figma", "pairing-code-XYZ");
    const s = new ArtifactStore({ rootDir: tmp.dir, db, knownSecrets: () => vault.knownSecrets() });
    const secretText = "Authorization: Bearer abc.def.ghi\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345\ncode pairing-code-XYZ";
    const rec = s.write({ projectId: "proj_1", runId: "run_1", kind: "prompt", name: "prompt.md", content: secretText, mimeType: "text/markdown", source: "engine" });
    const stored = readFileSync(s.resolvePath(rec), "utf8");
    expect(stored).not.toContain("abc.def.ghi");
    expect(stored).not.toContain("ghp_");
    expect(stored).not.toContain("pairing-code-XYZ");
    expect(stored).toContain("[REDACTED]");
    expect(rec.contentHash).toBe(sha256(stored));

    const json = s.write({ projectId: "proj_1", kind: "evidence", name: "e.json", content: new TextEncoder().encode('{"k":"sk-ant-0123456789abcdefghij"}'), mimeType: "application/json; charset=utf-8", source: "x" });
    expect(s.readText(json.id)).not.toContain("sk-ant-");
    expect(json.relativePath).toMatch(/^projects\/proj_1\/evidence\//);
    expect(json.retentionPolicy).toBe("keep");

    const raw = s.write({ projectId: "proj_1", kind: "document", name: "raw.txt", content: secretText, mimeType: "text/plain", source: "x", redact: false });
    expect(s.readText(raw.id)).toBe(secretText);
  });

  it("sanitizes names and rejects path traversal", () => {
    const rec = store.write({ projectId: "proj_1", runId: "run_1", kind: "diff", name: "../../../etc/passwd", content: "x", mimeType: "text/x-diff", source: "git" });
    expect(rec.relativePath).toMatch(/^projects\/proj_1\/runs\/run_1\/diffs\/art_[a-z0-9]+-passwd$/);
    expect(sanitizeName("..\\..\\win.ini")).toBe("win.ini");
    expect(sanitizeName("...")).toBe("artifact");

    expect(() => store.write({ projectId: "../evil", kind: "log", name: "a", content: "x", mimeType: "text/plain", source: "x" })).toThrow(ArtifactPathError);
    expect(() => store.write({ projectId: "proj_1", runId: "..", kind: "log", name: "a", content: "x", mimeType: "text/plain", source: "x" })).toThrow(ArtifactPathError);
    expect(() => store.resolvePath("../outside.txt")).toThrow(ArtifactPathError);
    expect(() => store.resolvePath("projects/../../outside.txt")).toThrow(ArtifactPathError);
    expect(() => store.resolvePath({ relativePath: "C:/Windows/win.ini" })).toThrow(ArtifactPathError);
    expect(() => store.resolvePath("/etc/passwd")).toThrow(ArtifactPathError);
    expect(() => store.appendLog({ projectId: "proj_1", sessionId: "../../x", chunk: "a" })).toThrow(ArtifactPathError);
  });

  it("detects tampered content on read", () => {
    const rec = store.write({ projectId: "proj_1", kind: "document", name: "a.txt", content: "hello", mimeType: "text/plain", source: "x" });
    writeFileSync(store.resolvePath(rec), "tampered");
    expect(() => store.read(rec.id)).toThrow(ArtifactIntegrityError);
  });

  it("applies retention policies", () => {
    const write = (name: string, retentionPolicy: "keep" | "days_7" | "days_30" | "run_lifetime", runId?: string) =>
      store.write({ projectId: "proj_1", ...(runId ? { runId } : {}), kind: "log", name, content: name, mimeType: "text/plain", source: "x", retentionPolicy });
    const keep = write("keep", "keep");
    const d7 = write("d7", "days_7");
    const d30 = write("d30", "days_30");
    const runScoped = write("run", "run_lifetime", "run_1");

    expect(store.applyRetention(new Date())).toEqual([]);
    const in8Days = new Date(Date.now() + 8 * 86_400_000);
    expect(store.applyRetention(in8Days)).toEqual([d7.id]);
    expect(existsSync(join(tmp.dir, d7.relativePath))).toBe(false);

    db.runStore.deleteRun("run_1");
    expect(store.applyRetention(in8Days)).toEqual([runScoped.id]);
    expect(existsSync(join(tmp.dir, "projects/proj_1/runs/run_1"))).toBe(false);

    expect(store.applyRetention(new Date(Date.now() + 31 * 86_400_000))).toEqual([d30.id]);
    expect(store.applyRetention(new Date(Date.now() + 3650 * 86_400_000))).toEqual([]);
    expect(store.readText(keep.id)).toBe("keep");
  });

  it("appends redacted raw logs, prunes them separately, and can be disabled", () => {
    const rel = store.appendLog({ projectId: "proj_1", sessionId: "sess_1", chunk: "hello " });
    store.appendLog({ projectId: "proj_1", sessionId: "sess_1", chunk: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstu\n" });
    expect(rel).toBe("projects/proj_1/sessions/sess_1/pty.raw.log");
    const content = readFileSync(store.resolvePath(rel!), "utf8");
    expect(content).toBe("hello OPENAI_API_KEY=[REDACTED]\n");
    expect(store.appendLog({ projectId: "proj_1", runId: "run_1", stream: "stderr", chunk: "x" })).toBe("projects/proj_1/runs/run_1/logs/stderr.raw.log");

    const old = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(store.resolvePath(rel!), old, old);
    store.applyRetention(new Date());
    expect(existsSync(store.resolvePath(rel!))).toBe(false);
    expect(existsSync(store.resolvePath("projects/proj_1/runs/run_1/logs/stderr.raw.log"))).toBe(true);

    const disabled = new ArtifactStore({ rootDir: tmp.dir, db, rawLogs: false });
    expect(disabled.appendLog({ projectId: "proj_1", sessionId: "sess_2", chunk: "x" })).toBeUndefined();
    expect(existsSync(join(tmp.dir, "projects/proj_1/sessions/sess_2"))).toBe(false);
  });

  it("stores snapshot content immutably, named by hash", () => {
    const text = "# BA\n\n### BA-ORDER-001 — Customer cancels a pending order\n";
    const snap: SourceSnapshot = { id: "snap_ba", type: "ba_markdown", contentHash: sha256(text), createdAt: "2026-10-01T09:00:00.000Z", metadata: {} };
    const first = store.saveSnapshotContent("proj_1", snap, text);
    expect(first).toEqual({ relativePath: `projects/proj_1/snapshots/${snap.contentHash}.md`, inserted: true });
    expect(store.readSnapshotContent("snap_ba")).toBe(text);

    expect(store.saveSnapshotContent("proj_1", snap, text).inserted).toBe(false);
    expect(() => store.saveSnapshotContent("proj_1", { ...snap, id: "snap_x" }, text + "changed")).toThrow(ArtifactIntegrityError);

    const sameContent = store.saveSnapshotContent("proj_1", { ...snap, id: "snap_ba_2" }, text);
    expect(sameContent.relativePath).toBe(first.relativePath);

    writeFileSync(store.resolvePath(first.relativePath), "edited");
    expect(() => store.readSnapshotContent("snap_ba")).toThrow(ArtifactIntegrityError);
    expect(() => store.saveSnapshotContent("proj_1", { ...snap, id: "snap_ba_3" }, text)).toThrow(ArtifactIntegrityError);
  });

  it("removes a project with its files", () => {
    store.write({ projectId: "proj_1", runId: "run_1", kind: "log", name: "a", content: "x", mimeType: "text/plain", source: "x" });
    store.removeProject("proj_1");
    expect(db.projects.get("proj_1")).toBeUndefined();
    expect(db.artifacts.list({ projectId: "proj_1" })).toEqual([]);
    expect(existsSync(join(tmp.dir, "projects/proj_1"))).toBe(false);
  });
});
