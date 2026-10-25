import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NodeRun } from "@frontflow/domain";
import { visualStateForNode } from "@frontflow/ui-components";
import { formatDuration, formatTime } from "../lib/activity.js";
import { toolDiff, toolTitle, toolTodos, relative, type NoteItem, type ToolItem, type TranscriptItem } from "../lib/transcript.js";
import { Markdown } from "./Markdown.js";

/** Long runs keep the page light: older items load on demand. */
const PAGE = 300;
/** Lifecycle the step header already shows: no divider of its own in the run view. */
const QUIET_STATUSES = new Set(["running", "passed"]);

/** What is drawn on the thread: one item, or several plain notes folded into one line. */
type Row = { kind: "item"; item: TranscriptItem } | { kind: "notes"; id: string; notes: NoteItem[] };

/**
 * A run's or a step's activity, read like a Claude Code conversation in the VS Code extension: the
 * AI's messages as text and each tool call as one line ("Read src/x.ts", "Bash npm test") that
 * opens to its diff, command and output, on one thread. Warnings, failures and "needs you" stand
 * out; routine notes fold into one line. In the run view each step's activity is a block headed by
 * its state; finished steps fold to a one-line summary, and the step name opens the step.
 */
export function ActivityFeed({
  items,
  stepLabels,
  stepRuns,
  showStep,
  projectRoot,
  onSelectStep,
  defaultVerbose = false,
  emptyText = "Nothing has happened yet.",
}: {
  items: TranscriptItem[];
  stepLabels?: Map<string, string>;
  /** Latest run of each step: its state in the block header. */
  stepRuns?: Map<string, NodeRun>;
  showStep: boolean;
  /** Paths inside the project are shown relative to it. */
  projectRoot?: string;
  onSelectStep?(nodeId: string): void;
  defaultVerbose?: boolean;
  emptyText?: string;
}) {
  const [verbose, setVerbose] = useState(defaultVerbose);
  const [follow, setFollow] = useState(true);
  const [limit, setLimit] = useState(PAGE);
  /** Blocks the user folded or opened, by key; the others follow their step's state. */
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const scroller = useRef<HTMLDivElement>(null);
  const all = verbose ? items : items.filter((i) => i.kind !== "note" || !i.verbose);
  const visible = all.slice(-limit);
  const last = visible.at(-1);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [visible.length, follow, last?.kind === "tool" ? last.status : last?.kind === "text" ? last.text : last?.id]);

  useEffect(() => setVerbose(defaultVerbose), [defaultVerbose]);

  const blocks = showStep ? sections(visible) : [{ nodeId: undefined, items: visible }];

  return (
    <div className="ff-feed">
      <div className="ff-feed-toolbar">
        <label className="ff-checkbox ff-small">
          <input type="checkbox" checked={verbose} onChange={(e) => setVerbose(e.target.checked)} />
          Show details
        </label>
        {!follow ? (
          <button type="button" className="ff-btn ff-btn-small" onClick={() => setFollow(true)}>
            ↓ Follow live
          </button>
        ) : (
          <span className="ff-live">● Live</span>
        )}
      </div>
      <div
        className="ff-feed-body ff-tx"
        ref={scroller}
        role="log"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
      >
        {visible.length === 0 ? <p className="ff-muted ff-feed-empty">{emptyText}</p> : null}
        {all.length > visible.length ? (
          <button type="button" className="ff-btn ff-btn-small ff-tx-more" onClick={() => setLimit((l) => l + PAGE)}>
            Show {Math.min(PAGE, all.length - visible.length)} earlier
          </button>
        ) : null}
        {blocks.map((block, i) => {
          const key = block.items[0]?.id ?? "empty";
          if (!showStep) return <Thread key={key} rows={toRows(block.items, false)} root={projectRoot} />;
          if (!block.nodeId) return <RunNotes key={key} items={block.items} />;
          const nr = stepRuns?.get(block.nodeId);
          const isLast = i === blocks.length - 1;
          // Finished steps fold, unless they are the latest activity; the user's choice wins.
          const settled = nr ? ["passed", "skipped"].includes(nr.status) : false;
          const open = folded[key] === undefined ? !settled || isLast : !folded[key];
          return (
            <StepBlock
              key={key}
              nodeId={block.nodeId}
              label={stepLabels?.get(block.nodeId) ?? block.nodeId}
              nodeRun={nr}
              items={block.items}
              open={open}
              root={projectRoot}
              onToggle={() => setFolded((f) => ({ ...f, [key]: open }))}
              {...(onSelectStep ? { onOpenStep: onSelectStep } : {})}
            />
          );
        })}
      </div>
    </div>
  );
}

function StepBlock({
  nodeId,
  label,
  nodeRun,
  items,
  open,
  root,
  onToggle,
  onOpenStep,
}: {
  nodeId: string;
  label: string;
  nodeRun: NodeRun | undefined;
  items: TranscriptItem[];
  open: boolean;
  root: string | undefined;
  onToggle(): void;
  onOpenStep?(nodeId: string): void;
}) {
  const spec = visualStateForNode(nodeRun?.status);
  const duration = nodeRun?.startedAt && nodeRun.finishedAt ? Date.parse(nodeRun.finishedAt) - Date.parse(nodeRun.startedAt) : undefined;
  const messages = items.filter((i) => i.kind === "text").length;
  const tools = items.filter((i) => i.kind === "tool").length;
  const failedTools = items.filter((i) => i.kind === "tool" && i.status === "failed").length;
  const summary = [messages ? `${messages} message${messages === 1 ? "" : "s"}` : "", tools ? `${tools} tool call${tools === 1 ? "" : "s"}` : "", failedTools ? `${failedTools} failed` : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <section className={`ff-tx-block ff-tx-block-${spec.tone}`}>
      <div className="ff-tx-block-head">
        <button type="button" className="ff-tx-fold" aria-expanded={open} aria-label={open ? `Fold ${label}` : `Unfold ${label}`} onClick={onToggle}>
          {open ? "▾" : "▸"}
        </button>
        <span className={`ff-tx-block-icon${spec.animated ? " ff-spin" : ""}`} aria-label={spec.label}>
          {spec.icon}
        </span>
        <button type="button" className="ff-tx-block-name" onClick={() => onOpenStep?.(nodeId)} disabled={!onOpenStep} title="Open this step">
          {label}
        </button>
        {!open && summary ? <span className="ff-tx-block-summary">{summary}</span> : null}
        <span className="ff-grow" />
        {duration !== undefined ? <span className="ff-tx-time">{formatDuration(duration)}</span> : null}
        <span className="ff-tx-time">{formatTime(items[0]?.timestamp ?? "")}</span>
      </div>
      {open ? <Thread rows={toRows(items, true)} root={root} /> : null}
    </section>
  );
}

/** One thread: the dots of every row sit on one vertical line. */
function Thread({ rows, root }: { rows: Row[]; root: string | undefined }) {
  if (!rows.length) return null;
  let minute = "";
  return (
    <div className="ff-tx-thread">
      {rows.map((row) => {
        const at = row.kind === "notes" ? row.notes[0]?.timestamp : row.item.timestamp;
        const stamp = at ? formatMinute(at) : "";
        // The time is written once per minute, on the right, as in the Claude Code extension.
        const showStamp = stamp && stamp !== minute;
        minute = stamp || minute;
        const key = row.kind === "notes" ? row.id : row.item.id;
        return (
          <div key={key}>
            {showStamp ? <div className="ff-tx-stamp">{stamp}</div> : null}
            {row.kind === "notes" ? <NotesRow notes={row.notes} /> : <Item item={row.item} root={root} />}
          </div>
        );
      })}
    </div>
  );
}

function formatMinute(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Run-level lines (started, resumed, completed) between the steps, without repeats. */
function RunNotes({ items }: { items: TranscriptItem[] }) {
  const notes = items.filter((i): i is NoteItem => i.kind === "note").filter((n, i, all) => n.text !== all[i - 1]?.text);
  return (
    <>
      {notes.map((n) => (
        <div key={n.id} className={`ff-tx-run ff-feed-${n.tone}`}>
          <span>
            {n.icon} {n.text}
          </span>
          <span className="ff-tx-time">{formatTime(n.timestamp)}</span>
        </div>
      ))}
    </>
  );
}

/** Consecutive items of the same step (run-level items have none). */
function sections(items: TranscriptItem[]): Array<{ nodeId: string | undefined; items: TranscriptItem[] }> {
  const out: Array<{ nodeId: string | undefined; items: TranscriptItem[] }> = [];
  for (const item of items) {
    const last = out.at(-1);
    if (last && last.nodeId === item.nodeId) last.items.push(item);
    else out.push({ nodeId: item.nodeId, items: [item] });
  }
  return out;
}

/** Routine notes in a row fold into one line; in a step block, its own started/done is in the header. */
function toRows(items: TranscriptItem[], inBlock: boolean): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    if (inBlock && item.kind === "note" && item.milestone && item.status && QUIET_STATUSES.has(item.status) && !/^Attempt/.test(item.text)) continue;
    if (isRoutine(item)) {
      const prev = rows.at(-1);
      if (prev?.kind === "notes") prev.notes.push(item);
      else rows.push({ kind: "notes", id: item.id, notes: [item] });
      continue;
    }
    rows.push({ kind: "item", item });
  }
  return rows;
}

function isRoutine(item: TranscriptItem): item is NoteItem {
  return item.kind === "note" && !item.milestone && !item.detail && (item.tone === "neutral" || item.tone === "muted" || item.tone === "info" || item.tone === "ai");
}

function NotesRow({ notes }: { notes: NoteItem[] }) {
  const [open, setOpen] = useState(false);
  const [first] = notes;
  if (!first) return null;
  if (notes.length === 1) {
    return (
      <div className="ff-tx-row ff-tx-notes" title={formatTime(first.timestamp)}>
        <span className="ff-tx-mark ff-tx-mark-note" aria-hidden="true" />
        <span className="ff-tx-note-text">{first.text}</span>
      </div>
    );
  }
  return (
    <div className="ff-tx-row ff-tx-notes">
      <span className="ff-tx-mark ff-tx-mark-note" aria-hidden="true" />
      <div className="ff-tx-note-text">
        <button type="button" className="ff-tx-notes-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          ⓘ {notes.length} details {open ? "▾" : "▸"}
        </button>
        {open ? (
          <ul className="ff-tx-notes-list">
            {notes.map((n) => (
              <li key={n.id} title={formatTime(n.timestamp)}>
                {n.text}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

const Item = memo(function Item({ item, root }: { item: TranscriptItem; root: string | undefined }) {
  switch (item.kind) {
    case "text":
      return (
        <div className="ff-tx-row ff-tx-msg" title={formatTime(item.timestamp)}>
          <span className="ff-tx-mark ff-tx-mark-text" aria-hidden="true" />
          <Markdown source={item.text} className="ff-tx-md" />
        </div>
      );
    case "user":
      return (
        <div className="ff-tx-user" title={formatTime(item.timestamp)}>
          {item.text}
        </div>
      );
    case "tool":
      return <ToolRow item={item} root={root} />;
    case "note":
      return <NoteRow item={item} />;
  }
});

/** Lines of a text, for the counts under a tool line. */
function lineCount(text: string | undefined): number {
  return text ? text.replace(/\n$/, "").split("\n").length : 0;
}

/** The muted line under a tool call: what it amounted to. */
function toolSubtitle(item: ToolItem, diff: ReturnType<typeof toolDiff>): string {
  if (item.status === "running") return "Running…";
  const added = diff?.filter((l) => l.sign === "+").length ?? 0;
  const removed = diff?.filter((l) => l.sign === "-").length ?? 0;
  switch (item.name) {
    case "Write":
      return `${added} line${added === 1 ? "" : "s"}`;
    case "Edit":
    case "MultiEdit":
      return [added ? `Added ${added} line${added === 1 ? "" : "s"}` : "", removed ? `removed ${removed}` : ""].filter(Boolean).join(", ") || "No change";
    case "Read":
      return item.output ? `Read ${lineCount(item.output)} lines` : "";
    case "Grep":
    case "Glob":
      return item.output ? `${lineCount(item.output)} result${lineCount(item.output) === 1 ? "" : "s"}` : "No results";
    default:
      return item.status === "failed" ? "Failed" : "";
  }
}

/**
 * One tool call: the verb in bold and its target, a muted line with what it amounted to, and for
 * edits and commands a short preview (the diff, or IN/OUT) that opens in full on click.
 */
function ToolRow({ item, root }: { item: ToolItem; root: string | undefined }) {
  const [open, setOpen] = useState(false);
  const { verb, target } = toolTitle(item, root);
  const todos = toolTodos(item);
  const diff = toolDiff(item);
  const command = typeof item.input["command"] === "string" ? (item.input["command"] as string) : undefined;
  const subtitle = toolSubtitle(item, diff);
  // Edits and commands always show a preview; other calls (reads, searches, MCP) open on click.
  const preview = !!(diff?.length || command);
  const details = !preview && !todos && !!(item.output || Object.keys(item.input).length);
  const status = item.status === "running" ? "running" : item.status === "failed" ? "failed" : "done";
  const expanded = open || item.status === "failed";
  return (
    <div className={`ff-tx-row ff-tx-tool ff-tx-tool-${item.status}`} title={`${formatTime(item.timestamp)} · ${status}`}>
      <span className={`ff-tx-mark ff-tx-mark-${item.status}`} aria-label={status} />
      <div className="ff-tx-tool-main">
        <button type="button" className="ff-tx-tool-head" aria-expanded={preview || details ? open : undefined} disabled={!preview && !details} onClick={() => setOpen((o) => !o)}>
          <span className="ff-tx-verb">{verb}</span>
          <span className="ff-tx-target">{target}</span>
          {item.status === "failed" ? <span className="ff-tx-failed">failed</span> : null}
        </button>
        {subtitle ? <div className="ff-tx-sub">{subtitle}</div> : null}
        {todos ? (
          <ul className="ff-tx-todos">
            {todos.map((t, n) => (
              <li key={n} className={`ff-tx-todo-${t.status}`}>
                <span aria-hidden="true">{t.status === "completed" ? "☑" : t.status === "in_progress" ? "◐" : "☐"}</span> {t.content}
              </li>
            ))}
          </ul>
        ) : null}
        {diff?.length ? (
          <pre className={`ff-tx-preview ff-tx-diff${expanded ? " ff-tx-open" : ""}`} onClick={() => setOpen((o) => !o)}>
            {diff.slice(0, expanded ? 400 : 8).map((l, n) => (
              <span key={n} className={l.sign === "+" ? "ff-tx-add-line" : l.sign === "-" ? "ff-tx-del-line" : undefined}>
                {l.sign} {l.text}
                {"\n"}
              </span>
            ))}
            {expanded && diff.length > 400 ? `… ${diff.length - 400} more lines\n` : null}
          </pre>
        ) : command ? (
          <div className={`ff-tx-preview ff-tx-io${item.status === "failed" ? " ff-tx-io-failed" : ""}${expanded ? " ff-tx-open" : ""}`} onClick={() => setOpen((o) => !o)}>
            <span className="ff-tx-io-label">IN</span>
            <pre>{command}</pre>
            {item.output ? (
              <>
                <span className="ff-tx-io-label">OUT</span>
                <pre>{relativeOutput(item.output, root)}</pre>
              </>
            ) : null}
          </div>
        ) : null}
        {details && open ? (
          <div className="ff-tx-preview ff-tx-io ff-tx-open">
            {Object.keys(item.input).length ? (
              <>
                <span className="ff-tx-io-label">IN</span>
                <pre>{JSON.stringify(item.input, null, 2)}</pre>
              </>
            ) : null}
            {item.output ? (
              <>
                <span className="ff-tx-io-label">OUT</span>
                <pre>{relativeOutput(item.output, root)}</pre>
              </>
            ) : null}
          </div>
        ) : null}
        {item.files.length && expanded ? (
          <div className="ff-tx-files">
            {item.files.map((f) => (
              <span key={f.path} className={`ff-file-change ff-file-${f.change}`} title={`${f.change} ${f.path}`}>
                {f.change === "created" ? "A" : f.change === "deleted" ? "D" : "M"}
              </span>
            ))}{" "}
            <span className="ff-muted ff-small">{item.files.map((f) => relative(f.path, root)).join(", ")}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A milestone, warning or failure: it stands out on the thread. */
function NoteRow({ item }: { item: NoteItem }) {
  return (
    <div className={`ff-tx-row ff-tx-callout ff-tx-callout-${item.tone}${item.milestone ? " ff-tx-callout-milestone" : ""}`} title={formatTime(item.timestamp)}>
      <span className="ff-tx-mark ff-tx-mark-callout" aria-hidden="true" />
      <div className="ff-tx-callout-body">
        <span>
          <span aria-hidden="true">{item.icon}</span> {item.text}
        </span>
        {item.milestone ? <span className="ff-tx-time">{formatTime(item.timestamp)}</span> : null}
        {item.detail ? (
          <details className="ff-tx-note-detail">
            <summary>Output</summary>
            <pre className="ff-tx-out">{item.detail}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** Tool output names files by absolute path; inside the project they read better relative to it. */
function relativeOutput(text: string, root: string | undefined): string {
  if (!root) return text;
  const r = root.replace(/[\\/]+$/, "");
  return text.split(`${r}\\`).join("").split(`${r.replace(/\\/g, "/")}/`).join("");
}
