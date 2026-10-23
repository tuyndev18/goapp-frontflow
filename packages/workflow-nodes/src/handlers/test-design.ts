import type { AcceptanceTestCasePackage, BusinessRequirement, SourceSnapshot } from "@frontflow/domain";
import { parseBaMarkdown, type AcceptanceCriterion } from "@frontflow/document-parser";
import type { NodeHandler } from "@frontflow/workflow-engine";
import { ingestRequirements } from "../ai-ingest.js";
import { buildTestPackage, ingestTestDesign, renderTestDesignReport, testDesignFromCriteria, type TestDesignResult } from "../ai-readiness.js";
import { askAi, invalidOutput, lineCount, loadSnapshot, runFolder, stepPrompt, writeRunFile } from "../ai-step.js";
import type { ImportedBaSpec, NodeServices } from "../services.js";
import { featureOf, json, plural, runInputs, saveArtifact, upstream, workspaceOf } from "../util.js";
import type { ReadinessOutput } from "./readiness.js";

export interface BaSpecOutput {
  ba: SourceSnapshot;
  /** Where the BA spec was saved in the project, for the agents to read (project-relative). */
  baSpecPath: string;
  actors: string[];
  requirements: BusinessRequirement[];
  acceptanceCriteria: AcceptanceCriterion[];
  /** "ai" when the agent extracted the scenarios, "parser" when the built-in parser had to be used. */
  extractedBy: "ai" | "parser";
  warnings: string[];
}

export type TestDesignOutput = AcceptanceTestCasePackage & { designedBy: "ai" | "criteria"; packageArtifactId: string };

/**
 * Workflow C1 — BA-driven test design (spec §14.1). The BA specification is the business test
 * oracle: its scenarios are mapped onto the reviewed UI and its UI ↔ API mapping, and their
 * expected results come from the BA only. Both steps are editable prompts the agent runs in the
 * project; the host grounds the JSON they write before anything downstream trusts it.
 */
export function testDesignHandlers(services: NodeServices): Record<string, NodeHandler> {
  return {
    "tests.read_ba": {
      async execute(ctx, input) {
        const provided = input.providedInput as Partial<ImportedBaSpec> | undefined;
        const doc = provided?.ba ?? runInputs(input).ba;
        if (!doc) {
          ctx.log("info", "Waiting for the BA specification; implementation continues without it (test design pending)");
          return { status: "waiting_for_input", prompt: "Import the BA specification (Markdown) to design the acceptance tests. Implementation continues meanwhile; the feature cannot be reported as business verified without it." };
        }
        const ba = await loadSnapshot(services, ctx.projectId, doc.snapshotId);
        const { projectPath } = await workspaceOf(ctx, services, input);
        const baSpecPath = writeRunFile(projectPath, ctx.runId, "ba-spec.md", ba.text);
        ctx.log("info", `Saved ${doc.sourceUri ?? "the BA specification"} (${lineCount(ba.text)} lines) to ${baSpecPath}`);

        const outputRel = `${runFolder(projectPath, ctx.runId).rel}/ba-scenarios.json`;
        const prompt = await stepPrompt(ctx, services, { feature: featureOf(input), baSpec: baSpecPath, output: outputRel });
        const ai = await askAi(ctx, services, input, { projectPath, prompt, outputRel });
        if (ai.data !== undefined) {
          try {
            const result = ingestRequirements(ai.data, ba);
            await saveArtifact(ctx, services, "evidence", "ba-scenarios.json", json(result), "application/json", "Business scenarios");
            ctx.log("info", `AI extracted ${plural(result.requirements.length, "requirement")} and ${plural(result.acceptanceCriteria.length, "acceptance criterion")}`);
            for (const w of result.warnings.slice(0, 20)) ctx.log("warn", w);
            const output: BaSpecOutput = { ba: ba.snapshot, baSpecPath, ...result, extractedBy: "ai" };
            return { status: "passed", output, assumed: result.warnings.length > 0 };
          } catch (err) {
            invalidOutput(ctx, input, `AI extraction unusable: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          invalidOutput(ctx, input, `The AI did not write ${outputRel}`);
        }

        // Last resort: the built-in parser only understands the recommended template (spec §11.1).
        ctx.log("warn", "Falling back to the built-in parser; results on free-form documents are approximate and marked as assumed");
        const parsed = parseBaMarkdown(ba.snapshot, ba.text);
        ctx.log("info", `Parser: ${plural(parsed.requirements.length, "requirement")}, ${plural(parsed.acceptanceCriteria.length, "acceptance criterion")}`);
        const output: BaSpecOutput = {
          ba: ba.snapshot,
          baSpecPath,
          actors: parsed.actors,
          requirements: parsed.requirements,
          acceptanceCriteria: parsed.acceptanceCriteria,
          extractedBy: "parser",
          warnings: ["Extracted by the built-in parser"],
        };
        return { status: "passed", output, assumed: true };
      },
    },

    "tests.design": {
      async execute(ctx, input) {
        const spec = upstream<BaSpecOutput>(input, "C1.ba_spec");
        const readiness = upstream<ReadinessOutput>(input, "A.review");
        const { projectPath } = await workspaceOf(ctx, services, input);
        const folder = runFolder(projectPath, ctx.runId);

        // The agent reads the grounded data, not its own earlier raw answers.
        const baScenarios = writeRunFile(projectPath, ctx.runId, "ba-requirements.json", json({ actors: spec.actors, requirements: spec.requirements, acceptanceCriteria: spec.acceptanceCriteria }));
        const review = writeRunFile(
          projectPath,
          ctx.runId,
          "ui-api-review.json",
          json({ screens: readiness.uiFlow, requirements: readiness.uiDataRequirements, operations: readiness.operations, mappings: readiness.mappings, gaps: readiness.gaps }),
        );
        const outputRel = `${folder.rel}/test-design.json`;

        let result: TestDesignResult | undefined;
        const prompt = await stepPrompt(ctx, services, { feature: featureOf(input), baScenarios, review, output: outputRel });
        const ai = await askAi(ctx, services, input, { projectPath, prompt, outputRel });
        if (ai.data !== undefined) {
          try {
            result = ingestTestDesign(ai.data, spec.requirements, readiness);
          } catch (err) {
            invalidOutput(ctx, input, `AI test design unusable: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          invalidOutput(ctx, input, `The AI did not write ${outputRel}`);
        }
        const designedBy: TestDesignOutput["designedBy"] = result ? "ai" : "criteria";
        if (!result) {
          ctx.log("warn", "Designing test cases from the acceptance criteria only; they are not mapped to screens or API operations and are marked as assumed");
          result = testDesignFromCriteria(spec.requirements, spec.acceptanceCriteria);
        }
        for (const w of result.warnings.slice(0, 20)) ctx.log("warn", w);

        const pkg = buildTestPackage({
          runId: ctx.runId,
          baSnapshotId: spec.ba.id,
          readinessPackageId: readiness.packageArtifactId,
          requirements: spec.requirements,
          testCases: result.testCases,
          testabilityGaps: result.testabilityGaps,
        });
        const c = pkg.coverage;
        for (const g of pkg.testabilityGaps) ctx.log(g.blocking ? "warn" : "info", `${g.requirementId}: ${g.reason} — ${g.message}`);
        ctx.log(
          c.blockedRequirements ? "warn" : "info",
          `Test design: ${plural(pkg.testCases.length, "test case")} for ${c.requirementsWithTests}/${c.totalRequirements} requirements; ${c.automatableRequirements} automatable, ${c.blockedRequirements} blocked`,
        );
        const report = renderTestDesignReport(pkg);
        writeRunFile(projectPath, ctx.runId, "test-design.md", report);
        await saveArtifact(ctx, services, "evidence", "testability-gap-report.md", report, "text/markdown", "Test design & testability gaps");

        const accepted = (input.providedInput as { accept?: unknown } | undefined)?.accept === true;
        if (pkg.status === "blocked" && !accepted) {
          return {
            status: "waiting_for_input",
            prompt: `${plural(c.blockedRequirements, "BA requirement")} cannot be tested yet. Review the testability gaps (${folder.rel}/test-design.md), then update the BA, design or API and start a new run, or accept the gaps to continue without those tests.`,
            output: { status: pkg.status, coverage: c },
          };
        }
        if (accepted) ctx.log("warn", "Testability gaps accepted by the user; the blocked requirements will not be business verified");
        const packageArtifactId = await saveArtifact(ctx, services, "package", "acceptance-test-cases.json", json(pkg), "application/json", "Acceptance Test Case Package");
        const output: TestDesignOutput = { ...pkg, designedBy, packageArtifactId };
        return { status: "passed", output, assumed: pkg.status !== "ready" || designedBy !== "ai" || spec.extractedBy !== "ai" };
      },
    },
  };
}
