import type { ApiOperation, BusinessRequirement, DocumentIssue } from "@frontflow/domain";
import { stableStringify } from "@frontflow/domain";
import { isGeneratedRequirementId, makeIssue, missingIdIssue } from "./issues.js";
import { extractStateTokens, isNegatedAt } from "./text.js";

const OBSERVABLE =
  /(?<![\p{L}])(?:display\w*|show\w*|shown|return\w*|receiv\w*|redirect\w*|message|email|notif\w*|status|state|visible|hidden|disabled|enabled|appear\w*|navigat\w*|download\w*|list\w*|created|updated|deleted|removed|saved|sent|error|toast|hiển thị|thông báo|trả về|nhận|chuyển|trạng thái|ẩn|hiện|lưu|gửi|xóa|xoá|tạo)(?![\p{L}])/iu;
const NO_CHANGE = /(?<![\p{L}])(?:remains?|stays?|unchanged|still|kept|giữ nguyên|không đổi|vẫn)(?![\p{L}])/iu;

export function stateMentions(text: string): { token: string; negated: boolean }[] {
  const out: { token: string; negated: boolean }[] = [];
  for (const token of extractStateTokens(text)) {
    const pattern = new RegExp(`(?<![A-Z0-9_])${token}(?![A-Z0-9_])`, "g");
    for (const m of text.matchAll(pattern)) out.push({ token, negated: isNegatedAt(text, m.index) });
  }
  return out;
}

function verifyRequirement(requirement: BusinessRequirement): DocumentIssue[] {
  const issues: DocumentIssue[] = [];
  const subject = { requirementId: requirement.id };
  const head = requirement.sourceRefs.slice(0, 1);

  if (isGeneratedRequirementId(requirement.id)) issues.push(missingIdIssue(requirement));
  if (!requirement.actor) {
    issues.push(makeIssue("missing_actor", "warning", `${requirement.id} does not name an actor or subject.`, { ...subject, detail: "actor" }, head));
  }
  if (requirement.actions.length === 0) {
    issues.push(makeIssue("missing_action", "error", `${requirement.id} does not describe the action being performed.`, { ...subject, detail: "action" }, head));
  }
  if (requirement.outcomes.length === 0) {
    issues.push(
      makeIssue("missing_outcome", "warning", `${requirement.id} does not describe an expected outcome, so it cannot be verified.`, { ...subject, detail: "outcome" }, head),
    );
  } else {
    const outcomeText = requirement.outcomes.join("\n");
    const hasCode = requirement.errors.some((e) => /^[A-Z][A-Z0-9_]+$/.test(e));
    if (extractStateTokens(outcomeText).length === 0 && !hasCode && !OBSERVABLE.test(outcomeText)) {
      issues.push(
        makeIssue(
          "not_verifiable",
          "warning",
          `${requirement.id}: outcome "${requirement.outcomes[0]}" has no observable state, response or UI signal to verify against.`,
          { ...subject, detail: "observable" },
          head,
        ),
      );
    }

    const mentions = stateMentions(outcomeText);
    const contradicted = [...new Set(mentions.filter((m) => m.negated).map((m) => m.token))].filter((token) =>
      mentions.some((m) => m.token === token && !m.negated),
    );
    for (const token of contradicted) {
      issues.push(
        makeIssue(
          "self_contradiction",
          "error",
          `${requirement.id} states the result is ${token} and also that it is not ${token}.`,
          { ...subject, detail: `negation:${token}` },
          head,
        ),
      );
    }

    const preStates = new Set(stateMentions(requirement.preconditions.join("\n")).filter((m) => !m.negated).map((m) => m.token));
    const resultStates = [...new Set(mentions.filter((m) => !m.negated).map((m) => m.token))];
    if (resultStates.length > 0 && resultStates.every((s) => preStates.has(s)) && !NO_CHANGE.test(outcomeText)) {
      issues.push(
        makeIssue(
          "self_contradiction",
          "warning",
          `${requirement.id}: result state ${resultStates.join(", ")} equals the precondition state, but no transition or "remains" wording is given.`,
          { ...subject, detail: "no-transition" },
          head,
        ),
      );
    }
  }
  return issues;
}

function operationKey(op: ApiOperation): string {
  return `${op.method.toUpperCase()} ${op.path.replace(/\{[^}]+\}/g, "{}")}`;
}

function definitionOf(op: ApiOperation): string {
  return stableStringify({
    id: op.id,
    auth: op.auth,
    roles: [...op.roles].sort(),
    requestSchema: op.requestSchema,
    responses: op.responses.map((r) => ({ status: r.status, errorCode: r.errorCode, schema: r.schema })),
  });
}

/** Spec §12.1 A4 — stable IDs, actor, action/outcome, self-consistency and verifiability. */
export function verifyDocuments(requirements: BusinessRequirement[], operations: ApiOperation[]): DocumentIssue[] {
  const issues: DocumentIssue[] = [];

  const byId = new Map<string, BusinessRequirement[]>();
  for (const requirement of requirements) byId.set(requirement.id, [...(byId.get(requirement.id) ?? []), requirement]);
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    issues.push(
      makeIssue(
        "duplicate_id",
        "error",
        `Requirement ID ${id} is used ${group.length} times; IDs must be unique for traceability.`,
        { requirementId: id, detail: "duplicate" },
        group.map((r) => r.sourceRefs[0]!).filter(Boolean),
      ),
    );
  }
  for (const requirement of requirements) issues.push(...verifyRequirement(requirement));

  const byKey = new Map<string, ApiOperation[]>();
  for (const op of operations) byKey.set(operationKey(op), [...(byKey.get(operationKey(op)) ?? []), op]);
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    const refs = group.flatMap((op) => op.sourceRefs.slice(0, 1));
    const distinct = new Set(group.map(definitionOf)).size > 1;
    issues.push(
      distinct
        ? makeIssue("self_contradiction", "error", `${key} is defined ${group.length} times with different definitions.`, { operationId: group[0]!.id, detail: `dup:${key}` }, refs)
        : makeIssue("duplicate_id", "warning", `${key} is defined ${group.length} times (identical definitions).`, { operationId: group[0]!.id, detail: `dup:${key}` }, refs),
    );
  }

  const byOpId = new Map<string, ApiOperation[]>();
  for (const op of operations) byOpId.set(op.id, [...(byOpId.get(op.id) ?? []), op]);
  for (const [id, group] of byOpId) {
    const keys = new Set(group.map(operationKey));
    if (keys.size < 2) continue;
    issues.push(
      makeIssue(
        "duplicate_id",
        "error",
        `Operation ID ${id} is used by ${[...keys].join(", ")}.`,
        { operationId: id, detail: "operation-id" },
        group.flatMap((op) => op.sourceRefs.slice(0, 1)),
      ),
    );
  }

  for (const op of operations) {
    if (op.responses.length === 0) {
      issues.push(
        makeIssue("not_verifiable", "warning", `${op.method} ${op.path} documents no responses.`, { operationId: op.id, detail: "responses" }, op.sourceRefs.slice(0, 1)),
      );
    }
  }
  return issues;
}
