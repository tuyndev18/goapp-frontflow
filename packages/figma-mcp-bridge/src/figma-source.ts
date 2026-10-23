import type { PluginGateway } from "./gateway.js";
import { PLUGIN_METHODS } from "./protocol.js";
import type {
  ComponentProperties,
  DesignTokens,
  ExportedAsset,
  FigmaConnectionStatus,
  FigmaWarning,
  NodeRef,
  NodeSummary,
  NodeTree,
  PrototypeInteractions,
  RenderFormat,
  RenderOptions,
  RenderResult,
} from "./types.js";

/** What the MCP tools call. Implementations: GatewayFigmaSource (live plugin) or test doubles. */
export interface FigmaSource {
  getConnectionStatus(): Promise<FigmaConnectionStatus>;
  getCurrentSelection(): Promise<NodeRef[]>;
  getNodeSummary(nodeId: string): Promise<NodeSummary>;
  getNodeTree(nodeId: string, depth: number): Promise<NodeTree>;
  /** Ancestors from the direct parent up to (and including) the page. Used by ScopeGuard. */
  getNodeAncestors(nodeId: string): Promise<NodeRef[]>;
  getComponentProperties(nodeId: string): Promise<ComponentProperties>;
  getDesignTokens(scope?: string): Promise<DesignTokens>;
  getPrototypeInteractions(nodeId: string): Promise<PrototypeInteractions>;
  renderNode(nodeId: string, options: RenderOptions): Promise<RenderResult>;
  exportAssets(nodeIds: string[], format: RenderFormat, scale?: number): Promise<ExportedAsset[]>;
  getWarnings(): Promise<FigmaWarning[]>;
}

export interface GatewayFigmaSourceOptions {
  /** Route requests to the plugin connection that has this file open. */
  fileKey?: string;
  timeoutMs?: number;
}

/** Forwards every call to the paired plugin over the gateway RPC channel. */
export class GatewayFigmaSource implements FigmaSource {
  constructor(
    private readonly gateway: PluginGateway,
    private readonly options: GatewayFigmaSourceOptions = {},
  ) {}

  async getConnectionStatus(): Promise<FigmaConnectionStatus> {
    const conn = this.gateway.connection(this.options.fileKey ? { fileKey: this.options.fileKey } : {});
    if (!conn) {
      const status: FigmaConnectionStatus = { connected: false, selection: [], fileVersion: "disconnected" };
      if (this.options.fileKey) status.fileKey = this.options.fileKey;
      return status;
    }
    const status: FigmaConnectionStatus = {
      connected: conn.connected,
      connectionId: conn.connectionId,
      fileKey: conn.fileKey,
      fileName: conn.fileName,
      selection: conn.selection,
      pluginName: conn.pluginName,
      pluginVersion: conn.pluginVersion,
      connectedAt: conn.connectedAt,
      lastSeenAt: conn.lastSeenAt,
      fileVersion: conn.fileVersion,
    };
    if (conn.pageId) status.pageId = conn.pageId;
    return status;
  }

  getCurrentSelection(): Promise<NodeRef[]> {
    return this.call<{ selection?: NodeRef[] } | NodeRef[]>(PLUGIN_METHODS.getCurrentSelection, {}).then((r) =>
      Array.isArray(r) ? r : (r?.selection ?? []),
    );
  }

  getNodeSummary(nodeId: string): Promise<NodeSummary> {
    return this.call(PLUGIN_METHODS.getNodeSummary, { nodeId });
  }

  getNodeTree(nodeId: string, depth: number): Promise<NodeTree> {
    return this.call(PLUGIN_METHODS.getNodeTree, { nodeId, depth });
  }

  getNodeAncestors(nodeId: string): Promise<NodeRef[]> {
    return this.call<{ ancestors?: NodeRef[] } | NodeRef[]>(PLUGIN_METHODS.getNodeAncestors, { nodeId }).then((r) =>
      Array.isArray(r) ? r : (r?.ancestors ?? []),
    );
  }

  getComponentProperties(nodeId: string): Promise<ComponentProperties> {
    return this.call(PLUGIN_METHODS.getComponentProperties, { nodeId });
  }

  getDesignTokens(scope?: string): Promise<DesignTokens> {
    return this.call(PLUGIN_METHODS.getDesignTokens, scope === undefined ? {} : { scope });
  }

  getPrototypeInteractions(nodeId: string): Promise<PrototypeInteractions> {
    return this.call(PLUGIN_METHODS.getPrototypeInteractions, { nodeId });
  }

  renderNode(nodeId: string, options: RenderOptions): Promise<RenderResult> {
    return this.call(PLUGIN_METHODS.renderNode, { nodeId, format: options.format, scale: options.scale });
  }

  exportAssets(nodeIds: string[], format: RenderFormat, scale = 1): Promise<ExportedAsset[]> {
    return this.call<{ assets?: ExportedAsset[] } | ExportedAsset[]>(PLUGIN_METHODS.exportAssets, {
      nodeIds,
      format,
      scale,
    }).then((r) => (Array.isArray(r) ? r : (r?.assets ?? [])));
  }

  getWarnings(): Promise<FigmaWarning[]> {
    return this.call<{ warnings?: FigmaWarning[] } | FigmaWarning[]>(PLUGIN_METHODS.getWarnings, {}).then((r) =>
      Array.isArray(r) ? r : (r?.warnings ?? []),
    );
  }

  private call<T>(method: string, params: unknown): Promise<T> {
    const opts: { fileKey?: string; timeoutMs?: number } = {};
    if (this.options.fileKey) opts.fileKey = this.options.fileKey;
    if (this.options.timeoutMs) opts.timeoutMs = this.options.timeoutMs;
    return this.gateway.request<T>(method, params, opts);
  }
}
