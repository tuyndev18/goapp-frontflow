/**
 * How each step type reads on the canvas, n8n style: an icon, one plain line on what it does,
 * what it hands to the next step, and — for decision steps — the other way out.
 */
export interface StepLook {
  icon: string;
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
  "figma.design": { icon: "🎨", does: "Frames pushed from Figma", handoff: "Figma scope", input: true },
  "readiness.read_api": { icon: "📄", does: "Upload → saved in the project", handoff: "API contract", input: true },
  "readiness.review": { icon: "🔀", does: "Contract vs the built UI", handoff: "Review report", decision: { pass: "≥ 92%", otherwise: "gaps → you decide" } },
  "ai.implement_ui": { icon: "🖌️", does: "UI from the Figma design", handoff: "UI code" },
  "ai.api_integration": { icon: "🔌", does: "API client and bindings", handoff: "API binding" },
  "integration.check_backend": { icon: "🛰️", does: "Real backend or contract-only", handoff: "Backend level" },
  "ai.bind_ui_states": { icon: "🧩", does: "Loading, empty, error states", handoff: "UI states" },
  "tests.read_ba": { icon: "📋", does: "Upload BA → AI extracts scenarios", handoff: "BA scenarios", input: true },
  "tests.read_ops_guide": { icon: "🗂️", does: "Optional: how to prepare test data (CMS)", handoff: "Operations guide" },
  "tests.design": { icon: "🧪", does: "Scenarios → test cases", handoff: "Test cases", decision: { pass: "testable", otherwise: "gaps → you decide" } },
  "ai.acceptance_tests": { icon: "✍️", does: "Write the test code", handoff: "Test code" },
  "test.acceptance": { icon: "🔬", does: "AI runs, fixes, reports", handoff: "Test report", decision: { pass: "Đạt", otherwise: "fail → you decide" } },
  "report.evidence": { icon: "📊", does: "Traceability & report" },
  "ai.prompt": { icon: "🤖", does: "AI runs this step's prompt", handoff: "Changes" },
  "manual.check": { icon: "👤", does: "You check, then continue", handoff: "Checked", input: true },
};

export function stepLook(type: string): StepLook {
  return LOOKS[type] ?? { icon: "⚙️", does: "" };
}
