#!/usr/bin/env node
// ffswap — claude-swap style commands for the Claude accounts saved in FrontFlow.
// The logins live in FrontFlow's encrypted vault, so this only forwards the command to the
// running app (src/main/accounts-cli.ts) and prints its answer. `ffswap help` lists commands.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const dir = join(homedir(), ".frontflow");
const socket =
  process.env.FRONTFLOW_ACCOUNTS_SOCKET ?? (process.platform === "win32" ? `\\\\.\\pipe\\frontflow-accounts-${userInfo().username}` : join(dir, "accounts.sock"));

function readToken() {
  try {
    return readFileSync(join(dir, "cli-token"), "utf8").trim();
  } catch {
    return undefined;
  }
}

function send(argv) {
  const token = readToken();
  if (!token) return Promise.reject(new Error("FrontFlow is not running. Open it, then try again."));
  return new Promise((resolve, reject) => {
    const conn = createConnection(socket);
    let data = "";
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(`${JSON.stringify({ token, argv })}\n`));
    conn.on("data", (chunk) => (data += chunk));
    conn.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("FrontFlow sent an unreadable answer"));
      }
    });
    conn.on("error", (err) => reject(err.code === "ENOENT" || err.code === "ECONNREFUSED" ? new Error("FrontFlow is not running. Open it, then try again.") : err));
  });
}

/** `add --login`: `claude auth login` runs here, in this terminal, in the folder FrontFlow chose. */
function runLogin(login) {
  return new Promise((resolve) => {
    const child = spawn("claude", login.args, {
      stdio: "inherit",
      env: { ...process.env, CLAUDE_CONFIG_DIR: login.dir },
      // npm installs claude as claude.cmd on Windows; the arguments are fixed words.
      shell: process.platform === "win32",
    });
    child.on("error", (err) => {
      console.error(`Could not start claude: ${err.message}`);
      resolve(false);
    });
    child.on("exit", (code) => resolve(code !== null));
  });
}

/**
 * `ffswap statusline`: Claude Code's statusLine command, installed from FrontFlow's Accounts
 * screen. Claude Code passes the session as JSON on stdin after each response; its
 * `rate_limits` (5h / 7d used and reset, from the response's own headers) are filed in
 * ~/.frontflow/statusline/<session>.json, so FrontFlow knows the account's quota without
 * asking Anthropic. No network, no token. Then the status line the user had before, if any,
 * gets the same input and prints the line; otherwise a short line of ours.
 */
async function statusLine() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    input = undefined;
  }
  const limits = input && typeof input === "object" ? input.rate_limits : undefined;
  const windows = [];
  for (const [key, label] of [["five_hour", "5h"], ["seven_day", "7d"]]) {
    const w = limits && typeof limits === "object" ? limits[key] : undefined;
    if (!w || typeof w.used_percentage !== "number" || !Number.isFinite(w.used_percentage)) continue;
    const r = w.resets_at;
    const resetsAt = typeof r === "number" && Number.isFinite(r) ? new Date(r > 1e12 ? r : r * 1000).toISOString() : typeof r === "string" && Number.isFinite(Date.parse(r)) ? new Date(r).toISOString() : undefined;
    windows.push({ key, label, utilization: Math.max(0, Math.min(100, w.used_percentage)), ...(resetsAt ? { resetsAt } : {}) });
  }
  if (windows.length) {
    try {
      const out = join(dir, "statusline");
      mkdirSync(out, { recursive: true, mode: 0o700 });
      const session = typeof input.session_id === "string" ? input.session_id : "session";
      const name = `${session.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.json`;
      const tmp = join(out, `.${name}.${process.pid}.tmp`);
      const configDir = process.env.CLAUDE_CONFIG_DIR || undefined;
      writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), sessionId: session, ...(configDir ? { configDir } : {}), windows }), { mode: 0o600 });
      renameSync(tmp, join(out, name));
    } catch {
      // The status line must never fail because of FrontFlow.
    }
  }
  let chained;
  try {
    chained = JSON.parse(readFileSync(join(dir, "statusline-chain.json"), "utf8")).command;
  } catch {
    chained = undefined;
  }
  if (typeof chained === "string" && chained.trim()) {
    process.stdout.write(await runChained(chained, raw));
    return;
  }
  process.stdout.write(windows.map((w) => `${w.label} ${Math.round(w.utilization)}%`).join(" · "));
}

/** The user's own status line, run the way Claude Code runs it (its shell), with a time limit. */
function runChained(command, input) {
  return new Promise((resolve) => {
    const shell = process.env.SHELL;
    const child = shell ? spawn(shell, ["-c", command], { stdio: ["pipe", "pipe", "ignore"] }) : spawn(command, { shell: true, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(""));
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "statusline") return statusLine();
  let reply = await send(argv);
  if (reply.login) {
    console.log(reply.output);
    const finished = await runLogin(reply.login);
    reply = await send(["__finish-login", reply.login.loginId, ...(finished ? [] : ["--cancel"])]);
  }
  (reply.ok ? console.log : console.error)(reply.output);
  process.exitCode = reply.ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
