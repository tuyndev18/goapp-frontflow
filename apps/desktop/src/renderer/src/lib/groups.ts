import type { LaneDto } from "../../../shared/ipc.js";

// Lane colours are decoration only (dots, node edges): Linear label palette. The built-in
// workflow's lanes and groups keep their own; other lanes take the palette in order.
const KNOWN: Record<string, string> = { B1: "#bb87fc", A: "#4ea7fc", B2: "#e2609e", C: "#26b5ce", C1: "#26b5ce", C2: "#f2994a" };
const PALETTE = ["#bb87fc", "#4ea7fc", "#e2609e", "#26b5ce", "#f2994a", "#4cb782"];
const NEUTRAL = "#8a8f98";

/** A swimlane of a workflow, ready to draw. */
export interface Lane {
  id: string;
  title: string;
  subtitle: string;
  /** Node groups shown in it. */
  groups: string[];
  color: string;
}

export function groupOf(node: { id: string; group?: string }): string {
  return node.group ?? node.id.split(".")[0] ?? "other";
}

/** A workflow's lanes top to bottom, plus one per node group no lane holds (runs of older workflow versions). */
export function lanesOf(lanes: LaneDto[] | undefined, nodes: ReadonlyArray<{ id: string; group?: string }>): Lane[] {
  const out: Lane[] = (lanes ?? []).map((l, i) => ({
    id: l.id,
    title: l.title || l.id,
    subtitle: l.subtitle ?? "",
    groups: l.groups ?? [l.id],
    color: laneColor(l.id, i),
  }));
  for (const n of nodes) {
    const group = groupOf(n);
    if (!out.some((l) => l.groups.includes(group))) out.push({ id: group, title: group, subtitle: "", groups: [group], color: laneColor(group, out.length) });
  }
  return out;
}

export function laneColor(laneId: string, index: number): string {
  return KNOWN[laneId] ?? PALETTE[index % PALETTE.length] ?? NEUTRAL;
}

export function laneFor(lanes: Lane[], node: { id: string; group?: string }): Lane | undefined {
  const group = groupOf(node);
  return lanes.find((l) => l.groups.includes(group));
}

/** A step's colour: its group's own in the built-in workflow, else its lane's. */
export function nodeColor(lanes: Lane[], node: { id: string; group?: string }): string {
  return KNOWN[groupOf(node)] ?? laneFor(lanes, node)?.color ?? NEUTRAL;
}

/** Colour of a node group when its workflow's lanes are not at hand. */
export function groupColor(group: string): string {
  return KNOWN[group] ?? NEUTRAL;
}
