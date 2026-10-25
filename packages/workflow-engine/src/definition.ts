import type { RetryPolicy } from "@frontflow/domain";
import { stableStringify } from "@frontflow/domain";
import { parse as parseYaml } from "yaml";
import { WorkflowDefinitionError } from "./errors.js";
import type { JoinMode, NodeCondition, WorkflowDefinition, WorkflowLane, WorkflowNodeSpec } from "./types.js";

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 1, backoff: "none", retryableErrors: [], baseDelayMs: 1000 };
export const DEFAULT_NODE_TIMEOUT_MS = 10 * 60 * 1000;
/** Hard cap so a misconfigured policy can never retry indefinitely (DoD #11). */
export const MAX_ATTEMPTS_LIMIT = 20;

const BACKOFFS = ["none", "linear", "exponential"] as const;
const JOIN_MODES: readonly JoinMode[] = ["all", "any"];
const TOP_LEVEL_KEYS = new Set(["id", "version", "name", "description", "requires", "timeoutMs", "defaults", "lanes", "nodes"]);
const LANE_KEYS = new Set(["id", "title", "subtitle", "groups"]);
const DEFAULT_KEYS = new Set(["retryPolicy", "timeoutMs", "group"]);
const NODE_KEYS = new Set([
  "id",
  "type",
  "label",
  "group",
  "description",
  "dependencies",
  "retryPolicy",
  "timeoutMs",
  "mutation",
  "readOnly",
  "when",
  "joinMode",
  "requiresCapabilities",
  "config",
  "version",
  "position",
]);
const RETRY_KEYS = new Set(["maxAttempts", "backoff", "retryableErrors", "baseDelayMs"]);
const CONDITION_KEYS = new Set(["node", "path", "equals", "notEquals", "in", "exists"]);

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function checkKeys(raw: Raw, allowed: Set<string>, where: string, issues: string[]): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) issues.push(`${where}: unknown field "${key}"`);
  }
}

function parseRetryPolicy(raw: unknown, base: RetryPolicy, where: string, issues: string[]): RetryPolicy {
  if (raw === undefined) return { ...base, retryableErrors: [...base.retryableErrors] };
  if (!isRecord(raw)) {
    issues.push(`${where}: must be an object`);
    return base;
  }
  checkKeys(raw, RETRY_KEYS, where, issues);
  const policy: RetryPolicy = { ...base, retryableErrors: [...base.retryableErrors] };
  if (raw.maxAttempts !== undefined) {
    if (typeof raw.maxAttempts === "number") policy.maxAttempts = raw.maxAttempts;
    else issues.push(`${where}.maxAttempts: must be a number`);
  }
  if (raw.backoff !== undefined) {
    if ((BACKOFFS as readonly unknown[]).includes(raw.backoff)) policy.backoff = raw.backoff as RetryPolicy["backoff"];
    else issues.push(`${where}.backoff: must be one of ${BACKOFFS.join(" | ")}`);
  }
  if (raw.retryableErrors !== undefined) {
    if (isStringArray(raw.retryableErrors)) policy.retryableErrors = [...raw.retryableErrors];
    else issues.push(`${where}.retryableErrors: must be a list of error codes`);
  }
  if (raw.baseDelayMs !== undefined) {
    if (typeof raw.baseDelayMs === "number") policy.baseDelayMs = raw.baseDelayMs;
    else issues.push(`${where}.baseDelayMs: must be a number`);
  }
  return policy;
}

function parseCondition(raw: unknown, where: string, issues: string[]): NodeCondition | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    issues.push(`${where}: must be an object`);
    return undefined;
  }
  checkKeys(raw, CONDITION_KEYS, where, issues);
  if (typeof raw.node !== "string" || raw.node.length === 0) {
    issues.push(`${where}.node: required string`);
    return undefined;
  }
  const condition: NodeCondition = { node: raw.node };
  if (raw.path !== undefined) {
    if (typeof raw.path === "string") condition.path = raw.path;
    else issues.push(`${where}.path: must be a string`);
  }
  if ("equals" in raw) condition.equals = raw.equals;
  if ("notEquals" in raw) condition.notEquals = raw.notEquals;
  if (raw.in !== undefined) {
    if (Array.isArray(raw.in)) condition.in = raw.in;
    else issues.push(`${where}.in: must be a list`);
  }
  if (raw.exists !== undefined) {
    if (typeof raw.exists === "boolean") condition.exists = raw.exists;
    else issues.push(`${where}.exists: must be a boolean`);
  }
  return condition;
}

/** Converts a plain object (parsed YAML/JSON) into a validated definition. */
export function parseWorkflowDefinition(raw: unknown, source = "workflow"): WorkflowDefinition {
  const issues: string[] = [];
  if (!isRecord(raw)) throw new WorkflowDefinitionError(source, ["document root must be a mapping"]);
  checkKeys(raw, TOP_LEVEL_KEYS, "root", issues);

  const defaults = raw.defaults === undefined ? {} : raw.defaults;
  if (!isRecord(defaults)) issues.push("defaults: must be an object");
  const defaultsRec: Raw = isRecord(defaults) ? defaults : {};
  checkKeys(defaultsRec, DEFAULT_KEYS, "defaults", issues);
  const defaultPolicy = parseRetryPolicy(defaultsRec.retryPolicy, DEFAULT_RETRY_POLICY, "defaults.retryPolicy", issues);
  const defaultTimeout = typeof defaultsRec.timeoutMs === "number" ? defaultsRec.timeoutMs : DEFAULT_NODE_TIMEOUT_MS;
  if (defaultsRec.timeoutMs !== undefined && typeof defaultsRec.timeoutMs !== "number") {
    issues.push("defaults.timeoutMs: must be a number");
  }
  const defaultGroup = typeof defaultsRec.group === "string" ? defaultsRec.group : undefined;

  const definition: WorkflowDefinition = {
    id: typeof raw.id === "string" ? raw.id : "",
    version: typeof raw.version === "number" ? raw.version : 1,
    name: typeof raw.name === "string" ? raw.name : "",
    nodes: [],
  };
  if (typeof raw.id !== "string") issues.push("id: required string");
  if (typeof raw.name !== "string") issues.push("name: required string");
  if (raw.version !== undefined && typeof raw.version !== "number") issues.push("version: must be a number");
  if (raw.description !== undefined) {
    if (typeof raw.description === "string") definition.description = raw.description;
    else issues.push("description: must be a string");
  }
  if (raw.requires !== undefined) {
    if (isStringArray(raw.requires)) definition.requires = [...raw.requires];
    else issues.push("requires: must be a list of node ids");
  }
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs === "number") definition.timeoutMs = raw.timeoutMs;
    else issues.push("timeoutMs: must be a number");
  }
  if (raw.lanes !== undefined) {
    if (!Array.isArray(raw.lanes)) issues.push("lanes: must be a list");
    else {
      definition.lanes = [];
      raw.lanes.forEach((rawLane, index) => {
        const where = `lanes[${index}]`;
        if (!isRecord(rawLane)) {
          issues.push(`${where}: must be an object`);
          return;
        }
        checkKeys(rawLane, LANE_KEYS, where, issues);
        if (typeof rawLane.id !== "string" || !rawLane.id) issues.push(`${where}.id: required string`);
        if (typeof rawLane.title !== "string") issues.push(`${where}.title: required string`);
        const lane: WorkflowLane = { id: typeof rawLane.id === "string" ? rawLane.id : "", title: typeof rawLane.title === "string" ? rawLane.title : "" };
        if (rawLane.subtitle !== undefined) {
          if (typeof rawLane.subtitle === "string") lane.subtitle = rawLane.subtitle;
          else issues.push(`${where}.subtitle: must be a string`);
        }
        if (rawLane.groups !== undefined) {
          if (isStringArray(rawLane.groups)) lane.groups = [...rawLane.groups];
          else issues.push(`${where}.groups: must be a list of strings`);
        }
        definition.lanes?.push(lane);
      });
    }
  }

  if (!Array.isArray(raw.nodes)) {
    issues.push("nodes: required list");
  } else {
    raw.nodes.forEach((rawNode, index) => {
      const nodeId = isRecord(rawNode) && typeof rawNode.id === "string" ? rawNode.id : undefined;
      const where = nodeId ? `nodes[${index}] (${nodeId})` : `nodes[${index}]`;
      if (!isRecord(rawNode)) {
        issues.push(`${where}: must be an object`);
        return;
      }
      checkKeys(rawNode, NODE_KEYS, where, issues);
      if (!nodeId) issues.push(`${where}.id: required string`);
      if (typeof rawNode.type !== "string" || rawNode.type.length === 0) issues.push(`${where}.type: required string`);
      const dependencies = rawNode.dependencies ?? [];
      if (!isStringArray(dependencies)) issues.push(`${where}.dependencies: must be a list of node ids`);
      const node: WorkflowNodeSpec = {
        id: nodeId ?? "",
        type: typeof rawNode.type === "string" ? rawNode.type : "",
        label: typeof rawNode.label === "string" ? rawNode.label : (nodeId ?? ""),
        dependencies: isStringArray(dependencies) ? [...dependencies] : [],
        retryPolicy: parseRetryPolicy(rawNode.retryPolicy, defaultPolicy, `${where}.retryPolicy`, issues),
        timeoutMs: typeof rawNode.timeoutMs === "number" ? rawNode.timeoutMs : defaultTimeout,
        mutation: rawNode.mutation === true,
        readOnly: rawNode.readOnly === true,
        version: typeof rawNode.version === "number" ? rawNode.version : 1,
      };
      if (rawNode.label !== undefined && typeof rawNode.label !== "string") issues.push(`${where}.label: must be a string`);
      if (rawNode.timeoutMs !== undefined && typeof rawNode.timeoutMs !== "number") {
        issues.push(`${where}.timeoutMs: must be a number`);
      }
      for (const flag of ["mutation", "readOnly"] as const) {
        if (rawNode[flag] !== undefined && typeof rawNode[flag] !== "boolean") issues.push(`${where}.${flag}: must be a boolean`);
      }
      if (rawNode.version !== undefined && typeof rawNode.version !== "number") issues.push(`${where}.version: must be a number`);
      const group = rawNode.group ?? defaultGroup;
      if (group !== undefined) {
        if (typeof group === "string") node.group = group;
        else issues.push(`${where}.group: must be a string`);
      }
      if (rawNode.description !== undefined) {
        if (typeof rawNode.description === "string") node.description = rawNode.description;
        else issues.push(`${where}.description: must be a string`);
      }
      const when = parseCondition(rawNode.when, `${where}.when`, issues);
      if (when) node.when = when;
      if (rawNode.joinMode !== undefined) {
        if ((JOIN_MODES as readonly unknown[]).includes(rawNode.joinMode)) node.joinMode = rawNode.joinMode as JoinMode;
        else issues.push(`${where}.joinMode: must be one of ${JOIN_MODES.join(" | ")}`);
      }
      if (rawNode.requiresCapabilities !== undefined) {
        if (isStringArray(rawNode.requiresCapabilities)) node.requiresCapabilities = [...rawNode.requiresCapabilities];
        else issues.push(`${where}.requiresCapabilities: must be a list of strings`);
      }
      if (rawNode.config !== undefined) {
        if (isRecord(rawNode.config)) node.config = rawNode.config;
        else issues.push(`${where}.config: must be an object`);
      }
      if (rawNode.position !== undefined) {
        const p = rawNode.position;
        if (isRecord(p) && Number.isFinite(p.x) && Number.isFinite(p.y) && Object.keys(p).length === 2) node.position = { x: p.x as number, y: p.y as number };
        else issues.push(`${where}.position: must be { x, y } numbers`);
      }
      definition.nodes.push(node);
    });
  }

  if (issues.length > 0) throw new WorkflowDefinitionError(source, issues);
  return validateWorkflowDefinition(definition, { source, allowRequires: true });
}

/** Parses and validates one workflow YAML document. Cross-file deps must be listed under `requires`. */
export function loadWorkflowYaml(text: string, source = "workflow.yaml"): WorkflowDefinition {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new WorkflowDefinitionError(source, [`YAML syntax error: ${error instanceof Error ? error.message : String(error)}`]);
  }
  return parseWorkflowDefinition(raw, source);
}

export interface ValidateOptions {
  source?: string;
  /** Allow dependencies on ids listed in `requires` (single file of a composed workflow). */
  allowRequires?: boolean;
}

/**
 * Semantic validation: ids, dependencies, conditions, retry policies and cycles.
 * Returns the same definition; throws WorkflowDefinitionError listing every issue.
 */
export function validateWorkflowDefinition(definition: WorkflowDefinition, options: ValidateOptions = {}): WorkflowDefinition {
  const source = options.source ?? definition.id ?? "workflow";
  const issues: string[] = [];
  if (!definition.id) issues.push("id: must not be empty");
  if (!definition.name) issues.push("name: must not be empty");
  if (!Number.isInteger(definition.version) || definition.version < 1) issues.push("version: must be a positive integer");
  if (definition.timeoutMs !== undefined && !(definition.timeoutMs > 0)) issues.push("timeoutMs: must be > 0");
  if (definition.nodes.length === 0) issues.push("nodes: workflow must contain at least one node");

  const requires = new Set(definition.requires ?? []);
  if (!options.allowRequires && requires.size > 0) {
    issues.push(`unresolved external dependencies: ${[...requires].join(", ")} (compose this workflow with the files that define them)`);
  }

  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (!node.id) continue;
    if (ids.has(node.id)) issues.push(`duplicate node id "${node.id}"`);
    ids.add(node.id);
    if (requires.has(node.id)) issues.push(`"${node.id}" is listed in requires but also defined in this workflow`);
  }

  for (const node of definition.nodes) {
    const where = `node "${node.id}"`;
    if (!node.type) issues.push(`${where}: type must not be empty`);
    if (!Number.isInteger(node.version) || node.version < 1) issues.push(`${where}: version must be a positive integer`);
    // 0 = no timeout (AI steps: a waiting agent costs nothing and the user can cancel it).
    if (!(node.timeoutMs >= 0)) issues.push(`${where}: timeoutMs must be >= 0`);
    if (node.mutation && node.readOnly) issues.push(`${where}: cannot be both mutation and readOnly`);
    const policy = node.retryPolicy;
    if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > MAX_ATTEMPTS_LIMIT) {
      issues.push(`${where}: retryPolicy.maxAttempts must be an integer between 1 and ${MAX_ATTEMPTS_LIMIT}`);
    }
    if (policy.baseDelayMs !== undefined && !(policy.baseDelayMs >= 0)) issues.push(`${where}: retryPolicy.baseDelayMs must be >= 0`);

    const seenDeps = new Set<string>();
    for (const dep of node.dependencies) {
      if (dep === node.id) issues.push(`${where}: depends on itself`);
      else if (!ids.has(dep) && !(options.allowRequires && requires.has(dep))) {
        issues.push(`${where}: unknown dependency "${dep}"`);
      }
      if (seenDeps.has(dep)) issues.push(`${where}: dependency "${dep}" listed twice`);
      seenDeps.add(dep);
    }
    if (node.when && !node.dependencies.includes(node.when.node)) {
      issues.push(`${where}: when.node "${node.when.node}" must be one of its dependencies`);
    }
    if (node.joinMode === "any" && node.dependencies.length < 2) {
      issues.push(`${where}: joinMode "any" requires at least two dependencies`);
    }
  }

  if (definition.lanes) {
    const laneIds = new Set<string>();
    const laneOfGroup = new Map<string, string>();
    for (const lane of definition.lanes) {
      if (!lane.id) continue;
      if (laneIds.has(lane.id)) issues.push(`duplicate lane id "${lane.id}"`);
      laneIds.add(lane.id);
      for (const group of lane.groups ?? [lane.id]) {
        const owner = laneOfGroup.get(group);
        if (owner !== undefined && owner !== lane.id) issues.push(`group "${group}" is in lanes "${owner}" and "${lane.id}"`);
        laneOfGroup.set(group, lane.id);
      }
    }
    for (const node of definition.nodes) {
      if (node.group === undefined || !laneOfGroup.has(node.group)) issues.push(`node "${node.id}": group "${node.group ?? ""}" is in no lane`);
    }
  }

  if (issues.length === 0) {
    const cycle = findCycle(definition);
    if (cycle) issues.push(`dependency cycle: ${cycle.join(" -> ")}`);
  }
  if (issues.length > 0) throw new WorkflowDefinitionError(source, issues);
  return definition;
}

function findCycle(definition: WorkflowDefinition): string[] | undefined {
  const byId = new Map(definition.nodes.map((n) => [n.id, n]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    const current = state.get(id);
    if (current === "done") return undefined;
    if (current === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of byId.get(id)?.dependencies ?? []) {
      if (!byId.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return undefined;
  };

  for (const node of definition.nodes) {
    const cycle = visit(node.id);
    if (cycle) return cycle.reverse();
  }
  return undefined;
}

export interface ComposeOptions {
  version?: number;
  description?: string;
  timeoutMs?: number;
}

/** Merges several workflow files into one run graph; node ids must be globally unique. */
export function composeWorkflows(
  id: string,
  name: string,
  definitions: WorkflowDefinition[],
  options: ComposeOptions = {},
): WorkflowDefinition {
  const issues: string[] = [];
  const owner = new Map<string, string>();
  for (const def of definitions) {
    for (const node of def.nodes) {
      const previous = owner.get(node.id);
      if (previous) issues.push(`node id "${node.id}" is defined in both "${previous}" and "${def.id}"`);
      else owner.set(node.id, def.id);
    }
  }
  for (const def of definitions) {
    for (const required of def.requires ?? []) {
      if (!owner.has(required)) issues.push(`"${def.id}" requires "${required}" which no composed workflow defines`);
    }
  }
  if (issues.length > 0) throw new WorkflowDefinitionError(id, issues);

  const composed: WorkflowDefinition = {
    id,
    version: options.version ?? 1,
    name,
    composedFrom: definitions.map((d) => ({ id: d.id, version: d.version })),
    nodes: definitions.flatMap((d) => d.nodes.map((n) => structuredClone(n))),
  };
  if (options.description !== undefined) composed.description = options.description;
  if (options.timeoutMs !== undefined) composed.timeoutMs = options.timeoutMs;
  return validateWorkflowDefinition(composed, { source: id });
}

/** Node ids in dependency order (stable with respect to declaration order). */
export function topologicalOrder(definition: WorkflowDefinition): string[] {
  const byId = new Map(definition.nodes.map((n) => [n.id, n]));
  const order: string[] = [];
  const done = new Set<string>();
  const visit = (id: string, path: Set<string>): void => {
    if (done.has(id) || path.has(id)) return;
    path.add(id);
    for (const dep of byId.get(id)?.dependencies ?? []) if (byId.has(dep)) visit(dep, path);
    path.delete(id);
    done.add(id);
    order.push(id);
  };
  for (const node of definition.nodes) visit(node.id, new Set());
  return order;
}

/** Transitive dependents of `nodeId` (not including itself). */
export function descendantsOf(definition: WorkflowDefinition, nodeId: string): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const node of definition.nodes) {
    for (const dep of node.dependencies) {
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    }
  }
  const result = new Set<string>();
  const queue = [...(dependents.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (result.has(id)) continue;
    result.add(id);
    queue.push(...(dependents.get(id) ?? []));
  }
  return result;
}

/** Transitive dependencies of `nodeId` (not including itself). */
export function ancestorsOf(definition: WorkflowDefinition, nodeId: string): Set<string> {
  const byId = new Map(definition.nodes.map((n) => [n.id, n]));
  const result = new Set<string>();
  const queue = [...(byId.get(nodeId)?.dependencies ?? [])];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (result.has(id)) continue;
    result.add(id);
    queue.push(...(byId.get(id)?.dependencies ?? []));
  }
  return result;
}

function readPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let current = value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function evaluateCondition(condition: NodeCondition, output: unknown): boolean {
  const value = readPath(output, condition.path);
  if (condition.exists !== undefined && (value !== undefined) !== condition.exists) return false;
  if ("equals" in condition && !deepEqual(value, condition.equals)) return false;
  if ("notEquals" in condition && deepEqual(value, condition.notEquals)) return false;
  if (condition.in !== undefined && !condition.in.some((candidate) => deepEqual(value, candidate))) return false;
  const hasComparator = condition.exists !== undefined || "equals" in condition || "notEquals" in condition || condition.in !== undefined;
  return hasComparator ? true : Boolean(value);
}

export interface WorkflowGraph {
  lanes?: WorkflowLane[];
  nodes: Array<{ id: string; label: string; type: string; group?: string; mutation: boolean; readOnly: boolean; position?: { x: number; y: number } }>;
  edges: Array<{ id: string; source: string; target: string; conditional: boolean }>;
}

/** React Flow friendly projection of a definition. */
export function toGraph(definition: WorkflowDefinition): WorkflowGraph {
  return {
    ...(definition.lanes ? { lanes: definition.lanes.map((l) => structuredClone(l)) } : {}),
    nodes: definition.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      type: n.type,
      ...(n.group === undefined ? {} : { group: n.group }),
      mutation: n.mutation,
      readOnly: n.readOnly,
      ...(n.position ? { position: { ...n.position } } : {}),
    })),
    edges: definition.nodes.flatMap((n) =>
      n.dependencies.map((dep) => ({
        id: `${dep}->${n.id}`,
        source: dep,
        target: n.id,
        conditional: n.when?.node === dep,
      })),
    ),
  };
}
