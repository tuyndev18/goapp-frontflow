import { useEffect, useRef, useState } from "react";
import { InteractiveTerminal } from "./InteractiveTerminal.js";

/**
 * Floating button next to the accounts bubble on a feature's run screen: opens Claude Code in the
 * project folder, as the feature's Claude account, in a large popover above it. Hiding the popover
 * (button, click outside) keeps the session running until the user closes the terminal.
 */
export function ClaudeCodeLauncher({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Outside clicks hide it; Escape is left to Claude Code, where it interrupts the AI.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="ff-ccl" ref={root}>
      {started ? (
        <section id="ff-ccl-panel" className="ff-ccl-panel" hidden={!open} aria-label="Claude Code">
          <InteractiveTerminal
            runId={runId}
            onMinimize={() => setOpen(false)}
            onClose={() => {
              setStarted(false);
              setOpen(false);
            }}
          />
        </section>
      ) : null}
      <button
        type="button"
        className={`ff-ccl-fab${open ? " ff-ccl-fab-open" : ""}`}
        aria-expanded={open}
        aria-controls="ff-ccl-panel"
        aria-label={started ? "Claude Code (running)" : "Open Claude Code for this feature"}
        title={started ? "Claude Code is running" : "Open Claude Code in the project folder"}
        onClick={() => {
          setStarted(true);
          setOpen((o) => !o || !started);
        }}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4.5" width="18" height="15" rx="3.5" />
          <path d="m7.5 10 2.5 2.5-2.5 2.5M12.5 15h4" />
        </svg>
        {started ? <span className="ff-ccl-live" aria-hidden="true" /> : null}
      </button>
    </div>
  );
}
