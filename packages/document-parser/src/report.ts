import type { AlignmentPackage, SourceReference, SourceSnapshot } from "@frontflow/domain";

export interface GapReportOptions {
  /** Used to print `ba.md:L12-L20` instead of snapshot ids. */
  snapshots?: SourceSnapshot[];
}

/**
 * Neutralizes untrusted document text for inclusion in Markdown: HTML is entity-escaped, Markdown
 * link/emphasis/table/heading syntax is backslash-escaped and newlines are flattened.
 */
export function escapeMarkdownText(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/([\\`*[\]|#!~])/g, "\\$1")
    .trim();
}

function basename(uri: string): string {
  const clean = uri.replace(/[?#].*$/, "");
  return clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) + 1) || clean;
}

const STATUS_ORDER = ["covered", "partial", "missing", "conflict", "ambiguous", "not_required", "assumed"] as const;

const READINESS_LABEL: Record<AlignmentPackage["readiness"], string> = {
  ready: "READY",
  ready_with_assumptions: "READY WITH ASSUMPTIONS",
  not_ready: "NOT READY",
};

/** Spec §12 — human-readable "Gap & Conflict Report" for an Alignment Package. */
export function renderGapReport(pkg: AlignmentPackage, options: GapReportOptions = {}): string {
  const names = new Map<string, string>();
  for (const snapshot of options.snapshots ?? []) names.set(snapshot.id, snapshot.sourceUri ? basename(snapshot.sourceUri) : snapshot.id);
  const ref = (r: SourceReference) =>
    `${escapeMarkdownText(names.get(r.snapshotId) ?? r.snapshotId)}:L${r.lineStart}${r.lineEnd !== r.lineStart ? `-L${r.lineEnd}` : ""}`;
  const opsById = new Map(pkg.operations.map((op) => [op.id, op]));
  const reqById = new Map(pkg.requirements.map((r) => [r.id, r]));
  const e = escapeMarkdownText;

  const out: string[] = [];
  out.push("# Gap & Conflict Report", "");
  out.push(`- Run: ${e(pkg.runId)}`);
  out.push(`- Readiness: **${READINESS_LABEL[pkg.readiness]}** (${pkg.readiness})`);
  out.push(`- Sources: ${pkg.sourceSnapshots.map((id) => (names.has(id) ? `${e(names.get(id)!)} (${e(id)})` : e(id))).join(", ") || "none"}`);
  out.push(`- Requirements: ${pkg.requirements.length} · API operations: ${pkg.operations.length} · Acceptance scenarios: ${pkg.scenarios.length}`);
  out.push("");

  out.push("## Summary", "", "| Status | Count |", "|---|---:|");
  const counts: Record<(typeof STATUS_ORDER)[number], number> = {
    covered: pkg.summary.covered,
    partial: pkg.summary.partial,
    missing: pkg.summary.missing,
    conflict: pkg.summary.conflict,
    ambiguous: pkg.summary.ambiguous,
    not_required: pkg.summary.notRequired,
    assumed: pkg.summary.assumed,
  };
  for (const status of STATUS_ORDER) out.push(`| ${status} | ${counts[status]} |`);
  const errors = pkg.issues.filter((i) => i.severity === "error").length;
  const warnings = pkg.issues.filter((i) => i.severity === "warning").length;
  out.push(`| document issues (error / warning) | ${errors} / ${warnings} |`, "");

  out.push("## Requirements", "");
  for (const mapping of pkg.mappings) {
    const requirement = reqById.get(mapping.requirementId);
    out.push(`### ${e(mapping.requirementId)} — ${e(requirement?.title ?? "")}`, "");
    out.push(`- Status: **${mapping.status}**${mapping.blocking ? " (blocking)" : " (optional)"} · confidence ${mapping.confidence}`);
    if (requirement?.actor) out.push(`- Actor: ${e(requirement.actor)}`);
    const apis = mapping.apiOperationIds.map((id) => {
      const op = opsById.get(id);
      return op ? `${e(id)} (${e(op.method)} ${e(op.path)})` : e(id);
    });
    out.push(`- API: ${apis.length > 0 ? apis.join(", ") : "none"}`);
    out.push(`- Rationale: ${e(mapping.rationale)}`);
    if (mapping.findings.length > 0) {
      out.push("- Findings:");
      for (const f of mapping.findings) out.push(`  - ${f.kind}${f.assumed ? " [ASSUMED]" : ""}: ${e(f.message)}`);
    }
    if (requirement && requirement.sourceRefs.length > 0) out.push(`- Source: ${ref(requirement.sourceRefs[0]!)}`);
    out.push("");
  }

  out.push("## Document issues", "");
  if (pkg.issues.length === 0) out.push("No document issues found.", "");
  else {
    out.push("| Severity | Code | Subject | Message | Source |", "|---|---|---|---|---|");
    for (const issue of pkg.issues) {
      const subject = issue.requirementId ?? issue.operationId ?? "";
      out.push(`| ${issue.severity} | ${issue.code} | ${e(subject)} | ${e(issue.message)} | ${issue.sourceRefs.map(ref).join(", ")} |`);
    }
    out.push("");
  }

  out.push("## Assumptions (inferred — not stated in the documents)", "");
  out.push("> Every item below was inferred by the parser. Confirm each one with the BA or API owner before treating it as fact.", "");
  const assumptions: string[] = [];
  for (const mapping of pkg.mappings) {
    for (const f of mapping.findings) if (f.assumed) assumptions.push(`- ${e(mapping.requirementId)}: ${e(f.message)}`);
  }
  for (const scenario of pkg.scenarios) {
    if (scenario.assumed) assumptions.push(`- ${e(scenario.id)}: scenario "${e(scenario.title)}" is derived from an assumption.`);
  }
  if (assumptions.length === 0) out.push("None.");
  else out.push(...assumptions);
  out.push("");
  return out.join("\n");
}
