import { describe, expect, it, vi } from "vitest";
import { BridgeSessionRegistry, PairingError, PairingManager } from "../src/index.js";

function expectPairingError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PairingError);
    expect((err as PairingError).code).toBe(code);
    return;
  }
  throw new Error(`expected PairingError ${code}`);
}

describe("PairingManager", () => {
  it("issues a short human code plus a full token with expiry and scope", () => {
    const pairing = new PairingManager();
    const ticket = pairing.createToken({ projectId: "proj_1", workflowRunId: "run_1" });
    expect(ticket.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(ticket.token.length).toBeGreaterThan(40);
    expect(Date.parse(ticket.expiresAt) - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    expect(ticket.scope).toEqual({ projectId: "proj_1", workflowRunId: "run_1" });
    expect(pairing.listPending()).toHaveLength(1);
    expect(JSON.stringify(pairing.listPending())).not.toContain(ticket.token);
  });

  it("is one-time: second consume fails with 'used'", () => {
    const pairing = new PairingManager();
    const ticket = pairing.createToken({ projectId: "p" });
    expect(pairing.consume(ticket.code.toLowerCase().replace("-", " ")).scope).toEqual({ projectId: "p" });
    expectPairingError(() => pairing.consume(ticket.code), "used");
    expectPairingError(() => pairing.consume(ticket.token), "used");
  });

  it("accepts the full token", () => {
    const pairing = new PairingManager();
    const ticket = pairing.createToken({ projectId: "p" });
    expect(pairing.consume(ticket.token).pairingId).toBe(ticket.pairingId);
  });

  it("rejects expired and unknown codes", () => {
    let now = 1_000_000;
    const pairing = new PairingManager({ now: () => now });
    const ticket = pairing.createToken({ projectId: "p", ttlMs: 1000 });
    now += 1001;
    expectPairingError(() => pairing.consume(ticket.code), "expired");
    expectPairingError(() => pairing.consume("ZZZZ-ZZZZ"), "unknown");
  });

  it("revokes unused codes and live connections", () => {
    const pairing = new PairingManager();
    const unused = pairing.createToken({ projectId: "p" });
    expect(pairing.revoke(unused.code)).toBe(true);
    expectPairingError(() => pairing.consume(unused.code), "revoked");

    const ticket = pairing.createToken({ projectId: "p" });
    const { pairingId } = pairing.consume(ticket.code);
    pairing.attachConnection(pairingId, "conn_1");
    const listener = vi.fn();
    pairing.onRevoked(listener);
    expect(pairing.listConnections().map((c) => c.connectionId)).toEqual(["conn_1"]);
    expect(pairing.revoke("conn_1", "user clicked revoke")).toBe(true);
    expect(listener).toHaveBeenCalledWith("conn_1", "user clicked revoke");
    expect(pairing.listConnections()).toEqual([]);
    expect(pairing.revoke("nope")).toBe(false);
  });

  it("rate-limits repeated failures", () => {
    const pairing = new PairingManager({ maxFailedAttempts: 3 });
    const ticket = pairing.createToken({ projectId: "p" });
    for (let i = 0; i < 3; i++) expectPairingError(() => pairing.consume(`BAD${i}-CODE`), "unknown");
    expectPairingError(() => pairing.consume(ticket.code), "rate_limited");
  });
});

describe("BridgeSessionRegistry", () => {
  it("mints, verifies, expires and revokes bearer tokens", () => {
    let now = 0;
    const registry = new BridgeSessionRegistry(() => now);
    const { session, token } = registry.mint({ projectId: "p", nodeRunId: "n1", scope: { fileKey: "F" }, ttlMs: 100 });
    expect(registry.verify(token)?.sessionId).toBe(session.sessionId);
    expect(registry.verify(`${token}x`)).toBeUndefined();
    now = 100;
    expect(registry.verify(token)).toBeUndefined();

    const second = registry.mint({ projectId: "p" });
    expect(registry.revoke(second.session.sessionId)).toBe(true);
    expect(registry.verify(second.token)).toBeUndefined();
  });
});
