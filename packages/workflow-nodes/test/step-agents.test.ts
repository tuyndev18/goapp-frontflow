import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StepAgentStore } from "../src/step-agents.js";

const store = () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-step-agents-"));
  return { dir, store: new StepAgentStore((runId) => join(dir, runId, "step-agents.json")) };
};

describe("StepAgentStore", () => {
  it("keeps each step's model and effort per run", () => {
    const { store: s } = store();
    expect(s.get("run_1", "B1.implement_ui")).toEqual({});
    expect(s.set("run_1", "B1.implement_ui", { model: "opus", effort: "high" })).toEqual({ model: "opus", effort: "high" });
    s.set("run_1", "C2.run_tests", { effort: "low" });
    expect(s.all("run_1")).toEqual({ "B1.implement_ui": { model: "opus", effort: "high" }, "C2.run_tests": { effort: "low" } });
    expect(s.get("run_2", "B1.implement_ui")).toEqual({});
  });

  it("drops a step whose choice is cleared", () => {
    const { store: s } = store();
    s.set("run_1", "B1.implement_ui", { model: "opus" });
    expect(s.set("run_1", "B1.implement_ui", { model: "" })).toEqual({});
    expect(s.all("run_1")).toEqual({});
  });

  it("refuses what could not go on Claude Code's command line, also from a hand-edited file", () => {
    const { dir, store: s } = store();
    expect(() => s.set("run_1", "a", { model: "opus --dangerously-skip-permissions" })).toThrow(/Invalid model/);
    expect(() => s.set("run_1", "a", { effort: "extreme" })).toThrow(/Effort must be one of/);
    s.set("run_1", "a", { model: "sonnet" });
    const file = join(dir, "run_1", "step-agents.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ steps: { a: { model: "sonnet" } } });
    writeFileSync(file, JSON.stringify({ steps: { a: { model: "x y", effort: "high" }, b: "nope" } }));
    expect(s.all("run_1")).toEqual({ a: { effort: "high" } });
  });
});
