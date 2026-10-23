import { useEffect, useRef, useState } from "react";
import type { CliStatus, SessionDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";

type Mode = "chat" | "terminal";

/** Starts an AI CLI session outside any workflow run, in the project folder or its own worktree. */
export function NewSessionDialog({ open, projectId, onCreated, onClose }: { open: boolean; projectId: string; onCreated(session: SessionDto): void; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [clis, setClis] = useState<CliStatus[]>();
  const [adapterId, setAdapterId] = useState("");
  const [mode, setMode] = useState<Mode>("chat");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [permissionMode, setPermissionMode] = useState<"acceptEdits" | "plan">("acceptEdits");
  const [workspace, setWorkspace] = useState<"project" | "worktree">("project");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open || clis) return;
    void Promise.all([api.invoke("clis:detect"), api.invoke("settings:get")]).then(
      ([detected, settings]) => {
        const installed = detected.filter((c) => c.installed);
        setClis(installed);
        setAdapterId((current) => current || (installed.some((c) => c.adapterId === settings.defaultAdapterId) ? settings.defaultAdapterId : (installed[0]?.adapterId ?? "")));
      },
      (err) => setError(errorMessage(err)),
    );
  }, [open, clis]);

  const isClaude = adapterId === "claude-code";
  const canSubmit = !!adapterId && !busy && (mode === "terminal" || !!prompt.trim());

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const session = await api.invoke("sessions:create", {
        projectId,
        adapterId,
        mode,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        permissionMode: isClaude ? permissionMode : "acceptEdits",
        workspace,
      });
      setTitle("");
      setPrompt("");
      onCreated(session);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="ff-dialog ff-new-session" onCancel={(e) => (e.preventDefault(), onClose())} aria-labelledby="ff-new-session-title">
      <h2 id="ff-new-session-title">New AI session</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void submit();
        }}
      >
        <div className="ff-new-session-row">
          <label className="ff-field ff-grow">
            <span>AI CLI</span>
            <select className="ff-input" value={adapterId} onChange={(e) => setAdapterId(e.target.value)} disabled={!clis}>
              {!clis ? <option value="">Detecting…</option> : clis.length === 0 ? <option value="">No AI CLI installed</option> : null}
              {clis?.map((c) => (
                <option key={c.adapterId} value={c.adapterId}>
                  {c.label}
                  {c.version ? ` ${c.version}` : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="ff-field">
            <span>Mode</span>
            <div className="ff-seg" role="radiogroup" aria-label="Session mode">
              {(["chat", "terminal"] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} className={`ff-seg-btn${mode === m ? " ff-seg-active" : ""}`} onClick={() => setMode(m)}>
                  {m === "chat" ? "💬 Chat" : "⌨ Terminal"}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="ff-muted ff-small ff-new-session-hint">
          {mode === "chat"
            ? "FrontFlow drives the CLI headless and shows a readable conversation with tokens and cost. Shell commands need the terminal."
            : "The CLI's own interface in a terminal you type into. FrontFlow only sees whether it prints, so its state is approximate and tokens are not counted."}
        </p>

        <label className="ff-field">
          <span>Title</span>
          <input className="ff-input" value={title} maxLength={120} placeholder="Optional — defaults to the first message" onChange={(e) => setTitle(e.target.value)} />
        </label>

        <fieldset className="ff-field ff-new-session-workspace">
          <span>Workspace</span>
          <label className="ff-checkbox">
            <input type="radio" name="workspace" checked={workspace === "project"} onChange={() => setWorkspace("project")} />
            Project folder — changes land in your working copy
          </label>
          <label className="ff-checkbox">
            <input type="radio" name="workspace" checked={workspace === "worktree"} onChange={() => setWorkspace("worktree")} />
            New git worktree — its own branch, so parallel sessions don't touch each other
          </label>
        </fieldset>

        <div className="ff-new-session-row">
          <label className="ff-field ff-grow">
            <span>Model</span>
            <input className="ff-input" value={model} maxLength={120} placeholder="CLI default" onChange={(e) => setModel(e.target.value)} />
          </label>
          {isClaude ? (
            <label className="ff-field">
              <span>Permissions</span>
              <select className="ff-input" value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as "acceptEdits" | "plan")}>
                <option value="acceptEdits">Edit files</option>
                <option value="plan">Plan only (read)</option>
              </select>
            </label>
          ) : null}
        </div>

        <label className="ff-field">
          <span>{mode === "chat" ? "First message" : "First message (type it in the terminal)"}</span>
          <textarea
            className="ff-input"
            rows={4}
            value={prompt}
            disabled={mode === "terminal"}
            placeholder={mode === "chat" ? "What should the AI do?" : "The terminal opens empty"}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>

        {error ? (
          <p className="ff-error ff-small" role="alert">
            {error}
          </p>
        ) : null}
        <div className="ff-dialog-actions">
          <button type="button" className="ff-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="ff-btn ff-btn-primary" disabled={!canSubmit}>
            {busy ? "Starting…" : "Start session"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
