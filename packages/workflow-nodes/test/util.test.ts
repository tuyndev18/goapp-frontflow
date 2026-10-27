import { describe, expect, it } from "vitest";
import { claudeAccountOf } from "../src/util.js";

const input = (inputs: Record<string, unknown>, config: Record<string, unknown> = {}) => ({ inputs: { snapshotIds: [], adapterId: "claude-code", ...inputs }, upstream: {}, config });

describe("claudeAccountOf", () => {
  it("runs a step with its own model and effort when the run chose none", () => {
    expect(claudeAccountOf(input({}, { model: "sonnet", effort: "medium" }))).toEqual({ model: "sonnet", effort: "medium" });
  });

  it("lets the run's model and effort override the step's, each on its own", () => {
    expect(claudeAccountOf(input({ model: "opus", effort: "high" }, { model: "sonnet", effort: "medium" }))).toEqual({ model: "opus", effort: "high" });
    expect(claudeAccountOf(input({ model: "opus" }, { model: "sonnet", effort: "medium" }))).toEqual({ model: "opus", effort: "medium" });
  });

  it("lets the choice for this step of the run win over the run's and the workflow's", () => {
    expect(claudeAccountOf(input({ model: "opus", effort: "high" }, { model: "sonnet", effort: "medium" }), { model: "haiku" })).toEqual({ model: "haiku", effort: "high" });
    expect(claudeAccountOf(input({}, { model: "sonnet" }), { effort: "low" })).toEqual({ model: "sonnet", effort: "low" });
  });

  it("leaves both to Claude Code when neither the run nor the step sets them", () => {
    expect(claudeAccountOf(input({ claudeAccountId: "acc_1" }))).toEqual({ claudeAccountId: "acc_1" });
    expect(claudeAccountOf(input({ model: "" }, { model: 42 }))).toEqual({});
  });
});
