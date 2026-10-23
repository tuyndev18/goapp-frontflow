// Real AI CLI smoke tests. Opt-in only: FRONTFLOW_REAL_CLI=1 (makes paid API calls).
import { afterAll, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, CodexCliAdapter, GeminiCliAdapter, type AiCliAdapter } from "../src/index.js";
import { collect, ctxInput, tempDir } from "./helpers.js";

const enabled = process.env.FRONTFLOW_REAL_CLI === "1";

describe.runIf(enabled)("real CLIs", () => {
  const ws = tempDir("ff-real-");
  afterAll(() => ws.cleanup());

  it.each<[string, () => AiCliAdapter]>([
    ["claude-code", () => new ClaudeCodeAdapter()],
    ["codex", () => new CodexCliAdapter()],
    ["gemini", () => new GeminiCliAdapter()],
  ])("detects %s", async (_name, make) => {
    const d = await make().detect();
    expect(typeof d.installed).toBe("boolean");
    if (d.installed) expect(d.version).toMatch(/\d+\.\d+/);
  });

  it("claude-code: one headless turn, then resume", async ({ skip }) => {
    const adapter = new ClaudeCodeAdapter();
    if (!(await adapter.detect()).installed) skip();
    const model = process.env.FRONTFLOW_REAL_CLI_MODEL ?? "haiku";
    const session = await adapter.start({
      ...ctxInput,
      cwd: ws.dir,
      model,
      prompt: "Reply with exactly the word PONG and nothing else. Do not use tools.",
      timeoutMs: 120_000,
    });
    const c = collect(adapter, session.id);
    const end = await c.done(125_000);
    expect(end.type, JSON.stringify(end.payload)).toBe("session.completed");
    expect(c.events[0]?.type).toBe("session.started");
    expect(c.events.some((e) => e.type === "usage.updated")).toBe(true);
    const ext = adapter.getSession(session.id)?.externalSessionId;
    expect(ext).toBeTruthy();

    const resumed = await adapter.resume({
      ...ctxInput,
      cwd: ws.dir,
      model,
      externalSessionId: ext!,
      prompt: "What word did you reply with? Answer with that single word.",
      timeoutMs: 120_000,
    });
    const c2 = collect(adapter, resumed.id);
    const end2 = await c2.done(125_000);
    expect(end2.type === "session.completed" && end2.payload.result).toMatch(/PONG/i);
  }, 260_000);
});
