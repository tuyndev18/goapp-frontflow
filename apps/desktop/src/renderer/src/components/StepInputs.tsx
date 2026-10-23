import { useEffect, useState } from "react";
import type { FigmaStatusDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";

const MAX_BYTES = 2 * 1024 * 1024;

interface PickedFile {
  name: string;
  content: string;
}

/**
 * Input for A.api_contract (kind "api", decides FE readiness) and C1.ba_spec (kind "ba", only drives
 * the acceptance tests): the document is imported into the waiting step.
 */
export function DocumentImportPanel({ runId, nodeId, kind }: { runId: string; nodeId: string; kind: "api" | "ba" }) {
  const notify = useApp((s) => s.notify);
  const [doc, setDoc] = useState<PickedFile>();
  const [format, setFormat] = useState<"markdown" | "openapi">("markdown");
  const [busy, setBusy] = useState(false);
  const isApi = kind === "api";

  async function pick(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_BYTES) return notify("error", `${file.name} is larger than 2 MB`);
    setDoc({ name: file.name, content: await file.text() });
    if (isApi) setFormat(/\.(ya?ml|json)$/i.test(file.name) ? "openapi" : "markdown");
  }

  async function submit() {
    if (!doc) return;
    setBusy(true);
    try {
      await api.invoke("runs:importDocuments", isApi ? { runId, nodeId, api: { ...doc, kind: format } } : { runId, nodeId, ba: doc });
      notify("info", `${isApi ? "API contract" : "BA specification"} imported`);
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ff-input-panel">
      <h3>{isApi ? "Import API contract" : "Import BA specification"}</h3>
      <div className="ff-dropzones">
        {isApi ? (
          <FilePick label="API contract" hint="Markdown or OpenAPI (.md, .yaml, .json)" accept=".md,.markdown,.yaml,.yml,.json" file={doc} onPick={(f) => void pick(f)} />
        ) : (
          <FilePick label="BA specification" hint="Markdown (.md) — used to generate acceptance tests" accept=".md,.markdown,text/markdown" file={doc} onPick={(f) => void pick(f)} />
        )}
      </div>
      <div className="ff-actions">
        {isApi ? (
          <label className="ff-field ff-inline ff-small">
            <span>API format</span>
            <select className="ff-input" value={format} onChange={(e) => setFormat(e.target.value as "markdown" | "openapi")}>
              <option value="markdown">Markdown contract</option>
              <option value="openapi">OpenAPI JSON/YAML</option>
            </select>
          </label>
        ) : null}
        <button type="button" className="ff-btn ff-btn-primary" disabled={!doc || busy} onClick={() => void submit()}>
          {busy ? "Importing…" : "Import & continue"}
        </button>
      </div>
    </div>
  );
}

function FilePick({ label, hint, accept, file, onPick }: { label: string; hint: string; accept: string; file?: PickedFile; onPick(f: File | undefined): void }) {
  return (
    <label className={`ff-dropzone${file ? " ff-dropzone-filled" : ""}`}>
      <span className="ff-dropzone-icon" aria-hidden="true">
        {file ? "📄" : "⬆"}
      </span>
      <span className="ff-dropzone-text">
        <strong>{label}</strong>
        <span className="ff-muted ff-small">{file ? `${file.name} · ${file.content.split("\n").length} lines` : hint}</span>
      </span>
      <input type="file" accept={accept} aria-label={label} onChange={(e) => onPick(e.target.files?.[0])} />
    </label>
  );
}

/**
 * Input for A.figma_scope: the step only receives data. The designer pushes the selected frames
 * from the GoApp Figma plugin's FrontFlow button; nothing runs until the user clicks Run here.
 */
export function FigmaHandoffPanel({ runId, nodeId }: { runId: string; nodeId: string }) {
  const notify = useApp((s) => s.notify);
  const [figma, setFigma] = useState<FigmaStatusDto>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.invoke("figma:status").then(setFigma);
    return api.on("figma:status", setFigma);
  }, []);

  const handoff = figma?.handoff;

  async function run() {
    if (!handoff) return;
    setBusy(true);
    try {
      await api.invoke("runs:provideInput", { runId, nodeId, data: { handoff } });
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ff-input-panel">
      <h3>Figma design</h3>
      {figma?.error ? (
        <p className="ff-error">⚠ {figma.error}</p>
      ) : figma && !figma.serverPath ? (
        <p className="ff-error">⚠ GoApp Figma MCP server not found: set the path of go-figma&apos;s dist/mcp.mjs in Settings.</p>
      ) : null}
      <p className="ff-muted ff-small" data-testid="figma-listening">
        {figma?.listening ? "● Listening to the GoApp Figma plugin" : "○ Waiting for the GoApp Figma hub…"}
      </p>
      {handoff ? (
        <>
          <p>
            <strong>{handoff.projectName}</strong>{" "}
            <span className="ff-muted ff-small">
              {handoff.id} · {handoff.target} · {new Date(handoff.createdAt).toLocaleTimeString()}
            </span>
          </p>
          <ul className="ff-selection" data-testid="figma-handoff">
            {handoff.nodes.map((n) => (
              <li key={n.id}>
                {n.breakpoint || n.state ? <span className="ff-tag">{n.breakpoint ?? n.state}</span> : null} {n.name}{" "}
                <span className="ff-muted ff-mono ff-small">{n.id}</span>
              </li>
            ))}
          </ul>
          <div className="ff-actions">
            <button type="button" className="ff-btn ff-btn-primary" disabled={busy} onClick={() => void run()}>
              {busy ? "Starting…" : `Run with ${handoff.nodes.length} frame${handoff.nodes.length === 1 ? "" : "s"}`}
            </button>
            <span className="ff-muted ff-small">Push again from Figma to replace this selection.</span>
          </div>
        </>
      ) : (
        <p className="ff-muted">
          In Figma, select the frames and click <strong>FrontFlow</strong> in the GoApp Figma plugin. Keep the plugin window open.
        </p>
      )}
    </div>
  );
}
