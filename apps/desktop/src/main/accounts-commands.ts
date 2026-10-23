import type { AccountDto, AccountsStateDto } from "../shared/ipc.js";
import type { IpcHandlers } from "./ipc-gateway.js";

/**
 * claude-swap (`cswap`) style commands for the Accounts service, shared by the `ffswap` CLI
 * (through the app's local socket) and the command box of the Accounts screen. Slots are the
 * order accounts were saved in, as on the screen, so `switch 2` means the same everywhere.
 */
export interface AccountsCommandContext {
  handlers: Pick<IpcHandlers, "accounts:state" | "accounts:captureCurrent" | "accounts:startLogin" | "accounts:switch" | "accounts:remove" | "accounts:rename" | "accounts:refresh">;
  /** CLI only: the CLI itself runs `claude auth login` with these, then sends `__finish-login`. */
  beginExternalLogin?(method: "claudeai" | "sso", label?: string): { loginId: string; dir: string; args: string[] };
  finishExternalLogin?(loginId: string, cancelled: boolean): Promise<{ status: string; accountId?: string; message?: string }>;
}

export interface CommandResult {
  ok: boolean;
  /** Human output (or the JSON document with --json). */
  output: string;
  /** CLI only: run `claude <args>` with CLAUDE_CONFIG_DIR=dir, then send `__finish-login <loginId>`. */
  login?: { loginId: string; dir: string; args: string[] };
}

export const ACCOUNTS_HELP = `ffswap — Claude Code accounts of this computer (same commands as claude-swap)

  ffswap list [--json]                         accounts with 5h / 7d quota
  ffswap status [--json]                       the account \`claude\` uses now
  ffswap switch [NUM|EMAIL|ALIAS] [--strategy best|next-available] [--json]
                                               no target: rotate to the next account
  ffswap add [--alias NAME]                    save the login \`claude\` uses now
  ffswap add --login [--sso] [--alias NAME]    log in to another account (current login untouched)
  ffswap remove NUM|EMAIL|ALIAS
  ffswap alias                                 list aliases
  ffswap alias NUM|EMAIL NAME | --unset        set or clear an alias
  ffswap refresh [NUM|EMAIL|ALIAS]             check quota now
  ffswap help

FrontFlow must be running: the logins live in its encrypted vault.`;

const SCHEMA_VERSION = 1;

/** Shown to the user as is; kept free of Electron so the commands are testable in plain Node. */
class CommandError extends Error {}

/** Splits a command line like a shell would for plain words and "quoted strings". */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  // The command box accepts the program name too: "ffswap list" = "list".
  if (out[0] === "ffswap" || out[0] === "cswap") out.shift();
  return out;
}

export async function runAccountsCommand(argv: string[], ctx: AccountsCommandContext, from: "cli" | "ui"): Promise<CommandResult> {
  const { flags, args } = parseArgs(argv);
  const json = flags.has("json");
  const [command = "help", ...rest] = args;
  try {
    switch (command) {
      case "help":
      case "--help":
        return ok(ACCOUNTS_HELP);

      case "list": {
        const state = await loadState(ctx);
        const accounts = slots(state);
        if (json) return ok(JSON.stringify({ schemaVersion: SCHEMA_VERSION, accounts: accounts.map((a, i) => accountJson(a, i + 1)) }));
        return ok(accounts.length ? listText(accounts) : "No accounts yet. Log in with `claude`, then run `ffswap add` (or `ffswap add --login`).");
      }

      case "status": {
        const state = await loadState(ctx);
        const accounts = slots(state);
        const index = accounts.findIndex((a) => a.active);
        if (json) return ok(JSON.stringify({ schemaVersion: SCHEMA_VERSION, loggedIn: state.live.loggedIn, ...(state.live.email ? { email: state.live.email } : {}), active: index >= 0 ? accountJson(accounts[index]!, index + 1) : null }));
        if (!state.live.loggedIn) return ok("Not logged in to Claude Code.");
        return ok(index >= 0 ? `Active: ${slotLine(accounts[index]!, index + 1)}` : `Logged in as ${state.live.email ?? "an unsaved account"} (not saved — run \`ffswap add\`).`);
      }

      case "switch": {
        const state = await loadState(ctx);
        const accounts = slots(state);
        const strategy = flags.get("strategy");
        const target = rest[0] ? requireTarget(accounts, rest[0]) : pick(accounts, strategy === "best" ? "best" : "next");
        if (!target) throw new CommandError("No other account is available to switch to");
        if (target.active) return ok(json ? JSON.stringify({ schemaVersion: SCHEMA_VERSION, switched: false, account: accountJson(target, accounts.indexOf(target) + 1) }) : `Already using ${name(target)}.`);
        if (target.status === "needs_login") throw new CommandError(`${name(target)} must log in again: ffswap add --login`);
        const result = await ctx.handlers["accounts:switch"]({ accountId: target.id });
        if (json) return ok(JSON.stringify({ schemaVersion: SCHEMA_VERSION, switched: true, account: accountJson(target, accounts.indexOf(target) + 1), warnings: result.warnings }));
        return ok([`Switched to ${slotLine(target, accounts.indexOf(target) + 1)}`, ...result.warnings].join("\n"));
      }

      case "add": {
        const alias = flags.get("alias");
        const label = typeof alias === "string" ? alias : undefined;
        if (flags.has("login")) {
          const method = flags.has("sso") ? "sso" : "claudeai";
          if (from === "cli") {
            if (!ctx.beginExternalLogin) throw new CommandError("Login from the command line is not available");
            const login = ctx.beginExternalLogin(method, label);
            return { ok: true, output: "Opening the Claude login (a separate folder: the current login keeps working)…", login };
          }
          await ctx.handlers["accounts:startLogin"]({ method, ...(label ? { label } : {}), cols: 110, rows: 28 });
          return ok("Login started: finish it in the terminal below (or in your browser).");
        }
        const account = await ctx.handlers["accounts:captureCurrent"](label ? { label } : {});
        return ok(json ? JSON.stringify({ schemaVersion: SCHEMA_VERSION, account: accountJson(account, 0) }) : `Saved ${name(account)}.`);
      }

      case "remove": {
        const accounts = slots(await loadState(ctx));
        const target = requireTarget(accounts, rest[0]);
        await ctx.handlers["accounts:remove"]({ accountId: target.id });
        return ok(`Removed ${name(target)}.`);
      }

      case "alias": {
        const accounts = slots(await loadState(ctx));
        if (!rest[0]) return ok(accounts.map((a, i) => `${i + 1}  ${a.label ?? "-"}  ${a.email ?? a.id.slice(0, 8)}`).join("\n") || "No accounts yet.");
        const target = requireTarget(accounts, rest[0]);
        const label = flags.has("unset") ? "" : rest[1];
        if (label === undefined) throw new CommandError("Usage: ffswap alias NUM|EMAIL NAME  (or --unset)");
        await ctx.handlers["accounts:rename"]({ accountId: target.id, label });
        return ok(label ? `${target.email ?? target.id.slice(0, 8)} is now "${label}".` : `Alias of ${target.email ?? target.id.slice(0, 8)} cleared.`);
      }

      case "refresh": {
        const accounts = slots(await loadState(ctx));
        const target = rest[0] ? requireTarget(accounts, rest[0]) : undefined;
        await ctx.handlers["accounts:refresh"](target ? { accountId: target.id } : {});
        return ok(listText(slots(await loadState(ctx))));
      }

      case "__finish-login": {
        if (from !== "cli" || !ctx.finishExternalLogin || !rest[0]) throw new CommandError("Unknown command");
        const result = await ctx.finishExternalLogin(rest[0], flags.has("cancel"));
        if (result.status !== "succeeded") return { ok: false, output: result.status === "cancelled" ? "Login cancelled." : `Login not added: ${result.message ?? "unknown error"}` };
        const accounts = slots(await loadState(ctx));
        const added = accounts.find((a) => a.id === result.accountId);
        return ok(added ? `Saved ${slotLine(added, accounts.indexOf(added) + 1)}. Switch with: ffswap switch ${accounts.indexOf(added) + 1}` : "Login saved.");
      }

      default:
        throw new CommandError(`Unknown command "${command}". Run ffswap help.`);
    }
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

function ok(output: string): CommandResult {
  return { ok: true, output };
}

function parseArgs(argv: string[]): { flags: Map<string, string | true>; args: string[] } {
  const flags = new Map<string, string | true>();
  const args: string[] = [];
  const valued = new Set(["alias", "strategy"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      args.push(a);
      continue;
    }
    const [key, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    if (inline !== undefined) flags.set(key, inline);
    else if (valued.has(key) && argv[i + 1] !== undefined) flags.set(key, argv[++i]!);
    else flags.set(key, true);
  }
  return { flags, args };
}

async function loadState(ctx: AccountsCommandContext): Promise<AccountsStateDto> {
  const state = await ctx.handlers["accounts:state"]();
  if (!state.supported) throw new CommandError(state.unsupportedReason ?? "Accounts are not supported here");
  return state;
}

/** Slot order = the order accounts were saved, like the Accounts screen. */
function slots(state: AccountsStateDto): AccountDto[] {
  return [...state.accounts].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

function resolve(accounts: AccountDto[], ref: string): AccountDto | undefined {
  if (/^\d+$/.test(ref)) return accounts[Number(ref) - 1];
  const lower = ref.toLowerCase();
  return accounts.find((a) => a.email?.toLowerCase() === lower) ?? accounts.find((a) => a.label?.toLowerCase() === lower) ?? accounts.find((a) => a.id === ref);
}

function requireTarget(accounts: AccountDto[], ref: string | undefined): AccountDto {
  if (!ref) throw new CommandError("Name the account: its number, email or alias (see ffswap list)");
  const target = resolve(accounts, ref);
  if (!target) throw new CommandError(`No account "${ref}" (see ffswap list)`);
  return target;
}

/** Highest of the 5h / weekly windows: how close the account is to being blocked. */
function pressure(a: AccountDto): number {
  const windows = a.quota?.windows ?? [];
  return windows.length ? Math.max(...windows.map((w) => w.utilization)) : 50;
}

function usable(a: AccountDto): boolean {
  return a.status !== "needs_login" && pressure(a) < 100;
}

function pick(accounts: AccountDto[], strategy: "best" | "next"): AccountDto | undefined {
  const others = accounts.filter((a) => !a.active && usable(a));
  if (strategy === "best") return [...others].sort((a, b) => pressure(a) - pressure(b))[0];
  const current = accounts.findIndex((a) => a.active);
  // Rotate: the first usable account after the active one, wrapping around.
  for (let step = 1; step <= accounts.length; step++) {
    const candidate = accounts[(current + step + accounts.length) % accounts.length]!;
    if (!candidate.active && usable(candidate)) return candidate;
  }
  return undefined;
}

function name(a: AccountDto): string {
  return a.label ?? a.email ?? a.id.slice(0, 8);
}

function windowPct(a: AccountDto, key: string): string {
  const w = a.quota?.windows.find((x) => x.key === key);
  return w ? `${Math.round(w.utilization)}%` : "—";
}

function slotLine(a: AccountDto, slot: number): string {
  return `${slot} ${a.label ? `${a.label} (${a.email ?? a.id.slice(0, 8)})` : (a.email ?? a.id.slice(0, 8))}`;
}

function listText(accounts: AccountDto[]): string {
  const rows = accounts.map((a, i) => [a.active ? "*" : " ", String(i + 1), a.label ? `${a.label} (${a.email ?? a.id.slice(0, 8)})` : (a.email ?? a.id.slice(0, 8)), a.subscriptionType ?? "?", windowPct(a, "five_hour"), windowPct(a, "seven_day"), a.status === "needs_login" ? "login expired" : ""]);
  const header = [" ", "#", "account", "plan", "5h", "7d", ""];
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c]!.length)));
  return [header, ...rows].map((r) => r.map((cell, c) => cell.padEnd(widths[c]!)).join("  ").trimEnd()).join("\n");
}

function accountJson(a: AccountDto, slot: number) {
  return {
    ...(slot ? { slot } : {}),
    id: a.id,
    ...(a.email ? { email: a.email } : {}),
    ...(a.label ? { alias: a.label } : {}),
    ...(a.subscriptionType ? { plan: a.subscriptionType } : {}),
    active: a.active,
    status: a.status,
    usage: Object.fromEntries((a.quota?.windows ?? []).map((w) => [w.key, { pct: w.utilization, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) }])),
  };
}
