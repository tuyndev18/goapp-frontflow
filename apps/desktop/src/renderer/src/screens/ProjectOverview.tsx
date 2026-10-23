import { useCallback, useEffect, useState } from "react";
import type { Project, ProjectProfile, WorkflowRunStatus } from "@frontflow/domain";
import { StatusBadge, visualStateForRun } from "@frontflow/ui-components";
import type { CliStatus, GitStatusDto, RunSummary } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { Loading } from "../components/Loading.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { DeleteProjectDialog } from "../components/DeleteProjectDialog.js";

const PROFILE_FIELDS = ["framework", "language", "packageManager", "uiLibrary", "apiClient", "stateManagement"] as const;

export function ProjectOverview({ projectId }: { projectId: string }) {
  const navigate = useApp((s) => s.navigate);
  const notify = useApp((s) => s.notify);
  const [data, setData] = useState<{ project: Project; profile?: ProjectProfile; warnings: string[] }>();
  const [git, setGit] = useState<GitStatusDto>();
  const [clis, setClis] = useState<CliStatus[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [removeProject, setRemoveProject] = useState(false);
  const [runToDelete, setRunToDelete] = useState<RunSummary>();
  const [deleting, setDeleting] = useState(false);

  async function deleteRun() {
    if (!runToDelete) return;
    setDeleting(true);
    try {
      await api.invoke("runs:delete", { runId: runToDelete.id });
      setRuns((list) => list.filter((r) => r.id !== runToDelete.id));
      notify("info", `Deleted run ${runToDelete.title}`);
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setDeleting(false);
      setRunToDelete(undefined);
    }
  }

  const load = useCallback(async () => {
    try {
      const [d, g, c, r] = await Promise.all([
        api.invoke("projects:get", { projectId }),
        api.invoke("projects:gitStatus", { projectId }),
        api.invoke("clis:detect"),
        api.invoke("runs:list", { projectId }),
      ]);
      setData(d);
      setGit(g);
      setClis(c);
      setRuns(r);
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }, [projectId, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reanalyze() {
    try {
      setData(await api.invoke("projects:analyze", { projectId }));
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }

  async function saveOverrides() {
    const overrides: Record<string, string | Record<string, string>> = {};
    const commands: Record<string, string> = {};
    for (const [key, value] of Object.entries(editing)) {
      if (key.startsWith("commands.")) commands[key.slice("commands.".length)] = value;
      else overrides[key] = value;
    }
    if (Object.keys(commands).length) overrides.commands = commands;
    try {
      setData(await api.invoke("projects:overrideProfile", { projectId, overrides }));
      setEditing({});
      notify("info", "Profile overrides saved");
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }

  if (!data) return <Loading label="Loading project" screen />;
  const { project, profile, warnings } = data;

  return (
    <div className="ff-screen">
      <header className="ff-screen-header">
        <div>
          <button type="button" className="ff-back" onClick={() => navigate({ name: "projects" })}>
            ← Projects
          </button>
          <h1>{project.name}</h1>
          <div className="ff-muted ff-mono ff-small">{project.rootPath}</div>
          <div className="ff-chips">
            {[profile?.framework, profile?.language, profile?.packageManager, profile?.uiLibrary].filter(Boolean).map((c) => (
              <span key={c} className="ff-tag">
                {c}
              </span>
            ))}
            {git?.isRepo ? <span className="ff-tag">⎇ {git.branch ?? "detached"}</span> : null}
          </div>
        </div>
        <div className="ff-actions">
          <button type="button" className="ff-btn" onClick={() => void reanalyze()}>
            Re-analyze
          </button>
          <button type="button" className="ff-btn ff-btn-danger" onClick={() => setRemoveProject(true)}>
            🗑 Remove project
          </button>
          <button type="button" className="ff-btn ff-btn-primary" onClick={() => navigate({ name: "new-run", projectId })}>
            + New feature
          </button>
        </div>
      </header>

      {warnings.length ? (
        <ul className="ff-warnings" aria-label="Analyzer warnings">
          {warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      ) : null}

      <DeleteProjectDialog project={removeProject ? project : undefined} onClose={() => setRemoveProject(false)} onDeleted={() => navigate({ name: "projects" })} />
      <ConfirmDialog
        open={!!runToDelete}
        title={`Delete run "${runToDelete?.title ?? ""}"?`}
        confirmLabel="Delete run"
        danger
        busy={deleting}
        onCancel={() => setRunToDelete(undefined)}
        onConfirm={() => void deleteRun()}
      >
        <p>Removes the run's history, logs, evidence and its hidden git snapshots. Your project files are not touched.</p>
      </ConfirmDialog>
      <section className="ff-card">
        <div className="ff-card-head">
          <h2>Feature runs</h2>
          {runs.length ? <span className="ff-muted ff-small">{runs.length} total</span> : null}
        </div>
        {runs.length === 0 ? (
          <div className="ff-empty ff-empty-inline">
            <p>No runs yet.</p>
            <button type="button" className="ff-btn ff-btn-primary" onClick={() => navigate({ name: "new-run", projectId })}>
              Start the first feature
            </button>
          </div>
        ) : (
          <ul className="ff-run-list">
            {runs.map((r) => (
              <li key={r.id} className="ff-run-row">
                <button type="button" className="ff-run-open" onClick={() => navigate({ name: "run", projectId, runId: r.id })}>
                  <StatusBadge spec={visualStateForRun(r.status as WorkflowRunStatus)} compact />
                  <span className="ff-run-name ff-ellipsis">{r.title}</span>
                  <span className="ff-muted ff-small">{new Date(r.createdAt).toLocaleString()}</span>
                </button>
                <button type="button" className="ff-icon-btn" title="Delete run" aria-label={`Delete run ${r.title}`} onClick={() => setRunToDelete(r)}>
                  🗑
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="ff-grid-2">
        <section className="ff-card">
          <h2>Project profile</h2>
          <p className="ff-muted ff-small">Detected stack and commands. Edit a value to override it.</p>
          {profile ? (
            <table className="ff-table ff-table-compact ff-profile-table">
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Value</th>
                  <th scope="col">Confidence / evidence</th>
                </tr>
              </thead>
              <tbody>
                {PROFILE_FIELDS.map((field) => (
                  <ProfileRow key={field} field={field} value={profile[field]} profile={profile} editing={editing} setEditing={setEditing} />
                ))}
                {Object.entries(profile.commands).map(([name, cmd]) => (
                  <ProfileRow
                    key={`commands.${name}`}
                    field={`commands.${name}`}
                    value={cmd}
                    profile={profile}
                    editing={editing}
                    setEditing={setEditing}
                  />
                ))}
              </tbody>
            </table>
          ) : (
            <p>No profile yet.</p>
          )}
          {Object.keys(editing).length ? (
            <button type="button" className="ff-btn ff-btn-primary" onClick={() => void saveOverrides()}>
              Save overrides
            </button>
          ) : null}
          {profile?.conventionDocs.length ? (
            <p className="ff-muted">Convention docs: {profile.conventionDocs.join(", ")}</p>
          ) : null}
        </section>

        <div className="ff-stack">
          <section className="ff-card">
            <h2>Git</h2>
            {git?.isRepo ? (
              <dl className="ff-dl">
                <dt>Branch</dt>
                <dd>{git.branch ?? "detached"}</dd>
                <dt>HEAD</dt>
                <dd className="ff-mono">{git.baseSha?.slice(0, 12)}</dd>
                <dt>Working tree</dt>
                <dd>{git.clean ? "✓ Clean" : `⚠ ${(git.dirtyFiles?.length ?? 0) + (git.untrackedFiles?.length ?? 0)} changed files — the AI agents work in this folder, so commit or stash first to review their changes on their own`}</dd>
              </dl>
            ) : (
              <p>⚠ Not a Git repository. Code-changing nodes require Git for checkpoints and rollback.</p>
            )}
            {git?.warnings.map((w) => (
              <p key={w} className="ff-muted">
                ⚠ {w}
              </p>
            ))}
          </section>

          <section className="ff-card">
            <h2>AI CLI integrations</h2>
            <ul className="ff-list">
              {clis.map((c) => (
                <li key={c.adapterId}>
                  {c.installed ? "✓" : "✕"} <strong>{c.label}</strong> {c.version ? <span className="ff-muted">{c.version}</span> : null}
                  {!c.installed && c.error ? <div className="ff-muted">{c.error}</div> : null}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function ProfileRow({
  field,
  value,
  profile,
  editing,
  setEditing,
}: {
  field: string;
  value: string | undefined;
  profile: ProjectProfile;
  editing: Record<string, string>;
  setEditing(next: Record<string, string>): void;
}) {
  const detection = profile.detection[field];
  const current = editing[field] ?? value ?? "";
  return (
    <tr>
      <th scope="row">{field}</th>
      <td>
        <input
          className="ff-input"
          aria-label={`Override ${field}`}
          value={current}
          onChange={(e) => setEditing({ ...editing, [field]: e.target.value })}
        />
      </td>
      <td className="ff-muted">
        {detection ? (
          <>
            {detection.overridden ? "user override" : `${Math.round(detection.confidence * 100)}%`}
            {detection.evidence.length ? <div className="ff-small">{detection.evidence.slice(0, 2).join("; ")}</div> : null}
          </>
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}
