import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeRun } from "@frontflow/domain";
import type { EventDto, GraphNodeDto } from "../../../shared/ipc.js";
import { formatDuration, formatTime, interactiveTerminalId, stepDuration, type ActivityLine } from "../lib/activity.js";
import { LiveTerminal } from "./LiveTerminal.js";
import { Terminal } from "./Terminal.js";

const MAX_PANES = 4;
const LIVE = new Set(["running", "retrying"]);

interface PaneInfo {
  node: GraphNodeDto;
  nodeRun: NodeRun;
  lines: ActivityLine[];
  sessionId?: string;
  adapterId?: string;
  model?: string;
  /** PTY of an interactive Claude session (Settings → interactive sessions). */
  terminalId?: string;
}

/**
 * tmux-style view of the run's AI CLI sessions: one pane per AI step, live steps first, with a
 * status bar listing every AI step as a window. Interactive steps show the real Claude Code TUI
 * (typing goes to it); headless steps show the normalized event stream, or the CLI's own
 * (redacted) output with "raw".
 */
export function TmuxView({
  title,
  nodes,
  latest,
  lines,
  events,
  now,
  onSelect,
}: {
  title: string;
  nodes: GraphNodeDto[];
  latest: Map<string, NodeRun>;
  lines: ActivityLine[];
  events: EventDto[];
  now: number;
  onSelect(id: string): void;
}) {
  const [zoomed, setZoomed] = useState<string>();
  const [showAll, setShowAll] = useState(false);

  const windows: PaneInfo[] = useMemo(() => {
    const sessions = new Map<string, { sessionId?: string; adapterId?: string; model?: string; terminalId?: string }>();
    for (const e of events) {
      if (e.type !== "session.started" || !e.nodeRunId) continue;
      const p = (e.payload ?? {}) as { adapterId?: string; model?: string };
      // A new session (retry, interactive or not) replaces the previous one's pane content.
      sessions.set(e.nodeRunId, { ...(e.sessionId ? { sessionId: e.sessionId } : {}), ...(p.adapterId ? { adapterId: p.adapterId } : {}), ...(p.model ? { model: p.model } : {}) });
      const terminalId = interactiveTerminalId(events, e.nodeRunId);
      if (terminalId) sessions.set(e.nodeRunId, { ...sessions.get(e.nodeRunId), terminalId });
    }
    return nodes.flatMap((node) => {
      const nodeRun = latest.get(node.id);
      if (!node.ai || !nodeRun) return [];
      const own = lines.filter((l) => l.nodeId === node.id && !l.verbose);
      // Pausing a run resets its interrupted steps to "ready" without a start time: keep their pane by their history.
      if (!nodeRun.startedAt && !own.length) return [];
      return [{ node, nodeRun, lines: own, ...sessions.get(nodeRun.id) }];
    });
  }, [nodes, latest, lines, events]);

  if (!windows.length) {
    return (
      <div className="ff-tmux">
        <p className="ff-tmux-empty">No AI CLI session has started in this run yet. Panes open here as soon as an AI step starts.</p>
      </div>
    );
  }

  const live = windows.filter((w) => LIVE.has(w.nodeRun.status));
  const zoomedPane = windows.find((w) => w.node.id === zoomed);
  const ordered = [...live, ...windows.filter((w) => !LIVE.has(w.nodeRun.status)).reverse()];
  const panes = zoomedPane ? [zoomedPane] : showAll ? ordered : ordered.slice(0, Math.max(1, Math.min(MAX_PANES, live.length || 1)));

  return (
    <div className="ff-tmux">
      <div className={`ff-tmux-grid ff-tmux-grid-${Math.min(panes.length, 3)}`}>
        {panes.map((p) => (
          <Pane
            key={p.node.id}
            pane={p}
            index={windows.indexOf(p)}
            now={now}
            zoomed={zoomedPane === p}
            onZoom={() => setZoomed(zoomedPane === p ? undefined : p.node.id)}
            onOpen={() => onSelect(p.node.id)}
          />
        ))}
      </div>
      <div className="ff-tmux-status" role="tablist" aria-label="AI sessions">
        <span className="ff-tmux-session">[{title}]</span>
        {windows.map((w, i) => {
          const focused = panes.includes(w);
          return (
            <button
              key={w.node.id}
              type="button"
              role="tab"
              aria-selected={zoomed === w.node.id}
              className={`ff-tmux-win${focused ? " ff-tmux-win-on" : ""}`}
              onClick={() => setZoomed(zoomed === w.node.id ? undefined : w.node.id)}
              title={`${w.node.label} — ${w.nodeRun.status}`}
            >
              {i}:{w.node.label}
              {LIVE.has(w.nodeRun.status) ? "●" : w.nodeRun.status === "failed" ? "!" : focused ? "*" : "-"}
            </button>
          );
        })}
        <span className="ff-tmux-right">
          {!zoomedPane && windows.length > panes.length ? (
            <button type="button" className="ff-tmux-win" onClick={() => setShowAll(true)}>
              +{windows.length - panes.length} more
            </button>
          ) : !zoomedPane && showAll ? (
            <button type="button" className="ff-tmux-win" onClick={() => setShowAll(false)}>
              live only
            </button>
          ) : null}
          {live.length} running · {new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
        </span>
      </div>
    </div>
  );
}

function Pane({ pane, index, now, zoomed, onZoom, onOpen }: { pane: PaneInfo; index: number; now: number; zoomed: boolean; onZoom(): void; onOpen(): void }) {
  const [mode, setMode] = useState<"tui" | "events" | "raw">(pane.terminalId ? "tui" : "events");
  const bodyRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const running = LIVE.has(pane.nodeRun.status);
  const duration = stepDuration(pane.nodeRun, now);

  // A retry may switch the step to (or from) an interactive session.
  useEffect(() => setMode(pane.terminalId ? "tui" : "events"), [pane.terminalId]);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [pane.lines.length, mode]);

  return (
    <section className={`ff-tmux-pane${running ? " ff-tmux-pane-live" : ""}`} aria-label={`AI session: ${pane.node.label}`}>
      <header className="ff-tmux-pane-head">
        <span>
          [{index}] {pane.node.label} · {pane.adapterId ?? "ai-cli"}
          {pane.model ? ` (${pane.model})` : ""} · {pane.nodeRun.status === "ready" && pane.lines.length ? "interrupted" : pane.nodeRun.status}
          {pane.nodeRun.attempt > 1 ? ` · try ${pane.nodeRun.attempt}` : ""}
          {duration !== undefined ? ` · ${formatDuration(duration)}` : ""}
        </span>
        <span className="ff-tmux-pane-actions">
          {pane.terminalId ? (
            <button type="button" aria-pressed={mode === "events"} onClick={() => setMode(mode === "tui" ? "events" : "tui")} title="Switch between the Claude session and its event log">
              {mode === "tui" ? "events" : "session"}
            </button>
          ) : pane.sessionId ? (
            <button type="button" aria-pressed={mode === "raw"} onClick={() => setMode(mode === "raw" ? "events" : "raw")} title="CLI's own output stream">
              raw
            </button>
          ) : null}
          <button type="button" onClick={onZoom} title={zoomed ? "Back to all panes" : "Zoom this pane"}>
            {zoomed ? "unzoom" : "zoom"}
          </button>
          <button type="button" onClick={onOpen} title="Open step details">
            open
          </button>
        </span>
      </header>
      {mode === "tui" && pane.terminalId ? (
        <div className="ff-tmux-raw" title={running ? "Interactive Claude session: click and type to answer its prompts" : undefined}>
          <LiveTerminal terminalId={pane.terminalId} />
        </div>
      ) : mode === "raw" && pane.sessionId ? (
        <div className="ff-tmux-raw">
          <Terminal sessionId={pane.sessionId} />
        </div>
      ) : (
        <div
          className="ff-tmux-body"
          ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          <div className="ff-tmux-line ff-tmux-prompt">
            $ {pane.adapterId ?? "ai-cli"} {pane.terminalId ? "(interactive)" : "(headless)"}
            {pane.model ? ` --model ${pane.model}` : ""} # {pane.node.label}
          </div>
          {pane.lines.map((l) => (
            <div key={l.id} className={`ff-tmux-line ff-tmux-${l.tone}`}>
              <span className="ff-tmux-time">{formatTime(l.timestamp)}</span> {l.icon} {l.text}
              {l.detail ? <pre className="ff-tmux-detail">{l.detail}</pre> : null}
            </div>
          ))}
          {running ? <span className="ff-tmux-cursor" aria-hidden="true" /> : null}
        </div>
      )}
    </section>
  );
}
