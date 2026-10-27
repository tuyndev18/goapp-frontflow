import { copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import { newId, nowIso, type GitCheckpoint } from "@frontflow/domain";
import { GitCli, type GitCliOptions } from "./git-cli.js";

const AUTHOR = { name: "FrontFlow", email: "frontflow@localhost" };

/** Hidden ref holding a run's snapshots; not a branch, so it never shows up in the user's workflow. */
export function snapshotRef(runId: string): string {
  return `refs/frontflow/${runId}`;
}

/**
 * Checkpoint of the project folder the AI agents work in (the user's checkout). The whole
 * working tree — untracked, non-ignored files included — is written as a commit object through a
 * temporary index and kept under `refs/frontflow/<runId>`, each snapshot parented on the previous
 * one (the first on HEAD). The user's branch, index and files are never touched.
 */
export async function snapshotCheckpoint(input: {
  repoPath: string;
  runId: string;
  nodeRunId?: string;
  message: string;
  baseSha: string;
  cliOptions?: GitCliOptions;
}): Promise<GitCheckpoint> {
  const git = new GitCli(input.repoPath, input.cliOptions);
  const ref = snapshotRef(input.runId);
  const gitDir = (await git.run(["rev-parse", "--absolute-git-dir"])).stdout.trim();
  const index = path.join(gitDir, `frontflow-${input.runId}.index`);
  const indexEnv = { GIT_INDEX_FILE: index };
  try {
    const parent = (await git.run(["rev-parse", "--verify", "--quiet", ref]).catch(() => undefined))?.stdout.trim() || (await git.headSha());
    // Start from a copy of the user's index: its stat cache lets `add -A` skip reading unchanged
    // files, which on a cold disk (and with on-access virus scanning) can take most of a minute.
    // Files the user marked assume-unchanged keep their indexed content, as in their own commits.
    if (!copyIndex(path.join(gitDir, "index"), index)) await git.run(["read-tree", "HEAD"], { env: indexEnv });
    await git.run(["add", "-A", "--", "."], { env: indexEnv });
    const tree = (await git.run(["write-tree"], { env: indexEnv })).stdout.trim();
    const trailer = input.nodeRunId ? `FrontFlow-Run: ${input.runId}\nFrontFlow-Node-Run: ${input.nodeRunId}` : `FrontFlow-Run: ${input.runId}`;
    const { stdout } = await git.run(["commit-tree", tree, "-p", parent, "-m", input.message || "frontflow checkpoint", "-m", trailer], {
      env: { GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email },
    });
    const headSha = stdout.trim();
    await git.run(["update-ref", ref, headSha]);
    const checkpoint: GitCheckpoint = {
      id: newId("ckpt"),
      workflowRunId: input.runId,
      projectPath: input.repoPath,
      branch: (await git.currentBranch()) ?? "(detached)",
      baseSha: input.baseSha,
      headSha,
      createdAt: nowIso(),
    };
    if (input.nodeRunId) checkpoint.nodeRunId = input.nodeRunId;
    return checkpoint;
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
  }
}

function copyIndex(from: string, to: string): boolean {
  try {
    copyFileSync(from, to);
    return true;
  } catch {
    // No index yet, or it is being rewritten: build the temporary one from HEAD instead.
    return false;
  }
}

/** Drops a run's snapshot ref (the objects are then garbage-collected by git). */
export async function deleteSnapshots(repoPath: string, runId: string, cliOptions?: GitCliOptions): Promise<void> {
  await new GitCli(repoPath, cliOptions).run(["update-ref", "-d", snapshotRef(runId)]).catch(() => undefined);
}
