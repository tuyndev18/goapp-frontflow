import { useEffect, useRef, useState } from "react";
import type { AccountDto, AccountsStateDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { loginExpiry, nameOf, resetText, sessionWindow, severity, toneClass, type Severity } from "../lib/accounts.js";
import { useDismiss } from "./Menu.js";

/**
 * Floating chat-style bubble with every saved login's 5h session window, on every screen.
 * Turns red (and pulses) once the active account nears its session limit, so the user can
 * switch to one with room left before `claude` stops.
 */
export function AccountsBubble() {
  const notify = useApp((s) => s.notify);
  const navigate = useApp((s) => s.navigate);
  const [state, setState] = useState<AccountsStateDto>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.invoke("accounts:state").then(setState, () => undefined);
    const off = api.on("accounts:changed", setState);
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      off();
      clearInterval(clock);
    };
  }, []);

  useDismiss(root, open, () => setOpen(false));

  if (!state?.supported || !state.accounts.length) return null;

  const accounts = [...state.accounts].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  const active = accounts.find((a) => a.active);
  const pct = sessionWindow(active)?.utilization;
  const tone = severity(pct);

  async function switchTo(a: AccountDto) {
    setBusy(true);
    try {
      const result = await api.invoke("accounts:switch", { accountId: a.id });
      notify("info", `Every new claude now uses ${nameOf(a)}.${result.warnings.length ? ` ${result.warnings.join(" ")}` : ""}`);
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ff-accb" ref={root}>
      {open ? (
        <section className="ff-accb-panel" aria-label="Claude accounts">
          <header className="ff-accb-head">
            <strong>Claude accounts</strong>
            <button
              type="button"
              className="ff-btn ff-btn-small ff-btn-ghost"
              onClick={() => {
                setOpen(false);
                navigate({ name: "accounts" });
              }}
            >
              Open ›
            </button>
          </header>
          {tone === "crit" ? (
            <p className="ff-accb-alert" role="alert">
              {nameOf(active)} has used {Math.round(pct!)}% of its session. Switch to an account with room left.
            </p>
          ) : null}
          <ul className="ff-accb-list">
            {accounts.map((a) => (
              <BubbleItem key={a.id} account={a} now={now} busy={busy} onSwitch={() => void switchTo(a)} />
            ))}
          </ul>
        </section>
      ) : null}
      <button
        type="button"
        className={`ff-accb-fab ff-accb-tone-${tone}${tone === "crit" ? " ff-accb-fab-crit" : ""}`}
        aria-expanded={open}
        aria-label={`Claude accounts${pct !== undefined ? ` · 5h session ${Math.round(pct)}% used` : ""}`}
        title={active ? `${nameOf(active)} · 5h session ${pct === undefined ? "unknown" : `${Math.round(pct)}% used`}` : "Claude accounts"}
        onClick={() => setOpen((o) => !o)}
      >
        <SessionRing pct={pct} tone={tone} />
      </button>
    </div>
  );
}

const RING_SIZE = 56;
const RING_R = 23.5;
const RING_C = 2 * Math.PI * RING_R;

/** The active account's 5h session used, as a thin ring along the bubble's edge, filling clockwise from the top. */
function SessionRing({ pct, tone }: { pct: number | undefined; tone: Severity }) {
  const used = pct === undefined ? 0 : Math.max(0, Math.min(100, pct));
  const c = RING_SIZE / 2;
  return (
    <span className="ff-accb-ring" aria-hidden="true">
      <svg viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} width={RING_SIZE} height={RING_SIZE}>
        <circle className="ff-accb-ring-track" cx={c} cy={c} r={RING_R} />
        {used > 0 ? <circle className="ff-accb-ring-fill" cx={c} cy={c} r={RING_R} strokeDasharray={`${(used / 100) * RING_C} ${RING_C}`} transform={`rotate(-90 ${c} ${c})`} /> : null}
      </svg>
      <span className="ff-accb-ring-text">
        {pct === undefined ? (
          "—"
        ) : (
          <>
            <b>{Math.round(used)}</b>
            <small>%</small>
          </>
        )}
      </span>
    </span>
  );
}

function BubbleItem({ account: a, now, busy, onSwitch }: { account: AccountDto; now: number; busy: boolean; onSwitch(): void }) {
  const w = sessionWindow(a);
  const pct = w === undefined ? undefined : Math.max(0, Math.min(100, w.utilization));
  const tone = severity(pct);
  const expiry = loginExpiry(a, now);
  return (
    <li className={`ff-accb-item${a.active ? " ff-accb-item-active" : ""}`}>
      <span className="ff-accb-name" title={a.email}>
        {a.active ? <span className="ff-wactive">● </span> : null}
        {nameOf(a)}
      </span>
      {a.active ? (
        <span className="ff-muted ff-small">active</span>
      ) : (
        <button type="button" className="ff-btn ff-btn-small" disabled={busy || a.status === "needs_login"} onClick={onSwitch}>
          Switch
        </button>
      )}
      <span className="ff-accb-meter">
        <span className="ff-wmuted">5h</span>
        <span className="ff-wbar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct === undefined ? undefined : Math.round(pct)} aria-label="Session (5h)">
          <span className="ff-wtrack" />
          {pct !== undefined ? <span className={`ff-wfill ff-sev-${tone}`} style={{ width: `${pct}%` }} /> : null}
        </span>
        <span className={`ff-wpct ff-sevtext-${tone}`}>{pct === undefined ? "—" : `${Math.round(pct)}%`}</span>
      </span>
      {a.status === "needs_login" ? (
        <span className="ff-accb-reset ff-wcrit">{a.location === "lost" ? "login replaced — add it again" : "login expired"}</span>
      ) : (
        <span className="ff-accb-reset">
          {w?.resetsAt ? resetText(w.resetsAt, now) : null}
          {w?.resetsAt && expiry ? " · " : null}
          {expiry ? (
            <span className={toneClass(expiry.tone)} title={expiry.title}>
              {expiry.text}
            </span>
          ) : null}
        </span>
      )}
    </li>
  );
}
