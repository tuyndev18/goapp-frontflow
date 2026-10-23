import { WebSocket, type RawData } from "ws";
import { PLUGIN_METHODS, isRecord, type WelcomeMessage } from "../protocol.js";
import type { NodeRef } from "../types.js";

/** 1×1 transparent PNG. */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export interface FakeNode {
  nodeId: string;
  name: string;
  type: string;
  width?: number;
  height?: number;
  states?: string[];
  componentProperties?: Record<string, unknown>;
  variantProperties?: Record<string, string>;
  componentSetId?: string;
  reactions?: Array<{ trigger: string; action: string; destinationId?: string }>;
  text?: string;
  children?: FakeNode[];
}

export interface FakeDocument {
  fileKey: string;
  fileName: string;
  pages: FakeNode[];
  tokens: Record<string, unknown>;
  warnings: Array<{ code: string; message: string; nodeId?: string }>;
}

/** page → frame "Create Tournament Modal" with children, component variants, tokens and a prototype interaction. */
export function createFakeDocument(): FakeDocument {
  return {
    fileKey: "FAKEFILEKEY123",
    fileName: "GoApp Tournament",
    pages: [
      {
        nodeId: "0:1",
        name: "Tournament",
        type: "PAGE",
        children: [
          {
            nodeId: "123:456",
            name: "Create Tournament Modal",
            type: "FRAME",
            width: 480,
            height: 560,
            states: ["default", "validation-error", "loading"],
            children: [
              { nodeId: "123:457", name: "Title", type: "TEXT", text: "Create tournament", width: 400, height: 28 },
              {
                nodeId: "123:458",
                name: "Name Input",
                type: "INSTANCE",
                width: 400,
                height: 40,
                componentProperties: { label: "Tournament name", required: true },
              },
              {
                nodeId: "123:459",
                name: "Submit Button",
                type: "INSTANCE",
                width: 160,
                height: 40,
                componentProperties: { label: "Create" },
                reactions: [{ trigger: "ON_CLICK", action: "NAVIGATE", destinationId: "123:470" }],
              },
              {
                nodeId: "123:460",
                name: "Close Icon",
                type: "VECTOR",
                width: 16,
                height: 16,
              },
            ],
          },
          {
            nodeId: "200:1",
            name: "Modal State",
            type: "COMPONENT_SET",
            states: ["default", "validation-error", "loading"],
            children: [
              { nodeId: "200:2", name: "State=default", type: "COMPONENT", componentSetId: "200:1", variantProperties: { State: "default" } },
              {
                nodeId: "200:3",
                name: "State=validation-error",
                type: "COMPONENT",
                componentSetId: "200:1",
                variantProperties: { State: "validation-error" },
              },
              { nodeId: "200:4", name: "State=loading", type: "COMPONENT", componentSetId: "200:1", variantProperties: { State: "loading" } },
            ],
          },
          { nodeId: "300:1", name: "Other Screen", type: "FRAME", width: 1440, height: 900, children: [] },
        ],
      },
      {
        nodeId: "0:2",
        name: "Archive",
        type: "PAGE",
        children: [{ nodeId: "400:1", name: "Old Modal", type: "FRAME", width: 480, height: 560, children: [] }],
      },
    ],
    tokens: {
      collections: [
        {
          name: "color",
          modes: ["light"],
          variables: [
            { name: "color/primary", type: "COLOR", value: "#3B82F6" },
            { name: "color/danger", type: "COLOR", value: "#EF4444" },
          ],
        },
        { name: "spacing", modes: ["default"], variables: [{ name: "space/4", type: "FLOAT", value: 16 }] },
      ],
      styles: [{ name: "Heading/H3", type: "TEXT", fontFamily: "Inter", fontSize: 20, fontWeight: 600 }],
    },
    warnings: [{ code: "missing_font", message: "Font 'Inter Display' is not available", nodeId: "123:457" }],
  };
}

export interface FakeFigmaPluginOptions {
  url: string;
  pairingCode: string;
  document?: FakeDocument;
  selection?: string[];
  origin?: string;
  pluginName?: string;
  pluginVersion?: string;
  pageId?: string;
  /** Override or add RPC handlers. Return a value, throw to answer with an error, or return NEVER to not answer. */
  handlers?: Record<string, (params: Record<string, unknown>) => unknown>;
}

export const NEVER_RESPOND = Symbol("never-respond");

type Handler = (params: Record<string, unknown>) => unknown;

/** In-memory stand-in for the GoApp Figma plugin, for integration and desktop E2E tests. */
export class FakeFigmaPlugin {
  readonly document: FakeDocument;
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  welcome: WelcomeMessage | undefined;
  revokedReason: string | undefined;
  closeInfo: { code: number; reason: string } | undefined;
  private ws: WebSocket | undefined;
  private selection: string[];
  private readonly parents = new Map<string, string>();
  private readonly nodes = new Map<string, FakeNode>();
  private readonly handlers: Record<string, Handler>;
  private closed: Promise<void> = Promise.resolve();

  constructor(private readonly options: FakeFigmaPluginOptions) {
    this.document = options.document ?? createFakeDocument();
    this.selection = options.selection ?? ["123:456"];
    for (const page of this.document.pages) this.index(page, undefined);
    this.handlers = { ...this.defaultHandlers(), ...(options.handlers ?? {}) };
  }

  /** Connects and performs the hello handshake. Resolves with the welcome, rejects with the handshake error. */
  connect(): Promise<WelcomeMessage> {
    const ws = new WebSocket(this.options.url, this.options.origin ? { origin: this.options.origin } : {});
    this.ws = ws;
    this.closed = new Promise((resolve) => ws.once("close", () => resolve()));
    return new Promise<WelcomeMessage>((resolve, reject) => {
      let settled = false;
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            type: "hello",
            pairingCode: this.options.pairingCode,
            protocolVersion: 1,
            plugin: { name: this.options.pluginName ?? "GoApp Figma", version: this.options.pluginVersion ?? "0.3.0" },
            file: {
              fileKey: this.document.fileKey,
              fileName: this.document.fileName,
              pageId: this.options.pageId ?? this.document.pages[0]?.nodeId,
            },
          }),
        );
      });
      ws.on("message", (raw: RawData) => {
        const msg = JSON.parse(raw.toString()) as unknown;
        if (!isRecord(msg)) return;
        if (msg.type === "welcome") {
          this.welcome = msg as unknown as WelcomeMessage;
          settled = true;
          resolve(this.welcome);
        } else if (msg.type === "error" && !settled) {
          settled = true;
          reject(Object.assign(new Error(String(msg.message)), { code: String(msg.code) }));
        } else if (msg.type === "revoked") {
          this.revokedReason = String(msg.reason);
        } else if (msg.type === "request" && typeof msg.id === "string" && typeof msg.method === "string") {
          void this.answer(msg.id, msg.method, isRecord(msg.params) ? msg.params : {});
        }
      });
      ws.once("close", (code, reason) => {
        this.closeInfo = { code, reason: reason.toString() };
        if (!settled) {
          settled = true;
          reject(Object.assign(new Error(`closed ${code} ${reason.toString()}`), { code: `close_${code}` }));
        }
      });
      ws.once("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Resolves once the socket is closed (by either side). */
  waitClosed(): Promise<void> {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close(1000, "plugin closed");
      await this.closed;
    }
  }

  setSelection(nodeIds: string[]): void {
    this.selection = nodeIds;
    this.emit("selection.changed", { selection: nodeIds.map((id) => this.ref(id)) });
  }

  emitFileChanged(version?: string): void {
    this.emit("file.changed", version ? { version } : {});
  }

  callCount(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  private emit(name: string, data: unknown): void {
    this.ws?.send(JSON.stringify({ type: "event", name, data }));
  }

  private async answer(id: string, method: string, params: Record<string, unknown>): Promise<void> {
    this.calls.push({ method, params });
    const handler = this.handlers[method];
    let reply: Record<string, unknown>;
    try {
      if (!handler) throw new Error(`Unknown method ${method}`);
      const result = await handler(params);
      if (result === NEVER_RESPOND) return;
      reply = { type: "response", id, result };
    } catch (err) {
      reply = { type: "response", id, error: { code: "plugin_error", message: err instanceof Error ? err.message : String(err) } };
    }
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(reply));
  }

  private defaultHandlers(): Record<string, Handler> {
    const nodeArg = (p: Record<string, unknown>): FakeNode => this.node(String(p.nodeId));
    return {
      [PLUGIN_METHODS.getCurrentSelection]: () => ({ selection: this.selection.map((id) => this.ref(id)) }),
      [PLUGIN_METHODS.getNodeSummary]: (p) => {
        const node = nodeArg(p);
        const summary: Record<string, unknown> = { ...this.ref(node.nodeId), childCount: node.children?.length ?? 0 };
        if (node.width !== undefined) summary.width = node.width;
        if (node.height !== undefined) summary.height = node.height;
        if (node.states) summary.states = node.states;
        summary.pageId = this.pageOf(node.nodeId);
        return summary;
      },
      [PLUGIN_METHODS.getNodeTree]: (p) => {
        const depth = typeof p.depth === "number" ? p.depth : 2;
        return this.tree(nodeArg(p), depth, true);
      },
      [PLUGIN_METHODS.getNodeAncestors]: (p) => {
        const out: NodeRef[] = [];
        let current = this.parents.get(nodeArg(p).nodeId);
        while (current) {
          out.push(this.ref(current));
          current = this.parents.get(current);
        }
        return { ancestors: out };
      },
      [PLUGIN_METHODS.getComponentProperties]: (p) => {
        const node = nodeArg(p);
        const set = node.type === "COMPONENT_SET" ? node : node.componentSetId ? this.node(node.componentSetId) : undefined;
        const result: Record<string, unknown> = { nodeId: node.nodeId, properties: node.componentProperties ?? {} };
        if (set) {
          result.componentSetId = set.nodeId;
          result.variants = (set.children ?? []).map((c) => ({ nodeId: c.nodeId, name: c.name, properties: c.variantProperties ?? {} }));
        } else if (node.states) {
          result.variants = node.states.map((s) => ({ name: s }));
        }
        return result;
      },
      [PLUGIN_METHODS.getDesignTokens]: () => this.document.tokens,
      [PLUGIN_METHODS.getPrototypeInteractions]: (p) => {
        const interactions: unknown[] = [];
        const visit = (n: FakeNode): void => {
          for (const r of n.reactions ?? []) interactions.push({ ...r, sourceNodeId: n.nodeId });
          for (const c of n.children ?? []) visit(c);
        };
        visit(nodeArg(p));
        return { nodeId: String(p.nodeId), interactions };
      },
      [PLUGIN_METHODS.renderNode]: (p) => {
        const node = nodeArg(p);
        const format = p.format === "svg" ? "svg" : "png";
        return {
          nodeId: node.nodeId,
          format,
          mimeType: format === "svg" ? "image/svg+xml" : "image/png",
          base64: format === "svg" ? this.svg(node) : TINY_PNG_BASE64,
          width: node.width,
          height: node.height,
        };
      },
      [PLUGIN_METHODS.exportAssets]: (p) => {
        const ids = Array.isArray(p.nodeIds) ? p.nodeIds.map(String) : [];
        const format = p.format === "png" ? "png" : "svg";
        return {
          assets: ids.map((id) => {
            const node = this.node(id);
            return {
              nodeId: id,
              format,
              fileName: node.name.toLowerCase().replace(/\s+/g, "-"),
              mimeType: format === "svg" ? "image/svg+xml" : "image/png",
              base64: format === "svg" ? this.svg(node) : TINY_PNG_BASE64,
            };
          }),
        };
      },
      [PLUGIN_METHODS.getWarnings]: () => ({ warnings: this.document.warnings }),
    };
  }

  private index(node: FakeNode, parentId: string | undefined): void {
    this.nodes.set(node.nodeId, node);
    if (parentId) this.parents.set(node.nodeId, parentId);
    for (const child of node.children ?? []) this.index(child, node.nodeId);
  }

  private node(nodeId: string): FakeNode {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);
    return node;
  }

  private ref(nodeId: string): NodeRef {
    const node = this.node(nodeId);
    const ref: NodeRef = { nodeId: node.nodeId, name: node.name, type: node.type };
    const parent = this.parents.get(nodeId);
    if (parent) ref.parentId = parent;
    return ref;
  }

  private pageOf(nodeId: string): string | undefined {
    let current: string | undefined = nodeId;
    while (current) {
      if (this.nodes.get(current)?.type === "PAGE") return current;
      current = this.parents.get(current);
    }
    return undefined;
  }

  private tree(node: FakeNode, depth: number, root: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = root ? { ...this.ref(node.nodeId) } : { nodeId: node.nodeId, name: node.name, type: node.type };
    if (node.width !== undefined) out.width = node.width;
    if (node.height !== undefined) out.height = node.height;
    if (node.text !== undefined) out.characters = node.text;
    if (node.children?.length) {
      out.children = depth > 0 ? node.children.map((c) => this.tree(c, depth - 1, false)) : [];
      if (depth === 0) out.truncatedChildren = node.children.length;
    }
    return out;
  }

  private svg(node: FakeNode): string {
    const w = node.width ?? 16;
    const h = node.height ?? 16;
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}"/></svg>`).toString("base64");
  }
}
