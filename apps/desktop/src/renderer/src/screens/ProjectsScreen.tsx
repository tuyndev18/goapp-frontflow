import { useEffect, useState } from "react";
import { StatusBadge, visualStateForRun } from "@frontflow/ui-components";
import type { WorkflowRunStatus } from "@frontflow/domain";
import type { ProjectSummary } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { DeleteProjectDialog } from "../components/DeleteProjectDialog.js";

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

  return (
    <div className="ff-screen">
      <header className="ff-screen-header">
        <div>
          <span className="ff-eyebrow">Workspace</span>
          <h1>Projects</h1>
          <p className="ff-muted">Local frontend projects FrontFlow can work on.</p>
        </div>
        <button type="button" className="ff-btn ff-btn-primary" disabled={busy} onClick={() => void openProject()}>
          {busy ? "Analyzing…" : "+ Open project folder"}
        </button>
      </header>
      {projects.length === 0 ? (
        <div className="ff-empty">
          <div className="ff-empty-icon" aria-hidden="true">
            📁
          </div>
          <p>No projects yet. Open a local frontend project to detect its stack, commands and conventions.</p>
        </div>
      ) : (
        <div className="ff-cards">
          {projects.map((p) => (
            <article key={p.id} className="ff-project-card">
              <button type="button" className="ff-project-open" onClick={() => navigate({ name: "project", projectId: p.id })} aria-label={p.name}>
                <h2>{p.name}</h2>
                <div className="ff-muted ff-mono ff-small ff-ellipsis">{p.rootPath}</div>
                <div className="ff-chips">
                  {[p.framework, p.packageManager].filter(Boolean).map((c) => (
                    <span key={c} className="ff-tag">
                      {c}
                    </span>
                  ))}
                  <span className={`ff-tag ${p.health === "ok" ? "ff-tag-ok" : "ff-tag-warn"}`}>{p.health === "ok" ? "✓ profile ok" : p.health === "warning" ? "⚠ check profile" : "? not analyzed"}</span>
                </div>
              </button>
              <footer className="ff-project-footer">
                {p.lastRun ? (
                  <button type="button" className="ff-link ff-row" onClick={() => navigate({ name: "run", projectId: p.id, runId: p.lastRun!.id })}>
                    <StatusBadge spec={visualStateForRun(p.lastRun.status as WorkflowRunStatus)} compact /> {p.lastRun.title}
                  </button>
                ) : (
                  <span className="ff-muted ff-small">No runs yet</span>
                )}
                <button type="button" className="ff-icon-btn" aria-label={`Remove ${p.name}`} title="Remove project" onClick={() => setToDelete(p)}>
                  🗑
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}
      <DeleteProjectDialog project={toDelete} onClose={() => setToDelete(undefined)} onDeleted={() => void refresh()} />
    </div>
  );
}
