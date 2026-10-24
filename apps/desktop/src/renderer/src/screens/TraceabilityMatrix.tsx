import { useEffect, useState } from "react";
import type { RunReportDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { Loading } from "../components/Loading.js";
import { Markdown } from "../components/Markdown.js";
import { FileActions } from "../components/FileActions.js";

/**
 * Spec §20.1 #6: the run's Markdown reports — the UI vs API review (workflow A), the BA scenarios
 * and test design (C1), the acceptance tests and the evidence report (C2) — one tab each.
 */
export function TraceabilityMatrix({ projectId, runId }: { projectId: string; runId: string }) {
  const navigate = useApp((s) => s.navigate);
  const notify = useApp((s) => s.notify);
  const runState = useApp((s) => s.runStates[runId]);
  const [reports, setReports] = useState<RunReportDto[]>();
  const [view, setView] = useState<string>();

  useEffect(() => {
    api.invoke("runs:reports", { runId }).then(setReports, (err) => notify("error", errorMessage(err)));
  }, [runId, notify, runState?.run.status]);

  const shown = reports?.find((r) => r.name === view) ?? reports?.[0];

  return (
    <div className="ff-screen">
      <header className="ff-screen-header">
        <div>
          <button type="button" className="ff-back" onClick={() => navigate({ name: "run", projectId, runId })}>
            ← {runState?.run.title ?? "Back to workflow"}
          </button>
          <h1>Reports</h1>
          <p className="ff-muted">The run&apos;s reports: whether the API contract is enough for the built UI, the BA scenarios and test design, the acceptance tests and the evidence.</p>
        </div>
        {reports?.length ? (
          <div className="ff-tabs" role="tablist">
            {reports.map((r) => (
              <button key={r.name} type="button" role="tab" aria-selected={shown?.name === r.name} className={`ff-tab${shown?.name === r.name ? " ff-tab-active" : ""}`} onClick={() => setView(r.name)}>
                {r.title}
              </button>
            ))}
          </div>
        ) : null}
      </header>
      {reports === undefined ? <Loading label="Loading reports" /> : null}
      {reports?.length === 0 ? <p>No report yet. The UI vs API review is the first one, written once the API contract is imported.</p> : null}
      {shown ? (
        <div className="ff-report">
          <FileActions runId={runId} text={shown.text} path={shown.path} />
          <Markdown source={shown.text} />
        </div>
      ) : null}
    </div>
  );
}
