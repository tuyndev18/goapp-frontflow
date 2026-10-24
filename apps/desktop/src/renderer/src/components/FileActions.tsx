import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";

/** Copy a shown file's text, or show the file itself in the OS file manager (a project file by `path`, or an artifact). */
export function FileActions({ runId, text, path, artifactId }: { runId: string; text: string; path?: string; artifactId?: string }) {
  const notify = useApp((s) => s.notify);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      notify("info", "Copied to the clipboard");
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }

  async function reveal() {
    try {
      await api.invoke("runs:revealFile", { runId, ...(path ? { path } : artifactId ? { artifactId } : {}) });
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }

  return (
    <div className="ff-actions">
      <button type="button" className="ff-btn ff-btn-small" onClick={() => void copy()}>
        Copy
      </button>
      {path || artifactId ? (
        <button type="button" className="ff-btn ff-btn-small" onClick={() => void reveal()}>
          Open in folder
        </button>
      ) : null}
    </div>
  );
}
