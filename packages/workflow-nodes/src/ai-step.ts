import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { sha256 } from "@frontflow/domain";
import { redactString } from "@frontflow/event-schema";
import { NodeError, type NodeExecutionContext, type NodeInput, type NodeResult } from "@frontflow/workflow-engine";
import { runAgentStep } from "./agent.js";
import { additionsPrompt, renderPrompt, SYSTEM_PROMPT_NAME } from "./prompt-library.js";
import type { NodeServices, StoredSnapshot } from "./services.js";
import { plural, runInputs, saveArtifact, claudeAccountOf } from "./util.js";

/**
 * AI steps are editable prompts (workflows/prompts/<workflow>/<step id>.md, overridable by the user) that an
 * AI agent runs in the project folder — an interactive tmux-style session for Claude. The files a
 * step hands to the agent or gets back from it (imported documents, Markdown reports) live in the
 * run's folder in the tool's data, never in the project; the agent is given access to it.
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

/** The run's folder of workflow files (absolute; created on first use). */
export function runFolder(services: NodeServices, ctx: NodeExecutionContext): string {
  const dir = services.runFilesDir(ctx.projectId, ctx.runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes a file into the run folder and returns its absolute path. */
export function writeRunFile(services: NodeServices, ctx: NodeExecutionContext, name: string, content: string): string {
  const file = join(runFolder(services, ctx), name);
  writeFileSync(file, content);
  return file;
}

/** A document step's latest upload as a list: runs imported before uploads held several files have a single document. */
export function latestUpload<T>(provided: T[] | T | undefined, pinned: T | undefined): T[] {
  if (Array.isArray(provided)) return provided;
  if (provided !== undefined) return [provided];
  return pinned !== undefined ? [pinned] : [];
}

/**
 * Replaces a subfolder of the run folder with these documents, so the agents only ever see the
 * latest upload. Names come from the uploaded files (made safe and unique); returns absolute paths.
 */
export function writeRunDocuments(services: NodeServices, ctx: NodeExecutionContext, folder: string, docs: Array<{ name: string; text: string }>): string[] {
  const dir = join(runFolder(services, ctx), folder);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const used = new Set<string>();
  return docs.map((doc, i) => {
    // Uploaded names may carry either separator, whatever the OS.
    const safe = (doc.name.split(/[\\/]/).pop() ?? "").replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/^[.\s]+/, "").trim() || `document-${i + 1}.md`;
    const ext = extname(safe);
    let name = safe;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${safe.slice(0, safe.length - ext.length)}-${n}${ext}`;
    used.add(name.toLowerCase());
    const file = join(dir, name);
    writeFileSync(file, doc.text);
    return file;
  });
}

/** Files for a prompt: the path itself when there is one, else one per line. */
export function fileList(files: string[]): string {
  const [only] = files;
  return files.length === 1 && only ? only : files.map((f) => `\n  - ${f}`).join("");
}

/**
 * The step's prompt: its template (named after the step id, in the run's workflow) followed by the
 * project's own additions, with `{{placeholders}}` filled in. The rendered prompt is kept as
 * evidence of exactly what the agent was asked.
 */
export async function stepPrompt(ctx: NodeExecutionContext, services: NodeServices, vars: Record<string, string>): Promise<string> {
  const template = services.prompts.get(ctx.nodeId, ctx.workflowId);
  const additions = (services.prompts.additions?.(ctx.projectId, ctx.workflowId, ctx.nodeId) ?? []).filter((a) => a.enabled && a.text.trim());
  const extra = additionsPrompt(additions);
  // previousFailure is no longer filled (no validation gates) but user-edited prompts may still contain it.
  const { text, missing } = renderPrompt(extra ? `${template.text.trimEnd()}\n\n${extra}` : template.text, { feature: "", previousFailure: "", ...vars });
  if (missing.length) ctx.log("warn", `Prompt placeholders without a value: ${missing.map((m) => `{{${m}}}`).join(", ")}`);
  ctx.log("info", `Prompt: ${template.customized ? "your edited prompt" : "default prompt"} for ${ctx.nodeId}${additions.length ? ` + ${plural(additions.length, "project addition")}` : ""}`);
  await saveArtifact(ctx, services, "prompt", `${ctx.nodeId}-attempt${ctx.attempt}.md`, text, "text/markdown", `Prompt (attempt ${ctx.attempt})`);
  return text;
}

/** The system prompt every AI step runs with (editable as `_system`). */
export function systemPrompt(services: NodeServices): string {
  return renderPrompt(services.prompts.get(SYSTEM_PROMPT_NAME).text, {}).text;
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

export type ReportVerdict = "enough" | "not_enough";

/** A report's conclusion: the first line under "## Kết luận" is `Đủ` or `Chưa đủ`; undefined when the agent did not follow that format. */
export function reportVerdict(report: string): ReportVerdict | undefined {
  // No \b: it is ASCII-only, so it never matches after "đủ".
  const m = /^#{1,6}\s*Kết luận\s*\n\s*[*_`]*\s*(Chưa đủ|Đủ)(?=[\s*_`.:,;!-]|$)/imu.exec(report.normalize("NFC"));
  if (!m?.[1]) return undefined;
  return m[1].toLowerCase().startsWith("chưa") ? "not_enough" : "enough";
}

/** A report's coverage: the first line under "## Kết luận" is `Đáp ứng: NN%`; undefined when the agent did not follow that format. */
export function reportScore(report: string): number | undefined {
  const m = /^#{1,6}\s*Kết luận\s*\n\s*[*_`]*\s*Đáp ứng\s*[*_`]*\s*:?\s*[*_`]*\s*(\d{1,3}(?:[.,]\d+)?)\s*%/imu.exec(report.normalize("NFC"));
  if (!m?.[1]) return undefined;
  const score = Number(m[1].replace(",", "."));
  return score >= 0 && score <= 100 ? score : undefined;
}

/** How a gated report is judged: its verdict (undefined: no readable conclusion), a short summary, and fields for the step output. */
export interface ReportJudgement {
  verdict?: ReportVerdict;
  summary: string;
  fields?: Record<string, unknown>;
}

/** The default judgement: the `Đủ` / `Chưa đủ` line under "## Kết luận". */
export function judgeByVerdict(report: string): ReportJudgement {
  const verdict = reportVerdict(report);
  return verdict ? { verdict, summary: verdict === "enough" ? "Đủ" : "Chưa đủ" } : { summary: "no Đủ / Chưa đủ conclusion found" };
}

/** What every Markdown report step outputs (plus its own fields). */
export interface ReportOutput {
  /** The report itself, shown as the step result. */
  report: string;
  /** Where it is saved in the run folder (absolute), for the next steps' agents to read. */
  reportPath: string;
  reportArtifactId: string;
  /** Only for steps with a gate. */
  verdict?: ReportVerdict | "unknown";
}

/**
 * An AI step whose answer is a short Markdown report written into the run folder; FrontFlow does
 * not parse it. With `gate`, only its conclusion is read (`judge`, by default the `Đủ` / `Chưa đủ`
 * line): anything but "enough" waits until the user accepts (`providedInput.accept`), which keeps
 * the report already written instead of asking again. Without a report file after the retries,
 * the agent's final answer is kept, marked as assumed.
 */
export async function reportStep(
  ctx: NodeExecutionContext,
  services: NodeServices,
  input: NodeInput,
  options: {
    fileName: string;
    label: string;
    cwd: string;
    vars: Record<string, string>;
    gate?: { judge?: (report: string) => ReportJudgement; notEnough: string; unknown: string };
    extra?: Record<string, unknown>;
    /** The agent may also run these project commands and edit the project (e.g. run and fix tests); otherwise it only reads and writes files. */
    allowedCommands?: string[];
  },
): Promise<NodeResult> {
  const reportPath = join(runFolder(services, ctx), options.fileName);
  const accepted = options.gate !== undefined && (input.providedInput as { accept?: unknown } | undefined)?.accept === true;
  let report = accepted && existsSync(reportPath) ? readFileSync(reportPath, "utf8").trim() : "";
  let assumed = false;
  if (!report) {
    const prompt = await stepPrompt(ctx, services, { ...options.vars, output: reportPath });
    // A stale file from a previous attempt must not be mistaken for this attempt's answer.
    if (existsSync(reportPath)) writeFileSync(reportPath, "");
    const result = await runAgentStep(ctx, services, {
      projectId: ctx.projectId,
      adapterId: runInputs(input).adapterId,
      ...claudeAccountOf(input),
      cwd: options.cwd,
      addDirs: [runFolder(services, ctx)],
      prompt,
      systemPrompt: systemPrompt(services),
      readOnly: false,
      ...(options.allowedCommands ? { allowedCommands: options.allowedCommands } : { filesOnly: true }),
      projectSettings: true,
      outputReady: () => existsSync(reportPath) && readFileSync(reportPath, "utf8").trim().length > 0,
    });
    report = existsSync(reportPath) ? readFileSync(reportPath, "utf8").trim() : "";
    if (!report) {
      invalidOutput(ctx, input, `The AI did not write ${options.fileName}`);
      // Out of attempts: the agent's final answer is all there is; keep it, marked as assumed.
      report = result.resultText.trim();
      if (!report) throw new NodeError("AI_OUTPUT_INVALID", `The AI did not write ${options.fileName}`, { retryable: false });
      assumed = true;
    }
  }
  report = redactString(report);
  writeFileSync(reportPath, report);
  const reportArtifactId = await saveArtifact(ctx, services, "evidence", options.fileName, report, "text/markdown", options.label);
  const output: ReportOutput & Record<string, unknown> = { ...options.extra, report, reportPath, reportArtifactId };
  if (!options.gate) {
    ctx.log("info", `${options.label} written to ${reportPath} (${lineCount(report)} lines)`);
    return { status: "passed", output, assumed };
  }

  const { verdict, summary, fields } = (options.gate.judge ?? judgeByVerdict)(report);
  Object.assign(output, fields, { verdict: verdict ?? "unknown" });
  ctx.log(verdict === "enough" ? "info" : "warn", `${options.label} written to ${reportPath}: ${summary}`);
  if (verdict !== "enough" && !accepted) {
    return { status: "waiting_for_input", prompt: `${options.label}: ${summary}. ${verdict === "not_enough" ? options.gate.notEnough : options.gate.unknown}`, output };
  }
  if (accepted) ctx.log("warn", "Gaps accepted by the user; the steps after this one are marked as assumed");
  return { status: "passed", output, assumed: assumed || accepted };
}
