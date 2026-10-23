// Stand-in for real toolchain commands so integration tests run without installing the sample app's deps.
// Fails when a file under src/ contains the marker "FRONTFLOW_FAIL", letting tests exercise retry loops.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const task = process.argv[2] ?? "build";

function walk(dir) {
  let files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files = files.concat(walk(full));
    else files.push(full);
  }
  return files;
}

const sources = walk(join(process.cwd(), "src"));
const broken = sources.filter((f) => readFileSync(f, "utf8").includes("FRONTFLOW_FAIL"));

if (broken.length) {
  console.error(`${task}: failing because of ${broken.join(", ")}`);
  process.exit(1);
}

if (task === "test" || task === "e2e") {
  console.log(JSON.stringify({ suite: task, passed: sources.length, failed: 0, skipped: 0 }));
} else {
  console.log(`${task}: ok (${sources.length} files)`);
}
