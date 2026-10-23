// Utility-process entry: `utilityProcess.fork(<this module>)` from Electron main.
import { createDefaultAdapters } from "../defaults.js";
import type { RunnerPort } from "./protocol.js";
import { startRunnerWorker, type RunnerWorker } from "./runner-host.js";

const parentPort = (process as unknown as { parentPort?: RunnerPort }).parentPort;

export const worker: RunnerWorker | undefined = parentPort
  ? startRunnerWorker(parentPort, { adapters: createDefaultAdapters() })
  : undefined;
