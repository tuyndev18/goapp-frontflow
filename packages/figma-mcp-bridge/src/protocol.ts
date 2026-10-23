import type { NodeRef } from "./types.js";

/**
 * Wire protocol between the GoApp Figma plugin (WebSocket client) and the local bridge.
 * Open decision #3 (§27): the plugin protocol is not final, so every RPC method name lives
 * in PLUGIN_METHODS and can be remapped in one place.
 */
export const PLUGIN_PROTOCOL_VERSION = 1;

export const PLUGIN_METHODS = {
  getCurrentSelection: "getCurrentSelection",
  getNodeSummary: "getNodeSummary",
  getNodeTree: "getNodeTree",
  getNodeAncestors: "getNodeAncestors",
  getComponentProperties: "getComponentProperties",
  getDesignTokens: "getDesignTokens",
  getPrototypeInteractions: "getPrototypeInteractions",
  renderNode: "renderNode",
  exportAssets: "exportAssets",
  getWarnings: "getWarnings",
} as const;

export type PluginMethodKey = keyof typeof PLUGIN_METHODS;

export const PLUGIN_EVENTS = {
  selectionChanged: "selection.changed",
  fileChanged: "file.changed",
} as const;

export const CLOSE_CODES = {
  shutdown: 1001,
  handshakeFailed: 4000,
  revoked: 4001,
  protocolError: 4003,
  replaced: 4004,
} as const;

export interface HelloMessage {
  type: "hello";
  pairingCode: string;
  protocolVersion?: number;
  plugin: { name: string; version: string };
  file: { fileKey: string; fileName: string; pageId?: string };
}

export interface WelcomeMessage {
  type: "welcome";
  protocolVersion: number;
  connectionId: string;
  app: { name: string; sessionLabel: string };
  scope: { projectId: string; workflowRunId?: string };
  heartbeatMs: number;
}

export interface HandshakeErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export interface RevokedMessage {
  type: "revoked";
  reason: string;
}

export interface RequestMessage {
  type: "request";
  id: string;
  method: string;
  params: unknown;
}

export interface ResponseMessage {
  type: "response";
  id: string;
  result?: unknown;
  error?: { code?: string; message: string; data?: unknown };
}

export interface SelectionChangedEvent {
  type: "event";
  name: "selection.changed";
  data: { selection: NodeRef[]; pageId?: string };
}

export interface FileChangedEvent {
  type: "event";
  name: "file.changed";
  data: { fileKey?: string; fileName?: string; pageId?: string; version?: string };
}

export type PluginEventMessage = SelectionChangedEvent | FileChangedEvent;

export type GatewayToPluginMessage = WelcomeMessage | HandshakeErrorMessage | RevokedMessage | RequestMessage;
export type PluginToGatewayMessage = HelloMessage | ResponseMessage | PluginEventMessage;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHello(value: unknown): HelloMessage | undefined {
  if (!isRecord(value) || value.type !== "hello") return undefined;
  const { pairingCode, plugin, file } = value;
  if (typeof pairingCode !== "string" || pairingCode.length === 0 || pairingCode.length > 256) return undefined;
  if (!isRecord(plugin) || typeof plugin.name !== "string" || typeof plugin.version !== "string") return undefined;
  if (!isRecord(file) || typeof file.fileKey !== "string" || !file.fileKey || typeof file.fileName !== "string") {
    return undefined;
  }
  if (file.pageId !== undefined && typeof file.pageId !== "string") return undefined;
  const hello: HelloMessage = {
    type: "hello",
    pairingCode,
    plugin: { name: plugin.name.slice(0, 120), version: plugin.version.slice(0, 40) },
    file: { fileKey: file.fileKey.slice(0, 200), fileName: file.fileName.slice(0, 300) },
  };
  if (typeof file.pageId === "string") hello.file.pageId = file.pageId;
  if (typeof value.protocolVersion === "number") hello.protocolVersion = value.protocolVersion;
  return hello;
}

export function toNodeRefs(value: unknown): NodeRef[] {
  if (!Array.isArray(value)) return [];
  const out: NodeRef[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.nodeId !== "string") continue;
    const ref: NodeRef = {
      nodeId: item.nodeId,
      name: typeof item.name === "string" ? item.name : "",
      type: typeof item.type === "string" ? item.type : "UNKNOWN",
    };
    if (typeof item.parentId === "string") ref.parentId = item.parentId;
    out.push(ref);
  }
  return out;
}
