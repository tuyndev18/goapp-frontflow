import type { AcceptanceScenario, BusinessRequirement, RequirementApiMapping, TraceabilityItem, TraceabilityStatus } from "@frontflow/domain";
import { TraceabilityError } from "./errors.js";
import { uniq } from "./text.js";

function statusFor(mapping: RequirementApiMapping | undefined): TraceabilityStatus {
  if (!mapping) return "blocked";
  if (mapping.status === "missing" || mapping.status === "conflict" || mapping.status === "ambiguous") return "blocked";
  if (mapping.status === "assumed" || mapping.findings.some((f) => f.assumed)) return "assumed";
  return "unverified";
}

/** Spec §12.1 A8 — one item per requirement; nothing is verified until evidence is linked. */
export function buildTraceabilityMatrix(
  requirements: BusinessRequirement[],
  mappings: RequirementApiMapping[],
  scenarios: AcceptanceScenario[],
): TraceabilityItem[] {
  const items: TraceabilityItem[] = [];
  const done = new Set<string>();
  for (const requirement of requirements) {
    if (done.has(requirement.id)) continue;
    done.add(requirement.id);
    const mapping = mappings.find((m) => m.requirementId === requirement.id);
    items.push({
      requirementId: requirement.id,
      apiOperationIds: [...(mapping?.apiOperationIds ?? [])],
      figmaNodeIds: [],
      sourceFiles: [],
      testIds: scenarios.filter((s) => s.requirementId === requirement.id).map((s) => s.id),
      evidenceIds: [],
      status: statusFor(mapping),
    });
  }
  return items;
}

export interface TraceabilityLink {
  requirementId: string;
  figmaNodeIds?: string[];
  sourceFiles?: string[];
  testIds?: string[];
  evidenceIds?: string[];
  /** Request to mark the item verified; refused unless evidence is attached (spec §14.2). */
  verified?: boolean;
}

/** Returns a new matrix with the link merged in. Never marks an item verified without evidence. */
export function linkTraceability(items: TraceabilityItem[], link: TraceabilityLink): TraceabilityItem[] {
  const index = items.findIndex((item) => item.requirementId === link.requirementId);
  if (index < 0) throw new TraceabilityError(`Unknown requirement ${link.requirementId} in traceability matrix.`);
  const current = items[index]!;
  const updated: TraceabilityItem = {
    ...current,
    figmaNodeIds: uniq([...current.figmaNodeIds, ...(link.figmaNodeIds ?? [])]),
    sourceFiles: uniq([...current.sourceFiles, ...(link.sourceFiles ?? [])]),
    testIds: uniq([...current.testIds, ...(link.testIds ?? [])]),
    evidenceIds: uniq([...current.evidenceIds, ...(link.evidenceIds ?? []).filter((id) => id.trim() !== "")]),
  };
  if (link.verified) {
    if (updated.evidenceIds.length === 0) {
      throw new TraceabilityError(`Cannot mark ${link.requirementId} as verified without evidence.`);
    }
    updated.status = "verified";
  }
  return items.map((item, i) => (i === index ? updated : item));
}
