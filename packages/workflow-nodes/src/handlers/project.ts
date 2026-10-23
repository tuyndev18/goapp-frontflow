import type { GitCheckpoint } from "@frontflow/domain";
import { preflight, snapshotCheckpoint } from "@frontflow/git-adapter";
import { NodeError } from "@frontflow/workflow-engine";
import type { NodeServices } from "../services.js";
import type { WorkspaceOutput } from "../util.js";

/**
 * The AI agents read the project themselves, so FrontFlow does not analyze it as a workflow step.
 * What it still needs from the folder is a checkpoint around every code-changing step: a hidden
 * git snapshot (refs/frontflow/<run>) that never touches the user's branch, index or files.
 */
export async function checkpointRun(
  services: NodeServices,
  ctx: { runId: string; nodeRunId: string },
  workspace: WorkspaceOutput,
  message: string,
): Promise<GitCheckpoint> {
  const checkpoint = await snapshotCheckpoint({ repoPath: workspace.projectPath, runId: ctx.runId, nodeRunId: ctx.nodeRunId, message, baseSha: workspace.baseSha });
  await services.saveCheckpoint?.(checkpoint);
  return checkpoint;
}

/** Code-changing steps need git (with a commit) for their checkpoints; fail clearly, never retry. */
export async function requireGitProject(workspace: WorkspaceOutput): Promise<void> {
  const pre = await preflight(workspace.projectPath);
  if (!pre.isRepo || !pre.baseSha) {
    throw new NodeError("NOT_A_GIT_REPOSITORY", "The project is not a Git repository with at least one commit; code-changing steps need it for checkpoints and rollback (spec §19).", {
      retryable: false,
    });
  }
}
