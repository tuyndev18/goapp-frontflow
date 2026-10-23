import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { composeCredentials, FileCredentialStore, type LiveCredentialStore } from "./credential-store.js";
import { acquireDirLock, atomicWriteFile, readJsonObject, withLock } from "./fsx.js";
import { claudeLockPaths, fingerprint, readLiveLogin, resolveClaudePaths, toIso, type LiveLogin } from "./live.js";
import { refreshOAuthToken, type RefreshOptions } from "./oauth.js";
import type { AccountRecord, AccountStatus, AuditEntry, ClaudePaths, LoginSnapshot, OAuthAccountInfo, SecretVault, TimelineEntry, UsageSnapshot } from "./types.js";

export class AccountError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "NO_LOGIN" | "NO_IDENTITY" | "UNSTABLE" | "NEEDS_LOGIN" | "VERIFY_FAILED" | "VAULT_MISSING" | "UNSAVED_LIVE" | "IN_USE",
    message: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

export interface AccountManagerOptions {
  /** The machine-wide login (what `claude` uses). */
  paths: ClaudePaths;
  /** FrontFlow's own folder for the account index (no secrets) and the lock. */
  storeDir: string;
  vault: SecretVault;
  now?: () => Date;
  /** Delay between the two reads that must agree before a login is captured. */
  stableReadDelayMs?: number;
  /**
   * Asks the provider whose token this is. Used before saving a live token that matched an
   * account only by the identity file, which a stale `claude` process may leave out of date.
   */
  verifyAccount?: (accessToken: string) => Promise<string | undefined>;
  /**
   * false: verifyAccount must not be called now (FrontFlow sends no request). A renewed live
   * token is then recognized by continuity instead: same identity, no switch in between.
   */
  canVerify?: () => boolean;
  /** Where the live login is (file by default; the macOS Keychain on a Mac). */
  liveStore?: LiveCredentialStore;
  /** Where Claude Code keeps the login of a profile folder (file by default; its own Keychain item on a Mac). */
  profileStore?: (paths: ClaudePaths) => LiveCredentialStore;
}

export interface Observation {
  loggedIn: boolean;
  /** Stored account holding the live login. */
  accountId?: string;
  fingerprint?: string;
  identity?: LiveLogin["identity"];
  subscriptionType?: string;
  /** Why the live login is suspicious, if it is. */
  mismatch?: string;
}

export interface SwitchOutcome {
  accountId: string;
  previousAccountId?: string;
  /** Running `claude` processes keep their in-memory login until restarted. */
  restartRequired: true;
  warnings: string[];
}

interface IndexFile {
  version: number;
  accounts: AccountRecord[];
  timeline: TimelineEntry[];
  audit: AuditEntry[];
  lastSwitch?: { accountId: string; at: string; fingerprint: string };
  /** The live login as last observed: a new token under the same identity since is Claude Code renewing it. */
  lastLive?: { accountId: string; fingerprint: string };
}

/** 2: one place per login (the live one is never copied into the vault). */
const INDEX_VERSION = 2;
const MAX_TIMELINE = 1000;
const MAX_AUDIT = 500;
const MAX_FINGERPRINTS = 20;
/** Backup slots of version 1, which kept a copy of the live login on every switch. */
const LEGACY_BACKUP_SLOTS = 3;
const accountKey = (id: string) => `claude:account:${id}`;

/**
 * Stored Claude logins and the machine-wide switch between them (spec doc §4.2–4.4, §4.12).
 *
 * Every login is in exactly one place, like a key that is either in the lock or on the hook:
 * the account in use only in Claude Code's own login (Claude Code renews it, FrontFlow keeps
 * no copy), every other account only in the vault ("parked"). A switch parks the outgoing
 * login, writes the incoming one under Claude Code's own locks, verifies it, and only then
 * drops the incoming one from the vault; an interrupted switch leaves a duplicate that the
 * next observation removes. Every change is audited with fingerprints, never tokens.
 */
export class ClaudeAccountManager {
  private readonly indexFile: string;
  private readonly lockDir: string;
  private readonly now: () => Date;

  constructor(private readonly options: AccountManagerOptions) {
    this.indexFile = join(options.storeDir, "index.json");
    this.lockDir = join(options.storeDir, ".lock");
    this.now = options.now ?? (() => new Date());
  }

  get paths(): ClaudePaths {
    return this.options.paths;
  }

  list(): AccountRecord[] {
    return this.readIndex().accounts;
  }

  get(id: string): AccountRecord | undefined {
    return this.readIndex().accounts.find((a) => a.id === id);
  }

  timeline(): TimelineEntry[] {
    return this.readIndex().timeline;
  }

  audit(): AuditEntry[] {
    return this.readIndex().audit;
  }

  status(record: AccountRecord): AccountStatus {
    const now = this.now().getTime();
    if (record.location === "lost") return "needs_login";
    if (record.refreshFailure?.code === "invalid_grant") return "needs_login";
    if (record.refreshExpiresAt && Date.parse(record.refreshExpiresAt) <= now) return "needs_login";
    if (record.accessExpiresAt && Date.parse(record.accessExpiresAt) <= now) return "access_expired";
    return "ok";
  }

  /**
   * Reads the live login, recognizes which stored account holds it, saves a newer token of
   * that account back to the vault, and records who held the login from when.
   */
  observe(): Promise<Observation> {
    return withLock(this.lockDir, () => this.observeLocked());
  }

  /** Stores the login `claude` uses right now. */
  captureLive(label?: string): Promise<AccountRecord> {
    return this.captureFrom(this.options.paths, label, true);
  }

  /**
   * Stores the login found in `paths` — the live one, or an isolated config folder a
   * `claude auth login` just wrote. Two reads must agree, so a login being written is not
   * captured half-way (token of one account with the identity of another).
   */
  async captureFrom(paths: ClaudePaths, label?: string, isLive = false, store?: LiveCredentialStore): Promise<AccountRecord> {
    const source = store ?? (isLive ? this.store : new FileCredentialStore(paths));
    const first = readLiveLogin(paths, this.now, source);
    await new Promise((r) => setTimeout(r, this.options.stableReadDelayMs ?? 300));
    const second = readLiveLogin(paths, this.now, source);
    if (!second.snapshot) throw new AccountError("NO_LOGIN", "No Claude subscription login found");
    if (first.fingerprint !== second.fingerprint || first.identity?.accountUuid !== second.identity?.accountUuid) {
      throw new AccountError("UNSTABLE", "The login is being changed right now; try again in a moment");
    }
    let id = second.identity?.accountUuid;
    const verify = this.verifier();
    if (verify) {
      const verified = await verify(second.snapshot.claudeAiOauth.accessToken).catch(() => undefined);
      if (verified && id && verified !== id) {
        throw new AccountError("VERIFY_FAILED", "The token and the account file belong to different accounts; log in again");
      }
      id ??= verified;
    }
    if (!id) throw new AccountError("NO_IDENTITY", "Could not tell which account this login is (no account id); run `claude` once and retry");
    const snapshot = second.snapshot;
    return withLock(this.lockDir, async () => {
      const index = this.readIndex();
      const existing = index.accounts.find((a) => a.id === id);
      if (isLive) {
        // The login in use stays Claude Code's alone: only its details are recorded.
        const record: AccountRecord = { ...fromSnapshot(id, snapshot, existing, this.now(), label), location: "live" };
        index.accounts = [...index.accounts.filter((a) => a.id !== id), record];
        this.audit_(index, { action: "capture", accountId: id, fingerprint: record.fingerprint });
        await this.dropParkedCopy(index, id, snapshot);
        index.lastLive = { accountId: id, fingerprint: record.fingerprint };
        this.pushTimeline(index, id);
        this.writeIndex(index);
        return record;
      }
      // A login made in its own folder is parked, unless its account is the one in use: that
      // one keeps the login Claude Code holds, and the new one is not kept as a second copy.
      if (existing && this.isLiveIn(existing, this.readLive())) {
        const record = label?.trim() ? { ...existing, label: label.trim() } : existing;
        index.accounts = index.accounts.map((a) => (a.id === id ? record : a));
        this.audit_(index, { action: "capture", accountId: id, fingerprint: existing.fingerprint, detail: "in use: kept Claude Code's login" });
        this.writeIndex(index);
        return record;
      }
      await this.options.vault.set(accountKey(id), JSON.stringify(snapshot));
      const record: AccountRecord = { ...fromSnapshot(id, snapshot, existing, this.now(), label), location: "vault" };
      index.accounts = [...index.accounts.filter((a) => a.id !== id), record];
      this.audit_(index, { action: "capture", accountId: id, fingerprint: record.fingerprint });
      this.writeIndex(index);
      return record;
    });
  }

  /**
   * Makes `id` the machine-wide login. Order matters, so an interruption never loses a login:
   * 1. park the login in use in the vault (read under Claude Code's locks, so a renewal that
   *    just finished is the one parked) and read it back;
   * 2. write the incoming login, verify Claude Code's login now holds it;
   * 3. only then drop the incoming login from the vault.
   * A login in use that FrontFlow cannot attribute to a saved account is never overwritten.
   */
  switchTo(id: string): Promise<SwitchOutcome> {
    return withLock(this.lockDir, async () => {
      const before = await this.observeLocked();
      const index = this.readIndex();
      const record = index.accounts.find((a) => a.id === id);
      if (!record) throw new AccountError("NOT_FOUND", `Unknown account ${id}`);
      if (before.accountId === id) return { accountId: id, restartRequired: true, warnings: ["This account is already the login in use"] };
      if (this.status(record) === "needs_login") throw new AccountError("NEEDS_LOGIN", "This account's login has expired or was replaced; log in to it again");
      if (before.loggedIn && !before.accountId) {
        throw new AccountError(
          "UNSAVED_LIVE",
          `${before.mismatch ? `${before.mismatch}. ` : ""}The login Claude Code uses now is not saved in FrontFlow; save it first, or switching would lose it`,
        );
      }
      // A login handed to a profile folder comes from there, as Claude Code last renewed it.
      const profile = record.location === "profile" && record.profileDir ? this.profilePaths(record.profileDir) : undefined;
      const snapshot = profile ? this.readProfile(profile) : await this.loadSnapshot(id);
      const warnings: string[] = [];
      if (before.mismatch) warnings.push(before.mismatch);
      if (profile) warnings.push("FrontFlow runs still open as this account lose its login: it is now the login of every `claude`");
      const outgoing = before.accountId ? index.accounts.find((a) => a.id === before.accountId) : undefined;

      await this.withClaudeCredentialLocks(async () => {
        const live = this.readLive();
        if (live.snapshot && live.fingerprint) {
          // Still the login observed above, or Claude Code renewed it in place since.
          if (!outgoing || (live.fingerprint !== before.fingerprint && live.identity?.accountUuid !== outgoing.id)) {
            throw new AccountError("UNSTABLE", "The login in use changed during the switch; nothing was changed, try again");
          }
          const parked: LoginSnapshot = {
            ...live.snapshot,
            ...(live.identity?.accountUuid === outgoing.id ? {} : outgoing.identity ? { oauthAccount: outgoing.identity } : {}),
            capturedAt: this.now().toISOString(),
          };
          await this.options.vault.set(accountKey(outgoing.id), JSON.stringify(parked));
          const back = await this.options.vault.get(accountKey(outgoing.id));
          if (!back || fingerprint((JSON.parse(back) as LoginSnapshot).claudeAiOauth.refreshToken) !== live.fingerprint) {
            throw new AccountError("VERIFY_FAILED", "Could not park the login in use in the vault; nothing was changed");
          }
        }
        const target = { ...snapshot.credentials, claudeAiOauth: snapshot.claudeAiOauth, ...(snapshot.organizationUuid ? { organizationUuid: snapshot.organizationUuid } : {}) };
        // The account's own keys; machine-wide ones (MCP server logins) keep their live value.
        this.store.write(composeCredentials(target, this.store.read()));
      });
      const identity = snapshot.oauthAccount ?? record.identity;
      if (identity) {
        // Only the identity entry changes; Claude's other settings and project history stay as they are.
        await this.writeIdentity(identity);
      } else {
        warnings.push("This account has no stored identity; `claude` may show the previous name until it refreshes its profile");
      }

      const after = this.readLive();
      const expected = fingerprint(snapshot.claudeAiOauth.refreshToken);
      // The incoming login is still parked: the next observation sorts out whatever happened.
      if (after.fingerprint !== expected) throw new AccountError("VERIFY_FAILED", "The login file changed during the switch; check the active account and retry");
      if (profile) this.clearProfile(profile);
      else await this.options.vault.delete(accountKey(id));

      const at = this.now().toISOString();
      const final = this.readIndex();
      final.lastSwitch = { accountId: id, at, fingerprint: expected };
      final.lastLive = { accountId: id, fingerprint: expected };
      final.accounts = final.accounts.map((a) => {
        if (a.id === outgoing?.id) return { ...a, location: "vault" as const };
        if (a.id !== id) return a;
        const { profileDir: _dir, ...rest } = a;
        return { ...rest, location: "live" as const, lastActivatedAt: at, ...(identity ? { identity } : {}) };
      });
      this.pushTimeline(final, id);
      this.audit_(final, { action: "switch", accountId: id, ...(before.accountId ? { from: before.accountId } : {}), fingerprint: expected });
      this.writeIndex(final);
      return { accountId: id, ...(before.accountId ? { previousAccountId: before.accountId } : {}), restartRequired: true, warnings };
    });
  }

  /**
   * Hands a parked login to its own Claude Code config folder, so a FrontFlow run can use it
   * (`CLAUDE_CONFIG_DIR=dir`) while the machine stays on its login. Moved, never copied: it
   * leaves the vault once Claude Code's store in `dir` holds it, and Claude Code renews it
   * there. The folder's global config is the user's (onboarding done, trusted folders, MCP
   * servers) with this account's identity; it is brought up to date on every call.
   */
  moveToProfile(id: string, dir: string): Promise<void> {
    return withLock(this.lockDir, async () => {
      const index = this.readIndex();
      const record = index.accounts.find((a) => a.id === id);
      if (!record) throw new AccountError("NOT_FOUND", `Unknown account ${id}`);
      if (this.isLiveIn(record, this.readLive())) throw new AccountError("IN_USE", "This account is the login in use: runs use it directly");
      if (this.status(record) === "needs_login") throw new AccountError("NEEDS_LOGIN", "This account's login has expired or was replaced; log in to it again");
      const paths = this.profilePaths(dir);
      const own = readJsonObject(paths.globalConfigFile) ?? {};
      const user = readJsonObject(this.options.paths.globalConfigFile) ?? {};
      if (record.location === "profile" && record.profileDir === dir) {
        atomicWriteFile(paths.globalConfigFile, JSON.stringify({ ...own, ...user, oauthAccount: own["oauthAccount"] ?? record.identity ?? {} }, null, 2));
        return;
      }
      const snapshot = await this.loadSnapshot(id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const store = this.profileStoreFor(paths);
      const target = { ...snapshot.credentials, claudeAiOauth: snapshot.claudeAiOauth, ...(snapshot.organizationUuid ? { organizationUuid: snapshot.organizationUuid } : {}) };
      store.write(composeCredentials(target, store.read()));
      atomicWriteFile(paths.globalConfigFile, JSON.stringify({ ...own, ...user, oauthAccount: snapshot.oauthAccount ?? record.identity ?? {} }, null, 2));
      const expected = fingerprint(snapshot.claudeAiOauth.refreshToken);
      if (readLiveLogin(paths, this.now, store).fingerprint !== expected) throw new AccountError("VERIFY_FAILED", "Could not hand the login to its profile folder; it stays parked");
      await this.options.vault.delete(accountKey(id));
      index.accounts = index.accounts.map((a) => (a.id === id ? { ...a, location: "profile" as const, profileDir: dir } : a));
      this.audit_(index, { action: "to_profile", accountId: id, fingerprint: expected });
      this.writeIndex(index);
    });
  }

  /** Forgets a stored account. The machine stays logged in as it is. */
  remove(id: string): Promise<void> {
    return withLock(this.lockDir, async () => {
      const index = this.readIndex();
      const record = index.accounts.find((a) => a.id === id);
      if (!record) throw new AccountError("NOT_FOUND", `Unknown account ${id}`);
      if (record.location === "profile" && record.profileDir) this.clearProfile(this.profilePaths(record.profileDir));
      await this.options.vault.delete(accountKey(id));
      index.accounts = index.accounts.filter((a) => a.id !== id);
      if (index.lastSwitch?.accountId === id) delete index.lastSwitch;
      this.audit_(index, { action: "remove", accountId: id });
      this.writeIndex(index);
    });
  }

  rename(id: string, label: string): Promise<void> {
    return this.update(id, (a) => {
      const { label: _old, ...rest } = a;
      return label.trim() ? { ...rest, label: label.trim() } : rest;
    });
  }

  /** The live login belongs to this account (then Claude Code, not us, refreshes it). */
  isLive(id: string): boolean {
    const record = this.get(id);
    return !!record && this.isLiveIn(record, this.readLive());
  }

  private isLiveIn(record: AccountRecord, live: LiveLogin): boolean {
    if (!live.fingerprint) return false;
    return live.fingerprint === record.fingerprint || !!record.previousFingerprints?.includes(live.fingerprint) || live.identity?.accountUuid === record.id;
  }

  /**
   * Refreshes the stored login of an account that is not live, so its quota can be read
   * (doc §4.4). One POST outside the lock, then compare-and-swap under it: if the stored
   * login changed meanwhile, the result is parked in the vault instead of overwriting it.
   */
  refreshStored(id: string, options: RefreshOptions = {}): Promise<"refreshed" | "live" | "invalid_grant" | "invalid_client" | "transient" | "parked"> {
    const running = this.inflight.get(id);
    if (running) return running;
    const task = this.refreshOnce(id, options).finally(() => this.inflight.delete(id));
    this.inflight.set(id, task);
    return task;
  }

  private readonly inflight = new Map<string, ReturnType<ClaudeAccountManager["refreshStored"]>>();

  private async refreshOnce(id: string, options: RefreshOptions): ReturnType<ClaudeAccountManager["refreshStored"]> {
    const record = this.get(id);
    if (!record) throw new AccountError("NOT_FOUND", `Unknown account ${id}`);
    // Claude Code renews the login in use and a profile folder's login itself.
    if (record.location === "profile" || this.isLive(id)) return "live";
    const before = await this.loadSnapshot(id);
    const beforeFp = fingerprint(before.claudeAiOauth.refreshToken);
    const result = await refreshOAuthToken(before.claudeAiOauth, { ...options, now: this.now });
    return withLock(this.lockDir, async () => {
      const index = this.readIndex();
      const record = index.accounts.find((a) => a.id === id);
      if (!record) return "transient";
      const at = this.now().toISOString();
      if (!result.ok) {
        index.accounts = index.accounts.map((a) => (a.id === id ? { ...a, refreshFailure: { code: result.code, message: result.message, at } } : a));
        this.audit_(index, { action: "refresh_failed", accountId: id, fingerprint: beforeFp, detail: result.code });
        this.writeIndex(index);
        return result.code;
      }
      const updated: LoginSnapshot = { ...before, claudeAiOauth: result.credentials, capturedAt: at };
      const current = await this.loadSnapshot(id);
      if (fingerprint(current.claudeAiOauth.refreshToken) !== beforeFp) {
        await this.options.vault.set(`claude:pending:${id}`, JSON.stringify(updated));
        this.audit_(index, { action: "refresh_parked", accountId: id, fingerprint: fingerprint(updated.claudeAiOauth.refreshToken) });
        this.writeIndex(index);
        return "parked";
      }
      await this.options.vault.set(accountKey(id), JSON.stringify(updated));
      const next = fromSnapshot(id, updated, record, this.now());
      index.accounts = index.accounts.map((a) => (a.id === id ? next : a));
      this.audit_(index, { action: "refresh", accountId: id, fingerprint: next.fingerprint });
      this.writeIndex(index);
      return "refreshed";
    });
  }

  /**
   * Freshest usable access token of an account: the live file's when the account is live
   * (Claude refreshes it there), else the stored one while it has not expired.
   */
  async accessTokenFor(id: string): Promise<string | undefined> {
    const now = this.now().getTime();
    const live = this.readLive();
    const record = this.get(id);
    if (!record) return undefined;
    const candidates: LoginSnapshot[] = [];
    if (live.snapshot && live.fingerprint && (live.fingerprint === record.fingerprint || record.previousFingerprints?.includes(live.fingerprint) || live.identity?.accountUuid === id)) {
      candidates.push(live.snapshot);
    }
    if (record.location === "profile" && record.profileDir) {
      const inProfile = (() => {
        try {
          return this.readProfile(this.profilePaths(record.profileDir!));
        } catch {
          return undefined;
        }
      })();
      if (inProfile) candidates.push(inProfile);
    }
    const stored = await this.loadSnapshot(id).catch(() => undefined);
    if (stored) candidates.push(stored);
    return candidates.find((s) => !s.claudeAiOauth.expiresAt || s.claudeAiOauth.expiresAt > now + 30_000)?.claudeAiOauth.accessToken;
  }

  recordUsage(id: string, result: { usage?: UsageSnapshot; error?: { code: string; message: string }; poll: AccountRecord["poll"] }): Promise<void> {
    return this.update(id, (a) => {
      const { usageError: _e, ...rest } = a;
      return {
        ...rest,
        ...(result.usage ? { usage: result.usage } : a.usage ? { usage: a.usage } : {}),
        ...(result.error ? { usageError: { ...result.error, at: this.now().toISOString() } } : {}),
        ...(result.poll ? { poll: result.poll } : {}),
      };
    });
  }

  recordProfile(id: string, profile: Record<string, string | number | boolean | null>): Promise<void> {
    return this.update(id, (a) => ({ ...a, profile, profileFetchedAt: this.now().toISOString() }));
  }

  // ---------------------------------------------------------------------------

  private async observeLocked(): Promise<Observation> {
    const live = this.readLive();
    const index = this.readIndex();
    // Observed every few seconds: the index is only rewritten when something changed.
    const initial = JSON.stringify(index);
    const save = () => {
      if (JSON.stringify(index) !== initial) this.writeIndex(index);
    };
    await this.migrate(index);
    if (!live.snapshot || !live.fingerprint) {
      await this.settlePrevious(index, undefined, undefined);
      delete index.lastLive;
      this.pushTimeline(index, null);
      save();
      return { loggedIn: false, ...(live.identity ? { identity: live.identity } : {}) };
    }
    const fp = live.fingerprint;
    const byToken = index.accounts.find((a) => a.fingerprint === fp || a.previousFingerprints?.includes(fp));
    const byIdentity = live.identity?.accountUuid ? index.accounts.find((a) => a.id === live.identity!.accountUuid) : undefined;
    let account = byToken;
    let mismatch: string | undefined;

    if (byToken && byIdentity && byToken.id !== byIdentity.id) {
      mismatch = `The token belongs to ${describe(byToken)} but Claude's account file says ${describe(byIdentity)}`;
      // We switched to this token: restore the identity that goes with it.
      if ((index.lastSwitch?.fingerprint === fp || index.lastSwitch?.accountId === byToken.id) && byToken.identity && existsSync(this.options.paths.globalConfigFile)) {
        await this.writeIdentity(byToken.identity);
        this.audit_(index, { action: "repair", accountId: byToken.id, fingerprint: fp });
        mismatch = undefined;
      }
    } else if (!byToken && byIdentity) {
      // A token we have not seen: Claude renewed it, or a stale process wrote another account's
      // token next to this identity. A provider check tells; with checks off, continuity does:
      // the same identity was live with the account's last token, and no switch came between.
      const verify = this.verifier();
      const verified = verify ? await verify(live.snapshot.claudeAiOauth.accessToken).catch(() => undefined) : undefined;
      const continuous = index.lastLive?.accountId === byIdentity.id && (index.lastLive.fingerprint === byIdentity.fingerprint || !!byIdentity.previousFingerprints?.includes(index.lastLive.fingerprint));
      if (verified === byIdentity.id || (!verify && continuous)) {
        account = byIdentity;
      } else if (verified) {
        mismatch = `The live token belongs to another account (${verified}) than Claude's account file says`;
      } else {
        mismatch = `Unverified token for ${describe(byIdentity)}: not recognized until it can be checked`;
      }
    }

    if (account) {
      // Its details come from the live login; an identity naming another account is not taken.
      const own: LoginSnapshot = live.identity?.accountUuid === account.id ? live.snapshot : { ...live.snapshot, oauthAccount: account.identity ?? {} };
      const updated: AccountRecord = { ...fromSnapshot(account.id, own, account, this.now()), location: "live" };
      if (updated.fingerprint !== account.fingerprint) this.audit_(index, { action: "sync", accountId: account.id, fingerprint: updated.fingerprint });
      index.accounts = index.accounts.map((a) => (a.id === account!.id ? updated : a));
      if (await this.dropParkedCopy(index, account.id, live.snapshot)) {
        mismatch ??= `Claude Code holds an older login of ${describe(account)} than FrontFlow parked; switch to another account and back to restore the newer one`;
      }
    }
    await this.settlePrevious(index, account?.id, live.identity?.accountUuid);
    if (account) index.lastLive = { accountId: account.id, fingerprint: fp };
    else if (live.identity?.accountUuid !== index.lastLive?.accountId) delete index.lastLive;
    this.pushTimeline(index, account?.id ?? null);
    save();
    return {
      loggedIn: true,
      ...(account ? { accountId: account.id } : {}),
      fingerprint: fp,
      ...(live.identity ? { identity: live.identity } : {}),
      ...(live.snapshot.claudeAiOauth.subscriptionType ? { subscriptionType: live.snapshot.claudeAiOauth.subscriptionType } : {}),
      ...(mismatch ? { mismatch } : {}),
    };
  }

  private profilePaths(dir: string): ClaudePaths {
    return resolveClaudePaths({ CLAUDE_CONFIG_DIR: dir });
  }

  private profileStoreFor(paths: ClaudePaths): LiveCredentialStore {
    return this.options.profileStore?.(paths) ?? new FileCredentialStore(paths);
  }

  private readProfile(paths: ClaudePaths): LoginSnapshot {
    const login = readLiveLogin(paths, this.now, this.profileStoreFor(paths));
    if (!login.snapshot) throw new AccountError("VAULT_MISSING", "The login of this account's profile folder is missing; add the account again");
    return login.snapshot;
  }

  /** Takes the account's login out of a profile folder (what stays there is not a login). */
  private clearProfile(paths: ClaudePaths): void {
    const store = this.profileStoreFor(paths);
    if (store.clear) {
      store.clear();
      return;
    }
    const { claudeAiOauth: _gone, ...rest } = store.read() ?? {};
    if (Object.keys(rest).length) store.write(rest);
    else rmSync(paths.credentialsFile, { force: true });
  }

  private verifier(): AccountManagerOptions["verifyAccount"] {
    return this.options.canVerify?.() === false ? undefined : this.options.verifyAccount;
  }

  /**
   * The account is live, so its parked copy goes (left by an interrupted switch, or by
   * FrontFlow before logins were kept in one place) — unless that copy is newer than the live
   * login (a stale process wrote an old token back): then it is kept, and true is returned.
   */
  private async dropParkedCopy(index: IndexFile, id: string, live: LoginSnapshot): Promise<boolean> {
    const raw = await this.options.vault.get(accountKey(id));
    if (!raw) return false;
    const parked = JSON.parse(raw) as LoginSnapshot;
    const parkedFp = fingerprint(parked.claudeAiOauth.refreshToken);
    if (parkedFp !== fingerprint(live.claudeAiOauth.refreshToken) && (parked.claudeAiOauth.expiresAt ?? 0) > (live.claudeAiOauth.expiresAt ?? 0)) return true;
    await this.options.vault.delete(accountKey(id));
    this.audit_(index, { action: "unpark", accountId: id, fingerprint: parkedFp });
    return false;
  }

  /**
   * The account that was live before and is not now: parked if a switch parked it, else its
   * login was replaced by a sign-in (or sign-out) outside FrontFlow, and it needs a new login.
   */
  private async settlePrevious(index: IndexFile, liveAccountId: string | undefined, liveIdentity: string | undefined): Promise<void> {
    const previous = index.lastLive?.accountId;
    if (!previous || previous === liveAccountId || (!liveAccountId && liveIdentity === previous)) return;
    const parked = await this.options.vault.get(accountKey(previous));
    index.accounts = index.accounts.map((a) => (a.id === previous ? { ...a, location: parked ? "vault" : "lost" } : a));
    if (!parked) this.audit_(index, { action: "lost", accountId: previous });
  }

  /**
   * Version 1 kept a copy of the live login in the vault and up to three backups of it per
   * switch. The copy goes on the next observation (dropParkedCopy); a backup goes when it is
   * a login of a saved account (current or earlier token), the rest are left as they are.
   */
  private async migrate(index: IndexFile): Promise<void> {
    if (index.version >= INDEX_VERSION) return;
    for (let slot = 0; slot < LEGACY_BACKUP_SLOTS; slot++) {
      const raw = await this.options.vault.get(`claude:backup:${slot}`);
      if (!raw) continue;
      const fp = fingerprint((JSON.parse(raw) as LoginSnapshot).claudeAiOauth.refreshToken);
      if (index.accounts.some((a) => a.fingerprint === fp || a.previousFingerprints?.includes(fp))) await this.options.vault.delete(`claude:backup:${slot}`);
    }
    for (const a of index.accounts) {
      if (!a.location && (await this.options.vault.get(accountKey(a.id)))) a.location = "vault";
    }
    index.version = INDEX_VERSION;
    this.audit_(index, { action: "migrate" });
  }

  private get store(): LiveCredentialStore {
    return this.options.liveStore ?? (this.fileStore ??= new FileCredentialStore(this.options.paths));
  }
  private fileStore?: FileCredentialStore;

  private readLive(): LiveLogin {
    return readLiveLogin(this.options.paths, this.now, this.store);
  }

  private async withClaudeCredentialLocks(fn: () => Promise<void>): Promise<void> {
    const locks = claudeLockPaths(this.options.paths);
    // Claude Code's order: refresh lock first, then the legacy one; stale after 60 s.
    const releaseRefresh = await acquireDirLock(locks.refresh, { staleMs: 60_000 });
    try {
      const releaseLegacy = await acquireDirLock(locks.legacy, { staleMs: 60_000 });
      try {
        await fn();
      } finally {
        releaseLegacy();
      }
    } finally {
      releaseRefresh();
    }
  }

  /** Replaces `oauthAccount` in Claude's global config under its config lock, keeping everything else. */
  private async writeIdentity(identity: OAuthAccountInfo): Promise<void> {
    const file = this.options.paths.globalConfigFile;
    const release = await acquireDirLock(claudeLockPaths(this.options.paths).config, { staleMs: 10_000 });
    try {
      const config = readJsonObject(file) ?? {};
      atomicWriteFile(file, JSON.stringify({ ...config, oauthAccount: identity }, null, 2));
    } finally {
      release();
    }
  }

  private async loadSnapshot(id: string): Promise<LoginSnapshot> {
    const raw = await this.options.vault.get(accountKey(id));
    if (!raw) throw new AccountError("VAULT_MISSING", "The stored login of this account is missing; add the account again");
    return JSON.parse(raw) as LoginSnapshot;
  }

  private update(id: string, fn: (a: AccountRecord) => AccountRecord): Promise<void> {
    return withLock(this.lockDir, () => {
      const index = this.readIndex();
      if (!index.accounts.some((a) => a.id === id)) throw new AccountError("NOT_FOUND", `Unknown account ${id}`);
      index.accounts = index.accounts.map((a) => (a.id === id ? fn(a) : a));
      this.writeIndex(index);
    });
  }

  private pushTimeline(index: IndexFile, accountId: string | null): void {
    if (index.timeline.at(-1)?.accountId === accountId && index.timeline.length) return;
    index.timeline = [...index.timeline, { accountId, at: this.now().toISOString() }].slice(-MAX_TIMELINE);
  }

  private audit_(index: IndexFile, entry: Omit<AuditEntry, "at">): void {
    index.audit = [...index.audit, { at: this.now().toISOString(), ...entry }].slice(-MAX_AUDIT);
  }

  private readIndex(): IndexFile {
    if (!existsSync(this.indexFile)) return { version: INDEX_VERSION, accounts: [], timeline: [], audit: [] };
    const parsed = JSON.parse(readFileSync(this.indexFile, "utf8")) as Partial<IndexFile>;
    return {
      version: parsed.version ?? 1,
      accounts: parsed.accounts ?? [],
      timeline: parsed.timeline ?? [],
      audit: parsed.audit ?? [],
      ...(parsed.lastSwitch ? { lastSwitch: parsed.lastSwitch } : {}),
      ...(parsed.lastLive ? { lastLive: parsed.lastLive } : {}),
    };
  }

  private writeIndex(index: IndexFile): void {
    atomicWriteFile(this.indexFile, JSON.stringify(index, null, 2));
  }
}

function describe(a: AccountRecord): string {
  return a.label ?? a.email ?? a.id;
}

function fromSnapshot(id: string, s: LoginSnapshot, existing: AccountRecord | undefined, now: Date, label?: string): AccountRecord {
  const fp = fingerprint(s.claudeAiOauth.refreshToken);
  const previous = existing && existing.fingerprint !== fp ? [existing.fingerprint, ...(existing.previousFingerprints ?? [])].slice(0, MAX_FINGERPRINTS) : existing?.previousFingerprints;
  const who = s.oauthAccount ?? {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const accessExpiresAt = toIso(s.claudeAiOauth.expiresAt);
  const refreshExpiresAt = toIso(s.claudeAiOauth.refreshTokenExpiresAt);
  const fields = {
    email: str(who.emailAddress) ?? existing?.email,
    displayName: str(who.displayName) ?? existing?.displayName,
    organizationUuid: s.organizationUuid ?? str(who.organizationUuid) ?? existing?.organizationUuid,
    organizationName: str(who.organizationName) ?? existing?.organizationName,
    subscriptionType: str(s.claudeAiOauth.subscriptionType) ?? existing?.subscriptionType,
    rateLimitTier: str(s.claudeAiOauth.rateLimitTier) ?? str(who["userRateLimitTier"]) ?? existing?.rateLimitTier,
    billingType: str(who["billingType"]) ?? existing?.billingType,
  };
  // A new token clears an old refresh failure.
  const { refreshFailure, ...kept } = existing ?? ({} as Partial<AccountRecord>);
  return {
    ...kept,
    ...(refreshFailure && existing?.fingerprint === fp ? { refreshFailure } : {}),
    id,
    ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
    ...(label?.trim() ? { label: label.trim() } : {}),
    addedAt: existing?.addedAt ?? now.toISOString(),
    ...(accessExpiresAt ? { accessExpiresAt } : {}),
    ...(refreshExpiresAt ? { refreshExpiresAt } : {}),
    ...(s.oauthAccount && Object.keys(s.oauthAccount).length ? { identity: s.oauthAccount } : existing?.identity ? { identity: existing.identity } : {}),
    fingerprint: fp,
    ...(previous?.length ? { previousFingerprints: previous } : {}),
  };
}
