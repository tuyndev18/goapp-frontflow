import type { NodeRunStatus, WorkflowRunStatus } from "@frontflow/domain";

/** Flo, the run's pixel mascot: one mood per kind of thing the run is doing. */
export const FLO_MOODS = ["idle", "thinking", "reading", "coding", "testing", "waiting", "retrying", "paused", "passed", "assumed", "blocked", "failed"] as const;
export type FloMood = (typeof FLO_MOODS)[number];

export interface FloStep {
  id: string;
  type: string;
  status: NodeRunStatus | undefined;
}

export interface FloFocus {
  mood: FloMood;
  /** The step Flo is about, when one step explains the mood. */
  nodeId?: string;
}

const READING = new Set(["figma.design", "readiness.read_api", "tests.read_ba", "tests.read_ops_guide"]);
const CODING = new Set(["ai.implement_ui", "ai.api_integration", "ai.bind_ui_states", "ai.prompt"]);
const TESTING = new Set(["ai.acceptance_tests", "test.acceptance", "test.e2e"]);

/** How a working step looks: reading input, writing code, testing — anything else is analysis. */
export function moodForStepType(type: string): FloMood {
  if (READING.has(type)) return "reading";
  if (CODING.has(type)) return "coding";
  if (TESTING.has(type)) return "testing";
  return "thinking";
}

/**
 * What Flo shows for a run, most urgent first: a paused or finished run, a step waiting for the
 * user, a retry, the step at work, then a failed or blocked step the run is going around.
 * `steps` in workflow order; the first match wins.
 */
export function floFocus(runStatus: WorkflowRunStatus | undefined, steps: FloStep[]): FloFocus {
  const find = (...statuses: NodeRunStatus[]) => steps.find((s) => s.status !== undefined && statuses.includes(s.status));
  const about = (mood: FloMood, step: FloStep | undefined): FloFocus => (step ? { mood, nodeId: step.id } : { mood });

  switch (runStatus) {
    case "paused":
    case "cancelled":
      return { mood: "paused" };
    case "completed":
      return { mood: "passed" };
    case "completed_with_assumptions":
      return { mood: "assumed" };
    case "blocked":
      return about("blocked", find("blocked", "failed"));
    case "failed":
    case "timed_out":
      return about("failed", find("failed", "blocked"));
  }

  const waiting = find("waiting_for_input");
  if (waiting || runStatus === "waiting" || runStatus === "test_design_pending") return about("waiting", waiting);
  const retrying = find("retrying");
  if (retrying) return about("retrying", retrying);
  const running = find("running");
  if (running) return about(moodForStepType(running.type), running);
  const failed = find("failed");
  if (failed) return about("failed", failed);
  const blocked = find("blocked");
  if (blocked) return about("blocked", blocked);
  return { mood: "idle" };
}
