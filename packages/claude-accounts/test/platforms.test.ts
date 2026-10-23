import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClaudeAccountManager,
  composeCredentials,
  listClaudeProcesses,
  MacKeychainCredentialStore,
  resolveClaudePaths,
  type SecretVault,
  type SecurityRunner,
} from "../src/index.js";

/** In-memory stand-in for `/usr/bin/security` (generic passwords only). */
function fakeSecurity(): { run: SecurityRunner; items: Map<string, string>; calls: string[][] } {
  const items = new Map<string, string>();
  const calls: string[][] = [];
  const exec = (args: string[]): { status: number; stdout: string } => {
    calls.push(args);
    const opt = (flag: string) => args[args.indexOf(flag) + 1]!;
    const key = `${opt("-a")}|${opt("-s")}`;
    switch (args[0]) {
      case "find-generic-password":
        return items.has(key) ? { status: 0, stdout: `${items.get(key)}\n` } : { status: 44, stdout: "" };
      case "add-generic-password":
        items.set(key, Buffer.from(opt("-X"), "hex").toString("utf8"));
        return { status: 0, stdout: "" };
      case "delete-generic-password":
        return items.delete(key) ? { status: 0, stdout: "" } : { status: 44, stdout: "" };
      default:
        return { status: 1, stdout: "" };
    }
  };
  const run: SecurityRunner = (args, input) => {
    if (args[0] === "-i" && input) {
      // Mimic `security -i`: one shell-quoted command line on stdin.
      const parts = [...input.trim().matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]!));
      return exec(parts);
    }
    return exec(args);
  };
  return { run, items, calls };
}

describe("credentials across platforms", () => {
  let root: string;
  beforeEach(() => (root = mkdtempSync(join(tmpdir(), "ff-acc-plat-"))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("keeps machine-wide keys live and takes the account's own keys from the target", () => {
    const live = { claudeAiOauth: { refreshToken: "old" }, mcpOAuth: { figma: "live" }, pluginSecrets: { p: 1 }, accountFlag: "old" };
    const target = { claudeAiOauth: { refreshToken: "new" }, mcpOAuth: { figma: "stale" }, mcpXaaIdp: "stale", accountFlag: "new" };
    expect(composeCredentials(target, live)).toEqual({ claudeAiOauth: { refreshToken: "new" }, accountFlag: "new", mcpOAuth: { figma: "live" }, pluginSecrets: { p: 1 } });
  });

  it("prefers a non-empty legacy .config.json like Claude Code", () => {
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), "{}");
    expect(resolveClaudePaths({}, home).globalConfigFile).toBe(join(home, ".claude.json"));
    writeFileSync(join(home, ".claude", ".config.json"), '{"oauthAccount":{}}');
    expect(resolveClaudePaths({}, home).globalConfigFile).toBe(join(home, ".claude", ".config.json"));
  });

  it("switches through the macOS Keychain and bumps the credentials file only if it exists", async () => {
    const sec = fakeSecurity();
    const paths = resolveClaudePaths({}, join(root, "home"));
    mkdirSync(paths.configDir, { recursive: true });
    const store = new MacKeychainCredentialStore(paths, { env: { USER: "dev" }, security: sec.run });
    const login = (uuid: string, refresh: string) => {
      sec.items.set("dev|Claude Code-credentials", JSON.stringify({ claudeAiOauth: { accessToken: `at-${refresh}`, refreshToken: refresh, expiresAt: Date.now() + 3_600_000 }, mcpOAuth: { m: 1 } }));
      writeFileSync(paths.globalConfigFile, JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: `${uuid}@x.dev` } }));
    };
    const vault = new Map<string, string>();
    const v: SecretVault = { get: (k) => vault.get(k), set: (k, val) => void vault.set(k, val), delete: (k) => vault.delete(k) };
    const manager = new ClaudeAccountManager({ paths, storeDir: join(root, "store"), vault: v, liveStore: store, stableReadDelayMs: 1 });

    login("acc-a", "rt-a");
    await manager.captureLive();
    // B is added through its own folder, as `claude auth login` does, so A stays the login in use.
    const isolated = resolveClaudePaths({ CLAUDE_CONFIG_DIR: join(root, "login-b") }, join(root, "home"));
    mkdirSync(isolated.configDir, { recursive: true });
    writeFileSync(isolated.credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: "at-rt-b", refreshToken: "rt-b", expiresAt: Date.now() + 3_600_000 } }));
    writeFileSync(isolated.globalConfigFile, JSON.stringify({ oauthAccount: { accountUuid: "acc-b", emailAddress: "acc-b@x.dev" } }));
    await manager.captureFrom(isolated);
    await manager.switchTo("acc-b");
    expect(JSON.parse(sec.items.get("dev|Claude Code-credentials")!).claudeAiOauth.refreshToken).toBe("rt-b");
    expect(JSON.parse(vault.get("claude:account:acc-a")!).claudeAiOauth.refreshToken).toBe("rt-a");
    await manager.switchTo("acc-a");

    const item = JSON.parse(sec.items.get("dev|Claude Code-credentials")!);
    expect(item.claudeAiOauth.refreshToken).toBe("rt-a");
    expect([...vault.keys()]).toEqual(["claude:account:acc-b"]);
    expect(item.mcpOAuth).toEqual({ m: 1 });
    // The JSON travels hex-encoded on stdin, never in argv.
    expect(sec.calls.some((c) => c.includes("-X") && c[0] === "add-generic-password")).toBe(true);
    expect(() => readFileSync(paths.credentialsFile)).toThrow();
    expect(JSON.parse(readFileSync(paths.globalConfigFile, "utf8")).oauthAccount.accountUuid).toBe("acc-a");
  });

  it("isolated logins use their own Keychain item and never touch the machine's", () => {
    const sec = fakeSecurity();
    sec.items.set("dev|Claude Code-credentials", JSON.stringify({ claudeAiOauth: { accessToken: "main", refreshToken: "main" } }));
    const dir = join(root, "login-1");
    const own = `Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
    const store = new MacKeychainCredentialStore(resolveClaudePaths({ CLAUDE_CONFIG_DIR: dir }), { env: { USER: "dev", CLAUDE_CONFIG_DIR: dir }, security: sec.run, isolated: true });
    // Nothing logged in there yet: it must not fall back to the machine's login.
    expect(store.read()).toBeUndefined();
    sec.items.set(`dev|${own}`, JSON.stringify({ claudeAiOauth: { accessToken: "new", refreshToken: "new" } }));
    expect(store.read()).toMatchObject({ claudeAiOauth: { refreshToken: "new" } });
    store.clear();
    expect(sec.items.has(`dev|${own}`)).toBe(false);
    expect(sec.items.has("dev|Claude Code-credentials")).toBe(true);
    const live = new MacKeychainCredentialStore(resolveClaudePaths({}, root), { env: { USER: "dev" }, security: sec.run });
    expect(() => live.clear()).toThrow(/Refusing/);
  });

  it("asks ps for UTC start times in the C locale", async () => {
    let env: Record<string, string> | undefined;
    const list = await listClaudeProcesses(async (_f, _a, e) => {
      env = e;
      return "  7 Thu Oct 23 03:00:00 2026 /usr/local/bin/claude\n";
    }, "darwin");
    expect(env).toEqual({ LC_ALL: "C", TZ: "UTC" });
    expect(list[0]?.startedAt).toBe("2026-10-23T03:00:00.000Z");
  });
});
