import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "@frontflow/event-schema";
import { createPtyParseState, parsePtyLine, PtyFallbackAdapter, stripAnsi } from "../src/index.js";
import { collect, ctxInput, tempDir } from "./helpers.js";

const ctx = { traceId: "t1", workflowRunId: "r1", sessionId: "ses_1", cwd: "/w" };
const PTY_SCRIPT = fileURLToPath(new URL("../../../tests/fixtures/fake-cli/fake-pty-cli.mjs", import.meta.url));

function parse(lines: string[]): AgentEvent[] {
  const state = createPtyParseState();
  return lines.flatMap((l) => parsePtyLine(l, ctx, state));
}

describe("parsePtyLine", () => {
  it("infers tool, file, command and error events with confidence < 1", () => {
    const events = parse([
      "\x1b[32m✔\x1b[0m WriteFile src/App.tsx",
      "✖ Shell npm run build",
      "Running: npm test -- --run",
      "Error: Cannot find module 'x'",
      "Plain assistant text",
    ]);
    expect(events.map((e) => e.type)).toEqual([
      "tool.started",
      "tool.completed",
      "file.changed",
      "tool.started",
      "tool.completed",
      "command.started",
      "message.delta",
      "message.delta",
    ]);
    expect(events[2]?.payload).toEqual({ path: "src/App.tsx", change: "created" });
    expect(events[4]?.payload).toMatchObject({ name: "Shell", ok: false });
    expect(events[5]?.payload).toMatchObject({ command: "npm test -- --run" });
    for (const e of events) {
      expect(e.confidence).toBeGreaterThan(0);
      expect(e.confidence).toBeLessThan(1);
    }
  });

  it("detects approval prompts once per prompt, as approval.required only", () => {
    const state = createPtyParseState();
    const first = parsePtyLine("Allow execution of 'rm -rf dist'? (y/n)", ctx, state);
    const redraw = parsePtyLine("\rAllow execution of 'rm -rf dist'? (y/n)", ctx, state);
    expect(first.map((e) => e.type)).toEqual(["approval.required", "status.changed"]);
    expect(first[0]?.payload).toMatchObject({ requestId: "pty_approval_1" });
    expect(first[0]?.confidence).toBeLessThan(1);
    expect(redraw).toEqual([]);
  });

  it("keeps only the last carriage-return segment and strips ANSI", () => {
    expect(stripAnsi("\x1b[1;31mred\x1b[0m \x1b]0;title\x07ok")).toBe("red ok");
    const [ev] = parse(["50%\r100% done"]);
    expect(ev?.payload).toEqual({ role: "assistant", text: "100% done" });
  });
});

describe("PtyFallbackAdapter", () => {
  const ws = tempDir("ff-pty-");
  afterAll(() => ws.cleanup());

  const adapter = (mode: string) =>
    new PtyFallbackAdapter({
      id: "fake-pty",
      binary: process.execPath,
      promptVia: "argv",
      buildArgs: () => [PTY_SCRIPT, mode],
      versionArgs: ["--version"],
    });

  it("runs in a PTY, never auto-approves, and sends keystrokes only on approve()", async () => {
    const a = adapter("approval");
    const caps = await a.capabilities();
    expect(caps.structuredEvents).toBe(false);
    const session = await a.start({ ...ctxInput, cwd: ws.dir, prompt: "do it" });
    const c = collect(a, session.id);
    const req = await c.waitFor((e) => e.type === "approval.required");
    expect(req.confidence).toBeLessThan(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(c.events.some((e) => e.type === "session.completed" || e.type === "session.failed")).toBe(false);
    expect(existsSync(path.join(ws.dir, "out.txt"))).toBe(false);

    await a.approve(session.id, (req.payload as { requestId: string }).requestId);
    const end = await c.done();
    expect(end.type).toBe("session.completed");
    expect(existsSync(path.join(ws.dir, "out.txt"))).toBe(true);
    expect(c.events.some((e) => e.type === "file.changed" && e.payload.path === "src/out.txt")).toBe(true);
    expect(c.events[0]?.type).toBe("session.started");
  });

  it("maps a non-zero exit to session.failed PROCESS_EXITED", async () => {
    const a = adapter("fail");
    const session = await a.start({ ...ctxInput, cwd: ws.dir, prompt: "x" });
    const c = collect(a, session.id);
    const end = await c.done();
    expect(end).toMatchObject({ type: "session.failed", payload: { code: "PROCESS_EXITED", exitCode: 2 } });
    expect(c.events.some((e) => e.type === "message.delta" && e.payload.role === "system")).toBe(true);
  });
});
