import type { DetectedValue, ProjectCommands, QualityGateRequirement } from "@frontflow/domain";
import { detected } from "./detectors.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const LOCKFILES: { file: string; pm: PackageManager }[] = [
  { file: "pnpm-lock.yaml", pm: "pnpm" },
  { file: "yarn.lock", pm: "yarn" },
  { file: "package-lock.json", pm: "npm" },
  { file: "npm-shrinkwrap.json", pm: "npm" },
  { file: "bun.lockb", pm: "bun" },
  { file: "bun.lock", pm: "bun" },
];

export function detectPackageManager(
  exists: (file: string) => boolean,
  packageManagerField: string | undefined,
  hasPackageJson: boolean,
  warnings: string[],
): DetectedValue<PackageManager> | undefined {
  const locks = LOCKFILES.filter((l) => exists(l.file));
  const lockPms = [...new Set(locks.map((l) => l.pm))];
  const fieldPm = /^(npm|pnpm|yarn|bun)@/.exec(packageManagerField ?? "")?.[1] as PackageManager | undefined;
  const evidence = [
    ...(fieldPm ? [`package.json packageManager: ${packageManagerField}`] : []),
    ...locks.map((l) => `lockfile ${l.file}`),
  ];
  if (fieldPm) {
    const agrees = lockPms.length === 0 || (lockPms.length === 1 && lockPms[0] === fieldPm);
    if (!agrees) warnings.push(`packageManager field says ${fieldPm} but lockfiles indicate ${lockPms.join(", ")}`);
    return detected(fieldPm, agrees ? 0.98 : 0.7, evidence);
  }
  if (lockPms.length === 1 && lockPms[0]) return detected(lockPms[0], 0.95, evidence);
  if (lockPms.length > 1) {
    warnings.push(`Multiple lockfiles found (${locks.map((l) => l.file).join(", ")}); package manager is ambiguous`);
    const pick = lockPms[0] as PackageManager;
    return detected(pick, 0.5, evidence);
  }
  if (hasPackageJson) return detected("npm", 0.3, ["no lockfile found; defaulting to npm"]);
  return undefined;
}

// Script names that collide with built-in package-manager commands need an explicit `run`.
const PNPM_BUILTINS = new Set(["install", "i", "add", "remove", "rm", "update", "up", "link", "unlink", "publish", "pack", "outdated", "audit", "init", "store", "list", "ls", "why", "import", "patch", "env", "setup", "deploy", "fetch", "rebuild", "prune", "dedupe", "config", "root", "bin", "exec", "dlx", "create"]);
const YARN_BUILTINS = new Set(["install", "add", "remove", "upgrade", "up", "info", "init", "link", "unlink", "pack", "publish", "version", "why", "config", "cache", "global", "workspace", "workspaces", "dlx", "exec", "bin", "node", "set", "plugin", "constraints", "dedupe", "npm", "outdated", "audit", "licenses", "owner", "team", "login", "logout", "import", "check", "policies", "tag", "generate-lock-entry", "list", "create"]);

export function runScript(pm: PackageManager, script: string): string {
  switch (pm) {
    case "pnpm":
      return PNPM_BUILTINS.has(script) ? `pnpm run ${script}` : `pnpm ${script}`;
    case "yarn":
      return YARN_BUILTINS.has(script) ? `yarn run ${script}` : `yarn ${script}`;
    case "bun":
      return `bun run ${script}`;
    case "npm":
      return `npm run ${script}`;
  }
}

/** Runs a script of one workspace package from the monorepo root. */
export function runWorkspaceScript(pm: PackageManager, pkgName: string, script: string): string {
  switch (pm) {
    case "pnpm":
      return `pnpm --filter ${pkgName} run ${script}`;
    case "yarn":
      return `yarn workspace ${pkgName} run ${script}`;
    case "bun":
      return `bun run --filter ${pkgName} ${script}`;
    case "npm":
      return `npm run ${script} -w ${pkgName}`;
  }
}

const NPM_DEFAULT_TEST = /no test specified/i;

const SCRIPT_CANDIDATES: Record<string, { names: string[]; accept?: (name: string, body: string) => boolean }> = {
  dev: { names: ["dev", "start", "serve", "develop"] },
  build: { names: ["build"] },
  typecheck: {
    names: ["typecheck", "type-check", "check-types", "tsc", "types", "check:types", "types:check", "lint:types", "check"],
    accept: (name, body) => name !== "check" || /\b(?:tsc|vue-tsc|svelte-check|astro check)\b/.test(body),
  },
  lint: { names: ["lint", "lint:all", "eslint"] },
  unitTest: { names: ["test:unit", "unit", "test"], accept: (_n, body) => !NPM_DEFAULT_TEST.test(body) },
  e2e: { names: ["test:e2e", "e2e", "playwright", "test:playwright", "cypress:run", "test:cypress"] },
  contractTest: { names: ["test:contract", "contract", "pact"] },
};

export interface ScriptSource {
  scripts: Record<string, string>;
  /** Workspace package name; undefined for the root package.json. */
  workspacePackage?: string;
  label: string;
}

export function detectCommands(
  pm: DetectedValue<PackageManager> | undefined,
  sources: ScriptSource[],
  options: { typescript: boolean; vueTsc: boolean },
): Record<string, DetectedValue<string>> {
  const out: Record<string, DetectedValue<string>> = {};
  if (!pm) return out;
  const manager = pm.value;
  out.install = detected(`${manager} install`, pm.confidence, [`package manager ${manager}`]);

  for (const [command, spec] of Object.entries(SCRIPT_CANDIDATES)) {
    let found: DetectedValue<string> | undefined;
    for (const source of sources) {
      for (const name of spec.names) {
        const body = source.scripts[name];
        if (body === undefined || (spec.accept && !spec.accept(name, body))) continue;
        const cmd = source.workspacePackage ? runWorkspaceScript(manager, source.workspacePackage, name) : runScript(manager, name);
        const primary = name === spec.names[0];
        found = detected(cmd, (source.workspacePackage ? 0.75 : primary ? 0.95 : 0.85) * Math.max(pm.confidence, 0.6), [
          `${source.label} scripts.${name}: ${body}`,
        ]);
        break;
      }
      if (found) break;
    }
    if (found) out[command] = found;
  }

  if (!out.typecheck && options.typescript) {
    const bin = options.vueTsc ? "vue-tsc" : "tsc";
    out.typecheck = detected(`npx ${bin} --noEmit`, 0.6, ["no typecheck script; TypeScript detected, falling back to compiler check"]);
  }
  return out;
}

const GATED_COMMANDS = ["build", "typecheck", "lint", "unitTest", "contractTest", "e2e"] as const;

export function deriveQualityGates(commands: Record<string, string | undefined>): Record<string, QualityGateRequirement | string> {
  const gates: Record<string, QualityGateRequirement | string> = {};
  for (const name of GATED_COMMANDS) gates[name] = commands[name] ? "required" : "disabled";
  gates.accessibility = "WCAG-2.2-AA";
  return gates;
}

export function commandsRecord(detections: Record<string, DetectedValue<string>>): ProjectCommands {
  const out: ProjectCommands = {};
  for (const [k, v] of Object.entries(detections)) out[k] = v.value;
  return out;
}
