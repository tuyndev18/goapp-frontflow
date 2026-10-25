import { useEffect, useState } from "react";
import type { PromptDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { Loading } from "./Loading.js";
import { ProjectPromptAdditions } from "./ProjectPromptAdditions.js";

const SYSTEM = "_system";
/** What the generic steps fill in (see workflow-nodes handlers/generic.ts). */
const GENERIC_PLACEHOLDERS: Record<string, string[]> = {
  "ai.prompt": ["feature", "runFolder", "output", "reports"],
  "manual.check": ["feature", "runFolder", "reports"],
};

type View = "step" | "system" | "project";

/**
 * Every AI step is just a prompt the agent runs in the project (an interactive session in AI
 * terminals); a manual check's prompt is the checklist shown to the person. The user edits it here
 * per workflow; the edit applies the next time the step runs (Retry or Run again reruns it).
 * `{{placeholders}}` are filled in by the step with its inputs. With a project, its own additions
 * to the step's prompt are edited here too.
 */
export function PromptEditor({
  workflowId,
  nodeId,
  nodeType,
  label,
  projectId,
  onSaved,
}: {
  workflowId: string;
  nodeId: string;
  nodeType?: string;
  label: string;
  projectId?: string;
  onSaved?(): void;
}) {
  const notify = useApp((s) => s.notify);
  const [view, setView] = useState<View>("step");
  const [prompt, setPrompt] = useState<PromptDto>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const isSystem = view === "system";
  const ref = isSystem ? { name: SYSTEM } : { workflowId, name: nodeId };

  useEffect(() => setView("step"), [workflowId, nodeId]);
  useEffect(() => {
    if (view === "project") return;
    let live = true;
    setPrompt(undefined);
    api.invoke("prompts:get", isSystem ? { name: SYSTEM } : { workflowId, name: nodeId }).then(
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
  }, [view, workflowId, nodeId, notify]);

  async function act(fn: () => Promise<PromptDto>, done: string) {
    setBusy(true);
    try {
      const p = await fn();
      setPrompt(p);
      setText(p.text);
      notify("info", done);
      onSaved?.();
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const dirty = prompt !== undefined && text !== prompt.text;
  const placeholders = !isSystem && nodeType && GENERIC_PLACEHOLDERS[nodeType] ? GENERIC_PLACEHOLDERS[nodeType] : (prompt?.placeholders ?? []);

  return (
    <div className="ff-pad ff-stack ff-prompt-editor">
      <div className="ff-row">
        <div className="ff-tabs ff-tabs-small" role="tablist" aria-label="Which prompt">
          <button type="button" role="tab" aria-selected={view === "step"} className={`ff-tab${view === "step" ? " ff-tab-active" : ""}`} onClick={() => setView("step")}>
            {label}
          </button>
          {projectId ? (
            <button type="button" role="tab" aria-selected={view === "project"} className={`ff-tab${view === "project" ? " ff-tab-active" : ""}`} onClick={() => setView("project")}>
              This project's additions
            </button>
          ) : null}
          <button type="button" role="tab" aria-selected={isSystem} className={`ff-tab${isSystem ? " ff-tab-active" : ""}`} onClick={() => setView("system")}>
            System prompt (all AI steps)
          </button>
        </div>
        {view !== "project" && prompt?.defaultText ? prompt.customized ? <span className="ff-tag ff-tag-warn">edited</span> : <span className="ff-tag">default</span> : null}
      </div>
      {view === "project" && projectId ? (
        <ProjectPromptAdditions projectId={projectId} workflowId={workflowId} nodeId={nodeId} />
      ) : (
        <>
          <p className="ff-muted ff-small">
            {isSystem
              ? "Rules every AI step runs with. "
              : nodeType === "manual.check"
                ? "What the person checking this step is asked to verify. It is shown in the step's Result while it waits. "
                : "What the AI agent is asked to do in this step, in every project. It runs as an interactive session in your project folder (see AI terminals). "}
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
                placeholder={isSystem ? undefined : "Write what this step should do. A step cannot run without a prompt."}
                onChange={(e) => setText(e.target.value)}
              />
              {placeholders.length ? (
                <p className="ff-small ff-muted">
                  Filled in when the step runs:{" "}
                  {placeholders.map((p) => (
                    <code key={p} className="ff-prompt-var">{`{{${p}}}`}</code>
                  ))}
                </p>
              ) : null}
              <div className="ff-actions">
                <button type="button" className="ff-btn ff-btn-primary" disabled={!dirty || busy || !text.trim()} onClick={() => void act(() => api.invoke("prompts:save", { ...ref, text }), "Prompt saved")}>
                  Save prompt
                </button>
                <button type="button" className="ff-btn" disabled={!dirty || busy} onClick={() => setText(prompt.text)}>
                  Discard changes
                </button>
                {prompt.customized && prompt.defaultText ? (
                  <button type="button" className="ff-btn" disabled={busy} onClick={() => void act(() => api.invoke("prompts:reset", ref), "Prompt reset to the default")}>
                    Reset to default
                  </button>
                ) : null}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
