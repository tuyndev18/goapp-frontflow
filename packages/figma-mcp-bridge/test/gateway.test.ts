import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { CLOSE_CODES, PairingManager, PluginGateway, PluginRpcError, type GatewayStatus } from "../src/index.js";
import { FakeFigmaPlugin, NEVER_RESPOND } from "../src/testing/fake-plugin.js";
import { waitFor } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startGateway(extra: Partial<ConstructorParameters<typeof PluginGateway>[0]> = {}) {
  const pairing = new PairingManager();
  const gateway = new PluginGateway({ pairing, port: 0, ...extra });
  const { url } = await gateway.start();
  cleanups.push(() => gateway.stop());
  return { pairing, gateway, url };
}

function plugin(options: ConstructorParameters<typeof FakeFigmaPlugin>[0]): FakeFigmaPlugin {
  const p = new FakeFigmaPlugin(options);
  cleanups.push(() => p.close());
  return p;
}

describe("PluginGateway", () => {
  it("refuses to bind a non-loopback host unless allowNonLocal", () => {
    const pairing = new PairingManager();
    expect(() => new PluginGateway({ pairing, host: "0.0.0.0" })).toThrow(/non-loopback/);
    expect(() => new PluginGateway({ pairing, host: "192.168.1.20" })).toThrow(/non-loopback/);
    expect(() => new PluginGateway({ pairing, host: "0.0.0.0", allowNonLocal: true })).not.toThrow();
    expect(() => new PluginGateway({ pairing, host: "localhost" })).not.toThrow();
  });

  it("rejects connections from a foreign browser origin", async () => {
    const { url } = await startGateway();
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(url, { origin: "https://evil.example" });
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => resolve(101));
      ws.on("error", () => undefined);
    });
    expect(status).toBe(403);
  });

  it("accepts Figma origins and completes the handshake with app/session info", async () => {
    const { pairing, gateway, url } = await startGateway();
    const ticket = pairing.createToken({ projectId: "proj_1", workflowRunId: "run_9" });
    const statuses: GatewayStatus[] = [];
    gateway.subscribe((s) => statuses.push(s));
    const p = plugin({ url, pairingCode: ticket.code, origin: "null" });
    const welcome = await p.connect();
    expect(welcome.app).toEqual({ name: "GoApp FrontFlow", sessionLabel: "Project proj_1 · run run_9" });
    expect(welcome.scope).toEqual({ projectId: "proj_1", workflowRunId: "run_9" });
    expect(welcome.connectionId).toMatch(/^figconn_/);

    const conn = gateway.status().connections[0]!;
    expect(conn).toMatchObject({ connected: true, fileKey: "FAKEFILEKEY123", pluginVersion: "0.3.0" });
    expect(statuses.at(-1)?.connected).toBe(true);

    p.setSelection(["123:458"]);
    await waitFor(() => gateway.status().connections[0]?.selection[0]?.nodeId === "123:458");
    expect(pairing.listConnections()[0]?.connectionId).toBe(welcome.connectionId);

    const second = plugin({ url, pairingCode: ticket.code, origin: "https://www.figma.com" });
    await expect(second.connect()).rejects.toMatchObject({ code: "pairing_used" });
    await second.waitClosed();
    expect(second.closeInfo?.code).toBe(CLOSE_CODES.handshakeFailed);
  });

  it("rejects bad pairing codes", async () => {
    const { url } = await startGateway();
    const p = plugin({ url, pairingCode: "AAAA-BBBB" });
    await expect(p.connect()).rejects.toMatchObject({ code: "pairing_unknown" });
  });

  it("forwards RPC, times out and fails pending calls on disconnect", async () => {
    const { pairing, gateway, url } = await startGateway({ requestTimeoutMs: 150 });
    const ticket = pairing.createToken({ projectId: "p" });
    const p = plugin({
      url,
      pairingCode: ticket.token,
      handlers: { slow: () => NEVER_RESPOND, boom: () => Promise.reject(new Error("kaboom")) },
    });
    await p.connect();
    await expect(gateway.request("getNodeSummary", { nodeId: "123:456" })).resolves.toMatchObject({
      name: "Create Tournament Modal",
    });
    await expect(gateway.request("slow", {})).rejects.toMatchObject({ code: "timeout" });
    await expect(gateway.request("boom", {})).rejects.toMatchObject({ code: "plugin_error", message: "kaboom" });

    const pending = gateway.request("slow", {}, { timeoutMs: 5000 });
    await p.close();
    await expect(pending).rejects.toBeInstanceOf(PluginRpcError);
    await waitFor(() => gateway.status().connections.length === 0);
    await expect(gateway.request("getWarnings", {})).rejects.toMatchObject({ code: "not_connected" });
  });

  it("revoke closes the plugin socket with a reason", async () => {
    const { pairing, gateway, url } = await startGateway();
    const ticket = pairing.createToken({ projectId: "p" });
    const p = plugin({ url, pairingCode: ticket.code });
    const welcome = await p.connect();
    expect(gateway.revoke(welcome.connectionId, "User revoked access")).toBe(true);
    await p.waitClosed();
    expect(p.revokedReason).toBe("User revoked access");
    expect(p.closeInfo).toEqual({ code: CLOSE_CODES.revoked, reason: "revoked: User revoked access" });
    expect(gateway.status().connected).toBe(false);
  });
});
