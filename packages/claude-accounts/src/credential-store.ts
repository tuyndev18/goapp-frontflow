import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { atomicWriteFile, readJsonObject } from "./fsx.js";
import type { ClaudePaths } from "./types.js";

/**
 * Where Claude Code keeps the live login JSON (`{ claudeAiOauth, mcpOAuth, … }`):
 * a plaintext file on Windows/Linux/WSL, a generic password in the macOS Keychain.
 */
export interface LiveCredentialStore {
  readonly kind: "file" | "macos-keychain";
  read(): Record<string, unknown> | undefined;
  write(credentials: Record<string, unknown>): void;
  /** Deletes the stored login (cleanup of an isolated login folder's Keychain item). */
  clear?(): void;
}

/**
 * Keys that belong to the machine, not to an account (MCP server logins, plugin secrets).
 * On a switch they always keep their live value — present or absent (claude-swap's rule).
 */
export const SHARED_CREDENTIAL_KEYS: readonly string[] = ["mcpOAuth", "mcpOAuthClientConfig", "mcpXaaIdp", "mcpXaaIdpConfig", "pluginSecrets"];

/** The account-bound part of a credentials object. */
export function accountCredentials(credentials: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(credentials).filter(([k]) => !SHARED_CREDENTIAL_KEYS.includes(k)));
}

/** Target account's own keys plus the machine's shared keys as they are live. */
export function composeCredentials(target: Record<string, unknown>, live: Record<string, unknown> | undefined): Record<string, unknown> {
  const shared = Object.fromEntries(Object.entries(live ?? {}).filter(([k]) => SHARED_CREDENTIAL_KEYS.includes(k)));
  return { ...accountCredentials(target), ...shared };
}

export class FileCredentialStore implements LiveCredentialStore {
  readonly kind = "file" as const;
  constructor(private readonly paths: ClaudePaths) {}

  read(): Record<string, unknown> | undefined {
    return readJsonObject(this.paths.credentialsFile);
  }

  write(credentials: Record<string, unknown>): void {
    atomicWriteFile(this.paths.credentialsFile, JSON.stringify(credentials));
  }
}

/** Runs `/usr/bin/security`; injectable for tests. */
export type SecurityRunner = (args: string[], input?: string) => { status: number | null; stdout: string };

const defaultSecurity: SecurityRunner = (args, input) => {
  const res = spawnSync("/usr/bin/security", args, { encoding: "utf8", timeout: 5000, ...(input !== undefined ? { input } : {}) });
  return { status: res.status, stdout: res.stdout ?? "" };
};

/** `security -i` reads one command line from stdin; longer lines go through argv instead. */
const SECURITY_STDIN_LIMIT = 4096 - 64;

export class KeychainError extends Error {
  override name = "KeychainError";
}

/**
 * Claude Code on macOS: item service `Claude Code-credentials` (with a short hash of the
 * folder when `CLAUDE_CONFIG_DIR` is set), account = the user name. Values are written
 * hex-encoded through `security -i` so the JSON never appears in a process list.
 */
export class MacKeychainCredentialStore implements LiveCredentialStore {
  readonly kind = "macos-keychain" as const;
  private readonly account: string;
  private readonly services: string[];

  /**
   * `isolated`: a throw-away login folder. Only its own item is read or cleared — never the
   * machine's default item, which would be someone else's login.
   */
  constructor(
    private readonly paths: ClaudePaths,
    options: { env?: NodeJS.ProcessEnv; security?: SecurityRunner; account?: string; isolated?: boolean } = {},
  ) {
    const env = options.env ?? process.env;
    this.security = options.security ?? defaultSecurity;
    this.account = options.account ?? keychainAccountName(env);
    const custom = env["CLAUDE_CONFIG_DIR"]?.trim();
    const base = "Claude Code-credentials";
    const own = custom ? `${base}-${createHash("sha256").update(custom).digest("hex").slice(0, 8)}` : base;
    this.isolated = !!options.isolated;
    if (this.isolated && !custom) throw new KeychainError("An isolated login needs its own CLAUDE_CONFIG_DIR");
    // Custom config folders get their own item; the plain name is the fallback for older CLIs.
    this.services = custom && !this.isolated ? [own, base] : [own];
  }

  private readonly isolated: boolean;

  private readonly security: SecurityRunner;
  private service?: string;

  read(): Record<string, unknown> | undefined {
    for (const service of this.services) {
      const raw = this.get(service);
      if (raw === undefined) continue;
      this.service = service;
      try {
        const parsed = JSON.parse(decodeKeychainValue(raw)) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        throw new KeychainError(`Keychain item "${service}" does not hold JSON`);
      }
    }
    // Some setups keep the file instead (Keychain unusable): read it as Claude Code would.
    return readJsonObject(this.paths.credentialsFile);
  }

  write(credentials: Record<string, unknown>): void {
    const service = this.service ?? this.services[0]!;
    const hex = Buffer.from(JSON.stringify(credentials), "utf8").toString("hex");
    const args = ["add-generic-password", "-U", "-a", this.account, "-s", service, "-X", hex];
    const line = `add-generic-password -U -a ${quote(this.account)} -s ${quote(service)} -X ${hex}\n`;
    const res = line.length <= SECURITY_STDIN_LIMIT ? this.security(["-i"], line) : this.security(args);
    if (res.status !== 0) throw new KeychainError(`Could not write the Keychain item "${service}" (exit ${res.status})`);
    // Running sessions watch the file's mtime: rewrite it when present, never create it.
    if (existsSync(this.paths.credentialsFile)) atomicWriteFile(this.paths.credentialsFile, readFileSync(this.paths.credentialsFile, "utf8"));
  }

  /** Isolated folders only: the machine's live login is never deleted from here. */
  clear(): void {
    if (!this.isolated) throw new KeychainError("Refusing to delete the machine's Claude login");
    this.security(["delete-generic-password", "-a", this.account, "-s", this.services[0]!]);
  }

  private get(service: string): string | undefined {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = this.security(["find-generic-password", "-a", this.account, "-w", "-s", service]);
      if (res.status === 0) return res.stdout.replace(/\n$/, "");
      if (res.status === 44) return undefined; // item not found
      if (attempt === 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
    throw new KeychainError(`Could not read the Keychain item "${service}"`);
  }
}

/** Claude Code's own rule for the Keychain account: $USER, else the OS user name. */
export function keychainAccountName(env: NodeJS.ProcessEnv = process.env): string {
  if (env["USER"]) return env["USER"];
  try {
    return userInfo().username || "claude-code-user";
  } catch {
    return "claude-code-user";
  }
}

/** `security -w` prints non-printable values as hex; our JSON is printable either way. */
function decodeKeychainValue(raw: string): string {
  const trimmed = raw.trim();
  if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0 && !trimmed.startsWith("{")) {
    const decoded = Buffer.from(trimmed, "hex").toString("utf8");
    if (decoded.startsWith("{")) return decoded;
  }
  return raw;
}

function quote(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

/** File on Windows/Linux/WSL; Keychain on macOS. */
export function liveCredentialStoreFor(paths: ClaudePaths, platform: NodeJS.Platform = process.platform): LiveCredentialStore {
  return platform === "darwin" ? new MacKeychainCredentialStore(paths) : new FileCredentialStore(paths);
}
