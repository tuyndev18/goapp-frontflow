import type { NodeRun } from "@frontflow/domain";
import type { EventDto } from "../../../shared/ipc.js";

export type ActivityTone = "neutral" | "info" | "success" | "warning" | "danger" | "ai" | "muted";

export interface ActivityLine {
  id: string;
  timestamp: string;
  nodeId?: string;
  icon: string;
  text: string;
  tone: ActivityTone;
  /** Command output / long AI text: shown in a monospace block. */
  detail?: string;
  /** Noisy lines (raw command output, artifacts) hidden unless the user asks for them. */
  verbose: boolean;
}

const MAX_TEXT = 600;

/**
 * Turns raw engine and agent events into a readable activity feed: what each
 * step is doing, which tools the AI uses, which commands run and how they end.
 */
export function buildActivity(events: EventDto[], nodeRuns: NodeRun[]): ActivityLine[] {
  const nodeOfRun = new Map(nodeRuns.map((n) => [n.id, n.nodeId]));
  const lines: ActivityLine[] = [];
  for (const event of events) {
    const nodeId = (event.payload as { nodeId?: string } | null)?.nodeId ?? (event.nodeRunId ? nodeOfRun.get(event.nodeRunId) : undefined);
    const line = describe(event, nodeId);
    if (!line) continue;
    // Merge consecutive AI text from the same step into one paragraph.
    const prev = lines.at(-1);
    if (event.type === "message.delta" && prev && prev.icon === "💬" && prev.nodeId === nodeId) {
      prev.text = clip(`${prev.text}${line.text}`);
      continue;
    }
    lines.push(line);
  }
  return lines;
}

/** PTY of the latest interactive Claude session a step attempt opened (logged by the agent node). */
export function interactiveTerminalId(events: EventDto[], nodeRunId: string): string | undefined {
  let id: string | undefined;
  for (const e of events) {
    if (e.type !== "node.log" || e.nodeRunId !== nodeRunId) continue;
    const data = (e.payload as { data?: { kind?: string; terminalId?: string } } | null)?.data;
    if (data?.kind === "terminal" && data.terminalId) id = data.terminalId;
  }
  return id;
}

/** Latest meaningful line per step, shown under the step name ("what is it doing right now"). */
export function lastActivityByNode(lines: ActivityLine[]): Map<string, ActivityLine> {
  const map = new Map<string, ActivityLine>();
  for (const line of lines) if (line.nodeId && !line.verbose) map.set(line.nodeId, line);
  return map;
}

function describe(event: EventDto, nodeId: string | undefined): ActivityLine | undefined {
  const base = { id: event.id, timestamp: event.timestamp, ...(nodeId ? { nodeId } : {}), verbose: false };
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);

  switch (event.type) {
    case "run.status_changed": {
      const status = str("status");
      if (status === "running" && p["previous"] === undefined) return { ...base, icon: "▶", text: "Run started", tone: "info" };
      const map: Record<string, [string, string, ActivityTone]> = {
        completed: ["✓", "Run completed", "success"],
        completed_with_assumptions: ["✓", "Run completed with assumptions", "success"],
        failed: ["✕", "Run failed", "danger"],
        blocked: ["⚠", "Run blocked", "warning"],
        paused: ["⏸", "Run paused", "warning"],
        cancelled: ["⊘", "Run cancelled", "muted"],
        waiting: ["⏸", "Run is waiting for your input", "warning"],
        timed_out: ["✕", "Run timed out", "danger"],
        running: ["▶", "Run resumed", "info"],
      };
      const m = status ? map[status] : undefined;
      return m ? { ...base, icon: m[0], text: m[1] + (str("reason") ? ` — ${str("reason")}` : ""), tone: m[2] } : undefined;
    }
    case "node.status_changed": {
      const attempt = typeof p["attempt"] === "number" ? (p["attempt"] as number) : 1;
      const error = p["error"] as { code?: string; message?: string } | undefined;
      switch (str("status")) {
        case "running":
          return { ...base, icon: "▶", text: attempt > 1 ? `Attempt ${attempt} started` : "Started", tone: "info" };
        case "passed":
          return { ...base, icon: "✓", text: p["assumed"] ? "Done (with assumptions)" : "Done", tone: "success" };
        case "retrying":
          return { ...base, icon: "↻", text: `Will retry${error ? `: ${error.message ?? error.code}` : ""}`, tone: "warning" };
        case "failed":
          return { ...base, icon: "✕", text: `Failed${error ? ` — ${error.code}: ${error.message}` : ""}`, tone: "danger" };
        case "waiting_for_input":
          return { ...base, icon: "⏸", text: `Needs your input: ${str("blockerSummary") ?? ""}`, tone: "warning" };
        case "blocked":
          return { ...base, icon: "⚠", text: `Blocked: ${str("blockerSummary") ?? ""}`, tone: "warning" };
        case "skipped":
          return { ...base, icon: "⤼", text: `Skipped${str("blockerSummary") ? ` — ${str("blockerSummary")}` : ""}`, tone: "muted" };
        case "cancelled":
          return { ...base, icon: "⊘", text: "Cancelled", tone: "muted" };
        default:
          return undefined;
      }
    }
    case "node.log": {
      const level = str("level") ?? "info";
      const message = str("message") ?? "";
      const data = p["data"] as { kind?: string } | undefined;
      if (data?.kind === "output") return { ...base, icon: "│", text: "", detail: message, tone: "muted", verbose: true };
      const icon = level === "error" ? "✕" : level === "warn" ? "⚠" : level === "debug" ? "·" : "•";
      const tone: ActivityTone = level === "error" ? "danger" : level === "warn" ? "warning" : level === "debug" ? "muted" : "neutral";
      return { ...base, icon, text: clip(message), tone, verbose: level === "debug" };
    }
    case "node.artifact":
      return { ...base, icon: "📎", text: `Saved ${str("label") ?? str("kind") ?? "artifact"}`, tone: "muted", verbose: true };
    case "session.started":
      return { ...base, icon: "🤖", text: `AI session started${str("model") ? ` (${str("model")})` : ""}`, tone: "ai" };
    case "message.delta":
      return str("role") === "assistant" && str("text")?.trim() ? { ...base, icon: "💬", text: clip(str("text")!), tone: "ai" } : undefined;
    case "tool.started":
      return { ...base, icon: "🔧", text: describeTool(str("name") ?? "tool", p["input"]), tone: "ai" };
    case "tool.completed":
      return p["ok"] === false ? { ...base, icon: "✕", text: `${str("name") ?? "Tool"} failed`, tone: "danger" } : undefined;
    case "file.changed":
      return { ...base, icon: "✎", text: `${str("change") ?? "changed"} ${str("path") ?? ""}`, tone: "info" };
    case "approval.required":
      return { ...base, icon: "⚠", text: `Approval required: ${str("action") ?? ""}`, tone: "warning" };
    case "test.result": {
      const failed = Number(p["failed"] ?? 0);
      return { ...base, icon: "🧪", text: `${str("suite")}: ${p["passed"]} passed, ${failed} failed, ${p["skipped"]} skipped`, tone: failed ? "danger" : "success" };
    }
    case "session.completed":
      return { ...base, icon: "🤖", text: "AI session finished", tone: "ai" };
    case "session.failed":
      return { ...base, icon: "✕", text: `AI session failed: ${str("message") ?? str("code") ?? ""}`, tone: "danger" };
    default:
      return undefined;
  }
}

function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const arg = ["file_path", "path", "command", "pattern", "url", "query"].map((k) => i[k]).find((v) => typeof v === "string") as string | undefined;
  const short = arg ? (arg.length > 120 ? `…${arg.slice(-120)}` : arg) : "";
  return `${name}${short ? ` ${short}` : ""}`;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/** Time a step has been working; steps waiting for the user or for earlier steps have no running clock. */
export function stepDuration(nr: { status: string; startedAt?: string; finishedAt?: string } | undefined, now: number): number | undefined {
  if (!nr?.startedAt || nr.status === "waiting_for_input" || nr.status === "waiting_for_dependency" || nr.status === "pending") return undefined;
  return Math.max(0, (nr.finishedAt ? Date.parse(nr.finishedAt) : now) - Date.parse(nr.startedAt));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
