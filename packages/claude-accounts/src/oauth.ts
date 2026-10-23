import type { FetchLike, HttpResponseLike } from "./api.js";
import type { OAuthCredentials } from "./types.js";

/** Claude Code's public OAuth client and token endpoint (what `claude` itself refreshes with). */
export const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export interface RefreshOptions {
  fetch?: FetchLike;
  url?: string;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * - invalid_grant: the refresh lineage is dead — the account needs a new login.
 * - invalid_client: the client itself was refused — systemic, says nothing about the account.
 * - transient: network, timeout, 5xx, unparseable. The server may still have rotated the
 *   token (doc §4.4 "unknown outcome"): never resend automatically right away.
 */
export type RefreshResult = { ok: true; credentials: OAuthCredentials } | { ok: false; code: "invalid_grant" | "invalid_client" | "transient"; message: string };

/** One POST, no retries. The caller persists the result before anything else uses the account. */
export async function refreshOAuthToken(current: OAuthCredentials, options: RefreshOptions = {}): Promise<RefreshResult> {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  let res: HttpResponseLike;
  try {
    res = await doFetch(options.url ?? CLAUDE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "GoApp-FrontFlow" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: CLAUDE_CODE_CLIENT_ID }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (err) {
    return { ok: false, code: "transient", message: (err as Error).message || "Network error" };
  }
  let body: Record<string, unknown> | undefined;
  try {
    const parsed = await res.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    body = undefined;
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    const error = typeof body?.["error"] === "string" ? body["error"] : undefined;
    if (error === "invalid_grant" || error === "invalid_client") return { ok: false, code: error, message: `Refresh refused: ${error}` };
    return { ok: false, code: "transient", message: `HTTP ${res.status}` };
  }
  if (res.status < 200 || res.status >= 300 || !body || typeof body["access_token"] !== "string") {
    return { ok: false, code: "transient", message: `HTTP ${res.status}` };
  }
  const now = (options.now?.() ?? new Date()).getTime();
  const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : undefined;
  const scope = typeof body["scope"] === "string" ? body["scope"] : undefined;
  return {
    ok: true,
    credentials: {
      ...current,
      accessToken: body["access_token"] as string,
      // Rotation: a returned refresh token replaces the old one, which the server now refuses.
      ...(typeof body["refresh_token"] === "string" && body["refresh_token"] ? { refreshToken: body["refresh_token"] as string } : {}),
      ...(expiresIn !== undefined ? { expiresAt: now + expiresIn * 1000 } : {}),
      ...(scope ? { scopes: scope.split(" ").filter(Boolean) } : {}),
    },
  };
}
