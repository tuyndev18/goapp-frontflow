import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_DELIVERY_WORKFLOW_ID, loadBuiltinWorkflows, loadWorkflowYaml, parseWorkflowDefinition, type WorkflowDefinition } from "@frontflow/workflow-engine";
import { checkWorkflowNodes, newNodeSpec, NODE_TYPES, stepsWithoutPrompt, upgradeWorkflow } from "../src/node-types.js";

const workflow = (nodes: string) => loadWorkflowYaml(`id: w\nname: W\nnodes:\n${nodes}`);

describe("checkWorkflowNodes", () => {
  it("accepts generic steps anywhere and any number of times", () => {
    expect(
      checkWorkflowNodes(workflow("  - { id: a, type: ai.prompt }\n  - { id: b, type: ai.prompt, dependencies: [a] }\n  - { id: c, type: manual.check, dependencies: [b] }\n")),
    ).toEqual([]);
  });

  it("keeps built-in steps on their id, after the steps they read", () => {
    expect(checkWorkflowNodes(workflow("  - { id: x, type: unknown.step }\n"))).toEqual(['node "x": unknown step type "unknown.step"']);
    expect(checkWorkflowNodes(workflow("  - { id: ui, type: figma.design }\n"))).toEqual(['node "ui": a "Select Figma scope" step must have the id "B1.figma_scope"']);
    expect(checkWorkflowNodes(workflow("  - { id: B1.implement_ui, type: ai.implement_ui }\n"))).toEqual([
      'node "B1.implement_ui" reads the output of "B1.figma_scope": add that step before it',
    ]);
    // Transitive: a generic step in between is fine.
    expect(
      checkWorkflowNodes(
        workflow(
          "  - { id: B1.figma_scope, type: figma.design }\n  - { id: prep, type: ai.prompt, dependencies: [B1.figma_scope] }\n  - { id: B1.implement_ui, type: ai.implement_ui, dependencies: [prep] }\n",
        ),
      ),
    ).toEqual([]);
  });

  it("checks the model and effort a step sets for its agent", () => {
    expect(checkWorkflowNodes(workflow("  - { id: a, type: ai.prompt, config: { model: claude-sonnet-5-5, effort: xhigh } }\n"))).toEqual([]);
    expect(checkWorkflowNodes(workflow("  - { id: a, type: ai.prompt, config: { model: 'opus --dangerous', effort: extreme } }\n"))).toEqual([
      'node "a": config.model must be a model alias or id',
      'node "a": config.effort must be one of low, medium, high, xhigh, max',
    ]);
  });

  it("lists every built-in step type once, with a unique id", () => {
    const ids = NODE_TYPES.flatMap((t) => (t.fixedId ? [t.fixedId] : []));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(NODE_TYPES.map((t) => t.type)).size).toBe(NODE_TYPES.length);
  });
});

describe("newNodeSpec", () => {
  const builtin = workflow("  - { id: B1.figma_scope, type: figma.design, label: Select Figma scope, timeoutMs: 180000, retryPolicy: { maxAttempts: 3 } }\n");

  it("copies built-in steps from the built-in workflow, on the lane asked for", () => {
    expect(newNodeSpec("figma.design", { id: "ignored", group: "ui" }, builtin)).toMatchObject({ id: "B1.figma_scope", group: "ui", timeoutMs: 180000, retryPolicy: { maxAttempts: 3 }, dependencies: [] });
  });

  it("makes generic steps that parse back into a valid workflow", () => {
    const nodes = [
      newNodeSpec("ai.prompt", { id: "fix", group: "main" }, builtin),
      { ...newNodeSpec("manual.check", { id: "check", label: "QA", group: "main" }, builtin), dependencies: ["fix"] },
    ];
    expect(nodes[0]).toMatchObject({ label: "AI prompt", mutation: true, config: { ai: true }, timeoutMs: 0 });
    const def = parseWorkflowDefinition({ id: "w", name: "W", lanes: [{ id: "main", title: "Main" }], nodes });
    expect(checkWorkflowNodes(def)).toEqual([]);
    expect(def.nodes[1]).toMatchObject({ label: "QA", mutation: false, retryPolicy: { maxAttempts: 1 } });
    expect(() => newNodeSpec("nope", { id: "x", group: "main" }, builtin)).toThrow(/Unknown step type/);
  });
});

describe("upgradeWorkflow", () => {
  const builtin = loadBuiltinWorkflows(fileURLToPath(new URL("../../../workflows", import.meta.url))).find((d) => d.id === FEATURE_DELIVERY_WORKFLOW_ID);
  if (!builtin) throw new Error("no built-in workflow");
  const shape = (def: WorkflowDefinition) => def.nodes.map((n) => [n.id, n.group, n.dependencies]).sort();

  it("moves the BA step of a workflow cloned from feature delivery v8 into lane ③", () => {
    // The clone as it was saved before v9: the BA read in C1, the API bound without it.
    const v8 = structuredClone(builtin);
    for (const node of v8.nodes) {
      if (node.id === "B2.ba_spec") Object.assign(node, { id: "C1.ba_spec", group: "C1" });
      node.dependencies = node.dependencies.filter((d) => !(node.id === "B2.api_binding" && d === "B2.ba_spec")).map((d) => (d === "B2.ba_spec" ? "C1.ba_spec" : d));
    }
    expect(checkWorkflowNodes(v8)).not.toEqual([]);
    const upgraded = upgradeWorkflow(v8);
    if (!upgraded) throw new Error("not upgraded");
    expect(shape(upgraded)).toEqual(shape(builtin));
    expect(checkWorkflowNodes(upgraded)).toEqual([]);
  });

  it("finds every built-in step type in the built-in workflow, except the retired ones", () => {
    const ids = new Set(builtin.nodes.map((n) => n.id));
    const builtinTypes = NODE_TYPES.filter((t) => t.fixedId);
    expect(builtinTypes.filter((t) => !t.retired && !ids.has(t.fixedId ?? "")).map((t) => t.type)).toEqual([]);
    expect(builtinTypes.filter((t) => t.retired).map((t) => t.fixedId)).toEqual(["B2.check_backend", "B2.ui_states"]);
    expect(builtinTypes.filter((t) => t.retired && ids.has(t.fixedId ?? ""))).toEqual([]);
  });

  it("leaves current workflows and generic steps alone", () => {
    expect(upgradeWorkflow(builtin)).toBeUndefined();
    expect(upgradeWorkflow(workflow("  - { id: C1.ba_spec, type: ai.prompt }\n"))).toBeUndefined();
  });
});

describe("stepsWithoutPrompt", () => {
  it("lists prompt steps whose prompt is missing or empty", () => {
    const def = workflow("  - { id: a, type: ai.prompt }\n  - { id: b, type: manual.check }\n  - { id: B1.figma_scope, type: figma.design }\n");
    const texts: Record<string, string> = { b: "  \n" };
    const prompts = {
      get(name: string) {
        const text = texts[name];
        if (text === undefined) throw new Error("none");
        return { name, text, customized: true, defaultText: "" };
      },
    };
    expect(stepsWithoutPrompt(def, prompts)).toEqual(["a", "b"]);
    texts["a"] = "Do it";
    texts["b"] = "Check it";
    expect(stepsWithoutPrompt(def, prompts)).toEqual([]);
  });
});
