import path from "node:path";
import type { PermissionClass, PolicyDecision } from "@frontflow/domain";
import { PERMISSION_CLASSES } from "@frontflow/domain";
import { classifyCommand } from "./commands.js";
import { checkContainment, isPathInside, resolveRealPath } from "./paths.js";

export type PolicySource = "user" | "ai" | "system";

/** MCP-style tool annotations. Metadata only: they can tighten, never loosen, a decision (spec §22.1). */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface PolicyRequest {
  permission: PermissionClass;
  action: string;
  projectRoot: string;
  /** Folder the AI agents may write to (normally the project folder). Writes are confined here when set. */
  activeRoot?: string;
  path?: string;
  command?: string;
  /** Commands from the project profile that may run without approval. */
  knownScripts?: string[];
  integration?: string;
  source: PolicySource;
  toolAnnotations?: ToolAnnotations;
}

export interface PolicyConfig {
  /** Integrations allowed to use the network, e.g. ["figma-bridge", "ai-cli"]. */
  networkAllowlist?: string[];
  /** Integrations allowed to read external designs. Default: ["figma-bridge"]. */
  designIntegrations?: string[];
  /** Audit hook, invoked for every decision. Errors thrown here are swallowed. */
  onDecision?: (request: PolicyRequest, decision: PolicyDecision) => void;
}

const SEVERITY: Record<PolicyDecision["effect"], number> = { allow: 0, require_approval: 1, deny: 2 };

function stricter(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return SEVERITY[b.effect] > SEVERITY[a.effect] ? b : a;
}

const allow = (reason: string): PolicyDecision => ({ effect: "allow", reason });
const deny = (reason: string): PolicyDecision => ({ effect: "deny", reason });
const approval = (reason: string): PolicyDecision => ({ effect: "require_approval", reason });

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function samePath(a: string, b: string): boolean {
  return isPathInside(a, b) && isPathInside(b, a);
}

export class PolicyEngine {
  private readonly networkAllowlist: ReadonlySet<string>;
  private readonly designIntegrations: ReadonlySet<string>;
  private readonly onDecision: PolicyConfig["onDecision"];

  constructor(config: PolicyConfig = {}) {
    this.networkAllowlist = new Set(config.networkAllowlist ?? []);
    this.designIntegrations = new Set(config.designIntegrations ?? ["figma-bridge"]);
    this.onDecision = config.onDecision;
  }

  evaluate(request: PolicyRequest): PolicyDecision {
    let decision: PolicyDecision;
    try {
      decision = this.applyAnnotations(request, this.evaluateBase(request));
    } catch (err) {
      decision = deny(`policy evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.onDecision) {
      try {
        this.onDecision(request, decision);
      } catch {
        // Audit sinks must not influence the decision.
      }
    }
    return decision;
  }

  private evaluateBase(req: PolicyRequest): PolicyDecision {
    if (!(PERMISSION_CLASSES as readonly string[]).includes(req.permission)) {
      return deny(`unknown permission class "${String(req.permission)}"`);
    }
    if (!req.projectRoot || !path.isAbsolute(req.projectRoot)) {
      return deny("projectRoot must be an absolute path");
    }
    if (req.activeRoot !== undefined && !path.isAbsolute(req.activeRoot)) {
      return deny("activeRoot must be an absolute path");
    }

    switch (req.permission) {
      case "read_project":
        return this.evaluateRead(req);
      case "write_project":
        return this.evaluateWrite(req, "write");
      case "export_asset":
        return this.evaluateWrite(req, "export");
      case "run_project_command":
        return this.evaluateCommand(req);
      case "git_mutation":
        return this.evaluateGit(req);
      case "network_access":
        return req.integration && this.networkAllowlist.has(req.integration)
          ? allow(`network access allowed for integration "${req.integration}"`)
          : deny(req.integration ? `integration "${req.integration}" is not allowed to use the network` : "network access requires an allowlisted integration");
      case "read_external_design":
        return req.integration && this.designIntegrations.has(req.integration)
          ? allow(`external design read via "${req.integration}"`)
          : deny(`integration "${req.integration ?? "(none)"}" may not read external designs`);
      case "destructive_action":
        return approval(`destructive action "${req.action}" always requires explicit approval`);
    }
  }

  private evaluateRead(req: PolicyRequest): PolicyDecision {
    if (req.path === undefined) return allow("project read");
    const base = req.activeRoot ?? req.projectRoot;
    const inProject = checkContainment(req.path, base, req.projectRoot);
    if (inProject.inside) return allow("read inside project root");
    if (req.activeRoot) {
      const inActive = checkContainment(req.path, base, req.activeRoot);
      if (inActive.inside) return allow("read inside active root");
    }
    return deny(`read outside project: ${inProject.reason ?? inProject.resolved}`);
  }

  private evaluateWrite(req: PolicyRequest, kind: "write" | "export"): PolicyDecision {
    if (req.path === undefined || req.path === "") return deny(`${kind} requires a target path`);
    const root = req.activeRoot ?? req.projectRoot;
    const result = checkContainment(req.path, root, root);
    if (!result.inside) return deny(`${kind} denied: ${result.reason ?? "outside active root"}`);
    if (isInsideGitDir(result.resolved, root)) return deny(`${kind} denied: direct writes to .git are not allowed`);
    return allow(`${kind} inside ${req.activeRoot ? "active root" : "project root"}`);
  }

  private evaluateCommand(req: PolicyRequest): PolicyDecision {
    if (!req.command || !req.command.trim()) return deny("no command given");
    const cmd = normalizeCommand(req.command);
    const classification = classifyCommand(cmd);
    if (classification.destructive) {
      return approval(`destructive command requires approval: ${classification.reasons.join(", ")}`);
    }
    const known = (req.knownScripts ?? []).some((s) => normalizeCommand(s) === cmd);
    if (known) return allow("known project script");
    const detail = classification.reasons.length ? ` (${classification.reasons.join(", ")})` : "";
    return approval(`arbitrary command requires approval${detail}`);
  }

  private evaluateGit(req: PolicyRequest): PolicyDecision {
    if (req.command) {
      const classification = classifyCommand(normalizeCommand(req.command));
      if (classification.destructive) return approval(`destructive git command: ${classification.reasons.join(", ")}`);
      if (classification.network) return approval(`git command touches a remote: ${classification.reasons.join(", ")}`);
    }
    if (!req.activeRoot) return approval("git mutation without an active root requires approval");
    if (samePath(resolveRealPath(req.activeRoot), resolveRealPath(req.projectRoot))) {
      return approval("git mutation on the user's working tree requires approval");
    }
    if (req.path !== undefined) {
      const result = checkContainment(req.path, req.activeRoot, req.activeRoot);
      if (!result.inside) return approval(`git mutation target outside active root: ${result.reason ?? result.resolved}`);
    }
    return allow("git mutation inside active root");
  }

  private applyAnnotations(req: PolicyRequest, decision: PolicyDecision): PolicyDecision {
    const a = req.toolAnnotations;
    if (!a) return decision;
    let result = decision;
    if (a.destructiveHint === true) {
      result = stricter(result, approval("tool declares destructiveHint"));
    }
    if (a.openWorldHint === true && !(req.integration && this.networkAllowlist.has(req.integration))) {
      result = stricter(result, approval("tool declares openWorldHint without an allowlisted integration"));
    }
    // readOnlyHint / idempotentHint are informational and never relax policy.
    return result;
  }
}

function isInsideGitDir(resolved: string, root: string): boolean {
  const gitDir = path.join(resolveRealPath(root), ".git");
  return isPathInside(resolved, gitDir);
}
