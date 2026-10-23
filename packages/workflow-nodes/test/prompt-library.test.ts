import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBuiltinWorkflows } from "@frontflow/workflow-engine";
import { PromptLibrary, promptPlaceholders, renderPrompt, SYSTEM_PROMPT_NAME } from "../src/prompt-library.js";

const WORKFLOWS = fileURLToPath(new URL("../../../workflows", import.meta.url));
const library = () => new PromptLibrary({ defaultsDir: path.join(WORKFLOWS, "prompts"), userDir: path.join(mkdtempSync(path.join(tmpdir(), "ff-prompts-")), "prompts") });

describe("PromptLibrary", () => {
  it("ships a prompt for every AI step of the workflow, plus the system prompt", () => {
    const lib = library();
    const aiSteps = loadBuiltinWorkflows(WORKFLOWS)
      .nodes.filter((n) => n.config?.["ai"] === true)
      .map((n) => n.id);
    expect(lib.list()).toEqual([SYSTEM_PROMPT_NAME, ...aiSteps].sort());
    for (const name of lib.list()) expect(lib.get(name).text.trim().length).toBeGreaterThan(50);
  });

  it("keeps the user's edit until it is reset to the default", () => {
    const lib = library();
    const original = lib.get("B1.implement_ui");
    expect(original.customized).toBe(false);
    const edited = lib.save("B1.implement_ui", "Build {{feature}} pixel-perfect.\n{{figma}}");
    expect(edited).toMatchObject({ customized: true, text: "Build {{feature}} pixel-perfect.\n{{figma}}\n", defaultText: original.text });
    expect(lib.get("B1.implement_ui").customized).toBe(true);
    expect(lib.reset("B1.implement_ui")).toMatchObject({ customized: false, text: original.text });
  });

  it("rejects names that could escape the prompt folders", () => {
    const lib = library();
    expect(() => lib.get("../secrets")).toThrow(/Invalid prompt name/);
    expect(() => lib.save("a/b", "x")).toThrow(/Invalid prompt name/);
    expect(() => lib.get("nope")).toThrow(/No prompt named/);
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
