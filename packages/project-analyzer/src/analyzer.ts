import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { DetectedValue, ProjectProfile } from "@frontflow/domain";
import { commandsRecord, deriveQualityGates, detectCommands, detectPackageManager } from "./commands.js";
import type { ScriptSource } from "./commands.js";
import { DepIndex, normalizePackageJson } from "./deps.js";
import type { PackageJson } from "./deps.js";
import {
  detectApiClient,
  detectApiClientDirs,
  detectConventionDocs,
  detectDesignTokens,
  detectFramework,
  detectLanguage,
  detectRouteStructure,
  detectStateManagement,
  detectTestConfigs,
  detectTestFrameworks,
  detectUiLibrary,
  detected,
} from "./detectors.js";
import type { DetectContext } from "./detectors.js";
import { detectGit } from "./git.js";
import { ProjectFs, join } from "./project-fs.js";

export type ProjectAccessErrorCode = "NOT_FOUND" | "NOT_DIRECTORY" | "NOT_READABLE" | "INVALID_PATH";

export class ProjectAccessError extends Error {
  override readonly name = "ProjectAccessError";
  constructor(
    readonly code: ProjectAccessErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AnalyzeOptions {
  projectId?: string;
  gitBinary?: string;
  /** Skip git detection entirely (defaultBaseBranch falls back to "main"). */
  skipGit?: boolean;
}

export interface AnalyzeResult {
  profile: ProjectProfile;
  warnings: string[];
}

interface WorkspacePackage {
  dir: string;
  pkg: PackageJson;
}

const MAX_WORKSPACE_PACKAGES = 100;

function validateAccess(rootPath: string): string {
  if (typeof rootPath !== "string" || rootPath.trim() === "" || rootPath.includes("\0")) {
    throw new ProjectAccessError("INVALID_PATH", String(rootPath), "project path is empty or invalid");
  }
  const resolved = path.resolve(rootPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new ProjectAccessError("NOT_READABLE", resolved, `project folder is not accessible: ${resolved}`);
    throw new ProjectAccessError("NOT_FOUND", resolved, `project folder does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new ProjectAccessError("NOT_DIRECTORY", resolved, `project path is not a directory: ${resolved}`);
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
    fs.readdirSync(resolved);
  } catch {
    throw new ProjectAccessError("NOT_READABLE", resolved, `project folder is not readable: ${resolved}`);
  }
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function expandWorkspaces(pfs: ProjectFs, patterns: string[]): WorkspacePackage[] {
  const dirs = new Set<string>();
  for (const raw of patterns) {
    if (raw.startsWith("!")) continue;
    const pattern = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (pattern.includes("..")) continue;
    const star = /^(.*?)\/?\*\*?$/.exec(pattern);
    if (star) {
      const base = star[1] ?? "";
      for (const d of pfs.subdirs(base)) dirs.add(d);
    } else if (!pattern.includes("*")) {
      dirs.add(pattern);
    }
  }
  const out: WorkspacePackage[] = [];
  for (const dir of [...dirs].sort()) {
    if (out.length >= MAX_WORKSPACE_PACKAGES) break;
    const pkg = normalizePackageJson(pfs.readJson(join(dir, "package.json")).value);
    if (pkg) out.push({ dir, pkg });
  }
  // Applications are the likeliest workflow target.
  return out.sort((a, b) => Number(!/^apps?\//.test(a.dir)) - Number(!/^apps?\//.test(b.dir)) || a.dir.localeCompare(b.dir));
}

function detectMonorepo(pfs: ProjectFs, rootPkg: PackageJson | undefined, warnings: string[]): { detection?: DetectedValue<unknown>; packages: WorkspacePackage[] } {
  const evidence: string[] = [];
  const patterns: string[] = [];
  let tool: string | undefined;
  if (rootPkg?.workspaces?.length) {
    patterns.push(...rootPkg.workspaces);
    evidence.push(`package.json workspaces: ${rootPkg.workspaces.join(", ")}`);
    tool = "workspaces";
  }
  const pnpmWs = pfs.readText("pnpm-workspace.yaml");
  if (pnpmWs !== undefined) {
    try {
      const doc = parseYaml(pnpmWs) as { packages?: unknown } | null;
      const pkgs = Array.isArray(doc?.packages) ? doc.packages.filter((p): p is string => typeof p === "string") : [];
      patterns.push(...pkgs);
      evidence.push(`pnpm-workspace.yaml packages: ${pkgs.join(", ")}`);
      tool = "pnpm-workspaces";
    } catch {
      warnings.push("pnpm-workspace.yaml could not be parsed");
    }
  }
  for (const [file, name] of [["turbo.json", "turborepo"], ["nx.json", "nx"], ["lerna.json", "lerna"], ["rush.json", "rush"]] as const) {
    if (pfs.isFile(file)) {
      evidence.push(`file ${file}`);
      tool = tool ? `${tool}+${name}` : name;
    }
  }
  if (!tool) return { packages: [] };
  const packages = expandWorkspaces(pfs, patterns);
  return {
    detection: detected({ tool, packages: packages.map((p) => p.dir) }, 0.9, evidence),
    packages,
  };
}

const RTK_QUERY = /["']@reduxjs\/toolkit\/query(?:\/react)?["']/;

export async function analyzeProject(rootPath: string, options: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const root = validateAccess(rootPath);
  const pfs = new ProjectFs(root);
  const warnings: string[] = [];
  const detection: Record<string, DetectedValue<unknown>> = {};

  const pkgJson = pfs.readJson("package.json");
  if (pkgJson.error) warnings.push(pkgJson.error);
  const rootPkg = normalizePackageJson(pkgJson.value);
  if (!rootPkg) warnings.push("No readable package.json at the project root; stack detection is limited.");

  const monorepo = detectMonorepo(pfs, rootPkg, warnings);
  if (monorepo.detection) detection.monorepo = monorepo.detection;

  const rootDeps = new DepIndex();
  if (rootPkg) rootDeps.add(rootPkg, "package.json");
  let ctx: DetectContext = { fs: pfs, deps: rootDeps, dirs: [""], scale: 1 };
  let framework = detectFramework(ctx);
  let targetPackage: WorkspacePackage | undefined;

  if (!framework && monorepo.packages.length) {
    for (const wp of monorepo.packages) {
      const deps = new DepIndex().add(wp.pkg, `${wp.dir}/package.json`);
      if (rootPkg) deps.add(rootPkg, "package.json");
      const candidate: DetectContext = { fs: pfs, deps, dirs: [wp.dir, ""], scale: 0.8 };
      const fw = detectFramework(candidate);
      if (fw) {
        ctx = candidate;
        framework = fw;
        targetPackage = wp;
        break;
      }
    }
    if (targetPackage) {
      warnings.push(
        `Monorepo: stack detected from workspace package ${targetPackage.dir} (${targetPackage.pkg.name ?? "unnamed"}); override the profile if another package is the target.`,
      );
    } else {
      warnings.push("Monorepo detected but no workspace package exposes a known frontend framework.");
    }
  }

  const set = (key: string, value: DetectedValue<unknown> | undefined) => {
    if (value) detection[key] = value;
  };

  set("framework", framework);
  const language = detectLanguage(ctx, Boolean(rootPkg));
  set("language", language);

  const packageManager = detectPackageManager((f) => pfs.isFile(f), rootPkg?.packageManager, Boolean(rootPkg || targetPackage), warnings);
  set("packageManager", packageManager);

  set("uiLibrary", detectUiLibrary(ctx));
  set(
    "apiClient",
    detectApiClient(ctx, () => {
      for (const base of ctx.dirs) {
        const files = pfs.walk(join(base, "src"), { maxFiles: 400, maxDepth: 8, include: /\.(?:[cm]?[jt]sx?)$/ });
        const hit = files.find((f) => RTK_QUERY.test(pfs.readText(f, 200 * 1024) ?? ""));
        if (hit) return hit;
      }
      return undefined;
    }),
  );
  set("stateManagement", detectStateManagement(ctx));
  const testFrameworks = detectTestFrameworks(ctx);
  set("testFrameworks", testFrameworks);

  const scriptSources: ScriptSource[] = [];
  if (targetPackage) {
    scriptSources.push({ scripts: rootPkg?.scripts ?? {}, label: "package.json" });
    const name = targetPackage.pkg.name;
    if (name) scriptSources.push({ scripts: targetPackage.pkg.scripts, workspacePackage: name, label: `${targetPackage.dir}/package.json` });
  } else if (rootPkg) {
    scriptSources.push({ scripts: rootPkg.scripts, label: "package.json" });
  }
  const commandDetections = detectCommands(packageManager, scriptSources, {
    typescript: language?.value === "typescript",
    vueTsc: ctx.deps.has("vue-tsc"),
  });
  for (const [name, value] of Object.entries(commandDetections)) detection[`commands.${name}`] = value;
  const commands = commandsRecord(commandDetections);

  const qualityGates = deriveQualityGates(commands);
  detection.qualityGates = detected(qualityGates, 0.7, ["required when a matching command was detected, otherwise disabled"]);

  set("routeStructure", detectRouteStructure(ctx, framework?.value));
  set("apiClientDirs", detectApiClientDirs(ctx));
  set("designTokens", detectDesignTokens(ctx));
  set("testConfigs", detectTestConfigs(ctx));
  const conventionDocs = detectConventionDocs({ ...ctx, dirs: targetPackage ? ["", targetPackage.dir] : [""] });
  set("conventionDocs", conventionDocs);

  const gitInfo = options.skipGit
    ? { isRepo: false, defaultBaseBranch: detected("main", 0.2, ["git detection skipped; assuming main"]) }
    : await detectGit(root, options.gitBinary);
  detection["git.defaultBaseBranch"] = gitInfo.defaultBaseBranch;
  if (!gitInfo.isRepo && !options.skipGit) warnings.push("Project is not a git repository: checkpoints and rollback will be unavailable.");

  for (const field of ["framework", "language", "uiLibrary", "apiClient", "stateManagement"] as const) {
    if (!detection[field]) warnings.push(`Could not detect ${field}.`);
  }

  const profile: ProjectProfile = {
    schemaVersion: 1,
    projectId: options.projectId ?? slugify(rootPkg?.name ?? path.basename(root)),
    rootPath: root.replace(/\\/g, "/"),
    testFrameworks: testFrameworks?.value ?? [],
    commands,
    qualityGates,
    git: { defaultBaseBranch: gitInfo.defaultBaseBranch.value },
    conventionDocs: conventionDocs?.value ?? [],
    detection,
  };
  if (framework) profile.framework = framework.value;
  if (language) profile.language = language.value;
  if (packageManager) profile.packageManager = packageManager.value;
  for (const field of ["uiLibrary", "apiClient", "stateManagement"] as const) {
    const d = detection[field];
    if (d && typeof d.value === "string") profile[field] = d.value;
  }
  return { profile, warnings };
}

export function slugify(name: string): string {
  const slug = name
    .replace(/^@[^/]+\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}
