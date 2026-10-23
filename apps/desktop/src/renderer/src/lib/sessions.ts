import type { SessionDto, SessionStateDto, UsageDto } from "../../../shared/ipc.js";

/** Sessions sharing a root: the first session and every resume / terminal takeover of it. */
export interface Conversation {
  rootId: string;
  /** Oldest first. */
  sessions: SessionDto[];
  latest: SessionDto;
  title: string;
  usage?: UsageDto;
  lastActivityAt: string;
}

export function groupConversations(sessions: SessionDto[]): Conversation[] {
  const byRoot = new Map<string, SessionDto[]>();
  for (const s of sessions) {
    const list = byRoot.get(s.rootSessionId) ?? [];
    list.push(s);
    byRoot.set(s.rootSessionId, list);
  }
  const out: Conversation[] = [];
  for (const [rootId, list] of byRoot) {
    list.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const latest = list.at(-1)!;
    const usage = list.reduce<UsageDto | undefined>((acc, s) => (s.usage ? (acc ? addUsage(acc, s.usage) : s.usage) : acc), undefined);
    const lastActivityAt = list.map((s) => s.lastActivityAt ?? s.endedAt ?? s.startedAt).sort().at(-1)!;
    out.push({ rootId, sessions: list, latest, title: list.find((s) => s.title)?.title ?? fallbackTitle(list[0]!), ...(usage ? { usage } : {}), lastActivityAt });
  }
  // Live first, then most recent activity; ties broken by id so rows never jump around.
  return out.sort((a, b) => Number(isActive(b.latest)) - Number(isActive(a.latest)) || b.lastActivityAt.localeCompare(a.lastActivityAt) || a.rootId.localeCompare(b.rootId));
}

function fallbackTitle(s: SessionDto): string {
  return s.workflowRunId ? `Workflow step ${s.nodeRunId ? s.nodeRunId.slice(0, 10) : ""}`.trim() : `Session ${s.id.slice(5, 13)}`;
}

export function addUsage(a: UsageDto, b: UsageDto): UsageDto {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
    ...(a.sourceCostUsd !== undefined || b.sourceCostUsd !== undefined ? { sourceCostUsd: (a.sourceCostUsd ?? 0) + (b.sourceCostUsd ?? 0) } : {}),
    pricingVersion: a.pricingVersion,
    models: [...new Set([...a.models, ...b.models])],
    unpricedModels: [...new Set([...a.unpricedModels, ...b.unpricedModels])],
    basis: a.basis === "total" || b.basis === "total" ? "total" : "fine",
  };
}

export const isActive = (s: SessionDto) => s.live || s.state === "working" || s.state === "starting" || s.state === "waiting_user" || s.state === "stalled";
export const isEnded = (s: SessionDto) => s.state === "ended" || s.state === "error" || s.state === "unknown";

export const STATE_LABEL: Record<SessionStateDto, string> = {
  starting: "Starting",
  working: "Working",
  waiting_user: "Waiting for you",
  idle: "Idle",
  stalled: "Stalled",
  ended: "Ended",
  error: "Error",
  unknown: "Not running",
};

export const STATE_TONE: Record<SessionStateDto, string> = {
  starting: "ff-tone-info",
  working: "ff-tone-info",
  waiting_user: "ff-tone-warning",
  idle: "",
  stalled: "ff-tone-danger",
  ended: "ff-tag-ok",
  error: "ff-tone-danger",
  unknown: "",
};

/** How recent the last activity is — independent of the state (a hot session can be waiting for you). */
export type ActivityAge = "hot" | "warm" | "cool" | "cold";

export function activityAge(iso: string | undefined, now = Date.now()): ActivityAge {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "cold";
  const age = now - t;
  if (age < 60_000) return "hot";
  if (age < 15 * 60_000) return "warm";
  if (age < 2 * 3_600_000) return "cool";
  return "cold";
}

export function relativeTime(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

export function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

/** "$1.20", or "≥ $1.20" when some usage could not be priced. */
export function costLabel(u: UsageDto): string {
  const base = formatUsd(u.estimatedCostUsd);
  return u.unpricedModels.length ? `≥ ${base}` : base;
}

export function costTitle(u: UsageDto): string {
  const lines = [`Estimated from token counts · price table ${u.pricingVersion}`];
  if (u.sourceCostUsd !== undefined) lines.push(`CLI-reported cost: ${formatUsd(u.sourceCostUsd)}`);
  if (u.unpricedModels.length) lines.push(`No price for: ${u.unpricedModels.join(", ")} — not included`);
  if (u.basis === "total") lines.push("Some sessions only reported running totals");
  return lines.join("\n");
}
