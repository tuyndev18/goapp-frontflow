import { NodeHandlerRegistry } from "@frontflow/workflow-engine";
import type { NodeServices } from "./services.js";
import { readinessHandlers } from "./handlers/readiness.js";
import { testDesignHandlers } from "./handlers/test-design.js";
import { figmaHandlers } from "./handlers/figma.js";
import { aiHandlers } from "./handlers/ai.js";
import { verificationHandlers } from "./handlers/verification.js";
import { reportHandlers } from "./handlers/report.js";
import { genericHandlers } from "./handlers/generic.js";

export * from "./services.js";
export { runAgentStep, extractJson, claudeSessionOf } from "./agent.js";
export type { AgentStepInput, AgentStepResult } from "./agent.js";
export { runProjectCommand, parseTestSummary } from "./commands.js";
export { runGates, GATE_COMMANDS } from "./gates.js";
export type { GateResult } from "./gates.js";
export * from "./skills.js";
export { PromptLibrary, ProjectPromptStore, PromptError, additionsPrompt, renderPrompt, promptPlaceholders, SYSTEM_PROMPT_NAME } from "./prompt-library.js";
export type { PromptAddition, PromptSource, PromptTemplate } from "./prompt-library.js";
export * from "./node-types.js";
export { StepAgentStore, type StepAgent } from "./step-agents.js";
export type { ManualCheckOutput, PromptStepOutput } from "./handlers/generic.js";

/** Handlers for every node type of the workflow catalog (NODE_TYPES). */
export function createBuiltinHandlers(services: NodeServices): NodeHandlerRegistry {
  return new NodeHandlerRegistry({
    ...readinessHandlers(services),
    ...testDesignHandlers(services),
    ...figmaHandlers(services),
    ...aiHandlers(services),
    ...verificationHandlers(services),
    ...reportHandlers(services),
    ...genericHandlers(services),
  });
}
export { createPersistentServices, createSessionRecorder, USAGE_PARSER_VERSION, type SessionRecorderOptions } from "./host.js";
