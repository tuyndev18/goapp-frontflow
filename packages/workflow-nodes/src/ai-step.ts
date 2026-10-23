import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256 } from "@frontflow/domain";
import { NodeError, type NodeExecutionContext, type NodeInput } from "@frontflow/workflow-engine";
import { extractJson, runAgentStep } from "./agent.js";
import { renderPrompt, SYSTEM_PROMPT_NAME } from "./prompt-library.js";
import type { NodeServices, StoredSnapshot } from "./services.js";
import { plural, runInputs, saveArtifact, claudeAccountOf } from "./util.js";

/**
 * AI steps are editable prompts (workflows/prompts/<step id>.md, overridable by the user) that an
 * AI agent runs in the project folder — an interactive tmux-style session for Claude. Files a step
 * hands to the agent or gets back from it live in `.frontflow/runs/<run id>/` inside the project.
 */

/** Reads a pinned snapshot and refuses to continue if its content no longer matches its hash (spec §3.6). */
export async function loadSnapshot(services: NodeServices, projectId: string, snapshotId: string): Promise<StoredSnapshot> {
  let stored;
  try {
    stored = await services.readSnapshot(projectId, snapshotId);
  } catch (err) {
    throw new NodeError("IO_ERROR", `Cannot read document snapshot: ${err instanceof Error ? err.message : String(err)}`, { retryable: true });
  }
  if (sha256(stored.text) !== stored.snapshot.contentHash) {
    throw new NodeError("SNAPSHOT_TAMPERED", `Snapshot ${snapshotId} content does not match its hash`, { retryable: false });
  }
  return stored;
}

/** The run's folder in the project (`.frontflow/runs/<run id>`): absolute path and the path the prompts show. */
export function runFolder(projectPath: string, runId: string): { abs: string; rel: string } {
  const rel = `.frontflow/runs/${runId}`;
  const abs = join(projectPath, ".frontflow", "runs", runId);
  mkdirSync(abs, { recursive: true });
  // FrontFlow's working files stay out of the user's git status and out of the step snapshots.
  const ignore = join(projectPath, ".frontflow", ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return { abs, rel };
}

/** Writes a file into the run folder and returns its project-relative path. */
export function writeRunFile(projectPath: string, runId: string, name: string, content: string): string {
  const folder = runFolder(projectPath, runId);
  writeFileSync(join(folder.abs, name), content);
  return `${folder.rel}/${name}`;
}

/**
 * The step's prompt: its template (named after the step id) with `{{placeholders}}` filled in.
 * The rendered prompt is kept as evidence of exactly what the agent was asked.
 */
export async function stepPrompt(ctx: NodeExecutionContext, services: NodeServices, vars: Record<string, string>): Promise<string> {
  const template = services.prompts.get(ctx.nodeId);
  // previousFailure is no longer filled (no validation gates) but user-edited prompts may still contain it.
  const { text, missing } = renderPrompt(template.text, { feature: "", previousFailure: "", ...vars });
  if (missing.length) ctx.log("warn", `Prompt placeholders without a value: ${missing.map((m) => `{{${m}}}`).join(", ")}`);
  ctx.log("info", `Prompt: ${template.customized ? "your edited prompt" : "default prompt"} for ${ctx.nodeId}`);
  await saveArtifact(ctx, services, "prompt", `${ctx.nodeId}-attempt${ctx.attempt}.md`, text, "text/markdown", `Prompt (attempt ${ctx.attempt})`);
  return text;
}

/** The system prompt every AI step runs with (editable as `_system`). */
export function systemPrompt(services: NodeServices): string {
  return renderPrompt(services.prompts.get(SYSTEM_PROMPT_NAME).text, {}).text;
}

/** Runs an analysis prompt in the project folder and reads back the JSON file it asks the agent to write. */
export async function askAi(
  ctx: NodeExecutionContext,
  services: NodeServices,
  input: NodeInput,
  options: { projectPath: string; prompt: string; outputRel: string; withFigma?: boolean },
): Promise<{ data: unknown }> {
  const file = join(options.projectPath, ...options.outputRel.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  // A stale file from a previous attempt must not be mistaken for this attempt's answer.
  if (existsSync(file)) writeFileSync(file, "");
  const result = await runAgentStep(ctx, services, {
    projectId: ctx.projectId,
    adapterId: runInputs(input).adapterId,
    ...claudeAccountOf(input),
    cwd: options.projectPath,
    prompt: options.prompt,
    systemPrompt: systemPrompt(services),
    readOnly: false,
    filesOnly: true,
    projectSettings: true,
    ...(options.withFigma ? { withFigma: true } : {}),
  });
  const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (text) {
    try {
      return { data: JSON.parse(text) };
    } catch {
      ctx.log("warn", `${options.outputRel} is not valid JSON`);
    }
  }
  return { data: extractJson<unknown>(result.resultText) };
}

/** Retries while the node's AI budget lasts, then lets the caller fall back. */
export function invalidOutput(ctx: NodeExecutionContext, input: NodeInput, message: string): void {
  const attempts = typeof input.config["aiAttempts"] === "number" ? (input.config["aiAttempts"] as number) : 2;
  if (ctx.attempt < attempts) throw new NodeError("AI_OUTPUT_INVALID", message, { retryable: true });
  ctx.log("error", `${message} after ${plural(ctx.attempt, "attempt")}`);
}

export function lineCount(text: string): number {
  return text.split("\n").length;
}
