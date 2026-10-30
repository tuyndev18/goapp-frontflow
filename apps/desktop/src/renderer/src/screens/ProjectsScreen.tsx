import { useEffect, useState } from "react";
import { StatusBadge, visualStateForRun } from "@frontflow/ui-components";
import type { ProjectSummary, RunSummary } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { DeleteProjectDialog } from "../components/DeleteProjectDialog.js";
import { RunLanes, RunNowLine } from "../components/RunProgressLine.js";
import { NavIcon } from "../components/NavIcon.js";
import { StepIcon } from "../components/StepIcon.js";
import { runProgress, timeAgo } from "../lib/runProgress.js";

export function ProjectsScreen() {
  const projects = useApp((s) => s.projects);
  const refresh = useApp((s) => s.refreshProjects);
  const navigate = useApp((s) => s.navigate);
  const notify = useApp((s) => s.notify);
  const [busy, setBusy] = useState(false);
  const [toDelete, setToDelete] = useState<ProjectSummary>();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function openProject() {
    setBusy(true);
    try {
      const project = await api.invoke("projects:open");
      if (project) {
        await refresh();
        navigate({ name: "project", projectId: project.id });
      }
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const now = Date.now();
  const sorted = [...projects].sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  const activeRuns = projects.reduce((n, p) => n + p.activeRuns, 0);
  const waiting = projects.flatMap((p) => p.needsYou.map((r) => ({ project: p, ...r })));

  return (
    <div className="ff-screen">
      <header className="ff-screen-header">
        <div>
          <span className="ff-eyebrow">Workspace</span>
          <h1>Projects</h1>
          <p>
            {projects.length
              ? `${projects.length} ${projects.length === 1 ? "project" : "projects"} · ${activeRuns ? `${activeRuns} ${activeRuns === 1 ? "run" : "runs"} in progress` : "no runs in progress"}`
              : "Local frontend projects FrontFlow can work on."}
          </p>
        </div>
        <button type="button" className="ff-btn ff-btn-primary" disabled={busy} onClick={() => void openProject()}>
          {busy ? "Analyzing…" : "+ Open project folder"}
        </button>
      </header>

      {waiting.length ? (
        <section className="ff-attention" aria-label="Waiting for you">
          <h2>
            <span aria-hidden="true">⏸</span> Waiting for you <span className="ff-count">{waiting.length}</span>
          </h2>
          <ul>
            {waiting.map((w) => (
              <li key={w.runId}>
                <span className="ff-attention-where ff-ellipsis">
                  <span className="ff-muted">{w.project.name} ›</span> {w.title}
                </span>
                <span className="ff-attention-steps">
                  {w.steps.map((s) => (
                    <button key={s.id} type="button" className="ff-btn ff-btn-small" onClick={() => navigate({ name: "run", projectId: w.project.id, runId: w.runId, nodeId: s.id })}>
                      {s.label} →
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {projects.length === 0 ? (
        <div className="ff-empty">
          <div className="ff-empty-icon" aria-hidden="true">
            <StepIcon name="folder" size={32} />
          </div>
          <p>No projects yet. Open a local frontend project to detect its stack, commands and conventions.</p>
        </div>
      ) : (
        <ul className="ff-project-list" aria-label="Projects">
          <li className="ff-project-list-head" aria-hidden="true">
            <span>Project</span>
            <span>Latest feature run</span>
            <span>Activity</span>
          </li>
          {sorted.map((p) => (
            <li key={p.id} className="ff-project-row">
              <button type="button" className="ff-project-main" onClick={() => navigate({ name: "project", projectId: p.id })} aria-label={p.name}>
                <span className="ff-project-avatar" style={{ background: `var(--viz-${avatarSlot(p.name)})` }} aria-hidden="true">
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="ff-project-who">
                  <strong className="ff-ellipsis">{p.name}</strong>
                  <span className="ff-muted ff-mono ff-ellipsis" title={p.rootPath}>
                    {p.rootPath}
                  </span>
                  <span className="ff-muted ff-small">{[p.framework, p.packageManager].filter(Boolean).join(" · ") || "Stack not detected"}</span>
                </span>
              </button>
              <div className="ff-project-run">
                {p.lastRun ? (
                  <LatestRun run={p.lastRun} onOpen={(runId) => navigate({ name: "run", projectId: p.id, runId })} />
                ) : (
                  <span className="ff-muted ff-small">No feature runs yet</span>
                )}
              </div>
              <div className="ff-project-activity">
                <span>
                  {p.activeRuns ? <strong>{p.activeRuns} active</strong> : <span className="ff-muted">No active runs</span>}
                  <span className="ff-muted"> · {p.totalRuns} total</span>
                </span>
                <span className="ff-muted ff-small" title={new Date(p.lastActivityAt).toLocaleString()}>
                  {timeAgo(p.lastActivityAt, now)}
                </span>
              </div>
              <button type="button" className="ff-icon-btn" aria-label={`Remove ${p.name}`} title="Remove project" onClick={() => setToDelete(p)}>
                <NavIcon name="trash" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <DeleteProjectDialog project={toDelete} onClose={() => setToDelete(undefined)} onDeleted={() => void refresh()} />
    </div>
  );
}

function LatestRun({ run, onOpen }: { run: RunSummary; onOpen(runId: string): void }) {
  const progress = runProgress(run.steps, run.lanes);
  return (
    <>
      <button type="button" className="ff-project-runlink" onClick={() => onOpen(run.id)}>
        <StatusBadge spec={visualStateForRun(run.status)} compact />
        <span className="ff-ellipsis">{run.title}</span>
      </button>
      <div className="ff-project-progress">
        <RunLanes progress={progress} />
        <span className="ff-muted ff-small">
          {progress.done}/{progress.total}
        </span>
      </div>
      <RunNowLine status={run.status} progress={progress} />
    </>
  );
}

/** Same project, same avatar colour: a stable pick from the 7 chart colours. */
function avatarSlot(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 7) + 1;
}
