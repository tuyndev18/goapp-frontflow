import { nowIso, type SourceSnapshot } from "@frontflow/domain";
import type { NodeHandler } from "@frontflow/workflow-engine";
import { fileList, latestUpload, lineCount, loadSnapshot, reportScore, reportStep, writeRunDocuments, type ReportJudgement, type ReportOutput } from "../ai-step.js";
import type { ImportedApiContract, ImportedBatch, NodeServices } from "../services.js";
import { featureOf, optionalUpstream, runInputs, upstream, workspaceOf } from "../util.js";
import { notesOf, type MutationOutput } from "./ai.js";
import { figmaFramesOf } from "./figma.js";
import type { BaSpecOutput } from "./test-design.js";

export interface ApiContractOutput {
  /** The documents of the latest upload. */
  api: SourceSnapshot[];
  /** Where they were saved in the run folder (absolute), for the agents to read; nothing from earlier uploads is there. */
  apiContractFiles: string[];
  /** Every upload into the step, oldest first; the last one is the one in use. */
  history: ImportedBatch[];
}

/** The review (short Markdown, in Vietnamese: how much of the built UI the contract covers, what is missing). */
export type ReadinessOutput = ReportOutput & { apiContractFiles: string[]; score?: number };

/** The review passes only when the contract covers at least this share of what the built UI needs. */
export const MIN_REVIEW_SCORE = 92;

/** The review's `Đáp ứng: NN%` line against MIN_REVIEW_SCORE. */
export function judgeCoverage(report: string): ReportJudgement {
  const score = reportScore(report);
  if (score === undefined) return { summary: "no “Đáp ứng: NN%” line found under Kết luận" };
  return {
    verdict: score >= MIN_REVIEW_SCORE ? "enough" : "not_enough",
    summary: `the API contract covers ${score}% of the built UI (at least ${MIN_REVIEW_SCORE}% is needed)`,
    fields: { score },
  };
}

/**
 * Workflow A — review the UI already built from Figma against the API contract (spec §12), once
 * the contract arrives. Reading the contract only saves the documents of the latest upload into the
 * run folder (an upload may hold several files; earlier uploads stay in the history only); the review is one editable prompt that the agent runs in the
 * project, checking the contract against the UI code (Figma is not read again). Its answer is a
 * short Markdown report that the next steps' agents read. FrontFlow only reads its coverage line
 * (`Đáp ứng: NN%`): below MIN_REVIEW_SCORE it stops here until the user imports a newer contract
 * or accepts the gaps.
 *
 * Lane B2 reviews the same UI against the BA (`readiness.ba_ui_review`): the BA decides behaviour
 * (flow, validation, forms, states, business rules); Figma supplies presentation and copy unless
 * BA explicitly mandates exact wording. Equivalent copy and BA silence are not conflicts. It waits only while the
 * two conflict (`Chưa đủ`); what the BA needs beyond the UI is for B2.api_binding to build.
 */
export function readinessHandlers(services: NodeServices): Record<string, NodeHandler> {
  return {
    "readiness.read_api": {
      async execute(ctx, input) {
        const provided = input.providedInput as Partial<ImportedApiContract> | undefined;
        const docs = latestUpload(provided?.api, runInputs(input).api);
        if (!docs.length) {
          ctx.log("info", "Waiting for the API contract; the UI is built from Figma meanwhile");
          return {
            status: "waiting_for_input",
            prompt: "Import the API contract (Markdown or OpenAPI, one or more files) when it is ready. The UI is built from Figma meanwhile; the review against the API starts once the contract is here.",
          };
        }
        const loaded = await Promise.all(docs.map(async (doc) => ({ doc, stored: await loadSnapshot(services, ctx.projectId, doc.snapshotId) })));
        const apiContractFiles = writeRunDocuments(
          services,
          ctx,
          "api-contract",
          loaded.map(({ doc, stored }, i) => ({ name: withExtension(doc.sourceUri ?? `api-contract-${i + 1}`, doc.kind, stored.text), text: stored.text })),
        );
        const history = provided?.history ?? [{ importedAt: loaded[0]?.stored.snapshot.createdAt ?? nowIso(), documents: docs.map(({ snapshotId, sourceUri }) => ({ snapshotId, ...(sourceUri ? { sourceUri } : {}) })) }];
        for (const [i, { doc, stored }] of loaded.entries()) ctx.log("info", `Saved ${doc.sourceUri ?? "API contract"} (${lineCount(stored.text)} lines) to ${apiContractFiles[i]}`);
        if (history.length > 1) ctx.log("info", `Using upload ${history.length} (${docs.length} file${docs.length === 1 ? "" : "s"}); earlier uploads are kept in the history only`);
        const output: ApiContractOutput = { api: loaded.map(({ stored }) => stored.snapshot), apiContractFiles, history };
        return { status: "passed", output };
      },
    },

    "readiness.review": {
      async execute(ctx, input) {
        const contract = upstream<ApiContractOutput>(input, "A.api_contract");
        const ui = optionalUpstream<MutationOutput>(input, "B1.implement_ui");
        const { projectPath } = await workspaceOf(ctx, services, input);
        return reportStep(ctx, services, input, {
          fileName: "api-review.md",
          label: "UI vs API review",
          cwd: projectPath,
          vars: {
            feature: featureOf(input),
            apiContract: fileList(contract.apiContractFiles),
            uiFiles: ui?.filesChanged.length ? ui.filesChanged.map((f) => `\n  - ${f}`).join("") : "UI của tính năng này trong project (tìm theo tên tính năng)",
          },
          gate: {
            judge: judgeCoverage,
            notEnough: "The API contract is not enough for the built UI (see the review). Import a newer API contract in “Read API contract” — the review runs again — or accept the gaps to continue (they are recorded as assumptions).",
            unknown: "Read the review, then run the step again or accept to continue (recorded as assumptions).",
          },
          extra: { apiContractFiles: contract.apiContractFiles },
        });
      },
    },

    // The UI is built from Figma, which shows less than the BA defines: what the BA needs beyond it
    // is listed here, before the integration builds it, instead of surfacing as failing tests.
    "readiness.ba_ui_review": {
      async execute(ctx, input) {
        const spec = upstream<BaSpecOutput>(input, "B2.ba_spec");
        const ui = optionalUpstream<MutationOutput>(input, "B1.implement_ui");
        const { projectPath } = await workspaceOf(ctx, services, input);
        return reportStep(ctx, services, input, {
          fileName: "ba-ui-review.md",
          label: "UI vs BA review",
          withFigma: true,
          cwd: projectPath,
          vars: {
            feature: featureOf(input),
            baSpec: fileList(spec.baSpecFiles),
            baScenarios: spec.reportPath,
            uiFiles: ui?.filesChanged.length ? ui.filesChanged.map((f) => `\n  - ${f}`).join("") : "UI của tính năng này trong project (tìm theo tên tính năng)",
            uiNotes: notesOf(input, "B1.implement_ui"),
            figmaFrames: figmaFramesOf(input),
          },
          gate: {
            notEnough: "The BA and the UI built from Figma conflict (see “Mâu thuẫn cần chốt” in the review). Accept to follow the choices the review proposes, or write your decisions as a feature prompt addition of this step (or import a newer BA) and run it again.",
            unknown: "The review has no clear Đủ / Chưa đủ conclusion. Read it, then run the step again or accept to continue (recorded as assumptions).",
          },
        });
      },
    },
  };
}

/** Uploaded names keep their extension; a name without one gets the format's. */
function withExtension(name: string, kind: "markdown" | "openapi", text: string): string {
  if (/\.[A-Za-z0-9]{1,5}$/.test(name)) return name;
  return `${name}.${kind === "openapi" ? (/^\s*[{[]/.test(text) ? "json" : "yaml") : "md"}`;
}
