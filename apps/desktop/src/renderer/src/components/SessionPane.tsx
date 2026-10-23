import { useEffect, useMemo, useState } from "react";
import type { EventDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { costLabel, costTitle, formatTokens, isEnded, STATE_LABEL, STATE_TONE, type Conversation } from "../lib/sessions.js";
import { AiChat } from "./AiChat.js";
import { LiveTerminal } from "./LiveTerminal.js";

/**
 * One conversation in the Sessions grid: its chat (structured sessions) or its CLI
 * terminal (terminal sessions). The terminal lives in the runner, not in this pane:
 * closing the pane detaches, it does not end the CLI.
 */
export function SessionPane({
  projectId,
  conversation,
  focused,
  onFocus,
  onClosePane,
  onChanged,
  onDelete,
}: {
  projectId: string;
  conversation: Conversation;
  focused: boolean;
  onFocus(): void;
  onClosePane(): void;
  onChanged(): void;
  onDelete(conversation: Conversation): void;
}) {
  const notify = useApp((s) => s.notify);
  const navigate = useApp((s) => s.navigate);
  const { latest } = conversation;
  const ids = useMemo(() => conversation.sessions.map((s) => s.id), [conversation.sessions]);
  const idsKey = ids.join(",");
  const events = useSessionEvents(ids, idsKey);
  const [renaming, setRenaming] = useState<string>();
  const [busy, setBusy] = useState(false);
  const terminalSession = conversation.sessions.find((s) => s.terminalId);
  const showTerminal = latest.mode === "pty" || !!terminalSession;
  const standalone = conversation.sessions.every((s) => !s.workflowRunId);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const openTerminal = () => act(() => api.invoke("sessions:openTerminal", { sessionId: latest.id, cols: 120, rows: 32 }));

  return (
    <section className={`ff-spane${focused ? " ff-spane-focused" : ""}`} onMouseDown={onFocus} aria-label={`Session ${conversation.title}`}>
      <header className="ff-spane-head">
        <span className={`ff-sdot ff-sdot-${latest.state}`} aria-hidden="true" />
        {renaming !== undefined ? (
          <form
            className="ff-grow"
            onSubmit={(e) => {
              e.preventDefault();
              const title = renaming.trim();
              setRenaming(undefined);
              if (title && title !== conversation.title) void act(() => api.invoke("sessions:rename", { sessionId: latest.id, title }));
            }}
          >
            <input className="ff-input ff-spane-rename" autoFocus value={renaming} maxLength={120} aria-label="Session title" onChange={(e) => setRenaming(e.target.value)} onBlur={() => setRenaming(undefined)} />
          </form>
        ) : (
          <h3 className="ff-spane-title ff-ellipsis" title={`${conversation.title} — double-click to rename`} onDoubleClick={() => setRenaming(conversation.title)}>
            {conversation.title}
          </h3>
        )}
        <span
          className={`ff-tag ${STATE_TONE[latest.state]}`}
          title={`${latest.stateDetail ?? STATE_LABEL[latest.state]}\nEvidence: ${latest.evidence.source} (${latest.evidence.confidence} confidence)`}
        >
          {STATE_LABEL[latest.state]}
        </span>
        <div className="ff-spane-actions">
          {latest.workflowRunId ? (
            <button type="button" className="ff-btn ff-btn-small" title="Open the workflow run" onClick={() => navigate({ name: "run", projectId, runId: latest.workflowRunId! })}>
              Run ↗
            </button>
          ) : null}
          {!showTerminal && latest.externalSessionId ? (
            <button type="button" className="ff-btn ff-btn-small" disabled={busy || latest.live} title={latest.live ? "End the chat first: one CLI process per conversation" : "Continue in the CLI's own terminal"} onClick={() => void openTerminal()}>
              ⌨ Terminal
            </button>
          ) : null}
          {latest.live && latest.mode === "structured" && latest.state === "working" ? (
            <button type="button" className="ff-btn ff-btn-small" disabled={busy} title="Stop the current turn" onClick={() => void act(() => api.invoke("sessions:cancel", { sessionId: latest.id }))}>
              Stop
            </button>
          ) : null}
          {latest.live ? (
            <button type="button" className="ff-btn ff-btn-small ff-btn-danger" disabled={busy} title={latest.mode === "pty" ? "Close the CLI" : "End the session after the current turn"} onClick={() => void act(() => api.invoke("sessions:close", { sessionId: latest.id }))}>
              End
            </button>
          ) : null}
          {standalone && !latest.live ? (
            <button type="button" className="ff-btn ff-btn-small ff-btn-danger" disabled={busy} onClick={() => onDelete(conversation)}>
              Delete
            </button>
          ) : null}
          <button type="button" className="ff-icon-btn" aria-label="Close pane" title="Close pane (the session keeps running)" onClick={onClosePane}>
            ✕
          </button>
        </div>
      </header>
      <div className="ff-spane-meta ff-small ff-muted">
        <span>{latest.adapterId}</span>
        {latest.model ? <span>{latest.model}</span> : null}
        {latest.worktreePath ? <span title={latest.worktreePath}>⎇ worktree</span> : null}
        {conversation.sessions.length > 1 ? <span>{conversation.sessions.length} sessions</span> : null}
        {conversation.usage ? (
          <span title={costTitle(conversation.usage)}>
            {formatTokens(conversation.usage.inputTokens)} in · {formatTokens(conversation.usage.outputTokens)} out · {costLabel(conversation.usage)}
          </span>
        ) : null}
        <span className="ff-ellipsis ff-mono" title={latest.cwd}>
          {latest.cwd}
        </span>
      </div>
      <div className="ff-spane-body">
        {terminalSession?.terminalId ? (
          <LiveTerminal key={terminalSession.terminalId} terminalId={terminalSession.terminalId} />
        ) : latest.mode === "pty" ? (
          <div className="ff-empty ff-empty-inline">
            <p>{latest.stateDetail ?? "The terminal is closed."}</p>
            {latest.externalSessionId ? (
              <button type="button" className="ff-btn ff-btn-primary" disabled={busy} onClick={() => void openTerminal()}>
                Reopen terminal
              </button>
            ) : (
              <p className="ff-muted ff-small">This CLI did not give the conversation an id, so it cannot be resumed.</p>
            )}
          </div>
        ) : (
          <AiChat events={events} sessionIds={ids} latestSessionId={latest.id} latestEnded={isEnded(latest)} onTakeOver={latest.externalSessionId ? () => void openTerminal() : undefined} />
        )}
      </div>
    </section>
  );
}

/** Stored events of the conversation, then live ones from the runner. */
function useSessionEvents(ids: string[], idsKey: string): EventDto[] {
  const notify = useApp((s) => s.notify);
  const [events, setEvents] = useState<EventDto[]>([]);
  useEffect(() => {
    const wanted = new Set(ids);
    let pending: EventDto[] | undefined = [];
    const merge = (list: EventDto[], more: EventDto[]) => {
      const seen = new Set(list.map((e) => e.id));
      return [...list, ...more.filter((e) => !seen.has(e.id))];
    };
    const off = api.on("session:event", (e) => {
      if (!e.sessionId || !wanted.has(e.sessionId)) return;
      if (pending) pending.push(e);
      else setEvents((list) => merge(list, [e]));
    });
    void api.invoke("sessions:events", { sessionIds: ids.slice(-50), limit: 3000 }).then(
      (stored) => {
        setEvents(merge(stored, pending ?? []));
        pending = undefined;
      },
      (err) => notify("error", errorMessage(err)),
    );
    return off;
    // idsKey stands for ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, notify]);
  return events;
}
