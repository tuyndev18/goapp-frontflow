import { useEffect, useState } from "react";
import type { PromptDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { Loading } from "./Loading.js";

const SYSTEM = "_system";

/**
 * Every AI step is just a prompt the agent runs in the project (an interactive session in AI
 * terminals). The user edits it here; the edit applies the next time the step runs (Retry or Run
 * again reruns it). `{{placeholders}}` are filled in by the step with its inputs.
 */
export function PromptEditor({ nodeId, label }: { nodeId: string; label: string }) {
  const notify = useApp((s) => s.notify);
  const [name, setName] = useState(nodeId);
  const [prompt, setPrompt] = useState<PromptDto>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => setName(nodeId), [nodeId]);
  useEffect(() => {
    let live = true;
    setPrompt(undefined);
    api.invoke("prompts:get", { name }).then(
      (p) => {
        if (!live) return;
        setPrompt(p);
        setText(p.text);
      },
      (err) => notify("error", errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [name, notify]);

  async function act(fn: () => Promise<PromptDto>, done: string) {
    setBusy(true);
    try {
      const p = await fn();
      setPrompt(p);
      setText(p.text);
      notify("info", done);
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const isSystem = name === SYSTEM;
  const dirty = prompt !== undefined && text !== prompt.text;

  return (
    <div className="ff-pad ff-stack ff-prompt-editor">
      <div className="ff-row">
        <div className="ff-tabs ff-tabs-small" role="tablist" aria-label="Which prompt">
          <button type="button" role="tab" aria-selected={!isSystem} className={`ff-tab${!isSystem ? " ff-tab-active" : ""}`} onClick={() => setName(nodeId)}>
            {label}
          </button>
          <button type="button" role="tab" aria-selected={isSystem} className={`ff-tab${isSystem ? " ff-tab-active" : ""}`} onClick={() => setName(SYSTEM)}>
            System prompt (all AI steps)
          </button>
        </div>
        {prompt?.customized ? <span className="ff-tag ff-tag-warn">edited</span> : <span className="ff-tag">default</span>}
      </div>
      <p className="ff-muted ff-small">
        {isSystem
          ? "Rules every AI step runs with. "
          : "What the AI agent is asked to do in this step. It runs as an interactive session in your project folder (see AI terminals). "}
        Changes apply the next time the step runs; use Retry or Run again on the step to rerun it now.
      </p>
      {prompt === undefined ? (
        <Loading label="Loading prompt" />
      ) : (
        <>
          <textarea
            className="ff-input ff-mono ff-prompt-text"
            aria-label={isSystem ? "System prompt" : `Prompt of ${label}`}
            value={text}
            spellCheck={false}
            rows={22}
            onChange={(e) => setText(e.target.value)}
          />
          {prompt.placeholders.length ? (
            <p className="ff-small ff-muted">
              Filled in when the step runs:{" "}
              {prompt.placeholders.map((p) => (
                <code key={p} className="ff-prompt-var">{`{{${p}}}`}</code>
              ))}
            </p>
          ) : null}
          <div className="ff-actions">
            <button type="button" className="ff-btn ff-btn-primary" disabled={!dirty || busy || !text.trim()} onClick={() => void act(() => api.invoke("prompts:save", { name, text }), "Prompt saved")}>
              Save prompt
            </button>
            <button type="button" className="ff-btn" disabled={!dirty || busy} onClick={() => setText(prompt.text)}>
              Discard changes
            </button>
            {prompt.customized ? (
              <button type="button" className="ff-btn" disabled={busy} onClick={() => void act(() => api.invoke("prompts:reset", { name }), "Prompt reset to the default")}>
                Reset to default
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
