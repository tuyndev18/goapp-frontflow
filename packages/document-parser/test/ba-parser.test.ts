import { describe, expect, it } from "vitest";
import { parseBaMarkdown } from "../src/index.js";
import { fixture, snap } from "./helpers.js";

function parse(md: string) {
  const { snapshot, text } = snap("ba_markdown", md);
  return { ...parseBaMarkdown(snapshot, text), snapshot };
}

describe("parseBaMarkdown — template", () => {
  it("parses the spec §11.1 template fixture with source references", () => {
    const { requirements, actors, acceptanceCriteria, issues, snapshot } = parse(fixture("cancel-order/ba.md"));
    expect(issues).toEqual([]);
    expect(actors).toEqual(["Customer", "Support agent"]);
    expect(requirements.map((r) => r.id)).toEqual(["BA-ORDER-001", "BA-ORDER-002"]);
    const r1 = requirements[0]!;
    expect(r1).toMatchObject({
      title: "Customer cancels a pending order",
      actor: "Customer",
      preconditions: ["Order status is PENDING"],
      actions: ["Confirm cancellation"],
      outcomes: ["Order status becomes CANCELLED"],
      errors: ["ORDER_NOT_FOUND", "ORDER_CANNOT_BE_CANCELLED"],
      states: ["PENDING", "CANCELLED"],
      validations: ["Cancellation reason is at most 500 characters"],
      confidence: 0.95,
    });
    expect(r1.sourceRefs[0]).toMatchObject({
      snapshotId: snapshot.id,
      lineStart: 13,
      lineEnd: 22,
      section: ["Feature: Cancel order", "Requirements", "BA-ORDER-001 — Customer cancels a pending order"],
    });
    const errorsRef = r1.sourceRefs.find((r) => r.excerpt?.startsWith("Errors"));
    expect(errorsRef).toMatchObject({ lineStart: 18, lineEnd: 20 });

    expect(acceptanceCriteria).toHaveLength(2);
    expect(acceptanceCriteria[0]).toMatchObject({
      id: "AC-001",
      requirementId: "BA-ORDER-001",
      given: ["a PENDING order owned by the customer"],
      when: ["the customer confirms cancellation"],
      then: ["the order status becomes CANCELLED (BA-ORDER-001)"],
    });
    expect(acceptanceCriteria[1]!.requirementId).toBe("BA-ORDER-002");
  });

  it("accepts different separators, bold labels, nested and ;/, multi-values", () => {
    const { requirements } = parse(
      [
        "# F",
        "### BA-A-1 – Dash title",
        "- **Actor:** Customer",
        "- Actions: Open cart; Press pay",
        "- Outcome: Payment is COMPLETED",
        "- Errors: CARD_DECLINED, PAYMENT_TIMEOUT",
        "- States:",
        "  - DRAFT",
        "  - COMPLETED",
        "### BA-A-2: Colon title",
        "- Actor: Admin",
        "- Action: Approve",
        "- Result: Request is APPROVED",
        "### BA-A-3 - Hyphen title",
        "### BA-A-4",
      ].join("\n"),
    );
    expect(requirements.map((r) => [r.id, r.title])).toEqual([
      ["BA-A-1", "Dash title"],
      ["BA-A-2", "Colon title"],
      ["BA-A-3", "Hyphen title"],
      ["BA-A-4", "BA-A-4"],
    ]);
    expect(requirements[0]).toMatchObject({
      actor: "Customer",
      actions: ["Open cart", "Press pay"],
      errors: ["CARD_DECLINED", "PAYMENT_TIMEOUT"],
      states: ["DRAFT", "COMPLETED"],
    });
    expect(requirements[2]!.confidence).toBeLessThan(0.95);
    expect(requirements[3]!.confidence).toBeLessThan(requirements[2]!.confidence);
  });

  it("supports Vietnamese labels and Given/When/Then under the requirement", () => {
    const { requirements, acceptanceCriteria } = parse(
      [
        "# Hủy đơn",
        "## BA-VN-001 — Khách hàng hủy đơn",
        "- Tác nhân: Khách hàng",
        "- Điều kiện: Đơn ở trạng thái PENDING",
        "- Hành động: Xác nhận hủy",
        "- Kết quả: Đơn chuyển sang CANCELLED",
        "- Lỗi:",
        "  - ORDER_NOT_FOUND",
        "- Ràng buộc: Lý do tối đa 500 ký tự",
        "- Trạng thái: PENDING, CANCELLED",
        "",
        "#### Acceptance criteria",
        "- Given đơn PENDING",
        "- When khách xác nhận hủy",
        "- Then đơn chuyển sang CANCELLED",
      ].join("\n"),
    );
    expect(requirements).toHaveLength(1);
    expect(requirements[0]).toMatchObject({
      id: "BA-VN-001",
      actor: "Khách hàng",
      preconditions: ["Đơn ở trạng thái PENDING"],
      actions: ["Xác nhận hủy"],
      outcomes: ["Đơn chuyển sang CANCELLED"],
      errors: ["ORDER_NOT_FOUND"],
      validations: ["Lý do tối đa 500 ký tự"],
      states: ["PENDING", "CANCELLED"],
      confidence: 0.95,
    });
    expect(acceptanceCriteria).toEqual([
      expect.objectContaining({
        requirementId: "BA-VN-001",
        given: ["đơn PENDING"],
        when: ["khách xác nhận hủy"],
        then: ["đơn chuyển sang CANCELLED"],
        sourceRef: expect.objectContaining({ lineStart: 13, lineEnd: 15 }),
      }),
    ]);
  });

  it("falls back to free-form requirements with generated ids, low confidence and a missing_id issue", () => {
    const md = [
      "# Orders",
      "## Overview",
      "This module must be fast.",
      "## Order history",
      "The customer must be able to see past orders. The list is sorted by date.",
      "## Export",
      "- Support agents should export orders to CSV so that finance receives a report.",
    ].join("\n");
    const first = parse(md);
    const second = parse(md);
    expect(first.requirements).toEqual(second.requirements);
    expect(first.requirements.map((r) => r.id)).toEqual(["BA-AUTO-001", "BA-AUTO-002"]);
    const [history, exportReq] = first.requirements;
    expect(history).toMatchObject({ title: "Order history", actor: "Customer", outcomes: [] });
    expect(history!.confidence).toBeLessThanOrEqual(0.5);
    expect(exportReq).toMatchObject({ actor: "Support agents" });
    expect(exportReq!.outcomes).toHaveLength(1);
    expect(exportReq!.confidence).toBeLessThanOrEqual(0.5);
    expect(first.issues.map((i) => [i.code, i.requirementId])).toEqual([
      ["missing_id", "BA-AUTO-001"],
      ["missing_id", "BA-AUTO-002"],
    ]);
    expect(history!.sourceRefs[0]).toMatchObject({ lineStart: 4, lineEnd: 5 });
  });

  it("parses ID-prefixed list items and reports an empty document", () => {
    const { requirements } = parse(["# Backlog", "- BA-X-010: Admin archives a product", "  - Action: Archive", "  - Result: Product is ARCHIVED"].join("\n"));
    expect(requirements).toEqual([
      expect.objectContaining({ id: "BA-X-010", title: "Admin archives a product", actions: ["Archive"], states: ["ARCHIVED"] }),
    ]);

    const empty = parse("# Nothing here\n\nJust prose.\n");
    expect(empty.requirements).toEqual([]);
    expect(empty.issues.map((i) => [i.code, i.severity])).toEqual([["empty_document", "error"]]);
  });

  it("does not leak requirement ids or HTTP words as states", () => {
    const { requirements } = parse("### BA-ORDER-001 — X\n- Actor: API client\n- Action: Call GET\n- Result: Record becomes ACTIVE via the API\n");
    expect(requirements[0]!.states).toEqual(["ACTIVE"]);
  });
});
