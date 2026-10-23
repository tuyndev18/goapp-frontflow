import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileAssetWriter, type AssetWriter } from "./assets.js";
import { buildCliMcpConfig, type CliMcpConfig, type CliMcpConfigOptions, type SupportedCli } from "./cli-config.js";
import { GatewayFigmaSource, type FigmaSource } from "./figma-source.js";
import { DEFAULT_WS_PORT, PluginGateway, type GatewayStatus } from "./gateway.js";
import { startHttpTransport, type HttpTransportHandle } from "./http-transport.js";
import {
  McpServer,
  type AuthorizeFn,
  type McpSession,
  type RequestApprovalFn,
  type SnapshotSink,
  type ToolCallLogEntry,
} from "./mcp-server.js";
import {
  PairingManager,
  type CreatePairingInput,
  type PairedConnection,
  type PairingTicket,
  type PendingPairing,
} from "./pairing.js";
import { ScopeGuard } from "./scope-guard.js";
import { BridgeSessionRegistry, type BridgeSession, type MintSessionInput } from "./sessions.js";
import type { FigmaContextManifest, FigmaScope, NodeRef } from "./types.js";

export const DEFAULT_MCP_HTTP_PORT = 47616;

export interface FigmaBridgeOptions {
  host?: string;
  wsPort?: number;
  httpPort?: number;
  mcpPath?: string;
  allowNonLocal?: boolean;
  allowedPluginOrigins?: string[];
  authorize: AuthorizeFn;
  requestApproval?: RequestApprovalFn;
  snapshotSink?: SnapshotSink;
  onToolCall?: (entry: ToolCallLogEntry) => void;
  onStatus?: (status: BridgeStatus) => void;
  /** Root directory for export_assets output. Default: <tmp>/frontflow-figma-assets. */
  assetsDir?: string;
  assetWriter?: AssetWriter;
  cacheTtlMs?: number;
  requestTimeoutMs?: number;
  heartbeatMs?: number;
  sessionLabel?: (scope: { projectId: string; workflowRunId?: string }) => string;
}

export interface BridgeStatus {
  running: boolean;
  wsUrl: string | null;
  mcpUrl: string | null;
  plugin: GatewayStatus;
  boundScope: FigmaScope | null;
  pairedConnections: PairedConnection[];
  pendingPairings: PendingPairing[];
  cliSessions: BridgeSession[];
}

export interface CliSessionHandle {
  sessionId: string;
  token: string;
  url: string;
  expiresAt: string;
}

/** Facade owned by the desktop main process: plugin gateway + MCP server + HTTP transport. */
export class FigmaBridge {
  readonly pairing = new PairingManager();
  readonly sessions = new BridgeSessionRegistry();
  readonly guard = new ScopeGuard();
  readonly gateway: PluginGateway;
  readonly mcp: McpServer;
  private http: HttpTransportHandle | undefined;
  private boundScope: FigmaScope | undefined;
  private readonly sources = new Map<string, GatewayFigmaSource>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(private readonly options: FigmaBridgeOptions) {
    const gatewayOptions: ConstructorParameters<typeof PluginGateway>[0] = {
      pairing: this.pairing,
      host: options.host ?? "127.0.0.1",
      port: options.wsPort ?? DEFAULT_WS_PORT,
    };
    if (options.allowNonLocal !== undefined) gatewayOptions.allowNonLocal = options.allowNonLocal;
    if (options.allowedPluginOrigins) gatewayOptions.allowedOrigins = options.allowedPluginOrigins;
    if (options.requestTimeoutMs !== undefined) gatewayOptions.requestTimeoutMs = options.requestTimeoutMs;
    if (options.heartbeatMs !== undefined) gatewayOptions.heartbeatMs = options.heartbeatMs;
    if (options.sessionLabel) gatewayOptions.sessionLabel = options.sessionLabel;
    this.gateway = new PluginGateway(gatewayOptions);

    const mcpOptions: ConstructorParameters<typeof McpServer>[0] = {
      source: (session) => this.sourceFor(this.scopeFor(session)?.fileKey),
      scopeFor: (session) => this.scopeFor(session),
      authorize: options.authorize,
      scopeGuard: this.guard,
      assetWriter: options.assetWriter ?? createFileAssetWriter(options.assetsDir ?? join(tmpdir(), "frontflow-figma-assets")),
      manifest: (session) => this.buildManifest(this.scopeFor(session)),
    };
    if (options.requestApproval) mcpOptions.requestApproval = options.requestApproval;
    if (options.snapshotSink) mcpOptions.snapshotSink = options.snapshotSink;
    if (options.onToolCall) mcpOptions.onToolCall = options.onToolCall;
    if (options.cacheTtlMs !== undefined) mcpOptions.cacheTtlMs = options.cacheTtlMs;
    this.mcp = new McpServer(mcpOptions);

    this.unsubscribers.push(
      this.gateway.onEvent((event) => {
        if (event.type === "file.changed" || event.type === "disconnected") {
          this.mcp.invalidateCache(event.fileKey);
          this.guard.invalidate(event.fileKey);
        }
      }),
      this.gateway.subscribe(() => this.emitStatus()),
    );
  }

  async start(): Promise<{ wsUrl: string; mcpUrl: string }> {
    const ws = await this.gateway.start();
    try {
      const httpOptions: Parameters<typeof startHttpTransport>[1] = {
        sessions: this.sessions,
        host: this.options.host ?? "127.0.0.1",
        port: this.options.httpPort ?? DEFAULT_MCP_HTTP_PORT,
        path: this.options.mcpPath ?? "/mcp",
      };
      if (this.options.allowNonLocal !== undefined) httpOptions.allowNonLocal = this.options.allowNonLocal;
      this.http = await startHttpTransport(this.mcp, httpOptions);
    } catch (err) {
      await this.gateway.stop();
      throw err;
    }
    this.emitStatus();
    return { wsUrl: ws.url, mcpUrl: this.http.url };
  }

  async stop(): Promise<void> {
    const http = this.http;
    this.http = undefined;
    await Promise.all([http?.close(), this.gateway.stop()]);
    this.emitStatus();
  }

  createPairing(input: CreatePairingInput): PairingTicket {
    const ticket = this.pairing.createToken(input);
    this.emitStatus();
    return ticket;
  }

  /** Revokes a plugin connection, a pairing or an unused pairing code. */
  revoke(target: string, reason?: string): boolean {
    const ok = this.pairing.revoke(target, reason);
    this.emitStatus();
    return ok;
  }

  status(): BridgeStatus {
    return {
      running: this.http !== undefined,
      wsUrl: this.http ? this.gateway.url : null,
      mcpUrl: this.http?.url ?? null,
      plugin: this.gateway.status(),
      boundScope: this.boundScope ? { ...this.boundScope } : null,
      pairedConnections: this.pairing.listConnections(),
      pendingPairings: this.pairing.listPending(),
      cliSessions: this.sessions.list(),
    };
  }

  /** Default scope for CLI sessions minted without their own scope. `undefined` clears it. */
  bindScope(scope: FigmaScope | undefined): void {
    this.boundScope = scope ? { ...scope } : undefined;
    this.emitStatus();
  }

  mintCliSession(input: MintSessionInput): CliSessionHandle {
    if (!this.http) throw new Error("FigmaBridge is not started");
    const { session, token } = this.sessions.mint(input);
    this.emitStatus();
    return { sessionId: session.sessionId, token, url: this.http.url, expiresAt: session.expiresAt };
  }

  revokeCliSession(sessionIdOrToken: string): boolean {
    const ok = this.sessions.revoke(sessionIdOrToken);
    this.emitStatus();
    return ok;
  }

  mcpConfigFor(cli: SupportedCli, session: { url: string; token: string }, options?: CliMcpConfigOptions): CliMcpConfig {
    return buildCliMcpConfig(cli, session, options);
  }

  /** §13.3 context manifest: what the AI sees first instead of the whole document. */
  async buildManifest(scope?: FigmaScope): Promise<FigmaContextManifest> {
    const source = this.sourceFor(scope?.fileKey);
    const status = await source.getConnectionStatus();
    const manifest: FigmaContextManifest = {
      fileKey: status.fileKey ?? scope?.fileKey ?? null,
      pageId: scope?.pageIds?.[0] ?? status.pageId ?? null,
      selectedNodes: [],
      availableTools: this.mcp.listTools().map((t) => t.name),
    };
    if (status.fileName) manifest.fileName = status.fileName;
    const warnings: string[] = [];
    if (!status.connected) {
      warnings.push("Figma plugin is not connected");
    } else if (scope && status.fileKey !== scope.fileKey) {
      warnings.push("The file open in Figma is not the file bound to this workflow");
    } else {
      let nodes: string[];
      if (scope?.rootNodeIds?.length) {
        nodes = scope.rootNodeIds;
      } else {
        const selection: NodeRef[] = await source.getCurrentSelection();
        nodes = [];
        for (const node of selection) {
          if (await this.guard.isAllowed(scope, status.fileKey, node.nodeId, source)) nodes.push(node.nodeId);
        }
      }
      for (const nodeId of nodes) {
        try {
          const summary = await source.getNodeSummary(nodeId);
          manifest.selectedNodes.push({
            nodeId: summary.nodeId,
            name: summary.name,
            type: summary.type,
            states: Array.isArray(summary.states) ? summary.states.map(String) : [],
          });
        } catch (err) {
          warnings.push(`Could not read node ${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (warnings.length) manifest.warnings = warnings;
    return manifest;
  }

  sourceFor(fileKey: string | undefined): FigmaSource {
    const key = fileKey ?? "";
    let source = this.sources.get(key);
    if (!source) {
      source = new GatewayFigmaSource(this.gateway, fileKey ? { fileKey } : {});
      this.sources.set(key, source);
    }
    return source;
  }

  private scopeFor(session: McpSession): FigmaScope | undefined {
    return session.scope ?? this.boundScope;
  }

  private emitStatus(): void {
    if (this.options.onStatus) this.options.onStatus(this.status());
  }
}
