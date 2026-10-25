import { useCallback, useEffect, useState } from "react";
import type { Project, ProjectProfile } from "@frontflow/domain";
import { StatusBadge, visualStateForRun } from "@frontflow/ui-components";
import type { CliStatus, FigmaStatusDto, GitStatusDto, RunSummary } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { Loading } from "../components/Loading.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { DeleteProjectDialog } from "../components/DeleteProjectDialog.js";
import { Menu } from "../components/Menu.js";
import { RunLanes, RunNowLine } from "../components/RunProgressLine.js";
import { runProgress, timeAgo } from "../lib/runProgress.js";

const STACK_FIELDS = [
  ["framework", "Framework"],
  ["language", "Language"],
  ["uiLibrary", "UI library"],
  ["apiClient", "API client"],
  ["stateManagement", "State management"],
  ["packageManager", "Package manager"],
] as const;

const COMMAND_LABELS: Record<string, string> = {
  install: "Install",
  dev: "Dev server",
  build: "Build",
  typecheck: "Typecheck",
  lint: "Lint",
  unitTest: "Unit tests",
  e2e: "E2E tests",
};

/** Agents check their work with these; without them every check needs an approval. */
const KEY_COMMANDS = ["build", "typecheck"];
/** Below this the analyzer was guessing: the value is flagged for the user to confirm. */
const LOW_CONFIDENCE = 0.6;
const TERMINAL = new Set(["completed", "completed_with_assumptions", "failed", "cancelled", "timed_out", "blocked"]);

interface Check {
  key: string;
  state: "ok" | "warn" | "bad";
  title: string;
  detail?: string;
}

const CHECK_ICON: Record<Check["state"], string> = { ok: "✓", warn: "⚠", bad: "✕" };

export function ProjectOverview({ projectId }: { projectId: string }) {
  const navigate = useApp((s) => s.navigate);
  const notify = useApp((s) => s.notify);
  const [data, setData] = useState<{ project: Project; profile?: ProjectProfile; warnings: string[] }>();
  const [git, setGit] = useState<GitStatusDto>();
  const [clis, setClis] = useState<CliStatus[]>([]);
  const [figma, setFigma] = useState<FigmaStatusDto>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [editing, setEditing] = useState<Record<string, string>>();
  const [analyzing, setAnalyzing] = useState(false);
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
      const [d, g, c, r, f] = await Promise.all([
        api.invoke("projects:get", { projectId }),
        api.invoke("projects:gitStatus", { projectId }),
        api.invoke("clis:detect"),
        api.invoke("runs:list", { projectId }),
        api.invoke("figma:status"),
      ]);
      setData(d);
      setGit(g);
      setClis(c);
      setRuns(r);
      setFigma(f);
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }, [projectId, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => api.on("figma:status", setFigma), []);

  async function reanalyze() {
    setAnalyzing(true);
    try {
      setData(await api.invoke("projects:analyze", { projectId }));
      setGit(await api.invoke("projects:gitStatus", { projectId }));
      notify("info", "Project re-analyzed");
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setAnalyzing(false);
    }
  }

  async function saveOverrides() {
    if (!editing) return;
    const overrides: Record<string, string | Record<string, string>> = {};
    const commands: Record<string, string> = {};
    for (const [key, value] of Object.entries(editing)) {
      if (key.startsWith("commands.")) commands[key.slice("commands.".length)] = value;
      else overrides[key] = value;
    }
    if (Object.keys(commands).length) overrides.commands = commands;
    try {
      setData(await api.invoke("projects:overrideProfile", { projectId, overrides }));
      setEditing(undefined);
      notify("info", "Profile saved");
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }

  if (!data) return <Loading label="Loading project" screen />;
  const { project, profile, warnings } = data;
  const now = Date.now();
  const active = runs.filter((r) => !TERMINAL.has(r.status));
  const finished = runs.filter((r) => TERMINAL.has(r.status));
  const waiting = active.flatMap((r) => {
    const steps = r.steps.filter((s) => s.status === "waiting_for_input");
    return steps.length ? [{ run: r, steps }] : [];
  });
  const checks = readinessChecks(git, clis, figma, profile, warnings);
  const problems = checks.filter((c) => c.state !== "ok").length;

  return (
    <div className="ff-screen">
      <header className="ff-screen-header">
        <div>
          <button type="button" className="ff-back" onClick={() => navigate({ name: "projects" })}>
            ← Projects
          </button>
          <h1>{project.name}</h1>
          <div className="ff-muted ff-mono ff-small ff-ellipsis" title={project.rootPath}>
            {project.rootPath}
          </div>
          <div className="ff-chips">
            {[profile?.framework, profile?.language, profile?.uiLibrary, profile?.packageManager].filter(Boolean).map((c) => (
              <span key={c} className="ff-tag">
                {c}
              </span>
            ))}
            {git?.isRepo ? <span className="ff-tag">⎇ {git.branch ?? "detached"}</span> : null}
          </div>
        </div>
        <div className="ff-actions">
          <Menu
            label="More actions"
            trigger="⋯"
            className="ff-btn"
            disabled={analyzing}
            items={[
              { label: analyzing ? "Analyzing…" : "Re-analyze project", hint: "Detect stack and commands again; your edits are kept", onSelect: () => void reanalyze() },
              { label: "Remove project", hint: "Only FrontFlow's data; project files stay", danger: true, onSelect: () => setRemoveProject(true) },
            ]}
          />
          <button type="button" className="ff-btn ff-btn-primary" onClick={() => navigate({ name: "new-run", projectId })}>
            + New feature
          </button>
        </div>
      </header>

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

      {waiting.length ? (
        <section className="ff-attention" aria-label="Waiting for you">
          <h2>
            <span aria-hidden="true">⏸</span> Waiting for you <span className="ff-count">{waiting.length}</span>
          </h2>
          <ul>
            {waiting.map(({ run, steps }) => (
              <li key={run.id}>
                <span className="ff-attention-where ff-ellipsis">{run.title}</span>
                <span className="ff-attention-steps">
                  {steps.map((s) => (
                    <button key={s.id} type="button" className="ff-btn ff-btn-small" onClick={() => navigate({ name: "run", projectId, runId: run.id, nodeId: s.id })}>
                      {s.label} →
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="ff-overview">
        <section className="ff-card">
          <div className="ff-card-head">
            <h2>Feature runs</h2>
            {runs.length ? (
              <span className="ff-muted ff-small">
                {active.length} in progress · {finished.length} finished
              </span>
            ) : null}
          </div>
          {runs.length === 0 ? (
            <div className="ff-empty ff-empty-inline">
              <p>No runs yet.</p>
              <p className="ff-small">A feature run takes one feature from Figma frames and the API contract to tested, traceable code.</p>
              <button type="button" className="ff-btn ff-btn-primary" onClick={() => navigate({ name: "new-run", projectId })}>
                Start the first feature
              </button>
            </div>
          ) : (
            <>
              <RunGroup title="In progress" runs={active} now={now} onOpen={(r) => navigate({ name: "run", projectId, runId: r.id })} onDelete={setRunToDelete} />
              <RunGroup title="Finished" runs={finished} now={now} onOpen={(r) => navigate({ name: "run", projectId, runId: r.id })} onDelete={setRunToDelete} />
            </>
          )}
        </section>

        <div className="ff-stack">
          <section className="ff-card">
            <div className="ff-card-head">
              <h2>Ready for AI agents</h2>
              <span className={`ff-tag ${problems ? "ff-tag-warn" : "ff-tag-ok"}`}>{problems ? `⚠ ${problems} to check` : "✓ All set"}</span>
            </div>
            <ul className="ff-checklist">
              {checks.map((c) => (
                <li key={c.key} className={`ff-check ff-check-${c.state}`}>
                  <span className="ff-check-icon" aria-hidden="true">
                    {CHECK_ICON[c.state]}
                  </span>
                  <div>
                    <div className="ff-check-title">{c.title}</div>
                    {c.detail ? <div className="ff-muted ff-small">{c.detail}</div> : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <ProfileCard profile={profile} editing={editing} setEditing={setEditing} onSave={() => void saveOverrides()} />
        </div>
      </div>
    </div>
  );
}

function RunGroup({ title, runs, now, onOpen, onDelete }: { title: string; runs: RunSummary[]; now: number; onOpen(run: RunSummary): void; onDelete(run: RunSummary): void }) {
  if (!runs.length) return null;
  return (
    <div className="ff-run-group">
      <h3>
        {title} <span className="ff-count">{runs.length}</span>
      </h3>
      <ul className="ff-run-list">
        {runs.map((r) => {
          const progress = runProgress(r.steps, r.lanes);
          return (
            <li key={r.id} className="ff-run-row">
              <button type="button" className="ff-run-open" onClick={() => onOpen(r)}>
                <span className="ff-run-top">
                  <StatusBadge spec={visualStateForRun(r.status)} compact />
                  <span className="ff-run-name ff-ellipsis">{r.title}</span>
                  <span className="ff-muted ff-small" title={`Last activity ${new Date(r.lastActivityAt).toLocaleString()}`}>
                    {timeAgo(r.lastActivityAt, now)}
                  </span>
                </span>
                <span className="ff-run-bottom">
                  <RunLanes progress={progress} />
                  <span className="ff-muted ff-small ff-run-count">
                    {progress.done}/{progress.total} steps
                  </span>
                  <RunNowLine status={r.status} progress={progress} />
                </span>
              </button>
              <button type="button" className="ff-icon-btn" title="Delete run" aria-label={`Delete run ${r.title}`} onClick={() => onDelete(r)}>
                🗑
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function readinessChecks(git: GitStatusDto | undefined, clis: CliStatus[], figma: FigmaStatusDto | undefined, profile: ProjectProfile | undefined, warnings: string[]): Check[] {
  const checks: Check[] = [];
  if (git) {
    const changed = (git.dirtyFiles?.length ?? 0) + (git.untrackedFiles?.length ?? 0);
    checks.push(
      !git.isRepo
        ? { key: "git", state: "bad", title: "Not a Git repository", detail: "Code-changing steps need Git for checkpoints and rollback." }
        : git.clean
          ? { key: "git", state: "ok", title: `Git: ${git.branch ?? "detached"}, no uncommitted changes`, detail: "Each code step is checkpointed in a hidden snapshot." }
          : {
              key: "git",
              state: "warn",
              title: `${changed} uncommitted ${changed === 1 ? "file" : "files"} on ${git.branch ?? "detached HEAD"}`,
              detail: "Agents edit this folder directly. Commit or stash first so their changes can be reviewed on their own.",
            },
    );
    git.warnings.forEach((w, i) => checks.push({ key: `git-warning-${i}`, state: "warn", title: w }));
  }
  // One installed CLI is enough to run the workflow; the ones not found are only listed.
  const installed = clis.filter((c) => c.installed);
  const missing = clis.filter((c) => !c.installed).map((c) => c.label);
  const notFound = missing.length ? `Not found: ${missing.join(", ")}` : undefined;
  checks.push(
    installed.length
      ? {
          key: "clis",
          state: "ok",
          title: installed.map((c) => `${c.label}${c.version ? ` ${c.version}` : ""}`).join(" · "),
          detail: notFound ?? "AI CLIs installed",
        }
      : { key: "clis", state: "bad", title: "No AI CLI installed", detail: notFound ?? "Install Claude Code to run the AI steps." },
  );
  if (figma) {
    checks.push(
      figma.error
        ? { key: "figma", state: "bad", title: "Figma MCP server missing", detail: figma.error }
        : figma.listening
          ? { key: "figma", state: "ok", title: "GoApp Figma plugin connected", detail: "Push frames with the plugin's FrontFlow button." }
          : { key: "figma", state: "warn", title: "GoApp Figma plugin not connected", detail: "Stage ① builds the UI from frames pushed by the plugin. Open it in Figma desktop." },
    );
  }
  if (profile) {
    const count = Object.values(profile.commands).filter(Boolean).length;
    const missing = KEY_COMMANDS.filter((k) => !profile.commands[k]);
    checks.push(
      missing.length
        ? {
            key: "commands",
            state: "warn",
            title: `No ${missing.map((k) => COMMAND_LABELS[k]?.toLowerCase() ?? k).join(" or ")} command`,
            detail: "Agents must ask for approval to run any command missing from the profile. Add it in Project profile.",
          }
        : { key: "commands", state: "ok", title: `${count} commands agents can run without asking`, detail: "From the project profile below." },
    );
  } else {
    checks.push({ key: "commands", state: "warn", title: "Project not analyzed yet", detail: "Re-analyze to detect the stack and commands." });
  }
  warnings.forEach((w, i) => checks.push({ key: `analyzer-${i}`, state: "warn", title: w }));
  return checks;
}

function ProfileCard({
  profile,
  editing,
  setEditing,
  onSave,
}: {
  profile: ProjectProfile | undefined;
  editing: Record<string, string> | undefined;
  setEditing(next: Record<string, string> | undefined): void;
  onSave(): void;
}) {
  if (!profile) {
    return (
      <section className="ff-card">
        <h2>Project profile</h2>
        <p className="ff-muted">No profile yet. Re-analyze the project to detect it.</p>
      </section>
    );
  }
  // While editing, every known command gets a field so a missing one can be added.
  const commandNames = [...new Set([...(editing ? Object.keys(COMMAND_LABELS) : []), ...Object.keys(profile.commands).filter((k) => profile.commands[k])])];
  const changed = !!editing && Object.keys(editing).length > 0;
  return (
    <section className="ff-card">
      <div className="ff-card-head">
        <h2>Project profile</h2>
        {editing ? (
          <span className="ff-actions">
            <button type="button" className="ff-btn ff-btn-small" onClick={() => setEditing(undefined)}>
              Cancel
            </button>
            <button type="button" className="ff-btn ff-btn-small ff-btn-primary" disabled={!changed} onClick={onSave}>
              Save
            </button>
          </span>
        ) : (
          <button type="button" className="ff-btn ff-btn-small" onClick={() => setEditing({})}>
            Edit
          </button>
        )}
      </div>

      <h3>Stack</h3>
      <dl className="ff-profile">
        {STACK_FIELDS.map(([field, label]) => (
          <ProfileField key={field} field={field} label={label} value={profile[field]} profile={profile} editing={editing} setEditing={setEditing} />
        ))}
        {profile.testFrameworks.length ? (
          <>
            <dt>Test frameworks</dt>
            <dd>{profile.testFrameworks.join(", ")}</dd>
          </>
        ) : null}
      </dl>

      <h3>Commands agents can run without asking</h3>
      {commandNames.length ? (
        <dl className="ff-profile ff-profile-commands">
          {commandNames.map((name) => (
            <ProfileField key={name} field={`commands.${name}`} label={COMMAND_LABELS[name] ?? name} value={profile.commands[name]} profile={profile} editing={editing} setEditing={setEditing} mono />
          ))}
        </dl>
      ) : (
        <p className="ff-muted ff-small">None detected. Click Edit to add the build and typecheck commands.</p>
      )}

      {profile.conventionDocs.length ? (
        <>
          <h3>Convention docs agents follow</h3>
          <div className="ff-chips">
            {profile.conventionDocs.map((d) => (
              <span key={d} className="ff-tag ff-mono">
                {d}
              </span>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

function ProfileField({
  field,
  label,
  value,
  profile,
  editing,
  setEditing,
  mono,
}: {
  field: string;
  label: string;
  value: string | undefined;
  profile: ProjectProfile;
  editing: Record<string, string> | undefined;
  setEditing(next: Record<string, string>): void;
  mono?: boolean;
}) {
  const detection = profile.detection[field];
  const evidence = detection?.evidence.slice(0, 3).join("\n");
  const unsure = !!value && !!detection && !detection.overridden && detection.confidence < LOW_CONFIDENCE;
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {editing ? (
          <input className={`ff-input${mono ? " ff-mono" : ""}`} aria-label={label} value={editing[field] ?? value ?? ""} placeholder="Not set" onChange={(e) => setEditing({ ...editing, [field]: e.target.value })} />
        ) : value ? (
          <span className="ff-profile-value">
            <span className={mono ? "ff-mono" : undefined} title={evidence}>
              {value}
            </span>
            {detection?.overridden ? <span className="ff-tag">edited</span> : null}
            {unsure && detection ? (
              <span className="ff-tag ff-tag-warn" title={`Detected with ${Math.round(detection.confidence * 100)}% confidence${evidence ? `:\n${evidence}` : ""}`}>
                ⚠ unsure
              </span>
            ) : null}
          </span>
        ) : (
          <span className="ff-muted">Not detected</span>
        )}
      </dd>
    </>
  );
}
