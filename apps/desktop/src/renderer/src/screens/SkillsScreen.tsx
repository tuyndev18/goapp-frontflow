import { Fragment, useEffect, useMemo, useState } from "react";
import type { SkillDto, SkillNodeDto, SkillsStateDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { Loading } from "../components/Loading.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { Markdown } from "../components/Markdown.js";
import { groupColor, groupOf } from "../lib/groups.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NEW_SKILL_BODY = `# Skill title

## When to use
Describe the tasks this skill is for.

## Instructions
1. First step the AI should follow.
2. …

## Checklist
- [ ] What must be true before the step is done.
`;

interface Draft {
  name: string;
  description: string;
  body: string;
}

const EMPTY_DRAFT: Draft = { name: "", description: "", body: NEW_SKILL_BODY };

/** Assignments are kept per workflow step. */
function stepOf(node: SkillNodeDto): string {
  return `${node.workflowId}/${node.id}`;
}

/**
 * Skill library and per-step skills. A skill is a folder with SKILL.md (frontmatter name +
 * description, then Markdown instructions), the format Claude Code and Codex use; the skills
 * attached to an AI step are added to that step's prompt the next time it runs.
 */
export function SkillsScreen({ focusStep }: { focusStep?: string }) {
  const notify = useApp((s) => s.notify);
  const [state, setState] = useState<SkillsStateDto>();
  /** Name of the skill open in the editor; "" = a new, unsaved skill; undefined = nothing open. */
  const [selected, setSelected] = useState<string>();
  const [original, setOriginal] = useState<SkillDto>();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [pendingOpen, setPendingOpen] = useState<string | null>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [filter, setFilter] = useState("");
  const [bodyView, setBodyView] = useState<"edit" | "preview">("edit");

  async function refresh() {
    try {
      setState(await api.invoke("skills:list"));
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!focusStep || !state) return;
    document.getElementById(`skills-node-${focusStep}`)?.scrollIntoView({ block: "center" });
  }, [focusStep, !state]);

  const dirty = selected === "" || (original !== undefined && (draft.name !== original.name || draft.description !== original.description || draft.body !== original.body));
  const usage = useMemo(() => {
    const out = new Map<string, SkillNodeDto[]>();
    for (const node of state?.nodes ?? []) {
      for (const name of state?.assignments[stepOf(node)] ?? []) out.set(name, [...(out.get(name) ?? []), node]);
    }
    return out;
  }, [state]);
  const visible = (state?.skills ?? []).filter((s) => !filter || `${s.name} ${s.description}`.toLowerCase().includes(filter.toLowerCase()));

  async function load(name: string | null) {
    if (name === null) {
      setSelected("");
      setOriginal(undefined);
      setDraft(EMPTY_DRAFT);
      return;
    }
    try {
      const skill = await api.invoke("skills:get", { name });
      setSelected(skill.name);
      setOriginal(skill);
      setDraft({ name: skill.name, description: skill.description, body: skill.body });
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }

  /** Opens a skill (null = new one), asking first when the editor has unsaved changes. */
  function open(name: string | null) {
    if (name !== null && name === selected) return;
    if (dirty && selected !== undefined) setPendingOpen(name);
    else void load(name);
  }

  async function save() {
    setBusy(true);
    try {
      const saved = await api.invoke("skills:save", {
        ...(original ? { previousName: original.name } : {}),
        name: draft.name.trim(),
        description: draft.description,
        body: draft.body,
      });
      setSelected(saved.name);
      setOriginal(saved);
      setDraft({ name: saved.name, description: saved.description, body: saved.body });
      await refresh();
      notify("info", original ? `Saved ${saved.name}` : `Created ${saved.name}`);
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!original) return;
    setBusy(true);
    try {
      await api.invoke("skills:delete", { name: original.name });
      notify("info", `Deleted ${original.name}`);
      setSelected(undefined);
      setOriginal(undefined);
      setConfirmDelete(false);
      await refresh();
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function assign(node: SkillNodeDto, names: string[]) {
    try {
      const assignments = await api.invoke("skills:assign", { workflowId: node.workflowId, nodeId: node.id, skills: names });
      setState((s) => (s ? { ...s, assignments } : s));
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }

  async function importFolder() {
    try {
      const result = await api.invoke("skills:import");
      if (!result) return;
      await refresh();
      const skipped = result.skipped.length ? ` Skipped ${result.skipped.map((s) => `${s.path} (${s.reason})`).join("; ")}.` : "";
      notify(result.imported.length ? "info" : "error", `Imported ${result.imported.length ? result.imported.join(", ") : "no skills"}.${skipped}`);
      if (result.imported[0]) void load(result.imported[0]);
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }

  async function openFolder(name?: string) {
    try {
      await api.invoke("skills:openFolder", name ? { name } : {});
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }

  if (!state) return <Loading label="Loading skills" screen />;
  const nameError = draft.name && !NAME_PATTERN.test(draft.name.trim()) ? "Lowercase letters, digits and hyphens only (max 64)." : undefined;
  const canSave = dirty && !busy && !nameError && draft.name.trim() && draft.description.trim() && draft.body.trim();

  return (
    <div className="ff-screen">
      <header className="ff-screen-header">
        <div>
          <span className="ff-eyebrow">Workspace</span>
          <h1>Skills</h1>
          <p className="ff-muted">
            Instructions the AI follows in a workflow step, written as <span className="ff-mono">SKILL.md</span> like Claude Code and Codex skills. Attach them to steps below; they apply the
            next time a step runs.
          </p>
        </div>
        <div className="ff-actions">
          <button type="button" className="ff-btn" onClick={() => void importFolder()}>
            Import folder…
          </button>
          <button type="button" className="ff-btn ff-btn-primary" onClick={() => open(null)}>
            + New skill
          </button>
        </div>
      </header>

      <section className="ff-card" aria-labelledby="skills-steps-title">
        <div className="ff-card-head">
          <h2 id="skills-steps-title">Skills per step</h2>
          <span className="ff-muted ff-small">Only steps that run an AI CLI use skills</span>
        </div>
        <table className="ff-table ff-skills-steps">
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">Skills</th>
            </tr>
          </thead>
          <tbody>
            {state.nodes.map((node, i) => {
              const names = state.assignments[stepOf(node)] ?? [];
              const available = state.skills.filter((s) => !names.includes(s.name));
              const firstOfWorkflow = state.nodes[i - 1]?.workflowId !== node.workflowId;
              return (
                <Fragment key={stepOf(node)}>
                {firstOfWorkflow ? (
                  <tr className="ff-table-section">
                    <th scope="colgroup" colSpan={2}>
                      {node.workflowName}
                    </th>
                  </tr>
                ) : null}
                <tr id={`skills-node-${stepOf(node)}`} className={stepOf(node) === focusStep ? "ff-row-active" : undefined}>
                  <th scope="row">
                    <span className="ff-skills-step">
                      <span className="ff-lane-dot" style={{ background: groupColor(groupOf(node)) }} />
                      <span>
                        <strong>{node.label}</strong>
                        <span className="ff-muted ff-small ff-mono"> {node.id}</span>
                      </span>
                    </span>
                  </th>
                  <td>
                    <div className="ff-skills-chips">
                      {names.map((name) => (
                        <span key={name} className="ff-skill-chip">
                          <button type="button" className="ff-skill-chip-name" onClick={() => open(name)} title="Open in the editor">
                            {name}
                          </button>
                          <button
                            type="button"
                            className="ff-skill-chip-remove"
                            aria-label={`Remove ${name} from ${node.label}`}
                            onClick={() => void assign(node, names.filter((n) => n !== name))}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      {available.length ? (
                        <select
                          className="ff-input ff-skills-add"
                          value=""
                          aria-label={`Add a skill to ${node.label}`}
                          onChange={(e) => e.target.value && void assign(node, [...names, e.target.value])}
                        >
                          <option value="">+ Add skill</option>
                          {available.map((s) => (
                            <option key={s.name} value={s.name}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      ) : names.length ? null : (
                        <span className="ff-muted ff-small">Create or import a skill first</span>
                      )}
                    </div>
                  </td>
                </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="ff-card" aria-labelledby="skills-library-title">
        <div className="ff-card-head">
          <h2 id="skills-library-title">Library</h2>
          <button type="button" className="ff-btn ff-btn-small" onClick={() => void openFolder()} title={state.dir}>
            Open folder
          </button>
        </div>
        <div className="ff-skills">
          <div className="ff-skills-list">
            <input className="ff-input" placeholder="Filter skills" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter skills" />
            {visible.length ? (
              <ul className="ff-list" aria-label="Skills">
                {visible.map((s) => {
                  const used = usage.get(s.name) ?? [];
                  return (
                    <li key={s.name}>
                      <button
                        type="button"
                        className={`ff-skill-item${s.name === selected ? " ff-skill-item-active" : ""}`}
                        aria-current={s.name === selected ? "true" : undefined}
                        onClick={() => open(s.name)}
                      >
                        <span className="ff-skill-item-head">
                          <strong className="ff-mono">{s.name}</strong>
                          {used.length ? <span className="ff-tag ff-tag-ai">{used.length === 1 ? "1 step" : `${used.length} steps`}</span> : null}
                        </span>
                        <span className="ff-skill-item-desc">{s.description}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="ff-muted ff-small">{state.skills.length ? "No skill matches the filter." : "No skills yet. Create one or import a folder such as ~/.claude/skills."}</p>
            )}
          </div>

          {selected === undefined ? (
            <div className="ff-empty ff-empty-inline">
              <p>Select a skill to edit it, or create a new one.</p>
            </div>
          ) : (
            <form
              className="ff-skill-editor"
              onSubmit={(e) => {
                e.preventDefault();
                if (canSave) void save();
              }}
            >
              <h3>{original ? `Edit ${original.name}` : "New skill"}</h3>
              <label className="ff-field">
                <span>Name</span>
                <input
                  className="ff-input ff-mono"
                  value={draft.name}
                  placeholder="react-page-generator"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  aria-invalid={nameError ? true : undefined}
                  required
                />
                {nameError ? <small className="ff-error">{nameError}</small> : <small className="ff-muted">The skill folder name; renaming keeps its step assignments.</small>}
              </label>
              <label className="ff-field">
                <span>Description</span>
                <textarea
                  className="ff-input"
                  rows={3}
                  maxLength={1024}
                  value={draft.description}
                  placeholder="What the skill does and when the AI should use it"
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  required
                />
              </label>
              <div className="ff-field">
                <div className="ff-skill-body-bar">
                  <span>Instructions (Markdown)</span>
                  <div className="ff-seg" role="tablist" aria-label="Instructions view">
                    {(["edit", "preview"] as const).map((v) => (
                      <button key={v} type="button" role="tab" aria-selected={bodyView === v} className={`ff-seg-btn${bodyView === v ? " ff-seg-active" : ""}`} onClick={() => setBodyView(v)}>
                        {v === "edit" ? "Edit" : "Preview"}
                      </button>
                    ))}
                  </div>
                </div>
                {bodyView === "edit" ? (
                  <textarea
                    className="ff-input ff-mono ff-skill-body"
                    aria-label="Instructions (Markdown)"
                    rows={22}
                    spellCheck={false}
                    value={draft.body}
                    onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                    required
                  />
                ) : draft.body.trim() ? (
                  <Markdown source={draft.body} className="ff-skill-preview" />
                ) : (
                  <p className="ff-muted">Nothing to preview yet.</p>
                )}
              </div>

              {original ? (
                <fieldset className="ff-skill-steps">
                  <legend>Used in steps</legend>
                  {state.nodes.map((node) => {
                    const names = state.assignments[stepOf(node)] ?? [];
                    const on = names.includes(original.name);
                    return (
                      <label key={stepOf(node)} className="ff-checkbox">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => void assign(node, on ? names.filter((n) => n !== original.name) : [...names, original.name])}
                        />
                        <span>
                          <span className="ff-lane-dot" style={{ background: groupColor(groupOf(node)) }} /> {node.label}
                          <span className="ff-muted ff-small"> · {node.workflowName}</span>
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              ) : (
                <p className="ff-muted ff-small">Save the skill to attach it to steps.</p>
              )}

              {original?.files.length ? (
                <div className="ff-field">
                  <span>Files</span>
                  <ul className="ff-skill-files">
                    {original.files.map((f) => (
                      <li key={f} className="ff-mono ff-small">
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="ff-actions">
                <button type="submit" className="ff-btn ff-btn-primary" disabled={!canSave}>
                  {busy ? "Saving…" : original ? "Save" : "Create skill"}
                </button>
                {original && dirty ? (
                  <button type="button" className="ff-btn" onClick={() => setDraft({ name: original.name, description: original.description, body: original.body })}>
                    Revert
                  </button>
                ) : null}
                {original ? (
                  <>
                    <button type="button" className="ff-btn" onClick={() => void openFolder(original.name)} title="Add templates, scripts or references next to SKILL.md">
                      Open skill folder
                    </button>
                    <span className="ff-grow" />
                    <button type="button" className="ff-btn ff-btn-danger" onClick={() => setConfirmDelete(true)}>
                      Delete
                    </button>
                  </>
                ) : (
                  <button type="button" className="ff-btn" onClick={() => setSelected(undefined)}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${original?.name ?? "skill"}?`}
        confirmLabel="Delete skill"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      >
        <p>
          The skill folder and every file in it are removed
          {original && usage.get(original.name)?.length ? `, and the skill is detached from ${usage.get(original.name)!.map((n) => n.label).join(", ")}` : ""}. This cannot be undone.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={pendingOpen !== undefined}
        title="Discard unsaved changes?"
        confirmLabel="Discard"
        danger
        onConfirm={() => {
          const next = pendingOpen;
          setPendingOpen(undefined);
          if (next !== undefined) void load(next);
        }}
        onCancel={() => setPendingOpen(undefined)}
      >
        <p>The skill in the editor has changes that are not saved.</p>
      </ConfirmDialog>
    </div>
  );
}
