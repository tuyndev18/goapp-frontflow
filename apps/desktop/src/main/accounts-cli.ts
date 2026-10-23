import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { runAccountsCommand, type AccountsCommandContext } from "./accounts-commands.js";

const MAX_REQUEST = 64 * 1024;

/**
 * Where the `ffswap` CLI reaches the running app (bin/ffswap.mjs computes the same paths).
 * Logins live in the app's safeStorage vault, so commands run here, not in the CLI.
 */
export function accountsCliEndpoint(): { socket: string; tokenFile: string } {
  const dir = join(homedir(), ".frontflow");
  const socket =
    process.env["FRONTFLOW_ACCOUNTS_SOCKET"] ?? (process.platform === "win32" ? `\\\\.\\pipe\\frontflow-accounts-${userInfo().username}` : join(dir, "accounts.sock"));
  return { socket, tokenFile: join(dir, "cli-token") };
}

/**
 * One JSON line in (`{ token, argv }`), one JSON line out (a CommandResult). The token file is
 * readable by this user only, so another local user cannot drive the accounts through the socket.
 */
export function startAccountsCliServer(ctx: AccountsCommandContext): { close(): void } {
  const { socket, tokenFile } = accountsCliEndpoint();
  const token = randomBytes(32).toString("hex");
  mkdirSync(join(homedir(), ".frontflow"), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile, token, { mode: 0o600 });

  const server: Server = createServer((conn) => {
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("error", () => undefined);
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST) return conn.destroy();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = "";
      void answer(line).then((reply) => conn.end(`${JSON.stringify(reply)}\n`));
    });
  });

  async function answer(line: string) {
    let request: { token?: unknown; argv?: unknown };
    try {
      request = JSON.parse(line) as typeof request;
    } catch {
      return { ok: false, output: "Bad request" };
    }
    const given = Buffer.from(typeof request.token === "string" ? request.token : "");
    if (given.length !== token.length || !timingSafeEqual(given, Buffer.from(token))) return { ok: false, output: "Not authorized: run ffswap as the user running FrontFlow" };
    const argv = Array.isArray(request.argv) ? request.argv.filter((a): a is string => typeof a === "string") : [];
    return runAccountsCommand(argv, ctx, "cli");
  }

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE" || process.platform === "win32") {
      console.warn("[accounts] ffswap socket unavailable:", err.message);
      return;
    }
    // A socket file left by a crashed app: reuse it unless another FrontFlow answers on it.
    const probe = createConnection(socket);
    probe.on("connect", () => {
      probe.destroy();
      console.warn("[accounts] another FrontFlow already serves ffswap");
    });
    probe.on("error", () => {
      rmSync(socket, { force: true });
      server.listen(socket);
    });
  });
  server.listen(socket);

  return {
    close() {
      server.close();
      rmSync(tokenFile, { force: true });
    },
  };
}
