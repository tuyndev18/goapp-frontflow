import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileFormatError, ProjectAccessError, analyzeProject, applyOverrides, profileFromYaml, profileToYaml } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "../../../tests/fixtures/projects");
const fixture = (name: string) => path.join(fixtures, name);

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ff-analyzer-")));
  temps.push(dir);
  return dir;
}
function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("analyzeProject — nextjs-antd-pnpm", () => {
  it("detects the full stack with evidence", async () => {
    const { profile, warnings } = await analyzeProject(fixture("nextjs-antd-pnpm"), { skipGit: true });
    expect(profile).toMatchObject({
      schemaVersion: 1,
      projectId: "web",
      framework: "nextjs",
      language: "typescript",
      packageManager: "pnpm",
      uiLibrary: "antd",
      apiClient: "tanstack-query",
      stateManagement: "zustand",
      git: { defaultBaseBranch: "main" },
    });
    expect(profile.rootPath).not.toContain("\\");
    expect(profile.testFrameworks).toEqual(["vitest", "playwright", "testing-library", "msw"]);
    expect(profile.commands).toEqual({
      install: "pnpm install",
      dev: "pnpm dev",
      build: "pnpm build",
      typecheck: "pnpm typecheck",
      lint: "pnpm lint",
      unitTest: "pnpm test",
      e2e: "pnpm test:e2e",
    });
    expect(profile.qualityGates).toEqual({
      build: "required",
      typecheck: "required",
      lint: "required",
      unitTest: "required",
      contractTest: "disabled",
      e2e: "required",
      accessibility: "WCAG-2.2-AA",
    });
    expect(profile.conventionDocs).toEqual(["AGENTS.md", "README.md"]);

    const d = profile.detection;
    expect(d.framework).toMatchObject({ value: "nextjs", confidence: 0.95 });
    expect(d.framework?.evidence).toEqual(expect.arrayContaining(["package.json dependencies.next@14.2.15", "config file next.config.mjs"]));
    expect(d.packageManager?.evidence).toContain("lockfile pnpm-lock.yaml");
    expect(d.uiLibrary?.evidence).toContain("package.json dependencies.antd@^5.21.0");
    expect(d.apiClient?.evidence).toContain("also present: axios");
    expect(d["commands.typecheck"]).toMatchObject({ value: "pnpm typecheck" });
    expect(d.routeStructure?.value).toEqual(["src/app"]);
    expect(d.apiClientDirs?.value).toEqual(["src/api"]);
    expect(d.designTokens?.value).toEqual(["src/styles/globals.css", "src/theme/tokens.json"]);
    expect(d.testConfigs?.value).toEqual(["playwright.config.mjs", "vitest.config.mjs"]);
    for (const [key, entry] of Object.entries(d)) {
      expect(entry.confidence, key).toBeGreaterThanOrEqual(0);
      expect(entry.confidence, key).toBeLessThanOrEqual(1);
      expect(entry.evidence.length, key).toBeGreaterThan(0);
    }
    expect(warnings.filter((w) => /Could not detect/.test(w))).toEqual([]);
  });

  it("honours an explicit projectId", async () => {
    const { profile } = await analyzeProject(fixture("nextjs-antd-pnpm"), { projectId: "ecommerce-web", skipGit: true });
    expect(profile.projectId).toBe("ecommerce-web");
  });
});

describe("analyzeProject — vite-react-npm", () => {
  it("detects vite + react, npm, rtk-query from source, and a tsc fallback", async () => {
    const { profile } = await analyzeProject(fixture("vite-react-npm"), { skipGit: true });
    expect(profile).toMatchObject({
      framework: "react-vite",
      language: "typescript",
      packageManager: "npm",
      uiLibrary: "mui",
      apiClient: "rtk-query",
      stateManagement: "redux-toolkit",
      testFrameworks: ["jest"],
    });
    expect(profile.commands).toEqual({
      install: "npm install",
      dev: "npm run dev",
      build: "npm run build",
      lint: "npm run lint",
      unitTest: "npm run test",
      typecheck: "npx tsc --noEmit",
    });
    expect(profile.detection["commands.typecheck"]!.confidence).toBeLessThan(profile.detection["commands.build"]!.confidence);
    expect(profile.detection.apiClient?.evidence).toContain("import of @reduxjs/toolkit/query in src/store/api.js");
    expect(profile.qualityGates.e2e).toBe("disabled");
    expect(profile.conventionDocs).toEqual(["CONTRIBUTING.md", "docs/coding-conventions.md"]);
    expect(profile.detection.designTokens?.value).toEqual(["tailwind.config.js"]);
    expect(profile.detection.apiClientDirs?.value).toEqual(["src/services"]);
    expect(profile.detection.routeStructure).toBeUndefined();
  });
});

describe("analyzeProject — plain-js", () => {
  it("falls back gracefully with low confidence", async () => {
    const { profile, warnings } = await analyzeProject(fixture("plain-js"), { skipGit: true });
    expect(profile.framework).toBeUndefined();
    expect(profile.language).toBe("javascript");
    expect(profile.packageManager).toBe("npm");
    expect(profile.detection.packageManager!.confidence).toBeLessThan(0.5);
    expect(profile.commands).toEqual({ install: "npm install", dev: "npm run start" });
    expect(profile.qualityGates).toMatchObject({ build: "disabled", unitTest: "disabled", accessibility: "WCAG-2.2-AA" });
    expect(profile.testFrameworks).toEqual([]);
    expect(warnings).toContain("Could not detect framework.");
  });
});

describe("analyzeProject — access & git", () => {
  it("throws typed errors for missing paths and files", async () => {
    const dir = tempDir();
    await expect(analyzeProject(path.join(dir, "missing"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    write(path.join(dir, "file.txt"), "x");
    const err = await analyzeProject(path.join(dir, "file.txt")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectAccessError);
    expect(err).toMatchObject({ code: "NOT_DIRECTORY" });
  });

  it("tolerates non-git folders and invalid package.json", async () => {
    const dir = tempDir();
    write(path.join(dir, "package.json"), "{ not json");
    const { profile, warnings } = await analyzeProject(dir);
    expect(profile.git.defaultBaseBranch).toBe("main");
    expect(profile.detection["git.defaultBaseBranch"]!.confidence).toBeLessThan(0.5);
    expect(warnings.some((w) => /not valid JSON/.test(w))).toBe(true);
  });

  it("detects the default base branch from git", async () => {
    const dir = tempDir();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, windowsHide: true });
    git("init", "-q", "-b", "master");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    write(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
    const { profile } = await analyzeProject(dir);
    expect(profile.git.defaultBaseBranch).toBe("master");
    expect(profile.detection["git.defaultBaseBranch"]).toMatchObject({ confidence: 0.8, evidence: ["local branch master exists"] });
  });
});

describe("analyzeProject — monorepo", () => {
  it("notes workspaces and detects the stack from the app package", async () => {
    const dir = tempDir();
    write(path.join(dir, "package.json"), JSON.stringify({ name: "mono", private: true, scripts: { build: "turbo build" } }));
    write(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
    write(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    write(path.join(dir, "turbo.json"), "{}");
    write(path.join(dir, "packages", "ui", "package.json"), JSON.stringify({ name: "@mono/ui", dependencies: { react: "18" } }));
    write(
      path.join(dir, "apps", "web", "package.json"),
      JSON.stringify({ name: "@mono/web", scripts: { dev: "nuxt dev", lint: "eslint ." }, dependencies: { nuxt: "^3.13.0", pinia: "^2.2.0" } }),
    );
    write(path.join(dir, "apps", "web", "nuxt.config.ts"), "export default {}\n");
    const { profile, warnings } = await analyzeProject(dir, { skipGit: true });
    expect(profile.detection.monorepo?.value).toEqual({ tool: "pnpm-workspaces+turborepo", packages: ["apps/web", "packages/ui"] });
    expect(profile.framework).toBe("nuxt");
    expect(profile.detection.framework!.confidence).toBeLessThan(0.95);
    expect(profile.stateManagement).toBe("pinia");
    expect(profile.commands).toMatchObject({ build: "pnpm build", dev: "pnpm --filter @mono/web run dev", lint: "pnpm --filter @mono/web run lint" });
    expect(warnings.some((w) => w.includes("apps/web"))).toBe(true);
  });
});

describe("overrides and YAML", () => {
  it("applies overrides immutably and marks them", async () => {
    const { profile } = await analyzeProject(fixture("vite-react-npm"), { skipGit: true });
    const next = applyOverrides(profile, {
      uiLibrary: "tailwindcss",
      apiClient: null,
      commands: { typecheck: "npm run check", e2e: "npx playwright test" },
      qualityGates: { e2e: "required" },
      git: { defaultBaseBranch: "develop" },
    });
    expect(profile.uiLibrary).toBe("mui");
    expect(profile.commands.e2e).toBeUndefined();
    expect(next.uiLibrary).toBe("tailwindcss");
    expect(next.apiClient).toBeUndefined();
    expect(next.commands).toMatchObject({ typecheck: "npm run check", e2e: "npx playwright test" });
    expect(next.git.defaultBaseBranch).toBe("develop");
    expect(next.detection.uiLibrary).toEqual({ value: "tailwindcss", confidence: 1, evidence: ["user override"], overridden: true });
    expect(next.detection["commands.e2e"]).toMatchObject({ overridden: true, confidence: 1 });
    expect(next.detection["git.defaultBaseBranch"]).toMatchObject({ value: "develop", overridden: true });
    expect(next.detection["qualityGates.e2e"]).toMatchObject({ value: "required", overridden: true });
  });

  it("round-trips through YAML in the §10.2 layout", async () => {
    const { profile } = await analyzeProject(fixture("nextjs-antd-pnpm"), { projectId: "ecommerce-web", skipGit: true });
    const overridden = applyOverrides(profile, { framework: "nextjs-app-router" });
    const text = profileToYaml(overridden);
    expect(text.startsWith("schemaVersion: 1\nprojectId: ecommerce-web\n")).toBe(true);
    expect(text).toContain("framework: nextjs-app-router");
    expect(text).toContain("  install: pnpm install");
    expect(text).toContain("  accessibility: WCAG-2.2-AA");
    expect(text).not.toContain("executionMode");
    expect(profileFromYaml(text)).toEqual(overridden);

    const slim = profileToYaml(overridden, { includeDetection: false });
    expect(slim).not.toContain("detection:");
    expect(profileFromYaml(slim).detection).toEqual({});
  });

  it("parses the spec example and rejects malformed profiles", () => {
    const spec = [
      "schemaVersion: 1",
      "projectId: ecommerce-web",
      "rootPath: D:/projects/ecommerce-web",
      "framework: nextjs",
      "commands:",
      "  install: pnpm install",
      "qualityGates:",
      "  build: required",
      "  accessibility: WCAG-2.2-AA",
      "git:",
      "  executionMode: worktree", // legacy key, ignored
      "  defaultBaseBranch: main",
    ].join("\n");
    const p = profileFromYaml(spec);
    expect(p).toMatchObject({ projectId: "ecommerce-web", framework: "nextjs", testFrameworks: [], conventionDocs: [], detection: {} });

    expect(() => profileFromYaml("schemaVersion: 2\nprojectId: x\nrootPath: /x\n")).toThrow(ProfileFormatError);
    expect(() => profileFromYaml("schemaVersion: 1\nrootPath: /x\n")).toThrow(/projectId/);
    expect(() => profileFromYaml("schemaVersion: 1\nprojectId: x\nrootPath: /x\ndetection:\n  a: { value: 1, confidence: 3 }\n")).toThrow(/confidence/);
    expect(() => profileFromYaml("- just\n- a list\n")).toThrow(ProfileFormatError);
  });
});
