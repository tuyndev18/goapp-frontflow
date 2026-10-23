import { request } from "node:http";

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => any;
}

/** Raw HTTP POST (node:http lets tests forge the Host header, which fetch does not). */
export function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<RawResponse> {
  const target = new URL(url);
  const data = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json: () => JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

/** Minimal MCP client over the HTTP transport. */
export class TestMcpClient {
  sessionId: string | undefined;
  private nextId = 1;

  constructor(
    readonly url: string,
    readonly token: string,
  ) {}

  async initialize(): Promise<any> {
    const res = await this.raw({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    this.sessionId = res.headers["mcp-session-id"] as string | undefined;
    await this.raw({ jsonrpc: "2.0", method: "notifications/initialized" });
    return res.json();
  }

  async rpc(method: string, params?: unknown): Promise<any> {
    const res = await this.raw({ jsonrpc: "2.0", id: this.nextId++, method, params });
    return res.json();
  }

  callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    return this.rpc("tools/call", { name, arguments: args });
  }

  raw(message: unknown, extraHeaders: Record<string, string> = {}): Promise<RawResponse> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, ...extraHeaders };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return post(this.url, message, headers);
  }
}

export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
