/** Figma-side data shapes exchanged with the plugin. Fields beyond the typed ones are passed through untouched. */

export interface NodeRef {
  nodeId: string;
  name: string;
  type: string;
  parentId?: string;
}

export interface NodeSummary extends NodeRef {
  pageId?: string;
  width?: number;
  height?: number;
  childCount?: number;
  /** Variant / state names relevant to this node (e.g. component set variants). */
  states?: string[];
  [key: string]: unknown;
}

export interface NodeTree extends NodeRef {
  children?: NodeTree[];
  [key: string]: unknown;
}

export interface ComponentProperties {
  nodeId: string;
  componentSetId?: string;
  variants?: Array<{ nodeId?: string; name: string; properties?: Record<string, string> }>;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DesignTokens {
  collections?: Array<{ name: string; modes?: string[]; variables: Array<Record<string, unknown>> }>;
  styles?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface PrototypeInteraction {
  trigger: string;
  action: string;
  destinationId?: string;
  [key: string]: unknown;
}

export interface PrototypeInteractions {
  nodeId: string;
  interactions: PrototypeInteraction[];
  [key: string]: unknown;
}

export type RenderFormat = "png" | "svg";

export interface RenderOptions {
  format: RenderFormat;
  scale: number;
}

export interface RenderResult {
  nodeId: string;
  format: RenderFormat;
  mimeType: string;
  base64: string;
  width?: number;
  height?: number;
}

export interface ExportedAsset {
  nodeId: string;
  format: RenderFormat;
  fileName?: string;
  mimeType: string;
  base64: string;
}

export interface FigmaWarning {
  code: string;
  message: string;
  nodeId?: string;
  severity?: "info" | "warning" | "error";
}

export interface FigmaConnectionStatus {
  connected: boolean;
  connectionId?: string;
  fileKey?: string;
  fileName?: string;
  pageId?: string;
  selection: NodeRef[];
  pluginName?: string;
  pluginVersion?: string;
  connectedAt?: string;
  lastSeenAt?: string;
  /** Opaque value that changes whenever the file (or the connection) changes. Used for cache keys. */
  fileVersion: string;
}

/** Allowed Figma scope bound to a workflow (§13.1 "Giới hạn quyền theo selected file/page/node"). */
export interface FigmaScope {
  fileKey: string;
  pageIds?: string[];
  rootNodeIds?: string[];
}

/** Context manifest handed to the AI instead of the full document (§13.3). */
export interface FigmaContextManifest {
  fileKey: string | null;
  fileName?: string;
  pageId: string | null;
  selectedNodes: Array<{ nodeId: string; name: string; type: string; states: string[] }>;
  availableTools: string[];
  warnings?: string[];
}
