import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatTime, type ActivityLine } from "../lib/activity.js";

export function ActivityFeed({
  lines,
  stepLabels,
  showStep,
  defaultVerbose = false,
  emptyText = "Nothing has happened yet.",
}: {
  lines: ActivityLine[];
  stepLabels?: Map<string, string>;
  showStep: boolean;
  defaultVerbose?: boolean;
  emptyText?: string;
}) {
  const [verbose, setVerbose] = useState(defaultVerbose);
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const visible = verbose ? lines : lines.filter((l) => !l.verbose);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [visible.length, follow, visible.at(-1)?.text]);

  useEffect(() => setVerbose(defaultVerbose), [defaultVerbose]);

  return (
    <div className="ff-feed">
      <div className="ff-feed-toolbar">
        <label className="ff-checkbox ff-small">
          <input type="checkbox" checked={verbose} onChange={(e) => setVerbose(e.target.checked)} />
          Show command output &amp; details
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
        className="ff-feed-body"
        ref={scroller}
        role="log"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
      >
        {visible.length === 0 ? <p className="ff-muted ff-feed-empty">{emptyText}</p> : null}
        {visible.map((line) =>
          line.detail !== undefined && !line.text ? (
            <pre key={line.id} className="ff-feed-output">
              {line.detail}
            </pre>
          ) : (
            <div key={line.id} className={`ff-feed-line ff-feed-${line.tone}`}>
              <span className="ff-feed-time">{formatTime(line.timestamp)}</span>
              {showStep ? <span className="ff-feed-step">{line.nodeId ? (stepLabels?.get(line.nodeId) ?? line.nodeId) : "Run"}</span> : null}
              <span className="ff-feed-icon" aria-hidden="true">
                {line.icon}
              </span>
              <span className="ff-feed-text">{line.text}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
