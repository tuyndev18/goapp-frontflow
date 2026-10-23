import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, CodexCliAdapter, FakeCliAdapter, TerminalManager, loadNodePty } from "../src/index.js";

const FAKE = fileURLToPath(new URL("../../../tests/fixtures/fake-cli/fake-cli.mjs", import.meta.url));
const hasPty = !!(await loadNodePty());

describe("interactive launch", () => {
  it("resumes the CLI's own conversation", () => {
    expect(new ClaudeCodeAdapter().interactiveLaunch({ externalSessionId: "abc" })).toMatchObject({ command: "claude", args: ["--resume", "abc"] });
    expect(new ClaudeCodeAdapter().interactiveLaunch({})).toMatchObject({ args: [] });
    expect(new CodexCliAdapter().interactiveLaunch({ externalSessionId: "t1" })).toMatchObject({ command: "codex", args: ["resume", "t1"] });
  });

  it("names a fresh Claude conversation so it can be resumed later", () => {
    expect(new ClaudeCodeAdapter().interactiveLaunch({ newSessionId: "9d6f…" })).toMatchObject({ args: ["--session-id", "9d6f…"] });
    // Resuming wins over naming.
    expect(new ClaudeCodeAdapter().interactiveLaunch({ externalSessionId: "abc", newSessionId: "x" })).toMatchObject({ args: ["--resume", "abc"] });
  });

  it("gives the PTY the allow-listed environment only", async () => {
    let spawnedEnv: Record<string, string> = {};
    const fakePty = {
      spawn: (_file: string, _args: unknown, opts: { env: Record<string, string> }) => {
        spawnedEnv = opts.env;
        return { pid: 1, onData: () => undefined, onExit: () => undefined, write: () => undefined, kill: () => undefined };
      },
    };
    const saved = { ...process.env };
    process.env["CLAUDE_CONFIG_DIR"] = "/profiles/a";
    process.env["GITHUB_TOKEN"] = "ghp_secret";
    process.env["FRONTFLOW_INTERNAL"] = "1";
    try {
      const fake = new FakeCliAdapter({ scriptPath: FAKE, sessionEnv: { FAKE_MODE: "x" } });
      const claude = new ClaudeCodeAdapter();
      const manager = new TerminalManager((id) => (id === "fake" ? fake : claude), {
        onData: () => undefined,
        onExit: () => undefined,
        ptyLoader: async () => fakePty as never,
      });
      await manager.open({ terminalId: "t1", adapterId: "fake", cwd: process.cwd(), cols: 80, rows: 24 });
      expect(spawnedEnv["FAKE_MODE"]).toBe("x");
      expect(spawnedEnv["TERM"]).toBe("xterm-256color");
      expect(spawnedEnv).not.toHaveProperty("GITHUB_TOKEN");
      expect(spawnedEnv).not.toHaveProperty("FRONTFLOW_INTERNAL");
      expect(Object.keys(spawnedEnv).some((k) => k.toUpperCase() === "PATH")).toBe(true);
      expect(claude.interactiveLaunch({})?.inheritKeys).toContain("CLAUDE_CONFIG_DIR");
    } finally {
      process.env = saved;
    }
  });
});

describe.skipIf(!hasPty)("TerminalManager", () => {
  it("runs the CLI interactively in a PTY so the user can type into it", async () => {
    const output: string[] = [];
    let exitCode: number | null | undefined;
    const fake = new FakeCliAdapter({ scriptPath: FAKE });
    const manager = new TerminalManager(() => fake, {
      onData: (_id, data) => output.push(data),
      onExit: (_id, code) => (exitCode = code),
    });
    const opened = await manager.open({ terminalId: "t1", adapterId: "fake", externalSessionId: "s-1", cwd: process.cwd(), cols: 80, rows: 24 });
    expect(opened.pid).toBeGreaterThan(0);

    const waitFor = async (text: string) => {
      for (let i = 0; i < 100 && !output.join("").includes(text); i++) await new Promise((r) => setTimeout(r, 50));
      expect(output.join("")).toContain(text);
    };
    await waitFor("resumed s-1");
    manager.resize("t1", 120, 30);
    manager.write("t1", "hello\r");
    await waitFor("fake: hello");
    manager.write("t1", "exit\r");
    for (let i = 0; i < 100 && exitCode === undefined; i++) await new Promise((r) => setTimeout(r, 50));
    expect(exitCode).toBe(0);
  });

  it("refuses adapters without an interactive mode and unknown terminals", async () => {
    const manager = new TerminalManager(() => undefined, { onData: () => {}, onExit: () => {} });
    await expect(manager.open({ terminalId: "x", adapterId: "nope", cwd: process.cwd(), cols: 80, rows: 24 })).rejects.toThrow(/no interactive mode/);
    expect(() => manager.write("missing", "a")).toThrow(/not open/);
  });
});
