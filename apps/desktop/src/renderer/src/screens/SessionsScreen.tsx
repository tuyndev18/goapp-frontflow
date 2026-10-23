import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionDto, UsageDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { NewSessionDialog } from "../components/NewSessionDialog.js";
import { SessionPane } from "../components/SessionPane.js";
import {
  activityAge,
  costLabel,
  costTitle,
  formatTokens,
  groupConversations,
  isActive,
  relativeTime,
  STATE_LABEL,
  type Conversation,
} from "../lib/sessions.js";

type Filter = "all" | "active" | "ended";
type Layout = 1 | 2 | 4;

const REFRESH_TYPES = new Set(["session.started", "session.completed", "session.failed", "status.changed"]);

/**
 * Every AI CLI session of a project — workflow steps and sessions started here — as
 * conversations (a session plus its resumes), with state, activity and usage, and up
 * to four of them open side by side.
 */
export function SessionsScreen({ projectId }: { projectId?: string }) {
  const notify = useApp((s) => s.notify);
  const projects = useApp((s) => s.projects);
  const refreshProjects = useApp((s) => s.refreshProjects);
  const [selectedProject, setSelectedProject] = useState(projectId);
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [usage, setUsage] = useState<UsageDto>();
  const [filter, setFilter] = useState<Filter>("all");
  const [cli, setCli] = useState("");
  const [layout, setLayout] = useState<Layout>(() => readPrefs(projectId).layout);
  const [panes, setPanes] = useState<string[]>(() => readPrefs(projectId).panes);
  const [focused, setFocused] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<{ conversation: Conversation; removeWorktree: boolean; dirty?: string; busy?: boolean }>();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    const prefs = readPrefs(selectedProject);
    setLayout(prefs.layout);
    setPanes(prefs.panes);
    setSessions([]);
    setUsage(undefined);
  }, [selectedProject]);

  useEffect(() => writePrefs(selectedProject, { layout, panes }), [selectedProject, layout, panes]);

  const load = useCallback(async () => {
    if (!selectedProject) return;
    try {
      const [list, total] = await Promise.all([api.invoke("sessions:list", { projectId: selectedProject }), api.invoke("sessions:usage", { projectId: selectedProject })]);
      setSessions(list);
      setUsage(total);
      setNow(Date.now());
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }, [selectedProject, notify]);

  // Agent events arrive in bursts: one list refresh per burst.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleLoad = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 300);
  }, [load]);

  useEffect(() => {
    void load();
    const offEvents = api.on("session:event", (e) => {
      if (REFRESH_TYPES.has(e.type)) scheduleLoad();
    });
    const offChanged = api.on("sessions:changed", (m) => {
      if (m.projectId === selectedProject) scheduleLoad();
    });
    return () => {
      offEvents();
      offChanged();
      clearTimeout(timer.current);
    };
  }, [load, scheduleLoad, selectedProject]);

  const conversations = useMemo(() => groupConversations(sessions), [sessions]);
  const anyLive = conversations.some((c) => c.latest.live);

  // Terminal states come from output timing and relative times age: refresh while something runs.
  useEffect(() => {
    const id = setInterval(() => (anyLive ? void load() : setNow(Date.now())), anyLive ? 5000 : 30_000);
    return () => clearInterval(id);
  }, [anyLive, load]);

  const clis = useMemo(() => [...new Set(sessions.map((s) => s.adapterId))].sort(), [sessions]);
  const visible = conversations.filter(
    (c) => (filter === "all" || (filter === "active" ? isActive(c.latest) : !isActive(c.latest))) && (!cli || c.latest.adapterId === cli),
  );
  const byRoot = useMemo(() => new Map(conversations.map((c) => [c.rootId, c])), [conversations]);
  const openPanes = panes.map((id) => byRoot.get(id)).filter((c): c is Conversation => !!c);
  // Forget panes of conversations deleted elsewhere (after the list has loaded).
  useEffect(() => {
    if (byRoot.size) setPanes((current) => (current.every((id) => byRoot.has(id)) ? current : current.filter((id) => byRoot.has(id))));
  }, [byRoot]);
  const activeCount = conversations.filter((c) => isActive(c.latest)).length;

  function openPane(rootId: string) {
    setFocused(rootId);
    setPanes((current) => (current.includes(rootId) ? current : [...current, rootId].slice(-layout)));
  }

  function changeLayout(next: Layout) {
    setLayout(next);
    setPanes((current) => current.slice(-next));
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleting({ ...deleting, busy: true });
    try {
      const result = await api.invoke("sessions:delete", {
        sessionId: deleting.conversation.latest.id,
        removeWorktree: deleting.removeWorktree,
        force: !!deleting.dirty,
      });
      setPanes((current) => current.filter((id) => id !== deleting.conversation.rootId));
      setDeleting(undefined);
      if (result.worktree === "kept") notify("info", "Session deleted. Its worktree and branch were kept.");
      else if (result.worktree === "removed") notify("info", "Session and worktree deleted. The branch was kept.");
      void load();
    } catch (err) {
      if ((err as { code?: string }).code === "WORKTREE_DIRTY") setDeleting({ ...deleting, busy: false, dirty: errorMessage(err) });
      else {
        setDeleting(undefined);
        notify("error", errorMessage(err));
      }
    }
  }

  return (
    <div className="ff-screen ff-sessions">
      <header className="ff-screen-header">
        <div>
          <span className="ff-eyebrow">Workspace</span>
          <h1>AI CLI sessions</h1>
          <p className="ff-muted">Run several AI CLI sessions side by side, follow their state and usage, and continue any of them in chat or in its terminal.</p>
        </div>
        <div className="ff-actions">
          <label className="ff-field ff-inline ff-header-field">
            <span>Project</span>
            <select className="ff-input" aria-label="Project" value={selectedProject ?? ""} onChange={(e) => setSelectedProject(e.target.value || undefined)}>
              <option value="">Select project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="ff-btn ff-btn-primary" disabled={!selectedProject} onClick={() => setCreating(true)}>
            + New session
          </button>
        </div>
      </header>

      {!selectedProject ? (
        <div className="ff-empty">
          <p>Select a project to list its AI CLI sessions.</p>
        </div>
      ) : (
        <>
          <div className="ff-sstats" aria-label="Project usage">
            <Stat label="Active" value={String(activeCount)} hint={`${conversations.length} conversation${conversations.length === 1 ? "" : "s"}`} />
            <Stat label="Input tokens" value={formatTokens(usage?.inputTokens ?? 0)} hint={usage?.cacheReadTokens ? `${formatTokens(usage.cacheReadTokens)} from cache` : undefined} />
            <Stat label="Output tokens" value={formatTokens(usage?.outputTokens ?? 0)} />
            <Stat
              label="Estimated cost"
              value={usage ? costLabel(usage) : "—"}
              hint={usage?.unpricedModels.length ? "some models unpriced" : usage ? "estimate" : undefined}
              title={usage ? costTitle(usage) : undefined}
            />
          </div>

          {conversations.length === 0 ? (
            <div className="ff-empty ff-empty-inline">
              <p>No AI CLI sessions for this project yet.</p>
              <p className="ff-muted ff-small">Start one here, or run a workflow step that uses an AI agent.</p>
              <button type="button" className="ff-btn ff-btn-primary" onClick={() => setCreating(true)}>
                + New session
              </button>
            </div>
          ) : (
            <div className="ff-sboard">
              <aside className="ff-slist" aria-label="Conversations">
                <div className="ff-slist-tools">
                  <div className="ff-seg" role="tablist" aria-label="Filter sessions">
                    {(["all", "active", "ended"] as const).map((f) => (
                      <button key={f} type="button" role="tab" aria-selected={filter === f} className={`ff-seg-btn${filter === f ? " ff-seg-active" : ""}`} onClick={() => setFilter(f)}>
                        {f === "all" ? "All" : f === "active" ? "Active" : "Ended"}
                      </button>
                    ))}
                  </div>
                  {clis.length > 1 ? (
                    <select className="ff-input ff-slist-cli" aria-label="Filter by CLI" value={cli} onChange={(e) => setCli(e.target.value)}>
                      <option value="">All CLIs</option>
                      {clis.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
                <ul className="ff-slist-items">
                  {visible.map((c) => (
                    <li key={c.rootId}>
                      <button
                        type="button"
                        className={`ff-sitem${panes.includes(c.rootId) ? " ff-sitem-open" : ""}${focused === c.rootId ? " ff-sitem-focused" : ""}`}
                        onClick={() => openPane(c.rootId)}
                      >
                        <span className={`ff-sdot ff-sdot-${c.latest.state}`} title={STATE_LABEL[c.latest.state]} aria-hidden="true" />
                        <span className="ff-sitem-main">
                          <span className="ff-sitem-title ff-ellipsis">{c.title}</span>
                          <span className="ff-sitem-meta ff-small ff-muted">
                            {c.latest.mode === "pty" ? "⌨" : "💬"} {c.latest.adapterId}
                            {c.latest.workflowRunId ? " · workflow" : ""}
                            {c.latest.worktreePath ? " · ⎇" : ""} · <span className={`ff-age ff-age-${activityAge(c.lastActivityAt, now)}`}>{relativeTime(c.lastActivityAt, now)}</span>
                          </span>
                        </span>
                        <span className="ff-sitem-side ff-small">
                          <span className="ff-sitem-state">{STATE_LABEL[c.latest.state]}</span>
                          {c.usage ? (
                            <span className="ff-muted" title={costTitle(c.usage)}>
                              {formatTokens(c.usage.inputTokens + c.usage.outputTokens)} · {costLabel(c.usage)}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                  {visible.length === 0 ? <li className="ff-muted ff-small ff-pad">No session matches the filter.</li> : null}
                </ul>
              </aside>

              <div className="ff-sgrid-wrap">
                <div className="ff-sgrid-tools">
                  <span className="ff-muted ff-small">
                    {openPanes.length} of {layout} pane{layout === 1 ? "" : "s"}
                  </span>
                  <div className="ff-seg" role="radiogroup" aria-label="Panes">
                    {([1, 2, 4] as const).map((n) => (
                      <button key={n} type="button" role="radio" aria-checked={layout === n} className={`ff-seg-btn${layout === n ? " ff-seg-active" : ""}`} onClick={() => changeLayout(n)}>
                        {n === 1 ? "▢ 1" : n === 2 ? "▥ 2" : "▦ 4"}
                      </button>
                    ))}
                  </div>
                </div>
                {openPanes.length === 0 ? (
                  <div className="ff-empty ff-empty-inline">
                    <p>Pick a conversation on the left to open it here.</p>
                  </div>
                ) : (
                  <div className={`ff-sgrid ff-sgrid-${layout}`}>
                    {openPanes.map((c) => (
                      <SessionPane
                        key={c.rootId}
                        projectId={selectedProject}
                        conversation={c}
                        focused={focused === c.rootId}
                        onFocus={() => setFocused(c.rootId)}
                        onClosePane={() => setPanes((current) => current.filter((id) => id !== c.rootId))}
                        onChanged={() => void load()}
                        onDelete={(conversation) => setDeleting({ conversation, removeWorktree: false })}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <NewSessionDialog
            open={creating}
            projectId={selectedProject}
            onClose={() => setCreating(false)}
            onCreated={(session) => {
              setCreating(false);
              void load().then(() => openPane(session.rootSessionId));
            }}
          />
        </>
      )}

      <ConfirmDialog
        open={!!deleting}
        title={deleting?.dirty ? "Discard uncommitted changes?" : "Delete this conversation?"}
        confirmLabel={deleting?.dirty ? "Delete and discard changes" : "Delete"}
        danger
        busy={deleting?.busy}
        onCancel={() => setDeleting(undefined)}
        onConfirm={() => void confirmDelete()}
      >
        {deleting?.dirty ? (
          <p>{deleting.dirty}. Removing the worktree discards them; commits on its branch are kept.</p>
        ) : (
          <>
            <p>
              “{deleting?.conversation.title}” and its {deleting?.conversation.sessions.length} session record(s), messages and usage are removed from FrontFlow. The CLI's own history is not touched.
            </p>
            {deleting?.conversation.latest.worktreePath ? (
              <label className="ff-checkbox">
                <input type="checkbox" checked={deleting.removeWorktree} onChange={(e) => setDeleting({ ...deleting, removeWorktree: e.target.checked })} />
                Also remove its git worktree (the branch is kept)
              </label>
            ) : null}
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}

function Stat({ label, value, hint, title }: { label: string; value: string; hint?: string; title?: string }) {
  return (
    <div className="ff-sstat" title={title}>
      <span className="ff-sstat-label">{label}</span>
      <span className="ff-sstat-value">{value}</span>
      {hint ? <span className="ff-sstat-hint">{hint}</span> : null}
    </div>
  );
}

interface Prefs {
  layout: Layout;
  panes: string[];
}

function readPrefs(projectId: string | undefined): Prefs {
  const fallback: Prefs = { layout: 2, panes: [] };
  if (!projectId) return fallback;
  try {
    const raw = JSON.parse(localStorage.getItem(`ff.sessions.${projectId}`) ?? "null") as Partial<Prefs> | null;
    const layout = raw?.layout === 1 || raw?.layout === 2 || raw?.layout === 4 ? raw.layout : fallback.layout;
    const panes = Array.isArray(raw?.panes) ? raw.panes.filter((p): p is string => typeof p === "string").slice(-layout) : [];
    return { layout, panes };
  } catch {
    return fallback;
  }
}

function writePrefs(projectId: string | undefined, prefs: Prefs): void {
  if (!projectId) return;
  try {
    localStorage.setItem(`ff.sessions.${projectId}`, JSON.stringify(prefs));
  } catch {
    // storage unavailable: the layout just isn't remembered
  }
}
