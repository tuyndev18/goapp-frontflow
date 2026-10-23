import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { AgentEvent } from "@frontflow/event-schema";
import { isRateLimitMessage } from "../rate-limit.js";
import { createClaudeParseState, parseClaudeMessage, type ClaudeParseContext, type ClaudeParseState } from "./claude-code.js";

/**
 * Following an interactive Claude Code session through its transcript
 * (`<config>/projects/<cwd slug>/<session id>.jsonl`). Transcript entries carry
 * the same `assistant` / `user` message shapes as `--output-format stream-json`,
 * plus bookkeeping entries that are ignored here.
 */
export interface ClaudeTranscriptState extends ClaudeParseState {
  /** Usage per API message id (one message spans several entries). */
  usage: Map<string, { input: number; output: number }>;
  /** Text of the latest assistant message: the step's answer. */
  answer: string[];
  answerId?: string;
  /** The last assistant message ended its turn (`stop_reason: "end_turn"`). */
  turnEnded: boolean;
  /** Set when the API refused for usage/rate limits. */
  rateLimit?: string;
}

export function createClaudeTranscriptState(): ClaudeTranscriptState {
  return { ...createClaudeParseState(), usage: new Map(), answer: [], turnEnded: false };
}

export interface TranscriptLineResult {
  events: AgentEvent[];
  /** A human typed into the session (not a tool result or meta entry). */
  humanPrompt: boolean;
}

/** Claude Code's project folder name for a working directory: every non-alphanumeric character becomes "-". */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Transcript path of `sessionId`; scans all project folders when the slug rule does not match (long paths). */
export function findClaudeTranscript(configDir: string, cwd: string, sessionId: string): string | undefined {
  const direct = path.join(configDir, "projects", claudeProjectSlug(cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  const root = path.join(configDir, "projects");
  if (!existsSync(root)) return undefined;
  for (const dir of readdirSync(root)) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function parseClaudeTranscriptLine(line: string, ctx: ClaudeParseContext, state: ClaudeTranscriptState): TranscriptLineResult {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return { events: [], humanPrompt: false };
  }
  if (!isObj(entry) || !isObj(entry.message)) return { events: [], humanPrompt: false };
  const message = entry.message;
  const content = Array.isArray(message.content) ? message.content : [];

  if (entry.type === "assistant") {
    const texts = content.flatMap((b) => (isObj(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : []));
    if (entry.isApiErrorMessage === true) {
      const text = texts.join("\n");
      if (entry.apiErrorStatus === 429 || isRateLimitMessage(text)) state.rateLimit = text || "API rate limit (429)";
      // The TUI shows (and retries) other API errors itself.
      return { events: [], humanPrompt: false };
    }
    if (typeof message.id === "string" && isObj(message.usage)) {
      const u = message.usage;
      state.usage.set(message.id, {
        input: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
        output: num(u.output_tokens),
      });
    }
    // The answer is the last assistant message (like stream-json's `result`), not the narration before it.
    if (message.id !== state.answerId) {
      state.answer = [];
      state.answerId = typeof message.id === "string" ? message.id : undefined;
    }
    state.answer.push(...texts);
    state.turnEnded = message.stop_reason === "end_turn";
    return { events: parseClaudeMessage({ type: "assistant", message }, ctx, state), humanPrompt: false };
  }

  if (entry.type === "user") {
    const toolResult = content.some((b) => isObj(b) && b.type === "tool_result");
    if (!toolResult) {
      const human = entry.isMeta !== true && (typeof message.content === "string" || content.length > 0);
      if (human) {
        state.answer = [];
        state.turnEnded = false;
      }
      return { events: [], humanPrompt: human };
    }
    const events = parseClaudeMessage(
      { type: "user", message, ...(isObj(entry.toolUseResult) ? { tool_use_result: entry.toolUseResult } : {}) },
      ctx,
      state,
    );
    state.turnEnded = false;
    return { events, humanPrompt: false };
  }
  return { events: [], humanPrompt: false };
}

export function transcriptUsage(state: ClaudeTranscriptState): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const u of state.usage.values()) {
    inputTokens += u.input;
    outputTokens += u.output;
  }
  return { inputTokens, outputTokens };
}
