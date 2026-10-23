import type { FeReadiness, ReadinessStatus } from "@frontflow/domain";

export interface VerdictView {
  score: number;
  headline: string;
  summary: string;
  analyzedBy: "ai" | "heuristics";
  readiness: FeReadiness;
  counts: Record<ReadinessStatus, number>;
  gaps: { api: number; design: number; mapping: number; conflict: number };
  issues: Array<{ id: string; title: string; status: ReadinessStatus; reason: string }>;
}

const STATUS_LABEL: Record<ReadinessStatus, string> = {
  ready: "ready",
  partial: "partial",
  missing_api: "missing API",
  missing_design: "missing design",
  conflict: "conflict",
  ambiguous: "ambiguous",
  fe_only: "FE only",
  assumed: "assumed",
};

/** Whether Figma × API is enough to build the feature, in a few lines (A.readiness result). */
export function VerdictCard({ verdict }: { verdict: VerdictView }) {
  const tone = verdict.score >= 85 ? "success" : verdict.score >= 60 ? "warning" : "danger";
  const gaps = [
    verdict.gaps.api ? `${verdict.gaps.api} API gap → backend` : "",
    verdict.gaps.design ? `${verdict.gaps.design} design gap → design` : "",
    verdict.gaps.mapping ? `${verdict.gaps.mapping} mapping gap` : "",
    verdict.gaps.conflict ? `${verdict.gaps.conflict} conflict` : "",
  ].filter(Boolean);
  return (
    <section className={`ff-verdict ff-verdict-${tone}`} aria-label="FE readiness verdict">
      <div className="ff-verdict-score" aria-label={`Score ${verdict.score} percent`}>
        <strong>{verdict.score}%</strong>
        <span>Figma × API</span>
      </div>
      <div className="ff-verdict-body">
        <h3>{verdict.headline}</h3>
        <p>{verdict.summary}</p>
        <div className="ff-chips">
          <span className="ff-tag">readiness: {verdict.readiness}</span>
          {(Object.keys(STATUS_LABEL) as ReadinessStatus[])
            .filter((s) => verdict.counts[s])
            .map((s) => (
              <span key={s} className={`ff-tag ff-align-tag-${s}`}>
                {STATUS_LABEL[s]} {verdict.counts[s]}
              </span>
            ))}
          {verdict.analyzedBy === "heuristics" ? <span className="ff-tag ff-tag-warn">approximate (no AI)</span> : <span className="ff-tag ff-tag-ai">by AI</span>}
        </div>
        {gaps.length ? <p className="ff-small ff-muted">{gaps.join(" · ")}</p> : null}
        {verdict.issues.length ? (
          <details className="ff-verdict-issues" open={verdict.issues.length <= 6}>
            <summary>Main issues ({verdict.issues.length})</summary>
            <ul>
              {verdict.issues.map((i) => (
                <li key={i.id}>
                  <span className={`ff-tag ff-align-tag-${i.status}`}>{STATUS_LABEL[i.status]}</span> <strong className="ff-mono">{i.id}</strong> {i.title}
                  <div className="ff-muted ff-small">{i.reason}</div>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}

interface ApiContractOutput {
  extractedBy: "ai" | "parser";
  operations: Array<{ id: string; method: string; path: string; roles: string[]; sourceRefs: Array<{ lineStart: number }> }>;
  warnings: string[];
}

interface BaSpecOutput {
  extractedBy: "ai" | "parser";
  requirements: Array<{ id: string; title: string; actor?: string; confidence: number; sourceRefs: Array<{ lineStart: number }> }>;
  acceptanceCriteria: unknown[];
  warnings: string[];
}

interface UiFlowOutput {
  extractedBy: "ai" | "layers";
  uiFlow: Array<{ id: string; name: string; kind: string; figmaNodeIds: string[]; actions: unknown[]; states: Array<{ name: string; designed: boolean }> }>;
  uiDataRequirements: Array<{ id: string; uiFlowNodeId: string; kind: string; description: string }>;
  warnings: string[];
}

interface TestDesignOutput {
  designedBy: "ai" | "criteria";
  status: string;
  coverage: { totalRequirements: number; requirementsWithTests: number; automatableRequirements: number; blockedRequirements: number };
  testCases: Array<{ id: string; title: string; requirementIds: string[]; level: string; automationStatus: string }>;
  testabilityGaps: Array<{ requirementId: string; reason: string; message: string; blocking: boolean }>;
}

export type StepResult =
  | { kind: "api"; output: ApiContractOutput }
  | { kind: "ba"; output: BaSpecOutput }
  | { kind: "ui_flow"; output: UiFlowOutput }
  | { kind: "test_design"; output: TestDesignOutput };

/** Recognizes the outputs that have a readable view; anything else is shown as raw JSON. */
export function readableResult(value: unknown): StepResult | undefined {
  const v = value as Record<string, unknown> | undefined;
  if (!v || typeof v !== "object") return undefined;
  if (Array.isArray(v["testCases"]) && typeof v["designedBy"] === "string") return { kind: "test_design", output: v as unknown as TestDesignOutput };
  if (Array.isArray(v["uiFlow"]) && Array.isArray(v["uiDataRequirements"]) && typeof v["extractedBy"] === "string") return { kind: "ui_flow", output: v as unknown as UiFlowOutput };
  if (Array.isArray(v["requirements"]) && typeof v["extractedBy"] === "string") return { kind: "ba", output: v as unknown as BaSpecOutput };
  if (Array.isArray(v["operations"]) && typeof v["extractedBy"] === "string") return { kind: "api", output: v as unknown as ApiContractOutput };
  return undefined;
}

export function StepResultView({ result }: { result: StepResult }) {
  switch (result.kind) {
    case "api":
      return <ApiContractView output={result.output} />;
    case "ba":
      return <BaSpecView output={result.output} />;
    case "ui_flow":
      return <UiFlowView output={result.output} />;
    case "test_design":
      return <TestDesignView output={result.output} />;
  }
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <details>
      <summary className="ff-warning">{warnings.length} warnings</summary>
      <ul className="ff-small">
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </details>
  );
}

/** What was read from the API contract (A.api_contract result). */
function ApiContractView({ output }: { output: ApiContractOutput }) {
  return (
    <div className="ff-pad ff-stack">
      <p>
        <strong>{output.operations.length}</strong> API operations, extracted by {output.extractedBy === "ai" ? "the AI" : "the built-in parser (approximate)"}.
      </p>
      <Warnings warnings={output.warnings} />
      <table className="ff-table ff-table-compact">
        <thead>
          <tr>
            <th scope="col">API operation</th>
            <th scope="col">Roles</th>
            <th scope="col">Line</th>
          </tr>
        </thead>
        <tbody>
          {output.operations.map((o) => (
            <tr key={o.id}>
              <td className="ff-mono">
                <strong>{o.method}</strong> {o.path}
              </td>
              <td>{o.roles.join(", ") || "—"}</td>
              <td className="ff-mono">L{o.sourceRefs[0]?.lineStart}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What was read from the BA specification (C1.ba_spec result). */
function BaSpecView({ output }: { output: BaSpecOutput }) {
  return (
    <div className="ff-pad ff-stack">
      <p>
        <strong>{output.requirements.length}</strong> business requirements and <strong>{output.acceptanceCriteria.length}</strong> acceptance criteria, extracted by{" "}
        {output.extractedBy === "ai" ? "the AI" : "the built-in parser (approximate)"}.
      </p>
      <Warnings warnings={output.warnings} />
      <table className="ff-table ff-table-compact">
        <thead>
          <tr>
            <th scope="col">Requirement</th>
            <th scope="col">Actor</th>
            <th scope="col">Line</th>
            <th scope="col">Confidence</th>
          </tr>
        </thead>
        <tbody>
          {output.requirements.map((r) => (
            <tr key={r.id}>
              <td>
                <strong className="ff-mono">{r.id}</strong> {r.title}
              </td>
              <td>{r.actor ?? "—"}</td>
              <td className="ff-mono">L{r.sourceRefs[0]?.lineStart}</td>
              <td className={r.confidence < 0.6 ? "ff-warning" : undefined}>{Math.round(r.confidence * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The UI flow model derived from Figma (A.ui_flow result). */
function UiFlowView({ output }: { output: UiFlowOutput }) {
  return (
    <div className="ff-pad ff-stack">
      <p>
        <strong>{output.uiFlow.length}</strong> screens and <strong>{output.uiDataRequirements.length}</strong> UI data/action needs, read{" "}
        {output.extractedBy === "ai" ? "by the AI from the Figma design" : "from the selected layers only (no needs derived)"}.
      </p>
      <Warnings warnings={output.warnings} />
      <table className="ff-table ff-table-compact">
        <thead>
          <tr>
            <th scope="col">Screen</th>
            <th scope="col">States</th>
            <th scope="col">UI needs</th>
          </tr>
        </thead>
        <tbody>
          {output.uiFlow.map((n) => (
            <tr key={n.id}>
              <td>
                <strong>{n.name}</strong> <span className="ff-muted ff-small">{n.kind}</span>
                <div className="ff-mono ff-small ff-muted">{n.figmaNodeIds.join(", ")}</div>
              </td>
              <td className="ff-small">{n.states.map((s) => `${s.name}${s.designed ? "" : " (implied)"}`).join(", ") || "—"}</td>
              <td className="ff-small">
                <ul>
                  {output.uiDataRequirements
                    .filter((r) => r.uiFlowNodeId === n.id)
                    .map((r) => (
                      <li key={r.id}>
                        <span className="ff-tag">{r.kind}</span> {r.description}
                      </li>
                    ))}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The Acceptance Test Case Package (C1.test_design result). */
function TestDesignView({ output }: { output: TestDesignOutput }) {
  const c = output.coverage;
  return (
    <div className="ff-pad ff-stack">
      <p>
        <strong>{output.testCases.length}</strong> test cases for {c.requirementsWithTests}/{c.totalRequirements} BA requirements ({c.automatableRequirements} automatable,{" "}
        {c.blockedRequirements} blocked) — <strong>{output.status}</strong>, designed {output.designedBy === "ai" ? "by the AI" : "from the acceptance criteria only (approximate)"}.
      </p>
      {output.testabilityGaps.length ? (
        <details open>
          <summary className="ff-warning">{output.testabilityGaps.length} testability gaps</summary>
          <ul className="ff-small">
            {output.testabilityGaps.map((g, i) => (
              <li key={i}>
                <strong className="ff-mono">{g.requirementId}</strong> {g.blocking ? "(blocking) " : ""}
                <em>{g.reason}</em>: {g.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <table className="ff-table ff-table-compact">
        <thead>
          <tr>
            <th scope="col">Test case</th>
            <th scope="col">Requirements</th>
            <th scope="col">Level</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {output.testCases.map((t) => (
            <tr key={t.id}>
              <td>
                <strong className="ff-mono">{t.id}</strong> {t.title}
              </td>
              <td className="ff-mono ff-small">{t.requirementIds.join(", ")}</td>
              <td>{t.level}</td>
              <td>{t.automationStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
