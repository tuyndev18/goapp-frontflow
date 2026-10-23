import { useState } from "react";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";

export function NewFeatureRun({ projectId }: { projectId: string }) {
  const navigate = useApp((s) => s.navigate);
  const notify = useApp((s) => s.notify);
  const projectName = useApp((s) => s.projects.find((p) => p.id === projectId)?.name);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      const state = await api.invoke("runs:create", { projectId, title: title.trim() });
      navigate({ name: "run", projectId, runId: state.run.id, nodeId: "A.figma_scope" });
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
        <ol className="ff-next-steps">
          <li>
            <strong>Select Figma scope</strong> — push frames from the GoApp Figma plugin&apos;s FrontFlow button, then click Run
          </li>
          <li>
            <strong>Read API contract</strong> — import the API contract (Markdown or OpenAPI); with Figma it decides whether the feature is ready to build
          </li>
          <li>
            <strong>Read BA specification</strong> — import it any time; it only drives the acceptance tests and never blocks implementation
          </li>
          <li>FrontFlow checks readiness, implements the UI and API, designs and runs the acceptance tests, and reports; you can follow every step live</li>
        </ol>
        <div className="ff-actions">
          <button type="submit" className="ff-btn ff-btn-primary" disabled={!title.trim() || submitting}>
            {submitting ? "Creating…" : "Create feature"}
          </button>
          <span className="ff-muted ff-small">AI engine: the default from Settings</span>
        </div>
      </form>
    </div>
  );
}
