import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// Workspace packages ship TypeScript sources, so they must be bundled rather than externalized.
const workspacePackages = [
  "@frontflow/claude-accounts",
  "@frontflow/cli-adapters",
  "@frontflow/document-parser",
  "@frontflow/domain",
  "@frontflow/event-schema",
  "@frontflow/figma-mcp-bridge",
  "@frontflow/git-adapter",
  "@frontflow/persistence",
  "@frontflow/policy",
  "@frontflow/project-analyzer",
  "@frontflow/ui-components",
  "@frontflow/workflow-engine",
  "@frontflow/workflow-nodes",
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          runner: resolve(__dirname, "src/main/runner-entry.ts"),
        },
        external: ["node-pty", "node:sqlite"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, "src/renderer/index.html") } },
    },
  },
});
