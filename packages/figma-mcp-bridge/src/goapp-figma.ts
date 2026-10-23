/**
 * Link to GoApp Figma (go-figma): its plugin reads the design open in Figma desktop, and its MCP
 * server (`dist/mcp.mjs`) runs a WebSocket hub on localhost:3940 the plugin connects to.
 *
 * FrontFlow only listens: the designer selects frames and clicks "FrontFlow" in the plugin, the hub
 * forwards that selection to every listener on /events, and the run waiting for a design shows it.
 * When the user runs the step, the AI CLI gets the same MCP server and reads the design itself
 * (get_design_context, get_screenshot, …) while it codes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { isRecord } from "./protocol.js";

export const GOAPP_FIGMA_SERVER_NAME = "goapp-figma";
export const GOAPP_FIGMA_PORT = 3940;
export const GOAPP_FIGMA_EVENTS_PATH = "/events";

export interface FigmaHandoffNode {
  id: string;
  name: string;
  width: number;
  breakpoint?: string;
  state?: string;
  url?: string;
}

/** A selection pushed by the plugin's FrontFlow button (go-figma src/shared/bridge.ts `Handoff`). */
export interface FigmaHandoff {
  /** GF-XXXXXX, to tell pushes apart. */
  id: string;
  /** The Figma file's name; plugins can't read the Figma project a file belongs to. */
  projectName: string;
  fileName: string;
  fileKey?: string;
  /** Reference code flavor picked in the plugin: react-tailwind, html-css or html-tailwind. */
  target: string;
  nodes: FigmaHandoffNode[];
  /** The plugin's "Copy for AI" prompt for these layers. */
  prompt: string;
  createdAt: string;
}

const MAX_NODES = 500;
const MAX_TEXT = 200_000;

/** Validates a hand-off from the hub (or one the renderer sends back); undefined when malformed. */
export function parseFigmaHandoff(value: unknown): FigmaHandoff | undefined {
  if (!isRecord(value)) return undefined;
  const { id, projectName, fileName, target, prompt, createdAt, nodes } = value;
  for (const field of [id, projectName, fileName, target, prompt, createdAt]) {
    if (typeof field !== "string" || field.length > MAX_TEXT) return undefined;
  }
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > MAX_NODES) return undefined;
  const parsedNodes: FigmaHandoffNode[] = [];
  for (const item of nodes) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string") return undefined;
    const node: FigmaHandoffNode = { id: item.id.slice(0, 200), name: item.name.slice(0, 300), width: typeof item.width === "number" ? item.width : 0 };
    if (typeof item.breakpoint === "string") node.breakpoint = item.breakpoint.slice(0, 40);
    if (typeof item.state === "string") node.state = item.state.slice(0, 80);
    if (typeof item.url === "string" && /^https:\/\/(www\.)?figma\.com\//.test(item.url)) node.url = item.url;
    parsedNodes.push(node);
  }
  const handoff: FigmaHandoff = {
    id: id as string,
    projectName: projectName as string,
    fileName: fileName as string,
    target: target as string,
    nodes: parsedNodes,
    prompt: prompt as string,
    createdAt: createdAt as string,
  };
  if (typeof value.fileKey === "string") handoff.fileKey = value.fileKey;
  return handoff;
}

export interface GoFigmaListenerOptions {
  /** dist/mcp.mjs; when set, a hub is started with `--hub` whenever none answers. */
  serverPath: () => string | undefined;
  onHandoff: (handoff: FigmaHandoff) => void;
  onStatus?: (listening: boolean) => void;
  port?: number;
  /** Node binary for the hub; defaults to `node` on PATH (Electron's own binary is not a plain Node). */
  nodePath?: string;
  reconnectMs?: number;
}

/**
 * Keeps a connection to the GoApp Figma hub's /events path. The hub lives in whichever goapp-figma
 * MCP process holds the port (an agent's, or a `--hub` one); when none does, this starts one so the
 * plugin always has something to push to, and reconnects when the hub hands over or exits.
 */
export class GoFigmaListener {
  private ws: WebSocket | undefined;
  private hub: ChildProcess | undefined;
  private retry: NodeJS.Timeout | undefined;
  private stopped = true;
  private connected = false;

  constructor(private readonly options: GoFigmaListenerOptions) {}

  get listening(): boolean {
    return this.connected;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.ws?.terminate();
    this.ws = undefined;
    this.hub?.kill();
    this.hub = undefined;
    this.setConnected(false);
  }

  /** Try again right away, e.g. after the server path changed in Settings. */
  reconnect(): void {
    if (this.stopped || this.connected) return;
    clearTimeout(this.retry);
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(`ws://127.0.0.1:${this.options.port ?? GOAPP_FIGMA_PORT}${GOAPP_FIGMA_EVENTS_PATH}`);
    this.ws = ws;
    ws.on("open", () => this.setConnected(true));
    ws.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!isRecord(message) || message.type !== "handoff") return;
      const handoff = parseFigmaHandoff(message.handoff);
      if (handoff) this.options.onHandoff(handoff);
    });
    ws.on("error", () => {
      // "close" follows and schedules the retry.
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      const wasConnected = this.connected;
      this.setConnected(false);
      if (this.stopped) return;
      // A hub handing over to a newer build is back within a second; otherwise start one.
      if (!wasConnected) this.ensureHub();
      this.retry = setTimeout(() => this.connect(), this.options.reconnectMs ?? 1_500);
    });
  }

  private ensureHub(): void {
    if (this.hub && this.hub.exitCode === null) return;
    const serverPath = this.options.serverPath();
    if (!serverPath || !existsSync(serverPath)) return;
    try {
      const hub = spawn(this.options.nodePath ?? "node", [serverPath, "--hub"], { stdio: "ignore", windowsHide: true });
      hub.on("error", () => {
        if (this.hub === hub) this.hub = undefined;
      });
      hub.on("exit", () => {
        if (this.hub === hub) this.hub = undefined;
      });
      this.hub = hub;
    } catch {
      this.hub = undefined;
    }
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return;
    this.connected = value;
    this.options.onStatus?.(value);
  }
}

/**
 * Where the plugin's MCP panel registered the server: the `goapp-figma` entry in the user's Claude
 * Code, Codex or Cursor config. Returns the first `…mcp.mjs` that exists.
 */
export function findGoFigmaServer(home = homedir()): string | undefined {
  const candidates: string[] = [];
  const fromJson = (file: string) => {
    try {
      const config = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, { args?: unknown }> };
      const args = config.mcpServers?.[GOAPP_FIGMA_SERVER_NAME]?.args;
      if (Array.isArray(args)) candidates.push(...args.filter((a): a is string => typeof a === "string" && a.endsWith(".mjs")));
    } catch {
      // Missing or unreadable config: try the next agent.
    }
  };
  fromJson(join(home, ".claude.json"));
  try {
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    const match = /\[mcp_servers\.(?:"goapp-figma"|goapp-figma)\][^[]*?args\s*=\s*\[\s*"((?:[^"\\]|\\.)+\.mjs)"/.exec(toml);
    if (match?.[1]) candidates.push(JSON.parse(`"${match[1]}"`) as string);
  } catch {
    // No Codex config.
  }
  fromJson(join(home, ".cursor", "mcp.json"));
  return candidates.find((path) => existsSync(path));
}
