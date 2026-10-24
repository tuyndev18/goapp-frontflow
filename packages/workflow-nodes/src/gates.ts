import { newId, type ProjectProfile, type TestResult } from "@frontflow/domain";
import { createAgentEvent } from "@frontflow/event-schema";
import type { NodeExecutionContext } from "@frontflow/workflow-engine";
import { parseTestSummary, runProjectCommand, tail } from "./commands.js";
import type { NodeServices } from "./services.js";
import { knownScripts, saveArtifact } from "./util.js";

/** Gate id → profile command name (spec §15.2). */
export const GATE_COMMANDS: Record<string, string> = {
  build: "build",
  typecheck: "typecheck",
  lint: "lint",
  "unit-test": "unitTest",
  "consumer-contract-test": "contractTest",
  "provider-verification": "providerVerify",
  "integration-test": "integrationTest",
  "e2e-test": "e2e",
  accessibility: "a11y",
};

const TEST_KINDS: Record<string, TestResult["kind"]> = {
  "unit-test": "unit",
  "consumer-contract-test": "contract",
  "provider-verification": "contract",
  "integration-test": "integration",
  "e2e-test": "e2e",
  accessibility: "accessibility",
};

export interface GateResult {
  gate: string;
  command?: string;
  status: "passed" | "failed" | "not_configured";
  exitCode?: number | null;
  passed?: number;
  failed?: number;
  skipped?: number;
  outputTail?: string;
  artifactId?: string;
  testResultId?: string;
}

export interface RunGatesOptions {
  profile: ProjectProfile | undefined;
  gates: string[];
  cwd: string;
  projectRoot: string;
  scenarioIds?: string[];
  /** Override for a gate's command, e.g. fall back to unitTest for contract tests. */
  fallbacks?: Record<string, string>;
}

export async function runGates(ctx: NodeExecutionContext, services: NodeServices, options: RunGatesOptions): Promise<GateResult[]> {
  const results: GateResult[] = [];
  const commands = options.profile?.commands ?? {};
  for (const gate of options.gates) {
    const commandName = GATE_COMMANDS[gate] ?? gate;
    const fallbackName = options.fallbacks?.[gate];
    const command = commands[commandName] ?? (fallbackName ? commands[fallbackName] : undefined);
    if (!command) {
      results.push({ gate, status: "not_configured" });
      continue;
    }
    const outcome = await runProjectCommand(ctx, services, {
      command,
      cwd: options.cwd,
      projectRoot: options.projectRoot,
      activeRoot: options.cwd,
      knownScripts: knownScripts(options.profile),
      timeoutMs: services.settings().commandTimeoutMs,
      label: `Quality gate ${gate}`,
    });
    const ok = outcome.exitCode === 0 && !outcome.timedOut;
    const log = `$ ${command}\n(exit ${outcome.exitCode}${outcome.timedOut ? ", timed out" : ""}, ${outcome.durationMs} ms)\n\n${outcome.output}`;
    const artifactId = await saveArtifact(ctx, services, "test_result", `${gate}.log`, log, "text/plain", `${gate} output`);
    const result: GateResult = { gate, command, status: ok ? "passed" : "failed", exitCode: outcome.exitCode, outputTail: tail(outcome.output), artifactId };

    const kind = TEST_KINDS[gate];
    if (kind) {
      const summary = parseTestSummary(outcome.output);
      const counts = summary.parsed ? summary : { passed: ok ? 1 : 0, failed: ok ? 0 : 1, skipped: 0 };
      Object.assign(result, { passed: counts.passed, failed: counts.failed, skipped: counts.skipped });
      const testResult: TestResult = {
        id: newId("test"),
        workflowRunId: ctx.runId,
        nodeRunId: ctx.nodeRunId,
        suite: gate,
        kind,
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
        durationMs: outcome.durationMs,
        scenarioIds: options.scenarioIds ?? [],
        artifactId,
      };
      result.testResultId = testResult.id;
      await services.recordTestResult?.(testResult);
      ctx.emit(
        createAgentEvent(
          "test.result",
          { traceId: ctx.traceId, workflowRunId: ctx.runId, nodeRunId: ctx.nodeRunId },
          { suite: gate, passed: counts.passed, failed: counts.failed, skipped: counts.skipped },
        ),
      );
    }
    results.push(result);
  }
  return results;
}

export function failedGates(results: GateResult[]): GateResult[] {
  return results.filter((r) => r.status === "failed");
}
