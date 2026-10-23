import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api, errorMessage } from "../api.js";

/** A chat message as typed into Claude Code's UI: pasted as one block (newlines kept), then Enter. */
export function typedMessage(text: string): string {
  return `\x1b[200~${text}\x1b[201~\r`;
}

/**
 * The AI CLI's own interactive UI in a PTY (like a tmux pane): the user types
 * and chats directly. It resumes the step's conversation when the CLI supports it.
 */
export function InteractiveTerminal({ sessionId, initialInput, onClose }: { sessionId: string; initialInput?: string; onClose(): void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const pending = useRef(initialInput);
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
    fit.fit();
    term.focus();

    let terminalId: string | undefined;
    let disposed = false;
    // A message to send once Claude Code's UI is up: when its output has settled for a moment.
    let settle: ReturnType<typeof setTimeout> | undefined;
    const offData = api.on("terminal:data", (m) => {
      if (m.terminalId !== terminalId) return;
      term.write(m.data);
      if (!pending.current) return;
      clearTimeout(settle);
      settle = setTimeout(() => {
        if (!pending.current || !terminalId) return;
        void api.invoke("terminal:write", { terminalId, data: typedMessage(pending.current) });
        pending.current = undefined;
      }, 1500);
    });
    const offExit = api.on("terminal:exit", (m) => {
      if (m.terminalId !== terminalId) return;
      term.write(`\r\n\x1b[90m[process exited${m.exitCode !== null ? ` with code ${m.exitCode}` : ""}]\x1b[0m\r\n`);
      setStatus({ text: "Exited", tone: "muted" });
      terminalId = undefined;
    });
    const input = term.onData((data) => {
      if (terminalId) void api.invoke("terminal:write", { terminalId, data });
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

    void api.invoke("terminal:open", { sessionId, cols: term.cols, rows: term.rows }).then(
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
      clearTimeout(settle);
      if (terminalId) void api.invoke("terminal:close", { terminalId });
      offData();
      offExit();
      input.dispose();
      resize.dispose();
      observer.disconnect();
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div className="ff-iterm">
      <div className="ff-iterm-bar">
        <span className={`ff-iterm-status ff-iterm-${status.tone}`}>● {status.text}</span>
        <span className="ff-muted ff-small">Interactive — you are typing into the AI CLI directly</span>
        <button type="button" className="ff-btn ff-btn-small" onClick={onClose}>
          Close terminal
        </button>
      </div>
      <div className="ff-iterm-screen" ref={hostRef} aria-label="Interactive AI terminal" />
    </div>
  );
}
