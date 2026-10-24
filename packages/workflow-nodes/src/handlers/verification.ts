import { GitCli } from "@frontflow/git-adapter";
import { NodeError, type NodeExecutionContext, type NodeHandler, type NodeInput, type NodeResult } from "@frontflow/workflow-engine";
import { reportStep, type ReportJudgement, type ReportOutput } from "../ai-step.js";
import { failedGates, runGates, type GateResult } from "../gates.js";
import type { NodeServices } from "../services.js";
import { featureOf, knownScripts, optionalUpstream, plural, profileOf, projectOf, runInputs, saveArtifact, upstream, workspaceOf } from "../util.js";
import { checkpointRun, requireGitProject } from "./project.js";
import { opsGuideOf, type TestDesignOutput } from "./test-design.js";

export interface BackendOutput {
  available: boolean;
  baseUrl?: string;
  reason: string;
  verificationLevel: "provider_verified" | "contract_only";
  gates: GateResult[];
}

/** The agent's report on the acceptance tests it ran (`acceptance-tests.md`), and what it changed fixing them. */
export interface AcceptanceRunOutput extends ReportOutput {
  verificationLevel: "business_verified" | "integration_verified" | "contract_only";
  filesChanged: string[];
  diffArtifactId?: string;
}

export function verificationHandlers(services: NodeServices): Record<string, NodeHandler> {
  return {
    "integration.check_backend": {
      async execute(ctx, input) {
        const baseUrl = runInputs(input).providerBaseUrl;
        const contractOnly = (reason: string): NodeResult => {
          ctx.log("warn", `Contract-only: ${reason}. The feature will not be reported as runtime verified.`);
          // Spec §13.6: without a runtime backend the result may only claim contract-level verification.
          const output: BackendOutput = { available: false, reason, verificationLevel: "contract_only", gates: [], ...(baseUrl ? { baseUrl } : {}) };
          return { status: "passed", output, assumed: true };
        };
        if (!baseUrl) return contractOnly("no backend URL configured for this run");

        const { rootPath } = await projectOf(ctx, services);
        const decision = services.policy.evaluate({ permission: "network_access", action: `Probe backend ${baseUrl}`, projectRoot: rootPath, integration: "provider-verification", source: "system" });
        if (decision.effect !== "allow" || !services.probeProvider) return contractOnly(`network access not allowed (${decision.reason})`);
        ctx.log("info", `Probing backend ${baseUrl}`);
        if (!(await services.probeProvider(baseUrl, ctx.signal))) return contractOnly(`backend ${baseUrl} did not respond`);

        const profile = await profileOf(ctx, services, input);
        if (!profile?.commands["providerVerify"]) return contractOnly("backend is reachable but the project has no providerVerify command");
        const gates = await runGates(ctx, services, { profile, gates: ["provider-verification"], cwd: rootPath, projectRoot: rootPath });
        if (failedGates(gates).length) throw new NodeError("COMMAND_FAILED", "Provider verification failed", { retryable: true });
        const output: BackendOutput = { available: true, baseUrl, reason: "provider verified", verificationLevel: "provider_verified", gates };
        return { status: "passed", output };
      },
    },

    "test.acceptance": {
      async execute(ctx, input) {
        return acceptanceTests(ctx, services, input);
      },
    },
  };
}

/**
 * C2 (spec §14.3): the agent runs the feature's acceptance tests the project's way, fixes the
 * implementation and test-generation gaps it finds, and reports in `acceptance-tests.md`.
 * FrontFlow runs no test command itself; it only reads the report's conclusion (`Đạt` /
 * `Chưa đạt`), and anything but `Đạt` waits for the user. The fixes are checkpointed like any
 * code-changing step.
 */
async function acceptanceTests(ctx: NodeExecutionContext, services: NodeServices, input: NodeInput): Promise<NodeResult> {
  const workspace = await workspaceOf(ctx, services, input);
  await requireGitProject(workspace);
  const profile = await profileOf(ctx, services, input);
  const tests = upstream<TestDesignOutput>(input, "C1.test_design");
  // Without the integration lane there is no backend check: the result can only be contract-level.
  const backend = optionalUpstream<BackendOutput>(input, "B2.check_backend") ?? { verificationLevel: "contract_only" as const };

  const before = await checkpointRun(services, ctx, workspace, `frontflow: before ${ctx.nodeId}`);
  const result = await reportStep(ctx, services, input, {
    fileName: "acceptance-tests.md",
    label: "Acceptance tests",
    cwd: workspace.projectPath,
    vars: { feature: featureOf(input), testDesign: tests.reportPath, opsGuide: opsGuideOf(input) },
    allowedCommands: knownScripts(profile),
    gate: {
      judge: judgeAcceptance,
      notEnough: "Some acceptance tests still fail (see the report). Fix the BA specification, the design or the API and run this step again, or accept to continue (recorded as assumptions).",
      unknown: "The acceptance test report has no clear Đạt / Chưa đạt conclusion. Read it, then run the step again or accept to continue (recorded as assumptions).",
    },
  });
  const checkpoint = await checkpointRun(services, ctx, workspace, `frontflow: ${ctx.nodeId}`);
  const diff = await new GitCli(workspace.projectPath).diff({ from: before.headSha, to: checkpoint.headSha });
  const diffArtifactId = diff.patch ? await saveArtifact(ctx, services, "diff", `${ctx.nodeId}.diff`, diff.patch, "text/x-diff", "Fixes in this step") : undefined;
  const filesChanged = diff.files.map((f) => f.path);
  if (filesChanged.length) ctx.log("info", `Checkpoint ${checkpoint.headSha.slice(0, 10)}: ${plural(filesChanged.length, "file")} changed while fixing the tests`);

  if (result.status !== "passed" && result.status !== "waiting_for_input") return result;
  const report = result.output as ReportOutput;
  const passed = report.verdict === "enough";
  const verificationLevel: AcceptanceRunOutput["verificationLevel"] = backend.verificationLevel === "contract_only" ? "contract_only" : passed ? "business_verified" : "integration_verified";
  const output: AcceptanceRunOutput = { ...report, verificationLevel, filesChanged, ...(diffArtifactId ? { diffArtifactId } : {}) };
  if (result.status === "waiting_for_input") return { ...result, output };
  ctx.log(passed ? "info" : "warn", `Verification level: ${verificationLevel}`);
  return { status: "passed", output, assumed: result.assumed || verificationLevel !== "business_verified" };
}

/** The acceptance report's conclusion: the first line under "## Kết luận" is `Đạt` or `Chưa đạt`. */
export function judgeAcceptance(report: string): ReportJudgement {
  const m = /^#{1,6}\s*Kết luận\s*\n\s*[*_`]*\s*(Chưa đạt|Đạt)(?=[\s*_`.:,;!-]|$)/imu.exec(report.normalize("NFC"));
  const found = m?.[1]?.toLowerCase();
  if (!found) return { summary: "no Đạt / Chưa đạt conclusion found" };
  return found === "đạt" ? { verdict: "enough", summary: "Đạt" } : { verdict: "not_enough", summary: "Chưa đạt" };
}
