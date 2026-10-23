/**
 * Adapter contract suite (spec §23.2): every AI CLI adapter must pass it.
 * Detect, start, send, normalized events, approval, cancel, resume, process exit.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_EVENT_TYPES, type AgentEvent } from "@frontflow/event-schema";
import {
  AdapterError,
  isProcessBackedAdapter,
  type AiCliAdapter,
  type StartSessionInput,
} from "../src/index.js";
import { collect, ctxInput, tempDir } from "./helpers.js";

export interface ContractSuiteOptions {
  /** Prompts that drive the CLI into each scenario. */
  prompts: {
    success: string;
    /** Must trigger one approval request that writes `approvalFile` when approved. */
    approval?: string;
    /** Must keep streaming until cancelled. */
    slow: string;
    /** Must make the process exit mid-stream. */
    crash?: string;
  };
  /** File (relative to cwd) the approval scenario writes when approved. */
  approvalFile?: string;
  /** Extra env per session (e.g. state dirs). */
  env?: (workdir: string) => Record<string, string>;
  /** Whether follow-up prompts can be sent into a live session. */
  supportsSend?: boolean;
  eventTimeoutMs?: number;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isIdle = (e: AgentEvent) => e.type === "status.changed" && e.payload.status === "idle";
const TERMINAL = (e: AgentEvent) => e.type === "session.completed" || e.type === "session.failed";

export function runAdapterContractSuite(
  name: string,
  factory: () => AiCliAdapter | Promise<AiCliAdapter>,
  opts: ContractSuiteOptions,
): void {
  describe(`adapter contract: ${name}`, () => {
    let adapter: AiCliAdapter;
    let ws: ReturnType<typeof tempDir>;
    const timeout = opts.eventTimeoutMs ?? 15_000;

    const input = (prompt: string, extra: Partial<StartSessionInput> = {}): StartSessionInput => ({
      ...ctxInput,
      cwd: ws.dir,
      prompt,
      env: opts.env?.(ws.dir) ?? {},
      ...extra,
    });

    beforeEach(async () => {
      ws = tempDir("ff-contract-");
      adapter = await factory();
    });
    afterEach(() => ws.cleanup());

    it("detects installation", async () => {
      const d = await adapter.detect();
      expect(d.installed, d.error).toBe(true);
      expect(d.binaryPath).toBeTruthy();
      expect(d.version).toMatch(/\d+\.\d+/);
    });

    it("declares every capability flag", async () => {
      const caps = await adapter.capabilities();
      for (const key of [
        "structuredEvents",
        "resumableSessions",
        "mcp",
        "toolApprovals",
        "modelSelection",
        "usageReporting",
        "imageInput",
      ] as const) {
        expect(typeof caps[key]).toBe("boolean");
      }
    });

    it("starts a session and emits normalized events in order", async () => {
      const session = await adapter.start(input(opts.prompts.success));
      expect(session.id).toBeTruthy();
      expect(session.adapterId).toBe(adapter.id);
      expect(session.cwd).toBe(ws.dir);
      const c = collect(adapter, session.id);
      const end = await c.done(timeout);
      expect(end.type, JSON.stringify(end.payload)).toBe("session.completed");

      const events = c.events;
      expect(events[0]?.type).toBe("session.started");
      expect(events.at(-1)).toBe(end);
      expect(events.filter(TERMINAL)).toHaveLength(1);
      expect(events.filter((e) => e.type === "session.started")).toHaveLength(1);
      expect(events.some((e) => e.type === "message.delta")).toBe(true);
      const ids = new Set<string>();
      for (const e of events) {
        expect(AGENT_EVENT_TYPES).toContain(e.type);
        expect(e.id).toBeTruthy();
        expect(ids.has(e.id)).toBe(false);
        ids.add(e.id);
        expect(e.timestamp).toMatch(ISO);
        expect(e.traceId).toBe(ctxInput.traceId);
        expect(e.workflowRunId).toBe(ctxInput.workflowRunId);
        expect(e.nodeRunId).toBe(ctxInput.nodeRunId);
        expect(e.sessionId).toBe(session.id);
      }
      const times = events.map((e) => Date.parse(e.timestamp));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    });

    it("sends a follow-up prompt into a live session", async ({ skip }) => {
      if (opts.supportsSend === false || !isProcessBackedAdapter(adapter)) skip();
      const session = await adapter.start(input(opts.prompts.success, { keepAlive: true }));
      const c = collect(adapter, session.id);
      await c.waitFor(isIdle, timeout);
      await adapter.send(session.id, `${opts.prompts.success} (follow-up)`);
      await c.waitFor((e) => e.type === "message.delta" && e.payload.role === "user", timeout);
      await c.waitFor((e) => isIdle(e) && c.events.filter(isIdle).length >= 2, timeout);
      if (isProcessBackedAdapter(adapter)) await adapter.close(session.id);
      const end = await c.done(timeout);
      expect(end.type).toBe("session.completed");
      expect(c.events.filter((e) => e.type === "usage.updated").length).toBeGreaterThanOrEqual(2);
      await expect(adapter.send(session.id, "too late")).rejects.toBeInstanceOf(AdapterError);
    });

    it("handles approval: approve path", async ({ skip }) => {
      const caps = await adapter.capabilities();
      if (!caps.toolApprovals || !opts.prompts.approval) skip();
      const session = await adapter.start(input(opts.prompts.approval!));
      const c = collect(adapter, session.id);
      const req = await c.waitFor((e) => e.type === "approval.required", timeout);
      if (req.type !== "approval.required") throw new Error("unreachable");
      await expect(adapter.approve(session.id, "not-a-request")).rejects.toMatchObject({ code: "UNKNOWN_APPROVAL" });
      await adapter.approve(session.id, req.payload.requestId);
      const end = await c.done(timeout);
      expect(end.type).toBe("session.completed");
      if (opts.approvalFile) {
        expect(existsSync(path.join(ws.dir, opts.approvalFile))).toBe(true);
        expect(c.events.some((e) => e.type === "file.changed")).toBe(true);
      }
    });

    it("handles approval: reject path (never auto-approved)", async ({ skip }) => {
      const caps = await adapter.capabilities();
      if (!caps.toolApprovals || !opts.prompts.approval) skip();
      const session = await adapter.start(input(opts.prompts.approval!));
      const c = collect(adapter, session.id);
      const req = await c.waitFor((e) => e.type === "approval.required", timeout);
      if (req.type !== "approval.required") throw new Error("unreachable");
      // Nothing is decided without the user: the session stays blocked.
      await new Promise((r) => setTimeout(r, 300));
      expect(c.events.some(TERMINAL)).toBe(false);
      if (opts.approvalFile) expect(existsSync(path.join(ws.dir, opts.approvalFile))).toBe(false);
      await adapter.reject(session.id, req.payload.requestId);
      await c.done(timeout);
      if (opts.approvalFile) expect(existsSync(path.join(ws.dir, opts.approvalFile))).toBe(false);
      expect(c.events.some((e) => e.type === "file.changed")).toBe(false);
    });

    it("cancels a running session", async () => {
      const session = await adapter.start(input(opts.prompts.slow));
      const c = collect(adapter, session.id);
      await c.waitFor((e) => e.type === "message.delta", timeout);
      await adapter.cancel(session.id);
      const end = await c.done(timeout);
      expect(end.type).toBe("session.failed");
      if (end.type === "session.failed") expect(end.payload.code).toBe("CANCELLED");
      expect(c.events.some((e) => e.type === "status.changed" && e.payload.status === "cancelled")).toBe(true);
      const count = c.events.length;
      await new Promise((r) => setTimeout(r, 300));
      expect(c.events.length).toBe(count);
      await adapter.cancel(session.id); // idempotent
    });

    it("enforces timeoutMs", async () => {
      const session = await adapter.start(input(opts.prompts.slow, { timeoutMs: 600 }));
      const c = collect(adapter, session.id);
      const end = await c.done(timeout);
      expect(end.type).toBe("session.failed");
      if (end.type === "session.failed") expect(end.payload.code).toBe("TIMEOUT");
    });

    it("resumes a session if supported", async ({ skip }) => {
      const caps = await adapter.capabilities();
      if (!caps.resumableSessions) skip();
      const first = await adapter.start(input(opts.prompts.success));
      const c1 = collect(adapter, first.id);
      const end1 = await c1.done(timeout);
      expect(end1.type).toBe("session.completed");
      const started = c1.events.find((e) => e.type === "session.started");
      const externalSessionId =
        started?.type === "session.started" ? started.payload.externalSessionId : undefined;
      expect(externalSessionId).toBeTruthy();

      const resumed = await adapter.resume({
        ...input(opts.prompts.success),
        externalSessionId: externalSessionId!,
      });
      expect(resumed.id).not.toBe(first.id);
      const c2 = collect(adapter, resumed.id);
      const end2 = await c2.done(timeout);
      expect(end2.type).toBe("session.completed");
      const started2 = c2.events.find((e) => e.type === "session.started");
      expect(started2?.type === "session.started" && started2.payload.externalSessionId).toBe(externalSessionId);
    });

    it("recovers from an unexpected process exit", async ({ skip }) => {
      if (!opts.prompts.crash) skip();
      const session = await adapter.start(input(opts.prompts.crash!));
      const c = collect(adapter, session.id);
      const end = await c.done(timeout);
      expect(end.type).toBe("session.failed");
      if (end.type === "session.failed") {
        expect(end.payload.code).toBe("PROCESS_EXITED");
        expect(end.payload.exitCode).not.toBe(0);
      }
      await expect(adapter.send(session.id, "hello?")).rejects.toMatchObject({ code: "SESSION_NOT_ACTIVE" });
    });
  });
}
