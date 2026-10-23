import { fileURLToPath } from "node:url";

export type SupportedCli = "claude-code" | "codex" | "gemini";

export const BRIDGE_TOKEN_ENV = "FRONTFLOW_BRIDGE_TOKEN";
export const BRIDGE_URL_ENV = "FRONTFLOW_BRIDGE_URL";
export const DEFAULT_MCP_SERVER_NAME = "goapp-figma";
export const STDIO_PROXY_PATH = fileURLToPath(new URL("./stdio-proxy.ts", import.meta.url));

export interface CliSessionCredentials {
  url: string;
  token: string;
}

export interface CliMcpConfigOptions {
  serverName?: string;
  /** "http" (default) talks to the bridge directly; "stdio" launches the stdio proxy. */
  transport?: "http" | "stdio";
  /**
   * Inline the bearer token into the config instead of an env-var reference. Only for CLIs/versions
   * that cannot expand env vars: the secret then lands on disk, so the adapter must write the file
   * into a private per-run directory and delete it afterwards.
   */
  embedToken?: boolean;
  stdioProxyPath?: string;
  nodePath?: string;
}

export interface CliMcpConfig {
  cli: SupportedCli;
  serverName: string;
  transport: "http" | "stdio";
  format: "json" | "toml";
  /** Conventional location for the CLI (project-relative or under the CLI config home). */
  fileName: string;
  config: Record<string, unknown>;
  content: string;
  /** Variables the CLI adapter must inject into the CLI process environment (never argv, §9.3). */
  env: Record<string, string>;
  embedsSecret: boolean;
}

/**
 * Builds the MCP server entry for an AI CLI. By default the token is referenced through
 * FRONTFLOW_BRIDGE_TOKEN (Claude Code `${VAR}`, Gemini `$VAR` expansion, Codex `bearer_token_env_var`),
 * so the config file itself holds no secret and the token lives only in the CLI process env.
 */
export function buildCliMcpConfig(
  cli: SupportedCli,
  credentials: CliSessionCredentials,
  options: CliMcpConfigOptions = {},
): CliMcpConfig {
  const serverName = options.serverName ?? DEFAULT_MCP_SERVER_NAME;
  const transport = options.transport ?? "http";
  const embed = options.embedToken === true;
  const tokenRef = embed ? credentials.token : `\${${BRIDGE_TOKEN_ENV}}`;
  const env = { [BRIDGE_TOKEN_ENV]: credentials.token, [BRIDGE_URL_ENV]: credentials.url };
  const command = options.nodePath ?? "node";
  const args = ["--experimental-strip-types", "--no-warnings", options.stdioProxyPath ?? STDIO_PROXY_PATH];
  const stdioEnv = { [BRIDGE_TOKEN_ENV]: tokenRef, [BRIDGE_URL_ENV]: credentials.url };

  if (cli === "codex") {
    const entry: Record<string, unknown> =
      transport === "http"
        ? embed
          ? { url: credentials.url, http_headers: { Authorization: `Bearer ${credentials.token}` } }
          : { url: credentials.url, bearer_token_env_var: BRIDGE_TOKEN_ENV }
        : embed
          ? { command, args, env: { ...env } }
          : { command, args, env: { [BRIDGE_URL_ENV]: credentials.url }, env_vars: [BRIDGE_TOKEN_ENV] };
    return {
      cli,
      serverName,
      transport,
      format: "toml",
      fileName: ".codex/config.toml",
      config: { mcp_servers: { [serverName]: entry } },
      content: toToml(serverName, entry),
      env,
      embedsSecret: embed,
    };
  }

  if (cli === "gemini") {
    const entry: Record<string, unknown> =
      transport === "http"
        ? { httpUrl: credentials.url, headers: { Authorization: `Bearer ${tokenRef}` }, trust: false }
        : { command, args, env: stdioEnv, trust: false };
    const config = { mcpServers: { [serverName]: entry } };
    return {
      cli,
      serverName,
      transport,
      format: "json",
      fileName: ".gemini/settings.json",
      config,
      content: `${JSON.stringify(config, null, 2)}\n`,
      env,
      embedsSecret: embed,
    };
  }

  const entry: Record<string, unknown> =
    transport === "http"
      ? { type: "http", url: credentials.url, headers: { Authorization: `Bearer ${tokenRef}` } }
      : { type: "stdio", command, args, env: stdioEnv };
  const config = { mcpServers: { [serverName]: entry } };
  return {
    cli,
    serverName,
    transport,
    format: "json",
    fileName: ".mcp.json",
    config,
    content: `${JSON.stringify(config, null, 2)}\n`,
    env,
    embedsSecret: embed,
  };
}

/** MCP config that launches a local stdio server, e.g. GoApp Figma's `node <go-figma>/dist/mcp.mjs`. */
export function buildStdioServerMcpConfig(
  cli: SupportedCli,
  server: { command: string; args: string[] },
  serverName: string = DEFAULT_MCP_SERVER_NAME,
): CliMcpConfig {
  const base = { cli, serverName, transport: "stdio" as const, env: {}, embedsSecret: false };
  if (cli === "codex") {
    const entry = { command: server.command, args: server.args };
    return { ...base, format: "toml", fileName: ".codex/config.toml", config: { mcp_servers: { [serverName]: entry } }, content: toToml(serverName, entry) };
  }
  const entry = cli === "gemini" ? { command: server.command, args: server.args, trust: false } : { type: "stdio", command: server.command, args: server.args };
  const config = { mcpServers: { [serverName]: entry } };
  return {
    ...base,
    format: "json",
    fileName: cli === "gemini" ? ".gemini/settings.json" : ".mcp.json",
    config,
    content: `${JSON.stringify(config, null, 2)}\n`,
  };
}

function toToml(serverName: string, entry: Record<string, unknown>): string {
  const lines = [`[mcp_servers.${tomlKey(serverName)}]`];
  const tables: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      tables.push("", `[mcp_servers.${tomlKey(serverName)}.${tomlKey(key)}]`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) tables.push(`${tomlKey(k)} = ${tomlValue(v)}`);
    } else {
      lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
    }
  }
  return `${[...lines, ...tables].join("\n")}\n`;
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(String(value));
}
