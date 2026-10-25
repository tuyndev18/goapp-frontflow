import { ancestorsOf, type WorkflowDefinition } from "@frontflow/workflow-engine";
import type { PromptSource } from "./prompt-library.js";

/**
 * The step types a workflow can use. Two are generic and can be added any number of times:
 * `ai.prompt` (the agent runs the step's prompt in the project) and `manual.check` (a person checks
 * what the step's prompt lists, then continues). The others are the built-in steps of the feature
 * delivery workflow: each reads the output of other built-in steps by id, so it keeps its id and
 * needs those steps before it.
 */
export interface NodeTypeInfo {
  type: string;
  label: string;
  description: string;
  /** ai: runs an AI agent; manual: a person does it; input: waits for documents/designs; system: runs on its own. */
  kind: "ai" | "manual" | "input" | "system";
  /** The step has a prompt (sent to the agent, or shown to the person checking). */
  prompt: boolean;
  /** Built-in step: at most one per workflow, with this id. */
  fixedId?: string;
  /** Steps whose output it reads: they must run before it. */
  needs?: string[];
}

export const AI_PROMPT_TYPE = "ai.prompt";
export const MANUAL_CHECK_TYPE = "manual.check";

export const NODE_TYPES: readonly NodeTypeInfo[] = [
  { type: AI_PROMPT_TYPE, label: "AI prompt", description: "Claude runs this step's prompt in the project folder; the project is snapshotted before and after.", kind: "ai", prompt: true },
  { type: MANUAL_CHECK_TYPE, label: "Manual check", description: "A person checks what this step's prompt lists, then continues the workflow.", kind: "manual", prompt: true },
  { type: "figma.design", label: "Select Figma scope", description: "Waits for the frames pushed from the GoApp Figma plugin.", kind: "input", prompt: false, fixedId: "B1.figma_scope" },
  { type: "ai.implement_ui", label: "AI implements UI", description: "Implements the presentational UI from the Figma scope.", kind: "ai", prompt: true, fixedId: "B1.implement_ui", needs: ["B1.figma_scope"] },
  { type: "readiness.read_api", label: "Read API contract", description: "Waits for the API contract upload.", kind: "input", prompt: false, fixedId: "A.api_contract" },
  { type: "readiness.review", label: "AI reviews UI vs API", description: "Reviews the API contract against the built UI; gated on its coverage.", kind: "ai", prompt: true, fixedId: "A.review", needs: ["A.api_contract"] },
  { type: "ai.api_integration", label: "AI binds API", description: "Binds the reviewed API to the UI.", kind: "ai", prompt: true, fixedId: "B2.api_binding", needs: ["A.review"] },
  { type: "integration.check_backend", label: "Check backend", description: "Provider verification when the backend is reachable.", kind: "system", prompt: false, fixedId: "B2.check_backend" },
  { type: "ai.bind_ui_states", label: "AI adds UI states", description: "Loading, empty, error and permission states.", kind: "ai", prompt: true, fixedId: "B2.ui_states", needs: ["A.review", "B2.check_backend"] },
  { type: "tests.read_ba", label: "Read BA specification", description: "Waits for the BA specification and lists its scenarios.", kind: "ai", prompt: true, fixedId: "C1.ba_spec" },
  { type: "tests.design", label: "Design acceptance tests", description: "Acceptance test cases from the BA; gated on its conclusion.", kind: "ai", prompt: true, fixedId: "C1.test_design", needs: ["C1.ba_spec"] },
  { type: "tests.read_ops_guide", label: "Read test operations guide", description: "Optional guide for preparing test data.", kind: "input", prompt: false, fixedId: "C2.ops_guide" },
  { type: "ai.acceptance_tests", label: "AI generates auto-tests", description: "One Playwright test per acceptance test case.", kind: "ai", prompt: true, fixedId: "C2.generate_tests", needs: ["C1.test_design", "C2.ops_guide"] },
  { type: "test.acceptance", label: "Run acceptance tests", description: "Runs and fixes the acceptance tests; gated on the result.", kind: "ai", prompt: true, fixedId: "C2.run_tests", needs: ["C1.test_design", "C2.ops_guide"] },
  { type: "report.evidence", label: "Evidence report", description: "Summarizes the run's reports and evidence.", kind: "system", prompt: false, fixedId: "C2.evidence_report", needs: ["A.review", "C1.test_design", "C2.run_tests"] },
];

export function nodeTypeInfo(type: string): NodeTypeInfo | undefined {
  return NODE_TYPES.find((t) => t.type === type);
}

const AGENT_RETRY = { maxAttempts: 3, backoff: "exponential", baseDelayMs: 5000, retryableErrors: ["AGENT_SESSION_FAILED", "AGENT_TIMEOUT", "NODE_TIMEOUT"] } as const;

/**
 * A new step of `type` as workflow data: a built-in step is copied from the built-in workflow (its
 * id, retries, config); a generic one gets `id`. Timeouts are 0: an agent or a person may take long.
 */
export function newNodeSpec(type: string, input: { id: string; label?: string; group: string }, builtin: WorkflowDefinition): Record<string, unknown> {
  const info = nodeTypeInfo(type);
  if (!info) throw new Error(`Unknown step type ${type}`);
  if (info.fixedId) {
    const spec = builtin.nodes.find((n) => n.id === info.fixedId);
    if (!spec) throw new Error(`The built-in workflow has no ${info.fixedId}`);
    const { id, type: t, label, description, retryPolicy, timeoutMs, mutation, readOnly, config, version } = structuredClone(spec);
    return { id, type: t, label, group: input.group, ...(description ? { description } : {}), dependencies: [], retryPolicy, timeoutMs, mutation, readOnly, ...(config ? { config } : {}), version };
  }
  const base = { id: input.id, type, label: input.label ?? info.label, group: input.group, dependencies: [], timeoutMs: 0 };
  return type === AI_PROMPT_TYPE
    ? { ...base, mutation: true, config: { ai: true }, retryPolicy: { ...AGENT_RETRY, retryableErrors: [...AGENT_RETRY.retryableErrors] } }
    : { ...base, retryPolicy: { maxAttempts: 1, backoff: "none", retryableErrors: [] } };
}

/** What a workflow needs to run here, beyond being a valid graph: known step types, built-in steps with their ids and inputs. */
export function checkWorkflowNodes(definition: WorkflowDefinition): string[] {
  const issues: string[] = [];
  for (const node of definition.nodes) {
    const info = nodeTypeInfo(node.type);
    if (!info) {
      issues.push(`node "${node.id}": unknown step type "${node.type}"`);
      continue;
    }
    if (info.fixedId && node.id !== info.fixedId) issues.push(`node "${node.id}": a "${info.label}" step must have the id "${info.fixedId}"`);
    if (info.needs?.length) {
      const before = ancestorsOf(definition, node.id);
      for (const need of info.needs) {
        if (!before.has(need)) issues.push(`node "${node.id}" reads the output of "${need}": add that step before it`);
      }
    }
  }
  return issues;
}

/** Steps that need a prompt and have none (or an empty one): the workflow cannot start without them. */
export function stepsWithoutPrompt(definition: WorkflowDefinition, prompts: Pick<PromptSource, "get">): string[] {
  return definition.nodes
    .filter((n) => nodeTypeInfo(n.type)?.prompt)
    .filter((n) => {
      try {
        return !prompts.get(n.id, definition.id).text.trim();
      } catch {
        return true;
      }
    })
    .map((n) => n.id);
}
