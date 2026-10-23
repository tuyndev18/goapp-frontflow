import type { ApiOperation, BusinessRequirement } from "@frontflow/domain";
import { describe, expect, it } from "vitest";
import { verifyDocuments } from "../src/index.js";

const ref = { snapshotId: "snap_ba", lineStart: 1, lineEnd: 2 };

function req(overrides: Partial<BusinessRequirement>): BusinessRequirement {
  return {
    id: "BA-1",
    title: "Customer cancels order",
    actor: "Customer",
    preconditions: ["Order status is PENDING"],
    actions: ["Confirm cancellation"],
    outcomes: ["Order status becomes CANCELLED"],
    validations: [],
    states: ["PENDING", "CANCELLED"],
    errors: [],
    sourceRefs: [ref],
    confidence: 0.95,
    ...overrides,
  };
}

function op(overrides: Partial<ApiOperation>): ApiOperation {
  return {
    id: "cancelOrder",
    method: "POST",
    path: "/orders/{orderId}/cancel",
    roles: ["CUSTOMER"],
    parameters: [],
    responses: [{ status: 200 }],
    sourceRefs: [{ snapshotId: "snap_api", lineStart: 1, lineEnd: 1 }],
    ...overrides,
  };
}

const codes = (issues: ReturnType<typeof verifyDocuments>) => issues.map((i) => `${i.severity}:${i.code}:${i.requirementId ?? i.operationId}`);

describe("verifyDocuments", () => {
  it("accepts a complete, consistent requirement", () => {
    expect(verifyDocuments([req({})], [op({})])).toEqual([]);
  });

  it("flags duplicate ids and missing actor / action / outcome", () => {
    const issues = verifyDocuments([req({}), req({ actor: undefined, actions: [], outcomes: [] })], []);
    expect(codes(issues)).toEqual(["error:duplicate_id:BA-1", "warning:missing_actor:BA-1", "error:missing_action:BA-1", "warning:missing_outcome:BA-1"]);
    expect(issues[0]!.sourceRefs).toHaveLength(2);
  });

  it("detects self-contradiction and unverifiable outcomes", () => {
    const negated = req({ id: "BA-2", outcomes: ["Order becomes CANCELLED", "Order is not CANCELLED until approved"] });
    const noTransition = req({ id: "BA-3", outcomes: ["Order status is PENDING"] });
    const remains = req({ id: "BA-4", outcomes: ["Order status remains PENDING"] });
    const vague = req({ id: "BA-5", outcomes: ["Everything works nicely"] });
    expect(codes(verifyDocuments([negated, noTransition, remains, vague], []))).toEqual([
      "error:self_contradiction:BA-2",
      "warning:self_contradiction:BA-3",
      "warning:not_verifiable:BA-5",
    ]);
  });

  it("flags duplicate operations, conflicting definitions and missing responses", () => {
    const same = verifyDocuments([], [op({}), op({ path: "/orders/{id}/cancel" })]);
    expect(codes(same)).toEqual(["warning:duplicate_id:cancelOrder"]);
    const different = verifyDocuments([], [op({}), op({ roles: ["ADMIN"] }), op({ id: "cancelOrder", method: "DELETE", path: "/orders/{id}", responses: [] })]);
    expect(codes(different)).toEqual(["error:self_contradiction:cancelOrder", "error:duplicate_id:cancelOrder", "warning:not_verifiable:cancelOrder"]);
  });

  it("produces deterministic issue ids", () => {
    const a = verifyDocuments([req({ actor: undefined })], []);
    const b = verifyDocuments([req({ actor: undefined })], []);
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
    expect(a[0]!.id).toMatch(/^iss_missing_actor_[0-9a-f]{10}$/);
  });
});
