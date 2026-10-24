import { nowIso, type SourceSnapshot } from "@frontflow/domain";
import type { NodeHandler, NodeInput } from "@frontflow/workflow-engine";
import { fileList, latestUpload, lineCount, loadSnapshot, reportStep, writeRunDocuments, type ReportOutput } from "../ai-step.js";
import type { ImportedBaSpec, ImportedBatch, ImportedOpsGuide, NodeServices } from "../services.js";
import { featureOf, runInputs, upstream, workspaceOf } from "../util.js";

/** The business scenarios the agent read from the BA spec (short Markdown, in Vietnamese). */
export type BaSpecOutput = ReportOutput & {
  /** The documents of the latest upload. */
  ba: SourceSnapshot[];
  /** Where they were saved in the run folder (absolute), for the agents to read; nothing from earlier uploads is there. */
  baSpecFiles: string[];
  /** Every upload into the step, oldest first; the last one is the one in use. */
  history: ImportedBatch[];
};

/** The feature's test operations guide (e.g. how to prepare data in the CMS); no files when the feature has none. */
export interface OpsGuideOutput {
  /** Where the latest upload was saved in the run folder (absolute). */
  opsGuideFiles: string[];
  /** Every upload into the step, oldest first; the last one is the one in use. */
  history: ImportedBatch[];
}

/** The acceptance test design (Markdown, in Vietnamese): test cases per scenario and what cannot be tested. */
export type TestDesignOutput = ReportOutput;

/** The operations guide for a prompt: its files, or "Không có" when the feature has none. */
export function opsGuideOf(input: NodeInput): string {
  const files = upstream<OpsGuideOutput>(input, "C2.ops_guide").opsGuideFiles;
  return files.length ? fileList(files) : "Không có";
}

/**
 * Workflow C1 — BA-driven test design (spec §14.1). The BA specification is the business test
 * oracle: test cases come from the BA only — not from the API contract, the design or the code,
 * which B2 is still integrating meanwhile; C2 builds the automated tests on the integrated
 * frontend. Their expected results come from the BA only. Both steps are editable
 * prompts whose answers are Markdown reports; test design is gated on its conclusion. The optional
 * operations guide (C2, no AI) only tells the auto-test agents how to prepare test data.
 */
export function testDesignHandlers(services: NodeServices): Record<string, NodeHandler> {
  return {
    "tests.read_ba": {
      async execute(ctx, input) {
        const provided = input.providedInput as Partial<ImportedBaSpec> | undefined;
        const docs = latestUpload(provided?.ba, runInputs(input).ba);
        if (!docs.length) {
          ctx.log("info", "Waiting for the BA specification; implementation continues without it (test design pending)");
          return { status: "waiting_for_input", prompt: "Import the BA specification (Markdown, one or more files) to design the acceptance tests. Implementation continues meanwhile; the feature cannot be reported as business verified without it." };
        }
        const loaded = await Promise.all(docs.map(async (doc) => ({ doc, stored: await loadSnapshot(services, ctx.projectId, doc.snapshotId) })));
        const { projectPath } = await workspaceOf(ctx, services, input);
        const baSpecFiles = writeRunDocuments(
          services,
          ctx,
          "ba-spec",
          loaded.map(({ doc, stored }, i) => {
            const name = doc.sourceUri ?? `ba-spec-${i + 1}`;
            return { name: /\.[A-Za-z0-9]{1,5}$/.test(name) ? name : `${name}.md`, text: stored.text };
          }),
        );
        const history = provided?.history ?? [{ importedAt: loaded[0]?.stored.snapshot.createdAt ?? nowIso(), documents: docs.map(({ snapshotId, sourceUri }) => ({ snapshotId, ...(sourceUri ? { sourceUri } : {}) })) }];
        for (const [i, { doc, stored }] of loaded.entries()) ctx.log("info", `Saved ${doc.sourceUri ?? "BA specification"} (${lineCount(stored.text)} lines) to ${baSpecFiles[i]}`);
        if (history.length > 1) ctx.log("info", `Using upload ${history.length} (${docs.length} file${docs.length === 1 ? "" : "s"}); earlier uploads are kept in the history only`);
        return reportStep(ctx, services, input, {
          fileName: "ba-scenarios.md",
          label: "BA scenarios",
          cwd: projectPath,
          vars: { feature: featureOf(input), baSpec: fileList(baSpecFiles) },
          extra: { ba: loaded.map(({ stored }) => stored.snapshot), baSpecFiles, history },
        });
      },
    },

    // Workflow C2, optional and never waits: most features have no operations guide. Importing one
    // later runs the auto-tests again with it; test design (BA only) is not affected.
    "tests.read_ops_guide": {
      async execute(ctx, input) {
        const provided = input.providedInput as Partial<ImportedOpsGuide> | undefined;
        const docs = provided?.ops ?? [];
        if (!docs.length) {
          ctx.log("info", "No test operations guide for this feature; import one here if the tests need it (e.g. preparing data in the CMS)");
          return { status: "passed", output: { opsGuideFiles: [], history: [] } satisfies OpsGuideOutput };
        }
        const loaded = await Promise.all(docs.map(async (doc) => ({ doc, stored: await loadSnapshot(services, ctx.projectId, doc.snapshotId) })));
        const opsGuideFiles = writeRunDocuments(
          services,
          ctx,
          "ops-guide",
          loaded.map(({ doc, stored }, i) => ({ name: doc.sourceUri ?? `ops-guide-${i + 1}.md`, text: stored.text })),
        );
        for (const [i, { doc, stored }] of loaded.entries()) ctx.log("info", `Saved ${doc.sourceUri ?? "operations guide"} (${lineCount(stored.text)} lines) to ${opsGuideFiles[i]}`);
        const history = provided?.history ?? [];
        if (history.length > 1) ctx.log("info", `Using upload ${history.length}; earlier uploads are kept in the history only`);
        return { status: "passed", output: { opsGuideFiles, history } satisfies OpsGuideOutput };
      },
    },

    "tests.design": {
      async execute(ctx, input) {
        const spec = upstream<BaSpecOutput>(input, "C1.ba_spec");
        const { projectPath } = await workspaceOf(ctx, services, input);
        return reportStep(ctx, services, input, {
          fileName: "test-design.md",
          label: "Acceptance test design",
          cwd: projectPath,
          vars: { feature: featureOf(input), baSpec: fileList(spec.baSpecFiles), baScenarios: spec.reportPath },
          gate: {
            notEnough: "Some BA scenarios cannot be tested yet (see the test design). Import a newer BA specification in “Read BA specification” — test design runs again — or accept the gaps to continue without those tests.",
            unknown: "The test design has no clear Đủ / Chưa đủ conclusion. Read it, then run the step again or accept to continue (recorded as assumptions).",
          },
        });
      },
    },
  };
}
