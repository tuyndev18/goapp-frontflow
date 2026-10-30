import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@frontflow/domain";
import { WORKFLOW_ID_PATTERN } from "@frontflow/workflow-engine";
import { currentStepId, currentStepKey, MOVED_STEPS, stepKey } from "./skills.js";

/**
 * Every AI step is just a prompt the user can read and edit, per workflow step. The shipped
 * defaults of the built-in workflows live next to their YAML (`workflows/prompts/<workflow>/<step
 * id>.md`); a user's edit is stored in its own folder with the same layout and wins until it is
 * reset. Steps of the user's own workflows only have that stored prompt. `_system.md` (no
 * workflow) is the system prompt every AI step runs with. Templates use `{{name}}` placeholders
 * that the step fills in when it runs. On top of a step's prompt, each project can add its own
 * instructions, and each feature (run) its own after those ({@link ProjectPromptStore}).
 */
export interface PromptTemplate {
  /** Undefined for the system prompt. */
  workflowId?: string;
  name: string;
  text: string;
  /** The user changed it; `defaultText` is the shipped version. */
  customized: boolean;
  defaultText: string;
}

/** An instruction a project or a feature adds after a step's prompt. */
export interface PromptAddition {
  id: string;
  title: string;
  text: string;
  /** Disabled additions are kept but not sent. */
  enabled: boolean;
}

/** What node handlers need: the current template of a step, and what the project and the feature add to it. */
export interface PromptSource {
  get(name: string, workflowId?: string): PromptTemplate;
  additions?(projectId: string, workflowId: string, nodeId: string): PromptAddition[];
  featureAdditions?(runId: string, workflowId: string, nodeId: string): PromptAddition[];
}

export const SYSTEM_PROMPT_NAME = "_system";
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

export class PromptError extends Error {
  override readonly name = "PromptError";
  constructor(
    readonly code: "INVALID_NAME" | "PROMPT_NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

export class PromptLibrary implements PromptSource {
  constructor(private readonly options: { defaultsDir: string; userDir: string }) {}

  /** Names of the step prompts shipped with a built-in workflow. */
  list(workflowId: string): string[] {
    const dir = join(this.options.defaultsDir, checkWorkflow(workflowId));
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
  }

  /** The prompt of a workflow step, or the system prompt when `workflowId` is undefined. */
  get(name: string, workflowId?: string): PromptTemplate {
    const found = this.find(name, workflowId);
    if (!found) throw new PromptError("PROMPT_NOT_FOUND", `No prompt named ${name}${workflowId ? ` in ${workflowId}` : ""}`);
    return found;
  }

  /** Undefined when the step has no prompt yet. */
  find(name: string, workflowId?: string): PromptTemplate | undefined {
    const [defaultPath, userPath] = this.paths(name, workflowId);
    const defaultText = read(defaultPath);
    const custom = read(userPath);
    if (defaultText === undefined && custom === undefined) return undefined;
    return { ...(workflowId ? { workflowId } : {}), name, text: custom ?? defaultText ?? "", customized: custom !== undefined, defaultText: defaultText ?? "" };
  }

  save(name: string, workflowId: string | undefined, text: string): PromptTemplate {
    const [, userPath] = this.paths(name, workflowId);
    mkdirSync(join(userPath, ".."), { recursive: true });
    writeFileSync(userPath, text.endsWith("\n") ? text : `${text}\n`);
    return this.get(name, workflowId);
  }

  /** Drops the user's edit; the shipped default applies again. */
  reset(name: string, workflowId?: string): PromptTemplate {
    const [, userPath] = this.paths(name, workflowId);
    rmSync(userPath, { force: true });
    return this.get(name, workflowId);
  }

  /** A cloned workflow starts with the prompts its steps had in the workflow it was cloned from. */
  copyWorkflow(fromId: string, toId: string, nodeIds: string[]): void {
    for (const nodeId of nodeIds) {
      const prompt = this.find(nodeId, fromId);
      if (prompt) this.save(nodeId, toId, prompt.text);
    }
  }

  /** Drops the stored prompts of a deleted workflow. */
  forgetWorkflow(workflowId: string): void {
    rmSync(join(this.options.userDir, checkWorkflow(workflowId)), { recursive: true, force: true });
  }

  /**
   * Edits saved before workflows could be chosen sit directly in the user folder, named after a
   * step of the one workflow there was; they move into that workflow's folder. Edits of a moved
   * step ({@link MOVED_STEPS}) take its new id in every workflow.
   */
  migrateLegacyEdits(workflowId: string): void {
    const dir = this.options.userDir;
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      const name = file.endsWith(".md") ? file.slice(0, -3) : "";
      if (!name || name === SYSTEM_PROMPT_NAME || !NAME.test(name) || !statSync(join(dir, file)).isFile()) continue;
      const target = join(dir, checkWorkflow(workflowId), file);
      mkdirSync(join(target, ".."), { recursive: true });
      if (existsSync(target)) rmSync(join(dir, file));
      else renameSync(join(dir, file), target);
    }
    for (const wf of readdirSync(dir)) {
      if (!WORKFLOW_ID_PATTERN.test(wf) || !statSync(join(dir, wf)).isDirectory()) continue;
      for (const [from, to] of Object.entries(MOVED_STEPS)) {
        const source = join(dir, wf, `${from}.md`);
        if (existsSync(source) && !existsSync(join(dir, wf, `${to}.md`))) renameSync(source, join(dir, wf, `${to}.md`));
      }
    }
  }

  private paths(name: string, workflowId: string | undefined): [string, string] {
    checkName(name);
    if (workflowId === undefined) {
      if (name !== SYSTEM_PROMPT_NAME) throw new PromptError("INVALID_NAME", `${name} is a workflow step: say which workflow`);
      return [join(this.options.defaultsDir, `${name}.md`), join(this.options.userDir, `${name}.md`)];
    }
    const wf = checkWorkflow(workflowId);
    const step = currentStepId(name);
    return [join(this.options.defaultsDir, wf, `${step}.md`), join(this.options.userDir, wf, `${step}.md`)];
  }
}

const MAX_ADDITIONS = 20;

/**
 * Additions to step prompts, in one JSON file per owner (`{ steps: { "<workflow>/<step>":
 * PromptAddition[] } }`): a project, whose additions are sent in all its features, or one feature
 * (run), whose additions follow the project's. They are appended after the step's prompt, in order.
 */
export class ProjectPromptStore {
  constructor(private readonly fileOf: (ownerId: string) => string) {}

  list(ownerId: string, workflowId: string, nodeId: string): PromptAddition[] {
    return this.all(ownerId)[stepKey(workflowId, nodeId)] ?? [];
  }

  /** stepKey → additions, for every step this owner changes. */
  all(ownerId: string): Record<string, PromptAddition[]> {
    const file = this.fileOf(ownerId);
    if (!existsSync(file)) return {};
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { steps?: unknown };
      const steps = raw.steps && typeof raw.steps === "object" ? (raw.steps as Record<string, unknown>) : {};
      const out: Record<string, PromptAddition[]> = {};
      for (const [key, list] of Object.entries(steps)) {
        if (!Array.isArray(list)) continue;
        const additions = list.flatMap((a): PromptAddition[] => {
          if (!a || typeof a !== "object") return [];
          const { id, title, text, enabled } = a as Record<string, unknown>;
          return typeof id === "string" && typeof text === "string"
            ? [{ id, title: typeof title === "string" ? title : "", text, enabled: enabled !== false }]
            : [];
        });
        if (additions.length) out[currentStepKey(key)] = [...(out[currentStepKey(key)] ?? []), ...additions];
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Replaces a step's additions (their order is the order they are sent in); new ones get an id. */
  set(ownerId: string, workflowId: string, nodeId: string, additions: Array<Omit<PromptAddition, "id"> & { id?: string }>): PromptAddition[] {
    checkWorkflow(workflowId);
    checkName(nodeId);
    const list = additions.slice(0, MAX_ADDITIONS).map((a) => ({ id: a.id || newId("pa"), title: a.title.trim(), text: a.text.trim(), enabled: a.enabled }));
    const all = this.all(ownerId);
    const key = stepKey(workflowId, nodeId);
    if (list.length) all[key] = list;
    else delete all[key];
    const file = this.fileOf(ownerId);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ steps: all }, null, 2));
    return list;
  }
}

/**
 * The enabled additions as the prompt sections that follow a step's own prompt: the project's,
 * then the feature's, so the feature's instructions come last and win where they differ.
 */
export function additionsPrompt(additions: PromptAddition[], featureAdditions: PromptAddition[] = []): string {
  const section = (heading: string, list: PromptAddition[]) => {
    const used = list.filter((a) => a.enabled && a.text.trim());
    return used.length ? [heading, ...used.map((a) => (a.title ? `### ${a.title}\n${a.text.trim()}` : a.text.trim()))].join("\n\n") : "";
  };
  return [section("## Chỉ dẫn bổ sung của project", additions), section("## Chỉ dẫn bổ sung của tính năng này", featureAdditions)].filter(Boolean).join("\n\n");
}

function read(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function checkName(name: string): string {
  if (!NAME.test(name) || name.includes("..")) throw new PromptError("INVALID_NAME", `Invalid prompt name: ${name}`);
  return name;
}

function checkWorkflow(workflowId: string): string {
  if (!WORKFLOW_ID_PATTERN.test(workflowId)) throw new PromptError("INVALID_NAME", `Invalid workflow id: ${workflowId}`);
  return workflowId;
}

/** Fills `{{name}}` placeholders; unknown ones are left empty and reported. */
export function renderPrompt(template: string, vars: Record<string, string>): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_m, key: string) => {
    if (key in vars) return vars[key] ?? "";
    missing.add(key);
    return "";
  });
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), missing: [...missing] };
}

/** Placeholders a template uses, in order of first appearance. */
export function promptPlaceholders(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]!))];
}
