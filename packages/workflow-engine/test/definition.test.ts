import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  WorkflowDefinitionError,
  composeWorkflows,
  evaluateCondition,
  loadBuiltinWorkflows,
  loadWorkflowYaml,
  toGraph,
  topologicalOrder,
} from "../src/index.js";

const WORKFLOWS_DIR = fileURLToPath(new URL("../../../workflows", import.meta.url));

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowDefinitionError);
    return (error as WorkflowDefinitionError).issues;
  }
  throw new Error("expected a WorkflowDefinitionError");
}

describe("loadWorkflowYaml", () => {
  it("parses nodes and applies defaults", () => {
    const def = loadWorkflowYaml(`
id: sample
version: 2
name: Sample
defaults:
  group: X
  timeoutMs: 1234
  retryPolicy: { maxAttempts: 2, backoff: linear, retryableErrors: [E1] }
nodes:
  - id: X.a
    type: t.a
  - id: X.b
    type: t.b
    label: Bee
    dependencies: [X.a]
    mutation: true
    retryPolicy: { maxAttempts: 4 }
    when: { node: X.a, path: ok, equals: true }
`);
    expect(def.version).toBe(2);
    const [a, b] = def.nodes;
    expect(a).toMatchObject({ id: "X.a", label: "X.a", group: "X", timeoutMs: 1234, version: 1, mutation: false, readOnly: false });
    expect(a?.retryPolicy).toEqual({ maxAttempts: 2, backoff: "linear", retryableErrors: ["E1"], baseDelayMs: 1000 });
    expect(b).toMatchObject({ label: "Bee", mutation: true, dependencies: ["X.a"], when: { node: "X.a", path: "ok", equals: true } });
    expect(b?.retryPolicy.maxAttempts).toBe(4);
    expect(b?.retryPolicy.backoff).toBe("linear");
  });

  it("reports unknown dependencies", () => {
    const issues = issuesOf(() =>
      loadWorkflowYaml(`
id: w
name: W
nodes:
  - { id: a, type: t }
  - { id: b, type: t, dependencies: [a, ghost] }
`),
    );
    expect(issues).toContain('node "b": unknown dependency "ghost"');
  });

  it("reports cycles with the path", () => {
    const issues = issuesOf(() =>
      loadWorkflowYaml(`
id: w
name: W
nodes:
  - { id: a, type: t, dependencies: [c] }
  - { id: b, type: t, dependencies: [a] }
  - { id: c, type: t, dependencies: [b] }
`),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^dependency cycle: (a -> c -> b -> a|a -> b -> c -> a)$/);
  });

  it("reports duplicate ids, bad fields and invalid combinations", () => {
    const issues = issuesOf(() =>
      loadWorkflowYaml(`
id: w
name: W
nodes:
  - { id: a, type: t }
  - { id: a, type: t, mutation: true, readOnly: true }
  - id: b
    type: t
    dependson: [a]
    retryPolicy: { backoff: forever, maxAttempts: 0 }
    when: { node: a, equals: 1 }
`),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        'nodes[2] (b): unknown field "dependson"',
        "nodes[2] (b).retryPolicy.backoff: must be one of none | linear | exponential",
      ]),
    );
    const semantic = issuesOf(() =>
      loadWorkflowYaml(`
id: w
name: W
nodes:
  - { id: a, type: t }
  - { id: a, type: t, mutation: true, readOnly: true }
  - { id: b, type: t, retryPolicy: { maxAttempts: 0 }, when: { node: a, equals: 1 } }
`),
    );
    expect(semantic).toEqual(
      expect.arrayContaining([
        'duplicate node id "a"',
        'node "a": cannot be both mutation and readOnly',
        'node "b": retryPolicy.maxAttempts must be an integer between 1 and 20',
        'node "b": when.node "a" must be one of its dependencies',
      ]),
    );
  });

  it("reports YAML syntax errors with the source name", () => {
    expect(() => loadWorkflowYaml("id: [unclosed", "broken.yaml")).toThrow(/broken\.yaml[\s\S]*YAML syntax error/);
  });

  it("allows cross-file dependencies only when declared in requires", () => {
    const text = `
id: second
name: Second
requires: [first.end]
nodes:
  - { id: second.start, type: t, dependencies: [first.end] }
`;
    expect(loadWorkflowYaml(text).requires).toEqual(["first.end"]);
    const issues = issuesOf(() => loadWorkflowYaml(text.replace("requires: [first.end]\n", "")));
    expect(issues).toContain('node "second.start": unknown dependency "first.end"');
  });
});

describe("composeWorkflows", () => {
  const first = loadWorkflowYaml("id: first\nname: First\nnodes:\n  - { id: first.end, type: t }\n");
  const second = loadWorkflowYaml(
    "id: second\nname: Second\nrequires: [first.end]\nnodes:\n  - { id: second.start, type: t, dependencies: [first.end] }\n",
  );

  it("merges files into one graph", () => {
    const composed = composeWorkflows("both", "Both", [second, first]);
    expect(composed.requires).toBeUndefined();
    expect(composed.composedFrom).toEqual([
      { id: "second", version: 1 },
      { id: "first", version: 1 },
    ]);
    expect(topologicalOrder(composed)).toEqual(["first.end", "second.start"]);
  });

  it("rejects unresolved requires and duplicate ids across files", () => {
    expect(issuesOf(() => composeWorkflows("x", "X", [second]))).toEqual([
      '"second" requires "first.end" which no composed workflow defines',
    ]);
    expect(issuesOf(() => composeWorkflows("x", "X", [first, first]))).toEqual([
      'node id "first.end" is defined in both "first" and "first"',
    ]);
  });
});

describe("evaluateCondition", () => {
  it("supports equals, notEquals, in, exists and truthiness", () => {
    const out = { provider: { available: true, region: "eu" }, count: 0 };
    expect(evaluateCondition({ node: "n", path: "provider.available", equals: true }, out)).toBe(true);
    expect(evaluateCondition({ node: "n", path: "provider.available", equals: false }, out)).toBe(false);
    expect(evaluateCondition({ node: "n", path: "provider.region", notEquals: "us" }, out)).toBe(true);
    expect(evaluateCondition({ node: "n", path: "provider.region", in: ["us", "eu"] }, out)).toBe(true);
    expect(evaluateCondition({ node: "n", path: "missing", exists: false }, out)).toBe(true);
    expect(evaluateCondition({ node: "n", path: "count" }, out)).toBe(false);
    expect(evaluateCondition({ node: "n", path: "provider" }, out)).toBe(true);
  });
});

describe("built-in workflows", () => {
  it("loads and composes the three workflow files", () => {
    const def = loadBuiltinWorkflows(WORKFLOWS_DIR);
    expect(def.id).toBe("feature-delivery");
    expect(def.version).toBe(3);
    expect(def.nodes).toHaveLength(4 + 6 + 5);
    const groups = new Set(def.nodes.map((n) => n.group));
    expect(groups).toEqual(new Set(["A", "B", "C1", "C2"]));
    for (const node of def.nodes) expect(node.id.startsWith(`${node.group}.`)).toBe(true);

    const byId = new Map(def.nodes.map((n) => [n.id, n]));
    // A: Figma and the API contract are read in parallel and decide readiness; the BA is not an input.
    expect(byId.get("A.figma_scope")?.dependencies).toEqual([]);
    expect(byId.get("A.api_contract")?.dependencies).toEqual([]);
    expect(byId.get("A.readiness")?.dependencies).toEqual(["A.ui_flow", "A.api_contract"]);
    expect(byId.get("A.readiness")?.readOnly).toBe(false);
    // B starts from the FE Readiness Package.
    expect(byId.get("B.implement_ui")?.dependencies).toEqual(["A.readiness", "B.prepare_project"]);
    expect(byId.get("B.implement_ui")).toMatchObject({ mutation: true, type: "ai.implement_ui" });
    expect(byId.get("B.implement_ui")?.retryPolicy.maxAttempts).toBeGreaterThan(1);
    // C1 designs tests from BA + UI flow + mapping only, never from the implementation.
    expect(byId.get("C1.test_design")?.dependencies).toEqual(["C1.ba_spec", "A.ui_flow", "A.readiness"]);
    expect(byId.get("C1.ba_spec")?.config?.["waitingRunStatus"]).toBe("test_design_pending");
    expect(byId.get("C2.generate_tests")?.dependencies).toEqual(["C1.test_design", "B.quality_gates"]);

    const graph = toGraph(def);
    expect(graph.nodes).toHaveLength(def.nodes.length);
    expect(graph.edges.find((e) => e.id === "A.readiness->B.implement_ui")?.conditional).toBe(false);
    expect(graph.edges.some((e) => e.source.startsWith("B.") && e.target.startsWith("C1."))).toBe(false);
  });
});
