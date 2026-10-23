import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@frontflow/event-schema";
import {
  buildClaudeArgs,
  claudeUserMessage,
  createClaudeParseState,
  parseClaudeStreamLine,
  parseFakeCliLine,
} from "../src/index.js";

const cwd = path.resolve("/work/app");
const ctx = { traceId: "t1", workflowRunId: "r1", sessionId: "ses_1", cwd };

// Recorded from `claude -p --output-format stream-json --verbose` (trimmed).
const SAMPLE = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    cwd,
    session_id: "0b8b6a3e-2f7c-4a51-9d0e-5b1b2c3d4e5f",
    tools: ["Task", "Bash", "Read", "Edit", "Write"],
    mcp_servers: [{ name: "frontflow", status: "connected" }],
    model: "claude-sonnet-4-5-20250929",
    permissionMode: "acceptEdits",
    apiKeySource: "none",
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_01",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [{ type: "text", text: "I'll add the login form." }],
      stop_reason: null,
      usage: { input_tokens: 4, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    session_id: "0b8b6a3e-2f7c-4a51-9d0e-5b1b2c3d4e5f",
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_02",
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "npm test", description: "Run tests" } },
      ],
    },
    session_id: "0b8b6a3e-2f7c-4a51-9d0e-5b1b2c3d4e5f",
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ tool_use_id: "toolu_01", type: "tool_result", content: "Error: Exit code 2\nnpm ERR! test failed", is_error: true }],
    },
    session_id: "0b8b6a3e-2f7c-4a51-9d0e-5b1b2c3d4e5f",
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_03",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_02",
          name: "Write",
          input: { file_path: path.join(cwd, "src", "LoginForm.tsx"), content: "export {}" },
        },
        { type: "tool_use", id: "toolu_03", name: "Edit", input: { file_path: "src/App.tsx", old_string: "a", new_string: "b" } },
      ],
    },
    session_id: "0b8b6a3e-2f7c-4a51-9d0e-5b1b2c3d4e5f",
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { tool_use_id: "toolu_02", type: "tool_result", content: [{ type: "text", text: "File created successfully" }] },
        { tool_use_id: "toolu_03", type: "tool_result", content: "The file src/App.tsx has been updated." },
      ],
    },
    session_id: "0b8b6a3e-2f7c-4a51-9d0e-5b1b2c3d4e5f",
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 12034,
    num_turns: 5,
    result: "Login form added.",
    session_id: "0b8b6a3e-2f7c-4a51-9d0e-5b1b2c3d4e5f",
    total_cost_usd: 0.0421,
    usage: { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 500, output_tokens: 640 },
  }),
];

function parseAll(lines: string[]): AgentEvent[] {
  const state = createClaudeParseState();
  return lines.flatMap((l) => parseClaudeStreamLine(l, ctx, state));
}

describe("parseClaudeStreamLine", () => {
  it("maps a recorded stream to normalized events", () => {
    const events = parseAll(SAMPLE);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("session.started");
    expect(types.at(-1)).toBe("session.completed");

    const started = events[0];
    expect(started?.type === "session.started" && started.payload).toEqual({
      adapterId: "claude-code",
      cwd,
      externalSessionId: "0b8b6a3e-2f7c-4a51-9d0e-5b1b2c3d4e5f",
      model: "claude-sonnet-4-5-20250929",
    });

    const text = events.find((e) => e.type === "message.delta");
    expect(text?.type === "message.delta" && text.payload).toEqual({ role: "assistant", text: "I'll add the login form." });

    const cmdDone = events.find((e) => e.type === "command.completed");
    expect(cmdDone?.type === "command.completed" && cmdDone.payload).toMatchObject({
      commandId: "toolu_01",
      command: "npm test",
      exitCode: 2,
    });
    const bash = events.find((e) => e.type === "tool.completed" && e.payload.toolCallId === "toolu_01");
    expect(bash?.type === "tool.completed" && bash.payload).toMatchObject({ name: "Bash", ok: false });

    const files = events.filter((e) => e.type === "file.changed").map((e) => e.payload);
    expect(files).toEqual([
      { path: "src/LoginForm.tsx", change: "created" },
      { path: "src/App.tsx", change: "modified" },
    ]);

    const usage = events.filter((e) => e.type === "usage.updated").map((e) => e.payload);
    // One report per API message (dedup key = message id), then the CLI's running total with its own cost.
    expect(usage[0]).toEqual({ inputTokens: 4, outputTokens: 1, model: "claude-sonnet-4-5-20250929", scope: "message", messageId: "msg_01" });
    expect(usage.at(-1)).toMatchObject({ inputTokens: 2000, outputTokens: 640, costUsd: 0.0421, scope: "total" });

    const done = events.at(-1);
    expect(done?.type === "session.completed" && done.payload).toEqual({
      externalSessionId: "0b8b6a3e-2f7c-4a51-9d0e-5b1b2c3d4e5f",
      result: "Login form added.",
    });

    for (const e of events) {
      expect(e).toMatchObject({ traceId: "t1", workflowRunId: "r1", sessionId: "ses_1" });
      expect(e.confidence).toBeUndefined();
      expect(e).not.toHaveProperty("cwd");
    }
  });

  it("maps error results to session.failed", () => {
    const state = createClaudeParseState();
    const max = parseClaudeStreamLine(
      JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, session_id: "s", num_turns: 10 }),
      ctx,
      state,
    );
    expect(max.at(-1)).toMatchObject({ type: "session.failed", payload: { code: "ERROR_MAX_TURNS" } });
    const apiErr = parseClaudeStreamLine(
      JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "API Error: 401", session_id: "s" }),
      ctx,
      state,
    );
    expect(apiErr.at(-1)).toMatchObject({ type: "session.failed", payload: { code: "CLI_ERROR", message: "API Error: 401" } });
  });

  it("ignores non-JSON, partial and unknown lines", () => {
    const state = createClaudeParseState();
    expect(parseClaudeStreamLine("Loading...", ctx, state)).toEqual([]);
    expect(parseClaudeStreamLine('{"type":"assistant","message":{"content":[{"type":"te', ctx, state)).toEqual([]);
    expect(parseClaudeStreamLine(JSON.stringify({ type: "stream_event", event: {} }), ctx, state)).toEqual([]);
    expect(parseClaudeStreamLine(JSON.stringify({ type: "system", subtype: "compact_boundary" }), ctx, state)).toEqual([]);
  });

  it("parses the fake CLI approval extension", () => {
    const events = parseFakeCliLine(
      JSON.stringify({ type: "approval_request", request_id: "req_1", tool_name: "Write", action: "Write a.txt" }),
      { ...ctx, adapterId: "fake" },
      createClaudeParseState(),
    );
    expect(events.map((e) => e.type)).toEqual(["approval.required", "status.changed"]);
    expect(events[0]?.payload).toEqual({ requestId: "req_1", action: "Write a.txt", permissionClass: "write_project" });
  });

  it("builds argv without prompt or secrets and stdin messages", () => {
    const args = buildClaudeArgs({
      model: "sonnet",
      resumeId: "abc",
      mcpConfigPath: "/tmp/mcp.json",
      systemPrompt: "Follow conventions",
      allowedTools: ["Read", "Edit"],
      disallowedTools: ["Bash", "PowerShell"],
      permissionMode: "acceptEdits",
    });
    expect(args.slice(0, 6)).toEqual(["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"]);
    expect(args).toEqual(
      expect.arrayContaining(["--resume", "abc", "--model", "sonnet", "--mcp-config", "/tmp/mcp.json", "--allowedTools", "Read,Edit", "--disallowedTools", "Bash,PowerShell"]),
    );
    expect(args).toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits", "--append-system-prompt"]));
    expect(JSON.parse(claudeUserMessage("hi"))).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
  });
});
