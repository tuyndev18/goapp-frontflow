import { execFile } from "node:child_process";
import type { DetectedValue } from "@frontflow/domain";
import { detected } from "./detectors.js";

function git(cwd: string, args: string[], gitBinary: string): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      gitBinary,
      ["-c", "core.quotepath=false", ...args],
      { cwd, timeout: 5000, windowsHide: true, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } },
      (error, stdout) => resolve({ ok: !error, stdout: typeof stdout === "string" ? stdout : "" }),
    );
  });
}

export interface GitDetection {
  isRepo: boolean;
  defaultBaseBranch: DetectedValue<string>;
}

/** Read-only detection of the default base branch. Tolerates missing git and non-repos. */
export async function detectGit(root: string, gitBinary = "git"): Promise<GitDetection> {
  const inside = await git(root, ["rev-parse", "--is-inside-work-tree"], gitBinary);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return { isRepo: false, defaultBaseBranch: detected("main", 0.2, ["not a git repository (or git unavailable); assuming main"]) };
  }
  const originHead = await git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], gitBinary);
  const remoteBranch = /^refs\/remotes\/origin\/(.+)$/.exec(originHead.stdout.trim())?.[1];
  if (originHead.ok && remoteBranch) {
    return { isRepo: true, defaultBaseBranch: detected(remoteBranch, 0.95, [`origin/HEAD -> origin/${remoteBranch}`]) };
  }
  for (const candidate of ["main", "master", "develop", "trunk"]) {
    const local = await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], gitBinary);
    if (local.ok) return { isRepo: true, defaultBaseBranch: detected(candidate, candidate === "develop" || candidate === "trunk" ? 0.6 : 0.8, [`local branch ${candidate} exists`]) };
    const remote = await git(root, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`], gitBinary);
    if (remote.ok) return { isRepo: true, defaultBaseBranch: detected(candidate, 0.75, [`remote branch origin/${candidate} exists`]) };
  }
  const current = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], gitBinary);
  const name = current.stdout.trim();
  if (current.ok && name) return { isRepo: true, defaultBaseBranch: detected(name, 0.5, [`current branch ${name}`]) };
  return { isRepo: true, defaultBaseBranch: detected("main", 0.3, ["no main/master branch found; assuming main"]) };
}
