import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountCredentials, FileCredentialStore, type LiveCredentialStore } from "./credential-store.js";
import { readJsonObject } from "./fsx.js";
import type { ClaudePaths, LoginSnapshot, OAuthAccountInfo, OAuthCredentials } from "./types.js";

/**
 * Claude Code's own rule: `CLAUDE_CONFIG_DIR` moves the config folder and the global config
 * file with it; a non-empty legacy `<config>/.config.json` still wins over `.claude.json`.
 */
export function resolveClaudePaths(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): ClaudePaths {
  const custom = env["CLAUDE_CONFIG_DIR"]?.trim();
  const configDir = custom || join(home, ".claude");
  const legacy = join(configDir, ".config.json");
  const modern = custom ? join(custom, ".claude.json") : join(home, ".claude.json");
  let globalConfigFile = modern;
  try {
    const st = statSync(legacy);
    if (st.isFile() && (st.size > 0 || !existsSync(modern))) globalConfigFile = legacy;
  } catch {
    // no legacy file
  }
  return { configDir, credentialsFile: join(configDir, ".credentials.json"), globalConfigFile, projectsDir: join(configDir, "projects") };
}

/**
 * Locks Claude Code itself takes (proper-lockfile directories): its token refresh holds the
 * first two, its config writes the third. Holding them while we write means a switch never
 * interleaves with a refresh that would write the old account back.
 */
export function claudeLockPaths(paths: ClaudePaths): { refresh: string; legacy: string; config: string } {
  return {
    refresh: join(paths.configDir, ".oauth_refresh.lock"),
    legacy: `${paths.configDir}.lock`,
    config: `${paths.globalConfigFile}.lock`,
  };
}

/** Short, non-reversible id of a refresh token: enough to tell generations apart, useless to an attacker. */
export function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export interface LiveLogin {
  /** Present when `.credentials.json` holds a Claude subscription login. */
  snapshot?: LoginSnapshot;
  fingerprint?: string;
  identity?: OAuthAccountInfo;
}

/** Reads the login the `claude` CLI uses right now. Throws only on malformed files. */
export function readLiveLogin(paths: ClaudePaths, now: () => Date = () => new Date(), store: LiveCredentialStore = new FileCredentialStore(paths)): LiveLogin {
  const credentials = store.read();
  const config = readJsonObject(paths.globalConfigFile);
  const identity = isObject(config?.["oauthAccount"]) ? (config["oauthAccount"] as OAuthAccountInfo) : undefined;
  const oauth = credentials?.["claudeAiOauth"];
  if (!isOAuth(oauth)) return identity ? { identity } : {};
  const organizationUuid = typeof credentials?.["organizationUuid"] === "string" ? (credentials["organizationUuid"] as string) : undefined;
  return {
    snapshot: {
      claudeAiOauth: oauth,
      credentials: accountCredentials(credentials!),
      ...(organizationUuid ? { organizationUuid } : {}),
      ...(identity ? { oauthAccount: identity } : {}),
      capturedAt: now().toISOString(),
    },
    fingerprint: fingerprint(oauth.refreshToken),
    ...(identity ? { identity } : {}),
  };
}

export function isOAuth(value: unknown): value is OAuthCredentials {
  return isObject(value) && typeof value["accessToken"] === "string" && typeof value["refreshToken"] === "string" && !!value["refreshToken"];
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function toIso(ms: unknown): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}
