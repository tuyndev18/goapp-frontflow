import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EventDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { formatTime } from "../lib/activity.js";
import { Markdown } from "./Markdown.js";
import { InteractiveTerminal } from "./InteractiveTerminal.js";
import { Terminal } from "./Terminal.js";

type ChatItem =
  | { kind: "ai"; id: string; time: string; text: string }
  | { kind: "user"; id: string; time: string; text: string }
  | { kind: "tool"; id: string; time: string; name: string; target?: string; input: unknown; ok?: boolean }
  | { kind: "file"; id: string; time: string; path: string; change: string }
  | { kind: "status"; id: string; time: string; text: string; tone: "info" | "danger" };

const EMPTY: EventDto[] = [];

/**
 * Readable view of an AI CLI conversation (instead of the raw stream-json),
 * with a composer to keep chatting in the same session and a button to take
 * over in the CLI's own interactive terminal.
 *
 * Events come from a workflow run (`runId`) or are given directly (`events`, Sessions
 * screen). `latestSessionId`/`latestEnded` override what the events alone can tell,
 * e.g. a session whose process ended with the app.
 */
export function AiChat({
  runId,
  events: given,
  nodeRunId,
  sessionIds,
  latestSessionId,
  latestEnded,
  onTakeOver,
}: {
  runId?: string;
  events?: EventDto[];
  nodeRunId?: string;
  sessionIds?: string[];
  latestSessionId?: string;
  latestEnded?: boolean;
  /** Replaces the built-in interactive terminal tab (e.g. a terminal that outlives this view). */
  onTakeOver?(): void;
}) {
  const runEvents = useApp((s) => (runId ? (s.runEvents[runId] ?? EMPTY) : EMPTY));
  const events = given ?? runEvents;
  const notify = useApp((s) => s.notify);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"chat" | "terminal" | "raw">("chat");
  const scroller = useRef<HTMLDivElement>(null);

  const mine = useMemo(
    () => events.filter((e) => e.sessionId && ((nodeRunId && e.nodeRunId === nodeRunId) || sessionIds?.includes(e.sessionId))),
    [events, nodeRunId, sessionIds],
  );
  const sessions = useMemo(() => [...new Set(mine.map((e) => e.sessionId!))], [mine]);
  const lastSession = latestSessionId ?? sessions.at(-1);
  const lastSessionEnded =
    latestEnded ?? (!!lastSession && mine.some((e) => e.sessionId === lastSession && (e.type === "session.completed" || e.type === "session.failed")));

  // The user's messages are events too (stored by main when sent), so the order survives a reload.
  const items = useMemo(() => buildChat(mine).sort((a, b) => a.time.localeCompare(b.time)), [mine]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [items.length, items.at(-1)]);

  async function send() {
    const text = draft.trim();
    if (!text || !lastSession) return;
    setBusy(true);
    try {
      if (lastSessionEnded) await api.invoke("sessions:resume", { sessionId: lastSession, prompt: text });
      else await api.invoke("sessions:send", { sessionId: lastSession, message: text });
      setDraft("");
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!lastSession) return <p className="ff-pad ff-muted">This step has not started an AI session.</p>;

  return (
    <div className="ff-chat">
      <div className="ff-chat-bar">
        <div className="ff-seg" role="tablist" aria-label="AI view">
          {(["chat", "terminal", "raw"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={`ff-seg-btn${mode === m ? " ff-seg-active" : ""}`}
              onClick={() => (m === "terminal" && onTakeOver ? onTakeOver() : setMode(m))}
            >
              {m === "chat" ? "💬 Chat" : m === "terminal" ? "⌨ Interactive terminal" : "Raw stream"}
            </button>
          ))}
        </div>
        <span className="ff-muted ff-small">
          {sessions.length} session{sessions.length === 1 ? "" : "s"} · {lastSessionEnded ? "finished" : "running"}
        </span>
      </div>

      {mode === "terminal" ? <InteractiveTerminal sessionId={lastSession} onClose={() => setMode("chat")} /> : null}
      {mode === "raw" ? <Terminal sessionId={lastSession} /> : null}
      {mode === "chat" ? (
        <>
          <div className="ff-chat-body" ref={scroller} role="log" aria-label="AI conversation">
            {items.map((item) => (
              <ChatRow key={item.id} item={item} />
            ))}
          </div>
          <form
            className="ff-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              className="ff-input"
              rows={2}
              placeholder={lastSessionEnded ? "Continue this conversation with the AI… (resumes the session)" : "Message the running AI session…"}
              value={draft}
              aria-label="Message to the AI"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button type="submit" className="ff-btn ff-btn-primary" disabled={!draft.trim() || busy}>
              {busy ? "Sending…" : "Send"}
            </button>
          </form>
        </>
      ) : null}
    </div>
  );
}

function ChatRow({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "ai":
      return (
        <div className="ff-msg ff-msg-ai">
          <div className="ff-msg-meta">🤖 AI · {formatTime(item.time)}</div>
          <Markdown source={item.text} />
        </div>
      );
    case "user":
      return (
        <div className="ff-msg ff-msg-user">
          <div className="ff-msg-meta">You · {formatTime(item.time)}</div>
          <div className="ff-msg-text">{item.text}</div>
        </div>
      );
    case "tool":
      return (
        <details className={`ff-tool${item.ok === false ? " ff-tool-failed" : ""}`}>
          <summary>
            <span className="ff-tool-name">{item.ok === false ? "✕" : "🔧"} {item.name}</span>
            {item.target ? <span className="ff-mono ff-small ff-tool-target">{item.target}</span> : null}
            <span className="ff-muted ff-small">{formatTime(item.time)}</span>
          </summary>
          <pre className="ff-pre">{previewInput(item.input)}</pre>
        </details>
      );
    case "file":
      return (
        <div className="ff-chat-file">
          ✎ {item.change} <span className="ff-mono">{item.path}</span>
        </div>
      );
    case "status":
      return <div className={`ff-chat-status ff-chat-status-${item.tone}`}>{item.text}</div>;
  }
}

function buildChat(events: EventDto[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, Extract<ChatItem, { kind: "tool" }>>();
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    switch (e.type) {
      case "session.started":
        items.push({ kind: "status", id: e.id, time: e.timestamp, text: `AI session started${typeof p["model"] === "string" ? ` · ${p["model"]}` : ""}`, tone: "info" });
        break;
      case "message.delta": {
        if (typeof p["text"] !== "string" || !p["text"].trim()) break;
        if (p["role"] === "user") {
          items.push({ kind: "user", id: e.id, time: e.timestamp, text: p["text"] });
          break;
        }
        if (p["role"] !== "assistant") break;
        const prev = items.at(-1);
        if (prev?.kind === "ai") prev.text += `\n\n${p["text"]}`;
        else items.push({ kind: "ai", id: e.id, time: e.timestamp, text: p["text"] });
        break;
      }
      case "tool.started": {
        const input = p["input"] as Record<string, unknown> | undefined;
        const target = ["file_path", "path", "command", "pattern", "url"].map((k) => input?.[k]).find((v) => typeof v === "string") as string | undefined;
        const tool: Extract<ChatItem, { kind: "tool" }> = { kind: "tool", id: e.id, time: e.timestamp, name: String(p["name"] ?? "tool"), input, ...(target ? { target: shorten(target) } : {}) };
        tools.set(String(p["toolCallId"]), tool);
        items.push(tool);
        break;
      }
      case "tool.completed": {
        const tool = tools.get(String(p["toolCallId"]));
        if (tool) tool.ok = p["ok"] !== false;
        break;
      }
      case "file.changed":
        items.push({ kind: "file", id: e.id, time: e.timestamp, path: shorten(String(p["path"] ?? "")), change: String(p["change"] ?? "changed") });
        break;
      case "session.completed":
        items.push({ kind: "status", id: e.id, time: e.timestamp, text: "AI session finished", tone: "info" });
        break;
      case "session.failed":
        items.push({ kind: "status", id: e.id, time: e.timestamp, text: `AI session failed: ${String(p["message"] ?? p["code"] ?? "")}`, tone: "danger" });
        break;
    }
  }
  return items;
}

function shorten(path: string): string {
  return path.length > 90 ? `…${path.slice(-90)}` : path;
}

function previewInput(input: unknown): string {
  const text = JSON.stringify(input, null, 2) ?? "";
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
}
