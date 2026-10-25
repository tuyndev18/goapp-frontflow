import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import type { NodeRun } from "@frontflow/domain";
import { StatusBadge, visualStateForNode, visualStateForRun } from "@frontflow/ui-components";
import type { EventDto, GraphNodeDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { Loading } from "../components/Loading.js";
import { ActivityFeed } from "../components/ActivityFeed.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { TmuxView } from "../components/TmuxView.js";
import { buildActivity, formatDuration, lastActivityByNode } from "../lib/activity.js";
import { buildTranscript } from "../lib/transcript.js";
import { laneFor, lanesOf } from "../lib/groups.js";
import { StepDetail } from "./StepDetail.js";
import { GraphView } from "./GraphView.js";

const EMPTY: EventDto[] = [];
const TERMINAL = new Set(["completed", "completed_with_assumptions", "failed", "cancelled", "timed_out", "blocked"]);
const PANEL_KEY = "ff-run-panel";
const PANEL_MIN = 380;
const CANVAS_MIN = 320;

export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/**
 * A run on one screen without scrolling the page: the workflow canvas on the left and, beside it,
 * the panel with the run's live activity or the selected step. Clicking a step on the canvas opens
 * it in the panel; the split can be dragged and the canvas hidden.
 */
export function RunScreen({ projectId, runId, initialNodeId }: { projectId: string; runId: string; initialNodeId?: string }) {
  const state = useApp((s) => s.runStates[runId]);
  const events = useApp((s) => s.runEvents[runId] ?? EMPTY);
  const loadRun = useApp((s) => s.loadRun);
  const navigate = useApp((s) => s.navigate);
  const notify = useApp((s) => s.notify);
  const project = useApp((s) => s.projects.find((p) => p.id === projectId));
  const [selected, setSelected] = useState<string | undefined>(initialNodeId);
  const [view, setView] = useState<"activity" | "terminals">("activity");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [layout, setLayout] = useState(readLayout);
  const split = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadRun(runId);
  }, [runId, loadRun]);

  const latest = useMemo(() => latestNodeRuns(state?.nodeRuns ?? []), [state?.nodeRuns]);
  const lines = useMemo(() => buildActivity(events, state?.nodeRuns ?? []), [events, state?.nodeRuns]);
  const transcript = useMemo(() => buildTranscript(events, state?.nodeRuns ?? []), [events, state?.nodeRuns]);
  const lastByNode = useMemo(() => lastActivityByNode(lines), [lines]);
  const labels = useMemo(() => new Map((state?.graph.nodes ?? []).map((n) => [n.id, n.label])), [state?.graph.nodes]);
  const lanes = useMemo(() => lanesOf(state?.graph.lanes, state?.graph.nodes ?? []), [state?.graph.lanes, state?.graph.nodes]);
  const active = !!state && !TERMINAL.has(state.run.status);
  const now = useNow(active);

  function saveLayout(next: typeof layout) {
    setLayout(next);
    try {
      localStorage.setItem(PANEL_KEY, JSON.stringify(next));
    } catch {
      // Not remembered; the layout still applies for this session.
    }
  }

  /** The panel's width from the pointer's x, keeping both sides usable. */
  function widthAt(clientX: number): number {
    const rect = split.current?.getBoundingClientRect();
    if (!rect) return layout.width;
    return Math.round(Math.min(Math.max(rect.right - clientX, PANEL_MIN), rect.width - CANVAS_MIN));
  }

  function startResize(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: globalThis.PointerEvent) => setLayout((l) => ({ ...l, width: widthAt(ev.clientX) }));
    const up = (ev: globalThis.PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      saveLayout({ ...layout, width: widthAt(ev.clientX) });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }

  function resizeByKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 80 : 24;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const rect = split.current?.getBoundingClientRect();
      const max = rect ? rect.width - CANVAS_MIN : layout.width;
      saveLayout({ ...layout, width: Math.min(Math.max(layout.width + (e.key === "ArrowLeft" ? step : -step), PANEL_MIN), max) });
    }
  }

  if (!state) return <Loading label="Loading run" screen />;
  const nodes = state.graph.nodes;
  const done = nodes.filter((n) => ["passed", "skipped"].includes(latest.get(n.id)?.status ?? "")).length;
  const started = state.run.startedAt ?? state.run.createdAt;
  const elapsed = (state.run.finishedAt ? Date.parse(state.run.finishedAt) : now) - Date.parse(started);
  const runningSteps = nodes.filter((n) => ["running", "retrying"].includes(latest.get(n.id)?.status ?? ""));
  const needsInput = nodes.filter((n) => latest.get(n.id)?.status === "waiting_for_input");
  const failedSteps = nodes.filter((n) => ["failed", "blocked"].includes(latest.get(n.id)?.status ?? ""));
  const selectedNode = nodes.find((n) => n.id === selected);
  // What the canvas keeps in view: the open step, else where the run needs attention or is working.
  const focus = selected ?? needsInput[0]?.id ?? failedSteps[0]?.id ?? runningSteps[0]?.id;

  async function control(action: "runs:pause" | "runs:resume" | "runs:cancel") {
    try {
      await api.invoke(action, { runId });
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }

  async function deleteRun() {
    setBusy(true);
    try {
      await api.invoke("runs:delete", { runId });
      notify("info", "Run deleted");
      navigate({ name: "project", projectId });
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div className="ff-run">
      <header className="ff-run-header">
        <div className="ff-run-title">
          <button type="button" className="ff-back" onClick={() => navigate({ name: "project", projectId })}>
            ← {project?.name ?? "Project"}
          </button>
          <h1>{state.run.title ?? state.run.workflowId}</h1>
          <div className="ff-run-meta">
            <StatusBadge spec={visualStateForRun(state.run.status)} />
            {state.run.workflowName ? <span className="ff-meta-item">⛓ {state.run.workflowName}</span> : null}
            <span className="ff-meta-item">
              <strong>{done}</strong>/{nodes.length} steps done
            </span>
            <span className="ff-meta-item">⏱ {formatDuration(Math.max(0, elapsed))}</span>
            {runningSteps.length ? <span className="ff-meta-item ff-now">● Now: {runningSteps.map((n) => n.label).join(", ")}</span> : null}
            {needsInput.length ? (
              <span className="ff-meta-item ff-run-waiting" role="alert">
                ⏸ Waiting for you:{" "}
                {needsInput.map((n) => (
                  <button key={n.id} type="button" className="ff-link" onClick={() => setSelected(n.id)}>
                    {n.label}
                  </button>
                ))}
              </span>
            ) : null}
          </div>
        </div>
        <div className="ff-actions">
          <button type="button" className="ff-btn" onClick={() => navigate({ name: "matrix", projectId, runId })}>
            Reports
          </button>
          {state.run.status === "paused" ? (
            <button type="button" className="ff-btn ff-btn-primary" onClick={() => void control("runs:resume")}>
              ▶ Resume
            </button>
          ) : (
            <button type="button" className="ff-btn" disabled={!active} onClick={() => void control("runs:pause")}>
              ⏸ Pause
            </button>
          )}
          <button type="button" className="ff-btn" disabled={!active} onClick={() => void control("runs:cancel")}>
            ⊘ Cancel
          </button>
          <button type="button" className="ff-btn ff-btn-danger" onClick={() => setConfirmDelete(true)} aria-label="Delete run">
            🗑 Delete
          </button>
        </div>
      </header>
      <ProgressBar nodes={nodes} latest={latest} />

      <div ref={split} className={`ff-run-split${layout.canvas ? "" : " ff-run-split-panel"}`} style={{ "--panel-w": `${layout.width}px` } as CSSProperties}>
        {layout.canvas ? (
          <>
            <GraphView runId={runId} graph={state.graph} latest={latest} lastByNode={lastByNode} selected={selected} focus={focus} now={now} onSelect={setSelected} />
            <div
              className="ff-splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the panel (arrow keys)"
              aria-valuenow={layout.width}
              tabIndex={0}
              onPointerDown={startResize}
              onKeyDown={resizeByKey}
              onDoubleClick={() => saveLayout({ ...layout, width: DEFAULT_LAYOUT.width })}
            />
          </>
        ) : null}
        <main className="ff-run-main">
          <div className="ff-panel-bar">
            <button type="button" className={`ff-btn ff-btn-small${selectedNode ? "" : " ff-btn-active"}`} aria-pressed={!selectedNode} onClick={() => setSelected(undefined)}>
              All activity
            </button>
            <select className="ff-input ff-panel-step" value={selected ?? ""} aria-label="Open a step" onChange={(e) => setSelected(e.target.value || undefined)}>
              <option value="">Open a step…</option>
              {lanes.map((lane) => {
                const members = nodes.filter((n) => laneFor(lanes, n)?.id === lane.id);
                return members.length ? (
                  <optgroup key={lane.id} label={lane.title}>
                    {members.map((n) => (
                      <option key={n.id} value={n.id}>
                        {visualStateForNode(latest.get(n.id)?.status).icon} {n.label} — {visualStateForNode(latest.get(n.id)?.status).label}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
            <span className="ff-grow" />
            <button
              type="button"
              className="ff-btn ff-btn-small"
              aria-pressed={!layout.canvas}
              title={layout.canvas ? "Give the panel the whole width" : "Show the workflow canvas again"}
              onClick={() => saveLayout({ ...layout, canvas: !layout.canvas })}
            >
              {layout.canvas ? "⤢ Hide canvas" : "⤡ Show canvas"}
            </button>
          </div>
          {selectedNode ? (
            <StepDetail
              projectId={projectId}
              runId={runId}
              node={selectedNode}
              lane={laneFor(lanes, selectedNode)}
              nodeRun={latest.get(selectedNode.id)}
              items={transcript.filter((t) => t.nodeId === selectedNode.id)}
              projectRoot={project?.rootPath}
              now={now}
            />
          ) : (
            <>
              <div className="ff-tabs ff-tabs-flush" role="tablist">
                <button type="button" role="tab" aria-selected={view === "activity"} className={`ff-tab${view === "activity" ? " ff-tab-active" : ""}`} onClick={() => setView("activity")}>
                  Live activity
                </button>
                <button type="button" role="tab" aria-selected={view === "terminals"} className={`ff-tab${view === "terminals" ? " ff-tab-active" : ""}`} onClick={() => setView("terminals")}>
                  AI terminals
                </button>
              </div>
              {view === "activity" ? (
                <ActivityFeed
                  items={transcript}
                  stepLabels={labels}
                  stepRuns={latest}
                  showStep
                  {...(project?.rootPath ? { projectRoot: project.rootPath } : {})}
                  onSelectStep={setSelected}
                  emptyText="Waiting for the first step to start…"
                />
              ) : (
                <TmuxView title={state.run.title ?? state.run.workflowId} nodes={nodes} latest={latest} lines={lines} events={events} now={now} onSelect={setSelected} />
              )}
            </>
          )}
        </main>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this run?"
        confirmLabel="Delete run"
        danger
        busy={busy}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void deleteRun()}
      >
        <p>This removes the run's history, logs, evidence and its hidden git snapshots. Your project files and branches are not touched.</p>
        <p>Your project files and other branches are not touched.{active ? " The run is still active and will be cancelled first." : ""}</p>
      </ConfirmDialog>
    </div>
  );
}

const DEFAULT_LAYOUT = { width: 520, canvas: true };

/** The split is a per-viewer convenience: remembered in this browser only, defaults otherwise. */
function readLayout(): typeof DEFAULT_LAYOUT {
  try {
    const raw = JSON.parse(localStorage.getItem(PANEL_KEY) ?? "null") as Partial<typeof DEFAULT_LAYOUT> | null;
    return {
      width: typeof raw?.width === "number" && raw.width >= PANEL_MIN ? raw.width : DEFAULT_LAYOUT.width,
      canvas: typeof raw?.canvas === "boolean" ? raw.canvas : DEFAULT_LAYOUT.canvas,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

const PROGRESS_LEGEND = [
  { tone: "success", label: "passed" },
  { tone: "info", label: "running" },
  { tone: "warning", label: "needs attention" },
  { tone: "danger", label: "failed" },
] as const;

function ProgressBar({ nodes, latest }: { nodes: GraphNodeDto[]; latest: Map<string, NodeRun> }) {
  const tones = nodes.map((n) => visualStateForNode(latest.get(n.id)?.status).tone);
  const done = nodes.filter((n) => ["passed", "skipped"].includes(latest.get(n.id)?.status ?? "")).length;
  return (
    <div className="ff-progress">
      <div className="ff-progress-track" aria-hidden="true">
        {nodes.map((n, i) => (
          <span key={n.id} className={`ff-progress-seg ff-progress-${tones[i]}`} title={n.label} />
        ))}
      </div>
      <div className="ff-progress-legend">
        <span className="ff-legend-total">
          <strong>{nodes.length ? Math.round((done / nodes.length) * 100) : 0}%</strong> complete
        </span>
        {PROGRESS_LEGEND.map(({ tone, label }) => {
          const count = tones.filter((t) => t === tone).length;
          return count ? (
            <span key={tone} className={`ff-legend-item ff-legend-${tone}`}>
              {count} {label}
            </span>
          ) : null;
        })}
      </div>
    </div>
  );
}

export function latestNodeRuns(nodeRuns: NodeRun[]): Map<string, NodeRun> {
  const map = new Map<string, NodeRun>();
  for (const nr of nodeRuns) {
    const prev = map.get(nr.nodeId);
    if (!prev || nr.attempt >= prev.attempt) map.set(nr.nodeId, nr);
  }
  return map;
}
