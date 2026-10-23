import type { DetectedValue } from "@frontflow/domain";
import { DepIndex } from "./deps.js";
import type { DepEntry } from "./deps.js";
import { join } from "./project-fs.js";
import type { ProjectFs } from "./project-fs.js";

export interface DetectContext {
  fs: ProjectFs;
  deps: DepIndex;
  /** Directories to look for config files in, most specific first ("" = project root). */
  dirs: string[];
  /** Confidence multiplier (< 1 when the stack comes from a workspace package). */
  scale: number;
}

const CFG = String.raw`\.(?:js|cjs|mjs|ts|cts|mts)$`;
const cfg = (base: string) => new RegExp(`^${base.replace(/\./g, "\\.")}${CFG}`);

export function detected<T>(value: T, confidence: number, evidence: string[]): DetectedValue<T> {
  return { value, confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100, evidence };
}

export function configFiles(ctx: DetectContext, pattern: RegExp): string[] {
  const out = new Set<string>();
  for (const dir of ctx.dirs) for (const f of ctx.fs.filesMatching(dir, pattern)) out.add(f);
  return [...out];
}

function depEvidence(ctx: DetectContext, names: string[]): string[] {
  return names.map((n) => ctx.deps.get(n)).filter((d): d is DepEntry => !!d).map(DepIndex.evidence);
}

// ---------------------------------------------------------------- framework

interface FrameworkRule {
  id: string;
  /** All of these must be present. */
  deps?: string[];
  /** At least one of these must be present (in addition to `deps`). */
  anyDeps?: string[];
  config?: RegExp;
  /** The config file alone is distinctive enough to identify the framework. */
  configAlone?: boolean;
}

const FRAMEWORKS: FrameworkRule[] = [
  { id: "nextjs", anyDeps: ["next"], config: cfg("next.config"), configAlone: true },
  { id: "nuxt", anyDeps: ["nuxt", "nuxt3"], config: cfg("nuxt.config"), configAlone: true },
  { id: "remix", anyDeps: ["@remix-run/react", "@remix-run/dev"], config: cfg("remix.config"), configAlone: true },
  { id: "react-router", anyDeps: ["@react-router/dev"], config: cfg("react-router.config"), configAlone: true },
  { id: "sveltekit", anyDeps: ["@sveltejs/kit"], config: cfg("svelte.config") },
  { id: "angular", anyDeps: ["@angular/core"], config: /^angular\.json$/, configAlone: true },
  { id: "astro", anyDeps: ["astro"], config: cfg("astro.config"), configAlone: true },
  { id: "solid-start", anyDeps: ["@solidjs/start"] },
  { id: "solid", anyDeps: ["solid-js"], config: cfg("vite.config") },
  { id: "cra", anyDeps: ["react-scripts"] },
  { id: "vue-vite", deps: ["vue", "vite"], config: cfg("vite.config") },
  { id: "react-vite", deps: ["react", "vite"], config: cfg("vite.config") },
  { id: "vite", anyDeps: ["vite"], config: cfg("vite.config"), configAlone: true },
  { id: "vue", anyDeps: ["vue"] },
  { id: "react", anyDeps: ["react"] },
];

export function detectFramework(ctx: DetectContext): DetectedValue<string> | undefined {
  for (const rule of FRAMEWORKS) {
    const all = rule.deps ?? [];
    const allOk = all.every((d) => ctx.deps.has(d));
    const anyHits = (rule.anyDeps ?? []).filter((d) => ctx.deps.has(d));
    const depMatch = allOk && (rule.anyDeps ? anyHits.length > 0 : all.length > 0);
    const configs = rule.config ? configFiles(ctx, rule.config) : [];
    if (!depMatch && !(rule.configAlone && configs.length)) continue;
    const evidence = [...depEvidence(ctx, depMatch ? [...all, ...anyHits] : []), ...configs.map((c) => `config file ${c}`)];
    const confidence = depMatch && configs.length ? 0.95 : depMatch ? 0.85 : 0.6;
    return detected(rule.id, confidence * ctx.scale, evidence);
  }
  return undefined;
}

// ---------------------------------------------------------------- language

export function detectLanguage(ctx: DetectContext, hasPackageJson: boolean): DetectedValue<string> | undefined {
  const tsconfigs = configFiles(ctx, /^tsconfig(?:\.[\w-]+)?\.json$/);
  const ts = ctx.deps.get("typescript");
  const evidence = [...tsconfigs.map((f) => `config file ${f}`), ...(ts ? [DepIndex.evidence(ts)] : [])];
  if (tsconfigs.length || ts) return detected("typescript", tsconfigs.length && ts ? 0.95 : 0.85, evidence);
  const jsconfig = configFiles(ctx, /^jsconfig\.json$/);
  if (jsconfig.length || hasPackageJson) {
    return detected("javascript", jsconfig.length ? 0.8 : 0.6, jsconfig.length ? [`config file ${jsconfig[0]}`] : ["no tsconfig.json or typescript dependency"]);
  }
  return undefined;
}

// ---------------------------------------------------------------- dependency catalogues

interface CatalogRule {
  id: string;
  deps?: string[];
  prefixes?: string[];
  files?: RegExp;
}

function matchCatalog(ctx: DetectContext, rules: CatalogRule[]): { id: string; evidence: string[] }[] {
  const out: { id: string; evidence: string[] }[] = [];
  for (const rule of rules) {
    const evidence = [
      ...depEvidence(ctx, rule.deps ?? []),
      ...(rule.prefixes ?? []).flatMap((p) => ctx.deps.withPrefix(p).map(DepIndex.evidence)),
      ...(rule.files ? configFiles(ctx, rule.files).map((f) => `file ${f}`) : []),
    ];
    if (evidence.length) out.push({ id: rule.id, evidence });
  }
  return out;
}

const UI_LIBRARIES: CatalogRule[] = [
  { id: "antd", deps: ["antd", "@ant-design/pro-components"] },
  { id: "mui", deps: ["@mui/material", "@mui/joy", "@material-ui/core"] },
  { id: "chakra-ui", deps: ["@chakra-ui/react"] },
  { id: "shadcn", files: /^components\.json$/ },
  { id: "mantine", deps: ["@mantine/core"] },
  { id: "element-plus", deps: ["element-plus"] },
  { id: "vuetify", deps: ["vuetify"] },
  { id: "quasar", deps: ["quasar"] },
  { id: "primevue", deps: ["primevue"] },
  { id: "angular-material", deps: ["@angular/material"] },
  { id: "bootstrap", deps: ["react-bootstrap", "bootstrap", "bootstrap-vue", "ngx-bootstrap"] },
  { id: "radix-ui", prefixes: ["@radix-ui/"] },
  { id: "headlessui", deps: ["@headlessui/react", "@headlessui/vue"] },
  { id: "tailwindcss", deps: ["tailwindcss"], files: cfg("tailwind.config") },
];

const API_CLIENTS: CatalogRule[] = [
  { id: "tanstack-query", deps: ["@tanstack/react-query", "@tanstack/vue-query", "@tanstack/svelte-query", "@tanstack/solid-query", "react-query"] },
  { id: "swr", deps: ["swr"] },
  { id: "apollo", deps: ["@apollo/client"] },
  { id: "urql", deps: ["urql", "@urql/core"] },
  { id: "openapi-fetch", deps: ["openapi-fetch"] },
  { id: "orval", deps: ["orval"] },
  { id: "ky", deps: ["ky"] },
  { id: "axios", deps: ["axios"] },
  { id: "ofetch", deps: ["ofetch"] },
];

const STATE_MANAGEMENT: CatalogRule[] = [
  { id: "zustand", deps: ["zustand"] },
  { id: "redux-toolkit", deps: ["@reduxjs/toolkit"] },
  { id: "redux", deps: ["redux", "react-redux"] },
  { id: "jotai", deps: ["jotai"] },
  { id: "mobx", deps: ["mobx", "mobx-react-lite", "mobx-react"] },
  { id: "pinia", deps: ["pinia"] },
  { id: "vuex", deps: ["vuex"] },
  { id: "recoil", deps: ["recoil"] },
  { id: "valtio", deps: ["valtio"] },
  { id: "xstate", deps: ["xstate", "@xstate/react"] },
  { id: "ngrx", deps: ["@ngrx/store"] },
];

const TEST_FRAMEWORKS: CatalogRule[] = [
  { id: "vitest", deps: ["vitest"], files: /^vitest\.(?:config|workspace)\.(?:js|cjs|mjs|ts|cts|mts|json)$/ },
  { id: "jest", deps: ["jest", "ts-jest", "@jest/core"], files: /^jest\.config\.(?:js|cjs|mjs|ts|json)$/ },
  { id: "playwright", deps: ["@playwright/test", "playwright"], files: cfg("playwright.config") },
  { id: "cypress", deps: ["cypress"], files: /^cypress\.(?:config\.(?:js|cjs|mjs|ts)|json)$/ },
  { id: "testing-library", prefixes: ["@testing-library/"] },
  { id: "msw", deps: ["msw"] },
  { id: "pact", deps: ["@pact-foundation/pact"] },
  { id: "storybook", deps: ["storybook"], prefixes: ["@storybook/"] },
  { id: "karma", deps: ["karma"] },
  { id: "mocha", deps: ["mocha"] },
];

function first(ctx: DetectContext, rules: CatalogRule[], baseConfidence: number): DetectedValue<string> | undefined {
  const hits = matchCatalog(ctx, rules);
  const top = hits[0];
  if (!top) return undefined;
  const others = hits.slice(1).map((h) => `also present: ${h.id}`);
  return detected(top.id, baseConfidence * ctx.scale, [...top.evidence, ...others]);
}

export function detectUiLibrary(ctx: DetectContext): DetectedValue<string> | undefined {
  const result = first(ctx, UI_LIBRARIES, 0.9);
  if (result?.value === "shadcn") {
    const shadcn = ctx.fs.readJson(configFiles(ctx, /^components\.json$/)[0] ?? "").value as Record<string, unknown> | undefined;
    if (!shadcn || typeof shadcn !== "object" || !("$schema" in shadcn || "style" in shadcn || "aliases" in shadcn)) {
      result.confidence = Math.min(result.confidence, 0.6);
    }
  }
  return result;
}

export function detectApiClient(ctx: DetectContext, srcHasRtkQuery: () => string | undefined): DetectedValue<string> | undefined {
  const hits = matchCatalog(ctx, API_CLIENTS);
  const rtk = ctx.deps.get("@reduxjs/toolkit");
  if (rtk) {
    const file = srcHasRtkQuery();
    if (file) {
      const rtkHit = { id: "rtk-query", evidence: [DepIndex.evidence(rtk), `import of @reduxjs/toolkit/query in ${file}`] };
      const tanstackOrSwr = hits.filter((h) => h.id === "tanstack-query" || h.id === "swr");
      hits.splice(tanstackOrSwr.length, 0, rtkHit);
    }
  }
  const top = hits[0];
  if (!top) return undefined;
  const others = hits.slice(1).map((h) => `also present: ${h.id}`);
  return detected(top.id, (top.id === "rtk-query" ? 0.75 : 0.85) * ctx.scale, [...top.evidence, ...others]);
}

export function detectStateManagement(ctx: DetectContext): DetectedValue<string> | undefined {
  return first(ctx, STATE_MANAGEMENT, 0.85);
}

export function detectTestFrameworks(ctx: DetectContext): DetectedValue<string[]> | undefined {
  const hits = matchCatalog(ctx, TEST_FRAMEWORKS);
  if (ctx.fs.isDir(".storybook") && !hits.some((h) => h.id === "storybook")) hits.push({ id: "storybook", evidence: ["directory .storybook/"] });
  if (!hits.length) return undefined;
  return detected(
    hits.map((h) => h.id),
    0.9 * ctx.scale,
    hits.flatMap((h) => h.evidence),
  );
}

// ---------------------------------------------------------------- structure

function existingDirs(ctx: DetectContext, candidates: string[]): string[] {
  const out = new Set<string>();
  for (const base of ctx.dirs) for (const c of candidates) if (ctx.fs.isDir(join(base, c))) out.add(join(base, c));
  return [...out];
}

const FILE_ROUTED = new Set(["nextjs", "nuxt", "remix", "react-router", "sveltekit", "astro", "solid-start"]);

export function detectRouteStructure(ctx: DetectContext, framework: string | undefined): DetectedValue<string[]> | undefined {
  const dirs = existingDirs(ctx, ["app", "pages", "src/app", "src/pages", "src/routes", "app/routes", "src/router"]);
  if (!dirs.length) return undefined;
  const fileRouted = framework !== undefined && FILE_ROUTED.has(framework);
  return detected(dirs, (fileRouted ? 0.85 : 0.6) * ctx.scale, dirs.map((d) => `directory ${d}/`));
}

export function detectApiClientDirs(ctx: DetectContext): DetectedValue<string[]> | undefined {
  const dirs = existingDirs(ctx, ["src/api", "src/apis", "src/services", "src/lib/api", "lib/api", "src/api-client", "src/http", "src/client", "src/generated", "src/gen"]);
  if (!dirs.length) return undefined;
  return detected(dirs, 0.7 * ctx.scale, dirs.map((d) => `directory ${d}/`));
}

const TOKEN_FILE = /^(?:design-)?tokens\.(?:json|ts|js|css|scss)$|\.tokens\.json$|^theme\.(?:ts|tsx|js|mjs|json|css|scss|less)$|^_?variables\.(?:css|scss|less)$/i;
const STYLE_FILE = /\.(?:css|scss|less)$/i;
const CSS_VARS = /(?::root|\[data-theme[^\]]*\]|\.dark|@theme)\s*[^{]*\{[^}]*--[\w-]+\s*:/;

export function detectDesignTokens(ctx: DetectContext): DetectedValue<string[]> | undefined {
  const found = new Map<string, string>();
  const tokenDirs = ["", "src", "src/styles", "src/theme", "src/tokens", "tokens", "styles", "design-tokens", "app", "src/app", "src/assets", "src/assets/styles"];
  for (const base of ctx.dirs) {
    for (const f of ctx.fs.filesMatching(base, cfg("tailwind.config"))) found.set(f, `tailwind config ${f}`);
    for (const d of tokenDirs) {
      const dir = join(base, d);
      if (d && !ctx.fs.isDir(dir)) continue;
      for (const f of ctx.fs.filesMatching(dir, TOKEN_FILE)) found.set(f, `token/theme file ${f}`);
      if (!d) continue;
      for (const f of ctx.fs.filesMatching(dir, STYLE_FILE)) {
        if (found.has(f)) continue;
        const text = ctx.fs.readText(f, 256 * 1024);
        if (text && CSS_VARS.test(text)) found.set(f, `CSS custom properties in ${f}`);
      }
    }
    for (const d of ["src/theme", "src/tokens", "tokens", "design-tokens"]) {
      const dir = join(base, d);
      if (ctx.fs.isDir(dir) && ![...found.keys()].some((k) => k.startsWith(`${dir}/`))) found.set(`${dir}/`, `directory ${dir}/`);
    }
  }
  if (!found.size) return undefined;
  const files = [...found.keys()].sort();
  return detected(files, 0.75 * ctx.scale, files.map((f) => found.get(f) ?? f));
}

const TEST_CONFIG = new RegExp(
  [
    String.raw`^vitest\.(?:config|workspace)\.(?:js|cjs|mjs|ts|cts|mts|json)$`,
    String.raw`^jest\.(?:config|setup)\.(?:js|cjs|mjs|ts|json)$`,
    String.raw`^playwright\.config\.(?:js|cjs|mjs|ts|cts|mts)$`,
    String.raw`^cypress\.(?:config\.(?:js|cjs|mjs|ts)|json)$`,
    String.raw`^karma\.conf\.(?:js|ts)$`,
    String.raw`^setupTests\.(?:js|ts|jsx|tsx)$`,
    String.raw`^vitest\.setup\.(?:js|ts)$`,
    String.raw`^\.mocharc\.(?:js|cjs|json|ya?ml)$`,
  ].join("|"),
);

export function detectTestConfigs(ctx: DetectContext): DetectedValue<string[]> | undefined {
  const files = new Set<string>();
  for (const base of ctx.dirs) {
    for (const f of ctx.fs.filesMatching(base, TEST_CONFIG)) files.add(f);
    for (const f of ctx.fs.filesMatching(join(base, "src"), /^setupTests\.(?:js|ts|jsx|tsx)$/)) files.add(f);
    if (ctx.fs.isDir(join(base, ".storybook"))) files.add(`${join(base, ".storybook")}/`);
  }
  if (!files.size) return undefined;
  const list = [...files].sort();
  return detected(list, 0.9 * ctx.scale, list.map((f) => `file ${f}`));
}

// ---------------------------------------------------------------- convention docs

const ROOT_DOCS = /^(?:AGENTS\.md|CLAUDE\.md|GEMINI\.md|README(?:\.[\w.-]+)?|CONTRIBUTING(?:\.[\w.-]+)?|CONVENTIONS(?:\.[\w.-]+)?|\.cursorrules|\.windsurfrules)$/i;
const DOCS_DIR_FILES = /(?:convention|guideline|style|architecture|contributing|coding|standard|agents?)[\w.-]*\.(?:md|mdx|txt)$/i;

export function detectConventionDocs(ctx: DetectContext): DetectedValue<string[]> | undefined {
  const files = new Set<string>();
  for (const base of ctx.dirs) {
    for (const f of ctx.fs.filesMatching(base, ROOT_DOCS)) files.add(f);
    if (ctx.fs.isFile(join(base, ".github/copilot-instructions.md"))) files.add(join(base, ".github/copilot-instructions.md"));
    for (const f of ctx.fs.filesMatching(join(base, ".github/instructions"), /\.md$/i)) files.add(f);
    for (const f of ctx.fs.filesMatching(join(base, ".cursor/rules"), /\.(?:mdc?|txt)$/i)) files.add(f);
    for (const f of ctx.fs.filesMatching(join(base, "docs"), DOCS_DIR_FILES)) files.add(f);
    for (const sub of ["docs/conventions", "docs/guidelines", "docs/adr"]) {
      for (const f of ctx.fs.filesMatching(join(base, sub), /\.(?:md|mdx)$/i)) files.add(f);
    }
  }
  if (!files.size) return undefined;
  const list = [...files].sort();
  return detected(list, 1, list.map((f) => `file ${f}`));
}
