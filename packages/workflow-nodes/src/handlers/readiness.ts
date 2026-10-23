import type { ApiOperation, DocumentIssue, FeReadinessPackage, SourceSnapshot } from "@frontflow/domain";
import { parseApiMarkdown, parseOpenApi } from "@frontflow/document-parser";
import type { NodeHandler } from "@frontflow/workflow-engine";
import { ingestOperations } from "../ai-ingest.js";
import {
  buildReadinessPackage,
  buildReadinessVerdict,
  heuristicReadiness,
  ingestReadiness,
  ingestUiFlow,
  renderReadinessReport,
  uiFlowFromLayers,
  type ReadinessResult,
  type ReadinessVerdict,
  type UiFlowResult,
} from "../ai-readiness.js";
import { askAi, invalidOutput, lineCount, loadSnapshot, runFolder, stepPrompt, writeRunFile } from "../ai-step.js";
import type { ImportedApiContract, NodeServices } from "../services.js";
import { featureOf, json, optionalUpstream, plural, runInputs, saveArtifact, upstream, workspaceOf } from "../util.js";
import type { MutationOutput } from "./ai.js";
import type { FigmaDesignOutput } from "./figma.js";

export interface ApiContractOutput {
  api: SourceSnapshot;
  format: "markdown" | "openapi";
  /** Where the contract was saved in the project, for the agents to read (project-relative). */
  apiContractPath: string;
}

export type ReadinessOutput = FeReadinessPackage & {
  verdict: ReadinessVerdict;
  packageArtifactId: string;
  apiContractPath: string;
  /** "ai" when the agent wrote the review, "fallback" when built-in parsing and heuristics had to be used. */
  reviewedBy: "ai" | "fallback";
  issues: DocumentIssue[];
};

const REVIEW_FILE = "api-review.json";

/**
 * Workflow A — review the UI already built from Figma against the API contract (spec §12), once
 * the contract arrives. Reading the contract only saves it into the project; the review is one
 * editable prompt that the agent runs in the project, comparing the contract with the UI code
 * (Figma is not read again). The host grounds the answer (operation ids, line ranges, screen ids)
 * and computes the package, the owner-specific gap reports and readiness deterministically.
 * Built-in fallbacks are last resorts and always `assumed`.
 */
export function readinessHandlers(services: NodeServices): Record<string, NodeHandler> {
  return {
    "readiness.read_api": {
      async execute(ctx, input) {
        const provided = input.providedInput as Partial<ImportedApiContract> | undefined;
        const doc = provided?.api ?? runInputs(input).api;
        if (!doc) {
          ctx.log("info", "Waiting for the API contract; the UI is built from Figma meanwhile");
          return {
            status: "waiting_for_input",
            prompt: "Import the API contract (Markdown or OpenAPI) when it is ready. The UI is built from Figma meanwhile; the review against the API starts once the contract is here.",
          };
        }
        const api = await loadSnapshot(services, ctx.projectId, doc.snapshotId);
        const { projectPath } = await workspaceOf(ctx, services, input);
        const name = doc.kind === "openapi" ? (/^\s*[{[]/.test(api.text) ? "api-contract.json" : "api-contract.yaml") : "api-contract.md";
        const apiContractPath = writeRunFile(projectPath, ctx.runId, name, api.text);
        ctx.log("info", `Saved ${doc.sourceUri ?? "the API contract"} (${lineCount(api.text)} lines) to ${apiContractPath}`);
        const output: ApiContractOutput = { api: api.snapshot, format: doc.kind, apiContractPath };
        return { status: "passed", output };
      },
    },

    "readiness.review": {
      async execute(ctx, input) {
        const contract = upstream<ApiContractOutput>(input, "A.api_contract");
        const design = optionalUpstream<FigmaDesignOutput>(input, "B1.figma_scope");
        const ui = optionalUpstream<MutationOutput>(input, "B1.implement_ui");
        const api = await loadSnapshot(services, ctx.projectId, contract.api.id);
        const { projectPath } = await workspaceOf(ctx, services, input);
        const folder = runFolder(projectPath, ctx.runId);
        const outputRel = `${folder.rel}/${REVIEW_FILE}`;

        const prompt = await stepPrompt(ctx, services, {
          feature: featureOf(input),
          apiContract: contract.apiContractPath,
          uiFiles: ui?.filesChanged.length ? ui.filesChanged.map((f) => `\n  - ${f}`).join("") : "the UI of this feature in the project (find it from the screen names)",
          figmaLayers: design?.nodes.length ? design.nodes.map((n) => `\n  - "${n.name}" (${n.nodeId})`).join("") : "none recorded",
          output: outputRel,
        });

        let operations: ApiOperation[] | undefined;
        let flow: UiFlowResult | undefined;
        let result: ReadinessResult | undefined;
        const warnings: string[] = [];
        const ai = await askAi(ctx, services, input, { projectPath, prompt, outputRel });
        if (ai.data !== undefined) {
          try {
            const ops = ingestOperations(ai.data, api);
            const uiFlow = ingestUiFlow(ai.data);
            result = ingestReadiness(ai.data, uiFlow.uiDataRequirements, ops.operations);
            operations = ops.operations;
            flow = uiFlow;
            warnings.push(...ops.warnings, ...uiFlow.warnings);
          } catch (err) {
            invalidOutput(ctx, input, `AI review unusable: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          invalidOutput(ctx, input, `The AI did not write ${outputRel}`);
        }

        const reviewedBy: ReadinessOutput["reviewedBy"] = result ? "ai" : "fallback";
        const issues: DocumentIssue[] = [];
        if (!operations || !flow || !result) {
          // Last resort: the template parser for the contract, the selected layers for the UI, keyword heuristics for the mapping.
          ctx.log("warn", "Falling back to the built-in parser and heuristics; the review is approximate and marked as assumed");
          const parsed = contract.format === "openapi" ? parseOpenApi(api.snapshot, api.text) : parseApiMarkdown(api.snapshot, api.text);
          operations = parsed.operations;
          issues.push(...parsed.issues);
          flow = uiFlowFromLayers(design?.nodes ?? []);
          result = heuristicReadiness(flow.uiDataRequirements, operations);
          warnings.push(...flow.warnings);
        }
        for (const w of [...warnings, ...result.warnings].slice(0, 20)) ctx.log("warn", w);
        ctx.log("info", `Contract: ${plural(operations.length, "API operation")}; UI: ${plural(flow.uiFlow.length, "screen")}, ${plural(flow.uiDataRequirements.length, "UI need")}`);

        const pkg = buildReadinessPackage({
          runId: ctx.runId,
          sourceSnapshots: [contract.api.id, ...(design ? [design.snapshotHash] : [])],
          uiFlow: flow.uiFlow,
          uiDataRequirements: flow.uiDataRequirements,
          operations,
          mappings: result.mappings,
          gaps: result.gaps,
          allowAssumptions: runInputs(input).allowAssumptions,
        });
        for (const m of pkg.mappings) {
          ctx.log(
            m.status === "ready" || m.status === "fe_only" ? "info" : "warn",
            `${m.uiDataRequirementId}: ${m.status}${m.apiOperationIds.length ? ` → ${m.apiOperationIds.join(", ")}` : ""}${m.rationale ? ` — ${m.rationale}` : ""}`,
          );
        }
        const verdict = buildReadinessVerdict(pkg, reviewedBy === "ai" ? "ai" : "heuristics", result.summary);
        const report = renderReadinessReport(pkg, verdict);
        writeRunFile(projectPath, ctx.runId, "api-review.md", report);
        await saveArtifact(ctx, services, "evidence", "readiness-gap-report.md", report, "text/markdown", "API review & gap report");
        const s = pkg.summary;
        ctx.log(verdict.score >= 80 ? "info" : "warn", `${verdict.headline}. ${verdict.summary}`);
        ctx.log(
          "info",
          `FE readiness: ${pkg.readiness} (reviewed by ${reviewedBy === "ai" ? "AI" : "built-in heuristics"}) — ready ${s.ready}, FE-only ${s.feOnly}, partial ${s.partial}, missing API ${s.missingApi}, missing design ${s.missingDesign}, conflict ${s.conflict}, ambiguous ${s.ambiguous}`,
        );

        const accepted = (input.providedInput as { accept?: unknown } | undefined)?.accept === true;
        if (pkg.readiness === "not_ready" && !accepted) {
          return {
            status: "waiting_for_input",
            prompt: `${verdict.headline}. Review the gap report (${folder.rel}/api-review.md), then update the API contract or the UI and start a new run, or accept the gaps to continue (they are recorded as assumptions).`,
            output: { readiness: pkg.readiness, summary: s, verdict },
          };
        }
        if (accepted) ctx.log("warn", "Gaps accepted by the user; everything downstream is marked as assumed");
        const packageArtifactId = await saveArtifact(ctx, services, "package", "fe-readiness-package.json", json(pkg), "application/json", "FE Readiness Package");
        const output: ReadinessOutput = { ...pkg, verdict, packageArtifactId, apiContractPath: contract.apiContractPath, reviewedBy, issues };
        return { status: "passed", output, assumed: pkg.readiness !== "ready" || accepted || reviewedBy !== "ai" };
      },
    },
  };
}
