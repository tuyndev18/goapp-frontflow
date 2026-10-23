import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { newId } from "@frontflow/domain";
import { PairingError, type PairingManager, type PairingScope } from "./pairing.js";
import {
  CLOSE_CODES,
  PLUGIN_EVENTS,
  PLUGIN_PROTOCOL_VERSION,
  isRecord,
  parseHello,
  toNodeRefs,
  type GatewayToPluginMessage,
  type WelcomeMessage,
} from "./protocol.js";
import { assertBindHost } from "./secrets.js";
import type { NodeRef } from "./types.js";

export const DEFAULT_WS_PORT = 47615;
export const APP_NAME = "GoApp FrontFlow";

/**
 * Figma plugin UIs run in an iframe whose Origin is "null" (desktop / data: URL) or figma.com.
 * Non-browser clients send no Origin. Any other browser origin is refused so random web pages
 * cannot reach the bridge; the pairing code remains the actual authentication.
 */
export const DEFAULT_ALLOWED_ORIGINS = ["null", "https://www.figma.com", "https://figma.com"];

export interface PluginGatewayOptions {
  pairing: PairingManager;
  host?: string;
  port?: number;
  allowNonLocal?: boolean;
  allowedOrigins?: string[];
  requestTimeoutMs?: number;
  heartbeatMs?: number;
  handshakeTimeoutMs?: number;
  maxPayloadBytes?: number;
  appName?: string;
  sessionLabel?: (scope: PairingScope) => string;
}

export interface PluginConnectionInfo {
  connectionId: string;
  connected: boolean;
  fileKey: string;
  fileName: string;
  pageId?: string;
  selection: NodeRef[];
  pluginName: string;
  pluginVersion: string;
  connectedAt: string;
  lastSeenAt: string;
  scope: PairingScope;
  fileVersion: string;
}

export interface GatewayStatus {
  listening: boolean;
  host: string;
  port: number | null;
  connected: boolean;
  connections: PluginConnectionInfo[];
}

export type GatewayStatusListener = (status: GatewayStatus) => void;

export type GatewayEvent =
  | { type: "connected"; connection: PluginConnectionInfo }
  | { type: "disconnected"; connectionId: string; fileKey: string; reason: string }
  | { type: "selection.changed"; connectionId: string; fileKey: string; selection: NodeRef[] }
  | { type: "file.changed"; connectionId: string; fileKey: string; fileVersion: string };

export type PluginRpcErrorCode = "not_connected" | "timeout" | "disconnected" | "plugin_error" | "send_failed";

export class PluginRpcError extends Error {
  constructor(
    readonly code: PluginRpcErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "PluginRpcError";
  }
}

export interface PluginRequestOptions {
  connectionId?: string;
  fileKey?: string;
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Connection {
  id: string;
  ws: WebSocket;
  scope: PairingScope;
  pluginName: string;
  pluginVersion: string;
  fileKey: string;
  fileName: string;
  pageId?: string;
  selection: NodeRef[];
  connectedAt: number;
  lastSeenAt: number;
  alive: boolean;
  fileRevision: number;
  fileVersionTag?: string;
  pending: Map<string, Pending>;
}

/** WebSocket endpoint the GoApp Figma plugin connects to (§13.1, §22.4). */
export class PluginGateway {
  readonly host: string;
  private readonly port: number;
  private readonly opts: Required<
    Pick<PluginGatewayOptions, "requestTimeoutMs" | "heartbeatMs" | "handshakeTimeoutMs" | "maxPayloadBytes" | "appName">
  >;
  private readonly allowedOrigins: Set<string>;
  private readonly connections = new Map<string, Connection>();
  private readonly statusListeners = new Set<GatewayStatusListener>();
  private readonly eventListeners = new Set<(event: GatewayEvent) => void>();
  private wss: WebSocketServer | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private boundPort: number | null = null;
  private seq = 0;
  private unsubscribeRevoke: (() => void) | undefined;

  constructor(private readonly options: PluginGatewayOptions) {
    this.host = options.host ?? "127.0.0.1";
    assertBindHost(this.host, options.allowNonLocal, "PluginGateway");
    this.port = options.port ?? DEFAULT_WS_PORT;
    this.allowedOrigins = new Set((options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS).map((o) => o.toLowerCase()));
    this.opts = {
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
      heartbeatMs: options.heartbeatMs ?? 15_000,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
      maxPayloadBytes: options.maxPayloadBytes ?? 32 * 1024 * 1024,
      appName: options.appName ?? APP_NAME,
    };
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
    if (this.wss) throw new Error("PluginGateway already started");
    const wss = new WebSocketServer({
      host: this.host,
      port: this.port,
      maxPayload: this.opts.maxPayloadBytes,
      verifyClient: (info, done) => {
        if (this.isOriginAllowed(info.origin)) done(true);
        else done(false, 403, "Origin not allowed");
      },
    });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    this.wss = wss;
    this.unsubscribeRevoke = this.options.pairing.onRevoked((id, reason) => this.closeRevoked(id, reason));
    this.boundPort = (wss.address() as AddressInfo).port;
    wss.on("connection", (ws) => this.onSocket(ws));
    this.heartbeat = setInterval(() => this.tickHeartbeat(), this.opts.heartbeatMs);
    this.heartbeat.unref();
    this.emitStatus();
    return { host: this.host, port: this.boundPort, url: this.url };
  }

  get url(): string {
    const host = this.host.includes(":") ? `[${this.host}]` : this.host;
    return `ws://${host}:${this.boundPort ?? this.port}`;
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const conn of [...this.connections.values()]) this.dropConnection(conn, "Bridge shutting down", CLOSE_CODES.shutdown);
    const wss = this.wss;
    this.wss = undefined;
    this.boundPort = null;
    if (wss) {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
    this.unsubscribeRevoke?.();
    this.unsubscribeRevoke = undefined;
    this.emitStatus();
  }

  status(): GatewayStatus {
    const connections = [...this.connections.values()].map((c) => this.info(c));
    return {
      listening: this.wss !== undefined,
      host: this.host,
      port: this.boundPort,
      connected: connections.length > 0,
      connections,
    };
  }

  connection(options: { connectionId?: string; fileKey?: string } = {}): PluginConnectionInfo | undefined {
    const conn = this.pick(options);
    return conn ? this.info(conn) : undefined;
  }

  subscribe(listener: GatewayStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onEvent(listener: (event: GatewayEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Revokes a live connection: the plugin receives a `revoked` message and the socket is closed. */
  revoke(connectionId: string, reason = "Revoked by user"): boolean {
    return this.options.pairing.revoke(connectionId, reason);
  }

  request<T = unknown>(method: string, params: unknown, options: PluginRequestOptions = {}): Promise<T> {
    const conn = this.pick(options);
    if (!conn) {
      const which = options.fileKey ? ` for file ${options.fileKey}` : "";
      return Promise.reject(new PluginRpcError("not_connected", `Figma plugin is not connected${which}`));
    }
    const id = `r${++this.seq}`;
    const timeoutMs = options.timeoutMs ?? this.opts.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new PluginRpcError("timeout", `Figma plugin did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      conn.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send(conn.ws, { type: "request", id, method, params: params ?? {} }, (err) => {
        if (!err) return;
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(new PluginRpcError("send_failed", `Failed to send ${method} to plugin`));
      });
    });
  }

  private isOriginAllowed(origin: string | undefined): boolean {
    if (origin === undefined || origin === "") return true;
    return this.allowedOrigins.has(origin.toLowerCase());
  }

  private onSocket(ws: WebSocket): void {
    let connection: Connection | undefined;
    const handshakeTimer = setTimeout(() => {
      this.rejectHandshake(ws, "handshake_timeout", "No hello received in time");
    }, this.opts.handshakeTimeoutMs);
    handshakeTimer.unref();

    ws.on("message", (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        ws.close(CLOSE_CODES.protocolError, "Binary frames are not supported");
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(rawToString(raw));
      } catch {
        ws.close(CLOSE_CODES.protocolError, "Invalid JSON");
        return;
      }
      if (!connection) {
        clearTimeout(handshakeTimer);
        connection = this.handshake(ws, msg);
        return;
      }
      connection.lastSeenAt = Date.now();
      connection.alive = true;
      this.onMessage(connection, msg);
    });
    ws.on("pong", () => {
      if (connection) {
        connection.alive = true;
        connection.lastSeenAt = Date.now();
      }
    });
    ws.on("close", (code, reason) => {
      clearTimeout(handshakeTimer);
      if (connection && this.connections.get(connection.id) === connection) {
        this.dropConnection(connection, reason.toString() || `Socket closed (${code})`);
      }
    });
    ws.on("error", () => {
      // 'close' follows; nothing else to do.
    });
  }

  private handshake(ws: WebSocket, msg: unknown): Connection | undefined {
    const hello = parseHello(msg);
    if (!hello) {
      this.rejectHandshake(ws, "bad_hello", "First message must be a valid hello");
      return undefined;
    }
    let consumed: { pairingId: string; scope: PairingScope };
    try {
      consumed = this.options.pairing.consume(hello.pairingCode);
    } catch (err) {
      const code = err instanceof PairingError ? `pairing_${err.code}` : "pairing_failed";
      this.rejectHandshake(ws, code, err instanceof Error ? err.message : "Pairing failed");
      return undefined;
    }
    const now = Date.now();
    const conn: Connection = {
      id: newId("figconn"),
      ws,
      scope: consumed.scope,
      pluginName: hello.plugin.name,
      pluginVersion: hello.plugin.version,
      fileKey: hello.file.fileKey,
      fileName: hello.file.fileName,
      selection: [],
      connectedAt: now,
      lastSeenAt: now,
      alive: true,
      fileRevision: 0,
      pending: new Map(),
    };
    if (hello.file.pageId) conn.pageId = hello.file.pageId;
    this.options.pairing.attachConnection(consumed.pairingId, conn.id, {
      fileKey: conn.fileKey,
      pluginVersion: conn.pluginVersion,
    });
    this.connections.set(conn.id, conn);
    const welcome: WelcomeMessage = {
      type: "welcome",
      protocolVersion: PLUGIN_PROTOCOL_VERSION,
      connectionId: conn.id,
      app: { name: this.opts.appName, sessionLabel: this.sessionLabel(conn.scope) },
      scope: { ...conn.scope },
      heartbeatMs: this.opts.heartbeatMs,
    };
    this.send(ws, welcome);
    this.emitEvent({ type: "connected", connection: this.info(conn) });
    this.emitStatus();
    return conn;
  }

  private onMessage(conn: Connection, msg: unknown): void {
    if (!isRecord(msg)) return;
    if (msg.type === "response" && typeof msg.id === "string") {
      const pending = conn.pending.get(msg.id);
      if (!pending) return;
      conn.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (isRecord(msg.error)) {
        const message = typeof msg.error.message === "string" ? msg.error.message : "Plugin error";
        pending.reject(new PluginRpcError("plugin_error", message, msg.error));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (msg.type === "event" && isRecord(msg.data)) {
      if (msg.name === PLUGIN_EVENTS.selectionChanged) {
        conn.selection = toNodeRefs(msg.data.selection);
        if (typeof msg.data.pageId === "string") conn.pageId = msg.data.pageId;
        this.emitEvent({ type: "selection.changed", connectionId: conn.id, fileKey: conn.fileKey, selection: conn.selection });
        this.emitStatus();
      } else if (msg.name === PLUGIN_EVENTS.fileChanged) {
        conn.fileRevision += 1;
        if (typeof msg.data.version === "string") conn.fileVersionTag = msg.data.version;
        if (typeof msg.data.fileName === "string") conn.fileName = msg.data.fileName;
        if (typeof msg.data.pageId === "string") conn.pageId = msg.data.pageId;
        this.emitEvent({ type: "file.changed", connectionId: conn.id, fileKey: conn.fileKey, fileVersion: fileVersion(conn) });
        this.emitStatus();
      }
    }
  }

  private closeRevoked(connectionId: string, reason: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    this.send(conn.ws, { type: "revoked", reason });
    this.dropConnection(conn, `revoked: ${reason}`, CLOSE_CODES.revoked);
  }

  private dropConnection(conn: Connection, reason: string, closeCode?: number): void {
    if (this.connections.get(conn.id) !== conn) return;
    this.connections.delete(conn.id);
    this.options.pairing.detachConnection(conn.id);
    for (const [id, pending] of conn.pending) {
      clearTimeout(pending.timer);
      pending.reject(new PluginRpcError("disconnected", "Figma plugin disconnected"));
      conn.pending.delete(id);
    }
    if (closeCode !== undefined && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.close(closeCode, truncateReason(reason));
    }
    this.emitEvent({ type: "disconnected", connectionId: conn.id, fileKey: conn.fileKey, reason });
    this.emitStatus();
  }

  private rejectHandshake(ws: WebSocket, code: string, message: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    this.send(ws, { type: "error", code, message });
    ws.close(CLOSE_CODES.handshakeFailed, truncateReason(code));
  }

  private tickHeartbeat(): void {
    for (const conn of [...this.connections.values()]) {
      if (!conn.alive) {
        this.dropConnection(conn, "Heartbeat timeout");
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        // close handler cleans up
      }
    }
  }

  private pick(options: { connectionId?: string; fileKey?: string }): Connection | undefined {
    if (options.connectionId) return this.connections.get(options.connectionId);
    let best: Connection | undefined;
    for (const conn of this.connections.values()) {
      if (options.fileKey && conn.fileKey !== options.fileKey) continue;
      if (!best || conn.connectedAt >= best.connectedAt) best = conn;
    }
    return best;
  }

  private sessionLabel(scope: PairingScope): string {
    if (this.options.sessionLabel) return this.options.sessionLabel(scope);
    return scope.workflowRunId ? `Project ${scope.projectId} · run ${scope.workflowRunId}` : `Project ${scope.projectId}`;
  }

  private info(conn: Connection): PluginConnectionInfo {
    const info: PluginConnectionInfo = {
      connectionId: conn.id,
      connected: conn.ws.readyState === WebSocket.OPEN,
      fileKey: conn.fileKey,
      fileName: conn.fileName,
      selection: conn.selection.map((s) => ({ ...s })),
      pluginName: conn.pluginName,
      pluginVersion: conn.pluginVersion,
      connectedAt: new Date(conn.connectedAt).toISOString(),
      lastSeenAt: new Date(conn.lastSeenAt).toISOString(),
      scope: { ...conn.scope },
      fileVersion: fileVersion(conn),
    };
    if (conn.pageId) info.pageId = conn.pageId;
    return info;
  }

  private send(ws: WebSocket, msg: GatewayToPluginMessage, cb?: (err?: Error) => void): void {
    if (ws.readyState !== WebSocket.OPEN) {
      cb?.(new Error("socket not open"));
      return;
    }
    ws.send(JSON.stringify(msg), cb);
  }

  private emitStatus(): void {
    if (this.statusListeners.size === 0) return;
    const status = this.status();
    for (const listener of this.statusListeners) listener(status);
  }

  private emitEvent(event: GatewayEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }
}

function fileVersion(conn: Connection): string {
  return `${conn.id}:${conn.fileRevision}${conn.fileVersionTag ? `:${conn.fileVersionTag}` : ""}`;
}

function rawToString(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return raw.toString("utf8");
}

/** WebSocket close reasons are limited to 123 bytes. */
function truncateReason(reason: string): string {
  let out = reason;
  while (Buffer.byteLength(out, "utf8") > 123) out = out.slice(0, -1);
  return out;
}
