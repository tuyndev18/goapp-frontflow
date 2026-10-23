import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { GOAPP_FIGMA_EVENTS_PATH, GoFigmaListener, buildStdioServerMcpConfig, findGoFigmaServer, parseFigmaHandoff, type FigmaHandoff } from "../src/index.js";

const HANDOFF: FigmaHandoff = {
  id: "GF-TEST42",
  projectName: "Cancel order",
  fileName: "Cancel order",
  fileKey: "FILEKEY123",
  target: "react-tailwind",
  nodes: [{ id: "123:456", name: "Cancel Order Modal", width: 480, url: "https://www.figma.com/design/FILEKEY123/Cancel-order?node-id=123-456" }],
  prompt: "Implement this Figma design in this codebase, using the goapp-figma MCP server.",
  createdAt: "2026-10-22T08:00:00.000Z",
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Stand-in for the go-figma hub: accepts listeners on /events and lets the test push to them. */
async function fakeHub(): Promise<{ port: number; listeners: Set<WebSocket>; paths: string[]; push(message: unknown): void; close(): void }> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const listeners = new Set<WebSocket>();
  const paths: string[] = [];
  wss.on("connection", (ws, req) => {
    paths.push(`${req.url}|${req.headers.origin ?? "no-origin"}`);
    listeners.add(ws);
    ws.on("close", () => listeners.delete(ws));
  });
  const hub = {
    port: (wss.address() as AddressInfo).port,
    listeners,
    paths,
    push: (message: unknown) => listeners.forEach((ws) => ws.send(JSON.stringify(message))),
    close: () => {
      listeners.forEach((ws) => ws.terminate());
      wss.close();
    },
  };
  cleanups.push(hub.close);
  return hub;
}

function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => (check() ? resolve() : Date.now() - started > timeoutMs ? reject(new Error("timed out")) : setTimeout(tick, 20));
    tick();
  });
}

describe("GoApp Figma hand-off", () => {
  it("validates pushed selections and drops non-Figma links", () => {
    expect(parseFigmaHandoff(HANDOFF)).toEqual(HANDOFF);
    expect(parseFigmaHandoff({ ...HANDOFF, nodes: [{ id: "1:2", name: "Frame", width: 10, url: "https://evil.example/x" }] })?.nodes).toEqual([
      { id: "1:2", name: "Frame", width: 10 },
    ]);
    expect(parseFigmaHandoff({ ...HANDOFF, nodes: [] })).toBeUndefined();
    expect(parseFigmaHandoff({ ...HANDOFF, nodes: [{ name: "no id" }] })).toBeUndefined();
    expect(parseFigmaHandoff({ ...HANDOFF, prompt: 1 })).toBeUndefined();
  });
});

describe("GoFigmaListener", () => {
  it("listens on /events without an Origin and reports each pushed selection", async () => {
    const hub = await fakeHub();
    const received: FigmaHandoff[] = [];
    const states: boolean[] = [];
    const listener = new GoFigmaListener({ port: hub.port, serverPath: () => undefined, onHandoff: (h) => received.push(h), onStatus: (s) => states.push(s) });
    cleanups.push(() => listener.stop());
    listener.start();

    await until(() => listener.listening);
    expect(hub.paths).toEqual([`${GOAPP_FIGMA_EVENTS_PATH}|no-origin`]);

    hub.push({ type: "handoff", handoff: { ...HANDOFF, nodes: "broken" } });
    hub.push({ type: "something-else" });
    hub.push({ type: "handoff", handoff: HANDOFF });
    await until(() => received.length > 0);
    expect(received).toEqual([HANDOFF]);
    expect(states).toEqual([true]);
  });

  it("reconnects when the hub goes away and comes back", async () => {
    const first = await fakeHub();
    const listener = new GoFigmaListener({ port: first.port, serverPath: () => undefined, onHandoff: () => {}, reconnectMs: 50 });
    cleanups.push(() => listener.stop());
    listener.start();
    await until(() => listener.listening);

    first.listeners.forEach((ws) => ws.close(1012, "handing over"));
    await until(() => !listener.listening);
    await until(() => listener.listening);
    expect(first.paths).toHaveLength(2);
  });
});

describe("GoApp Figma setup", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  it("finds the server the plugin registered in Claude Code or Codex", () => {
    home = mkdtempSync(join(tmpdir(), "ff-home-"));
    const server = join(home, "go-figma", "dist", "mcp.mjs");
    mkdirSync(join(home, "go-figma", "dist"), { recursive: true });
    writeFileSync(server, "");
    expect(findGoFigmaServer(home)).toBeUndefined();

    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { "goapp-figma": { command: "node", args: [join(home, "missing.mjs")] } } }));
    expect(findGoFigmaServer(home)).toBeUndefined();

    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), `[mcp_servers.goapp-figma]\ncommand = "node"\nargs = [${JSON.stringify(server)}]\n`);
    expect(findGoFigmaServer(home)).toBe(server);
  });

  it("builds stdio MCP configs for each CLI", () => {
    const server = { command: "node", args: ["/opt/go-figma/dist/mcp.mjs"] };
    const claude = buildStdioServerMcpConfig("claude-code", server, "goapp-figma");
    expect(claude.config).toEqual({ mcpServers: { "goapp-figma": { type: "stdio", command: "node", args: ["/opt/go-figma/dist/mcp.mjs"] } } });
    expect(claude.embedsSecret).toBe(false);
    expect(buildStdioServerMcpConfig("codex", server, "goapp-figma").content).toBe('[mcp_servers.goapp-figma]\ncommand = "node"\nargs = ["/opt/go-figma/dist/mcp.mjs"]\n');
    expect(buildStdioServerMcpConfig("gemini", server, "goapp-figma").fileName).toBe(".gemini/settings.json");
  });
});
