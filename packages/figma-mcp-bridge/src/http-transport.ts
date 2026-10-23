import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { newId } from "@frontflow/domain";
import {
  JSONRPC_ERRORS,
  SUPPORTED_PROTOCOL_VERSIONS,
  errorResponse,
  type McpServer,
  type McpSession,
} from "./mcp-server.js";
import { isRecord } from "./protocol.js";
import { assertBindHost, isLoopbackHost } from "./secrets.js";
import type { BridgeSession, BridgeSessionRegistry } from "./sessions.js";

export interface HttpTransportOptions {
  sessions: BridgeSessionRegistry;
  host?: string;
  port?: number;
  path?: string;
  allowNonLocal?: boolean;
  /** Browser origins allowed to call the endpoint. Default: none (CLIs send no Origin). */
  allowedOrigins?: string[];
  maxBodyBytes?: number;
}

export interface HttpTransportHandle {
  url: string;
  host: string;
  port: number;
  path: string;
  close(): Promise<void>;
}

interface TransportSession {
  bridgeSessionId: string;
  createdAt: number;
}

/**
 * Streamable-HTTP-compatible MCP endpoint (POST → application/json; no SSE stream).
 * Security: loopback bind, Host allow-list (DNS rebinding), Origin check, per-session bearer token.
 */
export async function startHttpTransport(server: McpServer, options: HttpTransportOptions): Promise<HttpTransportHandle> {
  const host = options.host ?? "127.0.0.1";
  assertBindHost(host, options.allowNonLocal, "MCP HTTP transport");
  const path = options.path ?? "/mcp";
  const maxBodyBytes = options.maxBodyBytes ?? 4 * 1024 * 1024;
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map((o) => o.toLowerCase()));
  const transportSessions = new Map<string, TransportSession>();
  let allowedHosts = new Set<string>();

  const httpServer = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, errorResponse(null, JSONRPC_ERRORS.internalError, "Internal error"));
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const hostHeader = (req.headers.host ?? "").toLowerCase();
    if (!allowedHosts.has(hostHeader)) return sendText(res, 403, "Forbidden host");
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin.toLowerCase())) return sendText(res, 403, "Forbidden origin");
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) return sendText(res, 404, "Not found");

    const bridgeSession = options.sessions.verify(bearer(req.headers.authorization));
    if (!bridgeSession) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="goapp-frontflow-figma"');
      return sendText(res, 401, "Unauthorized");
    }

    if (req.method === "DELETE") {
      const id = header(req, "mcp-session-id");
      const ts = id ? transportSessions.get(id) : undefined;
      if (!id || !ts || ts.bridgeSessionId !== bridgeSession.sessionId) return sendText(res, 404, "Unknown session");
      transportSessions.delete(id);
      res.writeHead(204).end();
      return;
    }
    if (req.method === "GET") {
      res.setHeader("Allow", "POST, DELETE");
      return sendText(res, 405, "SSE stream not supported");
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, DELETE");
      return sendText(res, 405, "Method not allowed");
    }
    const contentType = (req.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.includes("application/json")) return sendText(res, 415, "Content-Type must be application/json");
    const protocolVersion = header(req, "mcp-protocol-version");
    if (protocolVersion && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion)) {
      return sendJson(res, 400, errorResponse(null, JSONRPC_ERRORS.invalidRequest, "Unsupported MCP-Protocol-Version"));
    }

    let body: string;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch {
      res.setHeader("Connection", "close");
      return sendText(res, 413, "Payload too large");
    }
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return sendJson(res, 400, errorResponse(null, JSONRPC_ERRORS.parseError, "Parse error"));
    }

    const messages = Array.isArray(message) ? message : [message];
    const isInitialize = messages.some((m) => isRecord(m) && m.method === "initialize");
    let mcpSessionId = header(req, "mcp-session-id");
    if (isInitialize) {
      mcpSessionId = newId("mcps");
    } else if (!mcpSessionId) {
      return sendJson(res, 400, errorResponse(null, JSONRPC_ERRORS.invalidRequest, "Missing Mcp-Session-Id header"));
    } else {
      const ts = transportSessions.get(mcpSessionId);
      if (!ts || ts.bridgeSessionId !== bridgeSession.sessionId) {
        return sendJson(res, 404, errorResponse(null, JSONRPC_ERRORS.invalidRequest, "Unknown or expired MCP session"));
      }
    }

    const response = await server.handle(message, toMcpSession(bridgeSession, mcpSessionId));
    if (isInitialize && mcpSessionId) {
      const failed = !response || (Array.isArray(response) ? response.some((r) => "error" in r) : "error" in response);
      if (!failed) {
        transportSessions.set(mcpSessionId, { bridgeSessionId: bridgeSession.sessionId, createdAt: Date.now() });
        res.setHeader("Mcp-Session-Id", mcpSessionId);
      }
    }
    if (response === undefined) {
      res.writeHead(202).end();
      return;
    }
    sendJson(res, 200, response);
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 0, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const port = (httpServer.address() as AddressInfo).port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!isLoopbackHost(host)) allowedHosts.add(`${host.toLowerCase()}:${port}`);
  const urlHost = host.includes(":") ? `[${host}]` : host;

  return {
    url: `http://${urlHost}:${port}${path}`,
    host,
    port,
    path,
    close: () =>
      new Promise<void>((resolve) => {
        transportSessions.clear();
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      }),
  };
}

function toMcpSession(session: BridgeSession, mcpSessionId: string | undefined): McpSession {
  const out: McpSession = { sessionId: session.sessionId, projectId: session.projectId };
  if (mcpSessionId) out.mcpSessionId = mcpSessionId;
  if (session.workflowRunId) out.workflowRunId = session.workflowRunId;
  if (session.nodeRunId) out.nodeRunId = session.nodeRunId;
  if (session.scope) out.scope = session.scope;
  return out;
}

function bearer(value: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value ?? "");
  return match?.[1];
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      if (overflow) return;
      size += chunk.length;
      if (size > limit) {
        overflow = true;
        chunks.length = 0;
        reject(new Error("too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), "Cache-Control": "no-store" });
  res.end(data);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}
