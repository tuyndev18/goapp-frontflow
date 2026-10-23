import type { AcceptanceTestCase, ApiOperation, FeReadinessPackage } from "@frontflow/domain";

/**
 * Prompt builders. Uploaded documents, Figma content and repository files are
 * untrusted (spec §22.1), so they are fenced as data and the model is told
 * not to follow instructions found inside them.
 */

export function untrusted(label: string, content: string, maxChars = 24_000): string {
  const body = content.length > maxChars ? `${content.slice(0, maxChars)}\n…(truncated)` : content;
  return `<untrusted-data source="${label}">\n${body.replace(/<\/untrusted-data>/gi, "</untrusted_data>")}\n</untrusted-data>`;
}

export function testCaseList(testCases: AcceptanceTestCase[]): string {
  return testCases
    .map(
      (t) =>
        `- ${t.id} [${t.level}${t.automationStatus === "blocked" ? ", BLOCKED" : ""}] ${t.title} (requirements ${t.requirementIds.join(", ")}; screens ${t.uiFlowNodeIds.join(", ") || "?"}; api ${t.apiOperationIds.join(", ") || "none"})\n` +
        `  Given ${t.preconditions.map((p) => p.description).join("; ") || "-"}\n  When ${t.steps.map((s) => s.action).join("; ") || "-"}\n  Then ${t.expectedOutcomes.map((o) => o.description).join("; ")}` +
        (t.testData.length ? `\n  Test data: ${t.testData.map((d) => `${d.name}${d.example ? `=${d.example}` : ""}`).join(", ")}` : ""),
    )
    .join("\n");
}

export function operationList(operations: ApiOperation[]): string {
  return operations
    .map((op) => {
      const errors = op.responses.filter((r) => r.status >= 400).map((r) => `${r.status} ${r.errorCode ?? ""}`.trim());
      return `- ${op.id}: ${op.method.toUpperCase()} ${op.path} roles=[${op.roles.join(", ")}] auth=${op.auth ?? "?"} errors=[${errors.join(", ")}]`;
    })
    .join("\n");
}

/** The FE Readiness Package as the AI needs it: screens, their UI needs and the API operations mapped to them. */
export function readinessDigest(pkg: FeReadinessPackage): string {
  const screens = pkg.uiFlow
    .map((n) => {
      const needs = pkg.uiDataRequirements
        .filter((r) => r.uiFlowNodeId === n.id)
        .map((r) => {
          const m = pkg.mappings.find((x) => x.uiDataRequirementId === r.id);
          const fields = Object.entries(m?.fieldMappings ?? {}).map(([ui, apiField]) => `${ui}←${apiField}`);
          return `  - ${r.id} (${r.kind}) ${r.description}; status=${m?.status ?? "?"}; api=${m?.apiOperationIds.join(",") || "none"}${fields.length ? `; fields ${fields.join(", ")}` : ""}${r.expectedOutcomes.length ? `; outcomes ${r.expectedOutcomes.join(" | ")}` : ""}`;
        });
      const states = n.states.map((s) => `${s.name}${s.designed ? "" : " (not designed)"}`).join(", ");
      return `- ${n.id} ${n.name} [${n.kind}] figma=${n.figmaNodeIds.join(",") || "?"}; states: ${states || "-"}\n${needs.join("\n") || "  - no data/action need"}`;
    })
    .join("\n");
  const gaps = pkg.gaps.map((g) => `- ${g.kind}${g.blocking ? " (blocking)" : ""}: ${g.message}`).join("\n");
  return `FE readiness: ${pkg.readiness}\nUI flow:\n${screens}\nAPI operations:\n${operationList(pkg.operations)}${gaps ? `\nKnown gaps (treat as assumptions, do not invent API behaviour):\n${gaps}` : ""}`;
}
