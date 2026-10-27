import { escapeMarkdownText } from "@frontflow/document-parser";
import type { NodeHandler, NodeInput } from "@frontflow/workflow-engine";
import { writeRunFile, type ReportOutput } from "../ai-step.js";
import type { GateResult } from "../gates.js";
import type { NodeServices } from "../services.js";
import { optionalUpstream, saveArtifact, upstream } from "../util.js";
import type { MutationOutput } from "./ai.js";
import type { FigmaDesignOutput } from "./figma.js";
import type { ReadinessOutput } from "./readiness.js";
import type { TestDesignOutput } from "./test-design.js";
import type { AcceptanceRunOutput } from "./verification.js";

const MUTATION_NODES = ["B1.implement_ui", "B2.api_binding", "B2.ui_states", "C2.generate_tests", "C2.run_tests", "C2.run_e2e"];
const GATE_NODES = ["B2.check_backend"];

export type EvidenceOutput = Omit<ReportOutput, "verdict"> & { verificationLevel: AcceptanceRunOutput["verificationLevel"] };

/**
 * Evidence report (spec §14.4, DoD #10), in Markdown: the run's reports (UI vs API review, UI vs
 * BA review, test design, unit and E2E tests), quality gates, Figma, files changed and evidence. Nothing is
 * reported as verified without passing gates; contract-only runs, and reviews or test designs
 * whose gaps were accepted, stay `assumed` (spec §15.1).
 */
export function reportHandlers(services: NodeServices): Record<string, NodeHandler> {
  return {
    "report.evidence": {
      async execute(ctx, input) {
        const review = upstream<ReadinessOutput>(input, "A.review");
        const tests = upstream<TestDesignOutput>(input, "C1.test_design");
        const acceptance = upstream<AcceptanceRunOutput>(input, "C2.run_tests");
        // Feature delivery v11; runs and user workflows without them report what they have.
        const baReview = optionalUpstream<ReportOutput>(input, "B2.ba_ui_review");
        const e2e = optionalUpstream<AcceptanceRunOutput>(input, "C2.run_e2e");
        const design = optionalUpstream<FigmaDesignOutput>(input, "B1.figma_scope");

        const mutations = MUTATION_NODES.map((id) => optionalUpstream<MutationOutput>(input, id)).filter((m): m is MutationOutput => !!m);
        const sourceFiles = [...new Set(mutations.flatMap((m) => m.filesChanged))].sort();
        const gates = collectGates(input);
        const evidence = mutations.filter((m) => m.diffArtifactId).length + gates.filter((g) => g.artifactId).length + (design ? 1 : 0);
        const gaps = [
          review.verdict === "enough" ? "" : "UI vs API review",
          !baReview || baReview.verdict === "enough" ? "" : "UI vs BA review",
          tests.verdict === "enough" ? "" : "acceptance test design",
        ].filter(Boolean);
        ctx.log(
          acceptance.verificationLevel === "business_verified" && !gaps.length ? "info" : "warn",
          `Evidence: level ${acceptance.verificationLevel}; ${sourceFiles.length} files changed, ${evidence} evidence items${gaps.length ? `; gaps accepted in ${gaps.join(" and ")}` : ""}`,
        );

        const report = renderEvidenceReport({ review, baReview, tests, acceptance, e2e, gates, design, sourceFiles, gaps });
        const reportPath = writeRunFile(services, ctx, "evidence-report.md", report);
        const reportArtifactId = await saveArtifact(ctx, services, "evidence", "evidence-report.md", report, "text/markdown", "Evidence report");
        const output: EvidenceOutput = { report, reportPath, reportArtifactId, verificationLevel: acceptance.verificationLevel };
        return { status: "passed", output, assumed: acceptance.verificationLevel !== "business_verified" || gaps.length > 0 };
      },
    },
  };
}

function collectGates(input: NodeInput): GateResult[] {
  return GATE_NODES.flatMap((id) => optionalUpstream<{ gates: GateResult[] }>(input, id)?.gates ?? []);
}

function renderEvidenceReport(r: {
  review: ReadinessOutput;
  baReview: ReportOutput | undefined;
  tests: TestDesignOutput;
  acceptance: AcceptanceRunOutput;
  e2e: AcceptanceRunOutput | undefined;
  gates: GateResult[];
  design: FigmaDesignOutput | undefined;
  sourceFiles: string[];
  gaps: string[];
}): string {
  const esc = (s: string) => escapeMarkdownText(s);
  const path = (p: string) => `\`${p.replace(/`/g, "")}\``;
  const verdict = (v: string | undefined) => (v === "enough" ? "Đủ" : v === "not_enough" ? "Chưa đủ (accepted)" : "no conclusion (accepted)");
  const passed = (v: string | undefined) => (v === "enough" ? "Đạt" : v === "not_enough" ? "Chưa đạt (accepted)" : "no conclusion (accepted)");
  return [
    "# Evidence report",
    "",
    `- Verification level: **${r.acceptance.verificationLevel}**${r.acceptance.verificationLevel === "contract_only" ? " — backend runtime not verified" : ""}`,
    `- UI vs API review: ${r.review.score !== undefined ? `Đáp ứng ${r.review.score}% — ` : ""}${verdict(r.review.verdict)} — ${path(r.review.reportPath)}`,
    ...(r.baReview ? [`- UI vs BA review: ${verdict(r.baReview.verdict)} — ${path(r.baReview.reportPath)}`] : []),
    `- Acceptance test design: ${verdict(r.tests.verdict)} — ${path(r.tests.reportPath)}`,
    `- ${r.e2e ? "Unit tests" : "Acceptance tests"}: ${passed(r.acceptance.verdict)} — ${path(r.acceptance.reportPath)}`,
    ...(r.e2e ? [`- E2E tests: ${passed(r.e2e.verdict)} — ${path(r.e2e.reportPath)}`] : []),
    "",
    "## Quality gates",
    "",
    "| Gate | Command | Result | Tests |",
    "|---|---|---|---|",
    ...r.gates.map(
      (g) =>
        `| ${g.gate} | ${g.command ? `\`${g.command.replace(/`/g, "")}\`` : "—"} | ${g.status === "passed" ? "✓ passed" : g.status === "failed" ? "✕ failed" : "– not configured"} | ${g.passed !== undefined ? `${g.passed} passed / ${g.failed ?? 0} failed` : ""} |`,
    ),
    "",
    "## Figma",
    "",
    ...(r.design
      ? [`GoApp Figma ${r.design.handoffId} — ${esc(r.design.projectName)}`, "", ...r.design.nodes.map((n) => `- ${esc(n.name)} \`${n.nodeId}\`${n.tag ? ` (${esc(n.tag)})` : ""}`)]
      : ["- No Figma design in this run"]),
    "",
    "## Files changed",
    "",
    ...(r.sourceFiles.length ? r.sourceFiles.map((f) => `- ${path(f)}`) : ["- none"]),
    "",
    "## Assumptions",
    "",
    ...(r.gaps.length ? r.gaps.map((g) => `- Gaps accepted in the ${g}: what it lists as missing is assumed.`) : []),
    ...(r.acceptance.verificationLevel !== "business_verified" ? ["- The feature is not business verified: the result must not be reported as verified."] : []),
    ...(!r.gaps.length && r.acceptance.verificationLevel === "business_verified" ? ["- none"] : []),
  ].join("\n");
}
