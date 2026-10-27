import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_EFFORTS, isAgentEffort, isAgentModel } from "./node-types.js";

/** The model and effort a step's agent runs with; unset: decided elsewhere. */
export interface StepAgent {
  model?: string;
  effort?: string;
}

/**
 * The model and effort chosen for single steps of one feature (run) on the run screen, in one
 * JSON file per run (`{ steps: { "<step id>": { model, effort } } }`). They win over the feature's
 * own choice and the workflow's, from the step's next attempt.
 */
export class StepAgentStore {
  constructor(private readonly fileOf: (runId: string) => string) {}

  get(runId: string, nodeId: string): StepAgent {
    return this.all(runId)[nodeId] ?? {};
  }

  /** Step id → its choice, for every step of the run that has one. */
  all(runId: string): Record<string, StepAgent> {
    const file = this.fileOf(runId);
    if (!existsSync(file)) return {};
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { steps?: unknown };
      const steps = raw.steps && typeof raw.steps === "object" ? (raw.steps as Record<string, unknown>) : {};
      const out: Record<string, StepAgent> = {};
      for (const [nodeId, value] of Object.entries(steps)) {
        const { model, effort } = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
        // A hand-edited file must not put anything else on Claude Code's command line.
        const agent: StepAgent = { ...(isAgentModel(model) ? { model } : {}), ...(isAgentEffort(effort) ? { effort } : {}) };
        if (agent.model || agent.effort) out[nodeId] = agent;
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Sets a step's choice; an unset or empty field goes back to the feature's or the workflow's. */
  set(runId: string, nodeId: string, agent: StepAgent): StepAgent {
    if (agent.model && !isAgentModel(agent.model)) throw new Error(`Invalid model ${agent.model}`);
    if (agent.effort && !isAgentEffort(agent.effort)) throw new Error(`Effort must be one of ${AGENT_EFFORTS.join(", ")}`);
    const next: StepAgent = { ...(agent.model ? { model: agent.model } : {}), ...(agent.effort ? { effort: agent.effort } : {}) };
    const all = this.all(runId);
    if (next.model || next.effort) all[nodeId] = next;
    else delete all[nodeId];
    const file = this.fileOf(runId);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ steps: all }, null, 2));
    return next;
  }
}
