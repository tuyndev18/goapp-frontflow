#!/usr/bin/env node
// Text-only fake CLI for the PTY fallback adapter. Prints human-oriented
// markers, asks for confirmation and waits for "y"/"n" on stdin.
import { writeFileSync } from "node:fs";
import path from "node:path";

const mode = process.argv[2] ?? "approval";
const out = (s) => process.stdout.write(`${s}\r\n`);

out("\x1b[1mFake PTY CLI\x1b[0m ready");
out("Thinking about the task...");

if (mode === "fail") {
  out("Error: something went wrong");
  process.exit(2);
}

out("Running: npm run lint");
out("\x1b[32m✔\x1b[0m ReadFile src/index.ts");

if (mode === "approval") {
  out("WriteFile src/out.txt");
  out("Do you want to proceed? (y/n)");
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    const answer = buf.trim().toLowerCase();
    if (!answer) return;
    if (answer.startsWith("y")) {
      writeFileSync(path.join(process.cwd(), "out.txt"), "written after approval\n");
      out("✔ WriteFile src/out.txt");
      out("All done.");
      process.exit(0);
    } else {
      out("✗ WriteFile src/out.txt rejected by user");
      process.exit(0);
    }
  });
} else {
  out("All done.");
  process.exit(0);
}
