import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowLibrary } from "@frontflow/workflow-engine";
import { checkWorkflowNodes, ProjectPromptStore, PromptLibrary, stepsWithoutPrompt, type ManualCheckOutput, type PromptStepOutput } from "@frontflow/workflow-nodes";
import { createHarness, REPO_ROOT, type Harness } from "./harness.js";

/**
 * A workflow the user made: generic steps whose prompts are all they are (`ai.prompt`, run by the
 * agent in the project), a person checking the result (`manual.check`), and the project's and the
 * feature's own additions appended to a step's prompt.
 */
describe("user-made workflow", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  it("runs prompt steps with the project's and the feature's additions, then waits for the manual check", async () => {
    h = await createHarness({ aiFixture: "custom-workflow" });
    const workflows = new WorkflowLibrary({ builtinDir: join(REPO_ROOT, "workflows"), userDir: join(h.dir, "workflows"), check: checkWorkflowNodes });
    const definition = workflows.save({
      id: "quick-feature",
      name: "Quick feature",
      lanes: [{ id: "build", title: "Build" }, { id: "check", title: "Check" }],
      nodes: [
        { id: "implement", type: "ai.prompt", label: "Implement", group: "build", mutation: true, config: { ai: true } },
        { id: "summarize", type: "ai.prompt", label: "Summarize", group: "build", mutation: true, config: { ai: true }, dependencies: ["implement"] },
        { id: "review", type: "manual.check", label: "Review", group: "check", dependencies: ["summarize"] },
      ],
    });

    const prompts = h.services.prompts as PromptLibrary;
    expect(stepsWithoutPrompt(definition, prompts)).toEqual(["implement", "summarize", "review"]);
    prompts.save("implement", definition.id, "Implement {{feature}}.");
    prompts.save("summarize", definition.id, "Write {{output}}: a summary of {{feature}}.");
    prompts.save("review", definition.id, "Open {{feature}} in the browser and compare it with the design.\n\nSummary: {{reports}}");
    expect(stepsWithoutPrompt(definition, prompts)).toEqual([]);

    const additionsDir = mkdtempSync(join(tmpdir(), "ff-additions-"));
    const additions = new ProjectPromptStore((projectId) => join(additionsDir, projectId, "prompt-additions.json"));
    additions.set(h.projectId, definition.id, "implement", [
      { title: "Tokens", text: "Use the design tokens in src/theme.", enabled: true },
      { title: "Off", text: "Never sent.", enabled: false },
    ]);
    h.services.prompts = {
      get: (name, workflowId) => prompts.get(name, workflowId),
      additions: (...args) => additions.list(...args),
      featureAdditions: (_runId, _workflowId, nodeId) => (nodeId === "implement" ? [{ id: "pa_f", title: "", text: "Only the cancel button changes.", enabled: true }] : []),
    };

    const engine = h.newEngine();
    const run = await engine.startRun({ projectId: h.projectId, definition, inputs: h.createRunInputs({ importLater: true }) });
    let state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("waiting");
    const byId = () => new Map(state.nodes.map((n) => [n.nodeId, n]));

    // The agent ran each prompt in the project; the code-changing step was snapshotted.
    const implement = byId().get("implement");
    expect(implement?.status).toBe("passed");
    expect((implement?.output as PromptStepOutput).filesChanged).toContain("fake-output.txt");
    expect((implement?.output as PromptStepOutput).report).toBeUndefined();
    const sent = (name: string) => h!.artifacts.readText(h!.db.artifacts.listByRun(run.id).find((a) => a.name === name)!.id);
    const implementPrompt = sent("implement-attempt1.md");
    expect(implementPrompt).toMatch(
      /^Implement Run t_\w+\.\n\n## Additional instructions for this project\n\n### Tokens\nUse the design tokens in src\/theme\.\n\n## Additional instructions for this feature\n\nOnly the cancel button changes\.$/,
    );

    // The summary the agent wrote is the step's result, for the next steps.
    const runDir = join(h.dataDir, "projects", h.projectId, "runs", run.id, "files");
    const summary = byId().get("summarize")?.output as PromptStepOutput;
    expect(summary).toMatchObject({ reportPath: join(runDir, "summarize.md"), report: expect.stringContaining("Đã dựng màn hình hủy đơn") });
    expect(readFileSync(summary.reportPath!, "utf8")).toBe(summary.report);

    // The manual check shows its checklist and waits for a person.
    const review = byId().get("review");
    expect(review?.status).toBe("waiting_for_input");
    expect((review?.output as ManualCheckOutput).report).toContain(`Summary: ${summary.reportPath}`);

    await engine.provideInput(run.id, "review", { note: "Looks like the design" });
    state = await engine.waitForRun(run.id);
    expect(state.run.status).toBe("completed");
    expect(byId().get("review")?.output).toMatchObject({ note: "Looks like the design", checkedAt: expect.any(String) });
  });
});
