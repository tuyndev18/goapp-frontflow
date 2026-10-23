import { newId } from "@frontflow/domain";
import { digestEquals, formatCode, hashSecret, normalizeCode, randomCode, randomToken } from "./secrets.js";

export const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIRING_CODE_LENGTH = 8;
const RECORD_RETENTION_MS = 10 * 60 * 1000;

export interface PairingScope {
  projectId: string;
  workflowRunId?: string;
}

export interface CreatePairingInput extends PairingScope {
  ttlMs?: number;
}

/** Returned once to the desktop UI. `code` is for humans (XXXX-XXXX); `token` for programmatic pairing. */
export interface PairingTicket {
  pairingId: string;
  code: string;
  token: string;
  expiresAt: string;
  scope: PairingScope;
}

export type PairingErrorCode = "expired" | "used" | "unknown" | "revoked" | "rate_limited";

export class PairingError extends Error {
  constructor(
    readonly code: PairingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PairingError";
  }
}

export interface PairedConnection {
  connectionId: string;
  pairingId: string;
  scope: PairingScope;
  pairedAt: string;
  meta?: Record<string, unknown>;
}

export interface PendingPairing {
  pairingId: string;
  scope: PairingScope;
  createdAt: string;
  expiresAt: string;
}

interface PairingRecord {
  pairingId: string;
  codeHash: Buffer;
  tokenHash: Buffer;
  scope: PairingScope;
  createdAt: number;
  expiresAt: number;
  state: "pending" | "used" | "revoked";
}

export interface PairingManagerOptions {
  now?: () => number;
  /** Failed consume attempts tolerated per window before all attempts are refused. */
  maxFailedAttempts?: number;
  failureWindowMs?: number;
}

export type RevokeListener = (connectionId: string, reason: string) => void;

/**
 * One-time pairing codes (§22.4). Only SHA-256 digests of codes/tokens are kept in memory and
 * comparisons are constant-time. Secrets never appear in errors or listings.
 */
export class PairingManager {
  private readonly records = new Map<string, PairingRecord>();
  private readonly connections = new Map<string, PairedConnection>();
  private readonly revokeListeners = new Set<RevokeListener>();
  private failures: number[] = [];
  private readonly now: () => number;
  private readonly maxFailedAttempts: number;
  private readonly failureWindowMs: number;

  constructor(options: PairingManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxFailedAttempts = options.maxFailedAttempts ?? 10;
    this.failureWindowMs = options.failureWindowMs ?? 60_000;
  }

  createToken(input: CreatePairingInput): PairingTicket {
    if (!input.projectId) throw new Error("projectId is required");
    const ttlMs = input.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
    if (!(ttlMs > 0)) throw new Error("ttlMs must be positive");
    this.purge();
    const code = randomCode(PAIRING_CODE_LENGTH);
    const token = randomToken("ffp_");
    const now = this.now();
    const scope: PairingScope = { projectId: input.projectId };
    if (input.workflowRunId) scope.workflowRunId = input.workflowRunId;
    const record: PairingRecord = {
      pairingId: newId("pair"),
      codeHash: hashSecret(normalizeCode(code)),
      tokenHash: hashSecret(token),
      scope,
      createdAt: now,
      expiresAt: now + ttlMs,
      state: "pending",
    };
    this.records.set(record.pairingId, record);
    return {
      pairingId: record.pairingId,
      code: formatCode(code),
      token,
      expiresAt: new Date(record.expiresAt).toISOString(),
      scope: { ...scope },
    };
  }

  /** Consumes a pairing code or token. Throws PairingError (expired / used / unknown / revoked / rate_limited). */
  consume(codeOrToken: string): { pairingId: string; scope: PairingScope } {
    const now = this.now();
    this.failures = this.failures.filter((t) => now - t < this.failureWindowMs);
    if (this.failures.length >= this.maxFailedAttempts) {
      throw new PairingError("rate_limited", "Too many failed pairing attempts; try again later");
    }
    const record = this.find(codeOrToken);
    if (!record) {
      this.failures.push(now);
      throw new PairingError("unknown", "Pairing code is not recognised");
    }
    if (record.state === "used") {
      this.failures.push(now);
      throw new PairingError("used", "Pairing code was already used");
    }
    if (record.state === "revoked") {
      this.failures.push(now);
      throw new PairingError("revoked", "Pairing code was revoked");
    }
    if (now >= record.expiresAt) {
      throw new PairingError("expired", "Pairing code has expired");
    }
    record.state = "used";
    return { pairingId: record.pairingId, scope: { ...record.scope } };
  }

  attachConnection(pairingId: string, connectionId: string, meta?: Record<string, unknown>): PairedConnection {
    const record = this.records.get(pairingId);
    if (!record) throw new PairingError("unknown", "Unknown pairing");
    const conn: PairedConnection = {
      connectionId,
      pairingId,
      scope: { ...record.scope },
      pairedAt: new Date(this.now()).toISOString(),
    };
    if (meta) conn.meta = meta;
    this.connections.set(connectionId, conn);
    return conn;
  }

  detachConnection(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  /**
   * Revokes a live connection (by connectionId), a pairing (by pairingId) or an unused code/token.
   * Revoking a pairing also revokes every connection created from it.
   */
  revoke(target: string, reason = "Revoked by user"): boolean {
    const conn = this.connections.get(target);
    if (conn) {
      this.connections.delete(target);
      this.emitRevoked(target, reason);
      return true;
    }
    const record = this.records.get(target) ?? this.find(target);
    if (!record) return false;
    record.state = "revoked";
    for (const c of [...this.connections.values()]) {
      if (c.pairingId === record.pairingId) {
        this.connections.delete(c.connectionId);
        this.emitRevoked(c.connectionId, reason);
      }
    }
    return true;
  }

  listConnections(): PairedConnection[] {
    return [...this.connections.values()].map((c) => ({ ...c, scope: { ...c.scope } }));
  }

  listPending(): PendingPairing[] {
    this.purge();
    const now = this.now();
    return [...this.records.values()]
      .filter((r) => r.state === "pending" && r.expiresAt > now)
      .map((r) => ({
        pairingId: r.pairingId,
        scope: { ...r.scope },
        createdAt: new Date(r.createdAt).toISOString(),
        expiresAt: new Date(r.expiresAt).toISOString(),
      }));
  }

  onRevoked(listener: RevokeListener): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  private emitRevoked(connectionId: string, reason: string): void {
    for (const listener of this.revokeListeners) listener(connectionId, reason);
  }

  private find(codeOrToken: string): PairingRecord | undefined {
    const tokenDigest = hashSecret(codeOrToken.trim());
    const codeDigest = hashSecret(normalizeCode(codeOrToken));
    let match: PairingRecord | undefined;
    // Visit every record so timing does not depend on where a match sits.
    for (const record of this.records.values()) {
      const hit = digestEquals(record.tokenHash, tokenDigest) || digestEquals(record.codeHash, codeDigest);
      if (hit && !match) match = record;
    }
    return match;
  }

  private purge(): void {
    const now = this.now();
    for (const [id, record] of this.records) {
      if (record.expiresAt + RECORD_RETENTION_MS < now) this.records.delete(id);
    }
  }
}
