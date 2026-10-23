import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountError, ClaudeAccountManager, fingerprint, readLiveLogin, resolveClaudePaths, type ClaudePaths, type SecretVault } from "../src/index.js";

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

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-23T10:00:00.000Z");

function login(paths: ClaudePaths, who: { uuid: string; email: string; refresh: string; access?: string; expiresAt?: number; refreshExpiresAt?: number; extraConfig?: object }) {
  mkdirSync(paths.configDir, { recursive: true });
  const existing = (() => {
    try {
      return JSON.parse(readFileSync(paths.credentialsFile, "utf8")) as object;
    } catch {
      return {};
    }
  })();
  writeFileSync(
    paths.credentialsFile,
    JSON.stringify({
      ...existing,
      claudeAiOauth: {
        accessToken: who.access ?? `access-${who.refresh}`,
        refreshToken: who.refresh,
        expiresAt: who.expiresAt ?? NOW + 8 * HOUR,
        refreshTokenExpiresAt: who.refreshExpiresAt ?? NOW + 30 * 24 * HOUR,
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      },
      organizationUuid: `org-${who.uuid}`,
    }),
  );
  const config = (() => {
    try {
      return JSON.parse(readFileSync(paths.globalConfigFile, "utf8")) as object;
    } catch {
      return {};
    }
  })();
  writeFileSync(
    paths.globalConfigFile,
    JSON.stringify({ ...config, ...who.extraConfig, oauthAccount: { accountUuid: who.uuid, emailAddress: who.email, organizationName: `Org of ${who.email}`, billingType: "stripe_subscription" } }),
  );
}

describe("ClaudeAccountManager", () => {
  let root: string;
  let live: ClaudePaths;
  let vault: MemoryVault;
  let verified: Map<string, string>;
  let manager: ClaudeAccountManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ff-accounts-"));
    live = resolveClaudePaths({}, join(root, "home"));
    vault = new MemoryVault();
    verified = new Map();
    manager = new ClaudeAccountManager({
      paths: live,
      storeDir: join(root, "store"),
      vault,
      now: () => new Date(NOW),
      stableReadDelayMs: 1,
      verifyAccount: async (token) => verified.get(token),
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("resolves Claude's paths like the CLI does", () => {
    expect(resolveClaudePaths({}, "/home/u")).toMatchObject({ configDir: join("/home/u", ".claude"), globalConfigFile: join("/home/u", ".claude.json") });
    expect(resolveClaudePaths({ CLAUDE_CONFIG_DIR: "/p" }, "/home/u")).toMatchObject({ credentialsFile: join("/p", ".credentials.json"), globalConfigFile: join("/p", ".claude.json") });
  });

  it("records the live login without copying its token anywhere", async () => {
    login(live, { uuid: "acc-a", email: "a@x.dev", refresh: "rt-a1", extraConfig: { projects: { keep: true } } });
    const a = await manager.captureLive("Work");
    expect(a).toMatchObject({ id: "acc-a", label: "Work", email: "a@x.dev", subscriptionType: "max", organizationName: "Org of a@x.dev", fingerprint: fingerprint("rt-a1"), location: "live" });
    // The login in use stays Claude Code's alone.
    expect(vault.map.size).toBe(0);
    const index = readFileSync(join(root, "store", "index.json"), "utf8");
    expect(index).not.toContain("rt-a1");
    expect(index).not.toContain("access-rt-a1");
    expect((await manager.observe()).accountId).toBe("acc-a");
  });

  it("keeps every login in exactly one place across switches", async () => {
    login(live, { uuid: "acc-a", email: "a@x.dev", refresh: "rt-a1" });
    await manager.captureLive();
    const isolated = resolveClaudePaths({ CLAUDE_CONFIG_DIR: join(root, "login-b") }, join(root, "home"));
    login(isolated, { uuid: "acc-b", email: "b@x.dev", refresh: "rt-b1" });
    await manager.captureFrom(isolated);
    const where = () => ({
      live: JSON.parse(readFileSync(live.credentialsFile, "utf8")).claudeAiOauth.refreshToken,
      vault: [...vault.map.entries()].map(([k, v]) => `${k}=${JSON.parse(v).claudeAiOauth.refreshToken}`).sort(),
      locations: Object.fromEntries(manager.list().map((a) => [a.id, a.location])),
    });
    expect(where()).toEqual({ live: "rt-a1", vault: ["claude:account:acc-b=rt-b1"], locations: { "acc-a": "live", "acc-b": "vault" } });
    await manager.switchTo("acc-b");
    expect(where()).toEqual({ live: "rt-b1", vault: ["claude:account:acc-a=rt-a1"], locations: { "acc-a": "vault", "acc-b": "live" } });
    await manager.switchTo("acc-a");
    expect(where()).toEqual({ live: "rt-a1", vault: ["claude:account:acc-b=rt-b1"], locations: { "acc-a": "live", "acc-b": "vault" } });
    expect((await manager.switchTo("acc-a")).warnings).toEqual(["This account is already the login in use"]);
  });

  it("adds a login made in an isolated folder without touching the live one, then switches machine-wide", async () => {
    login(live, { uuid: "acc-a", email: "a@x.dev", refresh: "rt-a1", extraConfig: { projects: { keep: true }, theme: "dark" } });
    // MCP tokens in the live file belong to the machine, not to an account.
    const creds = JSON.parse(readFileSync(live.credentialsFile, "utf8"));
    writeFileSync(live.credentialsFile, JSON.stringify({ ...creds, mcpOAuth: { figma: "mcp-secret" } }));
    await manager.captureLive();

    const isolated = resolveClaudePaths({ CLAUDE_CONFIG_DIR: join(root, "login-1") }, join(root, "home"));
    login(isolated, { uuid: "acc-b", email: "b@x.dev", refresh: "rt-b1" });
    await manager.captureFrom(isolated);
    expect(readLiveLogin(live).identity?.accountUuid).toBe("acc-a");
    expect(manager.list().map((a) => a.id).sort()).toEqual(["acc-a", "acc-b"]);

    const outcome = await manager.switchTo("acc-b");
    expect(outcome).toMatchObject({ accountId: "acc-b", previousAccountId: "acc-a", restartRequired: true });
    const after = JSON.parse(readFileSync(live.credentialsFile, "utf8"));
    expect(after.claudeAiOauth.refreshToken).toBe("rt-b1");
    expect(after.mcpOAuth).toEqual({ figma: "mcp-secret" });
    const config = JSON.parse(readFileSync(live.globalConfigFile, "utf8"));
    expect(config).toMatchObject({ theme: "dark", projects: { keep: true }, oauthAccount: { accountUuid: "acc-b" } });
    // The previous live login is parked, and nothing else is kept: no backup copies.
    expect([...vault.map.keys()]).toEqual(["claude:account:acc-a"]);
    expect(manager.timeline().map((t) => t.accountId)).toEqual(["acc-a", "acc-b"]);
    expect(manager.audit().map((a) => a.action)).toEqual(["capture", "capture", "switch"]);
    expect(JSON.stringify(manager.audit())).not.toContain("rt-");
  });

  it("parks the token Claude renewed, not the one it replaced, when switching away", async () => {
    login(live, { uuid: "acc-a", email: "a@x.dev", refresh: "rt-a1" });
    await manager.captureLive();
    const isolated = resolveClaudePaths({ CLAUDE_CONFIG_DIR: join(root, "login-b") }, join(root, "home"));
    login(isolated, { uuid: "acc-b", email: "b@x.dev", refresh: "rt-b1" });
    await manager.captureFrom(isolated);

    // Claude rotates A's refresh token while A is live; the provider confirms it is A's.
    login(live, { uuid: "acc-a", email: "a@x.dev", refresh: "rt-a2", access: "at-a2", expiresAt: NOW + 9 * HOUR });
    verified.set("at-a2", "acc-a");
    await manager.switchTo("acc-b");
    await manager.switchTo("acc-a");
    // Switching back restores the rotated token, not the stale one (which the server revoked).
    expect(JSON.parse(readFileSync(live.credentialsFile, "utf8")).claudeAiOauth.refreshToken).toBe("rt-a2");
    expect(manager.get("acc-a")?.previousFingerprints).toEqual([fingerprint("rt-a1")]);
  });

  it("never saves an unverified token into an account just because the identity file names it", async () => {
    login(live, { uuid: "acc-a", email: "a@x.dev", refresh: "rt-a1" });
    await manager.captureLive();
    // Unknown token next to A's identity (e.g. a stale process wrote another account's token).
    login(live, { uuid: "acc-a", email: "a@x.dev", refresh: "rt-foreign", access: "at-foreign" });
    const obs = await manager.observe();
    expect(obs.accountId).toBeUndefined();
    expect(obs.mismatch).toMatch(/Unverified/);
    expect(manager.get("acc-a")?.fingerprint).toBe(fingerprint("rt-a1"));
    // ...and never switches away from a login it cannot attribute: it would be lost.
    const isolated = resolveClaudePaths({ CLAUDE_CONFIG_DIR: join(root, "login-b") }, join(root, "home"));
    login(isolated, { uuid: "acc-b", email: "b@x.dev", refresh: "rt-b1" });
    await manager.captureFrom(isolated);
    await expect(manager.switchTo("acc-b")).rejects.toMatchObject({ code: "UNSAVED_LIVE" });
    expect(JSON.parse(readFileSync(live.credentialsFile, "utf8")).claudeAiOauth.refreshToken).toBe("rt-foreign");

    verified.set("at-foreign", "acc-z");
    expect((await manager.observe()).mismatch).toMatch(/another account/);
    expect(manager.get("acc-a")?.fingerprint).toBe(fingerprint("rt-a1"));
    expect(vault.get("claude:account:acc-a")).toBeUndefined();
  });

  it("with provider checks off, recognizes Claude renewing the live token by continuity", async () => {
    const strict = new ClaudeAccountManager({
      paths: live,
      storeDir: join(root, "strict"),
      vault,
      now: () => new Date(NOW),
      stableReadDelayMs: 1,
      verifyAccount: async () => {
        throw new Error("no request may be sent");
      },
      canVerify: () => false,
    });
    login(live, { uuid: "acc-a", email: "a@x.dev", refresh: "rt-a1" });
    await strict.captureLive();
    login(live, { uuid: "acc-a", email: "a@x.dev", refresh: "rt-a2", access: "at-a2", expiresAt: NOW + 9 * HOUR });
    const obs = await strict.observe();
    expect(obs).toMatchObject({ accountId: "acc-a" });
    expect(obs.mismatch).toBeUndefined();
    expect(strict.get("acc-a")).toMatchObject({ fingerprint: fingerprint("rt-a2"), previousFingerprints: [fingerprint("rt-a1")] });
  });

  it("marks an account whose login was replaced outside FrontFlow as needing a new login", async () => {
    login(live, { uuid: "acc-a", email: "a@x.dev", refresh: "rt-a1" });
    await manager.captureLive();
    // `/login` with another account in Claude Code: A's token is overwritten, never parked.
    login(live, { uuid: "acc-z", email: "z@x.dev", refresh: "rt-z", access: "at-z" });
    verified.set("at-z", "acc-z");
    expect((await manager.observe()).accountId).toBeUndefined();
    expect(manager.get("acc-a")?.location).toBe("lost");
    expect(manager.status(manager.get("acc-a")!)).toBe("needs_login");
    expect(manager.audit().at(-1)).toMatchObject({ action: "lost", accountId: "acc-a" });
  });

  it("finishes an interrupted switch on the next look, never dropping a newer parked login", async () => {
    login(live, { uuid: "acc-a", email: "a@x.dev", refresh: "rt-a1" });
    await manager.captureLive();
    const isolated = resolveClaudePaths({ CLAUDE_CONFIG_DIR: join(root, "login-b") }, join(root, "home"));
    login(isolated, { uuid: "acc-b", email: "b@x.dev", refresh: "rt-b1" });
    await manager.captureFrom(isolated);
    // Crash after parking A and writing B, before B left the vault: B is in two places.
    vault.set("claude:account:acc-a", JSON.stringify({ claudeAiOauth: { accessToken: "access-rt-a1", refreshToken: "rt-a1", expiresAt: NOW + 8 * HOUR }, capturedAt: "" }));
    login(live, { uuid: "acc-b", email: "b@x.dev", refresh: "rt-b1" });
    expect((await manager.observe()).accountId).toBe("acc-b");
    expect([...vault.map.keys()]).toEqual(["claude:account:acc-a"]);
    expect(Object.fromEntries(manager.list().map((a) => [a.id, a.location]))).toEqual({ "acc-a": "vault", "acc-b": "live" });

    // A stale process writes back B's older token while a newer one is parked: keep the parked one.
    vault.set("claude:account:acc-b", JSON.stringify({ claudeAiOauth: { accessToken: "at-b2", refreshToken: "rt-b2", expiresAt: NOW + 20 * HOUR }, capturedAt: "" }));
    const obs = await manager.observe();
    expect(obs.mismatch).toMatch(/older login/);
    expect(JSON.parse(vault.get("claude:account:acc-b")!).claudeAiOauth.refreshToken).toBe("rt-b2");
  });

  it("hands a parked login to a profile folder for runs, and switches to it from there", async () => {
    login(live, { uuid: "acc-a", email: "a@x.dev", refresh: "rt-a1", extraConfig: { hasCompletedOnboarding: true, projects: { "/p": { hasTrustDialogAccepted: true } } } });
    await manager.captureLive();
    const isolated = resolveClaudePaths({ CLAUDE_CONFIG_DIR: join(root, "login-b") }, join(root, "home"));
    login(isolated, { uuid: "acc-b", email: "b@x.dev", refresh: "rt-b1", access: "at-b1" });
    await manager.captureFrom(isolated);
    await expect(manager.moveToProfile("acc-a", join(root, "profile-a"))).rejects.toMatchObject({ code: "IN_USE" });

    const dir = join(root, "profile-b");
    await manager.moveToProfile("acc-b", dir);
    const profile = resolveClaudePaths({ CLAUDE_CONFIG_DIR: dir });
    expect(JSON.parse(readFileSync(profile.credentialsFile, "utf8")).claudeAiOauth.refreshToken).toBe("rt-b1");
    // The user's onboarding and trusted folders, with B's identity: the TUI starts without first-run prompts.
    expect(JSON.parse(readFileSync(profile.globalConfigFile, "utf8"))).toMatchObject({ hasCompletedOnboarding: true, projects: { "/p": { hasTrustDialogAccepted: true } }, oauthAccount: { accountUuid: "acc-b" } });
    expect(vault.map.size).toBe(0);
    expect(manager.get("acc-b")).toMatchObject({ location: "profile", profileDir: dir });
    expect(await manager.accessTokenFor("acc-b")).toBe("at-b1");
    expect(await manager.refreshStored("acc-b")).toBe("live");
    await manager.moveToProfile("acc-b", dir); // again: only the config is brought up to date

    // Claude Code renewed it in the profile; switching takes that one, and the profile no longer holds it.
    login(profile, { uuid: "acc-b", email: "b@x.dev", refresh: "rt-b2" });
    const outcome = await manager.switchTo("acc-b");
    expect(outcome.warnings.some((w) => /runs still open/.test(w))).toBe(true);
    expect(JSON.parse(readFileSync(live.credentialsFile, "utf8")).claudeAiOauth.refreshToken).toBe("rt-b2");
    expect(JSON.parse(readFileSync(profile.credentialsFile, "utf8")).claudeAiOauth).toBeUndefined();
    expect([...vault.map.keys()]).toEqual(["claude:account:acc-a"]);
    expect(manager.get("acc-b")).toMatchObject({ location: "live" });
    expect(manager.get("acc-b")?.profileDir).toBeUndefined();
  });

  it("moves an index of version 1 to one place per login", async () => {
    login(live, { uuid: "acc-a", email: "a@x.dev", refresh: "rt-a1" });
    await manager.captureLive();
    const file = join(root, "store", "index.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), version: 1 }));
    const snap = (rt: string) => JSON.stringify({ claudeAiOauth: { accessToken: `access-${rt}`, refreshToken: rt, expiresAt: NOW + 8 * HOUR }, capturedAt: "" });
    vault.set("claude:account:acc-a", snap("rt-a1"));
    vault.set("claude:backup:0", snap("rt-a1"));
    vault.set("claude:backup:1", snap("rt-unknown"));
    await manager.observe();
    expect([...vault.map.keys()]).toEqual(["claude:backup:1"]);
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(2);
    expect(manager.audit().map((a) => a.action)).toEqual(["capture", "migrate", "unpark"]);
  });

  it("repairs the identity file when a running claude rewrote it after our switch", async () => {
    login(live, { uuid: "acc-a", email: "a@x.dev", refresh: "rt-a1" });
    await manager.captureLive();
    const isolated = resolveClaudePaths({ CLAUDE_CONFIG_DIR: join(root, "login-b") }, join(root, "home"));
    login(isolated, { uuid: "acc-b", email: "b@x.dev", refresh: "rt-b1" });
    await manager.captureFrom(isolated);
    await manager.switchTo("acc-b");
    // An old process saves its in-memory config: identity A again, token still B.
    const config = JSON.parse(readFileSync(live.globalConfigFile, "utf8"));
    writeFileSync(live.globalConfigFile, JSON.stringify({ ...config, oauthAccount: { accountUuid: "acc-a", emailAddress: "a@x.dev" } }));
    const obs = await manager.observe();
    expect(obs).toMatchObject({ accountId: "acc-b" });
    expect(obs.mismatch).toBeUndefined();
    expect(JSON.parse(readFileSync(live.globalConfigFile, "utf8")).oauthAccount.accountUuid).toBe("acc-b");
    expect(manager.audit().at(-1)?.action).toBe("repair");
  });

  it("refuses to switch to an account whose refresh token expired, and removes accounts", async () => {
    login(live, { uuid: "acc-a", email: "a@x.dev", refresh: "rt-a1" });
    await manager.captureLive();
    const isolated = resolveClaudePaths({ CLAUDE_CONFIG_DIR: join(root, "login-old") }, join(root, "home"));
    login(isolated, { uuid: "acc-old", email: "old@x.dev", refresh: "rt-old", refreshExpiresAt: NOW - HOUR });
    await manager.captureFrom(isolated);
    expect(manager.status(manager.get("acc-old")!)).toBe("needs_login");
    await expect(manager.switchTo("acc-old")).rejects.toMatchObject({ code: "NEEDS_LOGIN" });
    expect(JSON.parse(readFileSync(live.credentialsFile, "utf8")).claudeAiOauth.refreshToken).toBe("rt-a1");

    await manager.remove("acc-old");
    expect(manager.get("acc-old")).toBeUndefined();
    expect(vault.get("claude:account:acc-old")).toBeUndefined();
    await expect(manager.switchTo("acc-old")).rejects.toBeInstanceOf(AccountError);
  });

  it("hands out the freshest usable access token", async () => {
    login(live, { uuid: "acc-a", email: "a@x.dev", refresh: "rt-a1", access: "at-live" });
    await manager.captureLive();
    expect(await manager.accessTokenFor("acc-a")).toBe("at-live");
    const isolated = resolveClaudePaths({ CLAUDE_CONFIG_DIR: join(root, "login-c") }, join(root, "home"));
    login(isolated, { uuid: "acc-c", email: "c@x.dev", refresh: "rt-c", access: "at-c", expiresAt: NOW - HOUR });
    await manager.captureFrom(isolated);
    // Expired and not live: no token, the account shows its last known quota.
    expect(await manager.accessTokenFor("acc-c")).toBeUndefined();
  });
});
