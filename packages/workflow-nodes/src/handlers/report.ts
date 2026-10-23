import type { TestTraceabilityItem, UiApiTraceabilityItem } from "@frontflow/domain";
import { escapeMarkdownText } from "@frontflow/document-parser";
import type { NodeHandler, NodeInput } from "@frontflow/workflow-engine";
import type { GateResult } from "../gates.js";
import type { NodeServices } from "../services.js";
import { json, optionalUpstream, saveArtifact, upstream } from "../util.js";
import type { MutationOutput } from "./ai.js";
import type { FigmaDesignOutput } from "./figma.js";
import type { ReadinessOutput } from "./readiness.js";
import type { TestDesignOutput } from "./test-design.js";
import type { AcceptanceRunOutput, QualityOutput } from "./verification.js";

const MUTATION_NODES = ["B1.implement_ui", "B2.api_binding", "B2.ui_states", "C2.generate_tests"];
const GATE_NODES = ["B2.check_backend", "B2.quality_gates"];

/** What the renderer's Traceability Matrix reads (spec §20.1 #6). */
export interface TraceabilityReport {
  verificationLevel: AcceptanceRunOutput["verificationLevel"];
  ui: Array<UiApiTraceabilityItem & { name: string }>;
  tests: Array<TestTraceabilityItem & { title: string }>;
  sourceFiles: string[];
  evidenceIds: string[];
}

/**
 * Traceability & evidence report (spec §12.1 A8, §14.4, DoD #10): every UI
 * interaction is linked to Figma, API, code, tests and evidence, and every BA
 * requirement to its generated test cases and their results. Nothing is
 * `verified`/`passed` without passing gates and evidence; contract-only runs stay
 * `assumed` because the runtime API was not exercised (spec §15.1).
 */
export function reportHandlers(services: NodeServices): Record<string, NodeHandler> {
  return {
    "report.evidence": {
      async execute(ctx, input) {
        const pkg = upstream<ReadinessOutput>(input, "A.readiness");
        const tests = upstream<TestDesignOutput>(input, "C1.test_design");
        const acceptance = upstream<AcceptanceRunOutput>(input, "C2.run_tests");
        const design = optionalUpstream<FigmaDesignOutput>(input, "B1.figma_scope");

        const mutations = MUTATION_NODES.map((id) => optionalUpstream<MutationOutput>(input, id)).filter((m): m is MutationOutput => !!m);
        const sourceFiles = [...new Set(mutations.flatMap((m) => m.filesChanged))].sort();
        const gateResults = collectGates(input, acceptance.gates);
        const evidenceIds = [
          ...mutations.flatMap((m) => (m.diffArtifactId ? [m.diffArtifactId] : [])),
          ...gateResults.flatMap((g) => (g.artifactId ? [g.artifactId] : [])),
          ...(design ? [design.snapshotArtifactId] : []),
        ];
        const allPassed = gateResults.every((g) => g.status !== "failed") && gateResults.some((g) => g.status === "passed");
        const testsFailed = gateResults.reduce((n, g) => n + (g.failed ?? 0), 0);
        const runtime = acceptance.verificationLevel !== "contract_only";
        const executed = new Set(acceptance.executedTestCaseIds);
        const blockedReqs = new Set(tests.testabilityGaps.filter((g) => g.blocking).map((g) => g.requirementId));

        const ui = pkg.traceability.map((item) => {
          const reqIds = new Set(item.uiDataRequirementIds);
          const mappings = pkg.mappings.filter((m) => reqIds.has(m.uiDataRequirementId));
          const testIds = tests.testCases.filter((t) => t.uiFlowNodeIds.includes(item.uiFlowNodeId)).map((t) => t.id);
          const allReady = mappings.every((m) => m.status === "ready" || m.status === "fe_only");
          const status: UiApiTraceabilityItem["status"] =
            item.status === "blocked" ? "blocked" : allReady && allPassed && testsFailed === 0 && runtime && evidenceIds.length > 0 && testIds.length > 0 ? "verified" : "assumed";
          return { ...item, name: pkg.uiFlow.find((n) => n.id === item.uiFlowNodeId)?.name ?? item.uiFlowNodeId, sourceFiles, testIds, evidenceIds, status };
        });

        const testTrace = tests.requirements.map((req) => {
          const cases = tests.testCases.filter((t) => t.requirementIds.includes(req.id));
          const ran = cases.filter((t) => executed.has(t.id));
          const status: TestTraceabilityItem["status"] = blockedReqs.has(req.id)
            ? "blocked"
            : ran.length === 0
              ? "untested"
              : testsFailed > 0 || !allPassed
                ? "failed"
                : runtime
                  ? "passed"
                  : "assumed";
          return {
            requirementId: req.id,
            title: req.title,
            testCaseIds: cases.map((t) => t.id),
            uiFlowNodeIds: [...new Set(cases.flatMap((t) => t.uiFlowNodeIds))],
            figmaNodeIds: [...new Set(cases.flatMap((t) => t.figmaNodeIds))],
            apiOperationIds: [...new Set(cases.flatMap((t) => t.apiOperationIds))],
            sourceFiles,
            testIds: ran.map((t) => t.id),
            evidenceIds,
            status,
          };
        });

        const uiCounts = count(ui.map((u) => u.status));
        const testCounts = count(testTrace.map((t) => t.status));
        ctx.log(
          uiCounts["verified"] === ui.length ? "info" : "warn",
          `UI ↔ API traceability: ${uiCounts["verified"] ?? 0} verified, ${uiCounts["assumed"] ?? 0} assumed, ${uiCounts["blocked"] ?? 0} blocked of ${ui.length} — level ${acceptance.verificationLevel}`,
        );
        ctx.log(
          testCounts["passed"] === testTrace.length ? "info" : "warn",
          `BA test traceability: ${testCounts["passed"] ?? 0} passed, ${testCounts["assumed"] ?? 0} assumed, ${testCounts["untested"] ?? 0} untested, ${testCounts["blocked"] ?? 0} blocked of ${testTrace.length}; ${sourceFiles.length} files, ${evidenceIds.length} evidence items`,
        );
        const trace: TraceabilityReport = { verificationLevel: acceptance.verificationLevel, ui, tests: testTrace, sourceFiles, evidenceIds };
        const report = renderEvidenceReport(pkg, tests, acceptance, trace, gateResults, design);
        const reportId = await saveArtifact(ctx, services, "evidence", "evidence-report.md", report, "text/markdown", "Traceability & evidence report");
        await saveArtifact(ctx, services, "evidence", "traceability.json", json(trace), "application/json", "Traceability matrix");
        const output = { verificationLevel: acceptance.verificationLevel, ui: uiCounts, tests: testCounts, reportArtifactId: reportId };
        return { status: "passed", output, assumed: uiCounts["verified"] !== ui.length || testCounts["passed"] !== testTrace.length };
      },
    },
  };
}

function collectGates(input: NodeInput, final: GateResult[]): GateResult[] {
  const fromMutations = MUTATION_NODES.flatMap((id) => optionalUpstream<MutationOutput>(input, id)?.gates ?? []);
  const fromGateNodes = GATE_NODES.flatMap((id) => optionalUpstream<{ gates: GateResult[] }>(input, id)?.gates ?? []);
  return [...fromMutations, ...fromGateNodes, ...final];
}

function count(statuses: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of statuses) out[s] = (out[s] ?? 0) + 1;
  return out;
}

function renderEvidenceReport(
  pkg: ReadinessOutput,
  tests: TestDesignOutput,
  acceptance: AcceptanceRunOutput,
  trace: TraceabilityReport,
  gates: GateResult[],
  design: FigmaDesignOutput | undefined,
): string {
  const esc = (s: string) => escapeMarkdownText(s);
  const lines = [
    "# Traceability & evidence report",
    "",
    `- Run: \`${pkg.runId}\``,
    `- FE readiness: **${pkg.readiness}**`,
    `- Acceptance test design: **${tests.status}** (${tests.coverage.requirementsWithTests}/${tests.coverage.totalRequirements} BA requirements with test cases)`,
    `- Verification level: **${acceptance.verificationLevel}**${acceptance.verificationLevel === "contract_only" ? " — backend runtime not verified" : ""}`,
    `- AI fix attempts in acceptance tests: ${acceptance.fixAttempts}`,
    "",
    "## UI interactions",
    "",
    "| Screen | Figma | UI needs | API | Tests | Trace |",
    "|---|---|---|---|---|---|",
    ...trace.ui.map((u) => `| ${esc(u.name)} | ${u.figmaNodeIds.map(esc).join(", ") || "—"} | ${u.uiDataRequirementIds.length} | ${u.apiOperationIds.map(esc).join(", ") || "—"} | ${u.testIds.length} | ${u.status} |`),
    "",
    "## BA requirements",
    "",
    "| Requirement | Test cases | Executed | Screens | API | Result |",
    "|---|---|---|---|---|---|",
    ...trace.tests.map((t) => `| ${esc(t.requirementId)} ${esc(t.title)} | ${t.testCaseIds.length} | ${t.testIds.length} | ${t.uiFlowNodeIds.map(esc).join(", ") || "—"} | ${t.apiOperationIds.map(esc).join(", ") || "—"} | ${t.status} |`),
    "",
    "## Quality gates",
    "",
    "| Gate | Command | Result | Tests |",
    "|---|---|---|---|",
    ...gates.map(
      (g) =>
        `| ${g.gate} | ${g.command ? `\`${g.command.replace(/`/g, "")}\`` : "—"} | ${g.status === "passed" ? "✓ passed" : g.status === "failed" ? "✕ failed" : "– not configured"} | ${g.passed !== undefined ? `${g.passed} passed / ${g.failed ?? 0} failed` : ""} |`,
    ),
    "",
    "## Failure analyses",
    "",
    ...(acceptance.analyses.length ? acceptance.analyses.map((a) => `- attempt ${a.attempt}: **${a.cause}** ${a.testCaseIds.map(esc).join(", ")} ${esc(a.explanation)}`) : ["- none"]),
    "",
    "## Figma",
    "",
    ...(design
      ? [`GoApp Figma ${design.handoffId} — ${esc(design.projectName)}`, "", ...design.nodes.map((n) => `- ${esc(n.name)} \`${n.nodeId}\`${n.tag ? ` (${esc(n.tag)})` : ""}`)]
      : ["- No Figma design in this run"]),
    "",
    "## Files changed",
    "",
    ...(trace.sourceFiles.length ? trace.sourceFiles.map((f) => `- \`${f.replace(/`/g, "")}\``) : ["- none"]),
    "",
    "## Assumptions",
    "",
    ...pkg.gaps.map((g) => `- ${g.kind}${g.blocking ? " (accepted)" : ""}: ${esc(g.message)}`),
    ...tests.testabilityGaps.map((g) => `- testability ${esc(g.requirementId)} (${g.reason}): ${esc(g.message)}`),
    ...(trace.ui.some((u) => u.status === "assumed") || trace.tests.some((t) => t.status === "assumed")
      ? ["- Items marked `assumed` lack runtime or test evidence and must not be reported as verified."]
      : []),
  ];
  return lines.join("\n");
}
