import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorkflowYaml } from "./definition.js";
import type { WorkflowDefinition } from "./types.js";

/** The built-in workflow every feature used before workflows could be chosen (the 13-step canvas). */
export const FEATURE_DELIVERY_WORKFLOW_ID = "feature-delivery";

export function loadWorkflowFile(path: string): WorkflowDefinition {
  return loadWorkflowYaml(readFileSync(path, "utf8"), path);
}

/** Loads the built-in workflows (`*.yaml` in `dir`), feature delivery first. */
export function loadBuiltinWorkflows(dir: string): WorkflowDefinition[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => loadWorkflowFile(join(dir, f)))
    .sort((a, b) => Number(b.id === FEATURE_DELIVERY_WORKFLOW_ID) - Number(a.id === FEATURE_DELIVERY_WORKFLOW_ID) || a.name.localeCompare(b.name));
}
