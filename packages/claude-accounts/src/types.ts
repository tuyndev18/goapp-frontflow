/** Where Claude Code keeps its login on this machine. */
export interface ClaudePaths {
  /** `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
  configDir: string;
  /** OAuth tokens (plaintext JSON on Windows/Linux). */
  credentialsFile: string;
  /** Global config with the logged-in identity (`oauthAccount`). */
  globalConfigFile: string;
  /** Conversation transcripts, used for local usage. */
  projectsDir: string;
}

/** The `claudeAiOauth` entry of `.credentials.json`. Secret. */
export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt?: number;
  /** Epoch ms. */
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
  [key: string]: unknown;
}

/** The `oauthAccount` entry of `.claude.json`: who is logged in. Not secret. */
export interface OAuthAccountInfo {
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
  organizationName?: string;
  displayName?: string;
  [key: string]: unknown;
}

/** Everything a stored account restores when switched to. Secret: lives only in the vault. */
export interface LoginSnapshot {
  claudeAiOauth: OAuthCredentials;
  /**
   * The account-bound part of Claude's credentials object (everything but machine-shared keys
   * like MCP logins), restored as a whole on switch. Older snapshots lack it.
   */
  credentials?: Record<string, unknown>;
  organizationUuid?: string;
  oauthAccount?: OAuthAccountInfo;
  capturedAt: string;
}

export interface UsageWindow {
  /** Provider key, e.g. "five_hour", "seven_day", "seven_day_opus". */
  key: string;
  label: string;
  /** 0–100. */
  utilization: number;
  resetsAt?: string;
}

/** Quota as Claude reports it to the logged-in account (same data as `/usage`). */
export interface UsageSnapshot {
  windows: UsageWindow[];
  /** Pay-as-you-go extra usage, when the account has it. */
  extra?: Record<string, string | number | boolean | null>;
  fetchedAt: string;
  /** api: FrontFlow asked Anthropic. statusline: a Claude Code session passed it (no request made). */
  source?: "api" | "statusline";
}

export type AccountStatus = "ok" | "access_expired" | "needs_login";

/** A stored account. Holds no secret: tokens stay in the vault, only their fingerprints are here. */
export interface AccountRecord {
  /** Claude account UUID. */
  id: string;
  label?: string;
  email?: string;
  displayName?: string;
  organizationUuid?: string;
  organizationName?: string;
  subscriptionType?: string;
  rateLimitTier?: string;
  billingType?: string;
  addedAt: string;
  lastActivatedAt?: string;
  /** Access token expiry, ISO. */
  accessExpiresAt?: string;
  /** Refresh token expiry, ISO: past it, the account needs a new login. */
  refreshExpiresAt?: string;
  /** Short hash of the stored refresh token. */
  fingerprint: string;
  /** Hashes of earlier refresh tokens of this account (rotation), to recognize it in the live file. */
  previousFingerprints?: string[];
  /**
   * Where the account's login is — always one place: `live`, Claude Code's own login (Claude
   * Code renews it; FrontFlow keeps no copy); `vault`, parked in FrontFlow's vault; `profile`,
   * handed to its own Claude Code config folder (`profileDir`) for FrontFlow runs, where Claude
   * Code keeps and renews it; `lost`, replaced in Claude Code by a sign-in outside FrontFlow
   * before it could be parked.
   */
  location?: "live" | "vault" | "profile" | "lost";
  /** The `CLAUDE_CONFIG_DIR` holding the login while `location` is `profile`. */
  profileDir?: string;
  /** Claude's `oauthAccount` entry for this account (no secret), written back on a switch to it. */
  identity?: OAuthAccountInfo;
  usage?: UsageSnapshot;
  usageError?: { code: string; message: string; at: string };
  /** Last failed refresh of the stored login; `invalid_grant` means it needs a new login. */
  refreshFailure?: { code: string; message: string; at: string };
  /** Account and organization details from the profile endpoint (no secrets). */
  profile?: Record<string, string | number | boolean | null>;
  profileFetchedAt?: string;
  poll?: PollState;
}

export interface PollState {
  nextPollAt: number;
  intervalMs: number;
  failures: number;
  /** Kind of the last failure, while `failures` > 0. */
  lastError?: string;
}

/** Which account held the machine-wide login from `at` on (null: none / unknown login). */
export interface TimelineEntry {
  accountId: string | null;
  at: string;
}

export interface AuditEntry {
  at: string;
  action: "capture" | "switch" | "remove" | "sync" | "repair" | "rename" | "refresh" | "refresh_failed" | "refresh_parked" | "unpark" | "lost" | "migrate" | "to_profile";
  accountId?: string;
  from?: string;
  /** Fingerprints only, never tokens. */
  fingerprint?: string;
  detail?: string;
}

/** Same shape as the app's credential vault (`@frontflow/persistence` CredentialVault, Electron safeStorage). */
export interface SecretVault {
  get(key: string): Promise<string | undefined> | string | undefined;
  set(key: string, value: string): Promise<void> | void;
  delete(key: string): Promise<unknown> | unknown;
}
