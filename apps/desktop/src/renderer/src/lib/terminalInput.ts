import type { Terminal } from "@xterm/xterm";
import { api } from "../api.js";

/**
 * xterm.js turns Ctrl+V into a ^V for the CLI and swallows the browser's paste. Letting the
 * clipboard shortcuts through makes the browser paste (xterm sends the text, bracketed) and copy
 * the selection; Ctrl+C without a selection stays the CLI's interrupt.
 */
export function allowClipboardKeys(term: Terminal): void {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !(e.ctrlKey || e.metaKey) || e.altKey) return true;
    const key = e.key.toLowerCase();
    if (key === "v") return false;
    if (key === "c" && term.hasSelection()) return false;
    return true;
  });
}

/** The IPC schema caps one write; a long paste goes over in order, in pieces under that cap. */
const WRITE_CHUNK = 32_000;

export async function writeTerminal(terminalId: string, data: string): Promise<void> {
  for (let i = 0; i < data.length; i += WRITE_CHUNK) {
    await api.invoke("terminal:write", { terminalId, data: data.slice(i, i + WRITE_CHUNK) });
  }
}
