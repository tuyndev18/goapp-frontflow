import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

/**
 * End-to-end run of the composed A/B/C workflow (spec §23.3 "Figma selection + API upload →
 * FE Readiness Package", "BA Spec + FE Readiness Package → Acceptance Test Case Package",
 * "Generated test code → execution result → traceability evidence") against real packages:
 * SQLite, artifact store, git worktrees, a Figma selection pushed by the GoApp Figma plugin, and
 * the fake AI CLI through the real Claude stream-json parser.
 */
describe("feature delivery workflow", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  it("runs Figma × API readiness, implementation and BA acceptance tests through to an evidence report", async () => {
    h = await createHarness({ aiFixture: "cancel-order" });
    const engine = h.newEngine();
    // A feature starts with a name only; the API contract and the BA spec are imported into their steps.
    const run = await engine.startRun({ projectId: h.projectId, definition: h.definition, inputs: h.createRunInputs({ importLater: true }) });
    let state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("waiting");
    expect(state.nodes.find((n) => n.nodeId === "A.api_contract")?.status).toBe("waiting_for_input");
    expect(state.nodes.find((n) => n.nodeId === "C1.ba_spec")?.status).toBe("waiting_for_input");
    await engine.provideInput(run.id, "A.api_contract", h.importApi() as unknown as Record<string, unknown>);

    // Without the BA spec the feature is still implemented; only test design is pending (spec §11.1).
    state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("test_design_pending");
    expect(state.nodes.find((n) => n.nodeId === "B.quality_gates")?.status).toBe("passed");
    expect(state.nodes.find((n) => n.nodeId === "C2.generate_tests")?.status).toBe("waiting_for_dependency");
    await engine.provideInput(run.id, "C1.ba_spec", h.importBa() as unknown as Record<string, unknown>);
    state = await engine.waitForRun(run.id);

    const failed = state.nodes.filter((n) => !["passed", "skipped"].includes(n.status));
    expect(failed.map((n) => `${n.nodeId}:${n.status}:${n.error?.code ?? n.blockerSummary ?? ""}`)).toEqual([]);
    // No backend URL → provider verification is skipped and the run is honest about it (spec §15.1).
    expect(state.run.status).toBe("completed_with_assumptions");
    const byId = new Map(state.nodes.map((n) => [n.nodeId, n]));
    expect(byId.get("B.check_backend")?.output).toMatchObject({ verificationLevel: "contract_only" });
    expect(state.nodes).toHaveLength(15);

    // Workflow A was done by the AI CLI and grounded against the contract and the Figma selection.
    const apiOut = byId.get("A.api_contract")?.output as { extractedBy: string; operations: Array<{ id: string; sourceRefs: Array<{ excerpt?: string }> }> };
    expect(apiOut.extractedBy).toBe("ai");
    expect(apiOut.operations[0]?.sourceRefs[0]?.excerpt).toContain("POST /orders/{orderId}/cancel");
    const flowOut = byId.get("A.ui_flow")?.output as { extractedBy: string; uiFlow: Array<{ figmaNodeIds: string[] }> };
    expect(flowOut.extractedBy).toBe("ai");
    expect(flowOut.uiFlow[0]?.figmaNodeIds).toEqual(["123:456"]);
    const readiness = byId.get("A.readiness")?.output as { readiness: string; verdict: { score: number; headline: string; summary: string }; mappings: Array<{ status: string; rationale: string }> };
    expect(readiness.readiness).toBe("ready");
    expect(readiness.verdict).toMatchObject({ score: 100, headline: "3 of 3 UI needs ready to implement (100%)" });
    expect(readiness.verdict.summary).toContain("can be implemented");
    expect(readiness.mappings[0]?.rationale).toContain("api.md");
    const logs = h.db.runStore.listEvents(run.id, { types: ["node.log"] }).map((e) => (e.payload as { message: string }).message);
    expect(logs.some((m) => m.includes("mapped by AI"))).toBe(true);

    // Workflow C1 designed the tests from the BA, the UI flow and the mapping.
    const design = byId.get("C1.test_design")?.output as { status: string; designedBy: string; testCases: Array<{ id: string; figmaNodeIds: string[] }> };
    expect(design).toMatchObject({ status: "ready", designedBy: "ai" });
    expect(design.testCases.map((t) => t.id)).toEqual(["TC-BA-ORDER-001-01", "TC-BA-ORDER-001-02", "TC-BA-ORDER-002-01"]);
    expect(design.testCases[0]?.figmaNodeIds).toEqual(["123:456"]);

    const artifacts = h.db.artifacts.listByRun(run.id);
    const traceArtifact = artifacts.find((a) => a.relativePath.endsWith("traceability.json"));
    expect(traceArtifact).toBeDefined();
    const trace = JSON.parse(h.artifacts.readText(traceArtifact!.id)) as {
      ui: Array<{ figmaNodeIds: string[]; sourceFiles: string[]; evidenceIds: string[]; testIds: string[]; status: string }>;
      tests: Array<{ requirementId: string; testCaseIds: string[]; status: string }>;
    };
    expect(trace.ui.length).toBeGreaterThan(0);
    for (const item of trace.ui) {
      expect(item.figmaNodeIds).toContain("123:456");
      expect(item.sourceFiles).toContain("fake-output.txt");
      expect(item.evidenceIds.length).toBeGreaterThan(0);
      expect(item.testIds.length).toBe(3);
      // contract-only → never claimed as verified
      expect(item.status).toBe("assumed");
    }
    expect(trace.tests.map((t) => [t.requirementId, t.testCaseIds.length, t.status])).toEqual([
      ["BA-ORDER-001", 2, "assumed"],
      ["BA-ORDER-002", 1, "assumed"],
    ]);

    const report = artifacts.find((a) => a.relativePath.endsWith("evidence-report.md"));
    expect(report).toBeDefined();
    expect(h.artifacts.readText(report!.id)).toContain("contract_only");
    expect(artifacts.some((a) => a.relativePath.endsWith("fe-readiness-package.json"))).toBe(true);
    expect(artifacts.some((a) => a.relativePath.endsWith("acceptance-test-cases.json"))).toBe(true);
    expect(artifacts.some((a) => a.kind === "diff")).toBe(true);
    expect(artifacts.some((a) => a.kind === "figma_snapshot")).toBe(true);
    const results = h.db.testResults.listByRun(run.id);
    expect(results.some((r) => r.suite === "e2e-test" && r.scenarioIds.includes("TC-BA-ORDER-001-01"))).toBe(true);

    // Code changes happen in the run's worktree, never in the user's checkout (spec §19).
    const checkpoint = h.db.gitCheckpoints.latestForRun(run.id);
    expect(checkpoint?.worktreePath).not.toBe(h.projectRoot);
    expect(readFileSync(join(checkpoint!.worktreePath, "fake-output.txt"), "utf8")).toContain("generated");

    // AI sessions are recorded for the Sessions screen / resume.
    expect(h.db.aiSessions.listByRun(run.id).length).toBeGreaterThanOrEqual(8);
    expect(h.db.aiSessions.listByRun(run.id).every((s) => s.status === "completed")).toBe(true);
  }, 240_000);

  it("waits for input when Figma × API is not enough and continues when gaps are accepted", async () => {
    // No canned AI answers: the UI flow falls back to the selected layers, so no UI need can be mapped.
    h = await createHarness();
    const engine = h.newEngine();
    const run = await engine.startRun({ projectId: h.projectId, definition: h.definition, inputs: h.createRunInputs({ baFixture: "order-conflicts" }) });
    let state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("waiting");
    expect(state.nodes.filter((n) => n.status === "waiting_for_input").map((n) => n.nodeId)).toEqual(["A.readiness"]);
    // Implementation never starts from a package that is not ready.
    expect(state.nodes.find((n) => n.nodeId === "B.implement_ui")?.status).toBe("waiting_for_dependency");
    expect(h.db.artifacts.listByRun(run.id).some((a) => a.relativePath.endsWith("readiness-gap-report.md"))).toBe(true);
    const logs = h.db.runStore.listEvents(run.id, { types: ["node.log"] }).map((e) => (e.payload as { message: string }).message);
    expect(logs.some((m) => m.includes("FE readiness: not_ready"))).toBe(true);

    // Accept the gaps and let the run settle; the rest is covered by the first test.
    await engine.provideInput(run.id, "A.readiness", { accept: true });
    state = await engine.waitForRun(run.id);
    const pkgNode = state.nodes.find((n) => n.nodeId === "A.readiness");
    expect(pkgNode?.status).toBe("passed");
    expect(pkgNode?.assumed).toBe(true);
    expect(state.nodes.find((n) => n.nodeId === "B.implement_ui")?.status).toBe("passed");
  }, 240_000);

  it("restores and finishes a run after an app restart", async () => {
    h = await createHarness({ aiFixture: "cancel-order" });
    const first = h.newEngine();
    const run = await first.startRun({ projectId: h.projectId, definition: h.definition, inputs: h.createRunInputs() });
    await new Promise<void>((resolve) => {
      const off = first.subscribe((e) => {
        if (e.type === "node.status_changed" && e.payload.nodeId === "A.readiness" && e.payload.status === "passed") {
          off();
          resolve();
        }
      });
    });
    await first.pause(run.id);
    first.shutdown();
    // In the app the old process is gone; here its aborted handlers must finish before the "restart".
    await new Promise((r) => setTimeout(r, 3000));

    const second = h.newEngine();
    const recovered = await second.recover();
    expect(recovered.recovered).toContain(run.id);
    expect((await second.getRunState(run.id))?.run.status).toBe("paused");
    await second.resume(run.id);
    const state = await second.waitForRun(run.id);
    const bad = state.nodes.filter((n) => !["passed", "skipped"].includes(n.status));
    expect(bad.map((n) => `${n.nodeId}:${n.status}:${n.error?.code ?? ""}:${n.error?.message ?? n.blockerSummary ?? ""}`)).toEqual([]);
    expect(state.run.status).toBe("completed_with_assumptions");
    // Nodes finished before the restart were not executed again.
    expect(state.nodes.filter((n) => n.nodeId === "A.api_contract" && n.status === "passed").length).toBe(1);
  }, 240_000);
});
