import { describe, expect, it } from "vitest";
import { floFocus, moodForStepType, type FloStep } from "../src/mascot.js";

const step = (id: string, type: string, status: FloStep["status"]): FloStep => ({ id, type, status });

describe("Flo's mood", () => {
  it("tells reading, coding and testing steps from analysis", () => {
    expect(moodForStepType("readiness.read_api")).toBe("reading");
    expect(moodForStepType("ai.implement_ui")).toBe("coding");
    expect(moodForStepType("test.e2e")).toBe("testing");
    expect(moodForStepType("readiness.review")).toBe("thinking");
    expect(moodForStepType("custom.unknown")).toBe("thinking");
  });

  it("follows a paused or finished run over its steps", () => {
    const steps = [step("B1", "ai.implement_ui", "running")];
    expect(floFocus("paused", steps)).toEqual({ mood: "paused" });
    expect(floFocus("cancelled", steps)).toEqual({ mood: "paused" });
    expect(floFocus("completed", [])).toEqual({ mood: "passed" });
    expect(floFocus("completed_with_assumptions", [])).toEqual({ mood: "assumed" });
    expect(floFocus("timed_out", [step("C2", "test.e2e", "failed")])).toEqual({ mood: "failed", nodeId: "C2" });
    expect(floFocus("blocked", [step("A", "readiness.review", "blocked")])).toEqual({ mood: "blocked", nodeId: "A" });
  });

  it("puts a step waiting for the user before work in progress", () => {
    const steps = [step("B1", "ai.implement_ui", "running"), step("A", "readiness.read_api", "waiting_for_input")];
    expect(floFocus("running", steps)).toEqual({ mood: "waiting", nodeId: "A" });
    expect(floFocus("test_design_pending", [])).toEqual({ mood: "waiting" });
  });

  it("shows a retry, then the first working step by its type", () => {
    expect(floFocus("running", [step("B1", "ai.implement_ui", "running"), step("C2", "test.acceptance", "retrying")])).toEqual({ mood: "retrying", nodeId: "C2" });
    expect(floFocus("running", [step("A", "readiness.read_api", "passed"), step("B1", "ai.implement_ui", "running"), step("C2", "test.e2e", "running")])).toEqual({
      mood: "coding",
      nodeId: "B1",
    });
  });

  it("falls back to a failed or blocked step, then idle", () => {
    expect(floFocus("running", [step("A", "readiness.review", "blocked"), step("C2", "test.e2e", "failed")])).toEqual({ mood: "failed", nodeId: "C2" });
    expect(floFocus("running", [step("A", "readiness.review", "blocked")])).toEqual({ mood: "blocked", nodeId: "A" });
    expect(floFocus("queued", [step("A", "readiness.read_api", "pending")])).toEqual({ mood: "idle" });
    expect(floFocus(undefined, [])).toEqual({ mood: "idle" });
  });
});
