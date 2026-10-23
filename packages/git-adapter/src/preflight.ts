import fs from "node:fs";
import { GitCli, GitError } from "./git-cli.js";
import type { GitCliOptions } from "./git-cli.js";

export interface PreflightResult {
  isRepo: boolean;
  topLevel: string | null;
  /** HEAD commit the run should be pinned to; null for non-repos and unborn branches. */
  baseSha: string | null;
  branch: string | null;
  detached: boolean;
  clean: boolean;
  dirtyFiles: string[];
  untrackedFiles: string[];
  conflictedFiles: string[];
  warnings: string[];
}

/** Read-only inspection of a repository before a workflow run (spec §19.1). Never mutates anything. */
export async function preflight(repoPath: string, options: GitCliOptions = {}): Promise<PreflightResult> {
  const git = new GitCli(repoPath, options);
  const result: PreflightResult = {
    isRepo: false,
    topLevel: null,
    baseSha: null,
    branch: null,
    detached: false,
    clean: false,
    dirtyFiles: [],
    untrackedFiles: [],
    conflictedFiles: [],
    warnings: [],
  };

  if (!(await git.isRepo())) {
    result.warnings.push("Not a git repository: checkpoints and rollback are unavailable until the project is under git.");
    return result;
  }
  result.isRepo = true;
  result.topLevel = await git.topLevel();

  const status = await git.status();
  result.baseSha = status.branch.oid;
  result.branch = status.branch.head;
  result.detached = status.branch.detached;
  for (const e of status.entries) {
    if (e.kind === "untracked") result.untrackedFiles.push(e.path);
    else if (e.kind === "conflicted") result.conflictedFiles.push(e.path);
    else if (e.kind !== "ignored") result.dirtyFiles.push(e.path);
  }
  result.clean = status.clean;

  if (!result.baseSha) {
    result.warnings.push("Repository has no commits yet; checkpoints need at least one commit.");
  }
  if (result.detached) result.warnings.push("HEAD is detached; the run will be based on the current commit.");
  if (result.dirtyFiles.length || result.untrackedFiles.length) {
    result.warnings.push(
      `Working tree has ${result.dirtyFiles.length} modified and ${result.untrackedFiles.length} untracked file(s). ` +
        "The AI agents work in this same folder, so their edits mix with these changes; commit or stash first to review the AI's changes on their own.",
    );
  }
  if (result.conflictedFiles.length) result.warnings.push(`${result.conflictedFiles.length} file(s) have unresolved conflicts.`);

  for (const [marker, label] of [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase/am"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["BISECT_LOG", "bisect"],
  ] as const) {
    try {
      if (fs.existsSync(await git.gitPath(marker))) result.warnings.push(`A ${label} is in progress in the main working tree.`);
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
    }
  }
  return result;
}
