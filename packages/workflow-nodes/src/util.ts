import type { ArtifactKind, ProjectProfile } from "@frontflow/domain";
import { NodeError, type NodeExecutionContext, type NodeInput } from "@frontflow/workflow-engine";
import type { FeatureRunInputs, NodeServices, ProjectContext } from "./services.js";
import type { StepAgent } from "./step-agents.js";

export function runInputs(input: NodeInput): FeatureRunInputs {
  return input.inputs as unknown as FeatureRunInputs;
}

/**
 * What an AI step runs with: the run's saved Claude account; the model and effort chosen for this
 * step of the run (`step`, on the run screen), else for the whole run, else the step's own in the
 * workflow (`config.model` / `config.effort`), else Claude Code's.
 */
export function claudeAccountOf(input: NodeInput, step: StepAgent = {}): { claudeAccountId?: string; model?: string; effort?: string } {
  const run = runInputs(input);
  const { claudeAccountId } = run;
  const model = step.model || run.model || input.config["model"];
  const effort = step.effort || run.effort || input.config["effort"];
  return {
    ...(typeof claudeAccountId === "string" && claudeAccountId ? { claudeAccountId } : {}),
    ...(typeof model === "string" && model ? { model } : {}),
    ...(typeof effort === "string" && effort ? { effort } : {}),
  };
}

export function upstream<T>(input: NodeInput, nodeId: string): T {
  const value = input.upstream[nodeId];
  if (value === undefined) throw new NodeError("MISSING_UPSTREAM", `Output of ${nodeId} is not available`, { retryable: false });
  return value as T;
}

export function optionalUpstream<T>(input: NodeInput, nodeId: string): T | undefined {
  return input.upstream[nodeId] as T | undefined;
}

export async function projectOf(ctx: NodeExecutionContext, services: NodeServices): Promise<ProjectContext> {
  return services.getProject(ctx.projectId);
}

/** The project profile detected when the project was opened (commands for the gates). */
export async function profileOf(ctx: NodeExecutionContext, services: NodeServices, _input?: NodeInput): Promise<ProjectProfile | undefined> {
  return (await projectOf(ctx, services)).profile;
}

export function knownScripts(profile: ProjectProfile | undefined): string[] {
  return Object.values(profile?.commands ?? {}).filter((c): c is string => typeof c === "string" && c.length > 0);
}

export async function saveArtifact(
  ctx: NodeExecutionContext,
  services: NodeServices,
  kind: ArtifactKind,
  name: string,
  content: string | Uint8Array,
  mimeType: string,
  label?: string,
): Promise<string> {
  const { id } = await services.artifacts.write({
    projectId: ctx.projectId,
    runId: ctx.runId,
    nodeRunId: ctx.nodeRunId,
    kind,
    name,
    content,
    mimeType,
    source: ctx.nodeType,
  });
  ctx.emitArtifact({ artifactId: id, kind, ...(label ? { label } : {}) });
  return id;
}

/**
 * The project folder the AI agents work in. FrontFlow only drives the agents there; checkpoints
 * are hidden git snapshots, never branches or worktrees.
 */
export interface WorkspaceOutput {
  projectPath: string;
  /** HEAD when the run was created. */
  baseSha: string;
}

export async function workspaceOf(ctx: NodeExecutionContext, services: NodeServices, input: NodeInput): Promise<WorkspaceOutput> {
  const { rootPath } = await projectOf(ctx, services);
  const baseSha = runInputs(input).gitBaseSha;
  return { projectPath: rootPath, baseSha: typeof baseSha === "string" ? baseSha : "" };
}

/** The feature's name, as typed when it was created. */
export function featureOf(input: NodeInput): string {
  return runInputs(input).title ?? "this feature";
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}
