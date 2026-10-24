import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api } from "../api.js";
import { allowClipboardKeys, writeTerminal } from "../lib/terminalInput.js";

/**
 * Attaches to a PTY that is already running in the CLI runner (an interactive workflow step):
 * replays the screen buffered by main, then streams it live. Typing goes straight to the CLI,
 * so permission prompts can be answered here. After the session ends the last screen stays.
 */
export function LiveTerminal({ terminalId }: { terminalId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new XTerm({
      convertEol: false,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
      scrollback: 10_000,
      theme: { background: "#191919", foreground: "#e6e6e6", cursor: "#2383e2", selectionBackground: "#2f4a66" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    allowClipboardKeys(term);
    fit.fit();

    let open = false;
    let replayed = false;
    let disposed = false;
    // Chunks that arrive before the snapshot answer are already part of it.
    const offData = api.on("terminal:data", (m) => {
      if (m.terminalId === terminalId && replayed) term.write(m.data);
    });
    const offExit = api.on("terminal:exit", (m) => {
      if (m.terminalId !== terminalId) return;
      open = false;
      term.write("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
    });
    void api.invoke("terminal:snapshot", { terminalId }).then((snap) => {
      if (disposed) return;
      term.write(snap.data);
      replayed = true;
      open = snap.open;
      // Resizing to this pane makes the TUI redraw for the size it is shown at.
      if (open) void api.invoke("terminal:resize", { terminalId, cols: term.cols, rows: term.rows }).catch(() => undefined);
      else term.write("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
    });
    const input = term.onData((data) => {
      if (open) void writeTerminal(terminalId, data).catch(() => undefined);
    });
    const resize = term.onResize(({ cols, rows }) => {
      if (open) void api.invoke("terminal:resize", { terminalId, cols, rows }).catch(() => undefined);
    });
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // host not laid out yet
      }
    });
    observer.observe(hostRef.current);

    return () => {
      disposed = true;
      offData();
      offExit();
      input.dispose();
      resize.dispose();
      observer.disconnect();
      term.dispose();
    };
  }, [terminalId]);

  return <div className="ff-terminal" ref={hostRef} aria-label="Interactive AI session" />;
}
