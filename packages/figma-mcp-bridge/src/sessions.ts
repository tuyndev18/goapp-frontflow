import { newId } from "@frontflow/domain";
import { digestEquals, hashSecret, randomToken } from "./secrets.js";
import type { FigmaScope } from "./types.js";

export const DEFAULT_CLI_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** One AI CLI session allowed to call the bridge; maps to scope and log correlation ids. */
export interface BridgeSession {
  sessionId: string;
  projectId: string;
  workflowRunId?: string;
  nodeRunId?: string;
  cli?: string;
  scope?: FigmaScope;
  createdAt: string;
  expiresAt: string;
}

export interface MintSessionInput {
  projectId: string;
  workflowRunId?: string;
  nodeRunId?: string;
  cli?: string;
  scope?: FigmaScope;
  ttlMs?: number;
}

interface SessionRecord {
  session: BridgeSession;
  tokenHash: Buffer;
  expiresAtMs: number;
}

/** Bearer tokens for the MCP HTTP endpoint. Only SHA-256 digests are stored. */
export class BridgeSessionRegistry {
  private readonly byHash = new Map<string, SessionRecord>();
  private readonly byId = new Map<string, SessionRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(input: MintSessionInput): { session: BridgeSession; token: string } {
    if (!input.projectId) throw new Error("projectId is required");
    const ttlMs = input.ttlMs ?? DEFAULT_CLI_SESSION_TTL_MS;
    const token = randomToken("ffb_");
    const now = this.now();
    const session: BridgeSession = {
      sessionId: newId("figsess"),
      projectId: input.projectId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    if (input.workflowRunId) session.workflowRunId = input.workflowRunId;
    if (input.nodeRunId) session.nodeRunId = input.nodeRunId;
    if (input.cli) session.cli = input.cli;
    if (input.scope) session.scope = cloneScope(input.scope);
    const tokenHash = hashSecret(token);
    const record: SessionRecord = { session, tokenHash, expiresAtMs: now + ttlMs };
    this.byHash.set(tokenHash.toString("hex"), record);
    this.byId.set(session.sessionId, record);
    return { session: cloneSession(session), token };
  }

  verify(token: string | undefined): BridgeSession | undefined {
    if (!token) return undefined;
    const digest = hashSecret(token);
    const record = this.byHash.get(digest.toString("hex"));
    if (!record || !digestEquals(record.tokenHash, digest)) return undefined;
    if (this.now() >= record.expiresAtMs) {
      this.remove(record);
      return undefined;
    }
    return cloneSession(record.session);
  }

  get(sessionId: string): BridgeSession | undefined {
    const record = this.byId.get(sessionId);
    return record && this.now() < record.expiresAtMs ? cloneSession(record.session) : undefined;
  }

  updateScope(sessionId: string, scope: FigmaScope | undefined): boolean {
    const record = this.byId.get(sessionId);
    if (!record) return false;
    if (scope) record.session.scope = cloneScope(scope);
    else delete record.session.scope;
    return true;
  }

  /** Revokes by sessionId or by token. */
  revoke(sessionIdOrToken: string): boolean {
    const record = this.byId.get(sessionIdOrToken) ?? this.byHash.get(hashSecret(sessionIdOrToken).toString("hex"));
    if (!record) return false;
    this.remove(record);
    return true;
  }

  list(): BridgeSession[] {
    const now = this.now();
    for (const record of [...this.byId.values()]) if (now >= record.expiresAtMs) this.remove(record);
    return [...this.byId.values()].map((r) => cloneSession(r.session));
  }

  private remove(record: SessionRecord): void {
    this.byHash.delete(record.tokenHash.toString("hex"));
    this.byId.delete(record.session.sessionId);
  }
}

function cloneScope(scope: FigmaScope): FigmaScope {
  const out: FigmaScope = { fileKey: scope.fileKey };
  if (scope.pageIds) out.pageIds = [...scope.pageIds];
  if (scope.rootNodeIds) out.rootNodeIds = [...scope.rootNodeIds];
  return out;
}

function cloneSession(session: BridgeSession): BridgeSession {
  const out: BridgeSession = { ...session };
  if (session.scope) out.scope = cloneScope(session.scope);
  return out;
}
