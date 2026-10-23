import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api } from "../api.js";

/** Read-only xterm view of an AI CLI session's raw stream (already redacted in main). */
export function Terminal({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new XTerm({ convertEol: true, disableStdin: true, fontSize: 12, scrollback: 5000, theme: { background: "#191919", foreground: "#e6e6e6" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    let disposed = false;

    void api.invoke("sessions:rawLog", { sessionId }).then((text) => {
      if (!disposed && text) term.write(text);
    });
    const off = api.on("session:raw", ({ sessionId: sid, chunk }) => {
      if (sid === sessionId) term.write(chunk);
    });
    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);
    return () => {
      disposed = true;
      off();
      window.removeEventListener("resize", onResize);
      term.dispose();
    };
  }, [sessionId]);

  return <div className="ff-terminal" ref={hostRef} aria-label="Terminal output" />;
}
