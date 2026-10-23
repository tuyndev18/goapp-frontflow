import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REDACTED } from "@frontflow/event-schema";
import {
  buildChildEnv,
  escapeCmdArgument,
  loadNodePty,
  ProcessRunner,
  RawStreamRedactor,
  resolveExecutable,
  secretValuesOf,
  toSpawnCommand,
} from "../src/index.js";
import { tempDir } from "./helpers.js";

const isWin = process.platform === "win32";

describe("child env", () => {
  it("inherits only the minimal allow-list plus explicit env", () => {
    const env = buildChildEnv({
      source: { PATH: "/bin", HOME: "/h", AWS_SECRET_ACCESS_KEY: "x", NODE_OPTIONS: "--inspect", XDG_CONFIG_HOME: "/c" },
      env: { ANTHROPIC_API_KEY: "sk-ant-x" },
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", XDG_CONFIG_HOME: "/c", ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(buildChildEnv({ source: { PATH: "/bin" }, inherit: "none" })).toEqual({});
    expect(secretValuesOf({ ANTHROPIC_API_KEY: "sk-ant-123456", FAKE_CLI_SCENARIO: "success" })).toEqual(["sk-ant-123456"]);
  });
});

describe("RawStreamRedactor", () => {
  it("redacts secrets split across chunks", async () => {
    const out: string[] = [];
    const r = new RawStreamRedactor((t) => out.push(t), ["opaque-secret-value"]);
    r.push("token: opaque-sec");
    r.push("ret-value and GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz01\npartial");
    r.flush();
    const text = out.join("");
    expect(text).not.toContain("opaque-secret-value");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz01");
    expect(text).toContain(REDACTED);
    expect(text.endsWith("partial")).toBe(true);
  });
});

describe("ProcessRunner", () => {
  const ws = tempDir("ff-runner-");
  afterAll(() => ws.cleanup());
  const runner = new ProcessRunner();

  it("captures output, exit codes and redacted raw stream", async () => {
    const raw: string[] = [];
    const res = await runner.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('k='+process.env.MY_API_KEY+'\\n'); console.error('err'); process.exit(3)"],
      cwd: ws.dir,
      env: { MY_API_KEY: "plain-but-secret-123" },
      onRaw: (c) => raw.push(c),
    });
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toContain("plain-but-secret-123");
    expect(raw.join("")).not.toContain("plain-but-secret-123");
    expect(res.stderr).toContain("err");
  });

  it("does not leak parent secrets into the child env", async () => {
    process.env.FF_TEST_PARENT_SECRET_TOKEN = "parent-only";
    try {
      const res = await runner.run({
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify(Object.keys(process.env)))"],
        cwd: ws.dir,
      });
      expect(res.stdout).not.toContain("FF_TEST_PARENT_SECRET_TOKEN");
    } finally {
      delete process.env.FF_TEST_PARENT_SECRET_TOKEN;
    }
  });

  it("writes stdin, enforces timeout and kills the whole tree", async () => {
    const echo = await runner.run({
      command: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      cwd: ws.dir,
      input: "hello stdin",
    });
    expect(echo.stdout).toBe("hello stdin");

    const started = Date.now();
    const slow = await runner.run({
      command: process.execPath,
      args: [
        "-e",
        "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); setInterval(()=>{},1000)",
      ],
      cwd: ws.dir,
      timeoutMs: 400,
    });
    expect(slow.timedOut).toBe(true);
    expect(slow.killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it("throws NOT_INSTALLED for unknown binaries", async () => {
    await expect(runner.start({ command: "definitely-not-a-cli-xyz", cwd: ws.dir })).rejects.toMatchObject({
      code: "NOT_INSTALLED",
    });
  });

  it("runs inside a PTY when node-pty is available", async ({ skip }) => {
    if (!(await loadNodePty())) skip();
    const chunks: string[] = [];
    const proc = await runner.start({
      command: process.execPath,
      args: ["-e", "console.log('tty=' + Boolean(process.stdout.isTTY))"],
      cwd: ws.dir,
      usePty: true,
      onData: (c) => chunks.push(c),
    });
    expect(proc.mode).toBe("pty");
    const exit = await proc.exited;
    expect(exit.exitCode).toBe(0);
    expect(chunks.join("")).toContain("tty=true");
  });
});

describe("executable resolution", () => {
  const ws = tempDir("ff-resolve-");
  afterAll(() => ws.cleanup());

  it("resolves node from PATH", () => {
    const node = resolveExecutable("node");
    expect(node).toBeTruthy();
  });

  it.runIf(isWin)("unwraps npm .cmd shims to node + script", () => {
    const bin = path.join(ws.dir, "bin");
    mkdirSync(path.join(bin, "node_modules", "tool"), { recursive: true });
    writeFileSync(path.join(bin, "node_modules", "tool", "cli.js"), "");
    const shim = path.join(bin, "tool.cmd");
    writeFileSync(
      shim,
      '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\tool\\cli.js" %*\r\n',
    );
    const cmd = toSpawnCommand(shim, ["--json", "a b"]);
    expect(cmd.file.toLowerCase()).toMatch(/node(\.exe)?$/);
    expect(cmd.args).toEqual([path.join(bin, "node_modules", "tool", "cli.js"), "--json", "a b"]);

    const plain = path.join(bin, "plain.cmd");
    writeFileSync(plain, "@echo %*\r\n");
    const viaCmd = toSpawnCommand(plain, ["a&b"]);
    expect(viaCmd.windowsVerbatimArguments).toBe(true);
    expect(viaCmd.args.at(-1)).toContain("^&");
    expect(escapeCmdArgument("a&b", false)).toBe('^"a^&b^"');
  });

  it.runIf(isWin)("passes tricky args intact through the cmd.exe route", async () => {
    const script = path.join(ws.dir, "argv.cmd");
    writeFileSync(script, `@"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`);
    const args = ["a b", 'say "hi"', "a&b", "x|y", "<in>", "^caret", "50% (off)", "trail\\"];
    const res = await new ProcessRunner().run({ command: script, args, cwd: ws.dir });
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual(args);
  });
});
