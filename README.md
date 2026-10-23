# GoApp FrontFlow

> Desktop control plane for AI-assisted frontend delivery — *from spec and design to verified frontend.*

FrontFlow attaches to a local frontend project and drives AI CLIs (Claude Code, Codex CLI, Gemini CLI) through a standardised, observable pipeline:

**Figma × API contract → FE readiness → presentational UI → API binding → UI states → implementation gates**, with **BA spec → acceptance test cases → generated auto-tests → traceability & evidence report** alongside.

The product specification is [docs/goapp-frontflow-implementation-spec-v1.md](docs/goapp-frontflow-implementation-spec-v1.md) (v0.3). This README covers how to run the code and how it maps to the spec.

## Quick start

Requirements: Node.js ≥ 22.13 (for `node:sqlite`), Git, Windows/macOS/Linux. At least one AI CLI on `PATH` for real runs (`claude`, `codex` or `gemini`).

```bash
npm install
npm test            # unit + integration (vitest)
npm run typecheck   # all packages and tests
npm run dev         # Electron app with hot reload
npm run build       # production bundle in apps/desktop/out
npm run test:e2e    # builds, then runs the desktop E2E with Playwright
```

To try the full pipeline without spending AI credits, start the app with the fake CLI enabled:

```bash
FRONTFLOW_FAKE_CLI=$PWD/tests/fixtures/fake-cli/fake-cli.mjs npm run dev
```

Then open `tests/fixtures/sample-app` (after `git init` and a first commit), push a frame from the GoApp Figma plugin, and upload `tests/fixtures/alignment/cancel-order/api.md` (API contract step) and `ba.md` (BA specification step).

### Environment variables

| Variable | Purpose |
|---|---|
| `FRONTFLOW_DATA_DIR` | Override `{userData}/goapp-frontflow` (database, artifacts, worktrees) |
| `FRONTFLOW_FAKE_CLI` | Register the fake AI CLI adapter (development/E2E only) |
| `FRONTFLOW_FAKE_CLI_OUTPUTS` | Folder with canned answers the fake CLI returns for the analysis steps (`api-operations.json`, `ui-flow.json`, `readiness.json`, `ba-scenarios.json`, `test-design.json`) |
| `FRONTFLOW_WORKFLOWS_DIR` | Location of `workflows/*.yaml` |
| `FRONTFLOW_SKILLS_SEED_DIR` | Skills copied into an empty library on first launch (default: the repo's `skill/`) |
| `FRONTFLOW_GO_FIGMA_PORT` | Port of the GoApp Figma hub FrontFlow listens to (default 3940, as in go-figma) |
| `FRONTFLOW_E2E_OPEN_PATH` | E2E only: project folder used instead of the native folder dialog |
| `FRONTFLOW_REAL_CLI=1` | Enables the real-CLI adapter tests (calls a real AI CLI and costs credits) |

## Repository layout

```text
apps/desktop/            Electron app: main (IPC gateway, services), preload (typed bridge), renderer (React)
packages/
  domain/                Shared types: statuses, documents, FE readiness, acceptance tests, workflow, RunStore contract
  event-schema/          Normalized AgentEvent / EngineEvent types, secret redaction
  workflow-engine/       DAG scheduler, retry/timeout/pause/resume/cancel, idempotency, restart recovery
  workflow-nodes/        Handlers for every node type in workflows/*.yaml + host wiring
  document-parser/       BA/API/OpenAPI template parsers (fallback when the AI output is unusable); legacy BA ↔ API alignment
  project-analyzer/      Stack, command and convention detection → Project Profile
  git-adapter/           Git CLI wrapper, preflight, worktree/checkpoint/rollback
  policy/                Permission policy engine, command classification, approval broker
  cli-adapters/          AI CLI adapters, PTY/process runner, session manager, utility-process worker
  figma-mcp-bridge/      GoApp Figma link (hub listener, hand-off parsing, MCP config for CLIs); legacy pairing gateway + MCP server
  persistence/           SQLite schema/migrations/repositories, artifact store
  ui-components/         Accessible status badges (icon + text, never colour only)
workflows/               fe-readiness.yaml, ui-implementation.yaml, business-validation.yaml
tests/
  fixtures/              Sample app, BA/API documents, fake AI CLI, analyzer fixture projects
  integration/           End-to-end workflow runs against all real packages
  e2e/                   Electron E2E (Playwright)
```

`packages/workflow-nodes` and `packages/policy`/`git-adapter` are additions to the layout in spec §8.1: node handlers live outside Electron so the complete pipeline is testable in plain Node, and policy/Git are isolated, separately tested units.

## How a run works

FrontFlow is a control wrapper, not a coding agent: it starts and drives AI CLI sessions (headless or interactive tmux/terminal sessions) **in the opened project folder** and records what they do. It does not create a separate worktree or branch by default; before and after each code-changing step it records a hidden git snapshot so a step can be rolled back.

A feature is created with **a name only**. The composed `feature-delivery` workflow (15 steps from the three YAML files, spec §5) starts immediately, and each step asks for its own input when it needs it. Figma and the API contract decide whether the feature can be built; the BA specification is only the test oracle and never blocks implementation.

| Lane | Steps |
|---|---|
| A · FE readiness (Figma × API) | **Select Figma scope** (receives the frames pushed from the GoApp Figma plugin; click Run) ‖ **Read API contract** (import Markdown or OpenAPI; snapshotted with a content hash, then the AI extracts operations with line references) → **Extract UI flow** (the AI reads the frames through the goapp-figma MCP server: screens, actions, UI states and the data/action needs of each interaction) → **Map UI ↔ API readiness** (each UI need is classified `ready` / `partial` / `missing_api` / `missing_design` / `conflict` / `ambiguous` / `fe_only` / `assumed`; gap reports per owner — API → backend, design → designer, mapping → frontend; one gate: *Accept gaps & continue* or start a new run with updated sources) |
| B · UI & API integration | **Analyze project & checkpoint** (stack, commands, baseline snapshot of the project folder; runs in parallel with A) → **AI implements UI** (plan from the FE Readiness Package, presentational UI from Figma, build/typecheck/lint/a11y) → **AI binds API** (client + bindings + consumer contract tests) → **Check backend** (provider verification, or *contract-only*) → **AI adds UI states** (loading/empty/error/permission + component/integration tests) → **Implementation gates** (bounded AI fix loop) |
| C1 · BA test design | **Read BA specification** (import any time; while it is missing the run is `test_design_pending`) → **Design acceptance tests** (BA scenarios × UI flow × API mapping → Acceptance Test Case Package, independent of the implementation; gate on blocking testability gaps) |
| C2 · Acceptance auto-test | **AI generates auto-tests** (test code per test case id with the project's frameworks) → **Run acceptance tests** (failures classified as specification/design/API/test-generation/implementation gap; only the last two are fixed by the AI) → **Traceability & evidence** |

The run screen shows the step list with what each running step is doing, a live activity feed (step logs, AI messages and tool calls, command output, test results), a per-step view with the result, files, tests, evidence and the AI terminal, and an optional graph. Runs and projects can be deleted from the UI; this removes FrontFlow's own data (and its worktrees/branches if the optional worktree mode was used), never the project's own files.

AI output of the analysis steps (A, C1) is never trusted blindly: ids must be unique and known (operations, screens, UI needs, BA requirements), line ranges must exist in the snapshot (the excerpt is re-read from the real document), statuses must be valid, a data need is never `ready` without an operation from the contract, and anything that cannot be grounded is flagged. Invalid AI output is retried; only if it keeps failing does a built-in fallback (template parser, selected layers, keyword heuristics, acceptance criteria) take over, and the result is then marked as assumed.

Every step persists its state and events in SQLite before notifying the UI, so the app can be closed at any point and resumes on restart.

## Skills

Each AI step can follow **skills**: folders with a `SKILL.md` (YAML frontmatter `name` + `description`, then Markdown instructions) and any files the instructions refer to, the same format Claude Code and Codex use.

- The library lives in `{dataDir}/skills/<name>/`; on first launch it is filled from `skill/`. The **Skills** screen creates, edits, renames and deletes skills, and imports a skill folder or a folder of skills (e.g. `~/.claude/skills`). An import never overwrites an existing name.
- **Skills per step** attaches skills to the workflow's AI steps (`{dataDir}/skills/assignments.json`). A step's detail view shows its skills with a link to manage them.
- When a step runs, `runAgentStep` appends its skills to the task prompt (every AI CLI, headless or interactive), with each skill's folder so the AI can read the templates it mentions. The step log names each skill with a content hash.

## GoApp Figma

FrontFlow does not read the design itself; it uses the GoApp Figma plugin and MCP server ([go-figma](https://github.com/tuyndev18/go-figma)).

1. Build go-figma (`npm run build`), import its `manifest.json` in Figma desktop, and add `goapp-figma` to Claude Code from the plugin's MCP panel. FrontFlow finds `dist/mcp.mjs` from that entry (or set the path in Settings → GoApp Figma).
2. FrontFlow listens on the go-figma hub (`ws://127.0.0.1:3940/events`) and starts `mcp.mjs --hub` itself when no hub is running, so the plugin always has one to talk to.
3. When a run reaches **Select Figma scope**, select the frames in Figma and click **FrontFlow** in the plugin. The step shows the file name and frames; pushing again replaces them.
4. Click **Run with N frames**: the selection is snapshotted (`figma-handoff.json`). **Extract UI flow** and later **AI implements UI** start the AI CLI with the `goapp-figma` MCP server and the plugin's prompt. The AI calls `get_metadata` / `get_design_context` / `get_screenshot` itself, so keep the plugin window open while they run.

## Security model (spec §9, §22)

- Renderer: `contextIsolation`, `sandbox`, no Node integration, strict CSP; only a typed preload API. Every IPC payload is validated with zod in main. Uploaded Markdown and AI output are sanitised (DOMPurify) before rendering.
- AI CLIs run in an Electron `utilityProcess`, never in main; secrets reach CLIs via environment variables only.
- All project commands go through `PolicyEngine`: profile scripts are allowed, anything else needs explicit approval; destructive commands always need approval. Tool annotations from MCP are metadata only.
- AI agents edit the opened project folder directly (Settings → *AI works in*: project folder, the default). Each code-changing step is bracketed by hidden git snapshots, so its changes can be reviewed and rolled back without touching your branches; commit or stash first to see the AI's changes on their own. The optional worktree mode keeps them in a separate git worktree instead.
- GoApp Figma: FrontFlow listens on the go-figma hub at `ws://127.0.0.1:3940/events` (the hub refuses browser origins there), validates every pushed selection, and only snapshots it when the user clicks Run. Layer names reach the AI prompt as untrusted data.
- Events, logs and text artifacts are redacted before they are stored or shown.

## Status against the spec

| Area | Status |
|---|---|
| Phase 0–2: shell, PTY runner, persistence, engine, canvas, inspector | Implemented and covered by unit, integration and desktop E2E tests |
| Phase 3: FE readiness (Figma × API) | Implemented; FE Readiness Package with owner-specific gap reports, grounded on fixtures. Packages are stored as run artifacts (not yet in the normalized tables of spec §18.1) |
| Phase 4: UI implementation & API integration | Works with the real GoApp Figma plugin (go-figma): see [GoApp Figma](#goapp-figma); provider verification needs `providerBaseUrl` and a `providerVerify` project command |
| Phase 5: BA-driven auto-test & evidence | Implemented; acceptance test cases, generated tests, root-cause classification and the traceability matrix (UI ↔ API, BA ↔ tests) |
| Phase 6: hardening | Partially: policy, redaction, crash restart of the runner, retention. Packaging, signing and auto-update are not done |

Test totals at the time of writing: see `npm test` (4 real-CLI tests skipped by default) and 1 desktop E2E scenario (create → receive Figma push → import API contract and BA spec → live run → restart → delete).

### Decisions taken for the open questions in spec §27

| # | Question | Current behaviour |
|---|---|---|
| 1 | First AI CLI | Claude Code (stream-json); Codex and Gemini adapters exist, and only Claude was verified against a real binary |
| 2 | Worktree vs branch | Neither by default: the AI works in the current checkout, with hidden git snapshots as checkpoints. A per-run worktree under `{dataDir}/worktrees/{projectId}/{runId}` remains an opt-in setting |
| 3 | Figma plugin connection | The GoApp Figma plugin pushes the selection through its MCP hub; FrontFlow listens, and the AI CLI reads the design with the same MCP server |
| 4 | Contract testing library | Uses the project's `contractTest` script, falling back to `unitTest`; the AI is asked to write contract tests in the project's existing framework |
| 5 | Visual diff | Not automated: the AI compares with `get_screenshot` itself and the visual check is reported as `reference_only` |
| 6 | Retention | Raw terminal logs kept 30 days by default (Settings → Retention, can be disabled; applies on next start); run artifacts live as long as the run |
| 7 | `ready_with_assumptions` | Per run ("Allow continuing with assumptions"); accepted gaps are always shown as *assumed*, never *verified* |
| 8 | Arbitrary shell commands | Off by default. When on, the AI may run only the project's own scripts; anything else still goes through policy and approval |

### Known limitations

- `node:sqlite` is still flagged experimental in Node 22 and prints a warning; the driver is behind an interface so it can be swapped for `better-sqlite3`.
- Approvals for Claude Code in headless mode are enforced through permission mode and policy, not interactive tool approvals (`toolApprovals: false`).
- The graph view uses a fixed lane layout; the step list is the primary view.
- The fake CLI writes `fake-output.txt` to simulate code changes; real UI quality can only be judged with a real AI CLI.
