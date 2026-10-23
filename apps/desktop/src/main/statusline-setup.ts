import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Puts `ffswap statusline` in Claude Code's `statusLine` setting (the user's settings.json),
 * so every Claude Code session tells FrontFlow its quota and FrontFlow need not ask Anthropic.
 * A status line the user already had keeps running: it is chained, and restored on removal.
 */
export interface StatusLineSetup {
  /** ffswap.mjs exists where Claude Code can run it with node. */
  available: boolean;
  reason?: string;
  installed: boolean;
  /** The user's own status line runs after ours. */
  chained?: string;
  settingsPath: string;
}

const FRONTFLOW_DIR = join(homedir(), ".frontflow");
const CHAIN_FILE = join(FRONTFLOW_DIR, "statusline-chain.json");
const OURS = /ffswap(\.mjs)?["']?\s+statusline\b/;

export function statusLineSetup(configDir: string, ffswapPath: string): StatusLineSetup {
  const settingsPath = join(configDir, "settings.json");
  const available = existsSync(ffswapPath) && !/\.asar[\\/]/.test(ffswapPath);
  const command = currentCommand(settingsPath);
  const chained = readChain();
  return {
    available,
    ...(available ? {} : { reason: "The ffswap command is not available in this build of FrontFlow." }),
    installed: !!command && OURS.test(command),
    ...(chained ? { chained } : {}),
    settingsPath,
  };
}

export function installStatusLine(configDir: string, ffswapPath: string): void {
  const settingsPath = join(configDir, "settings.json");
  const settings = readSettings(settingsPath);
  const existing = isObject(settings["statusLine"]) ? settings["statusLine"] : undefined;
  const existingCommand = typeof existing?.["command"] === "string" ? existing["command"] : undefined;
  if (existingCommand && OURS.test(existingCommand)) return;
  mkdirSync(FRONTFLOW_DIR, { recursive: true, mode: 0o700 });
  if (existingCommand) writeFileSync(CHAIN_FILE, JSON.stringify({ command: existingCommand, original: existing }), { mode: 0o600 });
  else rmSync(CHAIN_FILE, { force: true });
  settings["statusLine"] = {
    ...(existing ?? {}),
    type: "command",
    command: `node "${ffswapPath.replace(/\\/g, "/")}" statusline`,
  };
  writeSettings(settingsPath, settings);
}

export function uninstallStatusLine(configDir: string): void {
  const settingsPath = join(configDir, "settings.json");
  const settings = readSettings(settingsPath);
  const existing = isObject(settings["statusLine"]) ? settings["statusLine"] : undefined;
  const command = typeof existing?.["command"] === "string" ? existing["command"] : undefined;
  if (command && OURS.test(command)) {
    let original: unknown;
    try {
      original = (JSON.parse(readFileSync(CHAIN_FILE, "utf8")) as { original?: unknown }).original;
    } catch {
      original = undefined;
    }
    if (isObject(original)) settings["statusLine"] = original;
    else delete settings["statusLine"];
    writeSettings(settingsPath, settings);
  }
  rmSync(CHAIN_FILE, { force: true });
}

function currentCommand(settingsPath: string): string | undefined {
  try {
    const s = readSettings(settingsPath);
    const line = isObject(s["statusLine"]) ? s["statusLine"] : undefined;
    return typeof line?.["command"] === "string" ? line["command"] : undefined;
  } catch {
    return undefined;
  }
}

function readChain(): string | undefined {
  try {
    const c = (JSON.parse(readFileSync(CHAIN_FILE, "utf8")) as { command?: unknown }).command;
    return typeof c === "string" ? c : undefined;
  } catch {
    return undefined;
  }
}

/** A missing file is empty settings; a file that is not a JSON object is never overwritten. */
function readSettings(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON; fix it first, FrontFlow will not overwrite it.`);
  }
  if (!isObject(parsed)) throw new Error(`${path} is not a JSON object; FrontFlow will not overwrite it.`);
  return parsed;
}

/** Backed up once (settings.json.frontflow-backup), then replaced atomically. */
function writeSettings(path: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const backup = `${path}.frontflow-backup`;
  if (existsSync(path) && !existsSync(backup)) copyFileSync(path, backup);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, path);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
