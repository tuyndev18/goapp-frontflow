import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteSnapshots, GitCli, snapshotCheckpoint, snapshotRef } from "../src/index.js";

let tmp: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ff-snap-")));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "app.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("snapshotCheckpoint (runs in the project folder)", () => {
  it("captures edits and new files without touching the user's branch, index or files", async () => {
    const head = git(repo, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(repo, "app.ts"), "export const a = 2;\n");
    git(repo, "add", "app.ts"); // the user's own staged change must stay staged
    fs.writeFileSync(path.join(repo, "new.ts"), "export const b = 1;\n");
    fs.mkdirSync(path.join(repo, "node_modules"));
    fs.writeFileSync(path.join(repo, "node_modules", "x.js"), "");
    const statusBefore = git(repo, "status", "--porcelain");

    const first = await snapshotCheckpoint({ repoPath: repo, runId: "run_1", message: "frontflow: baseline", baseSha: head });

    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(repo, "branch", "--show-current").trim()).toBe("main");
    expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
    expect(first).toMatchObject({ projectPath: repo, branch: "main", baseSha: head, workflowRunId: "run_1" });
    expect(git(repo, "rev-parse", snapshotRef("run_1")).trim()).toBe(first.headSha);
    const files = git(repo, "ls-tree", "-r", "--name-only", first.headSha).split("\n").filter(Boolean);
    expect(files).toEqual(expect.arrayContaining(["app.ts", "new.ts", ".gitignore"]));
    expect(files.some((f) => f.startsWith("node_modules"))).toBe(false);

    fs.writeFileSync(path.join(repo, "new.ts"), "export const b = 2;\n");
    const second = await snapshotCheckpoint({ repoPath: repo, runId: "run_1", nodeRunId: "nr_2", message: "frontflow: step", baseSha: head });
    expect(git(repo, "rev-parse", `${second.headSha}~1`).trim()).toBe(first.headSha);
    const diff = await new GitCli(repo).diff({ from: `${second.headSha}~1`, to: second.headSha });
    expect(diff.files.map((f) => f.path)).toEqual(["new.ts"]);

    await deleteSnapshots(repo, "run_1");
    expect(() => git(repo, "rev-parse", "--verify", "--quiet", snapshotRef("run_1"))).toThrow();
    expect(git(repo, "branch", "--list").trim()).toBe("* main");
  });
});
