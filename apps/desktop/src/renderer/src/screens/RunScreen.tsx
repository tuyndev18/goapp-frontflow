import { useEffect, useMemo, useState } from "react";
import type { NodeRun } from "@frontflow/domain";
import { StatusBadge, visualStateForNode, visualStateForRun } from "@frontflow/ui-components";
import type { EventDto, GraphNodeDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { Loading } from "../components/Loading.js";
import { ActivityFeed } from "../components/ActivityFeed.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { TmuxView } from "../components/TmuxView.js";
import { buildActivity, formatDuration, lastActivityByNode, stepDuration, type ActivityLine } from "../lib/activity.js";
import { GROUPS, groupOf } from "../lib/groups.js";
import { StepDetail } from "./StepDetail.js";
import { GraphView } from "./GraphView.js";

const EMPTY: EventDto[] = [];
const TERMINAL = new Set(["completed", "completed_with_assumptions", "failed", "cancelled", "timed_out", "blocked"]);

export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function RunScreen({ projectId, runId, initialNodeId }: { projectId: string; runId: string; initialNodeId?: string }) {
  const state = useApp((s) => s.runStates[runId]);
  const events = useApp((s) => s.runEvents[runId] ?? EMPTY);
  const loadRun = useApp((s) => s.loadRun);
  const navigate = useApp((s) => s.navigate);
  const notify = useApp((s) => s.notify);
  const projectName = useApp((s) => s.projects.find((p) => p.id === projectId)?.name);
  const [selected, setSelected] = useState<string | undefined>(initialNodeId);
  const [view, setView] = useState<"activity" | "terminals">("activity");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadRun(runId);
  }, [runId, loadRun]);

  const latest = useMemo(() => latestNodeRuns(state?.nodeRuns ?? []), [state?.nodeRuns]);
  const lines = useMemo(() => buildActivity(events, state?.nodeRuns ?? []), [events, state?.nodeRuns]);
  const lastByNode = useMemo(() => lastActivityByNode(lines), [lines]);
  const labels = useMemo(() => new Map((state?.graph.nodes ?? []).map((n) => [n.id, n.label])), [state?.graph.nodes]);
  const active = !!state && !TERMINAL.has(state.run.status);
  const now = useNow(active);

  if (!state) return <Loading label="Loading run" screen />;
  const nodes = state.graph.nodes;
  const done = nodes.filter((n) => ["passed", "skipped"].includes(latest.get(n.id)?.status ?? "")).length;
  const started = state.run.startedAt ?? state.run.createdAt;
  const elapsed = (state.run.finishedAt ? Date.parse(state.run.finishedAt) : now) - Date.parse(started);
  const runningSteps = nodes.filter((n) => ["running", "retrying"].includes(latest.get(n.id)?.status ?? ""));
  const needsInput = nodes.filter((n) => latest.get(n.id)?.status === "waiting_for_input");
  const selectedNode = nodes.find((n) => n.id === selected);

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
            ← {projectName ?? "Project"}
          </button>
          <h1>{state.run.title ?? state.run.workflowId}</h1>
          <div className="ff-run-meta">
            <StatusBadge spec={visualStateForRun(state.run.status)} />
            <span className="ff-meta-item">
              <strong>{done}</strong>/{nodes.length} steps done
            </span>
            <span className="ff-meta-item">⏱ {formatDuration(Math.max(0, elapsed))}</span>
            {runningSteps.length ? <span className="ff-meta-item ff-now">● Now: {runningSteps.map((n) => n.label).join(", ")}</span> : null}
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

      {needsInput.length && !selectedNode ? (
        <div className="ff-callout ff-callout-warning" role="alert">
          <strong>⏸ Waiting for you:</strong>{" "}
          {needsInput.map((n) => (
            <button key={n.id} type="button" className="ff-link" onClick={() => setSelected(n.id)}>
              {n.label}
            </button>
          ))}
        </div>
      ) : null}

      <GraphView runId={runId} graph={state.graph} latest={latest} lastByNode={lastByNode} selected={selected} now={now} onSelect={setSelected} />

      <div className="ff-run-body">
        <StepList nodes={nodes} latest={latest} lastByNode={lastByNode} selected={selected} now={now} onSelect={setSelected} />
        <main className="ff-run-main">
          {selectedNode ? (
            <StepDetail
              projectId={projectId}
              runId={runId}
              node={selectedNode}
              nodeRun={latest.get(selectedNode.id)}
              lines={lines.filter((l) => l.nodeId === selectedNode.id)}
              now={now}
              onBack={() => setSelected(undefined)}
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
                <ActivityFeed lines={lines} stepLabels={labels} showStep emptyText="Waiting for the first step to start…" />
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

function StepList({
  nodes,
  latest,
  lastByNode,
  selected,
  now,
  onSelect,
}: {
  nodes: GraphNodeDto[];
  latest: Map<string, NodeRun>;
  lastByNode: Map<string, ActivityLine>;
  selected?: string;
  now: number;
  onSelect(id: string | undefined): void;
}) {
  return (
    <nav className="ff-steps" aria-label="Workflow steps">
      <button type="button" className={`ff-step-all${selected ? "" : " ff-step-selected"}`} onClick={() => onSelect(undefined)}>
        All activity
      </button>
      {GROUPS.map((group) => {
        const members = nodes.filter((n) => groupOf(n) === group.id);
        if (!members.length) return null;
        const groupDone = members.filter((n) => ["passed", "skipped"].includes(latest.get(n.id)?.status ?? "")).length;
        return (
          <section key={group.id} className="ff-step-group">
            <h3>
              <span className="ff-lane-dot" style={{ background: group.color }} /> <span className="ff-grow">{group.label}</span>
              <span className="ff-step-group-count">
                {groupDone}/{members.length}
              </span>
            </h3>
            <ol>
              {members.map((n) => {
                const nr = latest.get(n.id);
                const spec = visualStateForNode(nr?.status);
                const last = lastByNode.get(n.id);
                const duration = stepDuration(nr, now);
                const note =
                  nr?.status === "waiting_for_input" || nr?.status === "blocked"
                    ? nr.blockerSummary
                    : nr?.status === "failed"
                      ? `${nr.error?.code}: ${nr.error?.message}`
                      : nr?.status === "waiting_for_dependency"
                        ? `Waiting for ${nr.waitingOn?.map((w) => nodes.find((x) => x.id === w)?.label ?? w).join(", ")}`
                        : ["running", "retrying"].includes(nr?.status ?? "")
                          ? last?.text
                          : undefined;
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      className={`ff-step ff-step-${spec.tone}${selected === n.id ? " ff-step-selected" : ""}`}
                      onClick={() => onSelect(n.id)}
                      aria-current={selected === n.id ? "true" : undefined}
                    >
                      <span className={`ff-step-icon${spec.animated ? " ff-spin" : ""}`} aria-label={spec.label}>
                        {spec.icon}
                      </span>
                      <span className="ff-step-main">
                        <span className="ff-step-label">
                          {n.label}
                          {n.ai ? <span className="ff-tag ff-tag-ai" title="Runs an AI CLI agent">AI</span> : null}
                          {nr?.assumed ? <span className="ff-tag ff-tag-assumed">assumed</span> : null}
                          {nr && nr.attempt > 1 ? <span className="ff-tag">try {nr.attempt}</span> : null}
                        </span>
                        {note ? <span className="ff-step-note">{note}</span> : null}
                      </span>
                      {duration !== undefined ? <span className="ff-step-time">{formatDuration(duration)}</span> : nr?.status === "waiting_for_input" ? <span className="ff-step-time ff-step-you">your turn</span> : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </nav>
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
