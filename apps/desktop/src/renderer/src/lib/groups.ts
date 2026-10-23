import type { GraphNodeDto } from "../../../shared/ipc.js";

// Lane colours are decoration only (dots, node edges): Notion sticker palette.
// In run order: the UI is built from Figma first, the API contract is reviewed when it arrives.
export const GROUPS = [
  { id: "B1", label: "① Build UI from Figma", color: "#ff64c8" },
  { id: "A", label: "② Review against API contract", color: "#62aef0" },
  { id: "B2", label: "③ Integrate the API", color: "#9a6dd7" },
  { id: "C1", label: "④ BA test design", color: "#2a9d99" },
  { id: "C2", label: "④ Acceptance auto-test", color: "#dd5b00" },
] as const;

/** Canvas swimlanes, one per stage, read top to bottom; C1 and C2 share the last one. */
export const LANES = [
  { id: "B1", title: "① Build UI from Figma", subtitle: "No API needed yet: UI with mock data", groups: ["B1"], color: "#ff64c8" },
  { id: "A", title: "② Review against API", subtitle: "When the contract arrives: is the UI covered?", groups: ["A"], color: "#62aef0" },
  { id: "B2", title: "③ Integrate the API", subtitle: "Bind API, states, then the gates", groups: ["B2"], color: "#9a6dd7" },
  { id: "C", title: "④ Prove it works", subtitle: "BA spec → test cases → run them", groups: ["C1", "C2"], color: "#2a9d99" },
] as const;

export function laneOf(group: string): string {
  return LANES.find((l) => (l.groups as readonly string[]).includes(group))?.id ?? group;
}

export function groupOf(node: GraphNodeDto): string {
  return node.group ?? node.id.split(".")[0] ?? "other";
}

export function groupColor(id: string): string {
  return GROUPS.find((g) => g.id === id)?.color ?? "#a39e98";
}

export function groupLabel(id: string): string {
  return GROUPS.find((g) => g.id === id)?.label ?? id;
}
