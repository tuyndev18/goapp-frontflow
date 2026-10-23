import type { AssetWriter, WrittenAsset } from "./assets.js";
import type { FigmaSource } from "./figma-source.js";
import type { ScopeGuard } from "./scope-guard.js";
import type { FigmaScope, RenderFormat } from "./types.js";

/** MCP tool annotations. Metadata only — the host policy (authorize) decides (§13.2, §22.1). */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface JsonSchema {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: Array<string | number>;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolOutput {
  /** JSON payload: hashed for snapshots and cached. */
  payload: unknown;
  content: McpContent[];
}

export interface ToolRunContext {
  source: FigmaSource;
  guard: ScopeGuard;
  scope: FigmaScope | undefined;
  fileKey: string | undefined;
  sessionId: string;
  assetWriter: AssetWriter | undefined;
}

export interface FigmaToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  /** Safe to serve from cache for the same file version. */
  cacheable: boolean;
  /** False only for tools that work without a connected, in-scope file. */
  requiresFile: boolean;
  nodeIds(args: Record<string, unknown>): string[];
  run(args: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolOutput>;
}

const NODE_ID: JsonSchema = {
  type: "string",
  description: "Figma node id, e.g. 123:456",
  pattern: "^[A-Za-z0-9:;_-]{1,200}$",
};

const READ_ONLY: Omit<ToolAnnotations, "title"> = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

export function jsonContent(payload: unknown): McpContent {
  return { type: "text", text: JSON.stringify(payload, null, 2) };
}

function json(payload: unknown): ToolOutput {
  return { payload, content: [jsonContent(payload)] };
}

const str = (args: Record<string, unknown>, key: string): string => String(args[key]);
const singleNode = (args: Record<string, unknown>): string[] => [str(args, "nodeId")];
const noNodes = (): string[] => [];

export const FIGMA_TOOLS: readonly FigmaToolDefinition[] = [
  {
    name: "get_connection_status",
    title: "Figma connection status",
    description: "Whether the GoApp Figma plugin is connected, which file/page is open and the current selection.",
    inputSchema: objectSchema({}),
    annotations: { title: "Figma connection status", ...READ_ONLY },
    cacheable: false,
    requiresFile: false,
    nodeIds: noNodes,
    async run(_args, ctx) {
      const status = await ctx.source.getConnectionStatus();
      const { fileVersion: _ignored, ...rest } = status;
      const payload: Record<string, unknown> = { ...rest };
      if (ctx.scope) {
        payload.scope = ctx.scope;
        payload.fileInScope = status.fileKey === ctx.scope.fileKey;
      }
      return json(payload);
    },
  },
  {
    name: "get_current_selection",
    title: "Current Figma selection",
    description: "Nodes currently selected in Figma (id, name, type). Nodes outside the bound scope are hidden.",
    inputSchema: objectSchema({}),
    annotations: { title: "Current Figma selection", ...READ_ONLY },
    cacheable: false,
    requiresFile: true,
    nodeIds: noNodes,
    async run(_args, ctx) {
      const selection = await ctx.source.getCurrentSelection();
      if (ctx.fileKey) ctx.guard.observeRefs(ctx.fileKey, selection);
      const visible = [];
      for (const node of selection) {
        if (await ctx.guard.isAllowed(ctx.scope, ctx.fileKey, node.nodeId, ctx.source)) visible.push(node);
      }
      return json({ selection: visible, hiddenOutOfScope: selection.length - visible.length });
    },
  },
  {
    name: "get_node_summary",
    title: "Figma node summary",
    description: "Compact summary of one node: name, type, size, child count and variant states.",
    inputSchema: objectSchema({ nodeId: NODE_ID }, ["nodeId"]),
    annotations: { title: "Figma node summary", ...READ_ONLY },
    cacheable: true,
    requiresFile: true,
    nodeIds: singleNode,
    async run(args, ctx) {
      const summary = await ctx.source.getNodeSummary(str(args, "nodeId"));
      if (ctx.fileKey) ctx.guard.observeRefs(ctx.fileKey, [summary]);
      return json(summary);
    },
  },
  {
    name: "get_node_tree",
    title: "Figma node tree",
    description: "Layer tree under a node, limited to `depth` levels. Request deeper levels only where needed.",
    inputSchema: objectSchema(
      {
        nodeId: NODE_ID,
        depth: { type: "integer", minimum: 0, maximum: 10, default: 2, description: "Levels of children to include" },
      },
      ["nodeId"],
    ),
    annotations: { title: "Figma node tree", ...READ_ONLY },
    cacheable: true,
    requiresFile: true,
    nodeIds: singleNode,
    async run(args, ctx) {
      const depth = typeof args.depth === "number" ? args.depth : 2;
      const tree = await ctx.source.getNodeTree(str(args, "nodeId"), depth);
      if (ctx.fileKey) ctx.guard.observeTree(ctx.fileKey, tree);
      return json(tree);
    },
  },
  {
    name: "get_component_properties",
    title: "Figma component properties",
    description: "Component / instance properties and the variants (states) of its component set.",
    inputSchema: objectSchema({ nodeId: NODE_ID }, ["nodeId"]),
    annotations: { title: "Figma component properties", ...READ_ONLY },
    cacheable: true,
    requiresFile: true,
    nodeIds: singleNode,
    async run(args, ctx) {
      return json(await ctx.source.getComponentProperties(str(args, "nodeId")));
    },
  },
  {
    name: "get_design_tokens",
    title: "Figma design tokens",
    description: "Variables and styles (colors, typography, spacing, radius, effects) defined in the file.",
    inputSchema: objectSchema({
      scope: { type: "string", maxLength: 200, description: "Optional collection name or category filter" },
    }),
    annotations: { title: "Figma design tokens", ...READ_ONLY },
    cacheable: true,
    requiresFile: true,
    nodeIds: noNodes,
    async run(args, ctx) {
      return json(await ctx.source.getDesignTokens(typeof args.scope === "string" ? args.scope : undefined));
    },
  },
  {
    name: "get_prototype_interactions",
    title: "Figma prototype interactions",
    description: "Prototype reactions (trigger, action, destination) defined on a node and its descendants.",
    inputSchema: objectSchema({ nodeId: NODE_ID }, ["nodeId"]),
    annotations: { title: "Figma prototype interactions", ...READ_ONLY },
    cacheable: true,
    requiresFile: true,
    nodeIds: singleNode,
    async run(args, ctx) {
      return json(await ctx.source.getPrototypeInteractions(str(args, "nodeId")));
    },
  },
  {
    name: "render_node",
    title: "Render Figma node",
    description: "Renders a node to PNG or SVG for visual comparison.",
    inputSchema: objectSchema(
      {
        nodeId: NODE_ID,
        format: { type: "string", enum: ["png", "svg"], default: "png" },
        scale: { type: "number", minimum: 0.25, maximum: 4, default: 1 },
      },
      ["nodeId"],
    ),
    annotations: { title: "Render Figma node", ...READ_ONLY },
    cacheable: true,
    requiresFile: true,
    nodeIds: singleNode,
    async run(args, ctx) {
      const format = (args.format === "svg" ? "svg" : "png") as RenderFormat;
      const scale = typeof args.scale === "number" ? args.scale : 1;
      const rendered = await ctx.source.renderNode(str(args, "nodeId"), { format, scale });
      const mimeType = rendered.mimeType || (format === "svg" ? "image/svg+xml" : "image/png");
      const { base64: _data, ...meta } = rendered;
      return {
        payload: rendered,
        content: [
          { type: "image", data: rendered.base64, mimeType },
          jsonContent({ ...meta, scale }),
        ],
      };
    },
  },
  {
    name: "export_assets",
    title: "Export Figma assets",
    description: "Exports nodes (icons, images) as PNG/SVG files into the session asset directory and returns their paths.",
    inputSchema: objectSchema(
      {
        nodeIds: { type: "array", items: NODE_ID, minItems: 1, maxItems: 50 },
        format: { type: "string", enum: ["png", "svg"], default: "svg" },
        scale: { type: "number", minimum: 0.25, maximum: 4, default: 1 },
      },
      ["nodeIds"],
    ),
    annotations: {
      title: "Export Figma assets",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    cacheable: false,
    requiresFile: true,
    nodeIds: (args) => (Array.isArray(args.nodeIds) ? args.nodeIds.map(String) : []),
    async run(args, ctx) {
      if (!ctx.assetWriter) throw new Error("Asset export is not configured on this bridge");
      const nodeIds = (args.nodeIds as unknown[]).map(String);
      const format = (args.format === "png" ? "png" : "svg") as RenderFormat;
      const scale = typeof args.scale === "number" ? args.scale : 1;
      const assets = await ctx.source.exportAssets(nodeIds, format, scale);
      const written: WrittenAsset[] = [];
      for (const asset of assets) {
        if (!nodeIds.includes(asset.nodeId)) continue;
        written.push(await ctx.assetWriter.write(asset, { sessionId: ctx.sessionId }));
      }
      return json({ assets: written });
    },
  },
  {
    name: "get_warnings",
    title: "Figma warnings",
    description: "Problems detected by the plugin (missing fonts, detached styles, unsupported effects, ...).",
    inputSchema: objectSchema({}),
    annotations: { title: "Figma warnings", ...READ_ONLY },
    cacheable: false,
    requiresFile: true,
    nodeIds: noNodes,
    async run(_args, ctx) {
      return json({ warnings: await ctx.source.getWarnings() });
    },
  },
];

export const FIGMA_TOOL_NAMES = FIGMA_TOOLS.map((t) => t.name);

/** Minimal JSON Schema check for the subset used by FIGMA_TOOLS. Returns an error message or undefined. */
export function validateAgainstSchema(schema: JsonSchema, value: unknown, path = "arguments"): string | undefined {
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${path} must be an object`;
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (record[key] === undefined) return `${path}.${key} is required`;
      }
      for (const [key, v] of Object.entries(record)) {
        const prop = schema.properties?.[key];
        if (!prop) {
          if (schema.additionalProperties === false) return `${path}.${key} is not allowed`;
          continue;
        }
        if (v === undefined) continue;
        const err = validateAgainstSchema(prop, v, `${path}.${key}`);
        if (err) return err;
      }
      return undefined;
    }
    case "array": {
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} items`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} allows at most ${schema.maxItems} items`;
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const err = validateAgainstSchema(schema.items, value[i], `${path}[${i}]`);
          if (err) return err;
        }
      }
      return undefined;
    }
    case "string": {
      if (typeof value !== "string") return `${path} must be a string`;
      if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} is too short`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} is too long`;
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path} has an invalid format`;
      if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(", ")}`;
      return undefined;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a number`;
      if (schema.type === "integer" && !Number.isInteger(value)) return `${path} must be an integer`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be >= ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be <= ${schema.maximum}`;
      return undefined;
    }
    case "boolean":
      return typeof value === "boolean" ? undefined : `${path} must be a boolean`;
    default:
      return undefined;
  }
}
