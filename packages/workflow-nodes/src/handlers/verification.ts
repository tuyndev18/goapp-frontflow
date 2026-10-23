import type { TestFailureCause } from "@frontflow/domain";
import { NodeError, type NodeExecutionContext, type NodeHandler, type NodeInput, type NodeResult } from "@frontflow/workflow-engine";
import { extractJson, runAgentStep } from "../agent.js";
import { describeFailures, failedGates, runGates, type GateResult } from "../gates.js";
import { SYSTEM_PROMPT, readinessDigest, testCaseList, untrusted } from "../prompts.js";
import type { NodeServices } from "../services.js";
import { json, knownScripts, plural, profileOf, projectOf, runInputs, saveArtifact, upstream, workspaceOf } from "../util.js";
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

/** Implemented Feature Package (spec §5 B): the implementation gates the feature passed. */
export interface QualityOutput {
  gates: GateResult[];
  fixAttempts: number;
  verificationLevel: "integration_verified" | "contract_only";
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
        const gates = await runGates(ctx, services, { profile, gates: ["provider-verification"], cwd: workspaceOf(input).projectPath, projectRoot: rootPath });
        if (failedGates(gates).length) throw new NodeError("COMMAND_FAILED", "Provider verification failed", { retryable: true });
        const output: BackendOutput = { available: true, baseUrl, reason: "provider verified", verificationLevel: "provider_verified", gates };
        return { status: "passed", output };
      },
    },

    "test.quality_gates": {
      async execute(ctx, input) {
        return qualityGates(ctx, services, input);
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
 * Implementation gates with the spec §5 B fix loop: on failure the AI diagnoses
 * and fixes in the project folder, then all gates re-run, until the fix budget is
 * spent. The node never loops forever (DoD #11) and ends blocked with evidence.
 * E2E belongs to the BA acceptance run (C2), not to these gates.
 */
async function qualityGates(ctx: NodeExecutionContext, services: NodeServices, input: NodeInput): Promise<NodeResult> {
  const workspace = workspaceOf(input);
  const { rootPath } = await projectOf(ctx, services);
  const profile = await profileOf(ctx, services, input);
  const pkg = upstream<ReadinessOutput>(input, "A.readiness");
  const backend = upstream<BackendOutput>(input, "B2.check_backend");
  const configured = Object.entries(profile?.qualityGates ?? {})
    .filter(([, req]) => req === "required" || req === "optional")
    .map(([name, req]) => [toGateId(name), req] as const)
    .filter(([gate]) => gate !== "e2e-test" && gate !== "provider-verification");
  const gates = configured.map(([gate]) => gate);
  const required = new Set(configured.filter(([, r]) => r === "required").map(([g]) => g));
  const budget = services.settings().fixBudget;
  ctx.log("info", `Implementation gates: ${gates.join(", ") || "none configured"} (AI fix budget ${budget})`);

  let results: GateResult[] = [];
  let fixAttempts = 0;
  for (;;) {
    results = await runGates(ctx, services, { profile, gates, cwd: workspace.projectPath, projectRoot: rootPath, fallbacks: { "consumer-contract-test": "unitTest" } });
    const blocking = failedGates(results).filter((r) => required.has(r.gate));
    if (blocking.length === 0) break;
    if (fixAttempts >= budget) {
      const summary = `Required gates still failing after ${fixAttempts} fix attempt(s): ${blocking.map((b) => b.gate).join(", ")}`;
      ctx.log("error", summary);
      await saveArtifact(ctx, services, "evidence", "quality-gates-blocked.md", `# Blocked\n\n${summary}\n\n${describeFailures(results)}`, "text/markdown", "Blocker evidence");
      return { status: "blocked", summary, output: { gates: results, fixAttempts } };
    }
    fixAttempts += 1;
    ctx.log("warn", `${blocking.map((b) => b.gate).join(", ")} failed — AI fix attempt ${fixAttempts}/${budget}`);
    await runAgentStep(ctx, services, {
      projectId: ctx.projectId,
      adapterId: runInputs(input).adapterId,
      cwd: workspace.projectPath,
      prompt: [
        "Required implementation gates failed. Diagnose the root cause from the output below and fix the code or tests. Do not weaken, skip or delete tests to make them pass.",
        untrusted("gate-output", describeFailures(results), 12_000),
        readinessDigest(pkg),
      ].join("\n\n"),
      systemPrompt: SYSTEM_PROMPT,
      readOnly: false,
      allowedCommands: knownScripts(profile),
      projectSettings: true,
    });
    await checkpointRun(services, ctx, workspace, `frontflow: implementation gate fix ${fixAttempts}`);
  }

  const output: QualityOutput = { gates: results, fixAttempts, verificationLevel: backend.verificationLevel === "contract_only" ? "contract_only" : "integration_verified" };
  ctx.log("info", `All required implementation gates passed${fixAttempts ? ` after ${fixAttempts} fix attempt(s)` : ""}; verification level: ${output.verificationLevel}`);
  await saveArtifact(ctx, services, "test_result", "implementation-gates.json", json(output), "application/json", "Implementation gates");
  const optionalFailed = failedGates(results).length > 0;
  const notConfigured = results.some((r) => r.status === "not_configured" && required.has(r.gate));
  return { status: "passed", output, assumed: output.verificationLevel === "contract_only" || optionalFailed || notConfigured };
}

/**
 * C2 (spec §14.3): run the generated acceptance tests on the integrated feature.
 * A failure is first classified; implementation and test-generation gaps go
 * through the bounded AI fix loop, while specification, design and API gaps
 * stop the run blocked with evidence, because code must not paper over them.
 */
async function acceptanceTests(ctx: NodeExecutionContext, services: NodeServices, input: NodeInput): Promise<NodeResult> {
  const workspace = workspaceOf(input);
  const { rootPath } = await projectOf(ctx, services);
  const profile = await profileOf(ctx, services, input);
  const tests = upstream<TestDesignOutput>(input, "C1.test_design");
  const pkg = upstream<ReadinessOutput>(input, "A.readiness");
  const backend = upstream<BackendOutput>(input, "B2.check_backend");
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
    await saveArtifact(ctx, services, "evidence", "acceptance-blocked.md", `# Blocked\n\n${summary}\n\n${analyses.map((a) => `- attempt ${a.attempt}: **${a.cause}** (${a.testCaseIds.join(", ") || "?"}) ${a.explanation}`).join("\n")}\n\n${describeFailures(results)}`, "text/markdown", "Blocker evidence");
    return { status: "blocked", summary, output: { gates: results, fixAttempts, analyses } };
  };
  for (;;) {
    results = await runGates(ctx, services, { profile, gates, cwd: workspace.projectPath, projectRoot: rootPath, scenarioIds: testCaseIds });
    if (results.every((r) => r.status === "not_configured")) {
      return { status: "blocked", summary: "No unit or e2e test command in the project profile; the acceptance tests cannot run. Add one under Project overview → profile.", output: { gates: results } };
    }
    const failures = failedGates(results);
    if (failures.length === 0) break;
    if (fixAttempts >= budget) return blocked(`Acceptance tests still failing after ${fixAttempts} fix attempt(s): ${failures.map((f) => f.gate).join(", ")}`);
    fixAttempts += 1;
    ctx.log("warn", `${failures.map((f) => f.gate).join(", ")} failed — AI root-cause analysis ${fixAttempts}/${budget}`);
    const agent = await runAgentStep(ctx, services, {
      projectId: ctx.projectId,
      adapterId: runInputs(input).adapterId,
      cwd: workspace.projectPath,
      prompt: [
        "Acceptance tests generated from the BA specification failed. First classify the root cause:",
        "- implementation_gap: the feature does not do what the BA, design and API contract say;",
        "- test_generation_gap: the test does not implement its test case correctly (selectors, setup, mocks), while its expected outcome is right;",
        "- specification_gap, design_gap or api_gap: the BA, the design or the API contract is missing something or contradicts another source.",
        "Fix the code only for implementation_gap or test_generation_gap. Never change an expected outcome that comes from the BA, and never weaken, skip or delete a test to make it pass. For the other causes change nothing.",
        "Finish your answer with a fenced ```json block: {\"cause\": \"implementation_gap\"|\"test_generation_gap\"|\"specification_gap\"|\"design_gap\"|\"api_gap\", \"testCaseIds\": string[], \"explanation\": string}.",
        untrusted("test-output", describeFailures(results), 12_000),
        "Acceptance test cases:",
        testCaseList(runnable),
        readinessDigest(pkg),
      ].join("\n\n"),
      systemPrompt: SYSTEM_PROMPT,
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
    if (!FIXABLE.has(cause)) return blocked(`Acceptance tests fail because of a ${cause.replace("_", " ")}; update the ${cause === "specification_gap" ? "BA specification" : cause === "design_gap" ? "Figma design" : "API contract"} and start a new run`);
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

/** Profile gate names (unitTest, contractTest, e2e) → gate ids used by runGates. */
function toGateId(name: string): string {
  const map: Record<string, string> = {
    unitTest: "unit-test",
    contractTest: "consumer-contract-test",
    e2e: "e2e-test",
    integrationTest: "integration-test",
    providerVerify: "provider-verification",
  };
  return map[name] ?? name;
}
