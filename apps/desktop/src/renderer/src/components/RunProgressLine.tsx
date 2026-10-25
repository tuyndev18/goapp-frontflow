import type { RunSummary } from "../../../shared/ipc.js";
import { LANE_STATE_TEXT, type RunProgress } from "../lib/runProgress.js";

/** One bar per stage (① Figma UI → ④ prove it works), filled by its finished steps. */
export function RunLanes({ progress }: { progress: RunProgress }) {
  return (
    <ul className="ff-lanes" aria-label="Stages">
      {progress.lanes.map((l) => {
        const s = LANE_STATE_TEXT[l.state];
        const text = `${l.title}: ${s.label}, ${l.done}/${l.total} steps`;
        return (
          <li key={l.id} className={`ff-lane-cell ff-lane-${l.state}`} title={text} aria-label={text}>
            <span className="ff-lane-fill" style={{ width: `${l.total ? (l.done / l.total) * 100 : 0}%` }} />
          </li>
        );
      })}
    </ul>
  );
}

/** What the run is doing in one line: what waits for the user first, then failures, then the step at work. */
export function RunNowLine({ status, progress }: { status: RunSummary["status"]; progress: RunProgress }) {
  const labels = (steps: { label: string }[]) => steps.map((s) => s.label).join(", ");
  const line = progress.waiting.length
    ? { tone: "warning", icon: "⏸", text: `Needs you: ${labels(progress.waiting)}` }
    : progress.failed.length
      ? { tone: "danger", icon: "✕", text: `Stopped at ${labels(progress.failed)}` }
      : progress.running.length
        ? { tone: "info", icon: "◐", text: `Now: ${labels(progress.running)}` }
        : status === "paused"
          ? { tone: "muted", icon: "⏸", text: "Paused" }
          : progress.total && progress.done === progress.total
            ? { tone: "success", icon: "✓", text: "All steps done" }
            : status === "queued"
              ? { tone: "muted", icon: "○", text: "Queued" }
              : { tone: "muted", icon: "○", text: `${progress.done} of ${progress.total} steps done` };
  return (
    <span className={`ff-now-line ff-now-${line.tone} ff-ellipsis`} title={line.text}>
      <span aria-hidden="true">{line.icon}</span> {line.text}
    </span>
  );
}
