import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * Desktop E2E (spec Â§23.4): create a feature by name, import the documents and
 * receive a selection pushed by a stand-in GoApp Figma hub inside their workflow steps, follow the fake AI
 * CLI live, inspect a step, restart the app, then delete the run and project.
 * Requires `npm run build` first.
 */
const ROOT = resolve(import.meta.dirname, "../..");
const FIXTURES = join(ROOT, "tests/fixtures");
const shots = process.env["FRONTFLOW_E2E_SCREENSHOTS"];

/** What the GoApp Figma plugin's FrontFlow button pushes through its hub. */
const HANDOFF = {
  id: "GF-E2E001",
  projectName: "Cancel order",
  fileName: "Cancel order",
  target: "react-tailwind",
  nodes: [{ id: "123:456", name: "Create Tournament Modal", width: 480 }],
  prompt: 'Implement this Figma design in this codebase, using the goapp-figma MCP server.\n\nFigma file "Cancel order":\n- "Create Tournament Modal" (node id 123:456)',
  createdAt: "2026-10-22T08:00:00.000Z",
};

/** Stand-in for the go-figma MCP hub on localhost: FrontFlow listens on /events. */
let hub: WebSocketServer;
let hubPort: number;
const listeners = new Set<WebSocket>();

test.beforeAll(async () => {
  hub = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((done) => hub.once("listening", () => done()));
  hubPort = (hub.address() as AddressInfo).port;
  hub.on("connection", (ws) => {
    listeners.add(ws);
    ws.on("close", () => listeners.delete(ws));
  });
});

test.afterAll(() => {
  for (const ws of listeners) ws.terminate();
  hub.close();
});

let work: string;
let projectRoot: string;
let dataDir: string;

test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "frontflow-e2e-"));
  projectRoot = join(work, "sample-app");
  dataDir = join(work, "appdata");
  cpSync(join(FIXTURES, "sample-app"), projectRoot, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@example.com", "-c", "core.autocrlf=false", ...args], { cwd: projectRoot });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
});

test.afterAll(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  // Hosts such as editor terminals may export ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
  const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
  const app = await electron.launch({
    args: [join(ROOT, "apps/desktop")],
    env: {
      ...(env as Record<string, string>),
      FRONTFLOW_DATA_DIR: dataDir,
      FRONTFLOW_E2E_OPEN_PATH: projectRoot,
      FRONTFLOW_FAKE_CLI: join(FIXTURES, "fake-cli/fake-cli.mjs"),
      FRONTFLOW_FAKE_CLI_OUTPUTS: join(FIXTURES, "alignment/cancel-order/ai"),
      FRONTFLOW_GO_FIGMA_PORT: String(hubPort),
      FRONTFLOW_WORKFLOWS_DIR: join(ROOT, "workflows"),
    },
  });
  const page = await app.firstWindow();
  // Renderer errors would otherwise only show up as missing elements.
  page.on("pageerror", (err) => console.error("[renderer error]", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("[renderer console]", msg.text());
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  return { app, page };
}

const runStatus = (page: Page) => page.locator(".ff-run-header [role=status]").first();
const step = (page: Page, label: string) =>
  page.getByRole("region", { name: "Workflow canvas" }).locator(".react-flow__node-step").filter({ has: page.locator(".ff-gnode-title", { hasText: label }) });

test("feature workflow: create by name, push Figma, import into steps, follow live, restart, delete", async () => {
  let { app, page } = await launch();
  try {
    await page.getByRole("button", { name: "+ Open project folder" }).click();
    await expect(page.getByRole("heading", { name: "sample-app" })).toBeVisible({ timeout: 30_000 });
    // The fake CLI is not the Settings default; make it the engine for this test.
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Default adapter").selectOption("fake");
    await page.getByRole("button", { name: "Projects" }).click();
    await page.getByRole("button", { name: "sample-app", exact: true }).click();

    await page.getByRole("button", { name: "+ New feature" }).first().click();
    await page.getByLabel("Feature name").fill("Cancel order");
    await page.getByRole("button", { name: "Create feature" }).click();

    // Step B1.figma_scope only receives data: the plugin pushes, nothing runs until Run is clicked.
    await expect(page.getByRole("heading", { name: "Select Figma scope" })).toBeVisible();
    if (shots) await page.getByRole("region", { name: "Workflow canvas" }).screenshot({ path: join(shots, "0-canvas-start.png"), animations: "disabled" });
    await expect(page.getByTestId("figma-listening")).toContainText("Listening", { timeout: 30_000 });
    for (const ws of listeners) ws.send(JSON.stringify({ type: "handoff", handoff: HANDOFF }));
    await expect(page.getByTestId("figma-handoff")).toContainText("Create Tournament Modal", { timeout: 15_000 });
    await page.getByRole("button", { name: "Run with 1 frame" }).click();

    // Step A.api_contract asks for the API contract whenever it is ready; the UI is built meanwhile.
    await step(page, "Read API contract").click();
    await expect(page.getByText("Needs your input.")).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("API contract", { exact: true }).setInputFiles(join(FIXTURES, "alignment/cancel-order/api.md"));
    if (shots) await page.screenshot({ path: join(shots, "1-import-api.png") });
    await page.getByRole("button", { name: "Import & continue" }).click();

    // Step C1.ba_spec asks for the BA specification; it only drives the acceptance tests.
    await step(page, "Read BA specification").click();
    await expect(page.getByText("Needs your input.")).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("BA specification", { exact: true }).setInputFiles(join(FIXTURES, "alignment/cancel-order/ba.md"));
    await page.getByRole("button", { name: "Import & continue" }).click();

    // Follow the run live.
    await page.getByRole("button", { name: "All activity", exact: true }).click();
    await expect(page.getByRole("log")).toContainText("Saved api.md", { timeout: 60_000 });
    await expect(runStatus(page)).toHaveAttribute("aria-label", /Completed with assumptions/, { timeout: 180_000 });
    await expect(page.getByRole("log")).toContainText("UI vs API review written to");
    await expect(page.getByRole("log")).toContainText("AI finished");
    await expect(page.getByRole("log")).toContainText("Contract-only");
    if (shots) await page.screenshot({ path: join(shots, "2-run-activity.png") });

    // The review is a short Markdown report, shown as the step result.
    await step(page, "AI reviews UI vs API").click();
    await expect(page.getByText(/Modal huỷ đơn có đủ dữ liệu/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Open in folder" })).toBeVisible();
    if (shots) await page.screenshot({ path: join(shots, "5-verdict.png") });
    await step(page, "AI implements UI").click();
    await expect(page.getByRole("log")).toContainText("Checkpoint");
    if (shots) await page.screenshot({ path: join(shots, "3-step-detail.png") });

    // The step is just an editable prompt.
    await page.getByRole("tab", { name: "Prompt" }).click();
    const promptBox = page.getByLabel("Prompt of AI implements UI");
    await expect(promptBox).toHaveValue(/Implement the presentational UI of the feature "\{\{feature\}\}"/);
    await promptBox.fill("Implement the presentational UI of {{feature}} pixel-perfect.\n\n{{figma}}");
    await page.getByRole("button", { name: "Save prompt" }).click();
    await expect(page.getByText("edited", { exact: true })).toBeVisible();
    if (shots) await page.screenshot({ path: join(shots, "8-prompt.png") });
    await page.getByRole("button", { name: "Reset to default" }).click();
    await expect(promptBox).toHaveValue(/Implement the presentational UI of the feature/);

    // A step's Claude Code is only reached through its own terminal (tmux-style pane); there is no chat.
    await page.getByRole("tab", { name: "Terminal" }).click();
    await expect(page.getByText(/Claude terminal/)).toBeVisible();

    await step(page, "Evidence report").click();
    await page.getByRole("tab", { name: /Evidence/ }).click();
    await expect(page.getByRole("button", { name: /evidence-report\.md/ })).toBeVisible();

    // The workflow canvas sits beside the run panel; each step carries its manual action.
    await page.getByRole("button", { name: "All activity", exact: true }).click();
    const canvas = page.getByRole("region", { name: "Workflow canvas" });
    await expect(canvas.locator(".react-flow__node-step")).toHaveCount(13);
    await expect(canvas.locator(".react-flow__node-lane")).toHaveCount(4);
    await expect(canvas.locator(".ff-gnode")).toHaveCount(13);
    // Finished steps need nothing from you: no action button left on the canvas.
    await expect(canvas.locator(".ff-gnode-action")).toHaveCount(0);
    if (shots) await page.screenshot({ path: join(shots, "4-graph.png"), animations: "disabled" });
    if (shots) await canvas.screenshot({ path: join(shots, "4b-canvas.png"), animations: "disabled" });

    await page.getByRole("button", { name: "Reports" }).click();
    await expect(page.getByText(/Modal huỷ đơn có đủ dữ liệu/)).toBeVisible();
    await page.getByRole("tab", { name: "Test design" }).click();
    await expect(page.getByText(/TC-BA-ORDER-001-01/).first()).toBeVisible();
  } finally {
    await app.close();
  }

  // Restart: project and run are restored from SQLite (spec DoD #9), then deleted from the UI.
  ({ app, page } = await launch());
  try {
    await expect(page.getByRole("button", { name: /Cancel order/ })).toBeVisible();
    await page.getByRole("button", { name: /Cancel order/ }).click();
    await expect(runStatus(page)).toHaveAttribute("aria-label", /Completed with assumptions/);

    await page.getByRole("button", { name: "Delete run" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete run" }).click();
    await expect(page.getByRole("heading", { name: "sample-app" })).toBeVisible();
    await expect(page.getByText("No runs yet.")).toBeVisible();

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: /Remove project/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove project" }).click();
    await expect(page.getByText("No projects yet.", { exact: false })).toBeVisible();
  } finally {
    await app.close();
  }
});
