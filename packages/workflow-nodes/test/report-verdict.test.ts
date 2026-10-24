import { describe, expect, it } from "vitest";
import { reportScore, reportVerdict } from "../src/ai-step.js";
import { judgeCoverage } from "../src/handlers/readiness.js";
import { judgeAcceptance } from "../src/handlers/verification.js";

describe("Markdown report verdict", () => {
  it("reads the first line under Kết luận", () => {
    expect(reportVerdict("## Kết luận\nĐủ\nCó đủ dữ liệu.\n\n## Còn thiếu\nKhông có")).toBe("enough");
    expect(reportVerdict("# Review\n\n## Kết luận\n\n**Chưa đủ** để triển khai trọn UI.\n## Còn thiếu\n- field")).toBe("not_enough");
    expect(reportVerdict("### kết luận\n`Đủ`.")).toBe("enough");
  });

  it("is undefined when the conclusion does not follow the format", () => {
    expect(reportVerdict("## Kết luận\nĐủng ra là thiếu")).toBeUndefined();
    expect(reportVerdict("Completed prompt #3")).toBeUndefined();
    expect(reportVerdict("## Kết luận\nNhìn chung là đủ")).toBeUndefined();
  });

  it("matches decomposed Vietnamese text too", () => {
    expect(reportVerdict("## Kết luận\nChưa đủ".normalize("NFD"))).toBe("not_enough");
  });
});

describe("UI vs API review coverage", () => {
  it("reads the Đáp ứng line under Kết luận", () => {
    expect(reportScore("## Kết luận\nĐáp ứng: 95%\nThiếu 1 field.")).toBe(95);
    expect(reportScore("## Kết luận\n\n**Đáp ứng: 87,5 %** — thiếu loại nhiệm vụ.")).toBe(87.5);
    expect(reportScore("## Kết luận\nĐáp ứng 100%")).toBe(100);
    expect(reportScore("## Kết luận\nĐủ")).toBeUndefined();
    expect(reportScore("## Kết luận\nĐáp ứng: 140%")).toBeUndefined();
  });

  it("passes from 92% only", () => {
    expect(judgeCoverage("## Kết luận\nĐáp ứng: 92%")).toMatchObject({ verdict: "enough", fields: { score: 92 } });
    expect(judgeCoverage("## Kết luận\nĐáp ứng: 91.9%")).toMatchObject({ verdict: "not_enough", fields: { score: 91.9 } });
    expect(judgeCoverage("## Kết luận\nChưa đủ").verdict).toBeUndefined();
  });
});

describe("acceptance test report", () => {
  it("reads Đạt / Chưa đạt under Kết luận", () => {
    expect(judgeAcceptance("## Kết luận\nĐạt\nCả 3 test case pass.")).toMatchObject({ verdict: "enough" });
    expect(judgeAcceptance("## Kết luận\n**Chưa đạt** — TC-01 fail.")).toMatchObject({ verdict: "not_enough" });
    expect(judgeAcceptance("## Kết luận\nĐạt yêu cầu phần lớn".normalize("NFD")).verdict).toBe("enough");
    expect(judgeAcceptance("## Kết luận\nĐạtđược").verdict).toBeUndefined();
    expect(judgeAcceptance("Tests ran.").verdict).toBeUndefined();
  });
});
