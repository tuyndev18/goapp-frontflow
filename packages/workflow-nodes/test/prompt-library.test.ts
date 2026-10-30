import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_DELIVERY_WORKFLOW_ID, loadBuiltinWorkflows } from "@frontflow/workflow-engine";
import { additionsPrompt, ProjectPromptStore, PromptLibrary, promptPlaceholders, renderPrompt, SYSTEM_PROMPT_NAME } from "../src/prompt-library.js";
import { NODE_TYPES, stepsWithoutPrompt } from "../src/node-types.js";

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
    // Retired steps keep their prompt for the runs and cloned workflows that still have them.
    const retired = NODE_TYPES.filter((t) => t.retired && t.prompt && t.fixedId).map((t) => t.fixedId ?? "");
    expect(lib.list(FD)).toEqual([...aiSteps, ...retired].sort());
    for (const name of lib.list(FD)) expect(lib.get(name, FD).text.trim().length).toBeGreaterThan(50);
    // Shared by every AI step: FrontFlow hands over inputs and scope, the project decides how.
    expect(lib.get(SYSTEM_PROMPT_NAME).text).toContain("theo chỉ dẫn và code của chính project");
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

  it("keeps the edits of a moved step under its new id, in every workflow and for runs started before", () => {
    const userDir = path.join(tmp(), "prompts");
    mkdirSync(path.join(userDir, FD), { recursive: true });
    mkdirSync(path.join(userDir, "my-delivery"), { recursive: true });
    writeFileSync(path.join(userDir, FD, "C1.ba_spec.md"), "Old BA edit\n");
    writeFileSync(path.join(userDir, "my-delivery", "C1.ba_spec.md"), "Clone BA edit\n");
    const lib = library(userDir);
    lib.migrateLegacyEdits(FD);
    expect(lib.get("B2.ba_spec", FD)).toMatchObject({ text: "Old BA edit\n", customized: true });
    expect(lib.get("B2.ba_spec", "my-delivery").text).toBe("Clone BA edit\n");
    expect(existsSync(path.join(userDir, FD, "C1.ba_spec.md"))).toBe(false);
    // A run started before still finds its step's prompt.
    expect(lib.get("C1.ba_spec", FD).text).toBe("Old BA edit\n");
    expect(lib.reset("C1.ba_spec", FD).text).toBe(lib.get("B2.ba_spec", FD).defaultText);
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

  it("keeps the additions of a moved step under its new id", () => {
    const dir = tmp();
    const file = path.join(dir, "p1", "prompt-additions.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ steps: { [`${FD}/C1.ba_spec`]: [{ id: "pa_1", title: "", text: "Read the annex too.", enabled: true }] } }));
    const store = new ProjectPromptStore(() => file);
    expect(Object.keys(store.all("p1"))).toEqual([`${FD}/B2.ba_spec`]);
    expect(store.list("p1", FD, "B2.ba_spec")).toEqual([{ id: "pa_1", title: "", text: "Read the annex too.", enabled: true }]);
    expect(store.list("p1", FD, "C1.ba_spec")).toHaveLength(1);
  });

  it("appends only the enabled additions after the step prompt", () => {
    expect(additionsPrompt([])).toBe("");
    expect(
      additionsPrompt([
        { id: "a", title: "Tokens", text: "Use tokens.", enabled: true },
        { id: "b", title: "Off", text: "Ignored.", enabled: false },
        { id: "c", title: "", text: "No inline styles.", enabled: true },
      ]),
    ).toBe("## Chỉ dẫn bổ sung của project\n\n### Tokens\nUse tokens.\n\nNo inline styles.");
  });

  it("appends the feature's additions after the project's", () => {
    const tokens = { id: "a", title: "Tokens", text: "Use tokens.", enabled: true };
    const modal = { id: "b", title: "", text: "The modal closes on Esc.", enabled: true };
    expect(additionsPrompt([tokens], [modal])).toBe(
      "## Chỉ dẫn bổ sung của project\n\n### Tokens\nUse tokens.\n\n## Chỉ dẫn bổ sung của tính năng này\n\nThe modal closes on Esc.",
    );
    expect(additionsPrompt([], [modal, { ...tokens, enabled: false }])).toBe("## Chỉ dẫn bổ sung của tính năng này\n\nThe modal closes on Esc.");
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
