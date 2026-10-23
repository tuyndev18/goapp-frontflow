import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { AccountDto, QuotaPointDto, UsageReportDto, UsageTotalsDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { durationText, formatTokens, formatUsd, nameOf } from "../lib/accounts.js";
import { Loading } from "../components/Loading.js";

const RANGES = [7, 14, 30] as const;
const RANGE_KEY = "ff-usage-days";
/** Categorical slots of the chart palette (styles.css --viz-1…8), assigned in fixed order. */
const SLOTS = 8;
const OTHER = "var(--viz-other)";
const NONE = "var(--viz-none)";
/** A line breaks where two polls are further apart than this. */
const LINE_GAP_MS = 6 * 3_600_000;

interface Series {
  key: string;
  label: string;
  color: string;
}

/**
 * Token usage of this computer's Claude Code sessions (from their transcripts), by day,
 * account, model, project and session, plus how each account's quota windows filled up.
 */
export function UsageScreen() {
  const [days, setDays] = useState<number>(readRange);
  const [report, setReport] = useState<UsageReportDto>();
  const [accounts, setAccounts] = useState<AccountDto[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [split, setSplit] = useState<"account" | "model">("account");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, s] = await Promise.all([api.invoke("accounts:usage", { days }), api.invoke("accounts:state")]);
      setReport(r);
      setAccounts(s.accounts);
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  function pickRange(d: number) {
    setDays(d);
    try {
      localStorage.setItem(RANGE_KEY, String(d));
    } catch {
      // Not remembered; the range still applies now.
    }
  }

  const accountSeries = seriesOfAccounts(accounts, report);
  const modelSeries = seriesOfModels(report);
  const series = split === "account" ? accountSeries : modelSeries;
  const cost = (usd: number) => `${report?.unpricedModels.length ? "≥" : "≈"} ${formatUsd(usd)}`;

  return (
    <div className="ff-screen ff-usage">
      <header className="ff-screen-header">
        <div>
          <span className="ff-eyebrow">This computer</span>
          <h1>Usage</h1>
          <p className="ff-muted">Tokens used by every Claude Code session on this machine — terminals, IDEs and FrontFlow — read from Claude's own transcripts.</p>
        </div>
        <div className="ff-actions">
          <div className="ff-seg" role="radiogroup" aria-label="Period">
            {RANGES.map((d) => (
              <button key={d} type="button" role="radio" aria-checked={days === d} className={`ff-seg-btn${days === d ? " ff-seg-active" : ""}`} onClick={() => pickRange(d)}>
                {d} days
              </button>
            ))}
          </div>
          <button type="button" className="ff-icon-btn ff-acc-icon" disabled={loading} onClick={() => void load()} title="Read the transcripts again" aria-label="Refresh">
            ↻
          </button>
        </div>
      </header>

      {error ? (
        <div className="ff-empty">
          <p>{error}</p>
        </div>
      ) : !report ? (
        <Loading label="Reading transcripts" />
      ) : (
        <>
          <section className="ff-usage-tiles" aria-label="Totals">
            <StatTile label="Today" totals={report.totals.today} cost={cost} />
            <StatTile label="Last 7 days" totals={report.totals.last7d} cost={cost} />
            <StatTile label={`Last ${report.days} days`} totals={report.totals.period} cost={cost} />
            <TokenMix totals={report.totals.period} />
          </section>

          <section className="ff-card ff-usage-card" aria-label="Tokens per day">
            <div className="ff-usage-card-head">
              <div>
                <h2>Tokens per day</h2>
                <p className="ff-muted ff-small">Input (cache included) + output, by {split === "account" ? "the account logged in at the time" : "model family"}.</p>
              </div>
              <div className="ff-seg" role="radiogroup" aria-label="Split by">
                {(["account", "model"] as const).map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={split === k} className={`ff-seg-btn${split === k ? " ff-seg-active" : ""}`} onClick={() => setSplit(k)}>
                    By {k}
                  </button>
                ))}
              </div>
            </div>
            <Legend series={series} />
            <DailyChart report={report} series={series} split={split} cost={cost} />
            <details className="ff-usage-table-toggle">
              <summary>Show as table</summary>
              <DailyTable report={report} series={series} split={split} cost={cost} />
            </details>
          </section>

          <div className="ff-usage-grid">
            <section className="ff-card ff-usage-card" aria-label="Models">
              <h2>Models</h2>
              <ModelBars report={report} cost={cost} />
            </section>
            <section className="ff-card ff-usage-card" aria-label="Accounts">
              <h2>Accounts</h2>
              <AccountBars report={report} series={accountSeries} cost={cost} />
            </section>
          </div>

          <section className="ff-card ff-usage-card" aria-label="Quota history">
            <h2>Quota used over time</h2>
            <p className="ff-muted ff-small">% of each account's window, as reported by Claude each time FrontFlow checked it.</p>
            {report.quotaHistory.length ? (
              <>
                <Legend series={accountSeries.filter((s) => s.key && report.quotaHistory.some((p) => p.accountId === s.key))} />
                <div className="ff-usage-grid">
                  <QuotaChart title="Session (5h)" windowKey="five_hour" points={report.quotaHistory} series={accountSeries} report={report} />
                  <QuotaChart title="Week (7d)" windowKey="seven_day" points={report.quotaHistory} series={accountSeries} report={report} />
                </div>
              </>
            ) : (
              <p className="ff-muted">No history yet: it builds up from now on, each time quota is checked.</p>
            )}
          </section>

          <section className="ff-card ff-usage-card" aria-label="Top projects">
            <h2>Top projects</h2>
            <ProjectsTable report={report} cost={cost} />
          </section>

          <section className="ff-card ff-usage-card" aria-label="Top sessions">
            <h2>Top sessions</h2>
            <SessionsTable report={report} cost={cost} />
          </section>

          <p className="ff-muted ff-small ff-usage-foot">
            Counted from Claude Code transcripts on this computer only. Cost is an estimate at API prices — Pro and Max plans are not billed per token.
            {report.unpricedModels.length ? ` No price for ${report.unpricedModels.join(", ")}, so costs are lower bounds.` : ""}
            {report.trackingSince ? ` Usage is attributed to accounts since ${new Date(report.trackingSince).toLocaleString()}.` : ""}
          </p>
        </>
      )}
    </div>
  );
}

function StatTile({ label, totals, cost }: { label: string; totals: UsageTotalsDto; cost(usd: number): string }) {
  return (
    <div className="ff-usage-tile">
      <span className="ff-usage-tile-label">{label}</span>
      <strong className="ff-usage-tile-value">{formatTokens(totals.tokens)}</strong>
      <span className="ff-muted ff-small">
        {cost(totals.costUsd)} · {totals.messages.toLocaleString()} messages
      </span>
    </div>
  );
}

/** Where the period's tokens went: mostly cache reads in long agent sessions. */
function TokenMix({ totals: t }: { totals: UsageTotalsDto }) {
  const parts = [
    { key: "cacheRead", label: "Cache read", value: t.cacheRead, color: "var(--viz-1)" },
    { key: "cacheWrite", label: "Cache write", value: t.cacheWrite, color: "var(--viz-2)" },
    { key: "fresh", label: "Fresh input", value: t.freshInput, color: "var(--viz-3)" },
    { key: "output", label: "Output", value: t.output, color: "var(--viz-4)" },
  ];
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div className="ff-usage-tile ff-usage-mix">
      <span className="ff-usage-tile-label">Token mix</span>
      <div className="ff-usage-mixbar" role="img" aria-label={parts.map((p) => `${p.label} ${pctText(p.value, total)}`).join(", ")}>
        {total ? parts.filter((p) => p.value > 0).map((p) => <span key={p.key} style={{ flexGrow: p.value, background: p.color }} title={`${p.label}: ${formatTokens(p.value)}`} />) : null}
      </div>
      <ul className="ff-usage-mixlegend">
        {parts.map((p) => (
          <li key={p.key}>
            <span className="ff-viz-swatch" style={{ background: p.color }} />
            {p.label} <span className="ff-muted">{pctText(p.value, total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="ff-viz-legend">
      {series.map((s) => (
        <li key={s.key}>
          <span className="ff-viz-swatch" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function valuesOf(day: UsageReportDto["daily"][number], series: Series[], split: "account" | "model"): number[] {
  if (split === "account") return series.map((s) => day.byAccount[s.key] ?? 0);
  const byFamily: Record<string, number> = {};
  for (const [model, n] of Object.entries(day.byModel)) byFamily[family(model)] = (byFamily[family(model)] ?? 0) + n;
  return series.map((s) => byFamily[s.key] ?? 0);
}

function DailyChart({ report, series, split, cost }: { report: UsageReportDto; series: Series[]; split: "account" | "model"; cost(usd: number): string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number>();
  const rows = report.daily.map((d) => ({ day: d, values: valuesOf(d, series, split) }));
  const H = 240;
  const pad = { l: 48, r: 8, t: 10, b: 24 };
  const plotW = Math.max(0, width - pad.l - pad.r);
  const plotH = H - pad.t - pad.b;
  const max = niceMax(Math.max(0, ...rows.map((r) => r.day.total.tokens)));
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;
  const band = rows.length ? plotW / rows.length : 0;
  const bw = Math.min(24, Math.max(2, band * 0.62));
  const every = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor(plotW / 56))));
  const hovered = hover === undefined ? undefined : rows[hover];

  return (
    <div className="ff-viz-chart" ref={ref} onMouseLeave={() => setHover(undefined)}>
      {width > 0 ? (
        <svg width={width} height={H} role="img" aria-label={`Tokens per day over the last ${report.days} days`}>
          {[0, max / 2, max].map((t) => (
            <g key={t}>
              <line className={t === 0 ? "ff-viz-axis" : "ff-viz-grid"} x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} />
              <text className="ff-viz-tick" x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {formatTokens(t)}
              </text>
            </g>
          ))}
          {hover !== undefined ? <rect className="ff-viz-hoverband" x={pad.l + hover * band} y={pad.t} width={band} height={plotH} /> : null}
          {rows.map((r, i) => {
            const x = pad.l + i * band + (band - bw) / 2;
            const segs = r.values.map((v, k) => ({ v, color: series[k]!.color })).filter((s) => s.v > 0);
            let acc = 0;
            return (
              <g key={r.day.date}>
                {segs.map((s, j) => {
                  const bottom = y(acc) - (j > 0 ? 2 : 0);
                  acc += s.v;
                  const top = y(acc);
                  const h = bottom - top;
                  if (h <= 0) return null;
                  return j === segs.length - 1 ? <path key={j} d={roundedTop(x, top, bw, h, Math.min(4, h, bw / 2))} fill={s.color} /> : <rect key={j} x={x} y={top} width={bw} height={h} fill={s.color} />;
                })}
                {i % every === 0 || i === rows.length - 1 ? (
                  <text className="ff-viz-tick" x={pad.l + (i + 0.5) * band} y={H - 6} textAnchor="middle">
                    {shortDate(r.day.date)}
                  </text>
                ) : null}
                <rect x={pad.l + i * band} y={pad.t} width={band} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
        </svg>
      ) : null}
      {hovered ? (
        <div className="ff-viz-tip" style={{ left: clamp(pad.l + (hover! + 0.5) * band, 110, width - 110), top: pad.t }}>
          <strong>{longDate(hovered.day.date)}</strong>
          <span>
            {formatTokens(hovered.day.total.tokens)} tokens · {cost(hovered.day.total.costUsd)}
          </span>
          {series.map((s, k) =>
            hovered.values[k] ? (
              <span key={s.key} className="ff-viz-tip-row">
                <span className="ff-viz-swatch" style={{ background: s.color }} />
                {s.label}
                <b>{formatTokens(hovered.values[k]!)}</b>
              </span>
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}

function DailyTable({ report, series, split, cost }: { report: UsageReportDto; series: Series[]; split: "account" | "model"; cost(usd: number): string }) {
  return (
    <div className="ff-usage-scroll">
      <table className="ff-usage-table">
        <thead>
          <tr>
            <th>Day</th>
            {series.map((s) => (
              <th key={s.key} className="ff-num">
                {s.label}
              </th>
            ))}
            <th className="ff-num">Total</th>
            <th className="ff-num">Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {[...report.daily].reverse().map((d) => {
            const values = valuesOf(d, series, split);
            return (
              <tr key={d.date}>
                <td>{longDate(d.date)}</td>
                {values.map((v, k) => (
                  <td key={series[k]!.key} className="ff-num">
                    {v ? formatTokens(v) : "—"}
                  </td>
                ))}
                <td className="ff-num">{formatTokens(d.total.tokens)}</td>
                <td className="ff-num">{d.total.costUsd ? cost(d.total.costUsd) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ModelBars({ report, cost }: { report: UsageReportDto; cost(usd: number): string }) {
  const max = Math.max(1, ...report.models.map((m) => m.tokens));
  if (!report.models.length) return <p className="ff-muted">No messages in this period.</p>;
  return (
    <ul className="ff-usage-bars">
      {report.models.map((m) => (
        <li key={m.model}>
          <span className="ff-usage-bars-label ff-mono" title={m.model}>
            <span className="ff-viz-swatch" style={{ background: familyColor(family(m.model)) }} />
            {m.model}
          </span>
          <span className="ff-usage-bars-track">
            <span style={{ width: `${(m.tokens / max) * 100}%`, background: familyColor(family(m.model)) }} />
          </span>
          <span className="ff-usage-bars-value">
            {formatTokens(m.tokens)} <span className="ff-muted">{cost(m.costUsd)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function AccountBars({ report, series, cost }: { report: UsageReportDto; series: Series[]; cost(usd: number): string }) {
  const max = Math.max(1, ...report.accounts.map((a) => a.tokens));
  if (!report.accounts.length) return <p className="ff-muted">No messages in this period.</p>;
  return (
    <ul className="ff-usage-bars">
      {report.accounts.map((a) => {
        const s = series.find((x) => x.key === (a.accountId ?? "")) ?? { key: "", label: a.accountId?.slice(0, 8) ?? "Not attributed", color: OTHER };
        return (
          <li key={s.key || "none"}>
            <span className="ff-usage-bars-label">
              <span className="ff-viz-swatch" style={{ background: s.color }} />
              {s.label}
            </span>
            <span className="ff-usage-bars-track">
              <span style={{ width: `${(a.tokens / max) * 100}%`, background: s.color }} />
            </span>
            <span className="ff-usage-bars-value">
              {formatTokens(a.tokens)} <span className="ff-muted">{cost(a.costUsd)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function QuotaChart({ title, windowKey, points, series, report }: { title: string; windowKey: string; points: QuotaPointDto[]; series: Series[]; report: UsageReportDto }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hoverAt, setHoverAt] = useState<number>();
  const now = Date.parse(report.generatedAt);
  const from = now - report.days * 86_400_000;
  const H = 180;
  const pad = { l: 40, r: 12, t: 10, b: 24 };
  const plotW = Math.max(0, width - pad.l - pad.r);
  const plotH = H - pad.t - pad.b;
  const x = (t: number) => pad.l + ((t - from) / (now - from)) * plotW;
  const y = (v: number) => pad.t + plotH - (Math.min(100, Math.max(0, v)) / 100) * plotH;
  const lines = series
    .filter((s) => s.key)
    .map((s) => ({ s, pts: points.filter((p) => p.accountId === s.key && typeof p.windows[windowKey] === "number").map((p) => ({ t: Date.parse(p.at), v: p.windows[windowKey]! })).sort((a, b) => a.t - b.t) }))
    .filter((l) => l.pts.length);
  if (!lines.length) {
    return (
      <div>
        <h3 className="ff-usage-h3">{title}</h3>
        <p className="ff-muted ff-small">No data for this window.</p>
      </div>
    );
  }
  const ticks = Array.from({ length: 5 }, (_, i) => from + ((now - from) * i) / 4);
  const at = (pts: Array<{ t: number; v: number }>, t: number) => {
    let found: { t: number; v: number } | undefined;
    for (const p of pts) {
      if (p.t > t) break;
      found = p;
    }
    return found && t - found.t <= LINE_GAP_MS ? found : undefined;
  };

  return (
    <div>
      <h3 className="ff-usage-h3">{title}</h3>
      <div
        className="ff-viz-chart"
        ref={ref}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - box.left;
          setHoverAt(px < pad.l || px > width - pad.r ? undefined : from + ((px - pad.l) / plotW) * (now - from));
        }}
        onMouseLeave={() => setHoverAt(undefined)}
      >
        {width > 0 ? (
          <svg width={width} height={H} role="img" aria-label={`${title}: % used per account over the last ${report.days} days`}>
            {[0, 50, 100].map((v) => (
              <g key={v}>
                <line className={v === 0 ? "ff-viz-axis" : "ff-viz-grid"} x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} />
                <text className="ff-viz-tick" x={pad.l - 8} y={y(v)} dy="0.32em" textAnchor="end">
                  {v}%
                </text>
              </g>
            ))}
            {ticks.map((t, i) => (
              <text key={i} className="ff-viz-tick" x={x(t)} y={H - 6} textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}>
                {shortDate(new Date(t))}
              </text>
            ))}
            {lines.map(({ s, pts }) => (
              <g key={s.key}>
                <path className="ff-viz-line" d={linePath(pts, x, y)} stroke={s.color} />
                <circle className="ff-viz-dot" cx={x(pts[pts.length - 1]!.t)} cy={y(pts[pts.length - 1]!.v)} r={4} fill={s.color} />
              </g>
            ))}
            {hoverAt !== undefined ? (
              <g>
                <line className="ff-viz-crosshair" x1={x(hoverAt)} x2={x(hoverAt)} y1={pad.t} y2={pad.t + plotH} />
                {lines.map(({ s, pts }) => {
                  const p = at(pts, hoverAt);
                  return p ? <circle key={s.key} className="ff-viz-dot" cx={x(hoverAt)} cy={y(p.v)} r={4} fill={s.color} /> : null;
                })}
              </g>
            ) : null}
          </svg>
        ) : null}
        {hoverAt !== undefined ? (
          <div className="ff-viz-tip" style={{ left: clamp(x(hoverAt), 100, width - 100), top: pad.t }}>
            <strong>{new Date(hoverAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</strong>
            {lines.map(({ s, pts }) => {
              const p = at(pts, hoverAt);
              return (
                <span key={s.key} className="ff-viz-tip-row">
                  <span className="ff-viz-swatch" style={{ background: s.color }} />
                  {s.label}
                  <b>{p ? `${Math.round(p.v)}%` : "—"}</b>
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ProjectsTable({ report, cost }: { report: UsageReportDto; cost(usd: number): string }) {
  if (!report.projects.length) return <p className="ff-muted">No messages in this period.</p>;
  const max = Math.max(1, ...report.projects.map((p) => p.tokens));
  const now = Date.parse(report.generatedAt);
  return (
    <div className="ff-usage-scroll">
      <table className="ff-usage-table">
        <thead>
          <tr>
            <th>Project</th>
            <th className="ff-num">Tokens</th>
            <th className="ff-num">Est. cost</th>
            <th className="ff-num">Messages</th>
            <th className="ff-num">Last active</th>
          </tr>
        </thead>
        <tbody>
          {report.projects.map((p) => (
            <tr key={p.project}>
              <td className="ff-usage-proj" title={p.project}>
                <strong>{baseName(p.project)}</strong>
                <span className="ff-muted ff-mono">{p.project}</span>
              </td>
              <td className="ff-num">
                <InlineBar value={p.tokens} max={max} />
              </td>
              <td className="ff-num">{cost(p.costUsd)}</td>
              <td className="ff-num">{p.messages.toLocaleString()}</td>
              <td className="ff-num">{durationText(now - Date.parse(p.lastAt))} ago</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionsTable({ report, cost }: { report: UsageReportDto; cost(usd: number): string }) {
  if (!report.sessions.length) return <p className="ff-muted">No messages in this period.</p>;
  const max = Math.max(1, ...report.sessions.map((s) => s.tokens));
  const now = Date.parse(report.generatedAt);
  return (
    <div className="ff-usage-scroll">
      <table className="ff-usage-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Model</th>
            <th className="ff-num">Tokens</th>
            <th className="ff-num">Est. cost</th>
            <th className="ff-num">Messages</th>
            <th className="ff-num">Span</th>
            <th className="ff-num">Last active</th>
          </tr>
        </thead>
        <tbody>
          {report.sessions.map((s) => (
            <tr key={s.sessionId}>
              <td className="ff-usage-proj" title={`${s.project}\n${s.sessionId}`}>
                <strong>{baseName(s.project)}</strong>
                <span className="ff-muted ff-mono">{s.sessionId.slice(0, 8)}</span>
              </td>
              <td>{s.model ? <span className="ff-mono ff-small">{s.model}</span> : "—"}</td>
              <td className="ff-num">
                <InlineBar value={s.tokens} max={max} />
              </td>
              <td className="ff-num">{cost(s.costUsd)}</td>
              <td className="ff-num">{s.messages.toLocaleString()}</td>
              <td className="ff-num">{durationText(Date.parse(s.lastAt) - Date.parse(s.firstAt))}</td>
              <td className="ff-num">{durationText(now - Date.parse(s.lastAt))} ago</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InlineBar({ value, max }: { value: number; max: number }) {
  return (
    <span className="ff-usage-inline">
      <span className="ff-usage-inline-track">
        <span style={{ width: `${(value / max) * 100}%` }} />
      </span>
      {formatTokens(value)}
    </span>
  );
}

/** Saved accounts in slot order (the order they were added), so a colour never moves. */
function seriesOfAccounts(accounts: AccountDto[], report: UsageReportDto | undefined): Series[] {
  const sorted = [...accounts].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  const out: Series[] = sorted.map((a, i) => ({ key: a.id, label: nameOf(a), color: i < SLOTS - 1 ? `var(--viz-${i + 1})` : OTHER }));
  // Usage of accounts removed since: one gray series each, after the saved ones.
  for (const a of report?.accounts ?? []) {
    if (a.accountId && !out.some((s) => s.key === a.accountId)) out.push({ key: a.accountId, label: `removed ${a.accountId.slice(0, 8)}`, color: OTHER });
  }
  if (report?.accounts.some((a) => a.accountId === null)) out.push({ key: "", label: "Not attributed", color: NONE });
  return out;
}

const FAMILIES = ["Opus", "Sonnet", "Haiku", "Other"] as const;
type Family = (typeof FAMILIES)[number];

function family(model: string): Family {
  const m = model.toLowerCase();
  return m.includes("opus") ? "Opus" : m.includes("sonnet") ? "Sonnet" : m.includes("haiku") ? "Haiku" : "Other";
}

function familyColor(f: Family): string {
  return f === "Other" ? OTHER : `var(--viz-${FAMILIES.indexOf(f) + 1})`;
}

function seriesOfModels(report: UsageReportDto | undefined): Series[] {
  const present = new Set((report?.models ?? []).map((m) => family(m.model)));
  return FAMILIES.filter((f) => present.has(f)).map((f) => ({ key: f, label: f, color: familyColor(f) }));
}

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Rectangle with rounded top corners, square at the baseline. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function linePath(pts: Array<{ t: number; v: number }>, x: (t: number) => number, y: (v: number) => number): string {
  return pts.map((p, i) => `${i === 0 || p.t - pts[i - 1]!.t > LINE_GAP_MS ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
}

/** 1, 2 or 5 × 10ⁿ at or above `n`, so the axis ends on a round value. */
function niceMax(n: number): number {
  if (n <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  return ([1, 2, 5, 10].find((m) => m * p >= n) ?? 10) * p;
}

function clamp(v: number, lo: number, hi: number): number {
  return hi < lo ? v : Math.min(hi, Math.max(lo, v));
}

function pctText(v: number, total: number): string {
  return total ? `${Math.round((v / total) * 100)}%` : "—";
}

function shortDate(d: string | Date): string {
  return (typeof d === "string" ? new Date(`${d}T00:00`) : d).toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}

function longDate(d: string): string {
  return new Date(`${d}T00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function readRange(): number {
  try {
    const n = Number(localStorage.getItem(RANGE_KEY));
    return (RANGES as readonly number[]).includes(n) ? n : 30;
  } catch {
    return 30;
  }
}
