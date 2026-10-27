import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { NodeExecutionContext } from "@frontflow/workflow-engine";
import { fileList, latestUpload, reportStep, writeRunDocuments } from "../src/ai-step.js";
import { runAgentStep } from "../src/agent.js";
import type { NodeServices } from "../src/services.js";

vi.mock("../src/agent.js", () => ({ runAgentStep: vi.fn() }));

it("grants design review MCP access while keeping shell commands disabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-review-"));
  const ctx = { projectId: "p", runId: "r", nodeId: "review", workflowId: "test", attempt: 1, log: vi.fn(), emitArtifact: vi.fn() } as unknown as NodeExecutionContext;
  const services = {
    runFilesDir: () => dir,
    prompts: { get: () => ({ text: "Write {{output}}" }) },
    artifacts: { write: () => ({ id: "artifact" }) },
  } as unknown as NodeServices;
  vi.mocked(runAgentStep).mockImplementationOnce(async () => {
    writeFileSync(join(dir, "review.md"), "## Kết luận\nĐủ");
    return { sessionId: "session", resultText: "done", filesChanged: [] };
  });
  try {
    const result = await reportStep(ctx, services, { inputs: { snapshotIds: [], adapterId: "fake" }, upstream: {}, config: {} }, {
      fileName: "review.md", label: "Review", cwd: dir, vars: {}, withFigma: true,
    });
    expect(result.status).toBe("passed");
    expect(runAgentStep).toHaveBeenCalledWith(ctx, services, expect.objectContaining({ withFigma: true, filesOnly: true }));
    expect(vi.mocked(runAgentStep).mock.calls[0]?.[2].allowedCommands).toBeUndefined();
  } finally {
    vi.mocked(runAgentStep).mockClear();
    rmSync(dir, { recursive: true, force: true });
  }
});

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
