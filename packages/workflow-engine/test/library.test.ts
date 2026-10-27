import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_DELIVERY_WORKFLOW_ID, WorkflowDefinitionError, WorkflowLibrary, WorkflowLibraryError } from "../src/index.js";

const WORKFLOWS_DIR = fileURLToPath(new URL("../../../workflows", import.meta.url));

type Options = ConstructorParameters<typeof WorkflowLibrary>[0];

function library(check?: Options["check"], upgrade?: Options["upgrade"]) {
  const userDir = join(mkdtempSync(join(tmpdir(), "ff-workflows-")), "workflows");
  return { lib: new WorkflowLibrary({ builtinDir: WORKFLOWS_DIR, userDir, ...(check ? { check } : {}), ...(upgrade ? { upgrade } : {}) }), userDir };
}

const raw = (extra: Record<string, unknown> = {}) => ({
  id: "quick-fix",
  name: "Quick fix",
  lanes: [{ id: "main", title: "Main" }],
  nodes: [
    { id: "fix", type: "ai.prompt", label: "Fix", group: "main" },
    { id: "check", type: "manual.check", label: "Check", group: "main", dependencies: ["fix"] },
  ],
  ...extra,
});

describe("WorkflowLibrary", () => {
  it("lists the built-in workflow first, read-only", () => {
    const { lib } = library();
    const [first] = lib.list();
    expect(first?.builtin).toBe(true);
    expect(first?.definition.id).toBe(FEATURE_DELIVERY_WORKFLOW_ID);
    expect(() => lib.save({ ...raw(), id: FEATURE_DELIVERY_WORKFLOW_ID })).toThrow(WorkflowLibraryError);
    expect(() => lib.remove(FEATURE_DELIVERY_WORKFLOW_ID)).toThrow(/built-in/);
  });

  it("saves user workflows and bumps the version only when the content changes", () => {
    const { lib } = library();
    expect(lib.save(raw()).version).toBe(1);
    expect(lib.save({ ...raw(), version: 40 }).version).toBe(1);
    expect(lib.save(raw({ name: "Quick fix v2" })).version).toBe(2);
    const entry = lib.get("quick-fix");
    expect(entry).toMatchObject({ builtin: false, definition: { name: "Quick fix v2", version: 2 } });
    expect(entry.definition.nodes.map((n) => [n.id, n.group, n.dependencies])).toEqual([
      ["fix", "main", []],
      ["check", "main", ["fix"]],
    ]);
    expect(lib.list().map((e) => e.definition.id)).toEqual([FEATURE_DELIVERY_WORKFLOW_ID, "quick-fix"]);
    lib.remove("quick-fix");
    expect(() => lib.get("quick-fix")).toThrow(/No workflow/);
  });

  it("rejects invalid ids, definitions and what the host check refuses", () => {
    const { lib } = library((def) => def.nodes.filter((n) => n.type !== "ai.prompt").map((n) => `node "${n.id}": unsupported`));
    expect(() => lib.save(raw({ id: "../x" }))).toThrow(/Invalid workflow id/);
    expect(() => lib.save(raw({ nodes: [] }))).toThrow(WorkflowDefinitionError);
    try {
      lib.save(raw());
      expect.unreachable();
    } catch (err) {
      expect((err as WorkflowDefinitionError).issues).toEqual(['node "check": unsupported']);
    }
  });

  it("skips user files that do not parse or whose id differs from the file name", () => {
    const { lib, userDir } = library();
    lib.save(raw());
    writeFileSync(join(userDir, "broken.yaml"), "id: broken\nnodes: 3\n");
    writeFileSync(join(userDir, "other.yaml"), "id: quick-fix\nname: X\nnodes:\n  - { id: a, type: t }\n");
    expect(lib.list().map((e) => e.definition.id)).toEqual([FEATURE_DELIVERY_WORKFLOW_ID, "quick-fix"]);
  });

  it("upgrades a user workflow saved before a change of the host's steps once, as a new version", () => {
    let upgrades = 0;
    const { lib, userDir } = library(undefined, (def) => {
      if (!def.nodes.some((n) => n.id === "fix")) return undefined;
      upgrades++;
      return { ...def, nodes: def.nodes.map((n) => ({ ...n, id: n.id === "fix" ? "repair" : n.id, dependencies: n.dependencies.map((d) => (d === "fix" ? "repair" : d)) })) };
    });
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      join(userDir, "quick-fix.yaml"),
      "id: quick-fix\nname: Quick fix\nversion: 3\nlanes: [{ id: main, title: Main }]\nnodes:\n  - { id: fix, type: ai.prompt, group: main }\n  - { id: check, type: manual.check, group: main, dependencies: [fix] }\n",
    );
    const { definition } = lib.get("quick-fix");
    expect(definition.version).toBe(4);
    expect(definition.nodes.map((n) => [n.id, n.dependencies])).toEqual([
      ["repair", []],
      ["check", ["repair"]],
    ]);
    expect(lib.get("quick-fix").definition.version).toBe(4);
    expect(upgrades).toBe(1);
  });

  it("makes free ids from names", () => {
    const { lib } = library();
    lib.save(raw());
    expect(lib.newId("Quick fix")).toBe("quick-fix-2");
    expect(lib.newId("Kiểm tra đơn hàng!")).toBe("kiem-tra-don-hang");
    expect(lib.newId("***")).toBe("workflow");
  });
});
