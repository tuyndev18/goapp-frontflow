# GoApp FrontFlow

> Desktop control plane for AI-assisted frontend delivery — *from spec and design to verified frontend.*

FrontFlow attaches to a local frontend project and drives AI CLIs (Claude Code, Codex CLI, Gemini CLI) through a standardised, observable pipeline:

**Figma × API contract → FE readiness → presentational UI → API binding → UI states**, with **BA spec → acceptance test cases → generated auto-tests → evidence report** alongside.

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
| `FRONTFLOW_DATA_DIR` | Override `{userData}/goapp-frontflow` (database, artifacts, scratch folders) |
| `FRONTFLOW_FAKE_CLI` | Register the fake AI CLI adapter (development/E2E only) |
| `FRONTFLOW_FAKE_CLI_OUTPUTS` | Folder with canned answers the fake CLI returns for the analysis steps (`api-review.md`, `ba-scenarios.md`, `test-design.md`) |
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
  git-adapter/           Git CLI wrapper, preflight, hidden snapshot checkpoints
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

FrontFlow is a control wrapper, not a coding agent: it opens AI CLI sessions (interactive tmux/terminal sessions, or headless) **in the opened project folder** and drives them step by step, recording what they do. There is no separate worktree or branch: around each code-changing step it records a hidden git snapshot (`refs/frontflow/<run>`) so the step can be reviewed and rolled back. Commit or stash your own changes first to see the AI's changes on their own.

**Every AI step is just an editable prompt** (`workflows/prompts/<step id>.md`, plus `_system.md`): the step fills in its `{{placeholders}}` (Figma selection, saved API contract, review, test cases…) and an AI agent runs it in the project folder — Claude Code always as an interactive session in a tmux-style pane (AI terminals), other CLIs headless. The step ends when the agent ends its answer; if it left work in the background (e.g. a long test run watched with `Monitor`) and has not written its report yet, the session stays open until it does. AI steps have no time limit (`timeoutMs: 0` in the workflow YAML): a waiting Claude costs nothing, so after 10 minutes without activity the step only logs a warning, and you answer it in its AI terminal or cancel it. Edit a prompt in the step's **Prompt** tab (stored in `{dataDir}/prompts/`, *Reset to default* restores the shipped one); the rendered prompt of each attempt is kept as evidence. Files a step hands to the agent live in `.frontflow/runs/<run>/` inside the project, which FrontFlow git-ignores.

A feature is created with **a name only**. The composed `feature-delivery` workflow (13 steps from the three YAML files) starts immediately, and each step asks for its own input when it needs it. The UI is built from Figma first, because the API contract is often not ready yet; when the contract arrives, the built UI is reviewed against it before the API is wired in. The BA specification is only the test oracle and never blocks implementation.

| Lane | Steps |
|---|---|
| ① Build UI from Figma (B1) | **Select Figma scope** (receives the frames pushed from the GoApp Figma plugin; click Run) → **AI implements UI** (prompt: presentational UI from Figma with mock data). There is no "analyze project" step: the agent reads the project itself |
| ② Review against the API contract (A) | **Read API contract** (import Markdown or OpenAPI whenever it is ready; snapshotted with a content hash and saved in the run folder under `api-contract/`, no AI. One upload may hold several files (up to 20); a newer upload can be made on the step at any time — every upload is kept in its history, but only the files of the latest one are in the run folder and read, and the steps after it run again) → **AI reviews UI vs API** (prompt: the agent checks whether the contract is enough to implement the UI it built — Figma is not read again — and writes a short Markdown review in Vietnamese, `api-review.md`: *Kết luận* `Đáp ứng: NN%` (how much of what the built UI needs the contract provides) and what is missing; the next steps' agents read it. One gate: below **92%** it waits until a newer contract is uploaded or *Accept gaps & continue*, which keeps that review and marks what follows as assumed) |
| ③ Integrate the API (B2) | **AI binds API** (client + bindings into the built UI + consumer contract tests) → **Check backend** (provider verification, or *contract-only*) → **AI adds UI states** (loading/empty/error/permission + component/integration tests) |
| ④ BA test design (C1) | **Read BA specification** (import any time, one or more files, and upload again later the same way as the API contract — only the latest upload is read; while it is missing the run is `test_design_pending`) (the agent lists the BA scenarios in `ba-scenarios.md`) → **Design acceptance tests** (BA scenarios → `test-design.md`: test cases and what cannot be tested yet, from the BA only — not from the API contract, the design or the code; it starts as soon as the BA is imported; gate on its *Kết luận* `Đủ` / `Chưa đủ`) |
| ④ Acceptance auto-test (C2) | **Read test operations guide** (optional, no AI, never waits: the feature's guide to prepare test data and preconditions, e.g. in the CMS, as Markdown, saved under `ops-guide/`; import or upload it again any time, then the auto-tests run again with it — test design is not affected. It never sets expected outcomes, and CMS access comes from the project's own test configuration, not from the guide) + **AI generates auto-tests** (once the UI is integrated: maps each test case onto the real screens and selectors of the frontend, then writes one Playwright E2E test per test case id — no unit tests, and it does not run them. FrontFlow is only the wrapper: the prompt leaves the test setup to the project's own way (docs, skills, existing tests); a project without Playwright gets it set up behind a `test:e2e` script, and the profile's e2e command is pointed at it; no API contract) → **Run acceptance tests** (prompt: the agent runs this feature's Playwright tests the project's way, fixes implementation and test-generation gaps — never an expected outcome from the BA — and writes `acceptance-tests.md` in Vietnamese: *Kết luận* `Đạt` / `Chưa đạt`, the result of each test case and what it fixed; FrontFlow runs no test command itself, its fixes are checkpointed, and anything but `Đạt` waits until you run it again or accept) → **Evidence report** (`evidence-report.md`) |

The run screen shows the step list with what each running step is doing, a live activity feed (step logs, AI messages and tool calls, command output, test results), a per-step view with the result, files, tests, evidence and the AI terminal (Markdown results can be copied or opened in their folder), and the workflow canvas, which always fits the whole workflow in its window. The terminal button next to the accounts bubble opens a fresh, interactive Claude Code in the project folder, as the feature's Claude account, in a large popover above it, to work on the feature by hand; *Hide* (or a click outside) hides it and it keeps running until *Close terminal* or you leave the run. A project `.claude/settings*.json` that Claude would stop on with a "Settings Warning" (e.g. an allow rule `*`) is left out of these terminals, as in the workflow steps. Any finished step can be run again (**Run again**, e.g. after editing its prompt; the steps after it are reset and run again too, also for a run that already finished). Runs and projects can be deleted from the UI; this removes FrontFlow's own data and the runs' hidden snapshots, never the project's own files or branches.

Every file the workflow produces is Markdown, written in Vietnamese by the AI steps (`api-review.md`, `ba-scenarios.md`, `test-design.md`) or by FrontFlow (`acceptance-tests.md`, `evidence-report.md`), and kept with the imported documents in the run folder in FrontFlow's data, `{dataDir}/projects/<project>/runs/<run>/files/` — never in the project (the agent is given access to that folder). FrontFlow does not parse the reports; it only reads the first line under *Kết luận* to gate: the review's `Đáp ứng: NN%` (at least 92% to go on) and the test design's `Đủ` / `Chưa đủ`. If an agent writes no report, the step is retried, then its final answer is kept as the report, marked as assumed. The **Reports** screen shows a run's reports.

FrontFlow runs no implementation gates (build, typecheck, lint, accessibility): a code-changing AI step passes when its agent session ends, and only agent failures (session error, timeout) are retried. Checking its own work is part of the step's prompt.

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
4. Click **Run with N frames**: the selection is snapshotted (`figma-handoff.md`, with its hash). **AI implements UI** (right away) and later **Extract UI flow** (once the API contract is in) start the AI CLI with the `goapp-figma` MCP server and the plugin's prompt. The AI calls `get_metadata` / `get_design_context` / `get_screenshot` itself, so keep the plugin window open while they run.

## Security model (spec §9, §22)

- Renderer: `contextIsolation`, `sandbox`, no Node integration, strict CSP; only a typed preload API. Every IPC payload is validated with zod in main. Uploaded Markdown and AI output are sanitised (DOMPurify) before rendering.
- AI CLIs run in an Electron `utilityProcess`, never in main; secrets reach CLIs via environment variables only.
- All project commands go through `PolicyEngine`: profile scripts are allowed, anything else needs explicit approval; destructive commands always need approval. Tool annotations from MCP are metadata only.
- AI agents edit the opened project folder directly; FrontFlow never creates worktrees or branches. Each code-changing step is bracketed by hidden git snapshots, so its changes can be reviewed and rolled back without touching your branches; commit or stash first to see the AI's changes on their own. Git commands that change the working tree still need approval. A step fails if its agent writes outside the project folder; the only exception is Claude Code's own session scratchpad (`<tmp>/claude/<project>/<session>/scratchpad`), which is logged instead.
- GoApp Figma: FrontFlow listens on the go-figma hub at `ws://127.0.0.1:3940/events` (the hub refuses browser origins there), validates every pushed selection, and only snapshots it when the user clicks Run. Layer names reach the AI prompt as untrusted data.
- Events, logs and text artifacts are redacted before they are stored or shown.

## Status against the spec

| Area | Status |
|---|---|
| Phase 0–2: shell, PTY runner, persistence, engine, canvas, inspector | Implemented and covered by unit, integration and desktop E2E tests |
| Phase 3: FE readiness (Figma × API) | Implemented as a short AI review (Markdown) of whether the API contract is enough for the built UI, with a gate on its conclusion; the structured FE Readiness Package of spec §12 is no longer produced |
| Phase 4: UI implementation & API integration | Works with the real GoApp Figma plugin (go-figma): see [GoApp Figma](#goapp-figma); provider verification needs `providerBaseUrl` and a `providerVerify` project command |
| Phase 5: BA-driven auto-test & evidence | Implemented; acceptance test cases, generated tests, root-cause classification and the run's Markdown reports (Reports screen); the structured Acceptance Test Case Package and traceability matrix are no longer produced |
| Phase 6: hardening | Partially: policy, redaction, crash restart of the runner, retention. Packaging, signing and auto-update are not done |

Test totals at the time of writing: see `npm test` (4 real-CLI tests skipped by default) and 1 desktop E2E scenario (create → receive Figma push → import API contract and BA spec → live run → restart → delete).

### Decisions taken for the open questions in spec §27

| # | Question | Current behaviour |
|---|---|---|
| 1 | First AI CLI | Claude Code (stream-json); Codex and Gemini adapters exist, and only Claude was verified against a real binary |
| 2 | Worktree vs branch | Neither: FrontFlow only drives AI agents in the current checkout, with hidden git snapshots as checkpoints |
| 3 | Figma plugin connection | The GoApp Figma plugin pushes the selection through its MCP hub; FrontFlow listens, and the AI CLI reads the design with the same MCP server |
| 4 | Contract testing library | The AI is asked to write contract tests in the project's existing framework; FrontFlow does not run them as a gate |
| 5 | Visual diff | None: the AI uses `get_screenshot` only to look at the design and is told not to check its UI visually (no dev server, browser or screenshots); the user reviews the UI, and the visual check is reported as `reference_only` |
| 6 | Retention | Raw terminal logs kept 30 days by default (Settings → Retention, can be disabled; applies on next start); run artifacts live as long as the run |
| 7 | `ready_with_assumptions` | Per run ("Allow continuing with assumptions"); accepted gaps are always shown as *assumed*, never *verified* |
| 8 | Arbitrary shell commands | Off by default. When on, the AI may run only the project's own scripts; anything else still goes through policy and approval |

### Known limitations

- `node:sqlite` is still flagged experimental in Node 22 and prints a warning; the driver is behind an interface so it can be swapped for `better-sqlite3`.
- Approvals for Claude Code in headless mode are enforced through permission mode and policy, not interactive tool approvals (`toolApprovals: false`).
- The canvas uses a fixed lane layout (one lane per stage) fitted to its window; zoom in with its controls for detail.
- The fake CLI writes `fake-output.txt` to simulate code changes; real UI quality can only be judged with a real AI CLI.
