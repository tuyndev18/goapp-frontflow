import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FigmaBridge, runStdioProxy } from "../src/index.js";
import { FakeFigmaPlugin } from "../src/testing/fake-plugin.js";

let bridge: FigmaBridge;
let plugin: FakeFigmaPlugin;

beforeEach(async () => {
  bridge = new FigmaBridge({ wsPort: 0, httpPort: 0, authorize: () => ({ effect: "allow", reason: "test" }) });
  const { wsUrl } = await bridge.start();
  const ticket = bridge.createPairing({ projectId: "proj_1" });
  plugin = new FakeFigmaPlugin({ url: wsUrl, pairingCode: ticket.code });
  await plugin.connect();
});

afterEach(async () => {
  await plugin.close();
  await bridge.stop();
});

function collect(stream: PassThrough): () => any[] {
  let buffer = "";
  stream.on("data", (chunk: Buffer) => (buffer += chunk.toString("utf8")));
  return () =>
    buffer
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
}

describe("stdio proxy", () => {
  it("round-trips JSON-RPC lines through the HTTP endpoint", async () => {
    const session = bridge.mintCliSession({ projectId: "proj_1" });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const output = collect(stdout);
    const done = runStdioProxy(stdin, stdout, {
      FRONTFLOW_BRIDGE_URL: session.url,
      FRONTFLOW_BRIDGE_TOKEN: session.token,
    });
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_node_summary", arguments: { nodeId: "123:456" } } },
    ];
    stdin.end(lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
    await done;

    const responses = output();
    const byId = new Map(responses.map((r) => [r.id, r]));
    expect(byId.get(1).result.protocolVersion).toBe("2025-06-18");
    expect(byId.get(2).result.tools).toHaveLength(10);
    expect(JSON.parse(byId.get(3).result.content[0].text).name).toBe("Create Tournament Modal");
    expect(byId.get(null).error.code).toBe(-32700);
    expect(responses).toHaveLength(4);
  });

  it("maps HTTP auth failures to JSON-RPC errors and never echoes the token", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const output = collect(stdout);
    let errText = "";
    stderr.on("data", (c: Buffer) => (errText += c.toString()));
    const done = runStdioProxy(
      stdin,
      stdout,
      { FRONTFLOW_BRIDGE_URL: bridge.status().mcpUrl!, FRONTFLOW_BRIDGE_TOKEN: "ffb_wrong_token_value" },
      { stderr },
    );
    stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} })}\n`);
    await done;
    const [res] = output();
    expect(res).toMatchObject({ id: 7, error: { code: -32000 } });
    expect(res.error.message).toContain("401");
    expect(JSON.stringify(res) + errText).not.toContain("ffb_wrong_token_value");
  });

  it("requires credentials from the environment", async () => {
    await expect(runStdioProxy(new PassThrough(), new PassThrough(), {})).rejects.toThrow(/FRONTFLOW_BRIDGE_TOKEN/);
  });
});
