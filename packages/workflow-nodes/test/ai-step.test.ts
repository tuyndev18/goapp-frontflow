import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NodeExecutionContext } from "@frontflow/workflow-engine";
import { fileList, latestUpload, writeRunDocuments } from "../src/ai-step.js";
import type { NodeServices } from "../src/services.js";

describe("document uploads", () => {
  it("uses the latest upload as a list, also for single documents of older runs", () => {
    expect(latestUpload([{ id: 1 }, { id: 2 }], { id: 0 })).toEqual([{ id: 1 }, { id: 2 }]);
    expect(latestUpload({ id: 1 }, undefined)).toEqual([{ id: 1 }]);
    expect(latestUpload(undefined, { id: 0 })).toEqual([{ id: 0 }]);
    expect(latestUpload(undefined, undefined)).toEqual([]);
  });

  it("replaces the folder with the latest upload, with safe and unique names", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-docs-"));
    const services = { runFilesDir: () => dir } as unknown as NodeServices;
    const ctx = { projectId: "p", runId: "r" } as NodeExecutionContext;
    writeRunDocuments(services, ctx, "api-contract", [{ name: "old.md", text: "v1" }]);
    const files = writeRunDocuments(services, ctx, "api-contract", [
      { name: "C:\\docs\\api.md", text: "a" },
      { name: "api.md", text: "b" },
      { name: "../../evil?.md", text: "c" },
      { name: "", text: "d" },
    ]);
    expect(readdirSync(join(dir, "api-contract")).sort()).toEqual(["api-2.md", "api.md", "document-4.md", "evil_.md"]);
    expect(files).toHaveLength(4);
    expect(fileList([files[0] ?? ""])).toBe(files[0]);
    expect(fileList(files)).toContain("\n  - ");
  });
});
