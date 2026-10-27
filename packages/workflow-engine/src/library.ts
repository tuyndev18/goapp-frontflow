import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stableStringify } from "@frontflow/domain";
import { stringify as stringifyYaml } from "yaml";
import { loadBuiltinWorkflows, loadWorkflowFile } from "./builtin.js";
import { parseWorkflowDefinition } from "./definition.js";
import { WorkflowDefinitionError } from "./errors.js";
import type { WorkflowDefinition } from "./types.js";

/** Same shape as skill names: lowercase letters, digits and hyphens. */
export const WORKFLOW_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface WorkflowEntry {
  definition: WorkflowDefinition;
  /** Shipped with FrontFlow: read-only, changed by cloning it. */
  builtin: boolean;
  /** Last save of a user workflow. */
  updatedAt?: string;
}

export class WorkflowLibraryError extends Error {
  constructor(
    readonly code: "WORKFLOW_NOT_FOUND" | "WORKFLOW_READ_ONLY" | "INVALID_WORKFLOW_ID",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowLibraryError";
  }
}

export interface WorkflowLibraryOptions {
  builtinDir: string;
  /** One `<id>.yaml` per user workflow. */
  userDir: string;
  /** Extra checks of a workflow being saved (e.g. node types the host can run); returns the issues. */
  check?: (definition: WorkflowDefinition) => string[];
  /** Upgrades a user workflow saved before a change of the host's steps; undefined when it is current. */
  upgrade?: (definition: WorkflowDefinition) => WorkflowDefinition | undefined;
}

/**
 * The workflows a feature can be started from: the built-in ones shipped next to the app and the
 * user's own. Saving a changed workflow bumps its version, so runs started from an earlier version
 * keep the graph they were started with.
 */
export class WorkflowLibrary {
  private readonly builtins: WorkflowDefinition[];

  constructor(private readonly options: WorkflowLibraryOptions) {
    this.builtins = loadBuiltinWorkflows(options.builtinDir);
  }

  list(): WorkflowEntry[] {
    const user: WorkflowEntry[] = [];
    if (existsSync(this.options.userDir)) {
      for (const file of readdirSync(this.options.userDir).filter((f) => f.endsWith(".yaml"))) {
        const id = file.slice(0, -".yaml".length);
        if (!WORKFLOW_ID_PATTERN.test(id) || this.isBuiltin(id)) continue;
        const entry = this.readUser(id);
        if (entry) user.push(entry);
      }
    }
    user.sort((a, b) => a.definition.name.localeCompare(b.definition.name));
    return [...this.builtins.map((definition) => ({ definition, builtin: true })), ...user];
  }

  get(id: string): WorkflowEntry {
    const builtin = this.builtins.find((d) => d.id === id);
    if (builtin) return { definition: builtin, builtin: true };
    const entry = WORKFLOW_ID_PATTERN.test(id) ? this.readUser(id) : undefined;
    if (!entry) throw new WorkflowLibraryError("WORKFLOW_NOT_FOUND", `No workflow ${id}`);
    return entry;
  }

  isBuiltin(id: string): boolean {
    return this.builtins.some((d) => d.id === id);
  }

  /** A free id for a new workflow named `name`. */
  newId(name: string): string {
    const base =
      name
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/đ/gi, "d")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 56) || "workflow";
    const taken = new Set(this.list().map((e) => e.definition.id));
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    return id;
  }

  /**
   * Saves a user workflow from untrusted data (parsed and validated like a YAML file). Its version
   * is managed here: 1 for a new workflow, +1 whenever the content changes.
   */
  save(raw: Record<string, unknown>): WorkflowDefinition {
    const id = typeof raw.id === "string" ? raw.id : "";
    if (!WORKFLOW_ID_PATTERN.test(id)) throw new WorkflowLibraryError("INVALID_WORKFLOW_ID", `Invalid workflow id: ${id}`);
    if (this.isBuiltin(id)) throw new WorkflowLibraryError("WORKFLOW_READ_ONLY", `${id} is a built-in workflow: clone it to change it`);
    const { version: _ignored, ...rest } = raw;
    const definition = parseWorkflowDefinition({ ...rest, version: 1 }, id);
    const issues = [
      ...(definition.requires?.length ? [`requires: a workflow cannot depend on another workflow (${definition.requires.join(", ")})`] : []),
      ...(this.options.check?.(definition) ?? []),
    ];
    if (issues.length) throw new WorkflowDefinitionError(id, issues);

    const previous = this.readUser(id)?.definition;
    if (previous) {
      const same = stableStringify(withoutVersion(previous)) === stableStringify(withoutVersion(definition));
      definition.version = same ? previous.version : previous.version + 1;
    }
    mkdirSync(this.options.userDir, { recursive: true });
    writeFileSync(this.file(id), stringifyYaml(serializable(definition)));
    return definition;
  }

  remove(id: string): void {
    if (this.isBuiltin(id)) throw new WorkflowLibraryError("WORKFLOW_READ_ONLY", `${id} is a built-in workflow`);
    if (!WORKFLOW_ID_PATTERN.test(id)) throw new WorkflowLibraryError("INVALID_WORKFLOW_ID", `Invalid workflow id: ${id}`);
    rmSync(this.file(id), { force: true });
  }

  private readUser(id: string): WorkflowEntry | undefined {
    const file = this.file(id);
    if (!existsSync(file)) return undefined;
    try {
      let definition = loadWorkflowFile(file);
      // The file name is the id: a hand-edited id inside the file must not shadow another workflow.
      if (definition.id !== id) return undefined;
      const upgraded = this.upgradeOf(definition);
      if (upgraded) {
        // Saved once as a new version: runs started from the old one keep their graph.
        writeFileSync(file, stringifyYaml(serializable(upgraded)));
        definition = upgraded;
      }
      return { definition, builtin: false, updatedAt: statSync(file).mtime.toISOString() };
    } catch (err) {
      console.warn("[workflows]", `${file}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** The upgraded workflow, re-validated; undefined when it is current or the upgrade would not be valid (it is then left as it is). */
  private upgradeOf(definition: WorkflowDefinition): WorkflowDefinition | undefined {
    const upgraded = this.options.upgrade?.(definition);
    if (!upgraded) return undefined;
    try {
      return parseWorkflowDefinition(serializable({ ...upgraded, version: definition.version + 1 }), definition.id);
    } catch (err) {
      console.warn("[workflows]", `${definition.id}: not upgraded: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private file(id: string): string {
    return join(this.options.userDir, `${id}.yaml`);
  }
}

function withoutVersion(definition: WorkflowDefinition): Omit<WorkflowDefinition, "version"> {
  const { version: _v, ...rest } = definition;
  return rest;
}

/** The definition as YAML data: every field the parser reads back, nothing composed. */
function serializable(definition: WorkflowDefinition): Record<string, unknown> {
  const { composedFrom: _c, requires: _r, ...rest } = definition;
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
}
