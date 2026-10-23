import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaudeInteractiveArgs, claudeProjectSettingsProblems } from "../src/adapters/claude-code.js";
import {
  claudeProjectSlug,
  createClaudeTranscriptState,
  findClaudeTranscript,
  parseClaudeTranscriptLine,
  transcriptUsage,
} from "../src/adapters/claude-transcript.js";

const ctx = { traceId: "trace_1", workflowRunId: "run_1", nodeRunId: "nr_1", sessionId: "ses_1", cwd: "/work" };
const line = (v: unknown) => JSON.stringify(v);
const assistant = (id: string, content: unknown[], stop: string, usage = { input_tokens: 10, output_tokens: 5 }) =>
  line({ type: "assistant", message: { id, role: "assistant", content, stop_reason: stop, usage } });

describe("claude transcript", () => {
  it("names project folders like Claude Code (every non-alphanumeric becomes -)", () => {
    expect(claudeProjectSlug("C:\\Users\\me\\AppData\\Roaming\\@frontflow\\run_1")).toBe("C--Users-me-AppData-Roaming--frontflow-run-1");
  });

  it("finds the transcript by slug, or by scanning when the slug differs", () => {
    const config = mkdtempSync(path.join(tmpdir(), "ff-claude-"));
    mkdirSync(path.join(config, "projects", "some-other-slug"), { recursive: true });
    writeFileSync(path.join(config, "projects", "some-other-slug", "abc.jsonl"), "");
    expect(findClaudeTranscript(config, "/work", "abc")).toBe(path.join(config, "projects", "some-other-slug", "abc.jsonl"));
    expect(findClaudeTranscript(config, "/work", "missing")).toBeUndefined();
  });

  it("maps tool use, results and file edits, and detects the end of the turn", () => {
    const state = createClaudeTranscriptState();
    const prompt = parseClaudeTranscriptLine(line({ type: "user", message: { role: "user", content: "do it" }, turnOrigin: "human" }), ctx, state);
    expect(prompt.humanPrompt).toBe(true);

    const use = parseClaudeTranscriptLine(
      assistant("msg_1", [{ type: "text", text: "Editing." }, { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/work/src/a.ts" } }], "tool_use"),
      ctx,
      state,
    );
    // Per-message usage comes first, keyed by the API message id.
    expect(use.events.map((e) => e.type)).toEqual(["usage.updated", "message.delta", "tool.started", "status.changed"]);
    expect(use.events[0]?.payload).toMatchObject({ scope: "message", messageId: "msg_1" });
    expect(state.turnEnded).toBe(false);

    const result = parseClaudeTranscriptLine(
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }, toolUseResult: { type: "create" } }),
      ctx,
      state,
    );
    expect(result.humanPrompt).toBe(false);
    expect(result.events.find((e) => e.type === "file.changed")?.payload).toEqual({ path: "src/a.ts", change: "created" });

    parseClaudeTranscriptLine(assistant("msg_2", [{ type: "text", text: "Done. ```json\n{\"ok\":true}\n```" }], "end_turn", { input_tokens: 20, output_tokens: 7 }), ctx, state);
    expect(state.turnEnded).toBe(true);
    expect(state.tools.size).toBe(0);
    expect(state.answer.join("\n")).toContain('{"ok":true}');
    expect(state.answer.join("\n")).not.toContain("Editing.");
    expect(transcriptUsage(state)).toEqual({ inputTokens: 30, outputTokens: 12 });
  });

  it("reopens the turn when the user keeps chatting, and ignores meta entries", () => {
    const state = createClaudeTranscriptState();
    parseClaudeTranscriptLine(assistant("m1", [{ type: "text", text: "Which one?" }], "end_turn"), ctx, state);
    expect(state.turnEnded).toBe(true);
    expect(parseClaudeTranscriptLine(line({ type: "user", isMeta: true, message: { role: "user", content: "[Image]" } }), ctx, state).humanPrompt).toBe(false);
    expect(state.turnEnded).toBe(true);
    expect(parseClaudeTranscriptLine(line({ type: "user", message: { role: "user", content: [{ type: "text", text: "the first" }] } }), ctx, state).humanPrompt).toBe(true);
    expect(state.turnEnded).toBe(false);
  });

  it("flags usage limits from API error entries but not other API errors", () => {
    const state = createClaudeTranscriptState();
    parseClaudeTranscriptLine(line({ type: "assistant", isApiErrorMessage: true, apiErrorStatus: 529, message: { content: [{ type: "text", text: "Overloaded" }] } }), ctx, state);
    expect(state.rateLimit).toBeUndefined();
    parseClaudeTranscriptLine(
      line({ type: "assistant", isApiErrorMessage: true, message: { content: [{ type: "text", text: "Claude AI usage limit reached|1760000000" }] } }),
      ctx,
      state,
    );
    expect(state.rateLimit).toContain("usage limit");
  });

  it("puts the prompt before variadic tool lists in interactive argv", () => {
    const args = buildClaudeInteractiveArgs({ prompt: "Do the task", sessionId: "uuid-1", permissionMode: "acceptEdits", allowedTools: ["Read", "mcp__goapp-figma"] });
    expect(args[0]).toBe("Do the task");
    expect(args).toEqual(["Do the task", "--session-id", "uuid-1", "--permission-mode", "acceptEdits", "--allowedTools", "Read,mcp__goapp-figma"]);
    expect(args).not.toContain("-p");
  });

  it("finds project settings files the TUI would stop on with a warning dialog", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "ff-settings-"));
    expect(claudeProjectSettingsProblems(cwd)).toEqual([]);
    mkdirSync(path.join(cwd, ".claude"));
    const settings = path.join(cwd, ".claude", "settings.json");
    const local = path.join(cwd, ".claude", "settings.local.json");
    writeFileSync(settings, `﻿${JSON.stringify({ permissions: { allow: ["Bash(npm run *)", "mcp__goapp-figma__*", "Read"], deny: ["*"] } })}`);
    writeFileSync(local, JSON.stringify({ permissions: { allow: ["*", "Edit", "mcp__*"] } }));
    expect(claudeProjectSettingsProblems(cwd)).toEqual([{ source: "local", file: local, problem: 'unsupported permissions.allow rules "*", "mcp__*"' }]);
    writeFileSync(settings, "{ not json");
    expect(claudeProjectSettingsProblems(cwd).map((p) => [p.source, p.problem])).toEqual([
      ["project", "invalid JSON"],
      ["local", 'unsupported permissions.allow rules "*", "mcp__*"'],
    ]);
  });
});
