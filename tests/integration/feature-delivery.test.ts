import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

/**
 * End-to-end run of the composed A/B/C workflow (spec §23.3 "Figma selection + API upload →
 * FE Readiness Package", "BA Spec + FE Readiness Package → Acceptance Test Case Package",
 * "Generated test code → execution result → traceability evidence") against real packages:
 * SQLite, artifact store, git snapshots of the project folder, a Figma selection pushed by the GoApp Figma plugin, and
 * the fake AI CLI through the real Claude stream-json parser.
 */
describe("feature delivery workflow", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  it("builds the UI from Figma first, reviews it against the API contract when it arrives, integrates and runs the BA acceptance tests", async () => {
    h = await createHarness({ aiFixture: "cancel-order" });
    const engine = h.newEngine();
    // A feature starts with a name only; the API contract and the BA spec are imported into their steps.
    const run = await engine.startRun({ projectId: h.projectId, definition: h.definition, inputs: h.createRunInputs({ importLater: true }) });
    let state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("waiting");
    expect(state.nodes.find((n) => n.nodeId === "A.api_contract")?.status).toBe("waiting_for_input");
    expect(state.nodes.find((n) => n.nodeId === "C1.ba_spec")?.status).toBe("waiting_for_input");
    // No contract yet: the UI is already built from Figma; the review waits for the contract.
    expect(state.nodes.find((n) => n.nodeId === "B1.implement_ui")?.status).toBe("passed");
    expect(state.nodes.find((n) => n.nodeId === "A.review")?.status).toBe("waiting_for_dependency");
    await engine.provideInput(run.id, "A.api_contract", h.importApi() as unknown as Record<string, unknown>);

    // Without the BA spec the feature is still implemented; only test design is pending (spec §11.1).
    state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("test_design_pending");
    expect(state.nodes.find((n) => n.nodeId === "B2.ui_states")?.status).toBe("passed");
    expect(state.nodes.find((n) => n.nodeId === "C2.generate_tests")?.status).toBe("waiting_for_dependency");
    await engine.provideInput(run.id, "C1.ba_spec", h.importBa() as unknown as Record<string, unknown>);
    state = await engine.waitForRun(run.id);

    const failed = state.nodes.filter((n) => !["passed", "skipped"].includes(n.status));
    expect(failed.map((n) => `${n.nodeId}:${n.status}:${n.error?.code ?? n.blockerSummary ?? ""}`)).toEqual([]);
    // No backend URL → provider verification is skipped and the run is honest about it (spec §15.1).
    expect(state.run.status).toBe("completed_with_assumptions");
    const byId = new Map(state.nodes.map((n) => [n.nodeId, n]));
    expect(byId.get("B2.check_backend")?.output).toMatchObject({ verificationLevel: "contract_only" });
    expect(state.nodes).toHaveLength(12);

    // The API contract was saved into the project, and the agent reviewed the built UI against it.
    const apiOut = byId.get("A.api_contract")?.output as { apiContractPath: string };
    expect(apiOut.apiContractPath).toBe(`.frontflow/runs/${run.id}/api-contract.md`);
    expect(readFileSync(join(h.projectRoot, apiOut.apiContractPath), "utf8")).toContain("POST /orders/{orderId}/cancel");
    const readiness = byId.get("A.review")?.output as {
      readiness: string;
      reviewedBy: string;
      verdict: { score: number; headline: string; summary: string };
      mappings: Array<{ status: string; rationale: string }>;
      operations: Array<{ sourceRefs: Array<{ excerpt?: string }> }>;
      uiFlow: Array<{ figmaNodeIds: string[] }>;
    };
    expect(readiness).toMatchObject({ readiness: "ready", reviewedBy: "ai" });
    expect(readiness.verdict).toMatchObject({ score: 100, headline: "3 of 3 UI needs ready to implement (100%)" });
    expect(readiness.verdict.summary).toContain("can be wired to the API");
    expect(readiness.mappings[0]?.rationale).toContain("api.md");
    expect(readiness.operations[0]?.sourceRefs[0]?.excerpt).toContain("POST /orders/{orderId}/cancel");
    expect(readiness.uiFlow[0]?.figmaNodeIds).toEqual(["123:456"]);
    const logs = h.db.runStore.listEvents(run.id, { types: ["node.log"] }).map((e) => (e.payload as { message: string }).message);
    expect(logs.some((m) => m.includes("reviewed by AI"))).toBe(true);
    // Every AI step ran its editable prompt; the rendered prompts are kept as evidence.
    const promptArtifacts = h.db.artifacts.listByRun(run.id).filter((a) => a.kind === "prompt").map((a) => a.name);
    expect(promptArtifacts).toEqual(expect.arrayContaining(["B1.implement_ui-attempt1.md", "A.review-attempt1.md", "B2.api_binding-attempt1.md", "C1.test_design-attempt1.md"]));
    const reviewPrompt = h.db.artifacts.listByRun(run.id).find((a) => a.name === "A.review-attempt1.md");
    expect(h.artifacts.readText(reviewPrompt!.id)).toContain(apiOut.apiContractPath);
    expect(h.artifacts.readText(reviewPrompt!.id)).not.toContain("{{");

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

    // The AI agents work in the project folder itself; FrontFlow only records hidden snapshots (no worktree, no branch).
    const checkpoint = h.db.gitCheckpoints.latestForRun(run.id);
    expect(checkpoint?.projectPath).toBe(h.projectRoot);
    expect(readFileSync(join(h.projectRoot, "fake-output.txt"), "utf8")).toContain("generated");
    // FrontFlow's own run files stay out of the user's git status.
    expect(execFileSync("git", ["status", "--porcelain", "--", ".frontflow"], { cwd: h.projectRoot, encoding: "utf8" }).trim()).toBe("");
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: h.projectRoot, encoding: "utf8" }).trim()).toBe("main");
    expect(execFileSync("git", ["worktree", "list"], { cwd: h.projectRoot, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
    expect(execFileSync("git", ["rev-parse", `refs/frontflow/${run.id}`], { cwd: h.projectRoot, encoding: "utf8" }).trim()).toBe(checkpoint?.headSha);

    // AI sessions are recorded for the Sessions screen / resume.
    expect(h.db.aiSessions.listByRun(run.id).length).toBeGreaterThanOrEqual(7);
    expect(h.db.aiSessions.listByRun(run.id).every((s) => s.status === "completed")).toBe(true);
  }, 240_000);

  it("waits for input when the built UI is not covered by the API contract and continues when gaps are accepted", async () => {
    // No canned AI answers: the review falls back to the selected layers, so no UI need can be mapped.
    h = await createHarness();
    const engine = h.newEngine();
    const run = await engine.startRun({ projectId: h.projectId, definition: h.definition, inputs: h.createRunInputs({ baFixture: "order-conflicts" }) });
    let state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("waiting");
    expect(state.nodes.filter((n) => n.status === "waiting_for_input").map((n) => n.nodeId)).toEqual(["A.review"]);
    // The UI was built from Figma anyway; API integration never starts from a package that is not ready.
    expect(state.nodes.find((n) => n.nodeId === "B1.implement_ui")?.status).toBe("passed");
    expect(state.nodes.find((n) => n.nodeId === "B2.api_binding")?.status).toBe("waiting_for_dependency");
    expect(h.db.artifacts.listByRun(run.id).some((a) => a.relativePath.endsWith("readiness-gap-report.md"))).toBe(true);
    const logs = h.db.runStore.listEvents(run.id, { types: ["node.log"] }).map((e) => (e.payload as { message: string }).message);
    expect(logs.some((m) => m.includes("FE readiness: not_ready"))).toBe(true);

    // Accept the gaps and let the run settle; the rest is covered by the first test.
    await engine.provideInput(run.id, "A.review", { accept: true });
    state = await engine.waitForRun(run.id);
    const pkgNode = state.nodes.find((n) => n.nodeId === "A.review");
    expect(pkgNode?.status).toBe("passed");
    expect(pkgNode?.assumed).toBe(true);
    expect(state.nodes.find((n) => n.nodeId === "B2.api_binding")?.status).toBe("passed");
  }, 240_000);

  it("restores and finishes a run after an app restart", async () => {
    h = await createHarness({ aiFixture: "cancel-order" });
    const first = h.newEngine();
    const run = await first.startRun({ projectId: h.projectId, definition: h.definition, inputs: h.createRunInputs() });
    await new Promise<void>((resolve) => {
      const off = first.subscribe((e) => {
        if (e.type === "node.status_changed" && e.payload.nodeId === "A.review" && e.payload.status === "passed") {
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
