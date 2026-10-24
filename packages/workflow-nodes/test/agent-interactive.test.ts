import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeProjectSlug, type OpenTerminalInput } from "@frontflow/cli-adapters";
import type { AnyEvent } from "@frontflow/event-schema";
import type { NodeExecutionContext } from "@frontflow/workflow-engine";
import { runAgentStep } from "../src/agent.js";
import type { NodeServices, TerminalBackend } from "../src/services.js";

const entry = (v: unknown) => `${JSON.stringify(v)}\n`;

/** Stands in for the runner's PTY: "Claude" writes a transcript, then (optionally) exits. */
function fakeTerminals(configDir: string, script: (write: (v: unknown) => void, exit: (code: number) => void) => void) {
  const exitHandlers = new Set<(id: string, code: number | null) => void>();
  const opened: OpenTerminalInput[] = [];
  const closed: string[] = [];
  const backend: TerminalBackend = {
    claudeConfigDir: configDir,
    async open(input) {
      opened.push(input);
      const args = input.args ?? [];
      const sessionId = args[args.indexOf("--session-id") + 1]!;
      const dir = path.join(configDir, "projects", claudeProjectSlug(input.cwd));
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${sessionId}.jsonl`);
      setTimeout(
        () =>
          script(
            (v) => appendFileSync(file, entry(v)),
            (code) => setTimeout(() => exitHandlers.forEach((h) => h(input.terminalId, code)), 450),
          ),
        10,
      );
      return { terminalId: input.terminalId, pid: 1, command: "claude" };
    },
    async close(terminalId) {
      closed.push(terminalId);
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
  };
  return { backend, opened, closed };
}

function setup(terminals: TerminalBackend) {
  const root = mkdtempSync(path.join(tmpdir(), "ff-agent-"));
  const cwd = path.join(root, "project");
  mkdirSync(cwd);
  const emitted: AnyEvent[] = [];
  const logs: Array<{ message: string; data?: unknown }> = [];
  const ctx = {
    runId: "run_1",
    projectId: "p1",
    nodeId: "B1.implement_ui",
    nodeRunId: "nr_1",
    nodeType: "ai.implement_ui",
    attempt: 1,
    traceId: "trace_1",
    signal: new AbortController().signal,
    log: (_level: string, message: string, data?: unknown) => logs.push({ message, data }),
    emitArtifact: () => undefined,
    emit: (e: AnyEvent) => emitted.push(e),
  } as unknown as NodeExecutionContext;
  const services = {
    terminals,
    agents: { start: () => Promise.reject(new Error("headless must not run")), resume: () => Promise.reject(new Error("no")), cancel: async () => undefined, subscribeAll: () => () => undefined },
    settings: () => ({ allowArbitraryShell: false, commandTimeoutMs: 1000, agentTimeoutMs: 20_000, fixBudget: 1 }),
    mcpConfigDir: path.join(root, "mcp"),
  } as unknown as NodeServices;
  return { ctx, services, cwd, emitted, logs };
}

describe("interactive Claude steps", () => {
  it("never runs a real CLI headless", async () => {
    const { ctx, services, cwd } = setup(undefined as unknown as TerminalBackend);
    await expect(runAgentStep(ctx, { ...services, terminals: undefined } as NodeServices, { projectId: "p1", adapterId: "claude-code", cwd, prompt: "x", readOnly: true })).rejects.toMatchObject({ code: "HEADLESS_DISABLED" });
    await expect(runAgentStep(ctx, services, { projectId: "p1", adapterId: "codex", cwd, prompt: "x", readOnly: true })).rejects.toMatchObject({ code: "HEADLESS_DISABLED" });
  });

  it("passes the run's model and effort to Claude Code", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "ff-claude-"));
    const { backend, opened } = fakeTerminals(configDir, (write, exit) => {
      write({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } });
      exit(0);
    });
    const { ctx, services, cwd } = setup(backend);
    await runAgentStep(ctx, services, { projectId: "p1", adapterId: "claude-code", cwd, prompt: "x", readOnly: true, model: "opus", effort: "high" });
    const args = opened[0]!.args!;
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });

  it("runs the TUI in a terminal, follows the transcript and completes when Claude ends its turn", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "ff-claude-"));
    let cwdSeen = "";
    const { backend, opened, closed } = fakeTerminals(configDir, (write, exit) => {
      write({ type: "user", message: { role: "user", content: "Your task is in …" }, turnOrigin: "human" });
      write({
        type: "assistant",
        message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: path.join(cwdSeen, "src", "App.tsx") } }], stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 20 } },
      });
      write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }, toolUseResult: { type: "create" } });
      write({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Implemented the screen." }], stop_reason: "end_turn", usage: { input_tokens: 150, output_tokens: 30 } } });
      exit(0);
    });
    const { ctx, services, cwd, emitted, logs } = setup(backend);
    cwdSeen = cwd;

    const result = await runAgentStep(ctx, services, { projectId: "p1", adapterId: "claude-code", cwd, prompt: "Build the UI", readOnly: false });

    expect(opened).toHaveLength(1);
    const args = opened[0]!.args!;
    expect(args).not.toContain("-p");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
    expect(result.resultText).toBe("Implemented the screen.");
    expect(result.filesChanged).toEqual(["src/App.tsx"]);
    expect(result.usage).toEqual({ inputTokens: 250, outputTokens: 50 });
    expect(result.externalSessionId).toBe(args[args.indexOf("--session-id") + 1]);
    expect(emitted.map((e) => e.type)).toContain("session.completed");
    expect(logs.some((l) => (l.data as { kind?: string } | undefined)?.kind === "terminal")).toBe(true);
    expect(closed).toEqual([opened[0]!.terminalId]);
    // The task file is only needed while the session runs.
    const taskFile = args[0]!.match(/Your task is in (.+?)\. Read/)?.[1];
    expect(taskFile && existsSync(taskFile)).toBe(false);
  });

  it("fails when Claude exits before finishing, and reports usage limits as RATE_LIMITED", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "ff-claude-"));
    const early = fakeTerminals(configDir, (write, exit) => {
      write({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Working" }], stop_reason: "tool_use" } });
      exit(1);
    });
    const a = setup(early.backend);
    await expect(runAgentStep(a.ctx, a.services, { projectId: "p1", adapterId: "claude-code", cwd: a.cwd, prompt: "x", readOnly: false })).rejects.toMatchObject({
      code: "AGENT_SESSION_FAILED",
    });

    const limited = fakeTerminals(configDir, (write) => {
      write({ type: "assistant", isApiErrorMessage: true, apiErrorStatus: 429, message: { content: [{ type: "text", text: "5-hour limit reached ∙ resets 3pm" }] } });
    });
    const b = setup(limited.backend);
    await expect(runAgentStep(b.ctx, b.services, { projectId: "p1", adapterId: "claude-code", cwd: b.cwd, prompt: "x", readOnly: false })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(limited.closed).toHaveLength(1);
  });

  it("keeps read-only steps from editing without plan mode", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "ff-claude-"));
    const { backend, opened } = fakeTerminals(configDir, (write, exit) => {
      write({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Analysis." }], stop_reason: "end_turn" } });
      exit(0);
    });
    const { ctx, services, cwd } = setup(backend);
    await runAgentStep(ctx, services, { projectId: "p1", adapterId: "claude-code", cwd, prompt: "Analyse", readOnly: true });
    const args = opened[0]!.args!;
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Edit");
  });

  it("loads the user's project settings, except a file Claude would stop on with a warning dialog", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "ff-claude-"));
    const { backend, opened } = fakeTerminals(configDir, (write, exit) => {
      write({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" } });
      exit(0);
    });
    const { ctx, services, cwd, logs } = setup(backend);
    await runAgentStep(ctx, services, { projectId: "p1", adapterId: "claude-code", cwd, prompt: "x", readOnly: false, projectSettings: true });
    expect(opened[0]!.args).not.toContain("--setting-sources");

    mkdirSync(path.join(cwd, ".claude"));
    writeFileSync(path.join(cwd, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["*"] } }));
    await runAgentStep(ctx, services, { projectId: "p1", adapterId: "claude-code", cwd, prompt: "x", readOnly: false, projectSettings: true });
    const args = opened[1]!.args!;
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user,project");
    expect(logs.some((l) => l.message.includes("settings.local.json") && l.message.includes('"*"'))).toBe(true);
  });

  it("keeps the session open while work left in the background has not produced the output yet", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "ff-claude-"));
    const report = path.join(mkdtempSync(path.join(tmpdir(), "ff-report-")), "acceptance-tests.md");
    let finished = false;
    let finishedEarly = false;
    const { backend } = fakeTerminals(configDir, (write) => {
      write({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Monitor", input: { command: "tail -f e2e.log" } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } } });
      write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Monitor started" }] } });
      write({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Waiting for the test run." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } });
      // Past the settle time: without the background wait the step would already be done.
      setTimeout(() => {
        finishedEarly = finished;
        write({ type: "user", isMeta: true, message: { role: "user", content: "<task-notification>tests finished</task-notification>" } });
        writeFileSync(report, "## Kết luận\nĐạt\n");
        write({ type: "assistant", message: { id: "m3", content: [{ type: "text", text: "Report written." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } });
      }, 9000);
    });
    const { ctx, services, cwd, logs } = setup(backend);
    const result = await runAgentStep(ctx, services, { projectId: "p1", adapterId: "claude-code", cwd, prompt: "Run the tests", readOnly: false, outputReady: () => existsSync(report) });
    finished = true;
    expect(finishedEarly).toBe(false);
    expect(result.resultText).toBe("Report written.");
    expect(logs.some((l) => l.message.includes("waiting for work it left in the background"))).toBe(true);
  }, 30_000);
});
