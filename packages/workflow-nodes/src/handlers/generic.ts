import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "@frontflow/domain";
import { redactString } from "@frontflow/event-schema";
import type { NodeHandler } from "@frontflow/workflow-engine";
import { additionsPrompt, renderPrompt } from "../prompt-library.js";
import { AI_PROMPT_TYPE, MANUAL_CHECK_TYPE } from "../node-types.js";
import { fileList, runFolder } from "../ai-step.js";
import type { NodeServices } from "../services.js";
import { featureOf, saveArtifact } from "../util.js";
import { mutationStep, type MutationOutput } from "./ai.js";

/** What an `ai.prompt` step outputs: its code changes, plus the summary the agent wrote, if any. */
export interface PromptStepOutput extends MutationOutput {
  report?: string;
  reportPath?: string;
}

/** What a `manual.check` step outputs once the person continues. */
export interface ManualCheckOutput {
  /** The checklist shown (the step's prompt), shown as the step result. */
  report: string;
  checkedAt?: string;
  note?: string;
}

/**
 * The generic steps of user-made workflows. Their prompts are all they are: `{{feature}}`,
 * `{{runFolder}}` (the run's workflow files), `{{output}}` (where the agent may write a Markdown
 * summary for the next steps) and `{{reports}}` (the reports earlier steps wrote) are filled in.
 */
export function genericHandlers(services: NodeServices): Record<string, NodeHandler> {
  return {
    [AI_PROMPT_TYPE]: {
      async execute(ctx, input) {
        const output = join(runFolder(services, ctx), `${ctx.nodeId}.md`);
        // A stale summary from a previous attempt must not be mistaken for this attempt's.
        if (existsSync(output)) writeFileSync(output, "");
        const result = await mutationStep(ctx, services, input, {
          vars: { runFolder: runFolder(services, ctx), output, reports: upstreamReports(input.upstream) },
        });
        if (result.status !== "passed") return result;
        const report = existsSync(output) ? redactString(readFileSync(output, "utf8").trim()) : "";
        if (!report) return result;
        writeFileSync(output, report);
        await saveArtifact(ctx, services, "evidence", `${ctx.nodeId}.md`, report, "text/markdown", "Step summary");
        return { ...result, output: { ...(result.output as MutationOutput), report, reportPath: output } satisfies PromptStepOutput };
      },
    },

    [MANUAL_CHECK_TYPE]: {
      async execute(ctx, input) {
        const template = services.prompts.get(ctx.nodeId, ctx.workflowId);
        const extra = additionsPrompt(
          services.prompts.additions?.(ctx.projectId, ctx.workflowId, ctx.nodeId) ?? [],
          services.prompts.featureAdditions?.(ctx.runId, ctx.workflowId, ctx.nodeId) ?? [],
        );
        const checklist = renderPrompt(extra ? `${template.text.trimEnd()}\n\n${extra}` : template.text, {
          feature: featureOf(input),
          runFolder: runFolder(services, ctx),
          reports: upstreamReports(input.upstream),
        }).text;
        const provided = input.providedInput as { note?: unknown } | undefined;
        if (!provided) {
          ctx.log("info", "Waiting for a person to check this step");
          return { status: "waiting_for_input", prompt: "Check what this step lists (see Result), then continue.", output: { report: checklist } satisfies ManualCheckOutput };
        }
        const note = typeof provided.note === "string" && provided.note.trim() ? redactString(provided.note.trim()) : undefined;
        ctx.log("info", `Checked${note ? `: ${note}` : ""}`);
        return { status: "passed", output: { report: checklist, checkedAt: nowIso(), ...(note ? { note } : {}) } satisfies ManualCheckOutput };
      },
    },
  };
}

/** The Markdown reports earlier steps wrote in the run folder, for the prompt. */
function upstreamReports(upstream: Record<string, unknown>): string {
  const paths = Object.values(upstream).flatMap((out) => {
    const path = (out as { reportPath?: unknown } | undefined)?.reportPath;
    return typeof path === "string" ? [path] : [];
  });
  return paths.length ? fileList(paths) : "None";
}
