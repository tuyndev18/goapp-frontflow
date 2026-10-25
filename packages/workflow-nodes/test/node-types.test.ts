import { describe, expect, it } from "vitest";
import { loadWorkflowYaml, parseWorkflowDefinition } from "@frontflow/workflow-engine";
import { checkWorkflowNodes, newNodeSpec, NODE_TYPES, stepsWithoutPrompt } from "../src/node-types.js";

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
