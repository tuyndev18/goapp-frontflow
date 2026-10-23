import { describe, expect, it } from "vitest";
import { NODE_RUN_STATUSES, WORKFLOW_RUN_STATUSES } from "@frontflow/domain";
import { describeWaiting, visualStateForNode, visualStateForRun } from "../src/node-state.js";

describe("visual states", () => {
  it("gives every node and run status an icon and a text label", () => {
    for (const status of NODE_RUN_STATUSES) {
      const spec = visualStateForNode(status);
      expect(spec.icon.length).toBeGreaterThan(0);
      expect(spec.label.length).toBeGreaterThan(0);
    }
    for (const status of WORKFLOW_RUN_STATUSES) {
      const spec = visualStateForRun(status);
      expect(spec.icon.length).toBeGreaterThan(0);
      expect(spec.label.length).toBeGreaterThan(0);
    }
  });

  it("labels waiting nodes with their dependencies", () => {
    expect(describeWaiting("waiting_for_dependency", ["A.alignment_package"])).toBe("Waiting for A.alignment_package");
    expect(describeWaiting("waiting_for_input", undefined)).toBe("Waiting for input");
    expect(describeWaiting("running", ["x"])).toBeUndefined();
  });
});
