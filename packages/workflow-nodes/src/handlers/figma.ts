import { hashJson } from "@frontflow/domain";
import { escapeMarkdownText } from "@frontflow/document-parser";
import { parseFigmaHandoff, type FigmaHandoff } from "@frontflow/figma-mcp-bridge";
import { NodeError, type NodeHandler } from "@frontflow/workflow-engine";
import type { NodeServices } from "../services.js";
import { plural, projectOf, runInputs, saveArtifact } from "../util.js";

/**
 * What the run knows about the design: the layers the GoApp Figma plugin pushed. FrontFlow does not
 * read the design itself; the AI CLI reads it through the goapp-figma MCP server while coding.
 */
export interface FigmaDesignOutput {
  handoffId: string;
  projectName: string;
  fileName: string;
  fileKey?: string;
  /** Reference code flavor picked in the plugin. */
  target: string;
  nodes: Array<{ nodeId: string; name: string; width: number; tag?: string; url?: string }>;
  /** The plugin's "Copy for AI" prompt for these layers. */
  prompt: string;
  snapshotHash: string;
  snapshotArtifactId: string;
}

const WAITING =
  'In Figma, select the frames for this feature and click "FrontFlow" in the GoApp Figma plugin. The selection shows up here; click Run to let the AI read the UI flow. Keep the plugin window open.';

export function figmaHandlers(services: NodeServices): Record<string, NodeHandler> {
  return {
    "figma.design": {
      async execute(ctx, input) {
        // 1. The selection the user chose to run: pushed by the plugin, or pinned when the run was created
        const provided = input.providedInput as { handoff?: unknown } | undefined;
        const raw = provided?.handoff ?? runInputs(input).figma?.handoff;
        if (raw === undefined) {
          ctx.log("info", "Waiting for a selection from the GoApp Figma plugin");
          return { status: "waiting_for_input", prompt: WAITING };
        }
        const handoff = parseFigmaHandoff(raw);
        if (!handoff) {
          ctx.log("warn", "The Figma selection is malformed; send it again from the plugin");
          return { status: "waiting_for_input", prompt: `The Figma selection could not be read. ${WAITING}` };
        }

        const { rootPath } = await projectOf(ctx, services);
        const decision = services.policy.evaluate({ permission: "read_external_design", action: "Use the Figma selection pushed by GoApp Figma", projectRoot: rootPath, integration: "figma-bridge", source: "system" });
        if (decision.effect !== "allow") throw new NodeError("PERMISSION_DENIED", decision.reason);

        ctx.log("info", `${handoff.id} from "${handoff.projectName}": ${plural(handoff.nodes.length, "layer")} (${handoff.target})`);
        for (const n of handoff.nodes) ctx.log("info", `Layer "${n.name}" ${n.id}${tagOf(n) ? ` (${tagOf(n)})` : ""}`);
        if (!services.figma?.serverPath()) ctx.log("warn", "GoApp Figma MCP server not found (Settings → GoApp Figma): the AI will not be able to read the design");

        // 2. Snapshot (spec §11.4): the run is pinned to these layers, not to whatever is pushed later.
        // The hash pins the exact selection; the kept file is readable Markdown like every run file.
        const snapshotHash = hashJson(handoff);
        const snapshotArtifactId = await saveArtifact(ctx, services, "figma_snapshot", "figma-handoff.md", handoffMarkdown(handoff, snapshotHash), "text/markdown", `Figma ${handoff.id}`);
        const output: FigmaDesignOutput = {
          handoffId: handoff.id,
          projectName: handoff.projectName,
          fileName: handoff.fileName,
          ...(handoff.fileKey ? { fileKey: handoff.fileKey } : {}),
          target: handoff.target,
          nodes: handoff.nodes.map((n) => {
            const tag = tagOf(n);
            return { nodeId: n.id, name: n.name, width: n.width, ...(tag ? { tag } : {}), ...(n.url ? { url: n.url } : {}) };
          }),
          prompt: handoff.prompt,
          snapshotHash,
          snapshotArtifactId,
        };
        return { status: "passed", output };
      },
    },
  };
}

function handoffMarkdown(handoff: FigmaHandoff, hash: string): string {
  const esc = escapeMarkdownText;
  // Longer than any backtick run in the prompt, so the prompt cannot close the code block.
  const fence = "`".repeat(Math.max(3, ...(handoff.prompt.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  return [
    `# Figma ${esc(handoff.id)} — ${esc(handoff.projectName)}`,
    "",
    `- File: ${esc(handoff.fileName)}${handoff.fileKey ? ` (\`${handoff.fileKey.replace(/`/g, "")}\`)` : ""}`,
    `- Code target: ${esc(handoff.target)}`,
    `- Snapshot hash: \`${hash}\``,
    "",
    "## Layers",
    "",
    ...handoff.nodes.map((n) => `- ${esc(n.name)} \`${n.id.replace(/`/g, "")}\` — ${n.width}px${tagOf(n) ? ` (${esc(tagOf(n) ?? "")})` : ""}${n.url ? ` — ${esc(n.url)}` : ""}`),
    "",
    "## Prompt from the plugin",
    "",
    `${fence}text`,
    handoff.prompt,
    fence,
  ].join("\n");
}

function tagOf(node: FigmaHandoff["nodes"][number]): string | undefined {
  return node.breakpoint ? `${node.breakpoint} breakpoint` : node.state ? `state "${node.state}"` : undefined;
}
