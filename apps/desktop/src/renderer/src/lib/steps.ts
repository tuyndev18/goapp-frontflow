import type { StepIconName } from "../components/StepIcon.js";

/**
 * How each step type reads on the canvas, n8n style: an icon, one plain line on what it does,
 * what it hands to the next step, and — for decision steps — the other way out.
 */
export interface StepLook {
  icon: StepIconName;
  /** One short line under the step name. */
  does: string;
  /** What the step hands to the next one: the label of its outgoing edges. */
  handoff?: string;
  /** The step waits for something only you can give (like an n8n trigger). */
  input?: boolean;
  /** Decision step (like an n8n IF node): the main output is `pass`, the other way out is `otherwise`. */
  decision?: { pass: string; otherwise: string; loop?: boolean };
}

const LOOKS: Record<string, StepLook> = {
  "figma.design": { icon: "figma", does: "Frames pushed from Figma", handoff: "Figma scope", input: true },
  "readiness.read_api": { icon: "contract", does: "Upload → saved in the project", handoff: "API contract", input: true },
  "readiness.review": { icon: "compare", does: "Contract vs the built UI", handoff: "Review report", decision: { pass: "≥ 92%", otherwise: "gaps → you decide" } },
  "ai.implement_ui": { icon: "layout", does: "UI from the Figma design", handoff: "UI code" },
  "ai.api_integration": { icon: "plug", does: "API client, bindings and UI states", handoff: "Integrated UI" },
  "integration.check_backend": { icon: "server", does: "Real backend or contract-only", handoff: "Backend level" },
  "ai.bind_ui_states": { icon: "layers", does: "Loading, empty, error states", handoff: "UI states" },
  "tests.read_ba": { icon: "clipboard", does: "Upload BA → scenarios & UI cases", handoff: "BA scenarios", input: true },
  "readiness.ba_ui_review": { icon: "scale", does: "BA vs the built UI: what to add", handoff: "UI vs BA review", decision: { pass: "no conflict", otherwise: "conflict → you decide" } },
  "tests.read_ops_guide": { icon: "folder", does: "Optional: how to prepare test data (CMS)", handoff: "Operations guide" },
  "tests.design": { icon: "flask", does: "Scenarios → test cases", handoff: "Test cases", decision: { pass: "testable", otherwise: "gaps → you decide" } },
  "ai.acceptance_tests": { icon: "code", does: "Write the test code", handoff: "Test code" },
  "test.acceptance": { icon: "check", does: "AI runs unit tests, fixes, reports", handoff: "Test report", decision: { pass: "Đạt", otherwise: "fail → you decide" } },
  "test.e2e": { icon: "compass", does: "AI runs E2E in the real env, fixes", handoff: "E2E report", decision: { pass: "Đạt", otherwise: "fail → you decide" } },
  "report.evidence": { icon: "chart", does: "Traceability & report" },
  "ai.prompt": { icon: "sparkles", does: "AI runs this step's prompt", handoff: "Changes" },
  "manual.check": { icon: "person", does: "You check, then continue", handoff: "Checked", input: true },
};

export function stepLook(type: string): StepLook {
  return LOOKS[type] ?? { icon: "step", does: "" };
}
