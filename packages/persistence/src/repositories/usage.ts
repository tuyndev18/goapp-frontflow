import type { SqlDriver, SqlRow } from "../driver.js";
import { nullable, num, str } from "../sql.js";

export type UsageScope = "message" | "turn" | "total";

/** One normalized usage report. Counts only — never prompt or output text. */
export interface UsageEventRecord {
  /** Dedup key: a re-reported API message keeps one row (last report wins). */
  eventId: string;
  projectId: string;
  sessionId: string;
  /** Adapter id, e.g. "claude-code". */
  provider: string;
  accountId?: string;
  model?: string;
  scope: UsageScope;
  occurredAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sourceCostUsd?: number;
  estimatedCostUsd?: number;
  pricingVersion?: string;
  /** Where the numbers came from, e.g. "claude-code:stream-json". */
  rawSource: string;
  parserVersion: number;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of the estimates that could be made; see `unpricedModels` for what is missing. */
  estimatedCostUsd: number;
  /** Latest cost the CLI itself reported, when it reports one. */
  sourceCostUsd?: number;
  models: string[];
  /** Models (or "unknown") whose usage has no estimate: the cost above is a lower bound. */
  unpricedModels: string[];
  /** "fine": per message/turn reports; "total": only the CLI's running totals were available. */
  basis: "fine" | "total";
}

export function emptyUsage(): UsageSummary {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, models: [], unpricedModels: [], basis: "fine" };
}

/** Adds `b` into `a` (project totals from session summaries). */
export function addUsage(a: UsageSummary, b: UsageSummary): UsageSummary {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
    ...(a.sourceCostUsd !== undefined || b.sourceCostUsd !== undefined ? { sourceCostUsd: (a.sourceCostUsd ?? 0) + (b.sourceCostUsd ?? 0) } : {}),
    models: [...new Set([...a.models, ...b.models])].sort(),
    unpricedModels: [...new Set([...a.unpricedModels, ...b.unpricedModels])].sort(),
    basis: a.basis === "total" || b.basis === "total" ? "total" : "fine",
  };
}

export class UsageRepository {
  constructor(private readonly db: SqlDriver) {}

  /** Upsert by event id. */
  record(e: UsageEventRecord): void {
    this.db
      .prepare(
        `INSERT INTO usage_events (event_id, project_id, session_id, provider, account_id, model, scope, occurred_at,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, source_cost_usd, estimated_cost_usd,
           pricing_version, raw_source, parser_version)
         VALUES (@eventId, @projectId, @sessionId, @provider, @accountId, @model, @scope, @occurredAt,
           @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens, @sourceCostUsd, @estimatedCostUsd,
           @pricingVersion, @rawSource, @parserVersion)
         ON CONFLICT(event_id) DO UPDATE SET model = excluded.model, occurred_at = excluded.occurred_at,
           input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
           cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
           source_cost_usd = excluded.source_cost_usd, estimated_cost_usd = excluded.estimated_cost_usd,
           pricing_version = excluded.pricing_version, parser_version = excluded.parser_version`,
      )
      .run({
        eventId: e.eventId,
        projectId: e.projectId,
        sessionId: e.sessionId,
        provider: e.provider,
        accountId: nullable(e.accountId),
        model: nullable(e.model),
        scope: e.scope,
        occurredAt: e.occurredAt,
        inputTokens: Math.max(0, Math.round(e.inputTokens)),
        outputTokens: Math.max(0, Math.round(e.outputTokens)),
        cacheReadTokens: Math.max(0, Math.round(e.cacheReadTokens)),
        cacheWriteTokens: Math.max(0, Math.round(e.cacheWriteTokens)),
        sourceCostUsd: nullable(e.sourceCostUsd),
        estimatedCostUsd: nullable(e.estimatedCostUsd),
        pricingVersion: nullable(e.pricingVersion),
        rawSource: e.rawSource,
        parserVersion: e.parserVersion,
      });
  }

  /**
   * Usage per session of a project. Message/turn reports are summed; a session with only
   * running totals (e.g. interactive transcripts) uses its latest total, never both.
   */
  bySession(projectId: string): Map<string, UsageSummary> {
    const out = new Map<string, UsageSummary>();
    const fine = this.db
      .prepare(
        `SELECT session_id, model, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cache_read_tokens) AS cr,
           SUM(cache_write_tokens) AS cw, SUM(COALESCE(estimated_cost_usd, 0)) AS cost,
           SUM(CASE WHEN estimated_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
         FROM usage_events WHERE project_id = @projectId AND scope != 'total'
         GROUP BY session_id, model`,
      )
      .all({ projectId });
    for (const row of fine) {
      const id = String(row.session_id);
      out.set(id, addUsage(out.get(id) ?? emptyUsage(), toSummary(row, "fine")));
    }
    const totals = this.db
      .prepare(
        `SELECT * FROM (
           SELECT session_id, model, input_tokens AS i, output_tokens AS o, cache_read_tokens AS cr, cache_write_tokens AS cw,
             estimated_cost_usd AS cost, source_cost_usd AS source, CASE WHEN estimated_cost_usd IS NULL THEN 1 ELSE 0 END AS unpriced,
             ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY occurred_at DESC, rowid DESC) AS rn
           FROM usage_events WHERE project_id = @projectId AND scope = 'total'
         ) WHERE rn = 1`,
      )
      .all({ projectId });
    for (const row of totals) {
      const id = String(row.session_id);
      const source = row.source === null || row.source === undefined ? undefined : num(row.source);
      const existing = out.get(id);
      if (existing) {
        if (source !== undefined) existing.sourceCostUsd = source;
      } else {
        out.set(id, { ...toSummary(row, "total"), ...(source !== undefined ? { sourceCostUsd: source } : {}) });
      }
    }
    return out;
  }

  /** Project total and the per-session summaries it adds up. */
  forProject(projectId: string): { total: UsageSummary; sessions: Map<string, UsageSummary> } {
    const sessions = this.bySession(projectId);
    let total = emptyUsage();
    for (const s of sessions.values()) total = addUsage(total, s);
    return { total, sessions };
  }
}

function toSummary(row: SqlRow, basis: UsageSummary["basis"]): UsageSummary {
  const model = str(row.model);
  return {
    inputTokens: num(row.i),
    outputTokens: num(row.o),
    cacheReadTokens: num(row.cr),
    cacheWriteTokens: num(row.cw),
    estimatedCostUsd: num(row.cost),
    models: model ? [model] : [],
    unpricedModels: num(row.unpriced) > 0 ? [model ?? "unknown"] : [],
    basis,
  };
}
