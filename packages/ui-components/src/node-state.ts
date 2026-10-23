import type { NodeRunStatus, WorkflowRunStatus } from "@frontflow/domain";

/** Spec §20.2 visual states. Never colour-only: every state has an icon and a text label. */
export type VisualState = "pending" | "running" | "passed" | "waiting" | "retrying" | "blocked" | "failed" | "skipped" | "cancelled";

export interface VisualStateSpec {
  state: VisualState;
  label: string;
  icon: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger" | "muted";
  animated: boolean;
}

const SPECS: Record<VisualState, VisualStateSpec> = {
  pending: { state: "pending", label: "Pending", icon: "○", tone: "neutral", animated: false },
  running: { state: "running", label: "Running", icon: "◐", tone: "info", animated: true },
  passed: { state: "passed", label: "Passed", icon: "✓", tone: "success", animated: false },
  waiting: { state: "waiting", label: "Waiting", icon: "⏸", tone: "warning", animated: false },
  retrying: { state: "retrying", label: "Retrying", icon: "↻", tone: "warning", animated: true },
  blocked: { state: "blocked", label: "Blocked", icon: "⚠", tone: "warning", animated: false },
  failed: { state: "failed", label: "Failed", icon: "✕", tone: "danger", animated: false },
  skipped: { state: "skipped", label: "Skipped", icon: "⤼", tone: "muted", animated: false },
  cancelled: { state: "cancelled", label: "Cancelled", icon: "⊘", tone: "muted", animated: false },
};

export function visualStateForNode(status: NodeRunStatus | undefined): VisualStateSpec {
  switch (status) {
    case undefined:
    case "pending":
    case "ready":
    // Waiting for earlier steps is the normal queued state, not something the user must act on.
    case "waiting_for_dependency":
      return SPECS.pending;
    case "running":
      return SPECS.running;
    case "waiting_for_input":
      return { ...SPECS.waiting, label: "Needs input" };
    case "retrying":
      return SPECS.retrying;
    case "passed":
      return SPECS.passed;
    case "failed":
      return SPECS.failed;
    case "blocked":
      return SPECS.blocked;
    case "skipped":
      return SPECS.skipped;
    case "cancelled":
      return SPECS.cancelled;
  }
}

export function visualStateForRun(status: WorkflowRunStatus | undefined): VisualStateSpec {
  switch (status) {
    case undefined:
    case "queued":
      return SPECS.pending;
    case "running":
      return SPECS.running;
    case "waiting":
    case "paused":
      return { ...SPECS.waiting, label: status === "paused" ? "Paused" : "Waiting" };
    case "test_design_pending":
      return { ...SPECS.waiting, label: "Test design pending" };
    case "completed":
      return SPECS.passed;
    case "completed_with_assumptions":
      return { ...SPECS.passed, label: "Completed with assumptions" };
    case "blocked":
      return SPECS.blocked;
    case "failed":
      return SPECS.failed;
    case "timed_out":
      return { ...SPECS.failed, label: "Timed out" };
    case "cancelled":
      return SPECS.cancelled;
  }
}

export function describeWaiting(status: NodeRunStatus | undefined, waitingOn: string[] | undefined): string | undefined {
  if (status === "waiting_for_input") return "Waiting for input";
  if (status === "waiting_for_dependency" && waitingOn?.length) return `Waiting for ${waitingOn.join(", ")}`;
  return undefined;
}
