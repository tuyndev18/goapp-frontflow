import type { PermissionClass } from "@frontflow/domain";
import { newId, nowIso } from "@frontflow/domain";
import type { PolicySource } from "./engine.js";

export type ApprovalOutcome = "approved" | "rejected" | "expired";

export interface ApprovalRequestInput {
  permission: PermissionClass;
  action: string;
  detail?: string;
  source: PolicySource;
  /** Auto-expire (never auto-approve) after this many ms. */
  timeoutMs?: number;
}

export interface PendingApproval {
  id: string;
  permission: PermissionClass;
  action: string;
  detail?: string;
  source: PolicySource;
  createdAt: string;
  expiresAt?: string;
}

export type ApprovalEvent =
  | { type: "requested"; request: PendingApproval }
  | { type: "resolved"; request: PendingApproval; outcome: ApprovalOutcome };

export type ApprovalListener = (event: ApprovalEvent) => void;

interface Entry {
  request: PendingApproval;
  resolve: (outcome: ApprovalOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Human-in-the-loop approval queue. Requests only resolve through approve/reject/expiry. */
export class ApprovalBroker {
  private readonly pending = new Map<string, Entry>();
  private readonly listeners = new Set<ApprovalListener>();

  request(input: ApprovalRequestInput): { requestId: string; promise: Promise<ApprovalOutcome> } {
    const id = newId("appr");
    const createdAt = nowIso();
    const request: PendingApproval = {
      id,
      permission: input.permission,
      action: input.action,
      source: input.source,
      createdAt,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.timeoutMs !== undefined ? { expiresAt: new Date(Date.now() + input.timeoutMs).toISOString() } : {}),
    };
    const promise = new Promise<ApprovalOutcome>((resolve) => {
      const entry: Entry = { request, resolve };
      if (input.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => this.settle(id, "expired"), Math.max(0, input.timeoutMs));
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
    });
    this.emit({ type: "requested", request });
    return { requestId: id, promise };
  }

  approve(requestId: string): boolean {
    return this.settle(requestId, "approved");
  }

  reject(requestId: string): boolean {
    return this.settle(requestId, "rejected");
  }

  /** Expires every pending request (e.g. on shutdown). */
  expireAll(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, "expired");
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map((e) => ({ ...e.request }));
  }

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private settle(id: string, outcome: ApprovalOutcome): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(outcome);
    this.emit({ type: "resolved", request: entry.request, outcome });
    return true;
  }

  private emit(event: ApprovalEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Listener failures must not affect approval state.
      }
    }
  }
}
