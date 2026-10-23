import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeWorkflows, loadWorkflowYaml } from "./definition.js";
import type { WorkflowDefinition } from "./types.js";

export const BUILTIN_WORKFLOW_FILES = ["ui-implementation.yaml", "fe-readiness.yaml", "business-validation.yaml"] as const;
export const FEATURE_DELIVERY_WORKFLOW_ID = "feature-delivery";

export function loadWorkflowFile(path: string): WorkflowDefinition {
  return loadWorkflowYaml(readFileSync(path, "utf8"), path);
}

/** Loads the built-in A/B/C workflow files from `dir` and composes them into one run graph. */
export function loadBuiltinWorkflows(dir: string): WorkflowDefinition {
  const parts = BUILTIN_WORKFLOW_FILES.map((file) => loadWorkflowFile(join(dir, file)));
  return composeWorkflows(FEATURE_DELIVERY_WORKFLOW_ID, "Feature delivery (UI → API review → integration ∥ BA tests)", parts, {
    // v5: no project-analysis step; the API review compares the contract with the built UI; every AI step is an editable prompt.
    // v6: no implementation gates (B2.quality_gates removed; AI steps run no build/typecheck/lint).
    version: 6,
    description: "UI from Figma, review against the API contract when it arrives, API integration, and BA-driven acceptance tests composed into one run graph.",
  });
}
