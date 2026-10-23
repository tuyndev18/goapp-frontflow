import { useState } from "react";
import type { Project } from "@frontflow/domain";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

export function DeleteProjectDialog({ project, onClose, onDeleted }: { project?: Pick<Project, "id" | "name" | "rootPath">; onClose(): void; onDeleted(): void }) {
  const notify = useApp((s) => s.notify);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (!project) return;
    setBusy(true);
    try {
      await api.invoke("projects:remove", { projectId: project.id });
      notify("info", `Removed ${project.name} from FrontFlow`);
      onDeleted();
      onClose();
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog open={!!project} title={`Remove ${project?.name ?? "project"}?`} confirmLabel="Remove project" danger busy={busy} onCancel={onClose} onConfirm={() => void confirm()}>
      <p>FrontFlow deletes everything it created for this project: all runs, logs, evidence, AI session history and the runs' hidden git snapshots. Active runs are cancelled. Your project files and branches are not touched.</p>
      <p>
        <strong>Your project folder is not touched:</strong> <span className="ff-mono">{project?.rootPath}</span>
      </p>
    </ConfirmDialog>
  );
}
