import type { BusinessRequirement, DocumentIssue, SourceReference } from "@frontflow/domain";
import { shortHash } from "./text.js";

export const AUTO_ID_PREFIX = "BA-AUTO-";

export function isGeneratedRequirementId(id: string): boolean {
  return id.startsWith(AUTO_ID_PREFIX);
}

export function issueId(code: DocumentIssue["code"], subject: string, detail = ""): string {
  return `iss_${code}_${shortHash(`${code}\u0000${subject}\u0000${detail}`, 10)}`;
}

export function makeIssue(
  code: DocumentIssue["code"],
  severity: DocumentIssue["severity"],
  message: string,
  subject: { requirementId?: string; operationId?: string; detail?: string },
  sourceRefs: SourceReference[],
): DocumentIssue {
  const key = subject.requirementId ?? subject.operationId ?? "";
  const issue: DocumentIssue = {
    id: issueId(code, key, subject.detail ?? sourceRefs.map((r) => `${r.snapshotId}:${r.lineStart}`).join(",")),
    severity,
    code,
    message,
    sourceRefs,
  };
  if (subject.requirementId) issue.requirementId = subject.requirementId;
  if (subject.operationId) issue.operationId = subject.operationId;
  return issue;
}

export function missingIdIssue(requirement: BusinessRequirement): DocumentIssue {
  return makeIssue(
    "missing_id",
    "warning",
    `Requirement "${requirement.title}" has no stable ID; it was assigned the generated id ${requirement.id}. Add an explicit ID (e.g. BA-XXX-001) for stable traceability.`,
    { requirementId: requirement.id, detail: "generated" },
    requirement.sourceRefs.slice(0, 1),
  );
}

/** Keeps the first issue for each id, preserving order. */
export function dedupeIssues(issues: DocumentIssue[]): DocumentIssue[] {
  const seen = new Set<string>();
  const out: DocumentIssue[] = [];
  for (const issue of issues) {
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    out.push(issue);
  }
  return out;
}
