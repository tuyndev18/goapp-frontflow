import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api, errorMessage } from "../api.js";
import { allowClipboardKeys, writeTerminal } from "../lib/terminalInput.js";

/**
 * The AI CLI's own interactive UI in a PTY (like a tmux pane): the user types and chats directly.
 * It starts a fresh Claude Code in the feature's project folder or, with a step, that step's own
 * Claude session again.
 */
export function InteractiveTerminal({
  runId,
  nodeId,
  onMinimize,
  onClose,
}: {
  runId: string;
  /** Reopen this step's Claude session. */
  nodeId?: string;
  /** Shows a Hide button that only hides the terminal; the CLI keeps running. */
  onMinimize?(): void;
  onClose(): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<{ text: string; tone: "info" | "danger" | "muted" }>({ text: "Starting…", tone: "muted" });

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new XTerm({
      convertEol: false,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
      scrollback: 10_000,
      theme: { background: "#191919", foreground: "#e6e6e6", cursor: "#2383e2", selectionBackground: "#2f4a66" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    allowClipboardKeys(term);
    fit.fit();
    term.focus();

    let terminalId: string | undefined;
    let disposed = false;
    const offData = api.on("terminal:data", (m) => {
      if (m.terminalId === terminalId) term.write(m.data);
    });
    const offExit = api.on("terminal:exit", (m) => {
      if (m.terminalId !== terminalId) return;
      term.write(`\r\n\x1b[90m[process exited${m.exitCode !== null ? ` with code ${m.exitCode}` : ""}]\x1b[0m\r\n`);
      setStatus({ text: "Exited", tone: "muted" });
      terminalId = undefined;
    });
    const input = term.onData((data) => {
      if (terminalId) void writeTerminal(terminalId, data).catch(() => undefined);
    });
    const resize = term.onResize(({ cols, rows }) => {
      if (terminalId) void api.invoke("terminal:resize", { terminalId, cols, rows });
    });
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // host not laid out yet
      }
    });
    observer.observe(hostRef.current);

    void api.invoke("terminal:openFeature", { runId, ...(nodeId ? { nodeId } : {}), cols: term.cols, rows: term.rows }).then(
      (opened) => {
        if (disposed) {
          void api.invoke("terminal:close", { terminalId: opened.terminalId });
          return;
        }
        terminalId = opened.terminalId;
        setStatus({ text: opened.command, tone: "info" });
      },
      (err) => {
        term.write(`\x1b[31m${errorMessage(err)}\x1b[0m\r\n`);
        setStatus({ text: "Could not start", tone: "danger" });
      },
    );

    return () => {
      disposed = true;
      if (terminalId) void api.invoke("terminal:close", { terminalId });
      offData();
      offExit();
      input.dispose();
      resize.dispose();
      observer.disconnect();
      term.dispose();
    };
  }, [runId, nodeId]);

  return (
    <div className="ff-iterm">
      <div className="ff-iterm-bar">
        <span className={`ff-iterm-status ff-iterm-${status.tone}`}>● {status.text}</span>
        <span className="ff-muted ff-small">Interactive — you are typing into the AI CLI directly</span>
        {onMinimize ? (
          <button type="button" className="ff-btn ff-btn-small" onClick={onMinimize}>
            Hide
          </button>
        ) : null}
        <button type="button" className="ff-btn ff-btn-small" onClick={onClose}>
          Close terminal
        </button>
      </div>
      <div className="ff-iterm-screen" ref={hostRef} aria-label="Interactive AI terminal" />
    </div>
  );
}
