import { ancestorsOf, type WorkflowDefinition } from "@frontflow/workflow-engine";
import type { PromptSource } from "./prompt-library.js";
import { MOVED_STEPS } from "./skills.js";

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
  /**
   * Dropped from the built-in workflow: still known, so user workflows and runs that have the step
   * keep working, but it can no longer be added.
   */
  retired?: true;
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
  { type: "ai.api_integration", label: "AI integrates API", description: "Binds the reviewed API to the UI and completes its loading, empty, error and permission states.", kind: "ai", prompt: true, fixedId: "B2.api_binding", needs: ["A.review", "B2.ba_spec"] },
  // Feature delivery v10 folded both into B2.api_binding.
  { type: "integration.check_backend", label: "Check backend", description: "Provider verification when the backend is reachable.", kind: "system", prompt: false, fixedId: "B2.check_backend", retired: true },
  { type: "ai.bind_ui_states", label: "AI adds UI states", description: "Loading, empty, error and permission states.", kind: "ai", prompt: true, fixedId: "B2.ui_states", needs: ["A.review", "B2.ba_spec", "B2.check_backend"], retired: true },
  { type: "tests.read_ba", label: "Read BA specification", description: "Waits for the BA specification and lists its scenarios and UI cases.", kind: "ai", prompt: true, fixedId: "B2.ba_spec" },
  { type: "readiness.ba_ui_review", label: "AI reviews UI vs BA", description: "Lists what the BA's flows, validation, forms and states need beyond the built UI; waits while the BA and Figma conflict.", kind: "ai", prompt: true, fixedId: "B2.ba_ui_review", needs: ["B1.implement_ui", "B2.ba_spec"] },
  { type: "tests.design", label: "Design acceptance tests", description: "Acceptance test cases from the BA; gated on its conclusion.", kind: "ai", prompt: true, fixedId: "C1.test_design", needs: ["B2.ba_spec"] },
  { type: "tests.read_ops_guide", label: "Read test operations guide", description: "Optional guide for preparing test data.", kind: "input", prompt: false, fixedId: "C2.ops_guide" },
  { type: "ai.acceptance_tests", label: "AI generates auto-tests", description: "One automated test per acceptance test case.", kind: "ai", prompt: true, fixedId: "C2.generate_tests", needs: ["C1.test_design", "C2.ops_guide"] },
  { type: "test.acceptance", label: "Run unit tests", description: "Runs and fixes the feature's unit tests; gated on the result.", kind: "ai", prompt: true, fixedId: "C2.run_tests", needs: ["C1.test_design", "C2.ops_guide"] },
  { type: "test.e2e", label: "Run E2E tests", description: "Runs and fixes the E2E auto-tests against the real environment; gated on the result.", kind: "ai", prompt: true, fixedId: "C2.run_e2e", needs: ["C1.test_design", "C2.ops_guide"] },
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

/** Claude Code's `--effort` levels, for a step's `config.effort`. */
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** A model alias or id; same rule as the run's model (shared/ipc.ts): it ends up on Claude Code's command line. */
export function isAgentModel(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._[\]-]{1,80}$/.test(value);
}

export function isAgentEffort(value: unknown): value is (typeof AGENT_EFFORTS)[number] {
  return (AGENT_EFFORTS as readonly unknown[]).includes(value);
}

/**
 * What a workflow needs to run here, beyond being a valid graph: known step types, built-in steps
 * with their ids and inputs, and a valid `config.model` / `config.effort` where a step sets one.
 */
export function checkWorkflowNodes(definition: WorkflowDefinition): string[] {
  const issues: string[] = [];
  for (const node of definition.nodes) {
    const info = nodeTypeInfo(node.type);
    if (!info) {
      issues.push(`node "${node.id}": unknown step type "${node.type}"`);
      continue;
    }
    const { model, effort } = node.config ?? {};
    if (model !== undefined && !isAgentModel(model)) issues.push(`node "${node.id}": config.model must be a model alias or id`);
    if (effort !== undefined && !isAgentEffort(effort)) issues.push(`node "${node.id}": config.effort must be one of ${AGENT_EFFORTS.join(", ")}`);
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

/**
 * A user workflow cloned before a built-in step moved ({@link MOVED_STEPS}), upgraded: the step
 * takes its new id (and the group of that id when the workflow has it), and the built-in steps that
 * now read it get it as a dependency. Undefined when there is nothing to upgrade.
 */
export function upgradeWorkflow(definition: WorkflowDefinition): WorkflowDefinition | undefined {
  const moved = new Map<string, string>();
  for (const node of definition.nodes) {
    const to = MOVED_STEPS[node.id];
    if (to && nodeTypeInfo(node.type)?.fixedId === to && !definition.nodes.some((n) => n.id === to)) moved.set(node.id, to);
  }
  if (!moved.size) return undefined;
  const groups = new Set([...definition.nodes.map((n) => n.group), ...(definition.lanes ?? []).flatMap((l) => l.groups ?? [l.id])]);
  const idOf = (id: string) => moved.get(id) ?? id;
  const upgraded = structuredClone(definition);
  for (const node of upgraded.nodes) {
    const to = moved.get(node.id);
    if (to) {
      const group = to.split(".")[0];
      node.id = to;
      if (group && groups.has(group)) node.group = group;
    }
    node.dependencies = node.dependencies.map(idOf);
  }
  const targets = new Set(moved.values());
  // Upstream steps first (a step has more ancestors than each of its ancestors), so a step already
  // reaching the moved one through an upgraded dependency gets no extra edge.
  const depth = new Map(upgraded.nodes.map((n) => [n.id, ancestorsOf(upgraded, n.id).size]));
  for (const node of [...upgraded.nodes].sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0))) {
    const before = ancestorsOf(upgraded, node.id);
    for (const need of nodeTypeInfo(node.type)?.needs ?? []) {
      if (targets.has(need) && !before.has(need)) node.dependencies.push(need);
    }
  }
  return upgraded;
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
