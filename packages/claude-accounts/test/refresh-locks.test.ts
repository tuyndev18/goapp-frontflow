import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClaudeAccountManager,
  claudeLockPaths,
  CLAUDE_CODE_CLIENT_ID,
  fetchQuota,
  paceOf,
  refreshOAuthToken,
  resolveClaudePaths,
  type ClaudePaths,
  type FetchLike,
  type SecretVault,
} from "../src/index.js";

const NOW = Date.parse("2026-10-23T10:00:00.000Z");
const HOUR = 3_600_000;

function responder(status: number, body: unknown): { fetch: FetchLike; bodies: unknown[] } {
  const bodies: unknown[] = [];
  return {
    bodies,
    fetch: async (_url, init) => {
      if (init.body) bodies.push(JSON.parse(init.body));
      return { status, headers: { get: () => null }, json: async () => body };
    },
  };
}

describe("OAuth refresh", () => {
  const current = { accessToken: "at-old", refreshToken: "rt-old", expiresAt: NOW - HOUR, subscriptionType: "max" };

  it("rotates the refresh token and keeps other fields", async () => {
    const { fetch, bodies } = responder(200, { access_token: "at-new", refresh_token: "rt-new", expires_in: 28_800, scope: "user:inference user:profile" });
    const res = await refreshOAuthToken(current, { fetch, now: () => new Date(NOW) });
    expect(bodies[0]).toEqual({ grant_type: "refresh_token", refresh_token: "rt-old", client_id: CLAUDE_CODE_CLIENT_ID });
    expect(res).toEqual({
      ok: true,
      credentials: { accessToken: "at-new", refreshToken: "rt-new", expiresAt: NOW + 28_800_000, scopes: ["user:inference", "user:profile"], subscriptionType: "max" },
    });
  });

  it("only calls a refusal invalid_grant when the server says so", async () => {
    expect(await refreshOAuthToken(current, { fetch: responder(400, { error: "invalid_grant" }).fetch })).toMatchObject({ ok: false, code: "invalid_grant" });
    expect(await refreshOAuthToken(current, { fetch: responder(401, { error: "invalid_client" }).fetch })).toMatchObject({ ok: false, code: "invalid_client" });
    expect(await refreshOAuthToken(current, { fetch: responder(400, "<html>").fetch })).toMatchObject({ ok: false, code: "transient" });
    expect(await refreshOAuthToken(current, { fetch: async () => Promise.reject(new Error("timeout")) })).toMatchObject({ ok: false, code: "transient" });
  });
});

describe("quota extras", () => {
  it("reads per-model limits by display name", async () => {
    const fetch: FetchLike = async () => ({
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        five_hour: { utilization: 76, resets_at: "2026-10-23T12:47:00Z" },
        limits: [{ scope: { model: { display_name: "Fable" } }, percent: 59, resets_at: "2026-10-28T13:00:00Z" }, { scope: { org: {} }, percent: 3 }, { percent: "x" }],
      }),
    });
    const res = await fetchQuota("t", { fetch });
    expect(res.ok && res.value.windows.map((w) => [w.key, w.label, w.utilization])).toEqual([
      ["five_hour", "5h", 76],
      ["model:fable", "Fable", 59],
    ]);
  });

  it("projects when a window runs out at the current pace", () => {
    // 5-hour window, 2.5 h in (resets in 2.5 h), 80% used: twice the even pace, out in ~37 min.
    const fast = paceOf({ key: "five_hour", label: "", utilization: 80, resetsAt: new Date(NOW + 2.5 * HOUR).toISOString() }, NOW)!;
    expect(fast).toMatchObject({ expectedPct: 50, aheadOfPace: true, willLastToReset: false });
    expect(Date.parse(fast.projectedExhaustionAt!) - NOW).toBeCloseTo(0.625 * HOUR, -3);
    const calm = paceOf({ key: "seven_day", label: "", utilization: 20, resetsAt: new Date(NOW + 3.5 * 24 * HOUR).toISOString() }, NOW)!;
    expect(calm).toMatchObject({ expectedPct: 50, aheadOfPace: false, willLastToReset: true });
    expect(calm.projectedExhaustionAt).toBeUndefined();
  });
});

class MemoryVault implements SecretVault {
  readonly map = new Map<string, string>();
  get(key: string) {
    return this.map.get(key);
  }
  set(key: string, value: string) {
    this.map.set(key, value);
  }
  delete(key: string) {
    return this.map.delete(key);
  }
}

function writeLogin(paths: ClaudePaths, uuid: string, refresh: string, expiresAt = NOW + 8 * HOUR) {
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(paths.credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: `at-${refresh}`, refreshToken: refresh, expiresAt } }));
  writeFileSync(paths.globalConfigFile, JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: `${uuid}@x.dev` } }));
}

describe("stored-login refresh and Claude Code's locks", () => {
  let root: string;
  let live: ClaudePaths;
  let vault: MemoryVault;
  let manager: ClaudeAccountManager;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "ff-acc-refresh-"));
    live = resolveClaudePaths({}, join(root, "home"));
    vault = new MemoryVault();
    manager = new ClaudeAccountManager({ paths: live, storeDir: join(root, "store"), vault, now: () => new Date(NOW), stableReadDelayMs: 1 });
    writeLogin(live, "acc-a", "rt-a");
    await manager.captureLive();
    const other = resolveClaudePaths({ CLAUDE_CONFIG_DIR: join(root, "login-b") }, join(root, "home"));
    writeLogin(other, "acc-b", "rt-b", NOW - HOUR);
    await manager.captureFrom(other);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("refreshes a saved account, never the live one", async () => {
    const { fetch } = responder(200, { access_token: "at-b2", refresh_token: "rt-b2", expires_in: 3600 });
    expect(await manager.refreshStored("acc-a", { fetch })).toBe("live");
    expect(await manager.accessTokenFor("acc-b")).toBeUndefined();
    expect(await manager.refreshStored("acc-b", { fetch })).toBe("refreshed");
    expect(await manager.accessTokenFor("acc-b")).toBe("at-b2");
    expect(JSON.parse(vault.get("claude:account:acc-b")!).claudeAiOauth.refreshToken).toBe("rt-b2");
    expect(manager.audit().at(-1)).toMatchObject({ action: "refresh", accountId: "acc-b" });
  });

  it("marks a dead refresh lineage as needing a login", async () => {
    expect(await manager.refreshStored("acc-b", { fetch: responder(400, { error: "invalid_grant" }).fetch })).toBe("invalid_grant");
    expect(manager.status(manager.get("acc-b")!)).toBe("needs_login");
    await expect(manager.switchTo("acc-b")).rejects.toMatchObject({ code: "NEEDS_LOGIN" });
  });

  it("waits for Claude Code's refresh lock before switching, and takes over a stale one", async () => {
    const locks = claudeLockPaths(live);
    expect(locks).toEqual({ refresh: join(live.configDir, ".oauth_refresh.lock"), legacy: `${live.configDir}.lock`, config: `${live.globalConfigFile}.lock` });
    // A fresh lock held by "Claude": the switch waits and writes only once it is released.
    mkdirSync(locks.refresh);
    const switching = manager.switchTo("acc-b");
    await new Promise((r) => setTimeout(r, 150));
    expect(JSON.parse(readFileSync(live.credentialsFile, "utf8")).claudeAiOauth.refreshToken).toBe("rt-a");
    rmSync(locks.refresh, { recursive: true });
    await switching;
    expect(JSON.parse(readFileSync(live.credentialsFile, "utf8")).claudeAiOauth.refreshToken).toBe("rt-b");

    // A lock left by a crashed process (older than 60 s) does not block forever.
    mkdirSync(locks.legacy);
    const old = new Date(Date.now() - 120_000);
    utimesSync(locks.legacy, old, old);
    await manager.switchTo("acc-a");
    expect(JSON.parse(readFileSync(live.credentialsFile, "utf8")).claudeAiOauth.refreshToken).toBe("rt-a");
  });
});
