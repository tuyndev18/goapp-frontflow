import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { CodexCliAdapter } from "./adapters/codex.js";
import { FakeCliAdapter, type FakeCliAdapterOptions } from "./adapters/fake.js";
import { GeminiCliAdapter } from "./adapters/pty-fallback.js";
import type { AiCliAdapter } from "./types.js";

export interface DefaultAdaptersOptions {
  includeFake?: boolean;
  fake?: FakeCliAdapterOptions;
}

/** claude-code, codex, gemini and (by default) the fake adapter. */
export function createDefaultAdapters(options: DefaultAdaptersOptions = {}): AiCliAdapter[] {
  const adapters: AiCliAdapter[] = [new ClaudeCodeAdapter(), new CodexCliAdapter(), new GeminiCliAdapter()];
  if (options.includeFake ?? true) adapters.push(new FakeCliAdapter(options.fake));
  return adapters;
}
