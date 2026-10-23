import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FakeCliAdapter } from "../src/index.js";
import { runAdapterContractSuite } from "./contract-suite.js";
import { collect, ctxInput, tempDir } from "./helpers.js";

const stateDir = tempDir("ff-fake-state-");
afterAll(() => stateDir.cleanup());

runAdapterContractSuite("FakeCliAdapter", () => new FakeCliAdapter({ sessionEnv: { FAKE_CLI_STATE_DIR: stateDir.dir } }), {
  prompts: {
    success: "Implement the login form scenario:success",
    approval: "Write a file scenario:approval",
    slow: "Long task scenario:slow",
    crash: "Crash please scenario:crash",
  },
  approvalFile: "approved.txt",
});

describe("FakeCliAdapter specifics", () => {
  const ws = tempDir("ff-fake-");
  afterAll(() => ws.cleanup());

  it("writes the file it reports and emits tool/command/file/usage events", async () => {
    const adapter = new FakeCliAdapter();
    const session = await adapter.start({ ...ctxInput, cwd: ws.dir, prompt: "go scenario:success" });
    const c = collect(adapter, session.id);
    await c.done();
    const types = c.events.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "session.started",
        "tool.started",
        "tool.completed",
        "command.started",
        "command.completed",
        "file.changed",
        "usage.updated",
        "session.completed",
      ]),
    );
    const file = c.events.find((e) => e.type === "file.changed");
    expect(file?.type === "file.changed" && file.payload).toEqual({ path: "fake-output.txt", change: "created" });
    expect(existsSync(path.join(ws.dir, "fake-output.txt"))).toBe(true);
    const usage = c.events.find((e) => e.type === "usage.updated");
    expect(usage?.type === "usage.updated" && usage.payload).toEqual({
      inputTokens: 115,
      outputTokens: 50,
      cacheReadTokens: 5,
      cacheWriteTokens: 10,
      costUsd: 0.0123,
      scope: "total",
    });
    const end = c.events.at(-1);
    expect(end?.type === "session.completed" && end.payload.exitCode).toBe(0);
    expect(adapter.getSession(session.id)?.status).toBe("completed");
    expect(adapter.getSession(session.id)?.externalSessionId).toBeTruthy();
  });

  it("fail scenario maps an is_error result to session.failed", async () => {
    const adapter = new FakeCliAdapter();
    const session = await adapter.start({ ...ctxInput, cwd: ws.dir, prompt: "x", env: { FAKE_CLI_SCENARIO: "fail" } });
    const c = collect(adapter, session.id);
    const end = await c.done();
    expect(end.type).toBe("session.failed");
    expect(end.type === "session.failed" && end.payload).toMatchObject({
      code: "ERROR_DURING_EXECUTION",
      message: "Simulated failure",
      exitCode: 1,
    });
  });

  it("resume reuses the external session id and keeps CLI-side state", async () => {
    const state = tempDir("ff-fake-resume-");
    const adapter = new FakeCliAdapter({ sessionEnv: { FAKE_CLI_STATE_DIR: state.dir } });
    const s1 = await adapter.start({ ...ctxInput, cwd: ws.dir, prompt: "one" });
    await collect(adapter, s1.id).done();
    const ext = adapter.getSession(s1.id)?.externalSessionId;
    expect(ext).toBeTruthy();
    const s2 = await adapter.resume({ ...ctxInput, cwd: ws.dir, prompt: "two", externalSessionId: ext! });
    const c2 = collect(adapter, s2.id);
    const end = await c2.done();
    expect(end.type === "session.completed" && end.payload.result).toBe("Completed prompt #2");
    expect(JSON.parse(readFileSync(path.join(state.dir, `${ext}.json`), "utf8"))).toEqual({ prompts: 2 });
    state.cleanup();
  });

  it("queued prompts each get a turn before the session completes", async () => {
    const adapter = new FakeCliAdapter();
    const session = await adapter.start({ ...ctxInput, cwd: ws.dir, prompt: "first" });
    const c = collect(adapter, session.id);
    await adapter.send(session.id, "second");
    const end = await c.done();
    expect(end.type === "session.completed" && end.payload.result).toBe("Completed prompt #2");
    expect(c.events.filter((e) => e.type === "usage.updated")).toHaveLength(2);
  });
});
