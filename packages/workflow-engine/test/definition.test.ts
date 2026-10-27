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

  it("takes timeoutMs 0 as no time limit, never a negative one", () => {
    expect(loadWorkflowYaml("id: w\nname: W\nnodes:\n  - { id: a, type: t, timeoutMs: 0 }\n").nodes[0]?.timeoutMs).toBe(0);
    expect(issuesOf(() => loadWorkflowYaml("id: w\nname: W\nnodes:\n  - { id: a, type: t, timeoutMs: -1 }\n"))).toContain('node "a": timeoutMs must be >= 0');
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

describe("lanes", () => {
  const yaml = (lanes: string, group = "main") => `id: w\nname: W\nlanes:\n${lanes}\nnodes:\n  - { id: a, type: t, group: ${group} }\n`;

  it("puts each node group in one lane", () => {
    const def = loadWorkflowYaml(yaml("  - { id: main, title: Main, subtitle: Sub }\n  - { id: tests, title: Tests, groups: [t1, t2] }"));
    expect(def.lanes).toEqual([
      { id: "main", title: "Main", subtitle: "Sub" },
      { id: "tests", title: "Tests", groups: ["t1", "t2"] },
    ]);
    expect(loadWorkflowYaml(yaml("  - { id: tests, title: Tests, groups: [t1, t2] }", "t2")).nodes[0]?.group).toBe("t2");
  });

  it("keeps where a step was placed on the canvas", () => {
    const def = loadWorkflowYaml("id: w\nname: W\nnodes:\n  - { id: a, type: t, position: { x: 120, y: 40 } }\n  - { id: b, type: t }\n");
    expect(def.nodes.map((n) => n.position)).toEqual([{ x: 120, y: 40 }, undefined]);
    expect(toGraph(def).nodes[0]?.position).toEqual({ x: 120, y: 40 });
    expect(issuesOf(() => loadWorkflowYaml("id: w\nname: W\nnodes:\n  - { id: a, type: t, position: { x: 1 } }\n"))).toEqual(["nodes[0] (a).position: must be { x, y } numbers"]);
  });

  it("rejects duplicate lanes, shared groups and nodes outside every lane", () => {
    expect(issuesOf(() => loadWorkflowYaml(yaml("  - { id: main, title: A }\n  - { id: main, title: B }")))).toEqual(['duplicate lane id "main"']);
    expect(issuesOf(() => loadWorkflowYaml(yaml("  - { id: main, title: A }\n  - { id: x, title: B, groups: [main] }")))).toEqual([
      'group "main" is in lanes "main" and "x"',
    ]);
    expect(issuesOf(() => loadWorkflowYaml(yaml("  - { id: other, title: A }")))).toEqual(['node "a": group "main" is in no lane']);
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
  it("loads the 13-step feature delivery workflow with its canvas lanes", () => {
    const [def, ...others] = loadBuiltinWorkflows(WORKFLOWS_DIR);
    expect(others).toEqual([]);
    if (!def) throw new Error("no built-in workflow");
    expect(def.id).toBe("feature-delivery");
    expect(def.version).toBe(12);
    expect(def.nodes).toHaveLength(5 + 2 + 6);
    const groups = new Set(def.nodes.map((n) => n.group));
    expect(groups).toEqual(new Set(["B1", "A", "B2", "C1", "C2"]));
    expect(def.lanes?.map((l) => [l.id, l.groups ?? [l.id]])).toEqual([["B1", ["B1"]], ["A", ["A"]], ["B2", ["B2"]], ["C", ["C1", "C2"]]]);
    for (const node of def.nodes) expect(node.id.startsWith(`${node.group}.`)).toBe(true);

    const byId = new Map(def.nodes.map((n) => [n.id, n]));
    // B1: the UI is built from Figma first; it needs no API contract.
    expect(byId.get("B1.figma_scope")?.dependencies).toEqual([]);
    // No "analyze project" step: the agent reads the project itself.
    expect(byId.has("B1.prepare_project")).toBe(false);
    expect(byId.get("B1.implement_ui")?.dependencies).toEqual(["B1.figma_scope"]);
    expect(byId.get("B1.implement_ui")).toMatchObject({ mutation: true, type: "ai.implement_ui" });
    expect(byId.get("B1.implement_ui")?.retryPolicy.maxAttempts).toBeGreaterThan(1);
    // A: the contract can arrive any time; the review starts once both it and the built UI exist.
    expect(byId.get("A.api_contract")?.dependencies).toEqual([]);
    // The review compares the contract with the built UI (Figma is not read again).
    expect(byId.get("A.review")?.dependencies).toEqual(["A.api_contract", "B1.implement_ui"]);
    expect(byId.get("A.review")).toMatchObject({ type: "readiness.review", readOnly: false, config: { ai: true } });
    expect(byId.get("A.api_contract")?.config?.["ai"]).toBeUndefined();
    // B2 integrates the API only from a reviewed contract and the BA checked against the built UI (v11).
    expect(byId.get("B2.ba_spec")).toMatchObject({ type: "tests.read_ba", group: "B2", dependencies: [] });
    expect(byId.get("B2.ba_ui_review")).toMatchObject({ type: "readiness.ba_ui_review", dependencies: ["B1.implement_ui", "B2.ba_spec"] });
    expect(byId.get("B2.api_binding")?.dependencies).toEqual(["A.review", "B2.ba_ui_review"]);
    // C1 designs tests from the BA and the UI vs BA review's decisions: no API contract or review.
    expect(byId.get("C1.test_design")?.dependencies).toEqual(["B2.ba_ui_review"]);
    // The operations guide is optional and only feeds the auto-tests: no dependency, no AI.
    expect(byId.get("C2.ops_guide")).toMatchObject({ type: "tests.read_ops_guide", dependencies: [] });
    expect(byId.get("C2.ops_guide")?.config?.["ai"]).toBeUndefined();
    // One agent session binds the API and completes the UI states; there is no backend check (v10).
    expect(byId.has("B2.ui_states")).toBe(false);
    expect(byId.has("B2.check_backend")).toBe(false);
    expect(byId.get("C2.generate_tests")?.dependencies).toEqual(["C1.test_design", "C2.ops_guide", "B2.api_binding"]);
    // The E2E tests run in their own session after the unit tests.
    expect(byId.get("C2.run_e2e")).toMatchObject({ type: "test.e2e", dependencies: ["C2.run_tests"] });
    expect(byId.get("C2.evidence_report")?.dependencies).toEqual(["C2.run_e2e"]);
    // Every AI step sets its model and effort: Opus for what is delivered or taken as the truth, Sonnet for the API review and the tests.
    const aiSteps = def.nodes.filter((n) => n.config?.["ai"]);
    for (const node of aiSteps) expect(node.config).toMatchObject({ model: expect.any(String), effort: expect.any(String) });
    expect(aiSteps.filter((n) => n.config?.["model"] === "opus").map((n) => n.id)).toEqual(["B1.implement_ui", "B2.ba_spec", "B2.ba_ui_review", "B2.api_binding", "C1.test_design"]);

    const graph = toGraph(def);
    expect(graph.lanes).toEqual(def.lanes);
    expect(graph.nodes).toHaveLength(def.nodes.length);
    expect(graph.edges.find((e) => e.id === "A.review->B2.api_binding")?.conditional).toBe(false);
    expect(graph.edges.some((e) => (e.source.startsWith("A.") || (e.source.startsWith("B") && e.source !== "B2.ba_ui_review")) && e.target.startsWith("C1."))).toBe(false);
  });
});
