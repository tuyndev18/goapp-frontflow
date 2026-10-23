import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StartSessionInput } from "@frontflow/cli-adapters";
import { createAgentEvent, type AgentEvent } from "@frontflow/event-schema";
import type { NodeExecutionContext } from "@frontflow/workflow-engine";
import { isClaudeScratchpad, runAgentStep } from "../src/agent.js";
import type { NodeServices } from "../src/services.js";

const SCRATCH = path.join(tmpdir(), "claude", "D--Proj", "bf27de6d", "scratchpad");

/** A fake headless session that reports the given file writes, then completes. */
function setup(writes: string[]) {
  const cwd = mkdtempSync(path.join(tmpdir(), "ff-agent-scope-"));
  const logs: string[] = [];
  let handler: ((e: AgentEvent) => void) | undefined;
  const ids = { traceId: "trace_1", workflowRunId: "run_1", nodeRunId: "nr_1", sessionId: "ses_1" };
  const ctx = {
    runId: "run_1",
    projectId: "p1",
    nodeId: "B1.implement_ui",
    nodeRunId: "nr_1",
    nodeType: "ai.implement_ui",
    attempt: 1,
    traceId: "trace_1",
    signal: new AbortController().signal,
    log: (_level: string, message: string) => logs.push(message),
    emitArtifact: () => undefined,
    emit: () => undefined,
  } as unknown as NodeExecutionContext;
  const services = {
    agents: {
      async start(adapterId: string, input: StartSessionInput) {
        setTimeout(() => {
          for (const file of writes) handler?.(createAgentEvent("file.changed", ids, { path: file, change: "created" }));
          handler?.(createAgentEvent("session.completed", ids, { result: "done" }));
        }, 5);
        return { id: "ses_1", adapterId, status: "running", cwd: input.cwd, startedAt: "" };
      },
      resume: () => Promise.reject(new Error("no")),
      cancel: async () => undefined,
      subscribeAll: (h: (e: AgentEvent) => void) => {
        handler = h;
        return () => (handler = undefined);
      },
    },
    settings: () => ({ allowArbitraryShell: false, commandTimeoutMs: 1000, agentTimeoutMs: 20_000, fixBudget: 1 }),
    mcpConfigDir: path.join(cwd, ".mcp"),
  } as unknown as NodeServices;
  const run = () => runAgentStep(ctx, services, { projectId: "p1", adapterId: "fake", cwd, prompt: "Build the UI", readOnly: false });
  return { cwd, logs, run };
}

describe("isClaudeScratchpad", () => {
  it("accepts only files under <tmp>/claude/<project>/<session>/scratchpad", () => {
    const tmp = path.resolve("/t");
    expect(isClaudeScratchpad(path.join(tmp, "claude", "D--Proj", "abc", "scratchpad", "probe.mjs"), tmp)).toBe(true);
    expect(isClaudeScratchpad(path.join(tmp, "claude", "D--Proj", "abc", "scratchpad", "a", "b.txt"), tmp)).toBe(true);
    expect(isClaudeScratchpad(path.join(tmp, "claude", "D--Proj", "abc", "scratchpad"), tmp)).toBe(false);
    expect(isClaudeScratchpad(path.join(tmp, "claude", "D--Proj", "abc", "tasks", "x.output"), tmp)).toBe(false);
    expect(isClaudeScratchpad(path.join(tmp, "claude", "D--Proj", "scratchpad", "x"), tmp)).toBe(false);
    expect(isClaudeScratchpad(path.join(tmp, "other", "D--Proj", "abc", "scratchpad", "x"), tmp)).toBe(false);
    expect(isClaudeScratchpad(path.join(tmp, "claude", "D--Proj", "abc", "scratchpad", "..", "..", "..", "..", "evil"), tmp)).toBe(false);
  });
});

describe("agent file writes outside the step folder", () => {
  it("allows Claude Code's scratchpad and keeps it out of the changed files", async () => {
    const { logs, run } = setup([path.join(SCRATCH, "probe-dm.mjs"), "src/page.tsx"]);
    const result = await run();
    expect(result.filesChanged).toEqual(["src/page.tsx"]);
    expect(logs.some((l) => l.startsWith("AI wrote temporary files in its Claude Code scratchpad") && l.includes("probe-dm.mjs"))).toBe(true);
  });

  it("still fails any other write outside the project", async () => {
    const elsewhere = path.join(tmpdir(), "ff-elsewhere", "x.txt");
    const { run } = setup([path.join(SCRATCH, "probe-dm.mjs"), elsewhere]);
    await expect(run()).rejects.toMatchObject({ code: "PERMISSION_DENIED", message: expect.stringContaining("x.txt") });
  });
});
