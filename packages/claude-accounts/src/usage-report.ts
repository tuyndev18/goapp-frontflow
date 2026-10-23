import { accountOwner, messageCost, type TranscriptMessage } from "./local-usage.js";
import type { TimelineEntry } from "./types.js";

/** Token counts of a slice of messages. `tokens` = all input (cache included) + output. */
export interface UsageTotals {
  tokens: number;
  /** Input not served from or written to the cache. */
  freshInput: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  messages: number;
}

export interface UsageReport {
  generatedAt: string;
  /** Local calendar days covered, oldest first, today last. */
  days: number;
  totals: { today: UsageTotals; last7d: UsageTotals; period: UsageTotals };
  /** One entry per local day, empty days included. Keys of the maps: account id ("" = not attributed) and model. */
  daily: Array<{ date: string; total: UsageTotals; byAccount: Record<string, number>; byModel: Record<string, number> }>;
  models: Array<UsageTotals & { model: string }>;
  accounts: Array<UsageTotals & { accountId: string | null }>;
  projects: Array<UsageTotals & { project: string; lastAt: string }>;
  sessions: Array<UsageTotals & { sessionId: string; project: string; model?: string; firstAt: string; lastAt: string }>;
  /** Their cost is missing: costs are lower bounds when not empty. */
  unpricedModels: string[];
}

export function emptyTotals(): UsageTotals {
  return { tokens: 0, freshInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0 };
}

/** Local-time YYYY-MM-DD. */
export function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Usage of the last `days` local days, by day, account, model, project and session, from
 * the messages of Claude transcripts. Accounts come from FrontFlow's switch timeline.
 */
export function usageReport(messages: TranscriptMessage[], timeline: TimelineEntry[], now: number, days: number, top = 10): UsageReport {
  const ownerAt = accountOwner(timeline);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const todayKey = localDay(now);
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - 6);

  const daily = new Map<string, UsageReport["daily"][number]>();
  for (let d = new Date(start); d.getTime() <= now; d.setDate(d.getDate() + 1)) {
    const date = localDay(d.getTime());
    daily.set(date, { date, total: emptyTotals(), byAccount: {}, byModel: {} });
  }
  const totals = { today: emptyTotals(), last7d: emptyTotals(), period: emptyTotals() };
  const models = new Map<string, UsageTotals & { model: string }>();
  const accounts = new Map<string, UsageTotals & { accountId: string | null }>();
  const projects = new Map<string, UsageTotals & { project: string; lastAt: string }>();
  const sessions = new Map<string, UsageTotals & { sessionId: string; project: string; model?: string; firstAt: string; lastAt: string; perModel: Map<string, number> }>();
  const unpriced = new Set<string>();

  for (const m of messages) {
    if (m.at < start.getTime() || m.at > now) continue;
    const tokens = m.input + m.output;
    // Synthetic entries (no model, no tokens) carry nothing to count.
    if (!tokens) continue;
    const est = messageCost(m);
    if (!est.ok) unpriced.add(m.model ?? "unknown");
    const usd = est.ok ? est.usd : 0;
    const model = m.model ?? "unknown";
    const owner = ownerAt(m.at);
    const iso = new Date(m.at).toISOString();
    const bump = (t: UsageTotals) => addTo(t, m, tokens, usd);

    bump(totals.period);
    if (m.at >= weekStart.getTime()) bump(totals.last7d);
    const day = daily.get(localDay(m.at));
    if (day) {
      bump(day.total);
      day.byAccount[owner ?? ""] = (day.byAccount[owner ?? ""] ?? 0) + tokens;
      day.byModel[model] = (day.byModel[model] ?? 0) + tokens;
      if (day.date === todayKey) bump(totals.today);
    }
    bump(models.get(model) ?? models.set(model, { ...emptyTotals(), model }).get(model)!);
    const accountKey = owner ?? "";
    bump(accounts.get(accountKey) ?? accounts.set(accountKey, { ...emptyTotals(), accountId: owner }).get(accountKey)!);
    const project = m.project ?? "unknown";
    const p = projects.get(project) ?? projects.set(project, { ...emptyTotals(), project, lastAt: iso }).get(project)!;
    bump(p);
    if (iso > p.lastAt) p.lastAt = iso;
    const sessionId = m.session ?? "unknown";
    const s = sessions.get(sessionId) ?? sessions.set(sessionId, { ...emptyTotals(), sessionId, project, firstAt: iso, lastAt: iso, perModel: new Map() }).get(sessionId)!;
    bump(s);
    if (iso < s.firstAt) s.firstAt = iso;
    if (iso > s.lastAt) s.lastAt = iso;
    s.perModel.set(model, (s.perModel.get(model) ?? 0) + tokens);
  }

  const byTokens = <T extends UsageTotals>(a: T, b: T) => b.tokens - a.tokens;
  return {
    generatedAt: new Date(now).toISOString(),
    days,
    totals,
    daily: [...daily.values()],
    models: [...models.values()].sort(byTokens),
    accounts: [...accounts.values()].sort(byTokens),
    projects: [...projects.values()].sort(byTokens).slice(0, top),
    sessions: [...sessions.values()]
      .sort(byTokens)
      .slice(0, top)
      .map(({ perModel, ...s }) => {
        const main = [...perModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        return { ...s, ...(main ? { model: main } : {}) };
      }),
    unpricedModels: [...unpriced],
  };
}

function addTo(t: UsageTotals, m: TranscriptMessage, tokens: number, usd: number): void {
  t.tokens += tokens;
  t.freshInput += m.input - m.cacheRead - m.cacheWrite;
  t.output += m.output;
  t.cacheRead += m.cacheRead;
  t.cacheWrite += m.cacheWrite;
  t.costUsd += usd;
  t.messages += 1;
}
