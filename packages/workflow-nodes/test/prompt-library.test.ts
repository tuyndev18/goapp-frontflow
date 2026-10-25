import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_DELIVERY_WORKFLOW_ID, loadBuiltinWorkflows } from "@frontflow/workflow-engine";
import { additionsPrompt, ProjectPromptStore, PromptLibrary, promptPlaceholders, renderPrompt, SYSTEM_PROMPT_NAME } from "../src/prompt-library.js";
import { stepsWithoutPrompt } from "../src/node-types.js";

const WORKFLOWS = fileURLToPath(new URL("../../../workflows", import.meta.url));
const FD = FEATURE_DELIVERY_WORKFLOW_ID;
const tmp = () => mkdtempSync(path.join(tmpdir(), "ff-prompts-"));
const library = (userDir = path.join(tmp(), "prompts")) => new PromptLibrary({ defaultsDir: path.join(WORKFLOWS, "prompts"), userDir });

describe("PromptLibrary", () => {
  it("ships a prompt for every AI step of the built-in workflow, plus the system prompt", () => {
    const lib = library();
    const [definition] = loadBuiltinWorkflows(WORKFLOWS);
    if (!definition) throw new Error("no built-in workflow");
    const aiSteps = definition.nodes.filter((n) => n.config?.["ai"] === true).map((n) => n.id);
    expect(lib.list(FD)).toEqual([...aiSteps].sort());
    for (const name of lib.list(FD)) expect(lib.get(name, FD).text.trim().length).toBeGreaterThan(50);
    expect(lib.get(SYSTEM_PROMPT_NAME).text.trim().length).toBeGreaterThan(50);
    expect(stepsWithoutPrompt(definition, lib)).toEqual([]);
  });

  it("keeps the user's edit until it is reset to the default", () => {
    const lib = library();
    const original = lib.get("B1.implement_ui", FD);
    expect(original.customized).toBe(false);
    const edited = lib.save("B1.implement_ui", FD, "Build {{feature}} pixel-perfect.\n{{figma}}");
    expect(edited).toMatchObject({ workflowId: FD, customized: true, text: "Build {{feature}} pixel-perfect.\n{{figma}}\n", defaultText: original.text });
    expect(lib.get("B1.implement_ui", FD).customized).toBe(true);
    expect(lib.reset("B1.implement_ui", FD)).toMatchObject({ customized: false, text: original.text });
  });

  it("keeps prompts per workflow and copies them to a clone", () => {
    const lib = library();
    expect(lib.find("fix", "quick-fix")).toBeUndefined();
    lib.save("fix", "quick-fix", "Fix {{feature}}");
    lib.save("B1.implement_ui", FD, "Edited");
    lib.copyWorkflow(FD, "my-delivery", ["B1.implement_ui", "A.review", "B1.figma_scope"]);
    expect(lib.get("B1.implement_ui", "my-delivery")).toMatchObject({ text: "Edited\n", customized: true, defaultText: "" });
    expect(lib.get("A.review", "my-delivery").text).toBe(lib.get("A.review", FD).text);
    expect(lib.find("B1.figma_scope", "my-delivery")).toBeUndefined();
    lib.forgetWorkflow("my-delivery");
    expect(lib.find("B1.implement_ui", "my-delivery")).toBeUndefined();
    expect(lib.get("fix", "quick-fix").text).toBe("Fix {{feature}}\n");
  });

  it("moves edits saved before workflows could be chosen into the feature delivery workflow", () => {
    const userDir = path.join(tmp(), "prompts");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(path.join(userDir, "A.review.md"), "Old edit\n");
    writeFileSync(path.join(userDir, `${SYSTEM_PROMPT_NAME}.md`), "System edit\n");
    const lib = library(userDir);
    lib.migrateLegacyEdits(FD);
    expect(lib.get("A.review", FD)).toMatchObject({ text: "Old edit\n", customized: true });
    expect(lib.get(SYSTEM_PROMPT_NAME).text).toBe("System edit\n");
    expect(existsSync(path.join(userDir, "A.review.md"))).toBe(false);
  });

  it("rejects names that could escape the prompt folders", () => {
    const lib = library();
    expect(() => lib.get("../secrets", FD)).toThrow(/Invalid prompt name/);
    expect(() => lib.save("a/b", FD, "x")).toThrow(/Invalid prompt name/);
    expect(() => lib.get("A.review", "../x")).toThrow(/Invalid workflow id/);
    expect(() => lib.get("A.review")).toThrow(/say which workflow/);
    expect(() => lib.get("nope", FD)).toThrow(/No prompt named/);
  });
});

describe("ProjectPromptStore", () => {
  it("keeps each project's additions per workflow step, in order", () => {
    const dir = tmp();
    const store = new ProjectPromptStore((projectId) => path.join(dir, projectId, "prompt-additions.json"));
    expect(store.list("p1", FD, "B1.implement_ui")).toEqual([]);
    const saved = store.set("p1", FD, "B1.implement_ui", [
      { title: " Tokens ", text: " Use src/theme tokens. ", enabled: true },
      { title: "", text: "No inline styles.", enabled: false },
    ]);
    expect(saved).toMatchObject([
      { title: "Tokens", text: "Use src/theme tokens.", enabled: true },
      { title: "", text: "No inline styles.", enabled: false },
    ]);
    expect(saved[0]?.id).toMatch(/^pa_/);
    expect(store.list("p1", FD, "B1.implement_ui")).toEqual(saved);
    expect(store.list("p2", FD, "B1.implement_ui")).toEqual([]);
    expect(store.list("p1", "other", "B1.implement_ui")).toEqual([]);
    expect(Object.keys(store.all("p1"))).toEqual([`${FD}/B1.implement_ui`]);
    expect(store.set("p1", FD, "B1.implement_ui", [])).toEqual([]);
    expect(store.all("p1")).toEqual({});
  });

  it("appends only the enabled additions after the step prompt", () => {
    expect(additionsPrompt([])).toBe("");
    expect(
      additionsPrompt([
        { id: "a", title: "Tokens", text: "Use tokens.", enabled: true },
        { id: "b", title: "Off", text: "Ignored.", enabled: false },
        { id: "c", title: "", text: "No inline styles.", enabled: true },
      ]),
    ).toBe("## Additional instructions for this project\n\n### Tokens\nUse tokens.\n\nNo inline styles.");
  });
});

describe("renderPrompt", () => {
  it("fills placeholders and reports the ones without a value", () => {
    const { text, missing } = renderPrompt("Feature {{ feature }}.\n\n\n\n{{figma}}\n{{unknown}}", { feature: "Cancel order", figma: "layer 1" });
    expect(text).toBe("Feature Cancel order.\n\nlayer 1");
    expect(missing).toEqual(["unknown"]);
    expect(promptPlaceholders("{{a}} {{b}} {{a}}")).toEqual(["a", "b"]);
  });
});
