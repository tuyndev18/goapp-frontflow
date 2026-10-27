import { useEffect, useState } from "react";
import type { PromptAdditionDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { Loading } from "./Loading.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

type Draft = Omit<PromptAdditionDto, "id"> & { id?: string; key: string };

const MAX_ADDITIONS = 20;
let keys = 0;
const toDraft = (a: PromptAdditionDto): Draft => ({ ...a, key: a.id });
const same = (a: Draft[], b: Draft[]) => JSON.stringify(a.map(({ key: _k, ...r }) => r)) === JSON.stringify(b.map(({ key: _k, ...r }) => r));

/**
 * Own instructions for one workflow step, sent after the step's prompt in this order: a project's
 * whenever the step runs in that project, or, with `runId`, one feature's after the project's.
 * Disabled ones are kept but not sent.
 */
export function PromptAdditions({ projectId, runId, workflowId, nodeId }: { projectId: string; runId?: string; workflowId: string; nodeId: string }) {
  const notify = useApp((s) => s.notify);
  const projectName = useApp((s) => s.projects.find((p) => p.id === projectId)?.name ?? projectId);
  const featureName = useApp((s) => (runId ? (s.runStates[runId]?.run.title ?? "this feature") : undefined));
  const owner = featureName ?? projectName;
  const [saved, setSaved] = useState<Draft[]>();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<number>();

  useEffect(() => {
    let live = true;
    setSaved(undefined);
    (runId ? api.invoke("featurePrompts:list", { runId }) : api.invoke("projectPrompts:list", { projectId })).then(
      (all) => {
        if (!live) return;
        const list = (all[`${workflowId}/${nodeId}`] ?? []).map(toDraft);
        setSaved(list);
        setDrafts(list);
      },
      (err) => notify("error", errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [projectId, runId, workflowId, nodeId, notify]);

  function update(i: number, patch: Partial<Draft>) {
    setDrafts((d) => d.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  }

  function move(i: number, by: -1 | 1) {
    setDrafts((d) => {
      const next = [...d];
      const [item] = next.splice(i, 1);
      if (item) next.splice(i + by, 0, item);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    try {
      const additions = drafts.map(({ key: _k, id, ...a }) => ({ ...a, ...(id ? { id } : {}) }));
      const list = (
        await (runId ? api.invoke("featurePrompts:save", { runId, nodeId, additions }) : api.invoke("projectPrompts:save", { projectId, workflowId, nodeId, additions }))
      ).map(toDraft);
      setSaved(list);
      setDrafts(list);
      notify("info", `Saved the additions of ${owner}`);
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!saved) return <Loading label={featureName ? "Loading feature additions" : "Loading project additions"} />;
  const dirty = !same(saved, drafts);
  const canSave = dirty && !busy && drafts.every((a) => a.text.trim());

  return (
    <div className="ff-stack">
      {featureName ? (
        <p className="ff-muted ff-small">
          Instructions only <strong>{featureName}</strong> needs at this step (its screens, edge cases, data…). They are sent after the step's prompt and the additions of{" "}
          {projectName}, in this order, so they win where they differ; other features of {projectName} do not get them.
        </p>
      ) : (
        <p className="ff-muted ff-small">
          Instructions only <strong>{projectName}</strong> needs at this step (its conventions, folders, test accounts…). They are sent after the step's prompt, in this order, in
          every feature of this project; the step's prompt itself stays the same for every project.
        </p>
      )}
      {drafts.length ? (
        <ol className="ff-additions">
          {drafts.map((a, i) => (
            <li key={a.key} className={`ff-addition${a.enabled ? "" : " ff-addition-off"}`}>
              <div className="ff-row">
                <input className="ff-input ff-grow" placeholder="Title (optional)" value={a.title} maxLength={200} onChange={(e) => update(i, { title: e.target.value })} aria-label={`Title of addition ${i + 1}`} />
                <label className="ff-checkbox">
                  <input type="checkbox" checked={a.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} />
                  <span>Send</span>
                </label>
                <button type="button" className="ff-btn ff-btn-small" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move addition ${i + 1} up`}>
                  ↑
                </button>
                <button type="button" className="ff-btn ff-btn-small" disabled={i === drafts.length - 1} onClick={() => move(i, 1)} aria-label={`Move addition ${i + 1} down`}>
                  ↓
                </button>
                <button type="button" className="ff-btn ff-btn-small ff-btn-danger" onClick={() => setRemoving(i)} aria-label={`Remove addition ${i + 1}`}>
                  Remove
                </button>
              </div>
              <textarea
                className="ff-input ff-mono"
                rows={5}
                spellCheck={false}
                value={a.text}
                placeholder="e.g. Use the components in src/shared/ui; never call fetch directly, use src/api/client.ts."
                onChange={(e) => update(i, { text: e.target.value })}
                aria-label={`Text of addition ${i + 1}`}
                aria-invalid={a.text.trim() ? undefined : true}
              />
            </li>
          ))}
        </ol>
      ) : (
        <p className="ff-muted">No additions: the step runs its prompt as it is.</p>
      )}
      <div className="ff-actions">
        <button
          type="button"
          className="ff-btn"
          disabled={drafts.length >= MAX_ADDITIONS}
          onClick={() => setDrafts((d) => [...d, { key: `new-${++keys}`, title: "", text: "", enabled: true }])}
        >
          + Add instruction
        </button>
        <button type="button" className="ff-btn ff-btn-primary" disabled={!canSave} onClick={() => void save()}>
          {busy ? "Saving…" : "Save additions"}
        </button>
        <button type="button" className="ff-btn" disabled={!dirty || busy} onClick={() => setDrafts(saved)}>
          Discard changes
        </button>
      </div>
      <ConfirmDialog
        open={removing !== undefined}
        title="Remove this instruction?"
        confirmLabel="Remove"
        danger
        onCancel={() => setRemoving(undefined)}
        onConfirm={() => {
          if (removing !== undefined) setDrafts((d) => d.filter((_, j) => j !== removing));
          setRemoving(undefined);
        }}
      >
        <p>It is removed from the list; click Save additions to apply.</p>
      </ConfirmDialog>
    </div>
  );
}
