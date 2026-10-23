import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AlignmentPackage, SourceSnapshot } from "@frontflow/domain";
import { InMemoryCredentialVault, openDatabase, type FrontflowDb } from "../src/index.js";
import { profile, project, run, seedProjectAndRun } from "./helpers.js";

let db: FrontflowDb;
beforeEach(() => {
  db = openDatabase(":memory:");
});
afterEach(() => db.close());

describe("projects & profiles", () => {
  it("lists projects by lastOpenedAt, touches and removes", () => {
    db.projects.upsert(project("p_a", "2026-10-01T00:00:00.000Z"));
    db.projects.upsert(project("p_b", "2026-10-02T00:00:00.000Z"));
    expect(db.projects.list().map((p) => p.id)).toEqual(["p_b", "p_a"]);
    expect(db.projects.touch("p_a", "2026-10-03T00:00:00.000Z")).toBe(true);
    expect(db.projects.list().map((p) => p.id)).toEqual(["p_a", "p_b"]);
    expect(db.projects.getByRootPath("D:/work/p_b")?.id).toBe("p_b");
    db.profiles.save(profile("p_a"));
    expect(db.projects.remove("p_a")).toBe(true);
    expect(db.projects.get("p_a")).toBeUndefined();
    expect(db.profiles.getLatest("p_a")).toBeUndefined();
  });

  it("versions profiles and skips unchanged saves", () => {
    db.projects.upsert(project());
    expect(db.profiles.save(profile()).version).toBe(1);
    expect(db.profiles.save(profile()).version).toBe(1);
    expect(db.profiles.save(profile("proj_1", "vite")).version).toBe(2);
    expect(db.profiles.getLatest("proj_1")?.framework).toBe("vite");
    expect(db.profiles.get("proj_1", 1)?.profile.framework).toBe("next");
    expect(db.profiles.listVersions("proj_1").map((v) => v.version)).toEqual([1, 2]);
  });
});

describe("source documents & snapshots", () => {
  const snap = (id: string, contentHash = `hash_${id}`): SourceSnapshot => ({
    id,
    type: "ba_markdown",
    sourceUri: "file:///ba.md",
    contentHash,
    createdAt: "2026-10-01T09:00:00.000Z",
    metadata: { lines: 42 },
  });

  it("keeps snapshots immutable and lists them by run input order", () => {
    db.projects.upsert(project());
    db.sourceDocuments.upsert({
      id: "doc_ba",
      projectId: "proj_1",
      type: "ba_markdown",
      name: "ba.md",
      createdAt: "2026-10-01T09:00:00.000Z",
      updatedAt: "2026-10-01T09:00:00.000Z",
    });
    expect(db.snapshots.insert("proj_1", snap("snap_ba"), { sourceDocumentId: "doc_ba" })).toBe(true);
    expect(db.snapshots.insert("proj_1", { ...snap("snap_ba"), contentHash: "tampered", metadata: {} })).toBe(false);
    expect(db.snapshots.get("snap_ba")).toEqual(snap("snap_ba"));
    expect(db.snapshots.getRecord("snap_ba")?.sourceDocumentId).toBe("doc_ba");
    db.snapshots.insert("proj_1", { ...snap("snap_api"), type: "api_markdown" });
    db.runStore.saveRun(run("run_1", { inputs: { snapshotIds: ["snap_api", "snap_ba", "snap_missing"] } }));
    expect(db.snapshots.listByRun("run_1").map((s) => s.id)).toEqual(["snap_api", "snap_ba"]);
    expect(db.snapshots.findByHash("proj_1", "hash_snap_ba")?.id).toBe("snap_ba");
    db.sourceDocuments.upsert({ ...db.sourceDocuments.get("doc_ba")!, latestSnapshotId: "snap_ba", updatedAt: "2026-10-02T00:00:00.000Z" });
    expect(db.sourceDocuments.listByProject("proj_1")[0]?.latestSnapshotId).toBe("snap_ba");
  });
});

describe("alignment package", () => {
  const pkg: AlignmentPackage = {
    version: 1,
    runId: "run_1",
    sourceSnapshots: ["snap_ba", "snap_api"],
    requirements: [
      {
        id: "BA-ORDER-001",
        title: "Customer cancels a pending order",
        actor: "Customer",
        preconditions: ["Order is PENDING"],
        actions: ["Click cancel"],
        outcomes: ["Order becomes CANCELLED"],
        validations: [],
        states: ["PENDING", "CANCELLED"],
        errors: ["ORDER_NOT_FOUND"],
        sourceRefs: [{ snapshotId: "snap_ba", lineStart: 10, lineEnd: 18, section: ["Requirements", "BA-ORDER-001"] }],
        confidence: 0.9,
      },
      {
        id: "BA-ORDER-002",
        title: "Admin views orders",
        preconditions: [],
        actions: ["Open list"],
        outcomes: ["List shown"],
        validations: [],
        states: [],
        errors: [],
        sourceRefs: [],
        confidence: 0.5,
      },
    ],
    operations: [
      {
        id: "POST /orders/{orderId}/cancel",
        method: "POST",
        path: "/orders/{orderId}/cancel",
        roles: ["customer"],
        parameters: [{ name: "orderId", in: "path", type: "string", required: true }],
        responses: [{ status: 200 }, { status: 404, errorCode: "ORDER_NOT_FOUND", schema: { type: "object" } }],
        sourceRefs: [{ snapshotId: "snap_api", lineStart: 1, lineEnd: 20 }],
      },
    ],
    mappings: [
      { requirementId: "BA-ORDER-001", apiOperationIds: ["POST /orders/{orderId}/cancel"], status: "covered", confidence: 0.92, rationale: "match", findings: [], blocking: true },
      {
        requirementId: "BA-ORDER-002",
        apiOperationIds: [],
        status: "missing",
        confidence: 0.4,
        rationale: "no list op",
        findings: [{ kind: "missing_operation", message: "GET /orders missing", assumed: false }],
        blocking: false,
      },
    ],
    scenarios: [
      {
        id: "SC-1",
        requirementId: "BA-ORDER-001",
        title: "Cancel pending order",
        kind: "happy_path",
        given: ["pending order"],
        when: ["cancel"],
        then: ["cancelled"],
        apiOperationIds: ["POST /orders/{orderId}/cancel"],
        assumed: false,
      },
    ],
    traceability: [
      { requirementId: "BA-ORDER-001", apiOperationIds: ["POST /orders/{orderId}/cancel"], figmaNodeIds: [], sourceFiles: [], testIds: [], evidenceIds: [], status: "unverified" },
      { requirementId: "BA-ORDER-002", apiOperationIds: [], figmaNodeIds: [], sourceFiles: [], testIds: [], evidenceIds: [], status: "blocked" },
    ],
    issues: [{ id: "I-1", severity: "warning", code: "missing_actor", message: "No actor", requirementId: "BA-ORDER-002", sourceRefs: [] }],
    summary: { covered: 1, partial: 0, missing: 1, conflict: 0, ambiguous: 0, notRequired: 0, assumed: 0 },
    readiness: "not_ready",
  };

  it("saves and loads deep-equal, replaces on re-save, updates traceability", () => {
    seedProjectAndRun(db);
    db.alignment.saveAlignmentPackage(pkg);
    expect(db.alignment.loadAlignmentPackage("run_1")).toEqual(pkg);
    db.alignment.saveAlignmentPackage(pkg);
    expect(db.alignment.loadAlignmentPackage("run_1")).toEqual(pkg);

    const updated = db.alignment.updateTraceabilityItem("run_1", "BA-ORDER-001", {
      sourceFiles: ["src/orders/CancelButton.tsx"],
      testIds: ["t1"],
      status: "verified",
    });
    expect(updated).toMatchObject({ status: "verified", testIds: ["t1"], apiOperationIds: ["POST /orders/{orderId}/cancel"] });
    expect(db.alignment.loadAlignmentPackage("run_1")?.traceability[0]).toEqual(updated);
    expect(db.alignment.updateTraceabilityItem("run_1", "NOPE", { status: "verified" })).toBeUndefined();
    expect(db.alignment.loadAlignmentPackage("other")).toBeUndefined();
  });

  it("writes nothing when the transaction fails", () => {
    seedProjectAndRun(db);
    const dup = { ...pkg, scenarios: [pkg.scenarios[0]!, pkg.scenarios[0]!] };
    expect(() => db.alignment.saveAlignmentPackage(dup)).toThrow();
    expect(db.alignment.loadAlignmentPackage("run_1")).toBeUndefined();
  });
});

describe("sessions, installations, approvals, results, checkpoints", () => {
  it("upserts CLI detection results", () => {
    db.cliInstallations.upsert({ adapterId: "codex", available: false, error: "not found", detectedAt: "2026-10-01T00:00:00.000Z" });
    db.cliInstallations.upsert({
      adapterId: "claude-code",
      available: true,
      executablePath: "C:/bin/claude.exe",
      version: "2.1.0",
      authStatus: "authenticated",
      capabilities: { structuredEvents: true, resumableSessions: true },
      detectedAt: "2026-10-01T00:00:00.000Z",
    });
    db.cliInstallations.upsert({ adapterId: "codex", available: true, version: "1.0.0", detectedAt: "2026-10-02T00:00:00.000Z" });
    expect(db.cliInstallations.list().map((i) => [i.adapterId, i.available])).toEqual([
      ["claude-code", true],
      ["codex", true],
    ]);
    expect(db.cliInstallations.get("codex")).toEqual({ adapterId: "codex", available: true, version: "1.0.0", detectedAt: "2026-10-02T00:00:00.000Z" });
  });

  it("tracks AI sessions and status changes", () => {
    seedProjectAndRun(db);
    db.aiSessions.save({ id: "s1", projectId: "proj_1", adapterId: "claude-code", mode: "pty", status: "starting", cwd: "D:/w", startedAt: "2026-10-01T10:00:00.000Z" });
    db.aiSessions.save({ id: "s2", projectId: "proj_1", workflowRunId: "run_1", adapterId: "codex", mode: "structured", status: "idle", cwd: "D:/w", startedAt: "2026-10-01T11:00:00.000Z" });
    expect(db.aiSessions.updateStatus("s1", "completed", { externalSessionId: "ext-1", endedAt: "2026-10-01T10:30:00.000Z" })).toBe(true);
    expect(db.aiSessions.get("s1")).toMatchObject({ status: "completed", externalSessionId: "ext-1", endedAt: "2026-10-01T10:30:00.000Z" });
    expect(db.aiSessions.listByProject("proj_1").map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(db.aiSessions.listByRun("run_1").map((s) => s.id)).toEqual(["s2"]);
    db.runStore.deleteRun("run_1");
    expect(db.aiSessions.get("s2")?.workflowRunId).toBeUndefined();
  });

  it("decides approvals once, expires due requests and redacts detail", () => {
    seedProjectAndRun(db);
    const base = { projectId: "proj_1", workflowRunId: "run_1", permission: "destructive_action" as const, status: "pending" as const };
    db.approvals.save({ ...base, requestId: "a1", action: "git reset --hard", detail: "TOKEN=supersecretvalue", requestedAt: "2026-10-01T10:00:00.000Z" });
    db.approvals.save({ ...base, requestId: "a2", action: "rm -rf dist", requestedAt: "2026-10-01T10:01:00.000Z", expiresAt: "2026-10-01T10:05:00.000Z" });
    expect(db.approvals.get("a1")?.detail).not.toContain("supersecretvalue");
    expect(db.approvals.listPending({ workflowRunId: "run_1" }).map((a) => a.requestId)).toEqual(["a1", "a2"]);
    expect(db.approvals.decide("a1", "approved", { decidedAt: "2026-10-01T10:02:00.000Z", decidedBy: "user" })).toBe(true);
    expect(db.approvals.decide("a1", "rejected")).toBe(false);
    expect(db.approvals.get("a1")).toMatchObject({ status: "approved", decidedAt: "2026-10-01T10:02:00.000Z", decidedBy: "user" });
    expect(db.approvals.expireDue("2026-10-01T10:06:00.000Z")).toEqual(["a2"]);
    expect(db.approvals.get("a2")?.status).toBe("expired");
    expect(db.approvals.listPending()).toEqual([]);
  });

  it("stores test results and git checkpoints per run", () => {
    seedProjectAndRun(db);
    const tr = { id: "tr1", workflowRunId: "run_1", suite: "unit", kind: "unit" as const, passed: 10, failed: 1, skipped: 0, durationMs: 1234, scenarioIds: ["SC-1"] };
    db.testResults.save(tr);
    expect(db.testResults.listByRun("run_1")).toEqual([tr]);
    const cp1 = { id: "cp1", workflowRunId: "run_1", projectPath: "D:/w", branch: "main", baseSha: "a", headSha: "b", createdAt: "2026-10-01T10:00:00.000Z" };
    const cp2 = { ...cp1, id: "cp2", nodeRunId: "nr_x", headSha: "c", createdAt: "2026-10-01T10:10:00.000Z" };
    db.gitCheckpoints.save(cp2);
    db.gitCheckpoints.save(cp1);
    expect(db.gitCheckpoints.listByRun("run_1")).toEqual([cp1, cp2]);
    expect(db.gitCheckpoints.latestForRun("run_1")).toEqual(cp2);
  });
});

describe("InMemoryCredentialVault", () => {
  it("gets, sets and deletes", async () => {
    const vault = new InMemoryCredentialVault();
    await vault.set("figma:pairing:proj_1", "pairing-secret");
    expect(await vault.get("figma:pairing:proj_1")).toBe("pairing-secret");
    expect(vault.knownSecrets()).toEqual(["pairing-secret"]);
    expect(await vault.delete("figma:pairing:proj_1")).toBe(true);
    expect(await vault.get("figma:pairing:proj_1")).toBeUndefined();
  });
});
