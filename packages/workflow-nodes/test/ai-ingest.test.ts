import { describe, expect, it } from "vitest";
import type { SourceSnapshot } from "@frontflow/domain";
import { ingestOperations, ingestRequirements, type DocumentText } from "../src/ai-ingest.js";

const snap = (id: string): SourceSnapshot => ({ id, type: "ba_markdown", contentHash: "x", createdAt: "2026-10-22T00:00:00Z", metadata: {} });
const ba: DocumentText = {
  snapshot: snap("snap_ba"),
  text: ["# Quản lý giải đấu", "", "## UC-01 HLV tạo giải", "HLV nhập tên giải và khối thi.", "BR-26: mọi khối cùng vòng.", "", "## UC-02 HLV huỷ giải"].join("\n"),
};
const api: DocumentText = {
  snapshot: snap("snap_api"),
  text: ["# API", "", "## POST /api/v1/host/tournaments", "Tạo giải. Lỗi 409 TOURNAMENT_NAME_TAKEN", "", "## DELETE /api/v1/host/tournaments/{id}"].join("\n"),
};

const requirements = {
  actors: ["HLV"],
  requirements: [
    {
      id: "UC-01",
      title: "HLV tạo giải",
      actor: "HLV",
      actions: ["Tạo giải"],
      outcomes: ["Giải ở trạng thái Nháp"],
      validations: ["BR-26: mọi khối cùng vòng"],
      errors: ["TOURNAMENT_NAME_TAKEN"],
      acceptanceCriteria: [{ given: ["HLV đã đăng nhập"], when: ["tạo giải"], then: ["giải được tạo"] }],
      lines: [3, 5],
      confidence: 0.9,
    },
    { id: "UC-02", title: "HLV huỷ giải", lines: [999, 1000], confidence: 0.8 },
    { id: "UC-01", title: "duplicate", lines: [3, 3] },
  ],
};

const operations = {
  operations: [
    { id: "createTournament", method: "post", path: "/api/v1/host/tournaments", roles: ["HLV"], responses: [{ status: 409, errorCode: "TOURNAMENT_NAME_TAKEN" }], lines: [3, 4] },
    { method: "DELETE", path: "/api/v1/host/tournaments/{id}", lines: [6, 6] },
    { method: "FETCH", path: "/nope" },
  ],
};

describe("BA requirement ingestion", () => {
  it("grounds line references in the real document and keeps document ids", () => {
    const result = ingestRequirements(requirements, ba);
    const uc1 = result.requirements.find((r) => r.id === "UC-01")!;
    expect(uc1.sourceRefs[0]).toMatchObject({ snapshotId: "snap_ba", lineStart: 3, lineEnd: 5 });
    expect(uc1.sourceRefs[0]?.excerpt).toContain("UC-01 HLV tạo giải");
    expect(uc1.confidence).toBe(0.9);
    expect(result.acceptanceCriteria).toHaveLength(1);
    expect(result.acceptanceCriteria[0]?.requirementId).toBe("UC-01");
  });

  it("re-locates or down-weights references that do not exist", () => {
    const result = ingestRequirements(requirements, ba);
    const uc2 = result.requirements.find((r) => r.id === "UC-02")!;
    // Line 999 does not exist; the id is found on line 7 instead.
    expect(uc2.sourceRefs[0]?.lineStart).toBe(7);
    expect(result.warnings.some((w) => w.includes("UC-02"))).toBe(true);
  });

  it("dedupes ids and rejects output without requirements", () => {
    const result = ingestRequirements(requirements, ba);
    expect(new Set(result.requirements.map((r) => r.id)).size).toBe(result.requirements.length);
    expect(() => ingestRequirements({ requirements: [] }, ba)).toThrow(/no requirements/);
    expect(() => ingestRequirements("nope", ba)).toThrow();
  });
});

describe("API operation ingestion", () => {
  it("drops invalid operations and grounds the rest in the contract", () => {
    const result = ingestOperations(operations, api);
    expect(result.operations.map((o) => o.method)).toEqual(["POST", "DELETE"]);
    expect(result.operations[0]).toMatchObject({ id: "createTournament", roles: ["HLV"], responses: [{ status: 409, errorCode: "TOURNAMENT_NAME_TAKEN" }] });
    expect(result.operations[0]?.sourceRefs[0]).toMatchObject({ snapshotId: "snap_api", lineStart: 3, lineEnd: 4 });
    expect(result.operations[1]?.id).toBeTruthy();
    expect(result.warnings.some((w) => w.includes("dropped"))).toBe(true);
  });

  it("rejects output without operations", () => {
    expect(() => ingestOperations({ operations: [] }, api)).toThrow(/no API operations/);
  });
});
