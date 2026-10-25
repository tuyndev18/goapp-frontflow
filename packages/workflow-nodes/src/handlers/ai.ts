import { existsSync } from "node:fs";
import { GitCli } from "@frontflow/git-adapter";
import { NodeError, type NodeExecutionContext, type NodeHandler, type NodeInput, type NodeResult } from "@frontflow/workflow-engine";
import { runAgentStep } from "../agent.js";
import { fileList, runFolder, stepPrompt, systemPrompt } from "../ai-step.js";
import { untrusted } from "../prompts.js";
import type { NodeServices } from "../services.js";
import { featureOf, knownScripts, plural, profileOf, runInputs, saveArtifact, upstream, workspaceOf, claudeAccountOf } from "../util.js";
import type { FigmaDesignOutput } from "./figma.js";
import { checkpointRun, requireGitProject } from "./project.js";
import type { ReadinessOutput } from "./readiness.js";
import { opsGuideOf, type TestDesignOutput } from "./test-design.js";

export interface MutationOutput {
  sessionId: string;
  filesChanged: string[];
  checkpointId: string;
  checkpointSha: string;
  diffArtifactId?: string;
  attempt: number;
  visual?: { status: "reference_only"; references: Array<{ nodeId: string; artifactId: string }> };
}

/**
 * Code-changing AI steps. Each one only fills the placeholders of its editable prompt
 * (workflows/prompts/<step id>.md); the agent reads the project itself.
 */
export function aiHandlers(services: NodeServices): Record<string, NodeHandler> {
  return {
    "ai.implement_ui": {
      async execute(ctx, input) {
        const design = upstream<FigmaDesignOutput>(input, "B1.figma_scope");
        const result = await mutationStep(ctx, services, input, {
          vars: { figma: untrusted("figma-handoff", `GoApp Figma selection ${design.handoffId} from "${design.projectName}":\n${design.prompt}`) },
          figma: true,
        });
        if (result.status === "passed") {
          // Pixel diffing is an open decision (spec §27 #5); the AI does not compare either: the user reviews the UI.
          ctx.log("info", `Visual check: reference only for ${plural(design.nodes.length, "Figma layer")} (automatic pixel diff not configured)`);
          (result.output as MutationOutput).visual = { status: "reference_only", references: design.nodes.map((n) => ({ nodeId: n.nodeId, artifactId: design.snapshotArtifactId })) };
        }
        return result;
      },
    },

    "ai.api_integration": {
      async execute(ctx, input) {
        const review = upstream<ReadinessOutput>(input, "A.review");
        ctx.log("info", `Binding the API to the UI following the review ${review.reportPath}`);
        return mutationStep(ctx, services, input, { vars: { apiContract: fileList(review.apiContractFiles), review: review.reportPath } });
      },
    },

    "ai.bind_ui_states": {
      async execute(ctx, input) {
        const review = upstream<ReadinessOutput>(input, "A.review");
        const backend = upstream<{ verificationLevel: string }>(input, "B2.check_backend");
        return mutationStep(ctx, services, input, {
          vars: {
            apiContract: fileList(review.apiContractFiles),
            review: review.reportPath,
            backendNote: backend.verificationLevel === "contract_only" ? "Note: the backend runtime is not available; only contract-level verification is possible." : "",
          },
        });
      },
    },

    "ai.acceptance_tests": {
      async execute(ctx, input) {
        const tests = upstream<TestDesignOutput>(input, "C1.test_design");
        ctx.log("info", `Generating the acceptance tests of the test design ${tests.reportPath}`);
        return mutationStep(ctx, services, input, { vars: { testDesign: tests.reportPath, opsGuide: opsGuideOf(input) } });
      },
    },
  };
}

/**
 * Code-changing AI step: snapshot the project folder, let the agent work there on the step's
 * prompt, then a second snapshot closes the step and the diff between the two is kept as
 * evidence. FrontFlow runs no build/typecheck/lint gates after the agent; checking its own
 * work is part of the step's prompt.
 */
export async function mutationStep(
  ctx: NodeExecutionContext,
  services: NodeServices,
  input: NodeInput,
  options: { vars: Record<string, string>; figma?: boolean },
): Promise<NodeResult> {
  const workspace = await workspaceOf(ctx, services, input);
  if (!existsSync(workspace.projectPath)) throw new NodeError("CHECKPOINT_INVALIDATED", `Project folder ${workspace.projectPath} no longer exists`);
  await requireGitProject(workspace);
  const profile = await profileOf(ctx, services, input);

  const prompt = await stepPrompt(ctx, services, { feature: featureOf(input), ...options.vars });

  const before = await checkpointRun(services, ctx, workspace, `frontflow: before ${ctx.nodeId}`);
  const result = await runAgentStep(ctx, services, {
    projectId: ctx.projectId,
    adapterId: runInputs(input).adapterId,
    ...claudeAccountOf(input),
    cwd: workspace.projectPath,
    // The run's workflow files (review, test design) are read from the tool's data.
    addDirs: [runFolder(services, ctx)],
    prompt,
    systemPrompt: systemPrompt(services),
    readOnly: false,
    allowedCommands: knownScripts(profile),
    projectSettings: true,
    ...(options.figma ? { withFigma: true } : {}),
  });
  await saveArtifact(ctx, services, "evidence", `${ctx.nodeId}-answer.md`, result.resultText, "text/markdown", "AI answer");

  const checkpoint = await checkpointRun(services, ctx, workspace, `frontflow: ${ctx.nodeId}`);
  const stepDiff = await new GitCli(workspace.projectPath).diff({ from: before.headSha, to: checkpoint.headSha });
  const diffArtifactId = stepDiff.patch ? await saveArtifact(ctx, services, "diff", `${ctx.nodeId}.diff`, stepDiff.patch, "text/x-diff", "Changes in this step") : undefined;
  const filesChanged = [...new Set([...result.filesChanged, ...stepDiff.files.map((f) => f.path)])];
  const added = stepDiff.files.reduce((n, f) => n + f.additions, 0);
  const removed = stepDiff.files.reduce((n, f) => n + f.deletions, 0);
  ctx.log("info", `Checkpoint ${checkpoint.headSha.slice(0, 10)}: ${plural(filesChanged.length, "file")} changed (+${added} −${removed})`);

  const output: MutationOutput = {
    sessionId: result.sessionId,
    filesChanged,
    checkpointId: checkpoint.id,
    checkpointSha: checkpoint.headSha,
    ...(diffArtifactId ? { diffArtifactId } : {}),
    attempt: ctx.attempt,
  };
  const assumed = /ASSUMPTIONS?:/i.test(result.resultText) && !/ASSUMPTIONS?:\s*(none|n\/a|-)?\s*$/im.test(result.resultText);
  if (assumed) ctx.log("warn", "The AI reported assumptions; see the AI answer in Evidence");
  return { status: "passed", output, assumed };
}
