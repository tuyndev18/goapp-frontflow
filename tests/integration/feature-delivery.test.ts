import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
    expect(state.nodes).toHaveLength(13);

    // The workflow files live in the tool's data for this project and run, never in the project.
    const runDir = join(h.dataDir, "projects", h.projectId, "runs", run.id, "files");
    const apiOut = byId.get("A.api_contract")?.output as { apiContractFiles: string[]; history: Array<{ documents: unknown[] }> };
    expect(apiOut.apiContractFiles).toEqual([join(runDir, "api-contract", "api.md")]);
    expect(apiOut.history).toHaveLength(1);
    expect(readFileSync(join(runDir, "api-contract", "api.md"), "utf8")).toContain("POST /orders/{orderId}/cancel");
    // The review is the agent's short Markdown report, read by the next steps' agents.
    const review = byId.get("A.review")?.output as { reportPath: string; report: string };
    expect(review).toMatchObject({ reportPath: join(runDir, "api-review.md"), verdict: "enough", score: 100 });
    expect(readFileSync(review.reportPath, "utf8")).toBe(review.report);
    expect(byId.get("A.review")?.assumed).toBeFalsy();
    // Every AI step ran its editable prompt; the rendered prompts are kept as evidence.
    const promptArtifacts = h.db.artifacts.listByRun(run.id).filter((a) => a.kind === "prompt").map((a) => a.name);
    expect(promptArtifacts).toEqual(expect.arrayContaining(["B1.implement_ui-attempt1.md", "A.review-attempt1.md", "B2.api_binding-attempt1.md", "C1.ba_spec-attempt1.md", "C1.test_design-attempt1.md"]));
    const prompt = (name: string) => h!.artifacts.readText(h!.db.artifacts.listByRun(run.id).find((a) => a.name === name)!.id);
    expect(prompt("A.review-attempt1.md")).toContain(join(runDir, "api-contract", "api.md"));
    expect(prompt("A.review-attempt1.md")).not.toContain("{{");
    expect(prompt("B2.api_binding-attempt1.md")).toContain(review.reportPath);

    // Workflow C1 read the BA scenarios and designed the tests, both as Markdown reports.
    const scenarios = byId.get("C1.ba_spec")?.output as { reportPath: string; report: string };
    expect(scenarios.reportPath).toBe(join(runDir, "ba-scenarios.md"));
    expect(scenarios.report).toContain("BA-ORDER-001");
    const design = byId.get("C1.test_design")?.output as { reportPath: string; report: string; verdict: string };
    expect(design).toMatchObject({ reportPath: join(runDir, "test-design.md"), verdict: "enough" });
    expect(design.report).toContain("TC-BA-ORDER-002-01");
    expect(prompt("C2.generate_tests-attempt1.md")).toContain(design.reportPath);

    const artifacts = h.db.artifacts.listByRun(run.id);
    const evidence = byId.get("C2.evidence_report")?.output as { reportPath: string; report: string };
    // contract-only → never claimed as verified
    expect(evidence.report).toContain("contract_only");
    expect(readFileSync(evidence.reportPath, "utf8")).toBe(evidence.report);
    // The agent ran the acceptance tests and reported them; FrontFlow only read its Đạt conclusion.
    expect(byId.get("C2.run_tests")?.output).toMatchObject({ reportPath: join(runDir, "acceptance-tests.md"), verdict: "enough", verificationLevel: "contract_only" });
    expect(readFileSync(join(runDir, "acceptance-tests.md"), "utf8")).toContain("TC-BA-ORDER-001-01: pass");
    // Every file FrontFlow keeps for the run is Markdown (or text: diffs, command output).
    expect(artifacts.filter((a) => a.mimeType === "application/json").map((a) => a.name)).toEqual([]);
    expect(h.artifacts.readText(artifacts.find((a) => a.kind === "figma_snapshot")!.id)).toContain("## Layers");
    expect(artifacts.some((a) => a.kind === "diff")).toBe(true);
    expect(artifacts.some((a) => a.kind === "figma_snapshot")).toBe(true);
    expect(existsSync(join(h.projectRoot, ".frontflow"))).toBe(false);

    // The AI agents work in the project folder itself; FrontFlow only records hidden snapshots (no worktree, no branch).
    const checkpoint = h.db.gitCheckpoints.latestForRun(run.id);
    expect(checkpoint?.projectPath).toBe(h.projectRoot);
    expect(readFileSync(join(h.projectRoot, "fake-output.txt"), "utf8")).toContain("generated");
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: h.projectRoot, encoding: "utf8" }).trim()).toBe("main");
    expect(execFileSync("git", ["worktree", "list"], { cwd: h.projectRoot, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
    expect(execFileSync("git", ["rev-parse", `refs/frontflow/${run.id}`], { cwd: h.projectRoot, encoding: "utf8" }).trim()).toBe(checkpoint?.headSha);

    // AI sessions are recorded for the Sessions screen / resume.
    expect(h.db.aiSessions.listByRun(run.id).length).toBeGreaterThanOrEqual(7);
    expect(h.db.aiSessions.listByRun(run.id).every((s) => s.status === "completed")).toBe(true);
  }, 240_000);

  it("waits when the review does not conclude Đủ and continues with that review when gaps are accepted", async () => {
    // No canned AI answers: the agent never writes the review file, only a final reply with no conclusion.
    h = await createHarness();
    const engine = h.newEngine();
    const run = await engine.startRun({ projectId: h.projectId, definition: h.definition, inputs: h.createRunInputs({ baFixture: "order-conflicts" }) });
    let state = await engine.waitForRun(run.id);
    let reviewNode = state.nodes.find((n) => n.nodeId === "A.review");
    expect(reviewNode).toMatchObject({ status: "waiting_for_input", attempt: 2 });
    expect((reviewNode?.output as { report: string; verdict: string }).verdict).toBe("unknown");
    expect(state.nodes.find((n) => n.nodeId === "B2.api_binding")?.status).toBe("waiting_for_dependency");
    const reviewPrompts = () => h!.db.artifacts.listByRun(run.id).filter((a) => a.name.startsWith("A.review-attempt")).length;
    const asked = reviewPrompts();

    await engine.provideInput(run.id, "A.review", { accept: true });
    state = await engine.waitForRun(run.id);
    reviewNode = state.nodes.find((n) => n.nodeId === "A.review");
    expect(reviewNode).toMatchObject({ status: "passed", assumed: true });
    expect((reviewNode?.output as { report: string }).report).toContain("Completed prompt");
    // Accepting reuses the review already written: the AI is not asked again.
    expect(reviewPrompts()).toBe(asked);
    expect(state.nodes.find((n) => n.nodeId === "B2.api_binding")?.status).toBe("passed");
  }, 240_000);

  it("runs the review again on demand and resets the steps built from it", async () => {
    h = await createHarness({ aiFixture: "cancel-order" });
    const engine = h.newEngine();
    const run = await engine.startRun({ projectId: h.projectId, definition: h.definition, inputs: h.createRunInputs() });
    const first = await engine.waitForRun(run.id);
    expect(first.run.status).toBe("completed_with_assumptions");
    const before = first.nodes.find((n) => n.nodeId === "B2.api_binding")?.finishedAt;

    await engine.retryNode(run.id, "A.review");
    const state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("completed_with_assumptions");
    const prompts = h.db.artifacts.listByRun(run.id).filter((a) => a.name === "A.review-attempt1.md");
    expect(prompts).toHaveLength(2);
    expect(state.nodes.find((n) => n.nodeId === "B2.api_binding")?.finishedAt).not.toBe(before);
    // Steps that do not depend on the review are left alone.
    expect(state.nodes.find((n) => n.nodeId === "B1.implement_ui")?.finishedAt).toBe(first.nodes.find((n) => n.nodeId === "B1.implement_ui")?.finishedAt);
  }, 240_000);

  it("reads only the files of the latest upload into a document step", async () => {
    h = await createHarness({ aiFixture: "cancel-order" });
    const engine = h.newEngine();
    const run = await engine.startRun({ projectId: h.projectId, definition: h.definition, inputs: h.createRunInputs({ importLater: true }) });
    await engine.waitForRun(run.id);
    // First upload: two files; second upload: one file. Only the second one is read.
    const first = h.importApi();
    const [doc] = first.api as Array<{ snapshotId: string; kind: "markdown" }>;
    await engine.provideInput(run.id, "A.api_contract", { api: [doc, { ...doc, sourceUri: "errors.md" }] });
    await engine.waitForRun(run.id);
    const runDir = join(h.dataDir, "projects", h.projectId, "runs", run.id, "files", "api-contract");
    expect(readdirSync(runDir).sort()).toEqual(["api.md", "errors.md"]);

    const history = [{ importedAt: "2026-10-23T00:00:00.000Z", documents: [doc, { ...doc, sourceUri: "errors.md" }] }, { importedAt: "2026-10-23T01:00:00.000Z", documents: [{ ...doc, sourceUri: "api-v2.md" }] }];
    await engine.retryNode(run.id, "A.api_contract", { api: [{ ...doc, sourceUri: "api-v2.md" }], history });
    const state = await engine.waitForRun(run.id);
    expect(readdirSync(runDir)).toEqual(["api-v2.md"]);
    const out = state.nodes.find((n) => n.nodeId === "A.api_contract")?.output as { apiContractFiles: string[]; history: unknown[] };
    expect(out.apiContractFiles).toEqual([join(runDir, "api-v2.md")]);
    expect(out.history).toHaveLength(2);
    const reviewPrompts = h.db.artifacts.listByRun(run.id).filter((a) => a.name === "A.review-attempt1.md");
    const latest = reviewPrompts.at(-1);
    expect(latest && h.artifacts.readText(latest.id)).toContain("api-v2.md");
    expect(latest && h.artifacts.readText(latest.id)).not.toContain("errors.md");
  }, 240_000);

  it("runs without a test operations guide and generates the auto-tests again when one is imported", async () => {
    h = await createHarness({ aiFixture: "cancel-order" });
    const engine = h.newEngine();
    const run = await engine.startRun({ projectId: h.projectId, definition: h.definition, inputs: h.createRunInputs() });
    const first = await engine.waitForRun(run.id);
    expect(first.run.status).toBe("completed_with_assumptions");
    // Most features have no operations guide: the step passes and never waits.
    expect(first.nodes.find((n) => n.nodeId === "C2.ops_guide")).toMatchObject({ status: "passed", output: { opsGuideFiles: [] } });
    const generatePrompts = () => h!.db.artifacts.listByRun(run.id).filter((a) => a.name === "C2.generate_tests-attempt1.md");
    expect(h.artifacts.readText(generatePrompts()[0]!.id)).toContain("Không có");

    await engine.retryNode(run.id, "C2.ops_guide", h.importOps() as unknown as Record<string, unknown>);
    const state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("completed_with_assumptions");
    const guide = join(h.dataDir, "projects", h.projectId, "runs", run.id, "files", "ops-guide", "ops-guide.md");
    expect(state.nodes.find((n) => n.nodeId === "C2.ops_guide")?.output).toMatchObject({ opsGuideFiles: [guide] });
    expect(readFileSync(guide, "utf8")).toContain("Tạo đơn hàng");
    // The auto-tests ran again with the guide; test design reads the BA only and was not run again.
    expect(generatePrompts()).toHaveLength(2);
    expect(h.artifacts.readText(generatePrompts().at(-1)!.id)).toContain(guide);
    const at = (s: typeof first, id: string) => s.nodes.find((n) => n.nodeId === id)?.finishedAt;
    expect(at(state, "C1.test_design")).toBe(at(first, "C1.test_design"));
    expect(h.db.artifacts.listByRun(run.id).filter((a) => a.name === "C1.test_design-attempt1.md")).toHaveLength(1);
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
