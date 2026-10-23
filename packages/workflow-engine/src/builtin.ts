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
    // v4: UI from Figma first; the API contract is reviewed against it when it arrives.
    version: 4,
    description: "UI from Figma, review against the API contract when it arrives, API integration, and BA-driven acceptance tests composed into one run graph.",
  });
}
