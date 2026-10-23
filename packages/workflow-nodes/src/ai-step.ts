import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@frontflow/domain";
import { NodeError, type NodeExecutionContext, type NodeInput } from "@frontflow/workflow-engine";
import { extractJson, runAgentStep } from "./agent.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import type { NodeServices, StoredSnapshot } from "./services.js";
import { plural, runInputs } from "./util.js";

/**
 * Analysis steps (read a document, read the design, map, design tests): the AI
 * works in a scratch directory outside the project, writes one JSON file, and
 * the caller grounds it. The project is never touched by these steps.
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

/** Per-run scratch directory shared by the analysis steps of one workflow (e.g. "readiness", "tests"). */
export function scratchWorkspace(services: NodeServices, runId: string, name: string): string {
  const dir = join(services.scratchDir, runId, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function askAi(
  ctx: NodeExecutionContext,
  services: NodeServices,
  input: NodeInput,
  options: { dir: string; prompt: string; outputFile: string; withFigma?: boolean },
): Promise<{ data: unknown }> {
  const file = join(options.dir, options.outputFile);
  // A stale file from a previous attempt must not be mistaken for this attempt's answer.
  if (existsSync(file)) writeFileSync(file, "");
  const result = await runAgentStep(ctx, services, {
    projectId: ctx.projectId,
    adapterId: runInputs(input).adapterId,
    cwd: options.dir,
    prompt: options.prompt,
    systemPrompt: SYSTEM_PROMPT,
    readOnly: false,
    filesOnly: true,
    ...(options.withFigma ? { withFigma: true } : {}),
  });
  const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (text) {
    try {
      return { data: JSON.parse(text) };
    } catch {
      ctx.log("warn", `${options.outputFile} is not valid JSON`);
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

export const FILES_ONLY_RULE = "You only have file tools: do not try to run shell commands, scripts or validators. Once the file is written, stop and reply with one line.";

export function lineCount(text: string): number {
  return text.split("\n").length;
}
