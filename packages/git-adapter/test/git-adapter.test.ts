import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCli, GitError, parseStatus, preflight } from "../src/index.js";

let tmp: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ff-git-")));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "commit.gpgsign", "false");
  write(path.join(repo, "src", "app.ts"), "export const a = 1;\n");
  write(path.join(repo, "README.md"), "# Repo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
});

afterEach(() => {
  // Repository files can be briefly locked on Windows; retry.
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("GitCli", () => {
  it("reports repo basics", async () => {
    const cli = new GitCli(repo);
    expect(await cli.isRepo()).toBe(true);
    expect(fs.realpathSync.native(await cli.topLevel())).toBe(repo);
    expect(await cli.currentBranch()).toBe("main");
    expect(await cli.headSha()).toMatch(/^[0-9a-f]{40}$/);
    expect(await new GitCli(tmp).isRepo()).toBe(false);
  });

  it("parses porcelain v2 status including spaces, renames and untracked files", async () => {
    const cli = new GitCli(repo);
    write(path.join(repo, "src", "app.ts"), "export const a = 2;\n");
    write(path.join(repo, "new dir", "file with space.txt"), "x\n");
    git(repo, "mv", "README.md", "README2.md");
    const st = await cli.status();
    expect(st.clean).toBe(false);
    expect(st.branch).toMatchObject({ head: "main", detached: false });
    expect(st.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/app.ts", kind: "changed", unstaged: true }),
        expect.objectContaining({ path: "new dir/file with space.txt", kind: "untracked" }),
        expect.objectContaining({ path: "README2.md", origPath: "README.md", kind: "renamed", staged: true }),
      ]),
    );
  });

  it("parses conflicted entries", () => {
    const raw = "# branch.oid abc\0# branch.head main\0u UU N... 100644 100644 100644 100644 a b c conflict file.ts\0";
    expect(parseStatus(raw).entries[0]).toMatchObject({ path: "conflict file.ts", kind: "conflicted" });
  });

  it("produces diffs with numstat and change kinds", async () => {
    const cli = new GitCli(repo);
    write(path.join(repo, "src", "app.ts"), "export const a = 2;\nexport const b = 3;\n");
    write(path.join(repo, "src", "new.ts"), "x\n");
    const plain = await cli.diff();
    expect(plain.files).toEqual([{ path: "src/app.ts", additions: 2, deletions: 1, binary: false, change: "modified" }]);
    expect(plain.patch).toContain("+export const b = 3;");

    const withUntracked = await cli.diff({ from: "HEAD", includeUntracked: true });
    expect(withUntracked.files.map((f) => [f.path, f.change])).toEqual([
      ["src/app.ts", "modified"],
      ["src/new.ts", "added"],
    ]);
    // Real index untouched by the temp-index diff.
    expect((await cli.status()).entries.find((e) => e.path === "src/new.ts")?.kind).toBe("untracked");
  });

  it("raises typed errors", async () => {
    await expect(new GitCli(repo).run(["not-a-command"])).rejects.toBeInstanceOf(GitError);
    await expect(new GitCli(repo, { gitBinary: "definitely-not-git-xyz" }).run(["status"])).rejects.toMatchObject({ code: "GIT_NOT_FOUND" });
    await expect(new GitCli(repo).diff({ from: "--output=x" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("preflight", () => {
  it("reports a clean repo", async () => {
    const r = await preflight(repo);
    expect(r).toMatchObject({ isRepo: true, branch: "main", detached: false, clean: true });
    expect(r.baseSha).toBe(git(repo, "rev-parse", "HEAD").trim());
    expect(r.dirtyFiles).toEqual([]);
  });

  it("reports dirty and untracked files without touching them", async () => {
    write(path.join(repo, "src", "app.ts"), "changed\n");
    write(path.join(repo, "notes.txt"), "mine\n");
    const before = git(repo, "status", "--porcelain");
    const r = await preflight(repo);
    expect(r.clean).toBe(false);
    expect(r.dirtyFiles).toEqual(["src/app.ts"]);
    expect(r.untrackedFiles).toEqual(["notes.txt"]);
    expect(r.warnings.join(" ")).toMatch(/commit or stash/);
    expect(git(repo, "status", "--porcelain")).toBe(before);
    expect(fs.readFileSync(path.join(repo, "src", "app.ts"), "utf8")).toBe("changed\n");
  });

  it("handles non-repos and unborn branches", async () => {
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(plain);
    expect(await preflight(plain)).toMatchObject({ isRepo: false, baseSha: null });
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty);
    git(empty, "init", "-q", "-b", "main");
    expect(await preflight(empty)).toMatchObject({ isRepo: true, baseSha: null });
  });
});
