import { afterAll, describe, expect, it } from "vitest";
import { createAgentEvent, REDACTED, type AgentEvent } from "@frontflow/event-schema";
import {
  FakeCliAdapter,
  SessionManager,
  type AgentEventHandler,
  type AiCliAdapter,
  type AiSession,
  type ManagedSession,
  type ProcessBackedAdapter,
  type SessionPersistence,
} from "../src/index.js";
import { collectFrom, ctxInput, tempDir } from "./helpers.js";

const SECRET = "sk-ant-api03-SECRETSECRETSECRET1234567890";
const OPAQUE = "opaque-value-9f8e7d6c";

class MemoryPersistence implements SessionPersistence {
  sessions: ManagedSession[] = [];
  events: AgentEvent[] = [];
  raw: string[] = [];
  saveSession(s: ManagedSession) {
    this.sessions.push(s);
  }
  appendEvent(e: AgentEvent) {
    this.events.push(e);
  }
  async appendRaw(_id: string, chunk: string) {
    this.raw.push(chunk);
  }
}

describe("SessionManager", () => {
  const ws = tempDir("ff-sm-");
  afterAll(() => ws.cleanup());

  it("fans out redacted events and raw output; secrets never reach sinks", async () => {
    const persistence = new MemoryPersistence();
    const manager = new SessionManager([new FakeCliAdapter()], { persistence });
    const all = collectFrom((h) => manager.subscribeAll(h));
    const raw: string[] = [];
    manager.onRaw((_id, chunk) => raw.push(chunk));

    const session = await manager.startSession("fake", {
      ...ctxInput,
      cwd: ws.dir,
      prompt: "leak it",
      env: { FAKE_CLI_SCENARIO: "leak", ANTHROPIC_API_KEY: SECRET, MY_SERVICE_TOKEN: OPAQUE },
    });
    const ended = await manager.waitForEnd(session.id);
    expect(ended.status).toBe("completed");
    await new Promise((r) => setTimeout(r, 50));

    const rawText = raw.join("");
    expect(rawText).toContain("ANTHROPIC_API_KEY=");
    expect(rawText).toContain(REDACTED);
    expect(rawText).not.toContain(SECRET);
    expect(rawText).not.toContain(OPAQUE);
    expect(persistence.raw.join("")).toBe(rawText);

    const eventsText = JSON.stringify(all.events);
    expect(eventsText).not.toContain(SECRET);
    expect(all.events.some((e) => e.type === "message.delta" && e.payload.text.includes(REDACTED))).toBe(true);
    const usage = all.events.find((e) => e.type === "usage.updated");
    expect(usage?.type === "usage.updated" && usage.payload.inputTokens).toBe(115);
    expect(persistence.events).toHaveLength(all.events.length);
    expect(persistence.sessions.at(-1)).toMatchObject({ id: session.id, status: "completed", traceId: ctxInput.traceId });
  });

  it("secrets are passed via env, never argv", async () => {
    const manager = new SessionManager([new FakeCliAdapter()]);
    const session = await manager.startSession("fake", {
      ...ctxInput,
      cwd: ws.dir,
      prompt: "argv check",
      env: { ANTHROPIC_API_KEY: SECRET },
    });
    // The adapter builds argv from non-secret inputs only.
    expect(JSON.stringify(manager.get(session.id))).not.toContain(SECRET);
    await manager.waitForEnd(session.id);
  });

  it("lists sessions, tracks status and detects all adapters", async () => {
    const manager = new SessionManager([new FakeCliAdapter()]);
    const s = await manager.startSession("fake", { ...ctxInput, cwd: ws.dir, prompt: "list me" });
    expect(manager.list().map((x) => x.id)).toContain(s.id);
    await manager.waitForEnd(s.id);
    expect(manager.get(s.id)?.status).toBe("completed");
    expect(manager.get(s.id)?.externalSessionId).toBeTruthy();
    const detections = await manager.detectAll();
    expect(detections).toEqual([
      expect.objectContaining({ adapterId: "fake", detection: expect.objectContaining({ installed: true, version: "1.2.3" }) }),
    ]);
    await expect(manager.startSession("nope", { ...ctxInput, cwd: ws.dir, prompt: "x" })).rejects.toMatchObject({
      code: "ADAPTER_NOT_FOUND",
    });
  });

  it("marks cancelled sessions", async () => {
    const manager = new SessionManager([new FakeCliAdapter()]);
    const s = await manager.startSession("fake", { ...ctxInput, cwd: ws.dir, prompt: "scenario:slow" });
    const c = collectFrom((h) => manager.subscribe(s.id, h));
    await c.waitFor((e) => e.type === "message.delta");
    await manager.cancel(s.id);
    await c.done();
    expect(manager.get(s.id)?.status).toBe("cancelled");
  });

  it("emits PROCESS_EXITED when an adapter's process dies without a terminal event", async () => {
    const stub = new SilentAdapter();
    const manager = new SessionManager([stub], { exitGraceMs: 5 });
    const all = collectFrom((h) => manager.subscribeAll(h));
    const s = await manager.startSession("silent", { ...ctxInput, cwd: ws.dir, prompt: "x" });
    stub.emit(s.id, createAgentEvent("session.started", { ...ctxInput, sessionId: s.id }, { adapterId: "silent", cwd: ws.dir }));
    stub.exit(s.id, 139);
    const end = await all.done(2000);
    expect(end).toMatchObject({
      type: "session.failed",
      sessionId: s.id,
      traceId: ctxInput.traceId,
      payload: { code: "PROCESS_EXITED", exitCode: 139 },
    });
    expect(manager.get(s.id)?.status).toBe("failed");
  });
});

/** Process-backed adapter stub that never reports completion on its own. */
class SilentAdapter implements AiCliAdapter, ProcessBackedAdapter {
  readonly id = "silent";
  private handlers = new Map<string, AgentEventHandler>();
  private exits = new Map<string, (code: number | null) => void>();
  async detect() {
    return { installed: true };
  }
  async capabilities() {
    return {
      structuredEvents: true,
      resumableSessions: false,
      mcp: false,
      toolApprovals: false,
      modelSelection: false,
      usageReporting: false,
      imageInput: false,
    };
  }
  async start(input: { cwd: string }): Promise<AiSession> {
    return { id: "ses_silent", adapterId: this.id, status: "running", cwd: input.cwd, startedAt: new Date().toISOString() };
  }
  async resume(): Promise<AiSession> {
    throw new Error("no");
  }
  async send() {}
  async approve() {}
  async reject() {}
  async cancel() {}
  async close() {}
  subscribe(id: string, h: AgentEventHandler) {
    this.handlers.set(id, h);
    return () => this.handlers.delete(id);
  }
  onProcessExit(id: string, h: (code: number | null) => void) {
    this.exits.set(id, h);
    return () => this.exits.delete(id);
  }
  onRaw() {
    return () => undefined;
  }
  getSession() {
    return undefined;
  }
  emit(id: string, e: AgentEvent) {
    this.handlers.get(id)?.(e);
  }
  exit(id: string, code: number) {
    this.exits.get(id)?.(code);
  }
}
