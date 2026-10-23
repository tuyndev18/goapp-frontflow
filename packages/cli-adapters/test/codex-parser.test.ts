import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@frontflow/event-schema";
import { buildCodexArgs, createCodexParseState, parseCodexJsonLine } from "../src/index.js";

const cwd = path.resolve("/work/app");
const ctx = { traceId: "t1", workflowRunId: "r1", sessionId: "ses_1", cwd };

// Recorded from `codex exec --json` (trimmed).
const SAMPLE = [
  '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Scanning the repo**"}}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"src\\npackage.json\\n","exit_code":0,"status":"completed"}}',
  JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "file_change",
      changes: [
        { path: path.join(cwd, "src", "Login.tsx"), kind: "add" },
        { path: "src/App.tsx", kind: "update" },
        { path: "src/old.ts", kind: "delete" },
      ],
      status: "completed",
    },
  }),
  '{"type":"item.started","item":{"id":"item_3","type":"mcp_tool_call","server":"figma","tool":"get_design_context","arguments":{"nodeId":"1:2"},"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"mcp_tool_call","server":"figma","tool":"get_design_context","arguments":{"nodeId":"1:2"},"result":{"content":[]},"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"Added the login screen."}}',
  '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122}}',
];

function parseAll(lines: string[]): AgentEvent[] {
  const state = createCodexParseState();
  return lines.flatMap((l) => parseCodexJsonLine(l, ctx, state));
}

describe("parseCodexJsonLine", () => {
  it("maps a recorded JSONL stream to normalized events", () => {
    const events = parseAll(SAMPLE);
    expect(events[0]).toMatchObject({
      type: "session.started",
      payload: { adapterId: "codex", externalSessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53", cwd },
    });
    expect(events.filter((e) => e.type === "command.started")).toHaveLength(1);
    expect(events.find((e) => e.type === "command.completed")?.payload).toMatchObject({
      commandId: "item_1",
      command: "bash -lc ls",
      exitCode: 0,
    });
    expect(events.filter((e) => e.type === "file.changed").map((e) => e.payload)).toEqual([
      { path: "src/Login.tsx", change: "created" },
      { path: "src/App.tsx", change: "modified" },
      { path: "src/old.ts", change: "deleted" },
    ]);
    const mcp = events.filter((e) => e.type === "tool.started" || e.type === "tool.completed").filter((e) => e.payload.toolCallId === "item_3");
    expect(mcp.map((e) => e.type)).toEqual(["tool.started", "tool.completed"]);
    expect(mcp[0]?.payload).toMatchObject({ name: "mcp:figma/get_design_context" });
    expect(events.find((e) => e.type === "message.delta")?.payload).toEqual({ role: "assistant", text: "Added the login screen." });
    // input_tokens already include the cached ones.
    expect(events.find((e) => e.type === "usage.updated")?.payload).toEqual({ inputTokens: 24763, outputTokens: 122, cacheReadTokens: 24448, scope: "turn" });
    expect(events.at(-1)).toMatchObject({
      type: "session.completed",
      payload: { externalSessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53", result: "Added the login screen." },
    });
  });

  it("synthesizes a start for items that only complete, and flags failed commands", () => {
    const events = parseAll([
      '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"npm test","aggregated_output":"fail","exit_code":1,"status":"failed"}}',
    ]);
    expect(events.map((e) => e.type)).toEqual([
      "tool.started",
      "status.changed",
      "command.started",
      "command.completed",
      "tool.completed",
    ]);
    expect(events.find((e) => e.type === "tool.completed")?.payload).toMatchObject({ ok: false });
  });

  it("treats turn.failed as fatal and top-level error as transient status", () => {
    const state = createCodexParseState();
    const transient = parseCodexJsonLine('{"type":"error","message":"Reconnecting... 1/5"}', ctx, state);
    expect(transient).toMatchObject([{ type: "status.changed", payload: { detail: "error: Reconnecting... 1/5" } }]);
    const failed = parseCodexJsonLine('{"type":"turn.failed","error":{"message":"stream disconnected"}}', ctx, state);
    expect(failed).toMatchObject([{ type: "session.failed", payload: { code: "TURN_FAILED", message: "stream disconnected" } }]);
    expect(parseCodexJsonLine("not json", ctx, state)).toEqual([]);
  });

  it("builds exec / resume argv reading the prompt from stdin", () => {
    expect(buildCodexArgs({ cwd: "/w", model: "gpt-5", sandbox: "workspace-write" })).toEqual([
      "exec", "--json", "--skip-git-repo-check", "-C", "/w", "--model", "gpt-5", "--sandbox", "workspace-write", "-",
    ]);
    expect(buildCodexArgs({ cwd: "/w", resumeId: "th_1" }).slice(-3)).toEqual(["resume", "th_1", "-"]);
  });
});
