import type { NodeRun } from "@frontflow/domain";
import type { EventDto } from "../../../shared/ipc.js";
import type { ActivityTone } from "./activity.js";

/**
 * A step's activity read like a Claude Code conversation (as in the VS Code extension): the AI's
 * messages as paragraphs, each tool call as one line that opens to its input and result, and the
 * step's own milestones (started, done, needs you…) between them.
 */
export type TranscriptItem = TextItem | UserItem | ToolItem | NoteItem;

interface ItemBase {
  id: string;
  timestamp: string;
  nodeId?: string;
}

export interface TextItem extends ItemBase {
  kind: "text";
  text: string;
}

/** A follow-up the user typed in the step's AI chat. */
export interface UserItem extends ItemBase {
  kind: "user";
  text: string;
}

export interface ToolItem extends ItemBase {
  kind: "tool";
  name: string;
  input: Record<string, unknown>;
  status: "running" | "ok" | "failed";
  output?: string;
  /** Files the call created, changed or deleted (from file.changed). */
  files: Array<{ path: string; change: string }>;
}

/** A milestone or log line of the step (or the run). */
export interface NoteItem extends ItemBase {
  kind: "note";
  icon: string;
  text: string;
  tone: ActivityTone;
  /** Command output and the like, shown folded. */
  detail?: string;
  /** Debug lines and saved artifacts: only with "Show details". */
  verbose: boolean;
  /** Step lifecycle (started, done, failed…): drawn as a divider. */
  milestone?: boolean;
  /** The step status a milestone reports (node.status_changed). */
  status?: string;
}

const MAX_OUTPUT = 20_000;

export function buildTranscript(events: EventDto[], nodeRuns: NodeRun[]): TranscriptItem[] {
  const nodeOfRun = new Map(nodeRuns.map((n) => [n.id, n.nodeId]));
  const items: TranscriptItem[] = [];
  const tools = new Map<string, ToolItem>();
  let lastTool: ToolItem | undefined;

  for (const event of events) {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
    const nodeId = str("nodeId") ?? (event.nodeRunId ? nodeOfRun.get(event.nodeRunId) : undefined);
    const base = { id: event.id, timestamp: event.timestamp, ...(nodeId ? { nodeId } : {}) };
    const note = (icon: string, text: string, tone: ActivityTone, extra: Partial<NoteItem> = {}) => items.push({ ...base, kind: "note", icon, text, tone, verbose: false, ...extra });

    switch (event.type) {
      case "message.delta": {
        const text = str("text") ?? "";
        if (!text.trim()) break;
        if (str("role") === "user") {
          items.push({ ...base, kind: "user", text });
          break;
        }
        if (str("role") !== "assistant") {
          note("•", text, "muted");
          break;
        }
        const prev = items.at(-1);
        // Text read from a terminal arrives line by line (it has a confidence): one paragraph.
        if (event.confidence !== undefined && prev?.kind === "text" && prev.nodeId === nodeId) prev.text += `\n${text}`;
        else items.push({ ...base, kind: "text", text });
        break;
      }
      case "tool.started": {
        const input = p["input"] && typeof p["input"] === "object" ? (p["input"] as Record<string, unknown>) : {};
        const item: ToolItem = { ...base, kind: "tool", name: str("name") ?? "tool", input, status: "running", files: [] };
        tools.set(str("toolCallId") ?? event.id, item);
        lastTool = item;
        items.push(item);
        break;
      }
      case "tool.completed": {
        const item = tools.get(str("toolCallId") ?? "");
        if (!item) {
          if (p["ok"] === false) note("✕", `${str("name") ?? "Tool"} failed`, "danger");
          break;
        }
        item.status = p["ok"] === false ? "failed" : "ok";
        const output = p["output"];
        if (output !== undefined && output !== null && output !== "") {
          const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
          item.output = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…` : text;
        }
        break;
      }
      case "file.changed": {
        const file = { path: str("path") ?? "", change: str("change") ?? "modified" };
        // The write or edit that made the change already says so: attach it there.
        if (lastTool && lastTool.nodeId === nodeId && /write|edit|create|patch|file_change/i.test(lastTool.name)) lastTool.files.push(file);
        else note("✎", `${file.change} ${file.path}`, "info");
        break;
      }
      case "node.log": {
        const level = str("level") ?? "info";
        const message = str("message") ?? "";
        const data = p["data"] as { kind?: string } | undefined;
        if (data?.kind === "output") {
          // Command output belongs to the line that ran the command.
          const prev = items.at(-1);
          if (prev?.kind === "note" && prev.nodeId === nodeId && !prev.milestone) prev.detail = `${prev.detail ?? ""}${message}`;
          else note("│", "Output", "muted", { detail: message, verbose: true });
          break;
        }
        if (data?.kind === "terminal") break;
        const icon = level === "error" ? "✕" : level === "warn" ? "⚠" : "•";
        const tone: ActivityTone = level === "error" ? "danger" : level === "warn" ? "warning" : "neutral";
        note(icon, message, tone, { verbose: level === "debug" });
        break;
      }
      case "node.status_changed": {
        const attempt = typeof p["attempt"] === "number" ? (p["attempt"] as number) : 1;
        const error = p["error"] as { code?: string; message?: string } | undefined;
        const m = { milestone: true, ...(str("status") ? { status: str("status")! } : {}) };
        switch (str("status")) {
          case "running":
            note("▶", attempt > 1 ? `Attempt ${attempt} started` : "Started", "info", m);
            break;
          case "passed":
            note("✓", p["assumed"] ? "Done (with assumptions)" : "Done", "success", m);
            break;
          case "retrying":
            note("↻", `Will retry${error ? `: ${error.message ?? error.code}` : ""}`, "warning", m);
            break;
          case "failed":
            note("✕", `Failed${error ? ` — ${error.code}: ${error.message}` : ""}`, "danger", m);
            break;
          case "waiting_for_input":
            note("⏸", `Needs your input: ${str("blockerSummary") ?? ""}`, "warning", m);
            break;
          case "blocked":
            note("⚠", `Blocked: ${str("blockerSummary") ?? ""}`, "warning", m);
            break;
          case "skipped":
            note("⤼", `Skipped${str("blockerSummary") ? ` — ${str("blockerSummary")}` : ""}`, "muted", m);
            break;
          case "cancelled":
            note("⊘", "Cancelled", "muted", m);
            break;
        }
        break;
      }
      case "run.status_changed": {
        const status = str("status");
        const map: Record<string, [string, string, ActivityTone]> = {
          completed: ["✓", "Run completed", "success"],
          completed_with_assumptions: ["✓", "Run completed with assumptions", "success"],
          failed: ["✕", "Run failed", "danger"],
          blocked: ["⚠", "Run blocked", "warning"],
          paused: ["⏸", "Run paused", "warning"],
          cancelled: ["⊘", "Run cancelled", "muted"],
          waiting: ["⏸", "Run is waiting for your input", "warning"],
          timed_out: ["✕", "Run timed out", "danger"],
          running: ["▶", p["previous"] === undefined ? "Run started" : "Run resumed", "info"],
        };
        const m = status ? map[status] : undefined;
        if (m) items.push({ id: event.id, timestamp: event.timestamp, kind: "note", icon: m[0], text: m[1] + (str("reason") ? ` — ${str("reason")}` : ""), tone: m[2], verbose: false, milestone: true });
        break;
      }
      case "node.artifact":
        note("📎", `Saved ${str("label") ?? str("kind") ?? "artifact"}`, "muted", { verbose: true });
        break;
      case "session.started":
        note("✳", `Claude session started${str("model") ? ` · ${str("model")}` : ""}`, "ai", { verbose: true });
        break;
      case "session.failed":
        note("✕", `AI session failed: ${str("message") ?? str("code") ?? ""}`, "danger");
        break;
      case "approval.required":
        note("⚠", `Approval required: ${str("action") ?? ""}`, "warning");
        break;
      case "test.result": {
        const failed = Number(p["failed"] ?? 0);
        note("🧪", `${str("suite")}: ${p["passed"]} passed, ${failed} failed, ${p["skipped"]} skipped`, failed ? "danger" : "success");
        break;
      }
    }
  }
  return items;
}

/** How a tool call reads on one line: its verb and its main argument. */
export function toolTitle(item: ToolItem, root?: string): { verb: string; target: string } {
  const i = item.input;
  const s = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : undefined);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(item.name);
  if (mcp) return { verb: mcp[2] ?? item.name, target: mcp[1] ?? "" };
  switch (item.name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { verb: item.name === "MultiEdit" ? "Edit" : item.name, target: relative(s("file_path") ?? s("notebook_path") ?? "", root) };
    case "Bash":
    case "PowerShell":
    case "command_execution":
      return { verb: item.name === "command_execution" ? "Run" : item.name, target: firstLine(s("description") && !s("command") ? s("description")! : (s("command") ?? "")) };
    case "Grep":
      return { verb: "Search", target: `${s("pattern") ?? ""}${s("path") ? `  in ${relative(s("path")!, root)}` : ""}` };
    case "Glob":
      return { verb: "Find files", target: s("pattern") ?? "" };
    case "TodoWrite":
      return { verb: "Update todos", target: "" };
    case "Task":
    case "Agent":
      return { verb: "Agent", target: s("description") ?? "" };
    case "WebFetch":
      return { verb: "Fetch", target: s("url") ?? "" };
    case "WebSearch":
    case "web_search":
      return { verb: "Search the web", target: s("query") ?? "" };
    default: {
      const arg = ["file_path", "path", "command", "pattern", "url", "query", "description"].map(s).find(Boolean);
      return { verb: item.name, target: arg ? relative(firstLine(arg), root) : "" };
    }
  }
}

/** The lines an Edit/Write call changes, as a small diff: old lines with "-", new ones with "+". */
export function toolDiff(item: ToolItem): Array<{ sign: "-" | "+" | " "; text: string }> | undefined {
  const i = item.input;
  const lines = (v: unknown) => (typeof v === "string" ? v.split("\n") : []);
  if (item.name === "Edit") return [...lines(i["old_string"]).map((text) => ({ sign: "-" as const, text })), ...lines(i["new_string"]).map((text) => ({ sign: "+" as const, text }))];
  if (item.name === "MultiEdit" && Array.isArray(i["edits"])) {
    return (i["edits"] as Array<Record<string, unknown>>).flatMap((e, n) => [
      ...(n ? [{ sign: " " as const, text: "⋯" }] : []),
      ...lines(e["old_string"]).map((text) => ({ sign: "-" as const, text })),
      ...lines(e["new_string"]).map((text) => ({ sign: "+" as const, text })),
    ]);
  }
  if (item.name === "Write") return lines(i["content"]).map((text) => ({ sign: "+" as const, text }));
  return undefined;
}

/** A TodoWrite call's list. */
export function toolTodos(item: ToolItem): Array<{ content: string; status: string }> | undefined {
  const todos = item.input["todos"];
  if (item.name !== "TodoWrite" || !Array.isArray(todos)) return undefined;
  return todos.flatMap((t) => (t && typeof t === "object" && typeof (t as { content?: unknown }).content === "string" ? [{ content: (t as { content: string }).content, status: String((t as { status?: unknown }).status ?? "pending") }] : []));
}

export function relative(path: string, root?: string): string {
  if (!root || !path) return path;
  const norm = (v: string) => v.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = norm(path);
  const r = norm(root);
  return p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : path;
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}
