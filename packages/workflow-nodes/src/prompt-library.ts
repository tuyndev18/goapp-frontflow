import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every AI step is just a prompt the user can read and edit. The shipped defaults live next to
 * the workflow YAML (`workflows/prompts/<step id>.md`); a user's edit is stored in its own folder
 * and wins until it is reset. `_system.md` is the system prompt every AI step runs with.
 * Templates use `{{name}}` placeholders that the step fills in when it runs.
 */
export interface PromptTemplate {
  name: string;
  text: string;
  /** The user changed it; `defaultText` is the shipped version. */
  customized: boolean;
  defaultText: string;
}

/** What node handlers need: the current template of a step. */
export interface PromptSource {
  get(name: string): PromptTemplate;
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

  /** Names of every step prompt that ships with FrontFlow. */
  list(): string[] {
    if (!existsSync(this.options.defaultsDir)) return [];
    return readdirSync(this.options.defaultsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
  }

  get(name: string): PromptTemplate {
    const defaultText = this.read(join(this.options.defaultsDir, `${checkName(name)}.md`));
    const custom = this.read(join(this.options.userDir, `${name}.md`));
    if (defaultText === undefined && custom === undefined) throw new PromptError("PROMPT_NOT_FOUND", `No prompt named ${name}`);
    return { name, text: custom ?? defaultText ?? "", customized: custom !== undefined, defaultText: defaultText ?? "" };
  }

  save(name: string, text: string): PromptTemplate {
    mkdirSync(this.options.userDir, { recursive: true });
    writeFileSync(join(this.options.userDir, `${checkName(name)}.md`), text.endsWith("\n") ? text : `${text}\n`);
    return this.get(name);
  }

  /** Drops the user's edit; the shipped default applies again. */
  reset(name: string): PromptTemplate {
    rmSync(join(this.options.userDir, `${checkName(name)}.md`), { force: true });
    return this.get(name);
  }

  private read(path: string): string | undefined {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }
}

function checkName(name: string): string {
  if (!NAME.test(name) || name.includes("..")) throw new PromptError("INVALID_NAME", `Invalid prompt name: ${name}`);
  return name;
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
