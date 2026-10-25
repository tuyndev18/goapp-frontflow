import { useEffect, useState } from "react";
import type { WorkflowSummaryDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { Loading } from "../components/Loading.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";

/**
 * The workflows a feature can run: the built-in one (read-only, changed by cloning it) and the
 * user's own. Each step of a workflow has its prompt (Prompts screen) and its skills (Skills screen).
 */
export function WorkflowsScreen() {
  const navigate = useApp((s) => s.navigate);
  const notify = useApp((s) => s.notify);
  const [workflows, setWorkflows] = useState<WorkflowSummaryDto[]>();
  const [creating, setCreating] = useState<{ name: string; fromId: string }>();
  const [removing, setRemoving] = useState<WorkflowSummaryDto>();
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setWorkflows((await api.invoke("workflows:list")).workflows);
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function create() {
    if (!creating?.name.trim()) return;
    setBusy(true);
    try {
      const w = await api.invoke("workflows:create", { name: creating.name.trim(), ...(creating.fromId ? { fromId: creating.fromId } : {}) });
      setCreating(undefined);
      navigate({ name: "workflow", workflowId: w.id });
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await api.invoke("workflows:delete", { workflowId: removing.id });
      notify("info", `Deleted ${removing.name}`);
      setRemoving(undefined);
      await refresh();
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!workflows) return <Loading label="Loading workflows" screen />;

  return (
    <div className="ff-screen">
      <header className="ff-screen-header">
        <div>
          <span className="ff-eyebrow">Workspace</span>
          <h1>Workflows</h1>
          <p className="ff-muted">
            The steps a feature goes through, lane by lane. Each AI step runs its prompt with Claude Code in the project; a manual check waits for you. Choose the workflow when you create a feature.
          </p>
        </div>
        <div className="ff-actions">
          <button type="button" className="ff-btn ff-btn-primary" onClick={() => setCreating({ name: "", fromId: "" })}>
            + New workflow
          </button>
        </div>
      </header>

      <ul className="ff-workflow-list" aria-label="Workflows">
        {workflows.map((w) => (
          <li key={w.id} className="ff-card ff-workflow-card">
            <div className="ff-grow">
              <div className="ff-row">
                <h2>{w.name}</h2>
                {w.builtin ? <span className="ff-tag">built-in</span> : null}
                <span className="ff-muted ff-small">
                  {w.steps} steps · v{w.version}
                  {w.updatedAt ? ` · saved ${new Date(w.updatedAt).toLocaleString()}` : ""}
                </span>
              </div>
              {w.description ? <p className="ff-muted">{w.description}</p> : null}
            </div>
            <div className="ff-actions">
              <button type="button" className="ff-btn ff-btn-primary" onClick={() => navigate({ name: "workflow", workflowId: w.id })}>
                {w.builtin ? "View" : "Edit"}
              </button>
              <button type="button" className="ff-btn" onClick={() => navigate({ name: "prompts", workflowId: w.id })}>
                Prompts
              </button>
              <button type="button" className="ff-btn" onClick={() => setCreating({ name: `${w.name} (copy)`, fromId: w.id })}>
                Clone
              </button>
              {w.builtin ? null : (
                <button type="button" className="ff-btn ff-btn-danger" onClick={() => setRemoving(w)}>
                  Delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={creating !== undefined}
        title={creating?.fromId ? "Clone workflow" : "New workflow"}
        confirmLabel={creating?.fromId ? "Clone" : "Create"}
        busy={busy}
        onConfirm={() => void create()}
        onCancel={() => setCreating(undefined)}
      >
        <form
          className="ff-dialog-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="ff-field">
            <span>Name</span>
            <input className="ff-input" value={creating?.name ?? ""} maxLength={120} autoFocus onChange={(e) => setCreating((c) => (c ? { ...c, name: e.target.value } : c))} />
          </label>
          <label className="ff-field">
            <span>Start from</span>
            <select className="ff-input" value={creating?.fromId ?? ""} onChange={(e) => setCreating((c) => (c ? { ...c, fromId: e.target.value } : c))}>
              <option value="">An empty workflow (one AI prompt step)</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  A copy of {w.name}, with its prompts and skills
                </option>
              ))}
            </select>
          </label>
        </form>
      </ConfirmDialog>

      <ConfirmDialog
        open={removing !== undefined}
        title={`Delete ${removing?.name ?? "workflow"}?`}
        confirmLabel="Delete workflow"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(undefined)}
      >
        <p>The workflow, its step prompts and its skill attachments are removed. Features that already ran it keep their history. This cannot be undone.</p>
      </ConfirmDialog>
    </div>
  );
}
