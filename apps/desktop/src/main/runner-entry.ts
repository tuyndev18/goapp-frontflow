// Utility process entry (spec §9.3): PTY / AI CLI execution runs here, never in the main process.
import { createDefaultAdapters, startRunnerWorker, type RunnerPort } from "@frontflow/cli-adapters";

const parentPort = (process as unknown as { parentPort?: RunnerPort }).parentPort;
if (!parentPort) throw new Error("runner-entry must be started with utilityProcess.fork");

// The fake CLI is only registered for development and desktop E2E runs.
const fakeScript = process.env["FRONTFLOW_FAKE_CLI"];
const fakeOutputs = process.env["FRONTFLOW_FAKE_CLI_OUTPUTS"];
startRunnerWorker(parentPort, {
  adapters: createDefaultAdapters(
    fakeScript
      ? { includeFake: true, fake: { scriptPath: fakeScript, ...(fakeOutputs ? { sessionEnv: { FAKE_CLI_OUTPUTS_DIR: fakeOutputs } } : {}) } }
      : { includeFake: false },
  ),
});
