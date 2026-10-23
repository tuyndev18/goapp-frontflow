import { useEffect, useMemo, useState } from "react";
import type { ReadinessStatus } from "@frontflow/domain";
import type { TraceabilityDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { Markdown } from "../components/Markdown.js";

const STATUS_ICON: Record<ReadinessStatus, string> = {
  ready: "✓",
  partial: "◑",
  missing_api: "✕",
  missing_design: "✕",
  conflict: "⚡",
  ambiguous: "?",
  fe_only: "–",
  assumed: "≈",
};

type View = "ui" | "tests" | "report";

/**
 * Spec §20.1 #6: UI interaction ↔ Figma ↔ API operation (workflow A, completed by the evidence
 * report) and BA requirement ↔ generated test case ↔ test evidence (workflow C).
 */
export function TraceabilityMatrix({ projectId, runId }: { projectId: string; runId: string }) {
  const navigate = useApp((s) => s.navigate);
  const notify = useApp((s) => s.notify);
  const runState = useApp((s) => s.runStates[runId]);
  const [data, setData] = useState<TraceabilityDto>();
  const [report, setReport] = useState<string | null>(null);
  const [view, setView] = useState<View>("ui");

  useEffect(() => {
    Promise.all([api.invoke("runs:traceability", { runId }), api.invoke("runs:gapReport", { runId })]).then(
      ([d, r]) => {
        setData(d);
        setReport(r);
      },
      (err) => notify("error", errorMessage(err)),
    );
  }, [runId, notify, runState?.run.status]);

  const pkg = data?.readiness;
  const uiTrace = useMemo(() => new Map(data?.trace?.ui.map((t) => [t.uiFlowNodeId, t]) ?? []), [data]);
  const testTrace = useMemo(() => new Map(data?.trace?.tests.map((t) => [t.requirementId, t]) ?? []), [data]);
  const tab = (id: View, label: string) => (
    <button type="button" role="tab" aria-selected={view === id} className={`ff-tab${view === id ? " ff-tab-active" : ""}`} onClick={() => setView(id)}>
      {label}
    </button>
  );

  return (
    <div className="ff-screen">
      <header className="ff-screen-header">
        <div>
          <button type="button" className="ff-back" onClick={() => navigate({ name: "run", projectId, runId })}>
            ← {runState?.run.title ?? "Back to workflow"}
          </button>
          <h1>Traceability matrix</h1>
          <p className="ff-muted">How each UI interaction maps to Figma, the API, code and tests, and how each BA requirement is covered by acceptance tests.</p>
        </div>
        <div className="ff-tabs" role="tablist">
          {tab("ui", "UI ↔ API")}
          {tab("tests", "BA ↔ tests")}
          {tab("report", "Gap reports")}
        </div>
      </header>
      {data === undefined ? <p>Loading…</p> : null}

      {data && view === "ui" ? (
        pkg ? (
          <>
            <div className="ff-row ff-summary" aria-label="FE readiness summary">
              <span className="ff-pill">
                Readiness: <strong>{pkg.readiness}</strong>
              </span>
              <span className="ff-pill">✓ ready {pkg.summary.ready}</span>
              <span className="ff-pill">– FE only {pkg.summary.feOnly}</span>
              <span className="ff-pill">◑ partial {pkg.summary.partial}</span>
              <span className="ff-pill">✕ missing API {pkg.summary.missingApi}</span>
              <span className="ff-pill">✕ missing design {pkg.summary.missingDesign}</span>
              <span className="ff-pill">⚡ conflict {pkg.summary.conflict}</span>
              <span className="ff-pill">? ambiguous {pkg.summary.ambiguous}</span>
              {data.trace ? <span className="ff-pill">Level: {data.trace.verificationLevel}</span> : null}
            </div>
            <table className="ff-table">
              <thead>
                <tr>
                  <th scope="col">Screen / UI need</th>
                  <th scope="col">Readiness</th>
                  <th scope="col">API</th>
                  <th scope="col">Figma</th>
                  <th scope="col">Code</th>
                  <th scope="col">Tests</th>
                  <th scope="col">Trace</th>
                </tr>
              </thead>
              <tbody>
                {pkg.uiFlow.map((node) => {
                  const t = uiTrace.get(node.id) ?? pkg.traceability.find((x) => x.uiFlowNodeId === node.id);
                  const needs = pkg.uiDataRequirements.filter((r) => r.uiFlowNodeId === node.id);
                  return (
                    <tr key={node.id}>
                      <td>
                        <strong>{node.name}</strong> <span className="ff-muted ff-small">{node.kind}</span>
                        <ul className="ff-small">
                          {needs.map((r) => (
                            <li key={r.id}>
                              <span className="ff-mono">{r.id}</span> ({r.kind}) {r.description}
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td>
                        <ul className="ff-small">
                          {needs.map((r) => {
                            const m = pkg.mappings.find((x) => x.uiDataRequirementId === r.id);
                            return m ? (
                              <li key={r.id} title={m.rationale}>
                                <span className={`ff-align ff-align-${m.status}`}>
                                  <span aria-hidden="true">{STATUS_ICON[m.status]}</span> {m.status}
                                </span>
                              </li>
                            ) : null;
                          })}
                        </ul>
                      </td>
                      <td className="ff-mono ff-small">{t?.apiOperationIds.join(", ") || "—"}</td>
                      <td className="ff-mono ff-small">{node.figmaNodeIds.join(", ") || "—"}</td>
                      <td className="ff-mono ff-small">{t?.sourceFiles.length ? `${t.sourceFiles.length} file(s)` : "—"}</td>
                      <td className="ff-small">{t?.testIds.length ? `${t.testIds.length} test case(s)` : "—"}</td>
                      <td>
                        <span className={`ff-align ff-align-${t?.status ?? "unverified"}`}>{t?.status ?? "unverified"}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        ) : (
          <p>The FE Readiness Package is not available yet. It is produced by workflow A.</p>
        )
      ) : null}

      {data && view === "tests" ? (
        data.tests ? (
          <>
            <div className="ff-row ff-summary" aria-label="Acceptance test summary">
              <span className="ff-pill">
                Test design: <strong>{data.tests.status}</strong>
              </span>
              <span className="ff-pill">Requirements {data.tests.coverage.totalRequirements}</span>
              <span className="ff-pill">With tests {data.tests.coverage.requirementsWithTests}</span>
              <span className="ff-pill">Blocked {data.tests.coverage.blockedRequirements}</span>
              <span className="ff-pill">Test cases {data.tests.testCases.length}</span>
            </div>
            <table className="ff-table">
              <thead>
                <tr>
                  <th scope="col">Requirement (BA)</th>
                  <th scope="col">Test cases</th>
                  <th scope="col">Screens</th>
                  <th scope="col">API</th>
                  <th scope="col">Evidence</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {data.tests.requirements.map((r) => {
                  const cases = data.tests!.testCases.filter((c) => c.requirementIds.includes(r.id));
                  const gaps = data.tests!.testabilityGaps.filter((g) => g.requirementId === r.id);
                  const t = testTrace.get(r.id);
                  const ref = r.sourceRefs[0];
                  return (
                    <tr key={r.id}>
                      <td>
                        <strong className="ff-mono">{r.id}</strong>
                        <div>{r.title}</div>
                        {ref ? (
                          <div className="ff-muted ff-small">
                            L{ref.lineStart}–{ref.lineEnd}
                          </div>
                        ) : null}
                        {gaps.map((g) => (
                          <div key={g.id} className="ff-small ff-warning">
                            {g.reason}: {g.message}
                          </div>
                        ))}
                      </td>
                      <td className="ff-small">
                        <ul>
                          {cases.map((c) => (
                            <li key={c.id}>
                              <span className="ff-mono">{c.id}</span> ({c.level}) {c.title}
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td className="ff-mono ff-small">{[...new Set(cases.flatMap((c) => c.uiFlowNodeIds))].join(", ") || "—"}</td>
                      <td className="ff-mono ff-small">{[...new Set(cases.flatMap((c) => c.apiOperationIds))].join(", ") || "—"}</td>
                      <td className="ff-small">{t?.evidenceIds.length ?? 0}</td>
                      <td>
                        <span className={`ff-align ff-align-${t?.status ?? "untested"}`}>{t?.status ?? "untested"}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        ) : (
          <p>The Acceptance Test Case Package is not available yet. It is produced by workflow C1 once the BA specification is imported.</p>
        )
      ) : null}

      {data && view === "report" ? report ? <Markdown source={report} /> : <p>No gap report yet.</p> : null}
    </div>
  );
}
