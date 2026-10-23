import { useState } from "react";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";

/** Claude Code's `--model` aliases: each names the latest model of its family. */
const MODELS = [
  { value: "", label: "Default", hint: "Claude Code's own model setting." },
  { value: "fable", label: "Fable", hint: "Fable: the most capable, for hard features." },
  { value: "opus", label: "Opus", hint: "Opus: strong all-round coding." },
  { value: "sonnet", label: "Sonnet", hint: "Sonnet: fast, a good balance for most steps." },
  { value: "haiku", label: "Haiku", hint: "Haiku: the fastest and lightest." },
];

type Effort = "" | "low" | "medium" | "high" | "xhigh" | "max";

/** Claude Code's `--effort` levels: how long the model thinks before acting. */
const EFFORTS: Array<{ value: Effort; label: string; hint: string }> = [
  { value: "", label: "Default", hint: "Claude Code's own effort setting." },
  { value: "low", label: "Low", hint: "Low: quickest answers, least thinking." },
  { value: "medium", label: "Medium", hint: "Medium: some thinking." },
  { value: "high", label: "High", hint: "High: thinks things through." },
  { value: "xhigh", label: "Extra high", hint: "Extra high: deep thinking, slower." },
  { value: "max", label: "Max", hint: "Max: as much thinking as it takes; slowest, uses the most quota." },
];

/** One choice of a few, every label visible at once. */
function ChoiceRow<T extends string>({ label, options, value, onChange }: { label: string; options: Array<{ value: T; label: string }>; value: T; onChange(value: T): void }) {
  return (
    <div className="ff-choice" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value || "default"} type="button" role="radio" aria-checked={value === o.value} className={`ff-choice-btn${value === o.value ? " ff-choice-active" : ""}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function NewFeatureRun({ projectId }: { projectId: string }) {
  const navigate = useApp((s) => s.navigate);
  const notify = useApp((s) => s.notify);
  const projectName = useApp((s) => s.projects.find((p) => p.id === projectId)?.name);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<Effort>("");

  async function submit() {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      const state = await api.invoke("runs:create", {
        projectId,
        title: title.trim(),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      });
      // Open the Figma step by type: its id differs between workflow versions.
      const figmaStep = state.graph.nodes.find((n) => n.type === "figma.design");
      navigate({ name: "run", projectId, runId: state.run.id, ...(figmaStep ? { nodeId: figmaStep.id } : {}) });
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="ff-screen">
      <header className="ff-screen-header">
        <div>
          <button type="button" className="ff-back" onClick={() => navigate({ name: "project", projectId })}>
            ← {projectName ?? "Project"}
          </button>
          <h1>New feature</h1>
          <p className="ff-muted">Give the feature a name. The workflow asks for the Figma design, the API contract and the BA specification in the steps that need them.</p>
        </div>
      </header>
      <form
        className="ff-form ff-card ff-new-feature"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="ff-field">
          <span>Feature name</span>
          <input className="ff-input ff-input-lg" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Cancel order" autoFocus maxLength={200} />
        </label>
        <div className="ff-field">
          <span>Model</span>
          <ChoiceRow label="Model" options={MODELS} value={model} onChange={setModel} />
          <small className="ff-muted">{MODELS.find((m) => m.value === model)?.hint}</small>
        </div>
        <div className="ff-field">
          <span>Effort</span>
          <ChoiceRow<Effort> label="Effort" options={EFFORTS} value={effort} onChange={setEffort} />
          <small className="ff-muted">{EFFORTS.find((x) => x.value === effort)?.hint} Every AI step of this feature runs Claude Code in its terminal with this model and effort.</small>
        </div>
        <ol className="ff-next-steps">
          <li>
            <strong>Select Figma scope</strong> — push frames from the GoApp Figma plugin&apos;s FrontFlow button, then click Run: the AI agent builds the UI in your project right away
          </li>
          <li>
            <strong>Read API contract</strong> — import it when it is ready (Markdown or OpenAPI); the built UI is then reviewed against it before the API is wired in
          </li>
          <li>
            <strong>Read BA specification</strong> — import it any time; it only drives the acceptance tests and never blocks implementation
          </li>
          <li>FrontFlow drives AI agents in your project folder: UI first, then API review and integration, then the acceptance tests and the report; you can follow every step live</li>
        </ol>
        <div className="ff-actions">
          <button type="submit" className="ff-btn ff-btn-primary" disabled={!title.trim() || submitting}>
            {submitting ? "Creating…" : "Create feature"}
          </button>
          <span className="ff-muted ff-small">AI engine: Claude Code, in an interactive terminal session</span>
        </div>
      </form>
    </div>
  );
}
