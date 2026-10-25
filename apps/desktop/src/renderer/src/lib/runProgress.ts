import type { LaneDto, RunStepDto } from "../../../shared/ipc.js";
import { durationText } from "./accounts.js";
import { laneFor, lanesOf } from "./groups.js";

/** How a stage of the run stands, worst first: what the user must act on comes before progress. */
export type LaneState = "failed" | "attention" | "active" | "done" | "pending";

export interface LaneProgress {
  id: string;
  title: string;
  done: number;
  total: number;
  state: LaneState;
}

export interface RunProgress {
  done: number;
  total: number;
  running: RunStepDto[];
  /** Steps waiting for the user's input. */
  waiting: RunStepDto[];
  failed: RunStepDto[];
  lanes: LaneProgress[];
}

const DONE = new Set(["passed", "skipped"]);
const RUNNING = new Set(["running", "retrying"]);
const FAILED = new Set(["failed", "blocked"]);

export const LANE_STATE_TEXT: Record<LaneState, { icon: string; label: string }> = {
  failed: { icon: "✕", label: "failed" },
  attention: { icon: "⏸", label: "needs you" },
  active: { icon: "◐", label: "in progress" },
  done: { icon: "✓", label: "done" },
  pending: { icon: "○", label: "not started" },
};

export function runProgress(steps: RunStepDto[], workflowLanes?: LaneDto[]): RunProgress {
  const all = lanesOf(workflowLanes, steps);
  const lanes = all.map((lane) => {
    const own = steps.filter((s) => laneFor(all, s)?.id === lane.id);
    const done = own.filter((s) => DONE.has(s.status ?? "")).length;
    const state: LaneState = own.some((s) => FAILED.has(s.status ?? ""))
      ? "failed"
      : own.some((s) => s.status === "waiting_for_input")
        ? "attention"
        : own.length && done === own.length
          ? "done"
          : own.some((s) => s.status && s.status !== "pending" && s.status !== "waiting_for_dependency")
            ? "active"
            : "pending";
    return { id: lane.id, title: lane.title, done, total: own.length, state };
  }).filter((l) => l.total > 0);
  return {
    done: steps.filter((s) => DONE.has(s.status ?? "")).length,
    total: steps.length,
    running: steps.filter((s) => RUNNING.has(s.status ?? "")),
    waiting: steps.filter((s) => s.status === "waiting_for_input"),
    failed: steps.filter((s) => FAILED.has(s.status ?? "")),
    lanes,
  };
}

/** "just now", "12m ago", "3h 5m ago", "2d 4h ago"; a date after a week. */
export function timeAgo(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  if (ms < 60_000) return "just now";
  if (ms > 7 * 24 * 3_600_000) return new Date(iso).toLocaleDateString();
  return `${durationText(ms)} ago`;
}
