import { useEffect, useState } from "react";
import type { FigmaStatusDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

const MAX_BYTES = 2 * 1024 * 1024;
/** Same limit as runs:importDocuments (MAX_UPLOAD_FILES). */
const MAX_FILES = 20;

interface PickedFile {
  name: string;
  content: string;
}

/** The documents a document step takes. */
export type DocumentKind = "api" | "ba" | "ops";

/** The document kind of a document step type; undefined for other steps. */
export function documentKindOf(type: string): DocumentKind | undefined {
  return type === "readiness.read_api" ? "api" : type === "tests.read_ba" ? "ba" : type === "tests.read_ops_guide" ? "ops" : undefined;
}

/** One upload into a document step (its files); runs imported before uploads held several files recorded one file per entry. */
export type DocumentUpload = { importedAt: string; documents: Array<{ snapshotId: string; sourceUri?: string }> } | { importedAt: string; snapshotId: string; sourceUri?: string };

/**
 * Input for A.api_contract (kind "api", reviewed against the built UI), B2.ba_spec (kind "ba",
 * followed by the API integration and the acceptance tests) and C2.ops_guide (kind "ops", how to prepare test data, e.g. in
 * the CMS). One upload holds one or more files and replaces the previous
 * upload: the step only reads the latest one. With `update`, a finished step runs again with the
 * new upload, and so do the steps after it (earlier uploads stay in the history).
 */
export function DocumentImportPanel({ runId, nodeId, kind, update }: { runId: string; nodeId: string; kind: DocumentKind; update?: boolean }) {
  const notify = useApp((s) => s.notify);
  const [docs, setDocs] = useState<PickedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const isApi = kind === "api";
  const what = isApi ? "API contract" : kind === "ba" ? "BA specification" : "test operations guide";

  async function pick(list: FileList | null) {
    const files = [...(list ?? [])];
    if (!files.length) return;
    if (files.length > MAX_FILES) return notify("error", `Upload at most ${MAX_FILES} files at once`);
    const tooBig = files.find((f) => f.size > MAX_BYTES);
    if (tooBig) return notify("error", `${tooBig.name} is larger than 2 MB`);
    setDocs(await Promise.all(files.map(async (f) => ({ name: f.name, content: await f.text() }))));
  }

  async function submit() {
    if (!docs.length) return;
    setBusy(true);
    try {
      await api.invoke(
        "runs:importDocuments",
        // OpenAPI files are recognized by their extension; everything else is a Markdown contract.
        isApi
          ? { runId, nodeId, api: docs.map((d) => ({ ...d, kind: /\.(ya?ml|json)$/i.test(d.name) ? ("openapi" as const) : ("markdown" as const) })) }
          : kind === "ba"
            ? { runId, nodeId, ba: docs }
            : { runId, nodeId, ops: docs },
      );
      notify("info", `${what}: ${docs.length} file${docs.length === 1 ? "" : "s"} imported${update ? "; running again with them" : ""}`);
      setDocs([]);
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ff-input-panel">
      {/* The operations guide step passes without a guide, so its first upload is an update too. */}
      <h3>{update && kind !== "ops" ? `Upload a newer ${what}` : `Import ${what}`}</h3>
      <div className="ff-dropzones">
        {isApi ? (
          <FilePick label="API contract" hint="One or more files: Markdown or OpenAPI (.md, .yaml, .json)" accept=".md,.markdown,.yaml,.yml,.json" files={docs} onPick={(l) => void pick(l)} />
        ) : kind === "ba" ? (
          <FilePick label="BA specification" hint="One or more Markdown files (.md) — the API integration, UI states and acceptance tests follow it" accept=".md,.markdown,text/markdown" files={docs} onPick={(l) => void pick(l)} />
        ) : (
          <FilePick
            label="Test operations guide"
            hint="One or more Markdown files (.md) — how to prepare test data and preconditions, e.g. in the CMS"
            accept=".md,.markdown,text/markdown"
            files={docs}
            onPick={(l) => void pick(l)}
          />
        )}
      </div>
      {docs.length > 1 ? (
        <ul className="ff-small ff-picked-files">
          {docs.map((d) => (
            <li key={d.name}>
              {d.name} <span className="ff-muted">· {d.content.split("\n").length} lines</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="ff-muted ff-small">The step reads only the files of its latest upload.</p>
      <div className="ff-actions">
        <button type="button" className="ff-btn ff-btn-primary" disabled={!docs.length || busy} onClick={() => (update ? setConfirming(true) : void submit())}>
          {busy ? "Importing…" : update ? "Import & run again" : "Import & continue"}
        </button>
      </div>
      {update ? (
        <ConfirmDialog
          open={confirming}
          title={`Use these ${docs.length} file${docs.length === 1 ? "" : "s"} from now on?`}
          confirmLabel="Import & run again"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void submit();
          }}
        >
          <p>They replace the files in use: this step and every step after it run again with them only. Earlier uploads stay in the history; code changes already made stay in the project.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/** The uploads into a document step, newest first; only the newest one is in use. */
export function DocumentHistory({ uploads }: { uploads: DocumentUpload[] }) {
  if (!uploads.length) return null;
  return (
    <div className="ff-doc-history">
      <h3>Uploads</h3>
      <ol reversed className="ff-small">
        {[...uploads].reverse().map((u, i) => {
          const files = "documents" in u ? u.documents : [u];
          return (
            <li key={`${u.importedAt}-${i}`}>
              {files.map((f) => f.sourceUri ?? f.snapshotId).join(", ")} <span className="ff-muted">· {new Date(u.importedAt).toLocaleString()}</span>
              {i === 0 ? <span className="ff-tag">in use</span> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function FilePick({ label, hint, accept, files, onPick }: { label: string; hint: string; accept: string; files: PickedFile[]; onPick(list: FileList | null): void }) {
  const [only] = files;
  return (
    <label className={`ff-dropzone${files.length ? " ff-dropzone-filled" : ""}`}>
      <span className="ff-dropzone-icon" aria-hidden="true">
        {files.length ? "📄" : "⬆"}
      </span>
      <span className="ff-dropzone-text">
        <strong>{label}</strong>
        <span className="ff-muted ff-small">{files.length > 1 ? `${files.length} files` : only ? `${only.name} · ${only.content.split("\n").length} lines` : hint}</span>
      </span>
      <input type="file" multiple accept={accept} aria-label={label} onChange={(e) => onPick(e.target.files)} />
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
