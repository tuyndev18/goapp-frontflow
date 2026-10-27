import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StartSessionInput } from "@frontflow/cli-adapters";
import { createAgentEvent, type AgentEvent } from "@frontflow/event-schema";
import type { NodeExecutionContext } from "@frontflow/workflow-engine";
import { runAgentStep } from "../src/agent.js";
import type { NodeServices } from "../src/services.js";
import { SkillLibrary, parseSkillMarkdown, skillsPrompt, toSkillName } from "../src/skills.js";

const tmp = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));

function writeSkill(dir: string, content: string, extra: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), content);
  for (const [file, text] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
}

describe("SkillLibrary", () => {
  it("creates, renames and deletes skills, keeping step assignments in sync", () => {
    const lib = new SkillLibrary(path.join(tmp("ff-skills-"), "skills"));
    lib.save({ name: "react-page", description: "Page logic", body: "# React page\n\nUse hooks." });
    lib.save({ name: "a11y", description: "Accessibility", body: "Label every input." });
    expect(lib.list().map((s) => s.name)).toEqual(["a11y", "react-page"]);

    lib.setNodeSkills("feature-delivery", "B1.implement_ui", ["react-page", "a11y"]);
    lib.setNodeSkills("feature-delivery", "B2.ui_states", ["react-page"]);
    expect(lib.forNode("feature-delivery", "B1.implement_ui").map((s) => s.name)).toEqual(["react-page", "a11y"]);

    const renamed = lib.save({ name: "react-page-logic", description: "Page logic v2", body: "Use hooks and services." }, "react-page");
    expect(renamed.body).toBe("Use hooks and services.\n");
    expect(lib.get("react-page")).toBeUndefined();
    expect(lib.assignments()).toEqual({ "feature-delivery/B1.implement_ui": ["react-page-logic", "a11y"], "feature-delivery/B2.ui_states": ["react-page-logic"] });

    lib.remove("react-page-logic");
    expect(lib.assignments()).toEqual({ "feature-delivery/B1.implement_ui": ["a11y"] });
    expect(lib.list().map((s) => s.name)).toEqual(["a11y"]);
  });

  it("moves skills assigned to earlier workflow steps to the steps that replaced them", () => {
    const root = path.join(tmp("ff-skills-"), "skills");
    const lib = new SkillLibrary(root);
    lib.save({ name: "a11y", description: "Accessibility", body: "Label every input." });
    lib.save({ name: "states", description: "UI states", body: "Cover every state." });
    writeFileSync(
      path.join(root, "assignments.json"),
      JSON.stringify({ nodes: { "B.implement_ui": ["a11y"], "B2.business_ui": ["states"], "C.bind_ui_states": ["states", "a11y"] } }),
    );
    expect(lib.assignments()).toEqual({ "feature-delivery/B1.implement_ui": ["a11y"], "feature-delivery/B2.ui_states": ["states", "a11y"] });
    expect(lib.forNode("feature-delivery", "B2.ui_states").map((s) => s.name)).toEqual(["states", "a11y"]);
  });

  it("keeps the skills of a moved step under its new id, in every workflow and for runs started before", () => {
    const root = path.join(tmp("ff-skills-"), "skills");
    const lib = new SkillLibrary(root);
    lib.save({ name: "ba", description: "BA reading", body: "List every UI case." });
    writeFileSync(path.join(root, "assignments.json"), JSON.stringify({ nodes: { "feature-delivery/C1.ba_spec": ["ba"], "my-delivery/C1.ba_spec": ["ba"] } }));
    expect(lib.assignments()).toEqual({ "feature-delivery/B2.ba_spec": ["ba"], "my-delivery/B2.ba_spec": ["ba"] });
    expect(lib.forNode("feature-delivery", "B2.ba_spec").map((s) => s.name)).toEqual(["ba"]);
    expect(lib.forNode("my-delivery", "C1.ba_spec").map((s) => s.name)).toEqual(["ba"]);
  });

  it("keeps skills per workflow step, copied to a clone and dropped with a deleted workflow", () => {
    const lib = new SkillLibrary(path.join(tmp("ff-skills-"), "skills"));
    lib.save({ name: "a11y", description: "Accessibility", body: "Label every input." });
    lib.setNodeSkills("feature-delivery", "B1.implement_ui", ["a11y"]);
    expect(lib.forNode("quick-fix", "B1.implement_ui")).toEqual([]);
    lib.copyWorkflow("feature-delivery", "quick-fix");
    expect(lib.forNode("quick-fix", "B1.implement_ui").map((s) => s.name)).toEqual(["a11y"]);
    lib.forgetWorkflow("quick-fix");
    expect(lib.assignments()).toEqual({ "feature-delivery/B1.implement_ui": ["a11y"] });
  });

  it("validates names, duplicates and unknown skills", () => {
    const lib = new SkillLibrary(path.join(tmp("ff-skills-"), "skills"));
    expect(() => lib.save({ name: "Bad Name", description: "x", body: "y" })).toThrow(/lowercase/);
    expect(() => lib.save({ name: "ok", description: " ", body: "y" })).toThrow(/Describe/);
    lib.save({ name: "ok", description: "x", body: "y" });
    expect(() => lib.save({ name: "ok", description: "x", body: "y" })).toThrow(/already exists/);
    expect(() => lib.setNodeSkills("feature-delivery", "B2.api_binding", ["missing"])).toThrow(/Unknown skill: missing/);
    expect(lib.setNodeSkills("feature-delivery", "B2.api_binding", [])).toEqual({});
  });

  it("keeps other frontmatter keys when a skill is edited", () => {
    const root = path.join(tmp("ff-skills-"), "skills");
    writeSkill(path.join(root, "tools"), "---\nname: tools\ndescription: old\nallowed-tools: Read, Grep\n---\n\nBody");
    const lib = new SkillLibrary(root);
    lib.save({ name: "tools", description: "new", body: "New body" }, "tools");
    const { frontmatter, body } = parseSkillMarkdown(readFileSync(path.join(root, "tools", "SKILL.md"), "utf8"));
    expect(frontmatter).toEqual({ name: "tools", description: "new", "allowed-tools": "Read, Grep" });
    expect(body).toBe("New body\n");
  });

  it("imports a folder of skills with their files, naming skills without frontmatter after their path", () => {
    const source = tmp("ff-skill-src-");
    writeSkill(path.join(source, "e2e"), "---\nname: feature-e2e-test\ndescription: E2E frame\n---\n\nSee [probe](templates/probe.mjs).", { "templates/probe.mjs": "// probe" });
    writeSkill(path.join(source, "design-skills", "notion"), "## Overview\n\nWarm paper canvas and hairline cards.");
    writeSkill(path.join(source, "empty"), "---\nname: empty\ndescription: nothing\n---\n");
    mkdirSync(path.join(source, "e2e", "node_modules", "x"), { recursive: true });
    writeFileSync(path.join(source, "e2e", "node_modules", "x", "index.js"), "");

    const lib = new SkillLibrary(path.join(tmp("ff-skills-"), "skills"));
    const result = lib.importFrom(source);
    expect(result.imported.sort()).toEqual(["design-skills-notion", "feature-e2e-test"]);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "SKILL.md has no instructions" })]);

    const e2e = lib.get("feature-e2e-test")!;
    expect(e2e.files).toEqual(["templates/probe.mjs"]);
    expect(lib.get("design-skills-notion")!.description).toBe("Warm paper canvas and hairline cards.");

    // Importing again never overwrites the library's copy.
    expect(lib.importFrom(source).skipped.map((s) => s.reason)).toContain("a skill named feature-e2e-test already exists");
  });

  it("derives valid names", () => {
    expect(toSkillName("Design Skills/Claude")).toBe("design-skills-claude");
    expect(toSkillName("Tối ưu hiệu năng")).toBe("toi-uu-hieu-nang");
  });
});

describe("skillsPrompt", () => {
  it("lists each skill with its folder and files, and shortens very long skills", () => {
    const { text, truncated } = skillsPrompt([
      { name: "a", description: "A skill", body: "Do A.", files: ["templates/x.mjs"], dir: "/lib/a", updatedAt: "" },
      { name: "b", description: "Big", body: "x".repeat(70_000), files: [], dir: "/lib/b", updatedAt: "" },
    ]);
    expect(text).toContain('<skill name="a" folder="/lib/a">');
    expect(text).toContain("Files in this skill's folder: templates/x.mjs");
    expect(truncated).toEqual(["b"]);
    expect(text.length).toBeLessThan(70_000);
  });
});

describe("agent steps with skills", () => {
  it("adds the skills attached to the node to the prompt", async () => {
    const root = tmp("ff-agent-skills-");
    const lib = new SkillLibrary(path.join(root, "skills"));
    lib.save({ name: "react-page", description: "Page logic", body: "Use one service per feature." });
    lib.setNodeSkills("feature-delivery", "B1.implement_ui", ["react-page"]);

    const started: StartSessionInput[] = [];
    let handler: ((e: AgentEvent) => void) | undefined;
    const logs: string[] = [];
    const ctx = {
      runId: "run_1",
      projectId: "p1",
      workflowId: "feature-delivery",
      nodeId: "B1.implement_ui",
      nodeRunId: "nr_1",
      nodeType: "ai.implement_ui",
      attempt: 1,
      traceId: "trace_1",
      signal: new AbortController().signal,
      log: (_level: string, message: string) => logs.push(message),
      emitArtifact: () => undefined,
      emit: () => undefined,
    } as unknown as NodeExecutionContext;
    const services = {
      skills: lib,
      agents: {
        async start(adapterId: string, input: StartSessionInput) {
          started.push(input);
          setTimeout(() => handler?.(createAgentEvent("session.completed", { traceId: "trace_1", workflowRunId: "run_1", nodeRunId: "nr_1", sessionId: "ses_1" }, { result: "done" })), 5);
          return { id: "ses_1", adapterId, status: "running", cwd: input.cwd, startedAt: "" };
        },
        resume: () => Promise.reject(new Error("no")),
        cancel: async () => undefined,
        subscribeAll: (h: (e: AgentEvent) => void) => {
          handler = h;
          return () => (handler = undefined);
        },
      },
      settings: () => ({ allowArbitraryShell: false, commandTimeoutMs: 1000, agentTimeoutMs: 20_000, fixBudget: 1 }),
      mcpConfigDir: path.join(root, "mcp"),
    } as unknown as NodeServices;

    // The `fake` test adapter is the only one allowed to run headless.
    const result = await runAgentStep(ctx, services, { projectId: "p1", adapterId: "fake", cwd: root, prompt: "Build the UI", readOnly: false });

    expect(result.resultText).toBe("done");
    expect(started[0]!.prompt.startsWith("Build the UI\n\n## Skills for this step")).toBe(true);
    expect(started[0]!.prompt).toContain("Use one service per feature.");
    expect(logs.some((l) => /^Skills: react-page \([0-9a-f]{8}\)$/.test(l))).toBe(true);
    expect(existsSync(path.join(root, "skills", "react-page", "SKILL.md"))).toBe(true);
  });
});
