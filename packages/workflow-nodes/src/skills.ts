import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { FEATURE_DELIVERY_WORKFLOW_ID } from "@frontflow/workflow-engine";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Skills in the format Claude Code and Codex use: one folder per skill holding a SKILL.md
 * (YAML frontmatter with `name` and `description`, then Markdown instructions) and any files
 * the instructions refer to by relative path (templates, scripts, references).
 *
 * The library lives in one folder of the app data directory; which skills apply to which
 * workflow step is kept next to it in assignments.json, keyed by {@link stepKey}. Agent steps
 * get the skills of their step through {@link SkillSource}.
 */

export const SKILL_FILE = "SKILL.md";
/** Same rule as Claude Code skill names: lowercase letters, digits and hyphens. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ASSIGNMENTS_FILE = "assignments.json";
/** AI steps of earlier workflow versions → the current steps that do the same work. */
const RENAMED_STEPS: Record<string, string> = {
  // v2 (BA ↔ API alignment)
  "B2.business_ui": "B2.ui_states",
  "C.api_integration": "B2.api_binding",
  "C.bind_ui_states": "B2.ui_states",
  // v3 (readiness before UI)
  "B.implement_ui": "B1.implement_ui",
  "B.api_binding": "B2.api_binding",
  "B.ui_states": "B2.ui_states",
};
const IGNORED_DIRS = new Set([".git", "node_modules"]);
const MAX_SKILL_FILES = 200;
const MAX_DESCRIPTION = 1024;

export interface SkillSummary {
  name: string;
  description: string;
  /** Files of the skill folder other than SKILL.md, relative and with forward slashes. */
  files: string[];
  updatedAt: string;
}

export interface Skill extends SkillSummary {
  /** SKILL.md without its frontmatter. */
  body: string;
  /** Absolute path of the skill folder. */
  dir: string;
}

export interface SkillInput {
  name: string;
  description: string;
  body: string;
}

/** {@link stepKey} → skill names, in the order the user attached them. */
export type SkillAssignments = Record<string, string[]>;

/** A step of one workflow: node ids are only unique within their workflow. */
export function stepKey(workflowId: string, nodeId: string): string {
  return `${workflowId}/${nodeId}`;
}

export interface SkillImportResult {
  imported: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/** What agent steps need from the host: the skills attached to a workflow step. */
export interface SkillSource {
  forNode(workflowId: string, nodeId: string): Skill[] | Promise<Skill[]>;
}

export class SkillError extends Error {
  constructor(
    readonly code: "INVALID_SKILL" | "SKILL_EXISTS" | "SKILL_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "SkillError";
  }
}

/** Splits SKILL.md into its frontmatter and Markdown body. A file without frontmatter is all body. */
export function parseSkillMarkdown(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { frontmatter: {}, body: normalized };
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1] ?? "");
  } catch {
    frontmatter = undefined;
  }
  return {
    frontmatter: frontmatter && typeof frontmatter === "object" && !Array.isArray(frontmatter) ? (frontmatter as Record<string, unknown>) : {},
    body: normalized.slice(match[0].length).replace(/^\n+/, ""),
  };
}

export function formatSkillMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.replace(/\r\n/g, "\n").trim()}\n`;
}

/** Turns a folder or file name into a valid skill name ("Design Skills/Claude" → "design-skills-claude"). */
export function toSkillName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

/** First prose line of a body, for skills whose SKILL.md has no description. */
function describeFromBody(body: string): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !l.startsWith("```") && !l.startsWith("|") && !l.startsWith("---"));
  return (line ?? "").replace(/[*_`]/g, "").slice(0, 200);
}

export class SkillLibrary implements SkillSource {
  constructor(readonly root: string) {}

  list(): SkillSummary[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && SKILL_NAME_PATTERN.test(d.name) && existsSync(join(this.root, d.name, SKILL_FILE)))
      .map((d) => this.read(d.name))
      .map(({ body: _body, dir: _dir, ...summary }) => summary)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Skill | undefined {
    if (!SKILL_NAME_PATTERN.test(name) || !existsSync(join(this.root, name, SKILL_FILE))) return undefined;
    return this.read(name);
  }

  /**
   * Creates a skill, or updates `previousName` (renaming its folder and its step assignments when
   * the name changes). Frontmatter keys other than name/description are kept.
   */
  save(input: SkillInput, previousName?: string): Skill {
    const name = input.name.trim();
    const description = input.description.trim().replace(/\s*\n\s*/g, " ");
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new SkillError("INVALID_SKILL", "Skill names use lowercase letters, digits and hyphens (max 64), e.g. react-page-generator");
    }
    if (!description) throw new SkillError("INVALID_SKILL", "Describe what the skill does and when it applies");
    if (description.length > MAX_DESCRIPTION) throw new SkillError("INVALID_SKILL", `The description is longer than ${MAX_DESCRIPTION} characters`);
    if (!input.body.trim()) throw new SkillError("INVALID_SKILL", "The skill has no instructions");

    const existing = previousName ? this.get(previousName) : undefined;
    if (previousName && !existing) throw new SkillError("SKILL_NOT_FOUND", `Unknown skill ${previousName}`);
    const target = join(this.root, name);
    if (name !== previousName && existsSync(target)) throw new SkillError("SKILL_EXISTS", `A skill named ${name} already exists`);

    mkdirSync(this.root, { recursive: true });
    if (existing && name !== previousName) {
      renameSync(existing.dir, target);
      this.renameAssignments(previousName!, name);
    }
    mkdirSync(target, { recursive: true });
    const file = join(target, SKILL_FILE);
    const { frontmatter } = existsSync(file) ? parseSkillMarkdown(readFileSync(file, "utf8")) : { frontmatter: {} };
    writeFileSync(file, formatSkillMarkdown({ ...frontmatter, name, description }, input.body));
    return this.read(name);
  }

  /** Deletes the skill folder and detaches the skill from every step. */
  remove(name: string): void {
    if (!this.get(name)) throw new SkillError("SKILL_NOT_FOUND", `Unknown skill ${name}`);
    rmSync(join(this.root, name), { recursive: true, force: true });
    const assignments = this.assignments();
    for (const nodeId of Object.keys(assignments)) assignments[nodeId] = assignments[nodeId]!.filter((n) => n !== name);
    this.writeAssignments(assignments);
  }

  /**
   * Copies skill folders into the library: `source` is one skill folder (has SKILL.md) or a folder
   * of skills such as ~/.claude/skills, searched a few levels deep. Existing names are skipped.
   */
  importFrom(source: string): SkillImportResult {
    const result: SkillImportResult = { imported: [], skipped: [] };
    for (const dir of findSkillDirs(source)) {
      const { frontmatter, body } = parseSkillMarkdown(readFileSync(join(dir, SKILL_FILE), "utf8"));
      const declared = typeof frontmatter["name"] === "string" ? frontmatter["name"].trim() : "";
      const rel = relative(source, dir);
      const name = SKILL_NAME_PATTERN.test(declared) ? declared : toSkillName(rel || basename(dir)) || toSkillName(declared);
      if (!name || !SKILL_NAME_PATTERN.test(name)) {
        result.skipped.push({ path: dir, reason: "no usable skill name" });
        continue;
      }
      if (existsSync(join(this.root, name))) {
        result.skipped.push({ path: dir, reason: `a skill named ${name} already exists` });
        continue;
      }
      if (!body.trim()) {
        result.skipped.push({ path: dir, reason: "SKILL.md has no instructions" });
        continue;
      }
      const description = (typeof frontmatter["description"] === "string" ? frontmatter["description"] : describeFromBody(body)).trim() || name;
      const target = join(this.root, name);
      mkdirSync(this.root, { recursive: true });
      cpSync(dir, target, {
        recursive: true,
        // Nested skills are imported on their own; tooling folders never belong to a skill.
        filter: (src) => src === dir || !(IGNORED_DIRS.has(basename(src)) || (statSync(src).isDirectory() && existsSync(join(src, SKILL_FILE)))),
      });
      writeFileSync(join(target, SKILL_FILE), formatSkillMarkdown({ ...frontmatter, name, description: description.slice(0, MAX_DESCRIPTION) }, body));
      result.imported.push(name);
    }
    return result;
  }

  assignments(): SkillAssignments {
    const file = join(this.root, ASSIGNMENTS_FILE);
    if (!existsSync(file)) return {};
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { nodes?: unknown };
      const nodes = raw.nodes && typeof raw.nodes === "object" ? (raw.nodes as Record<string, unknown>) : {};
      const out: SkillAssignments = {};
      for (const [stored, names] of Object.entries(nodes)) {
        // Before workflows could be chosen, keys were node ids of the one workflow (feature delivery);
        // steps of its v2 graph keep their skills under the step that replaced them.
        const key = stored.includes("/") ? stored : stepKey(FEATURE_DELIVERY_WORKFLOW_ID, RENAMED_STEPS[stored] ?? stored);
        const list = Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
        out[key] = [...new Set([...(out[key] ?? []), ...list])];
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Replaces the skills of one step; unknown names are rejected so a typo never silently drops a skill. */
  setNodeSkills(workflowId: string, nodeId: string, names: string[]): SkillAssignments {
    const unique = [...new Set(names)];
    const missing = unique.filter((n) => !this.get(n));
    if (missing.length) throw new SkillError("SKILL_NOT_FOUND", `Unknown skill${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
    const assignments = this.assignments();
    const key = stepKey(workflowId, nodeId);
    if (unique.length) assignments[key] = unique;
    else delete assignments[key];
    this.writeAssignments(assignments);
    return assignments;
  }

  /** A cloned workflow starts with the skills of the steps it was cloned from. */
  copyWorkflow(fromId: string, toId: string): void {
    const assignments = this.assignments();
    for (const [key, names] of Object.entries(assignments)) {
      if (key.startsWith(`${fromId}/`)) assignments[stepKey(toId, key.slice(fromId.length + 1))] = [...names];
    }
    this.writeAssignments(assignments);
  }

  /** Detaches every skill from a deleted workflow, so a new workflow reusing its id starts clean. */
  forgetWorkflow(workflowId: string): void {
    const assignments = this.assignments();
    for (const key of Object.keys(assignments)) if (key.startsWith(`${workflowId}/`)) delete assignments[key];
    this.writeAssignments(assignments);
  }

  forNode(workflowId: string, nodeId: string): Skill[] {
    return (this.assignments()[stepKey(workflowId, nodeId)] ?? []).flatMap((name) => {
      const skill = this.get(name);
      return skill ? [skill] : [];
    });
  }

  private read(name: string): Skill {
    const dir = join(this.root, name);
    const file = join(dir, SKILL_FILE);
    const { frontmatter, body } = parseSkillMarkdown(readFileSync(file, "utf8"));
    const description = typeof frontmatter["description"] === "string" ? frontmatter["description"] : describeFromBody(body);
    return {
      name,
      description,
      files: listFiles(dir).filter((f) => f !== SKILL_FILE),
      updatedAt: statSync(file).mtime.toISOString(),
      body,
      dir,
    };
  }

  private renameAssignments(from: string, to: string): void {
    const assignments = this.assignments();
    for (const nodeId of Object.keys(assignments)) assignments[nodeId] = assignments[nodeId]!.map((n) => (n === from ? to : n));
    this.writeAssignments(assignments);
  }

  private writeAssignments(assignments: SkillAssignments): void {
    mkdirSync(this.root, { recursive: true });
    const nodes = Object.fromEntries(Object.entries(assignments).filter(([, names]) => names.length));
    writeFileSync(join(this.root, ASSIGNMENTS_FILE), JSON.stringify({ nodes }, null, 2));
  }
}

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MAX_SKILL_FILES) break;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

function findSkillDirs(dir: string, depth = 0): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const own = existsSync(join(dir, SKILL_FILE)) ? [dir] : [];
  if (depth >= 3) return own;
  const nested = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !IGNORED_DIRS.has(d.name))
    .flatMap((d) => findSkillDirs(join(dir, d.name), depth + 1));
  return [...own, ...nested];
}

const MAX_SKILL_CHARS = 60_000;
const MAX_SKILLS_CHARS = 160_000;

/**
 * The prompt section for the skills of a step. Skills are the user's own instructions, so they
 * are not fenced as untrusted data; files they mention stay in the skill folder for the AI to read.
 */
export function skillsPrompt(skills: Skill[]): { text: string; truncated: string[] } {
  const truncated: string[] = [];
  let budget = MAX_SKILLS_CHARS;
  const blocks = skills.map((skill) => {
    const limit = Math.min(MAX_SKILL_CHARS, Math.max(budget, 0));
    let body = skill.body.trim();
    if (body.length > limit) {
      body = `${body.slice(0, limit)}\n…(truncated: read the rest in ${join(skill.dir, SKILL_FILE)})`;
      truncated.push(skill.name);
    }
    budget -= body.length;
    const files = skill.files.length ? `\nFiles in this skill's folder: ${skill.files.join(", ")}` : "";
    return `<skill name="${skill.name}" folder="${skill.dir}">\nDescription: ${skill.description}${files}\n\n${body.replace(/<\/skill>/gi, "</skill_>")}\n</skill>`;
  });
  const text = [
    "## Skills for this step",
    "The user attached these skills to this workflow step. Read them before you start and apply them wherever they fit the task. The task above and the API contract take precedence when a skill conflicts with them; mention any such conflict in your final answer.",
    "Paths a skill mentions relative to itself (templates, scripts, references) are inside its folder: read them from there and never edit the skill folder.",
    ...blocks,
  ].join("\n\n");
  return { text, truncated };
}
