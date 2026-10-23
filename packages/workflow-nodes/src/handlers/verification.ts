import type { TestFailureCause } from "@frontflow/domain";
import { NodeError, type NodeExecutionContext, type NodeHandler, type NodeInput, type NodeResult } from "@frontflow/workflow-engine";
import { extractJson, runAgentStep } from "../agent.js";
import { describeFailures, failedGates, runGates, type GateResult } from "../gates.js";
import { stepPrompt, systemPrompt } from "../ai-step.js";
import { readinessDigest, testCaseList, untrusted } from "../prompts.js";
import type { NodeServices } from "../services.js";
import { featureOf, json, knownScripts, optionalUpstream, plural, profileOf, projectOf, runInputs, saveArtifact, upstream, workspaceOf, claudeAccountOf } from "../util.js";
import { checkpointRun } from "./project.js";
import type { ReadinessOutput } from "./readiness.js";
import type { TestDesignOutput } from "./test-design.js";

export interface BackendOutput {
  available: boolean;
  baseUrl?: string;
  reason: string;
  verificationLevel: "provider_verified" | "contract_only";
  gates: GateResult[];
}

export interface FailureAnalysis {
  attempt: number;
  cause: TestFailureCause;
  testCaseIds: string[];
  explanation: string;
}

export interface AcceptanceRunOutput {
  gates: GateResult[];
  fixAttempts: number;
  analyses: FailureAnalysis[];
  /** Test cases that ran and passed; blocked ones never ran. */
  executedTestCaseIds: string[];
  verificationLevel: "business_verified" | "integration_verified" | "contract_only";
}

const CAUSES: readonly TestFailureCause[] = ["specification_gap", "design_gap", "api_gap", "test_generation_gap", "implementation_gap"];
/** Causes the AI may fix in code; the others need the BA, the design or the API to change (spec §14.3). */
const FIXABLE: ReadonlySet<TestFailureCause> = new Set(["test_generation_gap", "implementation_gap"]);

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
 * C2 (spec §14.3): run the generated acceptance tests on the integrated feature.
 * A failure is first classified; implementation and test-generation gaps go
 * through the bounded AI fix loop, while specification, design and API gaps
 * stop the run blocked with evidence, because code must not paper over them.
 */
async function acceptanceTests(ctx: NodeExecutionContext, services: NodeServices, input: NodeInput): Promise<NodeResult> {
  const workspace = await workspaceOf(ctx, services, input);
  const rootPath = workspace.projectPath;
  const profile = await profileOf(ctx, services, input);
  const tests = upstream<TestDesignOutput>(input, "C1.test_design");
  const pkg = upstream<ReadinessOutput>(input, "A.review");
  // Without the integration lane there is no backend check: the result can only be contract-level.
  const backend = optionalUpstream<BackendOutput>(input, "B2.check_backend") ?? { verificationLevel: "contract_only" as const };
  const runnable = tests.testCases.filter((t) => t.automationStatus !== "blocked");
  const testCaseIds = runnable.map((t) => t.id);
  const gates = ["unit-test", "e2e-test"];
  const budget = services.settings().fixBudget;
  ctx.log("info", `Running ${plural(runnable.length, "acceptance test case")} with ${gates.join(", ")} (AI fix budget ${budget})`);

  let results: GateResult[] = [];
  let fixAttempts = 0;
  const analyses: FailureAnalysis[] = [];
  const blocked = async (summary: string): Promise<NodeResult> => {
    ctx.log("error", summary);
    await saveArtifact(
      ctx,
      services,
      "evidence",
      "acceptance-blocked.md",
      `# Blocked\n\n${summary}\n\n${analyses.map((a) => `- attempt ${a.attempt}: **${a.cause}** (${a.testCaseIds.join(", ") || "?"}) ${a.explanation}`).join("\n")}\n\n${describeFailures(results)}`,
      "text/markdown",
      "Blocker evidence",
    );
    return { status: "blocked", summary, output: { gates: results, fixAttempts, analyses } };
  };
  for (;;) {
    results = await runGates(ctx, services, { profile, gates, cwd: workspace.projectPath, projectRoot: rootPath, scenarioIds: testCaseIds });
    if (results.every((r) => r.status === "not_configured")) {
      return {
        status: "blocked",
        summary: "No unit or e2e test command in the project profile; the acceptance tests cannot run. Add one under Project overview → profile.",
        output: { gates: results },
      };
    }
    const failures = failedGates(results);
    if (failures.length === 0) break;
    if (fixAttempts >= budget) return blocked(`Acceptance tests still failing after ${fixAttempts} fix attempt(s): ${failures.map((f) => f.gate).join(", ")}`);
    fixAttempts += 1;
    ctx.log("warn", `${failures.map((f) => f.gate).join(", ")} failed — AI root-cause analysis ${fixAttempts}/${budget}`);
    const agent = await runAgentStep(ctx, services, {
      projectId: ctx.projectId,
      adapterId: runInputs(input).adapterId,
      ...claudeAccountOf(input),
      cwd: workspace.projectPath,
      prompt: await stepPrompt(ctx, services, {
        feature: featureOf(input),
        failures: untrusted("test-output", describeFailures(results), 12_000),
        testCases: testCaseList(runnable),
        readiness: readinessDigest(pkg),
      }),
      systemPrompt: systemPrompt(services),
      readOnly: false,
      allowedCommands: knownScripts(profile),
      projectSettings: true,
    });
    const raw = extractJson<{ cause?: unknown; testCaseIds?: unknown; explanation?: unknown }>(agent.resultText);
    const cause = CAUSES.includes(raw?.cause as TestFailureCause) ? (raw!.cause as TestFailureCause) : "implementation_gap";
    if (!raw) ctx.log("warn", "The AI did not classify the failure; treating it as an implementation gap");
    const analysis: FailureAnalysis = {
      attempt: fixAttempts,
      cause,
      testCaseIds: Array.isArray(raw?.testCaseIds) ? raw!.testCaseIds.filter((id): id is string => typeof id === "string") : [],
      explanation: typeof raw?.explanation === "string" ? raw.explanation : "",
    };
    analyses.push(analysis);
    ctx.log(FIXABLE.has(cause) ? "warn" : "error", `Root cause: ${cause}${analysis.explanation ? ` — ${analysis.explanation}` : ""}`);
    if (!FIXABLE.has(cause))
      return blocked(
        `Acceptance tests fail because of a ${cause.replace("_", " ")}; update the ${cause === "specification_gap" ? "BA specification" : cause === "design_gap" ? "Figma design" : "API contract"} and start a new run`,
      );
    await checkpointRun(services, ctx, workspace, `frontflow: acceptance fix ${fixAttempts}`);
  }

  const e2eRan = results.some((r) => r.gate === "e2e-test" && r.status === "passed");
  const output: AcceptanceRunOutput = {
    gates: results,
    fixAttempts,
    analyses,
    executedTestCaseIds: testCaseIds,
    verificationLevel: backend.verificationLevel === "contract_only" ? "contract_only" : e2eRan ? "business_verified" : "integration_verified",
  };
  ctx.log("info", `Acceptance tests passed${fixAttempts ? ` after ${fixAttempts} fix attempt(s)` : ""}; verification level: ${output.verificationLevel}`);
  await saveArtifact(ctx, services, "test_result", "acceptance-tests.json", json(output), "application/json", "Acceptance tests");
  const skippedRequirements = tests.coverage.blockedRequirements > 0 || tests.coverage.requirementsWithTests < tests.coverage.totalRequirements;
  return { status: "passed", output, assumed: output.verificationLevel !== "business_verified" || skippedRequirements };
}

