import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PolicyDecision } from "@frontflow/domain";
import {
  FIGMA_TOOL_NAMES,
  FigmaBridge,
  JSONRPC_ERRORS,
  type SnapshotEntry,
  type ToolAuthorizationRequest,
  type ToolCallLogEntry,
} from "../src/index.js";
import { FakeFigmaPlugin, TINY_PNG_BASE64 } from "../src/testing/fake-plugin.js";
import { TestMcpClient, deferred, post } from "./helpers.js";

const FILE_KEY = "FAKEFILEKEY123";

interface Harness {
  bridge: FigmaBridge;
  plugin: FakeFigmaPlugin;
  mcpUrl: string;
  logs: ToolCallLogEntry[];
  snapshots: SnapshotEntry[];
  authCalls: ToolAuthorizationRequest[];
  approvals: Array<ToolAuthorizationRequest & { reason: string }>;
  setPolicy: (fn: (req: ToolAuthorizationRequest) => PolicyDecision) => void;
  setApproval: (fn: () => Promise<boolean>) => void;
  client: (scope?: { fileKey: string; pageIds?: string[]; rootNodeIds?: string[] }) => Promise<TestMcpClient>;
  assetsDir: string;
}

let h: Harness;

beforeEach(async () => {
  const logs: ToolCallLogEntry[] = [];
  const snapshots: SnapshotEntry[] = [];
  const authCalls: ToolAuthorizationRequest[] = [];
  const approvals: Array<ToolAuthorizationRequest & { reason: string }> = [];
  let policy: (req: ToolAuthorizationRequest) => PolicyDecision = () => ({ effect: "allow", reason: "test" });
  let approval: () => Promise<boolean> = async () => true;
  const assetsDir = await mkdtemp(join(tmpdir(), "ff-figma-assets-"));
  const bridge = new FigmaBridge({
    wsPort: 0,
    httpPort: 0,
    assetsDir,
    authorize: (req) => {
      authCalls.push(req);
      return policy(req);
    },
    requestApproval: (req) => {
      approvals.push(req);
      return approval();
    },
    snapshotSink: { save: (entry) => void snapshots.push(entry) },
    onToolCall: (entry) => logs.push(entry),
  });
  const { wsUrl, mcpUrl } = await bridge.start();
  const ticket = bridge.createPairing({ projectId: "proj_1", workflowRunId: "run_1" });
  const plugin = new FakeFigmaPlugin({ url: wsUrl, pairingCode: ticket.code, origin: "null" });
  await plugin.connect();
  h = {
    bridge,
    plugin,
    mcpUrl,
    logs,
    snapshots,
    authCalls,
    approvals,
    assetsDir,
    setPolicy: (fn) => (policy = fn),
    setApproval: (fn) => (approval = fn),
    client: async (scope) => {
      const input: Parameters<FigmaBridge["mintCliSession"]>[0] = { projectId: "proj_1", workflowRunId: "run_1", nodeRunId: "B1" };
      if (scope) input.scope = scope;
      const session = bridge.mintCliSession(input);
      const client = new TestMcpClient(session.url, session.token);
      await client.initialize();
      return client;
    },
  };
});

afterEach(async () => {
  await h.plugin.close();
  await h.bridge.stop();
  await rm(h.assetsDir, { recursive: true, force: true });
});

describe("MCP over HTTP with fake plugin", () => {
  it("initialize → tools/list → tools/call", async () => {
    const session = h.bridge.mintCliSession({ projectId: "proj_1" });
    const client = new TestMcpClient(session.url, session.token);
    const init = await client.initialize();
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities).toMatchObject({ tools: {}, resources: {} });
    expect(init.result.serverInfo.name).toBe("goapp-frontflow-figma");
    expect(client.sessionId).toMatch(/^mcps_/);

    const list = await client.rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(FIGMA_TOOL_NAMES);
    expect(list.result.tools).toHaveLength(10);
    for (const tool of list.result.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations).toEqual(
        expect.objectContaining({
          readOnlyHint: expect.any(Boolean),
          idempotentHint: expect.any(Boolean),
          destructiveHint: expect.any(Boolean),
          openWorldHint: expect.any(Boolean),
        }),
      );
    }
    const exportTool = list.result.tools.find((t: { name: string }) => t.name === "export_assets");
    expect(exportTool.annotations.readOnlyHint).toBe(false);

    const status = await client.callTool("get_connection_status");
    expect(status.result.isError).toBe(false);
    expect(status.result.structuredContent).toMatchObject({ connected: true, fileKey: FILE_KEY, pluginVersion: "0.3.0" });

    const tree = await client.callTool("get_node_tree", { nodeId: "123:456", depth: 1 });
    const treeJson = JSON.parse(tree.result.content[0].text);
    expect(treeJson.name).toBe("Create Tournament Modal");
    expect(treeJson.children.map((c: { name: string }) => c.name)).toContain("Submit Button");

    const render = await client.callTool("render_node", { nodeId: "123:456" });
    expect(render.result.content[0]).toEqual({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });

    const tokens = await client.callTool("get_design_tokens");
    expect(tokens.result.structuredContent.collections[0].name).toBe("color");

    const proto = await client.callTool("get_prototype_interactions", { nodeId: "123:456" });
    expect(proto.result.structuredContent.interactions[0]).toMatchObject({ trigger: "ON_CLICK", destinationId: "123:470" });

    const props = await client.callTool("get_component_properties", { nodeId: "200:3" });
    expect(props.result.structuredContent.variants.map((v: { name: string }) => v.name)).toEqual([
      "State=default",
      "State=validation-error",
      "State=loading",
    ]);

    const warnings = await client.callTool("get_warnings");
    expect(warnings.result.structuredContent.warnings[0].code).toBe("missing_font");

    const log = h.logs.find((l) => l.tool === "get_node_tree")!;
    expect(log).toMatchObject({ ok: true, cached: false, outcome: "ok", sessionId: session.sessionId, projectId: "proj_1" });
    expect(log.durationMs).toBeGreaterThanOrEqual(0);
    expect(log.mcpSessionId).toBe(client.sessionId);
  });

  it("validates arguments and unknown tools", async () => {
    const client = await h.client();
    const bad = await client.callTool("get_node_tree", { nodeId: "123:456", depth: 99 });
    expect(bad.error.code).toBe(JSONRPC_ERRORS.invalidParams);
    const unknown = await client.callTool("delete_everything");
    expect(unknown.error.code).toBe(JSONRPC_ERRORS.invalidParams);
    const notFound = await client.rpc("nope/method");
    expect(notFound.error.code).toBe(JSONRPC_ERRORS.methodNotFound);
  });

  it("scope guard denies nodes outside the bound subtree and allows descendants", async () => {
    const client = await h.client({ fileKey: FILE_KEY, rootNodeIds: ["123:456"] });
    const outside = await client.callTool("get_node_summary", { nodeId: "300:1" });
    expect(outside.error.code).toBe(JSONRPC_ERRORS.scopeDenied);
    expect(outside.error.data).toEqual({ nodeId: "300:1" });
    expect(h.logs.at(-1)).toMatchObject({ tool: "get_node_summary", ok: false, outcome: "denied_scope" });

    const otherPage = await client.callTool("render_node", { nodeId: "400:1" });
    expect(otherPage.error.code).toBe(JSONRPC_ERRORS.scopeDenied);

    // Descendant resolved via plugin ancestors (cold cache).
    const child = await client.callTool("get_node_summary", { nodeId: "123:458" });
    expect(child.result.structuredContent.name).toBe("Name Input");

    // Descendant learned from a node tree needs no ancestor lookup.
    await client.callTool("get_node_tree", { nodeId: "123:456", depth: 2 });
    const before = h.plugin.callCount("getNodeAncestors");
    const sibling = await client.callTool("get_node_summary", { nodeId: "123:459" });
    expect(sibling.result.isError).toBe(false);
    expect(h.plugin.callCount("getNodeAncestors")).toBe(before);

    const exportOutside = await client.callTool("export_assets", { nodeIds: ["123:460", "300:1"] });
    expect(exportOutside.error.code).toBe(JSONRPC_ERRORS.scopeDenied);

    h.plugin.setSelection(["123:457", "300:1"]);
    const selection = await client.callTool("get_current_selection");
    expect(selection.result.structuredContent).toEqual({
      selection: [expect.objectContaining({ nodeId: "123:457" })],
      hiddenOutOfScope: 1,
    });
  });

  it("denies access when the scope is bound to a different file", async () => {
    const client = await h.client({ fileKey: "OTHER" });
    const res = await client.callTool("get_design_tokens");
    // Routed to the plugin for file OTHER, which is not connected.
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/not connected/);

    h.bridge.bindScope({ fileKey: "OTHER" });
    const unscoped = await h.client();
    const res2 = await unscoped.callTool("get_node_summary", { nodeId: "123:456" });
    expect(res2.result.isError).toBe(true);
    h.bridge.bindScope(undefined);
  });

  it("authorize deny returns an isError result without calling the plugin", async () => {
    h.setPolicy((req) =>
      req.tool === "render_node" ? { effect: "deny", reason: "rendering disabled" } : { effect: "allow", reason: "ok" },
    );
    const client = await h.client();
    const before = h.plugin.callCount("renderNode");
    const res = await client.callTool("render_node", { nodeId: "123:456" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe("Denied by policy: rendering disabled");
    expect(h.plugin.callCount("renderNode")).toBe(before);
    const auth = h.authCalls.at(-1)!;
    expect(auth.annotations.readOnlyHint).toBe(true);
    expect(auth.session.nodeRunId).toBe("B1");
    expect(h.logs.at(-1)).toMatchObject({ outcome: "denied_policy", decision: "deny", ok: false });
  });

  it("require_approval waits for the approver", async () => {
    h.setPolicy((req) =>
      req.tool === "export_assets" ? { effect: "require_approval", reason: "writes files" } : { effect: "allow", reason: "ok" },
    );
    const gate = deferred<boolean>();
    h.setApproval(() => gate.promise);
    const client = await h.client({ fileKey: FILE_KEY, rootNodeIds: ["123:456"] });
    const pending = client.callTool("export_assets", { nodeIds: ["123:460"], format: "svg" });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]).toMatchObject({ tool: "export_assets", reason: "writes files" });
    gate.resolve(true);
    const res = await pending;
    expect(res.result.isError).toBe(false);
    const asset = res.result.structuredContent.assets[0];
    expect(asset.path.startsWith(h.assetsDir)).toBe(true);
    expect(await readFile(asset.path, "utf8")).toContain("<svg");

    h.setApproval(async () => false);
    const rejected = await client.callTool("export_assets", { nodeIds: ["123:460"] });
    expect(rejected.result.isError).toBe(true);
    expect(h.logs.at(-1)).toMatchObject({ outcome: "approval_rejected" });
  });

  it("caches read-only results per file version and snapshots every result with its hash", async () => {
    const client = await h.client();
    const first = await client.callTool("get_node_summary", { nodeId: "123:456" });
    const second = await client.callTool("get_node_summary", { nodeId: "123:456" });
    expect(h.plugin.callCount("getNodeSummary")).toBe(1);
    expect(first.result._meta["frontflow/cached"]).toBe(false);
    expect(second.result._meta["frontflow/cached"]).toBe(true);
    expect(second.result.content).toEqual(first.result.content);

    const logs = h.logs.filter((l) => l.tool === "get_node_summary");
    expect(logs.map((l) => l.cached)).toEqual([false, true]);
    const snaps = h.snapshots.filter((s) => s.tool === "get_node_summary");
    expect(snaps).toHaveLength(2);
    expect(snaps[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snaps[1]!.contentHash).toBe(snaps[0]!.contentHash);
    expect(snaps[0]!.fileKey).toBe(FILE_KEY);

    h.plugin.emitFileChanged("v2");
    await new Promise((r) => setTimeout(r, 50));
    await client.callTool("get_node_summary", { nodeId: "123:456" });
    expect(h.plugin.callCount("getNodeSummary")).toBe(2);

    await client.callTool("get_warnings");
    await client.callTool("get_warnings");
    expect(h.plugin.callCount("getWarnings")).toBe(2);
  });

  it("serves the §13.3 manifest as a resource and via buildManifest", async () => {
    const client = await h.client({ fileKey: FILE_KEY, rootNodeIds: ["123:456"] });
    const list = await client.rpc("resources/list");
    expect(list.result.resources[0].uri).toBe("figma://manifest");
    const read = await client.rpc("resources/read", { uri: "figma://manifest" });
    const manifest = JSON.parse(read.result.contents[0].text);
    expect(manifest).toMatchObject({
      fileKey: FILE_KEY,
      pageId: "0:1",
      selectedNodes: [
        { nodeId: "123:456", name: "Create Tournament Modal", type: "FRAME", states: ["default", "validation-error", "loading"] },
      ],
    });
    expect(manifest.availableTools).toEqual(expect.arrayContaining(["get_node_tree", "get_design_tokens", "render_node", "export_assets"]));

    const missing = await client.rpc("resources/read", { uri: "figma://nope" });
    expect(missing.error.code).toBe(JSONRPC_ERRORS.resourceNotFound);

    const fromSelection = await h.bridge.buildManifest();
    expect(fromSelection.selectedNodes.map((n) => n.nodeId)).toEqual(["123:456"]);
  });

  it("reports the plugin as disconnected after revoke", async () => {
    const client = await h.client();
    const connectionId = h.bridge.status().plugin.connections[0]!.connectionId;
    h.bridge.revoke(connectionId);
    await h.plugin.waitClosed();
    const res = await client.callTool("get_node_summary", { nodeId: "123:456" });
    expect(res.result.isError).toBe(true);
    const status = await client.callTool("get_connection_status");
    expect(status.result.structuredContent.connected).toBe(false);
  });
});

describe("HTTP transport security", () => {
  it("rejects a forged Host header (DNS rebinding)", async () => {
    const session = h.bridge.mintCliSession({ projectId: "proj_1" });
    const res = await post(
      session.url,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { Authorization: `Bearer ${session.token}`, Host: "evil.example:80" },
    );
    expect(res.status).toBe(403);
    const port = new URL(session.url).port;
    const ok = await post(
      session.url,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      { Authorization: `Bearer ${session.token}`, Host: `localhost:${port}` },
    );
    expect(ok.status).toBe(200);
    expect(ok.json().result.protocolVersion).toBe("2025-03-26");
  });

  it("rejects browser origins", async () => {
    const session = h.bridge.mintCliSession({ projectId: "proj_1" });
    const res = await post(session.url, { jsonrpc: "2.0", id: 1, method: "ping" }, {
      Authorization: `Bearer ${session.token}`,
      Origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
  });

  it("requires a valid, unrevoked bearer token", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
    const url = h.bridge.status().mcpUrl!;
    expect((await post(url, init)).status).toBe(401);
    expect((await post(url, init, { Authorization: "Bearer ffb_not-a-real-token" })).status).toBe(401);
    expect((await post(url, init, { Authorization: "Basic abc" })).status).toBe(401);

    const session = h.bridge.mintCliSession({ projectId: "proj_1" });
    expect((await post(url, init, { Authorization: `Bearer ${session.token}` })).status).toBe(200);
    h.bridge.revokeCliSession(session.sessionId);
    expect((await post(url, init, { Authorization: `Bearer ${session.token}` })).status).toBe(401);
  });

  it("requires a known Mcp-Session-Id bound to the same bearer", async () => {
    const a = await h.client();
    const b = await h.client();
    const missing = await post(a.url, { jsonrpc: "2.0", id: 5, method: "ping" }, { Authorization: `Bearer ${a.token}` });
    expect(missing.status).toBe(400);
    const crossed = await post(
      a.url,
      { jsonrpc: "2.0", id: 5, method: "ping" },
      { Authorization: `Bearer ${a.token}`, "Mcp-Session-Id": b.sessionId! },
    );
    expect(crossed.status).toBe(404);
    const ping = await a.rpc("ping");
    expect(ping.result).toEqual({});
    const notification = await a.raw({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    expect(notification.status).toBe(202);
  });

  it("refuses to bind the HTTP transport to a non-loopback host", async () => {
    expect(() => new FigmaBridge({ host: "0.0.0.0", authorize: () => ({ effect: "allow", reason: "" }) })).toThrow(/non-loopback/);
  });
});

describe("mcpConfigFor", () => {
  it("references the token through an env var by default", () => {
    const creds = { url: "http://127.0.0.1:47616/mcp", token: "ffb_secret_value" };
    const claude = h.bridge.mcpConfigFor("claude-code", creds);
    expect(claude.config).toEqual({
      mcpServers: {
        "goapp-figma": {
          type: "http",
          url: creds.url,
          headers: { Authorization: "Bearer ${FRONTFLOW_BRIDGE_TOKEN}" },
        },
      },
    });
    expect(claude.content).not.toContain(creds.token);
    expect(claude.env).toEqual({ FRONTFLOW_BRIDGE_TOKEN: creds.token, FRONTFLOW_BRIDGE_URL: creds.url });
    expect(claude.embedsSecret).toBe(false);

    const codex = h.bridge.mcpConfigFor("codex", creds);
    expect(codex.content).toContain("[mcp_servers.goapp-figma]");
    expect(codex.content).toContain('bearer_token_env_var = "FRONTFLOW_BRIDGE_TOKEN"');
    expect(codex.content).not.toContain(creds.token);

    const gemini = h.bridge.mcpConfigFor("gemini", creds);
    expect(gemini.config).toMatchObject({ mcpServers: { "goapp-figma": { httpUrl: creds.url } } });
    expect(gemini.content).not.toContain(creds.token);

    const stdio = h.bridge.mcpConfigFor("claude-code", creds, { transport: "stdio" });
    const entry = (stdio.config.mcpServers as Record<string, { args: string[]; env: Record<string, string> }>)["goapp-figma"]!;
    expect(entry.args.at(-1)).toMatch(/stdio-proxy\.ts$/);
    expect(stdio.content).not.toContain(creds.token);

    const embedded = h.bridge.mcpConfigFor("claude-code", creds, { embedToken: true });
    expect(embedded.embedsSecret).toBe(true);
    expect(embedded.content).toContain(creds.token);
  });
});
