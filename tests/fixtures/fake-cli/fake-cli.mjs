#!/usr/bin/env node
// Fake AI CLI speaking Claude Code's stream-json protocol (plus an approval
// extension) for adapter tests. No dependencies.
//
// Scenario: env FAKE_CLI_SCENARIO, else a `scenario:<name>` token in the prompt.
//   success  init, text, Bash + Write tool calls (file really written in cwd), result
//   approval approval_request → waits for {"type":"approval_response",...} on stdin
//   fail     is_error result, exit 1
//   slow     streams text until killed
//   crash    exits abruptly mid-stream (code 3)
//   leak     prints secret env vars to stdout/stderr, then behaves like success
// Resume: `--resume <id>` reuses the session id; the prompt counter is kept in
// $FAKE_CLI_STATE_DIR/<id>.json.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv.includes("--version")) {
  process.stdout.write("1.2.3 (Fake CLI)\n");
  process.exit(0);
}

// Interactive TUI stand-in for terminal takeover tests: echoes each line until "exit".
if (argv.includes("--interactive")) {
  const resumed = flag("--resume");
  process.stdout.write(`Fake CLI interactive${resumed ? ` (resumed ${resumed})` : ""}\r\n> `);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const text = line.trim();
    if (text === "exit") {
      process.stdout.write("bye\r\n", () => process.exit(0));
      return;
    }
    process.stdout.write(`fake: ${text}\r\n> `);
  });
  await new Promise(() => {});
}

const resumeId = flag("--resume");
const sessionId = resumeId ?? randomUUID();
const model = flag("--model") ?? "fake-model-1";
const cwd = process.cwd();
const stateDir = process.env.FAKE_CLI_STATE_DIR;
const stateFile = stateDir ? path.join(stateDir, `${sessionId}.json`) : undefined;

function loadCount() {
  if (!stateFile) return 0;
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")).prompts ?? 0;
  } catch {
    return 0;
  }
}
function saveCount(n) {
  if (!stateFile) return;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ prompts: n }));
}

let promptCount = loadCount();
let toolSeq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const exit = (code) => process.stdout.write("", () => process.exit(code));

const assistant = (content) =>
  emit({
    type: "assistant",
    message: { id: `msg_${randomUUID().slice(0, 8)}`, type: "message", role: "assistant", model, content },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
const toolResult = (id, content, isError = false, meta) =>
  emit({
    type: "user",
    message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content, is_error: isError }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    ...(meta ? { tool_use_result: meta } : {}),
  });
const result = (text, isError = false) =>
  emit({
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: isError,
    duration_ms: 42,
    num_turns: promptCount,
    result: text,
    session_id: sessionId,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 50 },
  });

// Lines from stdin: user messages and approval responses.
const userQueue = [];
const approvalWaiters = new Map();
let stdinClosed = false;
let wake;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "approval_response") {
    const waiter = approvalWaiters.get(msg.request_id);
    if (waiter) {
      approvalWaiters.delete(msg.request_id);
      waiter(Boolean(msg.approved));
    }
    return;
  }
  if (msg.type === "user") {
    const content = msg.message?.content;
    const text = typeof content === "string" ? content : (content ?? []).map((b) => b.text ?? "").join("\n");
    userQueue.push(text);
    wake?.();
  }
});
rl.on("close", () => {
  stdinClosed = true;
  wake?.();
  for (const w of approvalWaiters.values()) w(false);
  approvalWaiters.clear();
});

function scenarioFor(prompt) {
  if (process.env.FAKE_CLI_SCENARIO) return process.env.FAKE_CLI_SCENARIO;
  return /\bscenario[:=]([a-z]+)/i.exec(prompt)?.[1]?.toLowerCase() ?? "success";
}

async function writeFileTool(name, content) {
  const id = `toolu_${++toolSeq}`;
  const filePath = path.join(cwd, name);
  assistant([{ type: "tool_use", id, name: "Write", input: { file_path: filePath, content } }]);
  await sleep(10);
  writeFileSync(filePath, content);
  toolResult(id, `File created successfully at: ${filePath}`, false, { type: "create", filePath, content });
}

async function runTurn(prompt) {
  promptCount += 1;
  saveCount(promptCount);
  const scenario = scenarioFor(prompt);
  assistant([{ type: "text", text: `Working on prompt #${promptCount}: ${prompt.slice(0, 60)}` }]);
  await sleep(10);

  // Canned answers for FrontFlow's analysis steps: when the prompt asks to write a JSON file
  // ("Write [the result to] <name>.json in the current directory") and $FAKE_CLI_OUTPUTS_DIR
  // has it, "write" it like a real agent would.
  const outputsDir = process.env.FAKE_CLI_OUTPUTS_DIR;
  const requested = /Write (?:the result to )?([\w.-]+\.json) in the current directory/.exec(prompt)?.[1];
  if (outputsDir && scenario === "success" && requested) {
    const source = path.join(outputsDir, requested);
    if (existsSync(source)) {
      await writeFileTool(requested, readFileSync(source, "utf8"));
      result(`Wrote ${requested}`);
      return;
    }
  }

  switch (scenario) {
    case "fail":
      result("Simulated failure", true);
      await drainAndExit(1);
      return;
    case "crash":
      process.stdout.write('{"type":"assistant","message":{"content":[{"type":"te', () => process.exit(3));
      await sleep(10_000);
      return;
    case "slow":
      for (let i = 0; ; i++) {
        assistant([{ type: "text", text: `still working ${i}` }]);
        await sleep(100);
      }
    case "approval": {
      const requestId = `req_${randomUUID().slice(0, 8)}`;
      emit({
        type: "approval_request",
        request_id: requestId,
        tool_name: "Write",
        action: "Write approved.txt",
        input: { file_path: path.join(cwd, "approved.txt") },
        session_id: sessionId,
      });
      const approved = await new Promise((resolve) => approvalWaiters.set(requestId, resolve));
      if (approved) {
        await writeFileTool("approved.txt", `approved by user (prompt #${promptCount})\n`);
        result(`Approved and wrote approved.txt (prompt #${promptCount})`);
      } else {
        result(`User rejected the change (prompt #${promptCount})`);
      }
      return;
    }
    case "leak":
      for (const [k, v] of Object.entries(process.env)) {
        if (/KEY|TOKEN|SECRET/i.test(k)) {
          process.stdout.write(`debug env ${k}=${v}\n`);
          process.stderr.write(`warn: using ${k}=${v}\n`);
        }
      }
      assistant([{ type: "text", text: `key is ${process.env.ANTHROPIC_API_KEY ?? "none"}` }]);
    // falls through
    default: {
      const bashId = `toolu_${++toolSeq}`;
      assistant([{ type: "tool_use", id: bashId, name: "Bash", input: { command: "npm test", description: "run tests" } }]);
      await sleep(10);
      toolResult(bashId, "Tests: 3 passed");
      await writeFileTool("fake-output.txt", `generated for prompt #${promptCount}\n`);
      assistant([{ type: "text", text: "Done." }]);
      result(`Completed prompt #${promptCount}`);
    }
  }
}

async function drainAndExit(code) {
  rl.close();
  exit(code);
  await sleep(10_000);
}

emit({
  type: "system",
  subtype: "init",
  cwd,
  session_id: sessionId,
  model,
  tools: ["Bash", "Read", "Write", "Edit"],
  mcp_servers: [],
  permissionMode: flag("--permission-mode") ?? "default",
  apiKeySource: "none",
});

for (;;) {
  const next = userQueue.shift();
  if (next !== undefined) {
    await runTurn(next);
    continue;
  }
  if (stdinClosed) break;
  await new Promise((r) => (wake = r));
  wake = undefined;
}
exit(0);
