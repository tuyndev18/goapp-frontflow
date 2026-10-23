import type { AcceptanceScenario, ApiOperation, BusinessRequirement, RequirementApiMapping } from "@frontflow/domain";
import type { AcceptanceCriterion } from "./ba-parser.js";
import { rolesMatch, uniq } from "./text.js";

export interface ScenarioOptions {
  /** Given/When/Then statements extracted from the BA document; used first. */
  criteria?: AcceptanceCriterion[];
  /** Operations referenced by the mappings, used for HTTP statuses and allowed roles. */
  operations?: ApiOperation[];
  /** Known actors (e.g. from the BA "Actors" section) for permission scenarios. */
  actors?: string[];
}

const GENERIC_ACTOR = /^(?:user|users|any user|end user|system|the system|anyone|everyone|người dùng|hệ thống|mọi người)$/iu;

function splitActors(actor: string | undefined): string[] {
  if (!actor) return [];
  return actor
    .split(/[,;/]|\s+or\s+|\s+hoặc\s+/iu)
    .map((a) => a.trim())
    .filter((a) => a && !GENERIC_ACTOR.test(a));
}

function isCode(value: string): boolean {
  return /^[A-Z][A-Z0-9_]+$/.test(value);
}

/**
 * Spec §12.1 A7 — acceptance scenarios derived only from the documents (never from generated code):
 * explicit Given/When/Then first, then happy path, one per error, permission denials and validations.
 */
export function generateAcceptanceScenarios(
  requirements: BusinessRequirement[],
  mappings: RequirementApiMapping[],
  options: ScenarioOptions = {},
): AcceptanceScenario[] {
  const criteria = options.criteria ?? [];
  const opsById = new Map<string, ApiOperation>();
  for (const op of options.operations ?? []) if (!opsById.has(op.id)) opsById.set(op.id, op);
  const universe = uniq([...(options.actors ?? []).flatMap(splitActors), ...requirements.flatMap((r) => splitActors(r.actor))]);

  const scenarios: AcceptanceScenario[] = [];
  const occurrences = new Map<string, number>();

  requirements.forEach((requirement, index) => {
    const seen = (occurrences.get(requirement.id) ?? 0) + 1;
    occurrences.set(requirement.id, seen);
    const prefix = seen === 1 ? `AS-${requirement.id}` : `AS-${requirement.id}-dup${seen}`;
    const mapping = mappings[index]?.requirementId === requirement.id ? mappings[index] : mappings.find((m) => m.requirementId === requirement.id);
    const apiOperationIds = mapping?.apiOperationIds ?? [];
    const ops = apiOperationIds.map((id) => opsById.get(id)).filter((op): op is ApiOperation => !!op);
    const mappingAssumed = mapping?.status === "assumed";
    const derivedAssumed = mappingAssumed || mapping?.status === "ambiguous";
    const preconditions = requirement.preconditions.filter((p) => !p.startsWith("Permission: "));
    const actors = splitActors(requirement.actor);
    const whenSteps = requirement.actions.length > 0 ? requirement.actions : [requirement.title];
    let n = 0;
    const push = (scenario: Omit<AcceptanceScenario, "id" | "requirementId">) => {
      n += 1;
      scenarios.push({ id: `${prefix}-${String(n).padStart(2, "0")}`, requirementId: requirement.id, ...scenario });
    };

    for (const criterion of criteria.filter((c) => c.requirementId === requirement.id)) {
      const mentionsError = [...criterion.then, ...criterion.when].some((t) => requirement.errors.some((e) => isCode(e) && t.includes(e)));
      push({
        title: criterion.title ?? `Acceptance criterion ${criterion.id}`,
        kind: mentionsError ? "error" : "happy_path",
        given: criterion.given,
        when: criterion.when,
        then: criterion.then,
        apiOperationIds,
        assumed: mappingAssumed,
      });
    }

    if (requirement.actions.length > 0 || requirement.outcomes.length > 0) {
      push({
        title: `${requirement.title} — happy path`,
        kind: "happy_path",
        given: [...(actors.length > 0 ? [`The actor is ${actors.join(" or ")}`] : []), ...preconditions],
        when: whenSteps,
        then: requirement.outcomes.length > 0 ? requirement.outcomes : ["The action completes successfully"],
        apiOperationIds,
        assumed: derivedAssumed || requirement.outcomes.length === 0,
      });
    }

    for (const error of requirement.errors) {
      const code = isCode(error) ? error : undefined;
      const response = code ? ops.flatMap((op) => op.responses.filter((r) => r.errorCode === code).map((r) => ({ op, r })))[0] : undefined;
      const status = response && response.r.status > 0 ? ` (HTTP ${response.r.status})` : "";
      push({
        title: `${requirement.title} — error ${error}`,
        kind: "error",
        given: [...preconditions, code ? `A condition that triggers ${code} holds` : `The error case "${error}" occurs`],
        when: whenSteps,
        then: [code ? `The action is rejected with error ${code}${status}` : `The action is rejected: ${error}`, "The error is shown to the actor"],
        apiOperationIds: response ? [response.op.id] : apiOperationIds,
        assumed: derivedAssumed,
      });
    }

    const denied: { actor: string; op: ApiOperation }[] = [];
    for (const op of mapping?.status === "not_required" ? [] : ops) {
      if (op.roles.length === 0 || op.roles.includes("*")) continue;
      for (const actor of universe) {
        if (actors.some((a) => rolesMatch(a, actor))) continue;
        if (op.roles.some((r) => rolesMatch(actor, r))) continue;
        if (!denied.some((d) => d.actor === actor)) denied.push({ actor, op });
      }
    }
    for (const { actor, op } of denied) {
      const forbidden = op.responses.some((r) => r.status === 403);
      push({
        title: `${requirement.title} — ${actor} is not allowed`,
        kind: "permission",
        given: [`The actor is ${actor}`, ...preconditions],
        when: whenSteps,
        then: [`The action is denied${forbidden ? " (HTTP 403)" : ""}`, "No state change occurs"],
        apiOperationIds: [op.id],
        assumed: derivedAssumed,
      });
    }

    for (const rule of requirement.validations) {
      push({
        title: `${requirement.title} — validation: ${rule}`,
        kind: "validation",
        given: preconditions,
        when: [`The actor submits input that violates: ${rule}`],
        then: ["The input is rejected and the violation is reported to the actor", "No state change occurs"],
        apiOperationIds,
        assumed: derivedAssumed,
      });
    }
  });
  return scenarios;
}
