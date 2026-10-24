import { useEffect, useMemo, useState } from "react";
import type { ArtifactRecord, NodeRun } from "@frontflow/domain";
import { AssumedBadge, StatusBadge, visualStateForNode } from "@frontflow/ui-components";
import type { GraphNodeDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { ActivityFeed } from "../components/ActivityFeed.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { FileActions } from "../components/FileActions.js";
import { Markdown } from "../components/Markdown.js";
import { AiChat } from "../components/AiChat.js";
import { LiveTerminal } from "../components/LiveTerminal.js";
import { PromptEditor } from "../components/PromptEditor.js";
import { formatDuration, interactiveTerminalId, stepDuration, type ActivityLine } from "../lib/activity.js";
import { groupColor, groupLabel, groupOf } from "../lib/groups.js";
import { DocumentHistory, DocumentImportPanel, documentKindOf, FigmaHandoffPanel, type DocumentUpload } from "../components/StepInputs.js";

const TABS = ["Activity", "Prompt", "Result", "Files", "Tests", "Evidence", "AI chat"] as const;
type Tab = (typeof TABS)[number];

export function StepDetail({
  projectId,
  runId,
  node,
  nodeRun,
  lines,
  now,
  onBack,
}: {
  projectId: string;
  runId: string;
  node: GraphNodeDto;
  nodeRun?: NodeRun;
  lines: ActivityLine[];
  now: number;
  onBack(): void;
}) {
  const notify = useApp((s) => s.notify);
  const events = useApp((s) => s.runEvents[runId]);
  const runPaused = useApp((s) => s.runStates[runId]?.run.status === "paused");
  const [tab, setTab] = useState<Tab>("Activity");
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [open, setOpen] = useState<{ record: ArtifactRecord; text?: string; dataUrl?: string }>();
  const [note, setNote] = useState("");
  const [confirmRunAgain, setConfirmRunAgain] = useState(false);

  const outputReport = (nodeRun?.output as { report?: unknown } | undefined)?.report;
  const report = typeof outputReport === "string" ? outputReport : undefined;
  // The UI vs API review's coverage (Đáp ứng: NN%), which gates it.
  const score = (nodeRun?.output as { score?: unknown } | undefined)?.score;
  // Steps with a Markdown report (review, BA scenarios, test design, evidence) open on it; others open on the live activity.
  useEffect(() => setTab(nodeRun?.status === "passed" && report ? "Result" : "Activity"), [node.id]);
  useEffect(() => {
    setOpen(undefined);
    if (!nodeRun) return setArtifacts([]);
    void api.invoke("runs:artifacts", { runId, nodeRunId: nodeRun.id }).then(setArtifacts, () => setArtifacts([]));
  }, [runId, nodeRun?.id, nodeRun?.status]);

  // A step keeps one record across Run again, retries and restarts: show what its latest execution produced, the rest folded away.
  const startedAt = nodeRun?.startedAt;
  const [currentArtifacts, earlierArtifacts] = useMemo(
    () => (startedAt ? [artifacts.filter((a) => a.createdAt >= startedAt), artifacts.filter((a) => a.createdAt < startedAt)] : [artifacts, []]),
    [artifacts, startedAt],
  );
  const sessionId = useMemo(() => events?.find((e) => e.nodeRunId === nodeRun?.id && e.sessionId)?.sessionId, [events, nodeRun?.id]);
  const terminalId = useMemo(() => (nodeRun ? interactiveTerminalId(events ?? [], nodeRun.id) : undefined), [events, nodeRun?.id]);
  const running = nodeRun?.status === "running" || nodeRun?.status === "retrying";
  // An interactive Claude session may be waiting for an answer (trust folder, permissions): bring it up.
  useEffect(() => {
    if (terminalId && running) setTab("AI chat");
  }, [terminalId]);
  const files = useMemo(() => {
    const out = new Map<string, string>();
    for (const e of events ?? []) {
      // Like Evidence: only what the latest execution changed (earlier runs of the step left old workflow files).
      if (e.type === "file.changed" && e.nodeRunId === nodeRun?.id && (!startedAt || e.timestamp >= startedAt)) {
        const p = e.payload as { path: string; change: string };
        out.set(p.path, p.change);
      }
    }
    return [...out];
  }, [events, nodeRun?.id, startedAt]);
  const tests = useMemo(
    () =>
      (events ?? [])
        .filter((e) => e.type === "test.result" && e.nodeRunId === nodeRun?.id && (!startedAt || e.timestamp >= startedAt))
        .map((e) => ({ id: e.id, ...(e.payload as { suite: string; passed: number; failed: number; skipped: number }) })),
    [events, nodeRun?.id, startedAt],
  );

  async function act(fn: () => Promise<unknown>, done?: string) {
    try {
      await fn();
      if (done) notify("info", done);
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }

  async function show(id: string) {
    await act(async () => setOpen(await api.invoke("runs:readArtifact", { artifactId: id })));
  }

  const spec = visualStateForNode(nodeRun?.status);
  const duration = stepDuration(nodeRun, now);
  const canRetry = nodeRun && ["failed", "blocked", "cancelled"].includes(nodeRun.status);
  // A finished step can run again, e.g. after its prompt was edited; the engine resets the steps after it.
  const canRunAgain = nodeRun?.status === "passed" || nodeRun?.status === "waiting_for_input";
  const isGapGate = node.type === "readiness.review" || node.type === "tests.design" || node.type === "test.acceptance";
  const documentKind = documentKindOf(node.type);

  return (
    <section className="ff-detail" aria-label={`Step ${node.label}`}>
      <header className="ff-detail-header">
        <button type="button" className="ff-back" onClick={onBack}>
          ← All activity
        </button>
        <div className="ff-detail-title">
          <h2>{node.label}</h2>
        </div>
        <div className="ff-run-meta">
          <StatusBadge spec={spec} {...(nodeRun && nodeRun.attempt > 1 ? { suffix: `attempt ${nodeRun.attempt}` } : {})} />
          {nodeRun?.assumed ? <AssumedBadge /> : null}
          <span className="ff-meta-item">
            <span className="ff-lane-dot" style={{ background: groupColor(groupOf(node)) }} /> {groupLabel(groupOf(node))}
          </span>
          {duration !== undefined ? <span className="ff-meta-item">⏱ {formatDuration(duration)}</span> : null}
          <span className="ff-meta-item">{node.ai ? "🤖 AI CLI agent" : "⚙ Automatic, no AI"}</span>
        </div>
        {node.description ? <p className="ff-muted ff-detail-desc">{node.description}</p> : null}
        {node.ai ? <StepSkills nodeId={node.id} /> : null}
        {canRunAgain ? (
          <div className="ff-actions">
            <button type="button" className="ff-btn" onClick={() => setConfirmRunAgain(true)}>
              ↻ Run again
            </button>
            <span className="ff-muted ff-small">Runs this step again{node.ai ? " with its current prompt" : ""}; the steps after it run again too.</span>
          </div>
        ) : null}
      </header>
      <ConfirmDialog
        open={confirmRunAgain}
        title={`Run "${node.label}" again?`}
        confirmLabel="Run again"
        onCancel={() => setConfirmRunAgain(false)}
        onConfirm={() => {
          setConfirmRunAgain(false);
          // A gap gate asks again instead of reusing gaps accepted earlier.
          void act(
            () => api.invoke("runs:retryNode", { runId, nodeId: node.id, ...(isGapGate ? { input: {} } : {}) }),
            // A paused run keeps the reset steps waiting until it is resumed.
            runPaused ? `${node.label} reset; the run is paused — click Resume to run it` : `Running ${node.label} again`,
          );
        }}
      >
        <p>The current result of this step is replaced, and every step after it is reset and runs again. Code changes those steps already made stay in the project.</p>
      </ConfirmDialog>

      {nodeRun?.status === "waiting_for_input" ? (
        <div className="ff-callout ff-callout-warning">
          <p>
            <strong>⏸ Needs your input.</strong> {nodeRun.blockerSummary}
          </p>
          {documentKind ? (
            <DocumentImportPanel runId={runId} nodeId={node.id} kind={documentKind} />
          ) : node.type === "figma.design" ? (
            <FigmaHandoffPanel runId={runId} nodeId={node.id} />
          ) : isGapGate ? (
            <div className="ff-actions">
              <button type="button" className="ff-btn ff-btn-primary" onClick={() => void act(() => api.invoke("runs:provideInput", { runId, nodeId: node.id, data: { accept: true } }), "Gaps accepted")}>
                Accept gaps &amp; continue
              </button>
              <span className="ff-muted ff-small">
                {node.type === "readiness.review"
                  ? "or import a newer API contract in Read API contract; this review then runs again. See Result for the review."
                  : node.type === "test.acceptance"
                    ? "or fix what fails (BA, design or API) and run this step again. See Result for the test report."
                    : "or import a newer BA specification in Read BA specification; test design then runs again. See Evidence for the gap report."}
              </span>
            </div>
          ) : (
            <div className="ff-actions">
              <input className="ff-input ff-grow" placeholder="Optional note" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
              <button type="button" className="ff-btn ff-btn-primary" onClick={() => void act(() => api.invoke("runs:provideInput", { runId, nodeId: node.id, data: note ? { note } : {} }))}>
                Continue
              </button>
            </div>
          )}
        </div>
      ) : null}
      {nodeRun?.status === "failed" || nodeRun?.status === "blocked" ? (
        <div className={`ff-callout ${nodeRun.status === "failed" ? "ff-callout-danger" : "ff-callout-warning"}`}>
          <p>
            <strong>{nodeRun.status === "failed" ? "✕ Failed" : "⚠ Blocked"}:</strong> {nodeRun.error ? `${nodeRun.error.code} — ${nodeRun.error.message}` : nodeRun.blockerSummary}
          </p>
          {canRetry ? (
            <button type="button" className="ff-btn" onClick={() => void act(() => api.invoke("runs:retryNode", { runId, nodeId: node.id }), "Retrying step")}>
              ↻ Retry this step
            </button>
          ) : null}
        </div>
      ) : null}

      {documentKind && nodeRun && ["passed", "failed", "blocked"].includes(nodeRun.status) ? (
        <div className="ff-callout">
          <DocumentHistory uploads={(nodeRun.output as { history?: DocumentUpload[] } | undefined)?.history ?? []} />
          <DocumentImportPanel runId={runId} nodeId={node.id} kind={documentKind} update />
        </div>
      ) : null}

      <div className="ff-tabs ff-tabs-flush" role="tablist">
        {TABS.filter((t) => t !== "Prompt" || node.ai).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`ff-tab${tab === t ? " ff-tab-active" : ""}`} onClick={() => setTab(t)}>
            {t}
            {t === "Result" && typeof score === "number" ? <span className="ff-count">{score}%</span> : null}
            {t === "Files" && files.length ? <span className="ff-count">{files.length}</span> : null}
            {t === "Evidence" && currentArtifacts.length ? <span className="ff-count">{currentArtifacts.length}</span> : null}
          </button>
        ))}
      </div>

      <div className="ff-detail-body">
        {tab === "Activity" && <ActivityFeed lines={lines} showStep={false} defaultVerbose emptyText={nodeRun ? "No activity yet." : "This step has not started yet."} />}
        {tab === "Prompt" && node.ai ? <PromptEditor nodeId={node.id} label={node.label} /> : null}
        {tab === "Result" && <ResultView runId={runId} value={nodeRun?.output} report={report} />}
        {tab === "Files" && (
          <div className="ff-pad">
            {files.length ? (
              <ul className="ff-files">
                {files.map(([path, change]) => (
                  <li key={path}>
                    <span className={`ff-file-change ff-file-${change}`}>{change === "created" ? "A" : change === "deleted" ? "D" : "M"}</span>
                    <span className="ff-mono">{path}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ff-muted">No file changes reported for this step.</p>
            )}
            <ArtifactList items={currentArtifacts.filter((a) => a.kind === "diff")} onOpen={show} />
          </div>
        )}
        {tab === "Tests" && (
          <div className="ff-pad">
            {tests.length ? (
              <table className="ff-table ff-table-compact">
                <thead>
                  <tr>
                    <th scope="col">Suite</th>
                    <th scope="col">Passed</th>
                    <th scope="col">Failed</th>
                    <th scope="col">Skipped</th>
                  </tr>
                </thead>
                <tbody>
                  {tests.map((t) => (
                    <tr key={t.id}>
                      <td>{t.suite}</td>
                      <td>✓ {t.passed}</td>
                      <td className={t.failed ? "ff-error" : undefined}>{t.failed ? `✕ ${t.failed}` : "0"}</td>
                      <td>{t.skipped}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="ff-muted">No test results for this step.</p>
            )}
          </div>
        )}
        {tab === "Evidence" && (
          <div className="ff-pad">
            <ArtifactList items={currentArtifacts} onOpen={show} />
            {earlierArtifacts.length ? (
              <details>
                <summary className="ff-muted">Earlier runs of this step ({earlierArtifacts.length})</summary>
                <ArtifactList items={earlierArtifacts} onOpen={show} />
              </details>
            ) : null}
          </div>
        )}
        {tab === "AI chat" &&
          (terminalId ? (
            <div className="ff-step-session">
              <p className="ff-muted ff-small ff-step-session-hint">
                {running
                  ? "Interactive Claude Code session. Click inside and type to answer its questions (trust this folder, permissions) or to keep chatting."
                  : "Last screen of the interactive Claude Code session."}
              </p>
              <LiveTerminal terminalId={terminalId} />
            </div>
          ) : sessionId && nodeRun ? (
            <AiChat runId={runId} nodeRunId={nodeRun.id} />
          ) : (
            <p className="ff-pad ff-muted">This step does not use an AI session.</p>
          ))}
        {open && tab !== "Activity" ? (
          <div className="ff-artifact-view">
            <div className="ff-row">
              <strong>{open.record.relativePath.split("/").pop()?.replace(/^art_[a-z0-9]+-/, "")}</strong>
              <span className="ff-muted ff-mono ff-small">sha256 {open.record.contentHash.slice(0, 12)}</span>
              {open.text !== undefined ? <FileActions runId={runId} text={open.text} artifactId={open.record.id} /> : null}
              <button type="button" className="ff-btn ff-btn-small" onClick={() => setOpen(undefined)}>
                Close
              </button>
            </div>
            {open.dataUrl ? <img src={open.dataUrl} alt="Artifact preview" className="ff-img" /> : null}
            {open.text !== undefined ? (
              open.record.mimeType === "text/markdown" ? <Markdown source={open.text} /> : <pre className="ff-pre">{open.text}</pre>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Skills attached to this AI step (Skills screen); they are added to the step's prompt when it runs. */
function StepSkills({ nodeId }: { nodeId: string }) {
  const navigate = useApp((s) => s.navigate);
  const [names, setNames] = useState<string[]>();
  useEffect(() => {
    void api.invoke("skills:list").then(
      (s) => setNames(s.assignments[nodeId] ?? []),
      () => setNames(undefined),
    );
  }, [nodeId]);
  if (!names) return null;
  return (
    <div className="ff-detail-skills ff-small">
      <span className="ff-muted">Skills:</span>
      {names.length ? names.map((n) => <span key={n} className="ff-tag ff-mono">{n}</span>) : <span className="ff-muted">none</span>}
      <button type="button" className="ff-link" onClick={() => navigate({ name: "skills", nodeId })}>
        {names.length ? "Manage" : "Add skills"}
      </button>
    </div>
  );
}

function ArtifactList({ items, onOpen }: { items: ArtifactRecord[]; onOpen(id: string): void }) {
  if (items.length === 0) return <p className="ff-muted">No artifacts.</p>;
  return (
    <ul className="ff-artifacts">
      {items.map((a) => (
        <li key={a.id}>
          <button type="button" className="ff-artifact" onClick={() => onOpen(a.id)}>
            <span className="ff-tag">{a.kind.replace("_", " ")}</span>
            <span>{a.relativePath.split("/").pop()?.replace(/^art_[a-z0-9]+-/, "")}</span>
            <span className="ff-muted ff-small">{(a.sizeBytes / 1024).toFixed(1)} KB</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ResultView({ runId, value, report }: { runId: string; value: unknown; report: string | undefined }) {
  if (value === undefined) return <p className="ff-pad ff-muted">No result yet.</p>;
  if (report) {
    const reportPath = (value as { reportPath?: unknown }).reportPath;
    return (
      <div className="ff-report ff-pad">
        <FileActions runId={runId} text={report} {...(typeof reportPath === "string" ? { path: reportPath } : {})} />
        <Markdown source={report} />
      </div>
    );
  }
  const text = JSON.stringify(value, null, 2) ?? "";
  return <pre className="ff-pre ff-pad-pre">{text.length > 20000 ? `${text.slice(0, 20000)}\n…truncated` : text}</pre>;
}
