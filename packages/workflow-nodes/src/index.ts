import { NodeHandlerRegistry } from "@frontflow/workflow-engine";
import type { NodeServices } from "./services.js";
import { readinessHandlers } from "./handlers/readiness.js";
import { testDesignHandlers } from "./handlers/test-design.js";
import { projectHandlers } from "./handlers/project.js";
import { figmaHandlers } from "./handlers/figma.js";
import { aiHandlers } from "./handlers/ai.js";
import { verificationHandlers } from "./handlers/verification.js";
import { reportHandlers } from "./handlers/report.js";

export * from "./services.js";
export { runAgentStep, extractJson } from "./agent.js";
export type { AgentStepInput, AgentStepResult } from "./agent.js";
export { runProjectCommand, parseTestSummary } from "./commands.js";
export { runGates, GATE_COMMANDS } from "./gates.js";
export type { GateResult } from "./gates.js";
export * from "./skills.js";

/** Handlers for every node type used by workflows/*.yaml. */
export function createBuiltinHandlers(services: NodeServices): NodeHandlerRegistry {
  return new NodeHandlerRegistry({
    ...readinessHandlers(services),
    ...testDesignHandlers(services),
    ...projectHandlers(services),
    ...figmaHandlers(services),
    ...aiHandlers(services),
    ...verificationHandlers(services),
    ...reportHandlers(services),
  });
}
export { createPersistentServices, createSessionRecorder, USAGE_PARSER_VERSION, type SessionRecorderOptions, type StandaloneSessionInfo } from "./host.js";
