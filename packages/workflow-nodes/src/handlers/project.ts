import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { GitCheckpoint, ProjectProfile } from "@frontflow/domain";
import { analyzeProject } from "@frontflow/project-analyzer";
import { preflight, snapshotCheckpoint } from "@frontflow/git-adapter";
import { NodeError, type NodeHandler } from "@frontflow/workflow-engine";
import type { NodeServices } from "../services.js";
import { json, projectOf, saveArtifact, type WorkspaceOutput } from "../util.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage", ".turbo", ".cache"]);

export interface CodebaseSummary {
  fileCount: number;
  components: string[];
  routes: string[];
  apiClients: string[];
  tests: string[];
  styles: string[];
  conventions: Record<string, string>;
}

export interface PrepareOutput {
  profile: ProjectProfile;
  warnings: string[];
  codebase: CodebaseSummary;
  workspace: WorkspaceOutput;
  userWorkingTreeDirty: boolean;
}

export function projectHandlers(services: NodeServices): Record<string, NodeHandler> {
  return {
    "project.prepare": {
      async execute(ctx, input) {
        const project = await projectOf(ctx, services);
        const checkAbort = () => {
          if (ctx.signal.aborted) throw new NodeError("CANCELLED", "Interrupted");
        };

        ctx.log("info", "Detecting stack, commands and conventions");
        const { profile: detected, warnings } = await analyzeProject(project.rootPath, { projectId: ctx.projectId });
        // User overrides stored on the project win over fresh detection (spec §10.3).
        const profile = project.profile ? mergeOverrides(detected, project.profile) : detected;
        await services.saveProfile?.(ctx.projectId, profile);
        ctx.log("info", `Stack: ${[profile.framework, profile.language, profile.uiLibrary, profile.apiClient, profile.packageManager].filter(Boolean).join(" · ") || "unknown"}`);
        const commands = Object.entries(profile.commands).filter(([, v]) => v);
        ctx.log("info", `Commands: ${commands.map(([k, v]) => `${k}=\`${v}\``).join(", ") || "none detected"}`);
        for (const w of warnings) ctx.log("warn", w);

        const codebase = summarizeCodebase(project.rootPath);
        ctx.log("info", `Codebase: ${codebase.fileCount} files, ${codebase.components.length} components, ${codebase.tests.length} test files; conventions: ${Object.keys(codebase.conventions).join(", ") || "none"}`);
        await saveArtifact(ctx, services, "evidence", "codebase-analysis.json", json(codebase), "application/json", "Codebase analysis");

        checkAbort();
        const pre = await preflight(project.rootPath);
        if (!pre.isRepo || !pre.baseSha) {
          return { status: "blocked", summary: "Project is not a Git repository with at least one commit; code changes need a checkpoint and rollback (spec §19)." };
        }
        const pinned = typeof input.inputs.gitBaseSha === "string" ? input.inputs.gitBaseSha : pre.baseSha;
        // FrontFlow only drives the AI agents: they work in the opened project folder itself.
        ctx.log("info", `AI agents work in the project folder ${project.rootPath} (branch ${pre.branch ?? "detached"})`);
        if (!pre.clean) ctx.log("warn", "The project folder has uncommitted changes: the AI's edits will mix with them. Commit or stash first to review the AI's changes on their own.");
        const workspace: WorkspaceOutput = { projectPath: project.rootPath, branch: pre.branch ?? "(detached)", baseSha: pinned, checkpointId: "", checkpointSha: "" };
        const checkpoint = await checkpointRun(services, ctx, workspace, "frontflow: baseline");
        const output: PrepareOutput = {
          profile,
          warnings,
          codebase,
          workspace: { ...workspace, checkpointId: checkpoint.id, checkpointSha: checkpoint.headSha },
          userWorkingTreeDirty: !pre.clean,
        };
        return { status: "passed", output };
      },
    },
  };
}

/**
 * Records the project folder's state after a step as a hidden git snapshot (refs/frontflow/<run>):
 * the step can be reviewed and rolled back, and the user's branch, index and files are untouched.
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

function mergeOverrides(detected: ProjectProfile, stored: ProjectProfile): ProjectProfile {
  const merged = { ...detected, commands: { ...detected.commands }, detection: { ...detected.detection } };
  for (const [field, meta] of Object.entries(stored.detection)) {
    if (!meta.overridden) continue;
    merged.detection[field] = meta;
    if (field.startsWith("commands.")) merged.commands[field.slice("commands.".length)] = meta.value as string;
    else (merged as Record<string, unknown>)[field] = meta.value;
  }
  return merged;
}

function summarizeCodebase(rootPath: string): CodebaseSummary {
  const files = listFiles(rootPath, 4, 600);
  const conventions: Record<string, string> = {};
  for (const doc of ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "CONTRIBUTING.md"]) {
    const path = join(rootPath, doc);
    if (existsSync(path)) conventions[doc] = readFileSync(path, "utf8").slice(0, 4000);
  }
  const pick = (re: RegExp) => files.filter((f) => re.test(f)).slice(0, 40);
  return {
    fileCount: files.length,
    components: pick(/(^|\/)components?\//i),
    routes: pick(/(^|\/)(app|pages|routes)\//),
    apiClients: pick(/(^|\/)(api|services|queries|hooks)\//i),
    tests: pick(/\.(test|spec)\.[jt]sx?$|(^|\/)(e2e|__tests__)\//),
    styles: pick(/\.(css|scss|less)$|tailwind\.config|theme\.|tokens?\./i),
    conventions,
  };
}

function listFiles(root: string, maxDepth: number, limit: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (out.length >= limit) return;
      if (name.startsWith(".") && name !== ".storybook") continue;
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (!SKIP_DIRS.has(name)) walk(full, depth + 1);
      } else {
        out.push(relative(root, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(root, 0);
  return out;
}
