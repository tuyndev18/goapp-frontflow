/**
 * stdio ⇄ Streamable HTTP proxy for AI CLIs that only speak MCP over stdio.
 * Reads newline-delimited JSON-RPC from stdin, POSTs each message to the bridge and writes the
 * JSON responses to stdout. Credentials come from the environment, never argv (§9.3):
 *   FRONTFLOW_BRIDGE_URL   e.g. http://127.0.0.1:47616/mcp
 *   FRONTFLOW_BRIDGE_TOKEN bearer token minted for this CLI session
 *
 * Self-contained (node built-ins only) so it runs directly: node --experimental-strip-types stdio-proxy.ts
 */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export interface StdioProxyOptions {
  fetch?: typeof fetch;
  stderr?: NodeJS.WritableStream;
}

type JsonRpcId = string | number | null;

const PROXY_ERROR = -32000;

export async function runStdioProxy(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  env: Record<string, string | undefined>,
  options: StdioProxyOptions = {},
): Promise<void> {
  const url = env.FRONTFLOW_BRIDGE_URL;
  const token = env.FRONTFLOW_BRIDGE_TOKEN;
  if (!url || !token) throw new Error("FRONTFLOW_BRIDGE_URL and FRONTFLOW_BRIDGE_TOKEN must be set");
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("FRONTFLOW_BRIDGE_URL must be http(s)");
  const doFetch = options.fetch ?? fetch;
  const stderr = options.stderr ?? process.stderr;

  let mcpSessionId: string | undefined;
  let protocolVersion: string | undefined;
  let ready: Promise<void> = Promise.resolve();
  const inflight = new Set<Promise<void>>();

  const write = (message: unknown): void => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };
  const failAll = (ids: JsonRpcId[], message: string): void => {
    for (const id of ids) write({ jsonrpc: "2.0", id, error: { code: PROXY_ERROR, message } });
  };

  const forward = async (body: string, message: unknown, isInit: boolean): Promise<void> => {
    const ids = requestIds(message);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (mcpSessionId && !isInit) headers["Mcp-Session-Id"] = mcpSessionId;
    if (protocolVersion && !isInit) headers["MCP-Protocol-Version"] = protocolVersion;
    let res: Response;
    try {
      res = await doFetch(parsedUrl, { method: "POST", headers, body });
    } catch {
      failAll(ids, "FrontFlow Figma bridge is unreachable");
      return;
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) mcpSessionId = sid;
    if (res.status === 202) return;
    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    const payloads = contentType.includes("text/event-stream") ? sseData(text) : [text];
    let wrote = false;
    for (const payload of payloads) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (isInit) protocolVersion = negotiatedVersion(parsed) ?? protocolVersion;
      if (isJsonRpc(parsed)) {
        if (isRecord(parsed) && parsed.id === null && ids.length === 1) parsed.id = ids[0] ?? null;
        write(parsed);
        wrote = true;
      }
    }
    if (!wrote && !res.ok) {
      if (res.status === 404) mcpSessionId = undefined;
      failAll(ids, `FrontFlow Figma bridge returned HTTP ${res.status}`);
      stderr.write(`frontflow stdio proxy: HTTP ${res.status}\n`);
    }
  };

  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    const isInit = hasMethod(message, "initialize");
    const task = (isInit ? Promise.resolve() : ready).then(() => forward(trimmed, message, isInit));
    if (isInit) ready = task.catch(() => undefined);
    inflight.add(task);
    void task.finally(() => inflight.delete(task)).catch(() => undefined);
  }
  await Promise.allSettled([...inflight]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMethod(message: unknown, method: string): boolean {
  const list = Array.isArray(message) ? message : [message];
  return list.some((m) => isRecord(m) && m.method === method);
}

function requestIds(message: unknown): JsonRpcId[] {
  const list = Array.isArray(message) ? message : [message];
  const ids: JsonRpcId[] = [];
  for (const m of list) {
    if (isRecord(m) && typeof m.method === "string" && "id" in m) {
      ids.push(typeof m.id === "string" || typeof m.id === "number" ? m.id : null);
    }
  }
  return ids;
}

function isJsonRpc(value: unknown): boolean {
  if (Array.isArray(value)) return value.every((v) => isRecord(v) && v.jsonrpc === "2.0");
  return isRecord(value) && value.jsonrpc === "2.0";
}

function negotiatedVersion(value: unknown): string | undefined {
  const list = Array.isArray(value) ? value : [value];
  for (const v of list) {
    if (isRecord(v) && isRecord(v.result) && typeof v.result.protocolVersion === "string") return v.result.protocolVersion;
  }
  return undefined;
}

function sseData(text: string): string[] {
  const out: string[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (data) out.push(data);
  }
  return out;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runStdioProxy(process.stdin, process.stdout, process.env).catch((err: unknown) => {
    process.stderr.write(`frontflow stdio proxy: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
