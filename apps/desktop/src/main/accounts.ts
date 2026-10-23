import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { app, safeStorage } from "electron";
import { newId } from "@frontflow/domain";
import type { OpenTerminalInput } from "@frontflow/cli-adapters";
import {
  ClaudeAccountManager,
  EncryptedFileVault,
  FileCredentialStore,
  liveCredentialStoreFor,
  MacKeychainCredentialStore,
  type LiveCredentialStore,
  fetchProfile,
  fetchQuota,
  listClaudeProcesses,
  mayRequest,
  mergeReading,
  nextPoll,
  paceOf,
  readingFits,
  readLiveLogin,
  readStatusLineReadings,
  resolveClaudePaths,
  TranscriptScanner,
  usageByAccount,
  usageReport,
  type AccountRecord,
  type ClaudeProcess,
  type LocalUsage,
  type Observation,
  type StatusLineReading,
  type TranscriptMessage,
  type UsageWindow,
} from "@frontflow/claude-accounts";
import type { AccountDto, AccountsStateDto, ClaudeProcessDto, IpcPushEvents, QuotaWindowDto } from "../shared/ipc.js";
import { AppError, type IpcHandlers, type PushBus } from "./ipc-gateway.js";
import { runAccountsCommand, splitCommandLine } from "./accounts-commands.js";
import { startAccountsCliServer } from "./accounts-cli.js";
import { QuotaHistory } from "./quota-history.js";
import { installStatusLine, statusLineSetup, uninstallStatusLine } from "./statusline-setup.js";

const TICK_MS = 20_000;
const PROCESS_TTL_MS = 15_000;
const USAGE_SCAN_TTL_MS = 120_000;
const LOCAL_USAGE_DAYS = 30;
/** Status-line readings newer than this are taken in. */
const STATUSLINE_FRESH_MS = 10 * 60_000;
/** Right after the login changes, a session may still pass the previous account's numbers. */
const SWITCH_SETTLE_MS = 60_000;

export interface AccountsDeps {
  dataDir: string;
  bus: PushBus;
  openTerminal(input: OpenTerminalInput): Promise<{ command: string }>;
  closeTerminal(terminalId: string): Promise<void>;
  onTerminalExit(handler: (terminalId: string, exitCode: number | null) => void): () => void;
}

type AccountHandlers = Pick<
  IpcHandlers,
  | "accounts:state"
  | "accounts:captureCurrent"
  | "accounts:startLogin"
  | "accounts:cancelLogin"
  | "accounts:switch"
  | "accounts:remove"
  | "accounts:rename"
  | "accounts:refresh"
  | "accounts:command"
  | "accounts:usage"
>;

type LoginResult = IpcPushEvents["accounts:login"];

interface PendingLogin {
  loginId: string;
  /** Empty for a login the `ffswap` CLI runs in the user's own terminal. */
  terminalId: string;
  dir: string;
  method: string;
  label?: string;
  startedAt: string;
  cancelled?: boolean;
}

/**
 * The Accounts screen's backend: Claude Code logins of this machine, switched machine-wide.
 * Tokens stay in the main process (vault + Claude's own files); the renderer only ever sees
 * account metadata, quota numbers and fingerprints-free status.
 */
export function createAccountsService(deps: AccountsDeps) {
  const { bus } = deps;
  const storeDir = join(deps.dataDir, "claude-accounts");
  const loginsDir = join(storeDir, "logins");
  const paths = resolveClaudePaths(process.env);
  // Leftover isolated logins (crash mid-login) hold plaintext tokens: never keep them.
  removeDir(loginsDir);

  const unsupportedReason = !safeStorage.isEncryptionAvailable() ? "The OS credential vault is not available, so logins cannot be stored safely." : undefined;
  // Linux without a keyring (no libsecret / kwallet): Electron falls back to a fixed key.
  const vaultWarning =
    process.platform === "linux" && safeStorage.getSelectedStorageBackend?.() === "basic_text"
      ? "No system keyring found: saved logins are only obfuscated on disk. Install gnome-keyring or KWallet to encrypt them."
      : undefined;
  // Windows/Linux/WSL: a file Claude Code re-reads on change. macOS: the login Keychain item.
  const liveStore = liveCredentialStoreFor(paths);

  // FrontFlow sends no request with a Claude login: quota comes from Claude Code's status line,
  // Claude Code renews the logins it holds, and a renewed live token is recognized by continuity.
  const manager = unsupportedReason
    ? undefined
    : new ClaudeAccountManager({
        paths,
        storeDir,
        vault: new EncryptedFileVault(join(storeDir, "vault.json"), {
          encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
          decrypt: (enc) => safeStorage.decryptString(Buffer.from(enc, "base64")),
        }),
        liveStore,
        profileStore: (p) => isolatedStore(p.configDir, p),
      });
  const requireManager = () => {
    if (!manager) throw new AppError("UNSUPPORTED", unsupportedReason ?? "Accounts are not supported here");
    return manager;
  };

  const logins = new Map<string, PendingLogin>();
  const statusLineDir = join(homedir(), ".frontflow", "statusline");
  const ffswapPath = join(app.getAppPath(), "bin", "ffswap.mjs");
  let lastObservation: Observation | undefined;
  let processes: { at: number; list: ClaudeProcess[] } = { at: 0, list: [] };
  let localUsage: { at: number; messages: TranscriptMessage[]; byAccount: Map<string, LocalUsage>; unattributed: LocalUsage } | undefined;
  const scanner = new TranscriptScanner();
  const quotaHistory = new QuotaHistory(join(storeDir, "quota-history.jsonl"));

  async function currentProcesses(): Promise<ClaudeProcess[]> {
    if (Date.now() - processes.at > PROCESS_TTL_MS) {
      processes = { at: Date.now(), list: await listClaudeProcesses(run) };
    }
    return processes.list;
  }

  /** Pushes fresh state when done; callers other than the Usage screen do not wait for it. */
  let scanning: Promise<void> | undefined;
  function refreshLocalUsage(force = false): Promise<void> {
    if (!manager) return Promise.resolve();
    if (scanning) return scanning;
    if (!force && localUsage && Date.now() - localUsage.at < USAGE_SCAN_TTL_MS) return Promise.resolve();
    const since = Date.now() - LOCAL_USAGE_DAYS * 86_400_000;
    scanning = scanner
      .scan(paths.projectsDir, since)
      .then((messages) => {
        localUsage = { at: Date.now(), messages, ...usageByAccount(messages, manager.timeline(), Date.now()) };
        return pushState();
      })
      .catch((err) => console.warn("[accounts] usage scan failed:", (err as Error).message))
      .finally(() => {
        scanning = undefined;
      });
    return scanning;
  }

  async function state(): Promise<AccountsStateDto> {
    const base = { configDir: paths.configDir, liveStore: liveStore.kind, ...(vaultWarning ? { vaultWarning } : {}), logins: [...logins.values()].filter((l) => l.terminalId).map((l) => ({ loginId: l.loginId, terminalId: l.terminalId, method: l.method, startedAt: l.startedAt })) };
    if (!manager) return { supported: false, unsupportedReason: unsupportedReason!, accounts: [], live: { loggedIn: false, known: false }, processes: [], ...base };
    let observation: Observation;
    try {
      observation = await manager.observe();
    } catch (err) {
      observation = { loggedIn: false, mismatch: `Could not read Claude's login: ${(err as Error).message}` };
    }
    lastObservation = observation;
    const timeline = manager.timeline();
    const procs = (await currentProcesses()).map((p): ClaudeProcessDto => ({ ...p, accountId: ownerAt(timeline, p.startedAt) }));
    const records = manager.list();
    const byId = new Map(records.map((r) => [r.id, r]));
    const identity = observation.identity;
    return {
      supported: true,
      ...base,
      accounts: records.map((r) => toDto(r, observation, procs)).sort((a, b) => Number(b.active) - Number(a.active) || a.addedAt.localeCompare(b.addedAt)),
      live: {
        loggedIn: observation.loggedIn,
        known: !!observation.accountId,
        ...(observation.accountId ? { accountId: observation.accountId } : {}),
        ...(identity?.emailAddress ? { email: String(identity.emailAddress) } : observation.accountId && byId.get(observation.accountId)?.email ? { email: byId.get(observation.accountId)!.email! } : {}),
        ...(identity?.organizationName ? { organizationName: String(identity.organizationName) } : {}),
        ...(observation.subscriptionType ? { subscriptionType: observation.subscriptionType } : {}),
        ...(observation.mismatch ? { mismatch: observation.mismatch } : {}),
      },
      processes: procs,
      statusLine: { ...statusLineSetup(paths.configDir, ffswapPath), ...(lastReadingAt ? { lastReadingAt } : {}), ...(statusLineError ? { error: statusLineError } : {}) },
      ...(localUsage ? { unattributedUsage: localUsage.unattributed, usageScannedAt: new Date(localUsage.at).toISOString() } : {}),
      ...(timeline[0] ? { trackingSince: timeline[0].at } : {}),
    };
  }

  function toDto(r: AccountRecord, observation: Observation, procs: ClaudeProcessDto[]): AccountDto {
    const usage = localUsage?.byAccount.get(r.id);
    return {
      id: r.id,
      ...(r.label ? { label: r.label } : {}),
      ...(r.email ? { email: r.email } : {}),
      ...(r.displayName ? { displayName: r.displayName } : {}),
      ...(r.organizationName ? { organizationName: r.organizationName } : {}),
      ...(r.organizationUuid ? { organizationUuid: r.organizationUuid } : {}),
      ...(r.subscriptionType ? { subscriptionType: r.subscriptionType } : {}),
      ...(r.rateLimitTier ? { rateLimitTier: r.rateLimitTier } : {}),
      ...(r.billingType ? { billingType: r.billingType } : {}),
      active: observation.accountId === r.id,
      status: manager!.status(r),
      ...(r.location ? { location: r.location } : {}),
      addedAt: r.addedAt,
      ...(r.lastActivatedAt ? { lastActivatedAt: r.lastActivatedAt } : {}),
      ...(r.accessExpiresAt ? { accessExpiresAt: r.accessExpiresAt } : {}),
      ...(r.refreshExpiresAt ? { refreshExpiresAt: r.refreshExpiresAt } : {}),
      ...(r.usage ? { quota: { ...r.usage, windows: r.usage.windows.map((w) => windowDto(w, Date.now())) } } : {}),
      ...(r.usageError ? { quotaError: r.usageError } : {}),
      ...(r.profile ? { profile: r.profile } : {}),
      ...(usage ? { localUsage: usage } : {}),
      runningProcesses: procs.filter((p) => p.accountId === r.id).length,
    };
  }

  async function pushState(): Promise<void> {
    try {
      bus.send("accounts:changed", await state());
    } catch (err) {
      console.warn("[accounts] state failed:", (err as Error).message);
    }
  }

  /**
   * `ffswap statusline` in Claude Code's settings.json `statusLine`, put there on start (and kept
   * there): every Claude Code session then files its 5h / weekly usage for FrontFlow to read.
   * A status line the user already had keeps running after it.
   */
  let statusLineError: string | undefined;
  function ensureStatusLine(): void {
    try {
      const setup = statusLineSetup(paths.configDir, ffswapPath);
      if (setup.available && !setup.installed) installStatusLine(paths.configDir, ffswapPath);
      statusLineError = setup.available ? undefined : setup.reason;
    } catch (err) {
      statusLineError = (err as Error).message;
    }
  }
  if (manager) ensureStatusLine();

  /**
   * Quota from Claude Code's sessions (`ffswap statusline`): FrontFlow asks Anthropic nothing.
   * A reading of a session in a profile folder is that account's; any other is the login in
   * use's, once a switch has settled and when its 5h window can be that account's.
   */
  let lastReadingAt: string | undefined;
  async function ingestStatusLine(obs: Observation | undefined): Promise<boolean> {
    if (!manager) return false;
    const now = Date.now();
    const fresh = readStatusLineReadings(statusLineDir, now - STATUSLINE_FRESH_MS, now).filter((r) => !lastReadingAt || r.at > lastReadingAt);
    if (!fresh.length) return false;
    lastReadingAt = fresh[0]!.at;
    const records = manager.list();
    const changedAt = Date.parse(manager.timeline().at(-1)?.at ?? "");
    // Newest per account: a session in a profile folder is that account's; any other, the login in use.
    const taken = new Map<string, StatusLineReading>();
    for (const r of fresh) {
      const owner = r.configDir ? records.find((a) => a.location === "profile" && a.profileDir && samePath(a.profileDir, r.configDir!)) : undefined;
      if (r.configDir && !owner && !samePath(r.configDir, paths.configDir)) continue;
      const id = owner?.id ?? obs?.accountId;
      if (!id || taken.has(id)) continue;
      if (!owner && Number.isFinite(changedAt) && Date.parse(r.at) < changedAt + SWITCH_SETTLE_MS) continue;
      taken.set(id, r);
    }
    let changed = false;
    for (const [id, reading] of taken) {
      const record = records.find((a) => a.id === id);
      if (!record || !readingFits(reading, record.usage, now)) continue;
      await manager.recordUsage(id, { usage: mergeReading(record.usage, reading), poll: record.poll });
      quotaHistory.record(id, reading.windows);
      changed = true;
    }
    return changed;
  }

  /**
   * The Claude config folder a FrontFlow run uses to run as `accountId`: undefined for the login
   * in use (runs use it directly), else the account's profile folder, its login moved there from
   * the vault. The user's own Claude settings follow it (copied, re-synced on every run).
   */
  async function claudeProfileFor(accountId: string): Promise<string | undefined> {
    const m = requireManager();
    if (!m.get(accountId)) throw new AppError("NOT_FOUND", "The Claude account chosen for this run is no longer saved");
    if (m.isLive(accountId)) return undefined;
    const dir = join(storeDir, "profiles", accountId);
    try {
      await m.moveToProfile(accountId, dir);
    } catch (err) {
      throw new AppError("CLAUDE_ACCOUNT", `Cannot run as this Claude account: ${(err as Error).message}`);
    }
    shareUserConfig(paths.configDir, dir);
    void pushState();
    return dir;
  }

  let ticking = false;
  const tick = async () => {
    if (ticking || !manager) return;
    ticking = true;
    try {
      const before = JSON.stringify([lastObservation?.accountId, lastObservation?.mismatch, lastObservation?.fingerprint]);
      const obs = await manager.observe().catch(() => undefined);
      if (obs) lastObservation = obs;
      const read = await ingestStatusLine(obs);
      void refreshLocalUsage();
      if (read || JSON.stringify([obs?.accountId, obs?.mismatch, obs?.fingerprint]) !== before) await pushState();
    } finally {
      ticking = false;
    }
  };
  const timer = manager ? setInterval(() => void tick(), TICK_MS) : undefined;
  timer?.unref?.();
  if (manager) setTimeout(() => void tick(), 1500).unref?.();

  const offExit = deps.onTerminalExit((terminalId) => {
    const login = [...logins.values()].find((l) => l.terminalId === terminalId);
    if (!login) return;
    logins.delete(login.loginId);
    void finishLogin(login);
  });

  async function finishLogin(login: PendingLogin): Promise<LoginResult> {
    const loginPaths = resolveClaudePaths({ CLAUDE_CONFIG_DIR: login.dir });
    // On macOS `claude auth login` writes a Keychain item of its own for this folder.
    const store = isolatedStore(login.dir, loginPaths);
    let result: LoginResult;
    try {
      if (login.cancelled) {
        result = { loginId: login.loginId, status: "cancelled" };
      } else {
        const record = await requireManager().captureFrom(loginPaths, login.label, false, store);
        result = { loginId: login.loginId, status: "succeeded", accountId: record.id };
        void tick();
      }
    } catch (err) {
      result = { loginId: login.loginId, status: "failed", message: (err as Error).message };
    } finally {
      // The isolated folder (and Keychain item) hold the new login's tokens: they now live in the vault only.
      try {
        store.clear?.();
      } catch (err) {
        console.warn("[accounts] could not delete the login's Keychain item:", (err as Error).message);
      }
      removeDir(login.dir);
    }
    bus.send("accounts:login", result);
    await pushState();
    return result;
  }

  /** `ffswap add --login`: the CLI runs `claude <args>` with CLAUDE_CONFIG_DIR=dir in its own terminal. */
  function beginExternalLogin(method: "claudeai" | "sso", label?: string): { loginId: string; dir: string; args: string[] } {
    requireManager();
    if (logins.size) throw new AppError("LOGIN_IN_PROGRESS", "Finish or cancel the login in progress first");
    const loginId = newId("login");
    const dir = join(loginsDir, loginId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    logins.set(loginId, { loginId, terminalId: "", dir, method, ...(label ? { label } : {}), startedAt: new Date().toISOString() });
    return { loginId, dir, args: ["auth", "login", method === "sso" ? "--sso" : "--claudeai"] };
  }

  async function finishExternalLogin(loginId: string, cancelled: boolean): Promise<LoginResult> {
    const login = logins.get(loginId);
    if (!login || login.terminalId) throw new AppError("NOT_FOUND", "Unknown login");
    logins.delete(loginId);
    login.cancelled = cancelled;
    return finishLogin(login);
  }

  function isolatedStore(dir: string, loginPaths: ReturnType<typeof resolveClaudePaths>): LiveCredentialStore {
    return process.platform === "darwin"
      ? new MacKeychainCredentialStore(loginPaths, { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, isolated: true })
      : new FileCredentialStore(loginPaths);
  }

  const handlers: AccountHandlers = {
    "accounts:state": async () => {
      ensureStatusLine();
      void refreshLocalUsage();
      return state();
    },
    "accounts:captureCurrent": async ({ label }) => {
      const record = await requireManager().captureLive(label);
      void tick();
      const s = await state();
      return s.accounts.find((a) => a.id === record.id)!;
    },
    "accounts:startLogin": async ({ method, email, label, cols, rows }) => {
      requireManager();
      if (logins.size) throw new AppError("LOGIN_IN_PROGRESS", "Finish or cancel the login in progress first");
      const loginId = newId("login");
      const dir = join(loginsDir, loginId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const terminalId = newId("term");
      const login: PendingLogin = { loginId, terminalId, dir, method, ...(label ? { label } : {}), startedAt: new Date().toISOString() };
      logins.set(loginId, login);
      try {
        await deps.openTerminal({
          terminalId,
          adapterId: "claude-code",
          args: ["auth", "login", method === "sso" ? "--sso" : "--claudeai", ...(email ? ["--email", email] : [])],
          // A separate config folder: the machine's current login is not touched until the user switches.
          env: { CLAUDE_CONFIG_DIR: dir },
          // Not `dir`: on Windows a process's working folder cannot be deleted while it lives.
          cwd: storeDir,
          cols,
          rows,
        });
      } catch (err) {
        logins.delete(loginId);
        removeDir(dir);
        throw err;
      }
      void pushState();
      return { loginId, terminalId };
    },
    "accounts:cancelLogin": async ({ loginId }) => {
      const login = logins.get(loginId);
      if (!login) return;
      login.cancelled = true;
      await deps.closeTerminal(login.terminalId);
    },
    "accounts:switch": async ({ accountId }) => {
      const outcome = await requireManager().switchTo(accountId);
      processes = { at: 0, list: [] };
      const running = (await currentProcesses()).length;
      void pushState();
      // Claude Code re-reads its credentials file when it changes (Windows/Linux); the macOS Keychain needs a restart.
      const restartRequired = process.platform === "darwin";
      return {
        accountId,
        restartRequired,
        runningProcesses: running,
        warnings: [
          ...outcome.warnings,
          ...(running && restartRequired ? [`${running} Claude process${running === 1 ? " is" : "es are"} still running with the previous login; restart ${running === 1 ? "it" : "them"}.`] : []),
        ],
      };
    },
    "accounts:remove": async ({ accountId }) => {
      await requireManager().remove(accountId);
      void pushState();
    },
    "accounts:rename": async ({ accountId, label }) => {
      await requireManager().rename(accountId, label);
      void pushState();
    },
    // Reads this computer again (logins, status-line readings, transcripts): nothing is asked of Anthropic.
    "accounts:refresh": async () => {
      requireManager();
      processes = { at: 0, list: [] };
      void refreshLocalUsage(true);
      await tick();
      await pushState();
    },
    "accounts:command": async ({ line }) => {
      const { ok, output } = await runAccountsCommand(splitCommandLine(line), { handlers }, "ui");
      return { ok, output };
    },
    "accounts:usage": async ({ days }) => {
      const m = requireManager();
      await refreshLocalUsage();
      const now = Date.now();
      const timeline = m.timeline();
      return {
        ...usageReport(localUsage?.messages ?? [], timeline, now, days),
        quotaHistory: quotaHistory.since(now - days * 86_400_000),
        ...(timeline[0] ? { trackingSince: timeline[0].at } : {}),
      };
    },
  };

  // `ffswap …` in any terminal runs the same commands as the Accounts screen's command box.
  const cli = manager ? startAccountsCliServer({ handlers, beginExternalLogin, finishExternalLogin }) : undefined;

  return {
    handlers,
    claudeProfileFor,
    dispose() {
      cli?.close();
      if (timer) clearInterval(timer);
      offExit();
      for (const login of logins.values()) removeDir(login.dir);
    },
  };
}

/** Best effort: on Windows a folder still in use by a process (EBUSY/EPERM) cannot be deleted; the next start retries. */
function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[accounts] could not delete ${dir}:`, (err as Error).message);
  }
}

/** What a profile folder takes from the user's Claude folder: settings and instructions, never logins or history. */
const SHARED_CLAUDE_ENTRIES = ["settings.json", "CLAUDE.md", "keybindings.json", "skills", "commands", "agents", "rules", "output-styles"];

function shareUserConfig(from: string, to: string): void {
  for (const name of SHARED_CLAUDE_ENTRIES) {
    const src = join(from, name);
    if (!existsSync(src)) continue;
    try {
      cpSync(src, join(to, name), { recursive: true, force: true });
    } catch (err) {
      console.warn(`[accounts] could not share ${name} with a profile:`, (err as Error).message);
    }
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/**
 * A window whose reset passed since the last reading restarted at 0%: shown so, marked, rather
 * than asking Anthropic again just to learn it (a parked account is not polled to see that).
 */
function windowDto(w: UsageWindow, now: number): QuotaWindowDto {
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  if (Number.isFinite(reset) && reset <= now) return { key: w.key, label: w.label, utilization: 0, resetSinceCheck: true };
  return { ...w, ...paceOf(w, now) };
}

/** Account that held the machine-wide login when a process started (it keeps that login). */
function ownerAt(timeline: Array<{ accountId: string | null; at: string }>, startedAt: string | undefined): string | null | undefined {
  if (!startedAt) return undefined;
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t) || !timeline.length || t < Date.parse(timeline[0]!.at)) return undefined;
  let owner: string | null = null;
  for (const entry of timeline) {
    if (Date.parse(entry.at) > t) break;
    owner = entry.accountId;
  }
  return owner;
}

function run(file: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}
