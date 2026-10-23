import { useCallback, useEffect, useState } from "react";
import type { AccountDto, AccountsStateDto, QuotaWindowDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { Loading } from "../components/Loading.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { LiveTerminal } from "../components/LiveTerminal.js";
import { Menu } from "../components/Menu.js";
import { durationText, loginExpiry, nameOf, resetText, severity, toneClass } from "../lib/accounts.js";

/** Quota older than this is shown dimmed with its age. */
const STALE_MS = 10 * 60_000;

/**
 * Claude Code logins of this computer, shown the way claude-swap's watch view does: one
 * block per account with its quota windows as thin bars. Add an account (isolated
 * `claude auth login`), switch the machine-wide login, follow quota and local usage.
 * Tokens never reach this screen.
 */
export function AccountsScreen() {
  const notify = useApp((s) => s.notify);
  const [state, setState] = useState<AccountsStateDto>();
  const [switching, setSwitching] = useState<AccountDto>();
  const [removing, setRemoving] = useState<AccountDto>();
  const [renaming, setRenaming] = useState<{ account: AccountDto; label: string }>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setState(await api.invoke("accounts:state"));
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }, [notify]);

  useEffect(() => {
    void load();
    const offState = api.on("accounts:changed", setState);
    const offLogin = api.on("accounts:login", (m) => {
      if (m.status === "succeeded") notify("info", "Account added. Switch to it when you want every `claude` to use it.");
      else if (m.status === "failed") notify("error", `Login not added: ${m.message ?? "unknown error"}`);
    });
    // Countdowns tick every 30 s, like the TUI's refresh.
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      offState();
      offLogin();
      clearInterval(clock);
    };
  }, [load, notify]);

  async function act<T>(fn: () => Promise<T>, done?: (value: T) => void): Promise<T | undefined> {
    setBusy(true);
    try {
      const value = await fn();
      done?.(value);
      await load();
      return value;
    } catch (err) {
      notify("error", errorMessage(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  function startLogin(method: "claudeai" | "sso") {
    void act(() => api.invoke("accounts:startLogin", { method }));
  }

  const live = state?.live;
  const activeAccount = state?.accounts.find((a) => a.active);
  const login = state?.logins[0];
  // Slot order (the order they were saved), so numbers never move.
  const accounts = [...(state?.accounts ?? [])].sort((a, b) => a.addedAt.localeCompare(b.addedAt));

  return (
    <div className="ff-screen ff-accounts">
      <header className="ff-screen-header">
        <div>
          <span className="ff-eyebrow">This computer</span>
          <h1>Claude accounts</h1>
          <p className="ff-muted">
            Claude Code logins saved on this machine. Switching changes the login every <code>claude</code> uses — terminals, IDEs and FrontFlow.
          </p>
        </div>
        <div className="ff-actions">
          <button type="button" className="ff-icon-btn ff-acc-icon" disabled={busy || !state?.supported} onClick={() => void act(() => api.invoke("accounts:refresh", {}))} title="Read logins and usage on this computer again" aria-label="Refresh">
            ↻
          </button>
          {/* Runs `claude auth login` in an isolated folder; name the account afterwards with Rename. */}
          <Menu
            label="Add account"
            className="ff-btn ff-btn-primary"
            disabled={busy || !state?.supported || !!login}
            trigger={<>+ Add account ▾</>}
            items={[
              { label: "Claude.ai account", hint: "Pro, Max or Team login in the browser", onSelect: () => startLogin("claudeai") },
              { label: "Organization SSO", hint: "Log in with your company's SSO", onSelect: () => startLogin("sso") },
            ]}
          />
        </div>
      </header>

      {!state ? (
        <Loading label="Loading accounts" />
      ) : !state.supported ? (
        <div className="ff-empty">
          <p>{state.unsupportedReason}</p>
        </div>
      ) : (
        <>
          {state.vaultWarning ? (
            <div className="ff-acc-banner ff-acc-banner-warn" role="alert">
              ⚠ {state.vaultWarning}
            </div>
          ) : null}
          {state.statusLine?.error ? (
            <div className="ff-acc-banner ff-acc-banner-warn" role="alert">
              ⚠ Usage cannot be read from Claude Code's status line: {state.statusLine.error}
            </div>
          ) : null}
          {live?.mismatch ? (
            <div className="ff-acc-banner ff-acc-banner-warn" role="alert">
              ⚠ {live.mismatch}
            </div>
          ) : null}
          {live && !live.loggedIn ? (
            <div className="ff-acc-banner">This computer is not logged in to Claude Code. Add an account, or switch to a saved one.</div>
          ) : live && !live.known ? (
            <div className="ff-acc-banner">
              <span>
                Logged in as <strong>{live.email ?? "an unsaved account"}</strong>
                {live.organizationName ? ` · ${live.organizationName}` : ""} — save it to switch between accounts.
              </span>
              <button type="button" className="ff-btn ff-btn-small ff-btn-primary" disabled={busy} onClick={() => void act(() => api.invoke("accounts:captureCurrent", {}), () => notify("info", "Current login saved."))}>
                Save this login
              </button>
            </div>
          ) : null}

          {login ? (
            <section className="ff-card ff-acc-login" aria-label="Login in progress">
              <div className="ff-card-head">
                <div>
                  <h2>Log in to another account</h2>
                  <p className="ff-muted ff-small">
                    Finish the login in your browser (or paste the code below). It runs in a separate folder: the current login keeps working until you switch.
                  </p>
                </div>
                <button type="button" className="ff-btn ff-btn-danger" onClick={() => void act(() => api.invoke("accounts:cancelLogin", { loginId: login.loginId }))}>
                  Cancel
                </button>
              </div>
              <div className="ff-acc-login-term">
                <LiveTerminal key={login.terminalId} terminalId={login.terminalId} />
              </div>
            </section>
          ) : null}

          <section className="ff-acards" aria-label="Accounts and quota">
            {accounts.length === 0 ? (
              <div className="ff-empty">
                <p>{live?.loggedIn && !live.known ? "Save the current login above, then add more accounts." : "Add an account to get started."}</p>
              </div>
            ) : (
              accounts.map((a, i) => (
                <AccountBlock
                  key={a.id}
                  slot={i + 1}
                  account={a}
                  now={now}
                  busy={busy}
                  onSwitch={() => setSwitching(a)}
                  onRename={() => setRenaming({ account: a, label: a.label ?? "" })}
                  onRemove={() => setRemoving(a)}
                />
              ))
            )}
          </section>
        </>
      )}

      <ConfirmDialog
        open={!!switching}
        title={`Switch to ${nameOf(switching)}?`}
        confirmLabel="Switch account"
        busy={busy}
        onCancel={() => setSwitching(undefined)}
        onConfirm={() =>
          void act(
            () => api.invoke("accounts:switch", { accountId: switching!.id }),
            (result) => {
              setSwitching(undefined);
              notify("info", `Every new claude now uses ${nameOf(switching)}.${result.warnings.length ? ` ${result.warnings.join(" ")}` : ""}`);
            },
          )
        }
      >
        <p>
          Every <code>claude</code> started from now on uses <strong>{nameOf(switching)}</strong>
          {activeAccount ? (
            <>
              {" "}
              instead of <strong>{nameOf(activeAccount)}</strong>
            </>
          ) : null}
          . The current login is parked in FrontFlow's vault, so you can switch back at any time.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={!!removing}
        title={`Remove ${nameOf(removing)}?`}
        confirmLabel="Remove"
        danger
        busy={busy}
        onCancel={() => setRemoving(undefined)}
        onConfirm={() => void act(() => api.invoke("accounts:remove", { accountId: removing!.id }), () => setRemoving(undefined))}
      >
        <p>FrontFlow forgets this account and its saved login. {removing?.active ? "This computer stays logged in to it until you switch or log out." : "Its Claude account itself is not affected."}</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={!!renaming}
        title="Rename account"
        confirmLabel="Save"
        busy={busy}
        onCancel={() => setRenaming(undefined)}
        onConfirm={() => void act(() => api.invoke("accounts:rename", { accountId: renaming!.account.id, label: renaming!.label }), () => setRenaming(undefined))}
      >
        <label className="ff-field">
          <span>Label</span>
          <input className="ff-input" value={renaming?.label ?? ""} maxLength={80} placeholder={renaming?.account.email ?? "e.g. Work"} onChange={(e) => renaming && setRenaming({ ...renaming, label: e.target.value })} />
        </label>
      </ConfirmDialog>
    </div>
  );
}

interface Row {
  key: string;
  label: string;
  /** undefined: unknown. */
  pct?: number;
  suffix?: string;
  /** "(ahead of pace)", "(!)" … */
  flag?: { text: string; tone: "warn" | "crit" };
  pace?: number;
  note?: string;
}

/** `$$` (extra usage) first, then 5h, 7d, and the per-model limits, like claude-swap. */
function rowsOf(a: AccountDto, now: number): Row[] {
  const rows: Row[] = [];
  const extra = a.quota?.extra;
  if (extra?.["is_enabled"] === true && typeof extra["utilization"] === "number") {
    rows.push({ key: "$$", label: "$$", pct: extra["utilization"], suffix: spendText(extra) });
  }
  for (const w of a.quota?.windows ?? []) rows.push(windowRow(w, now));
  return rows;
}

function windowRow(w: QuotaWindowDto, now: number): Row {
  const weekly = w.key !== "five_hour";
  const exhausted = w.utilization >= 100;
  return {
    key: w.key,
    label: w.label,
    pct: w.utilization,
    suffix: w.resetSinceCheck ? "reset since last check" : w.resetsAt ? resetText(w.resetsAt, now) : "",
    // The 5h window has no pace note: it resets too soon for one to mean much.
    ...(exhausted && w.key.startsWith("model:") ? { flag: { text: "(!)", tone: "crit" as const } } : weekly && w.aheadOfPace ? { flag: { text: "(ahead of pace)", tone: "warn" as const } } : {}),
    ...(w.expectedPct !== undefined && weekly ? { pace: w.expectedPct } : {}),
    ...(w.projectedExhaustionAt ? { note: `out ${durationText(Date.parse(w.projectedExhaustionAt) - now, "in ")} at this pace` } : {}),
  };
}

/** What each quota tile is called: the window, and what it covers. */
function tileTitle(key: string, label: string): { title: string; sub: string } {
  if (key === "five_hour") return { title: "Session", sub: "5-hour window" };
  if (key === "seven_day") return { title: "Week", sub: "all models" };
  if (key === "$$") return { title: "Extra usage", sub: "this month" };
  if (key.startsWith("model:")) return { title: label, sub: "week, this model" };
  return { title: label, sub: "" };
}

/**
 * One saved account as a card: who it is and where its login is, then one tile per quota
 * window — the share used in large type, a bar with the even-pace mark, when it resets and
 * whether it runs out first.
 */
function AccountBlock({
  slot,
  account: a,
  now,
  busy,
  onSwitch,
  onRename,
  onRemove,
}: {
  slot: number;
  account: AccountDto;
  now: number;
  busy: boolean;
  onSwitch(): void;
  onRename(): void;
  onRemove(): void;
}) {
  const rows = rowsOf(a, now);
  const age = a.quota ? now - Date.parse(a.quota.fetchedAt) : undefined;
  const stale = age !== undefined && age > STALE_MS;
  const expiry = loginExpiry(a, now);
  const name = a.label ?? a.email ?? a.id.slice(0, 8);
  const plan = [a.subscriptionType ? planLabel(a.subscriptionType) : undefined, a.organizationName].filter(Boolean).join(" · ");
  const lost = a.location === "lost";
  return (
    <article className={`ff-acard${a.active ? " ff-acard-active" : ""}`} aria-label={`Account ${slot}: ${nameOf(a)}`}>
      <header className="ff-acard-head">
        <span className="ff-acard-avatar" style={{ background: slot <= 7 ? `var(--viz-${slot})` : "var(--viz-other)" }} aria-hidden="true">
          {initials(nameOf(a))}
        </span>
        <div className="ff-acard-who">
          <div className="ff-acard-name">
            <strong title={a.email}>{name}</strong>
            {a.label && a.email ? <span className="ff-muted ff-small">{a.email}</span> : null}
            {a.active ? <span className="ff-chip ff-chip-ok">Active</span> : null}
            {a.location === "profile" ? (
              <span className="ff-chip" title="Its login is in its own Claude config folder, for FrontFlow runs that use this account">
                Runs in FrontFlow
              </span>
            ) : null}
            {a.status === "needs_login" ? (
              <span className="ff-chip ff-chip-crit" title={lost ? "Claude Code was signed in to another account outside FrontFlow, so this login was not kept." : undefined}>
                {lost ? "Login replaced — add it again" : "Login expired"}
              </span>
            ) : null}
          </div>
          <div className="ff-acard-meta">
            {plan ? <span>{plan}</span> : null}
            {expiry && a.status !== "needs_login" ? (
              <span className={expiry.tone === "ok" ? undefined : toneClass(expiry.tone)} title={expiry.title}>
                {expiry.tone === "ok" ? "" : "⚠ "}
                {expiry.text}
              </span>
            ) : null}
            {a.quota ? (
              <span title={a.quota.source === "statusline" ? "Read from a Claude Code session's status line: no request was sent" : "Asked from Anthropic"}>
                {a.quota.source === "statusline" ? "from status line" : "checked"} {age !== undefined && age >= 60_000 ? `${durationText(age)} ago` : "just now"}
              </span>
            ) : null}
          </div>
        </div>
        <div className="ff-acard-actions">
          {!a.active ? (
            <button type="button" className="ff-btn ff-btn-small ff-btn-primary" disabled={busy || a.status === "needs_login"} title={a.status === "needs_login" ? "Log in to this account again (Add account)" : undefined} onClick={onSwitch}>
              Switch
            </button>
          ) : null}
          <Menu
            label="More actions"
            className="ff-icon-btn ff-acc-icon"
            disabled={busy}
            trigger="⋯"
            items={[
              { label: "Rename", onSelect: onRename },
              { label: "Remove", danger: true, onSelect: onRemove },
            ]}
          />
        </div>
      </header>

      {rows.length ? (
        <div className={`ff-mtiles${stale ? " ff-mtiles-stale" : ""}`}>
          {rows.map((r) => (
            <MetricTile key={r.key} row={r} />
          ))}
        </div>
      ) : (
        <p className="ff-acard-nodata">
          {a.quotaError
            ? `Usage unavailable · ${a.quotaError.message}`
            : a.status === "needs_login"
              ? "Usage unknown — add the account again to log in."
              : "No usage yet: it shows after this account's next Claude Code response (status line), or when FrontFlow may ask Anthropic."}
        </p>
      )}

      <details className="ff-wdetails ff-acard-details">
        <summary>Details</summary>
        <dl>
          <Detail label="Account ID" value={a.id} mono />
          {a.email ? <Detail label="Email" value={a.email} /> : null}
          {a.displayName ? <Detail label="Name" value={a.displayName} /> : null}
          {a.organizationUuid ? <Detail label="Organization ID" value={a.organizationUuid} mono /> : null}
          {a.rateLimitTier ? <Detail label="Rate-limit tier" value={a.rateLimitTier} /> : null}
          {a.billingType ? <Detail label="Billing" value={a.billingType} /> : null}
          <Detail label="Login kept in" value={a.location === "live" || a.active ? "Claude Code (in use)" : a.location === "profile" ? "its own Claude config folder (runs)" : lost ? "nowhere: replaced outside FrontFlow" : "FrontFlow's vault (parked)"} />
          <Detail label="Saved" value={new Date(a.addedAt).toLocaleString()} />
          {a.lastActivatedAt ? <Detail label="Last switched to" value={new Date(a.lastActivatedAt).toLocaleString()} /> : null}
          {a.refreshExpiresAt ? <Detail label="Login valid until" value={new Date(a.refreshExpiresAt).toLocaleString()} /> : null}
          {Object.entries(a.profile ?? {}).map(([k, v]) => (
            <Detail key={k} label={k} value={v === null ? "—" : String(v)} />
          ))}
        </dl>
      </details>
    </article>
  );
}

function MetricTile({ row: r }: { row: Row }) {
  const pct = r.pct === undefined ? undefined : Math.max(0, Math.min(100, r.pct));
  const tone = severity(r.pct);
  const { title, sub } = tileTitle(r.key, r.label);
  return (
    <div className={`ff-mtile ff-mtile-${tone}`}>
      <div className="ff-mtile-head">
        <span className="ff-mtile-title">{title}</span>
        {sub ? <span className="ff-mtile-sub">{sub}</span> : null}
      </div>
      <div className={`ff-mtile-value ff-sevtext-${tone}`}>
        {pct === undefined ? (
          "—"
        ) : (
          <>
            {Math.round(pct)}
            <small>%</small>
          </>
        )}
      </div>
      <span className="ff-wbar ff-mtile-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct === undefined ? undefined : Math.round(pct)} aria-label={title}>
        <span className="ff-wtrack" />
        {pct !== undefined ? <span className={`ff-wfill ff-sev-${tone}`} style={{ width: `${pct}%` }} /> : null}
        {r.pace !== undefined ? <span className="ff-wpace" style={{ left: `${r.pace}%` }} title={`Even pace: ${Math.round(r.pace)}% by now`} /> : null}
      </span>
      <div className="ff-mtile-foot">{r.suffix || " "}</div>
      {r.flag || r.note ? (
        <div className={`ff-mtile-note ${r.flag?.tone === "crit" ? "ff-wcrit" : "ff-wwarn"}`}>
          {r.flag?.tone === "crit" ? "Limit reached" : r.note ? `Runs out ${r.note.replace(/^out /, "").replace(/ at this pace$/, "")} at this pace` : "Ahead of an even pace"}
        </div>
      ) : null}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono ? "ff-mono" : undefined}>{value}</dd>
    </>
  );
}

/** Extra-usage amounts come in minor units (`decimal_places`, cents by default). */
function spendText(extra: Record<string, string | number | boolean | null>): string {
  const currency = typeof extra["currency"] === "string" ? extra["currency"] : "USD";
  const decimals = typeof extra["decimal_places"] === "number" ? extra["decimal_places"] : 2;
  const money = (minor: number) => new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 10 ** decimals);
  const used = extra["used_credits"];
  const limit = extra["monthly_limit"];
  return typeof used === "number" && typeof limit === "number" ? `${money(used)} / ${money(limit)}` : "extra usage";
}

function planLabel(plan: string): string {
  const map: Record<string, string> = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise", free: "Free" };
  return map[plan.toLowerCase()] ?? plan;
}
