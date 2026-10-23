import type { AlignmentFinding, AlignmentPolicy, ApiOperation, BusinessRequirement, RequirementApiMapping } from "@frontflow/domain";
import type { RequirementApiLink } from "./mapping.js";
import { profileRequirement } from "./mapping.js";
import { hasOpenStatusField, operationStates } from "./schema.js";
import { isVariantOf, rolesMatch, round2, uniq } from "./text.js";
import { stateMentions } from "./verify.js";

export const DEFAULT_POLICY: AlignmentPolicy = { allowAssumptions: false, optionalRequirementIds: [] };

/** Inferred (non-explicit) links scoring at least this are treated as established. */
export const STRONG_LINK_SCORE = 0.5;
/** Parser confidence below this means the requirement itself is too unclear to classify. */
export const MIN_REQUIREMENT_CONFIDENCE = 0.6;

const FE_ONLY =
  /client[- ]side only|(?<![\p{L}])(?:ui|fe|frontend|front[- ]end)[- ]only(?![\p{L}])|no api (?:call )?(?:is )?(?:needed|required)|does not (?:require|need) (?:an |any )?api|without (?:calling )?(?:an |any )?api|chỉ (?:xử lý )?(?:ở |tại |phía )?(?:fe|frontend|front-end|client)(?![\p{L}])|không cần (?:gọi )?api/iu;

const AMBIGUOUS_WORDING =
  /(?<![\p{L}])(?:tbd|tbc|todo|etc|maybe|possibly|perhaps|as appropriate|as needed|if possible|and\/or|somehow|to be (?:defined|decided|confirmed)|chưa rõ|chưa xác định|tùy trường hợp|có lẽ|v\.v)(?![\p{L}])|\?/iu;

const GENERIC_ACTOR = /^(?:user|users|any user|end user|system|the system|anyone|everyone|người dùng|hệ thống|mọi người)$/iu;

export function isFrontendOnly(requirement: BusinessRequirement): boolean {
  return FE_ONLY.test(profileRequirement(requirement).fullText);
}

function ambiguousWording(requirement: BusinessRequirement): string | undefined {
  for (const text of [requirement.title, ...requirement.actions, ...requirement.outcomes]) {
    const m = AMBIGUOUS_WORDING.exec(text);
    if (m) return m[0];
  }
  return undefined;
}

function actorList(actor: string | undefined): string[] {
  if (!actor) return [];
  return actor
    .split(/[,;/]|\s+or\s+|\s+hoặc\s+/iu)
    .map((a) => a.trim())
    .filter((a) => a && !GENERIC_ACTOR.test(a));
}

function opLabel(op: ApiOperation): string {
  return `${op.id} (${op.method} ${op.path})`;
}

function finding(kind: AlignmentFinding["kind"], message: string, assumed = false): AlignmentFinding {
  return { kind, message, assumed };
}

interface Evaluated {
  conflicts: AlignmentFinding[];
  partials: AlignmentFinding[];
  assumptions: AlignmentFinding[];
  confirmations: string[];
}

function evaluate(requirement: BusinessRequirement, ops: ApiOperation[]): Evaluated {
  const result: Evaluated = { conflicts: [], partials: [], assumptions: [], confirmations: [] };
  const opCodes = uniq(ops.flatMap((op) => op.responses.map((r) => r.errorCode).filter((c): c is string => !!c)));

  for (const code of requirement.errors.filter((e) => /^[A-Z][A-Z0-9_]+$/.test(e))) {
    if (opCodes.includes(code)) {
      result.confirmations.push(`error ${code} documented`);
      continue;
    }
    const variant = opCodes.find((c) => isVariantOf(code, c));
    if (variant) {
      result.conflicts.push(finding("conflicting_value", `BA error code ${code} is spelled ${variant} in the API contract.`));
    } else {
      result.partials.push(finding("missing_error", `BA error ${code} is not documented by ${ops.map((o) => o.id).join(", ")}.`));
    }
  }

  const actors = actorList(requirement.actor);
  for (const op of ops) {
    if (actors.length === 0 || op.roles.includes("*")) continue;
    if (op.roles.length === 0) {
      if (op.auth !== "none") {
        result.partials.push(finding("missing_role", `${opLabel(op)} does not list allowed roles; cannot confirm that ${actors.join(", ")} may call it.`));
      }
      continue;
    }
    const denied = actors.filter((a) => !op.roles.some((r) => rolesMatch(a, r)));
    if (denied.length > 0) {
      result.conflicts.push(
        finding("missing_role", `Actor ${denied.join(", ")} is not in the allowed roles of ${opLabel(op)} (${op.roles.join(", ")}).`),
      );
    } else {
      result.confirmations.push(`role ${actors.join(", ")} allowed by ${op.id}`);
    }
  }

  const mentions = stateMentions(requirement.outcomes.join("\n"));
  const resultStates = uniq(mentions.filter((m) => !m.negated).map((m) => m.token));
  const apiStates = uniq(ops.flatMap(operationStates));
  const openStatus = ops.some(hasOpenStatusField);
  for (const state of resultStates) {
    if (apiStates.includes(state)) {
      result.confirmations.push(`result state ${state} in response`);
      continue;
    }
    const variant = apiStates.find((s) => isVariantOf(state, s));
    if (variant) {
      result.conflicts.push(finding("conflicting_value", `BA result state ${state} conflicts with API value ${variant}.`));
    } else if (apiStates.length > 0) {
      result.partials.push(finding("missing_field", `BA result state ${state} is not among the API response values (${apiStates.join(", ")}).`));
    } else if (openStatus) {
      result.assumptions.push(finding("assumption", `API response has an unconstrained status field; assuming it can be ${state}.`, true));
    } else {
      result.partials.push(finding("missing_field", `API response does not expose the BA result state ${state}.`));
    }
  }
  return result;
}

/** Spec §12.1 A6 — one mapping per requirement with status, findings and a human-readable rationale. */
export function classifyAlignment(
  requirements: BusinessRequirement[],
  operations: ApiOperation[],
  links: RequirementApiLink[],
  policy: AlignmentPolicy = DEFAULT_POLICY,
): RequirementApiMapping[] {
  const optional = new Set(policy.optionalRequirementIds);
  const opsById = new Map<string, ApiOperation[]>();
  for (const op of operations) opsById.set(op.id, [...(opsById.get(op.id) ?? []), op]);

  return requirements.map((requirement): RequirementApiMapping => {
    const reqLinks = links.filter((l) => l.requirementId === requirement.id && opsById.has(l.operationId));
    const apiOperationIds = uniq(reqLinks.map((l) => l.operationId));
    const ops = apiOperationIds.flatMap((id) => opsById.get(id) ?? []);
    const blocking = !optional.has(requirement.id);
    const base = { requirementId: requirement.id, apiOperationIds, blocking };

    if (isFrontendOnly(requirement)) {
      return {
        ...base,
        apiOperationIds: [],
        status: "not_required",
        confidence: round2(requirement.confidence),
        rationale: "Requirement is explicitly marked as frontend-only; no API operation is required.",
        findings: [],
      };
    }

    const unclearWord = ambiguousWording(requirement);
    const unclear: AlignmentFinding[] = [];
    if (requirement.confidence < MIN_REQUIREMENT_CONFIDENCE) {
      unclear.push(
        finding("unclear", `Requirement was parsed with low confidence (${requirement.confidence}); actor, action or outcome is not stated explicitly.`),
      );
    }
    if (unclearWord) unclear.push(finding("unclear", `Requirement wording is ambiguous ("${unclearWord}").`));

    if (reqLinks.length === 0) {
      if (unclear.length > 0) {
        return {
          ...base,
          status: "ambiguous",
          confidence: round2(Math.min(requirement.confidence, 0.5)),
          rationale: "No API operation matches and the requirement is too unclear to decide whether one is needed.",
          findings: unclear,
        };
      }
      return {
        ...base,
        status: "missing",
        confidence: round2(requirement.confidence * 0.9),
        rationale: `No API operation in the contract matches "${requirement.title}".`,
        findings: [finding("missing_operation", `The API contract has no operation for ${requirement.id} — ${requirement.title}.`)],
      };
    }

    const explicit = reqLinks.some((l) => l.explicit);
    const best = Math.max(...reqLinks.map((l) => l.score));
    const inferred = !explicit && best < STRONG_LINK_SCORE;
    const evaluation = evaluate(requirement, ops);
    const flag = (f: AlignmentFinding): AlignmentFinding => (inferred ? { ...f, assumed: true } : f);
    const findings: AlignmentFinding[] = [...unclear, ...evaluation.conflicts.map(flag), ...evaluation.partials.map(flag), ...evaluation.assumptions];
    if (inferred) {
      for (const link of reqLinks) {
        const op = opsById.get(link.operationId)![0]!;
        findings.push(
          finding(
            "assumption",
            `Mapping to ${opLabel(op)} is inferred (score ${link.score}: ${link.signals.filter((s) => s.weight > 0).map((s) => s.detail).join("; ") || "weak similarity"}); confirm with the API owner.`,
            true,
          ),
        );
      }
    }

    let status: RequirementApiMapping["status"];
    if (unclear.length > 0) status = "ambiguous";
    else if (evaluation.conflicts.length > 0) status = "conflict";
    else if (evaluation.partials.length > 0) status = "partial";
    else if (inferred || evaluation.assumptions.length > 0) status = "assumed";
    else status = "covered";

    const linkStrength = explicit ? 1 : Math.min(1, 0.5 + best);
    const confidence = round2(Math.min(status === "ambiguous" ? 0.5 : 1, requirement.confidence * linkStrength));
    const how = explicit
      ? "explicitly referenced"
      : `matched by ${uniq(reqLinks.flatMap((l) => l.signals.filter((s) => s.weight > 0).map((s) => s.kind.replace(/_/g, " ")))).join(", ")}`;
    const opsText = ops.map(opLabel).join(", ");
    const rationale = {
      covered: `Covered by ${opsText} (${how}); ${evaluation.confirmations.join("; ") || "no gaps detected"}.`,
      partial: `Partially covered by ${opsText} (${how}): ${evaluation.partials.length} gap(s) found.`,
      conflict: `BA and API disagree for ${opsText} (${how}): ${evaluation.conflicts.length} conflict(s) found.`,
      assumed: `Mapped to ${opsText} by inference (${how}); treat as an assumption until confirmed.`,
      ambiguous: `Requirement is too unclear to confirm alignment with ${opsText}.`,
      missing: "",
      not_required: "",
    }[status];

    return { ...base, status, confidence, rationale, findings };
  });
}
