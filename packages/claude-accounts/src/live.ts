import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonObject } from "./fsx.js";
import type { ClaudePaths, LoginSnapshot, OAuthAccountInfo, OAuthCredentials } from "./types.js";

/** Claude Code's own rule: `CLAUDE_CONFIG_DIR` moves the config folder and the global config file with it. */
export function resolveClaudePaths(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): ClaudePaths {
  const custom = env["CLAUDE_CONFIG_DIR"]?.trim();
  const configDir = custom || join(home, ".claude");
  return {
    configDir,
    credentialsFile: join(configDir, ".credentials.json"),
    globalConfigFile: custom ? join(custom, ".claude.json") : join(home, ".claude.json"),
    projectsDir: join(configDir, "projects"),
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
export function readLiveLogin(paths: ClaudePaths, now: () => Date = () => new Date()): LiveLogin {
  const credentials = readJsonObject(paths.credentialsFile);
  const config = readJsonObject(paths.globalConfigFile);
  const identity = isObject(config?.["oauthAccount"]) ? (config["oauthAccount"] as OAuthAccountInfo) : undefined;
  const oauth = credentials?.["claudeAiOauth"];
  if (!isOAuth(oauth)) return identity ? { identity } : {};
  const organizationUuid = typeof credentials?.["organizationUuid"] === "string" ? (credentials["organizationUuid"] as string) : undefined;
  return {
    snapshot: {
      claudeAiOauth: oauth,
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
