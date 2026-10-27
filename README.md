# GoApp FrontFlow

> Desktop control plane for AI-assisted frontend delivery — *from spec and design to verified frontend.*

FrontFlow attaches to a local frontend project and drives AI CLIs (Claude Code, Codex CLI, Gemini CLI) through a standardised, observable pipeline:

**Figma × API contract → FE readiness → presentational UI → API binding + UI states**, with **BA spec → acceptance test cases → generated auto-tests → evidence report** alongside.

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
| `FRONTFLOW_WORKFLOWS_DIR` | Location of the built-in `workflows/*.yaml` and their default prompts (`workflows/prompts/`) |
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
workflows/               feature-delivery.yaml (built-in workflow) + prompts/<workflow>/<step id>.md, prompts/_system.md
tests/
  fixtures/              Sample app, BA/API documents, fake AI CLI, analyzer fixture projects
  integration/           End-to-end workflow runs against all real packages
  e2e/                   Electron E2E (Playwright)
```

`packages/workflow-nodes` and `packages/policy`/`git-adapter` are additions to the layout in spec §8.1: node handlers live outside Electron so the complete pipeline is testable in plain Node, and policy/Git are isolated, separately tested units.

## How a run works

FrontFlow is a control wrapper, not a coding agent: it opens AI CLI sessions (interactive tmux/terminal sessions, or headless) **in the opened project folder** and drives them step by step, recording what they do. There is no separate worktree or branch: around each code-changing step it records a hidden git snapshot (`refs/frontflow/<run>`) so the step can be reviewed and rolled back. Commit or stash your own changes first to see the AI's changes on their own.

**Every AI step is just an editable prompt** of its workflow (`workflows/prompts/<workflow>/<step id>.md`, plus `_system.md`): the step fills in its `{{placeholders}}` (Figma selection, saved API contract, review, test cases…) and an AI agent runs it in the project folder. A code-changing step's prompt only hands over its inputs, the task, its scope and the output to return; how the work is done (stack, conventions, tests, design system) comes from the project's own instructions (CLAUDE.md, skills), which the agent loads itself — Claude Code always as an interactive session in a tmux-style pane (AI terminals), other CLIs headless. The step ends when the agent ends its answer; if it left work in the background (e.g. a long test run watched with `Monitor`) and has not written its report yet, the session stays open until it does. AI steps have no time limit (`timeoutMs: 0` in the workflow YAML): a waiting Claude costs nothing, so after 10 minutes without activity the step only logs a warning, and you answer it in its AI terminal or cancel it. Edit a prompt in the step's **Prompt** tab or on the **Prompts** screen (stored in `{dataDir}/prompts/<workflow>/`, *Reset to default* restores the shipped one); a project can add its own instructions to a step (see Workflows and prompts below); the rendered prompt of each attempt is kept as evidence. Files a step hands to the agent live in `.frontflow/runs/<run>/` inside the project, which FrontFlow git-ignores.

A feature is created with **a name and a workflow** (see Workflows and prompts below). The built-in `feature-delivery` workflow (13 steps in four lanes, `workflows/feature-delivery.yaml`) starts immediately, and each step asks for its own input when it needs it. The UI is built from Figma first, because the API contract is often not ready yet; when the contract arrives, the built UI is reviewed against it before the API is wired in. The BA decides behaviour (flow, validation, forms, states, business rules) and Figma how it looks; Figma shows less than the BA, so the built UI is checked against the BA and what it lacks is built with the API integration, not discovered by failing tests. Tests use both sources: BA governs logic and flow; design supplies presentation, labels and notification text unless BA explicitly mandates exact wording. Equivalent design copy and details BA leaves unspecified are not conflicts.

Each AI step runs with the **model and effort** its workflow sets (`config.model` / `config.effort`, e.g. `opus` / `high`): the built-in workflow uses Opus for what is delivered or what the next steps take as the truth (AI implements UI, Read BA specification, the UI vs BA review, the API integration, the test design) and Sonnet for the API review and the tests, all with medium effort except high for the UI vs BA review (one short pass that decides whether to stop). **New feature** keeps *Default* for that; choosing a model or effort there applies it to every AI step of the feature instead. On the run screen, an AI step shows the model and effort it runs with and where they come from; choosing one there applies to that step of that feature only (saved in `{dataDir}/projects/<project>/runs/<run>/step-agents.json`), from its next attempt — a step already running keeps its model. Most specific wins: that step of the feature, then the feature, then the workflow step, then Claude Code.

| Lane | Steps |
|---|---|
| ① Build UI from Figma (B1) | **Select Figma scope** (receives the frames pushed from the GoApp Figma plugin; click Run) → **AI implements UI** (prompt: presentational UI from Figma with mock data, plus a dev-only bubble to switch between the UI states of the design). There is no "analyze project" step: the agent reads the project itself |
| ② Review against the API contract (A) | **Read API contract** (import Markdown or OpenAPI whenever it is ready; snapshotted with a content hash and saved in the run folder under `api-contract/`, no AI. One upload may hold several files (up to 20); a newer upload can be made on the step at any time — every upload is kept in its history, but only the files of the latest one are in the run folder and read, and the steps after it run again) → **AI reviews UI vs API** (prompt: the agent checks whether the contract is enough to implement the UI it built — Figma is not read again — and writes a short Markdown review in Vietnamese, `api-review.md`: *Kết luận* `Đáp ứng: NN%` (how much of what the built UI needs the contract provides) and what is missing; the next steps' agents read it. One gate: below **92%** it waits until a newer contract is uploaded or *Accept gaps & continue*, which keeps that review and marks what follows as assumed) |
| ③ Integrate the API (B2) | **Read BA specification** (import any time, one or more files, and upload again later the same way as the API contract — only the latest upload is read; the agent extracts what the FE needs from the BA — business rules, actions and outcomes, exceptions, acceptance criteria, the full flow and open points, without repeating the design or the contract — in `ba-scenarios.md`; the API is not integrated until it is read) → **AI reviews UI vs BA** (prompt, read-only: the UI built from Figma against the BA scenarios → `ba-ui-review.md`: what the UI still lacks — flows, states, validation, forms — with the Figma pattern to show it, conflicts between the BA and Figma with a proposed choice, and what no frame shows, for the designer. Gate on its *Kết luận*: `Chưa đủ` while there is a conflict; *Accept gaps & continue* follows the proposed choices, or write your decisions as a feature addition of the step and run it again) → **AI integrates API** (one agent session: client + bindings into the built UI following the review, the BA scenarios and the UI vs BA review — it builds what that review lists — then loading/empty/error/permission states; it writes no tests, lane ④ does; the backend is not checked, so the feature is *contract-only*) |
| ④ BA test design (C1) | **Design acceptance tests** (the BA scenarios and the UI vs BA review → `test-design.md`: unit tests of the validation, forms, states, rules and flow branches the FE handles; E2E autotests of the **full flow with every role** the BA describes, in stages that can each run alone, plus **2–3 high-risk edge cases** — only what unit tests cannot verify; and which tests cover each BR/AC, or that a tester checks it by hand. Behaviour comes from the BA; presentation and notification copy come from design evidence and the review's choices; not from the API contract; gate on its *Kết luận* `Đủ` / `Chưa đủ`) |
| ④ Acceptance auto-test (C2) | **Read test operations guide** (optional, no AI, never waits: the feature's guide to prepare test data and preconditions, e.g. in the CMS, as Markdown, saved under `ops-guide/`; import or upload it again any time, then the auto-tests run again with it — test design is not affected. It never sets expected outcomes, and CMS access comes from the project's own test configuration, not from the guide) + **AI generates auto-tests** (once the UI is integrated: maps each test case onto the real screens and selectors of the frontend, then writes one automated test per test case, with the test case id in its name; it runs this feature's unit tests and one short E2E stage only to fix the tests themselves, never the application code. FrontFlow is only the wrapper: which test framework and levels to use comes from the project's own instructions (CLAUDE.md, skills, existing tests); no API contract) → **Run unit tests** (prompt: the agent runs this feature's unit tests, fixes the FE where it misses the BA's behaviour and the tests where they contradict the BA logic or the design copy and accepted choices recorded in the test design — never an expected outcome from the BA — and writes `acceptance-tests.md` in Vietnamese: *Kết luận* `Đạt` / `Chưa đạt`, the result of each test case and what it fixed) → **Run E2E tests** (prompt, a session of its own: the full flow, then the edge cases, in the real environment with the data prepared as the operations guide says — fixed accounts per role, reset and clock, never waiting for real time; it reruns from the failing stage and reports environment problems apart, in `e2e-tests.md`). FrontFlow runs no test command itself, the fixes are checkpointed, and anything but `Đạt` waits until you run the step again or accept → **Evidence report** (`evidence-report.md`) |

The **Projects** screen lists projects by latest activity, each with its newest run's progress per stage and what it is doing now, and gathers every step **waiting for you** across projects at the top (one click opens that step). A **project overview** shows the same for each of its runs (in progress / finished), a *Ready for AI agents* checklist (Git state, AI CLIs, GoApp Figma plugin, the commands agents may run without approval) and the editable project profile. The UI follows the Linear design (`skill/design-skills/linear/SKILL.md`), dark by default (the theme button at the bottom of the sidebar cycles light / dark / system), with the sidebar collapsed to icons at every start (it expands only when you click its toggle or press Ctrl+\, and that is not remembered).

The run screen fits the window without scrolling the page: the workflow canvas on the left (**Following live step** is on by default: it zooms to the steps waiting for you, running or failed, with the steps right before and after them, and moves along as the run goes on; the running step breathes. Panning, zooming or using the minimap stops following until you click **Follow live step** again. With nothing live it shows the whole workflow when that stays readable, else its start at a readable zoom; opening a step out of view pans to it. Scroll pans, Ctrl+scroll zooms) and a panel beside it — drag the divider to resize it, or hide the canvas to give the panel the whole width (remembered on this computer). Clicking a step on the canvas, or picking it in the panel, opens it in the panel: its result, files, tests, evidence and AI terminal (Markdown results can be copied or opened in their folder). **Activity** reads like a Claude Code conversation in the VS Code extension, on one thread: the AI's messages as text, each tool call as a bold verb and its target ("Edit src/x.ts", "Bash npm test") with what it amounted to underneath and, for edits and commands, a short diff or IN/OUT preview that opens in full; warnings, failures and "needs you" stand out, routine notes fold into one line. In *All activity* each step is a block headed by its state (its name opens the step); finished steps fold to a one-line summary. A step's **Terminal** tab is its Claude Code pane while it runs; once the step has ended (its pane closes with it), *Open the step's Claude session* reopens that same session (`claude --resume`, as the run's Claude account) in the project. There is no separate chat. The terminal button next to the accounts bubble opens a fresh, interactive Claude Code in the project folder, as the feature's Claude account, in a large popover above it, to work on the feature by hand; *Hide* (or a click outside) hides it and it keeps running until *Close terminal* or you leave the run. A project `.claude/settings*.json` that Claude would stop on with a "Settings Warning" (e.g. an allow rule `*`) is left out of these terminals, as in the workflow steps. Any finished step can be run again (**Run again**, e.g. after editing its prompt; the steps after it are reset and run again too, also for a run that already finished). Runs and projects can be deleted from the UI; this removes FrontFlow's own data and the runs' hidden snapshots, never the project's own files or branches.

Every file the workflow produces is Markdown, written in Vietnamese by the AI steps (`api-review.md`, `ba-scenarios.md`, `ba-ui-review.md`, `test-design.md`, `acceptance-tests.md`, `e2e-tests.md`) or by FrontFlow (`evidence-report.md`), and kept with the imported documents in the run folder in FrontFlow's data, `{dataDir}/projects/<project>/runs/<run>/files/` — never in the project (the agent is given access to that folder). FrontFlow does not parse the reports; it only reads the first line under *Kết luận* to gate: the API review's `Đáp ứng: NN%` (at least 92% to go on), the UI vs BA review's and the test design's `Đủ` / `Chưa đủ`, and the test runs' `Đạt` / `Chưa đạt`. If an agent writes no report, the step is retried, then its final answer is kept as the report, marked as assumed. The **Reports** screen shows a run's reports.

FrontFlow runs no implementation gates (build, typecheck, lint, accessibility): a code-changing AI step passes when its agent session ends, and only agent failures (session error, timeout) are retried. How it checks its own work comes from the project's own instructions, not from FrontFlow's prompt.

Every step persists its state and events in SQLite before notifying the UI, so the app can be closed at any point and resumes on restart.

Each step keeps **one Claude Code session**, like a conversation in the Claude Code IDE extension: its id is saved on the step before Claude starts, and a retry (e.g. no report written), a resumed pause or a step interrupted by closing the app continues that same session (`claude --resume <id>`, same transcript) instead of opening a new one. Only **Run again** (a reset of the step, and of the steps after it) starts a new session. The step's time works the same way: a retry, a resumed pause or a restart keeps counting from when the step started; Run again, or new input for a step that was waiting for you, counts from then. Transcripts stay where Claude Code keeps them (`<Claude config>/projects/<folder>/<id>.jsonl`, listed by `claude --resume` and the IDE extension) and age out with Claude's own `cleanupPeriodDays`; FrontFlow never deletes them.

## Workflows and prompts

A workflow is the steps a feature goes through, in lanes (the rows of the workflow canvas). The **Workflows** screen lists them: the built-in **Feature delivery** (read-only; clone it to change it) and your own, stored as YAML in `{dataDir}/workflows/<id>.yaml`. Saving a changed workflow makes a new version; features already started keep the graph they started with. **New feature** asks which workflow to run.

- The **workflow editor** fills the window with the canvas. Drag a step type from the toolbar onto a lane (or click it to add it to the selected step's lane), drag steps anywhere — their place is saved with the workflow and used by the run canvas too (*Auto-arrange* lays them out again) — and pull a step's right dot onto another step to make it wait for that one; select a link or a step and press Delete to remove it. Selecting a step opens a drawer with its **Settings** (name, description, lane, the steps it runs after; for an AI step, the model and effort it runs with — *Default* leaves them to Claude Code), **Prompt** and **Skills**; *Workflow & lanes* edits the name, description and lanes, and *Problems* lists what is missing (a prompt, a step a built-in step reads) and opens the step. One **Save** writes the workflow and every edited prompt. The built-in workflow's steps cannot change (clone it), but its prompts and skills can be edited there.
- Step types: **AI prompt** (Claude runs the step's prompt in the project; the project is snapshotted before and after; `{{feature}}`, `{{runFolder}}`, `{{output}}` — where it may write a Markdown summary, shown as the step result — and `{{reports}}` — the reports of earlier steps — are filled in) and **Manual check** (its prompt is a checklist shown to you; the run waits until you click *Checked — continue*) can be added any number of times. The built-in steps of Feature delivery (Figma scope, API contract, review, tests…) can be reused once each, with their id and after the steps they read.
- Every AI step and manual check needs a prompt; a feature cannot start a workflow until each has one. Prompts are per workflow step and the same in every project. The **Prompts** screen edits them by workflow, plus the system prompt (`_system.md`), which ships empty: each step's prompt carries what it needs, and text added there is appended to the system prompt of every AI step.
- **Project additions**: for a chosen project, a step can get extra instructions (ordered, each can be turned off) that are appended after the step's prompt only in that project (`{dataDir}/projects/<project>/prompt-additions.json`). Edit them on the Prompts screen or in the step's Prompt tab of a run.
- **Feature additions**: in a run, the step's Prompt tab also has **This feature's additions**: instructions only that feature needs (its screens, edge cases, data). They are sent after the project's additions, so they win where they differ, and no other feature gets them. They live in the run's data folder (`{dataDir}/projects/<project>/runs/<run>/prompt-additions.json`) and are deleted with the run; use Retry or Run again on the step to send them now.
- Cloning a workflow copies its prompts and skills; deleting one removes them (not allowed while an unfinished feature runs it).
- Since Feature delivery v9 the BA is read in lane ③ (`C1.ba_spec` → `B2.ba_spec`). A workflow cloned before is upgraded once when it is loaded (the step takes the new id and lane, and *AI binds API* waits for it), saved as a new version; edited prompts, project additions and skills of `C1.ba_spec` move to `B2.ba_spec`. Features started before keep their graph and still run.
- Since Feature delivery v10 *AI binds API* is **AI integrates API**: the same step (`B2.api_binding`) also does the UI states, and *Check backend* (`B2.check_backend`) and *AI adds UI states* (`B2.ui_states`) are gone from the built-in workflow — nothing set a backend URL, so the check always ended *contract-only*. They cannot be added to a workflow any more; workflows cloned before and features started before keep them and still run. A clone keeps its own copy of the old *AI binds API* prompt: to get the merged step there, reset that prompt or copy the built-in one.
- Since Feature delivery v11 **AI reviews UI vs BA** (`B2.ba_ui_review`) sits between the UI and the API integration (and the test design), the E2E tests run in **Run E2E tests** (`C2.run_e2e`) after **Run unit tests** (`C2.run_tests`), and each AI step sets its model and effort. Workflows cloned before and features started before keep their graph and still run. Prompts you edited keep your text: to get the new ones (UI vs BA review in the integration and the test design, unit tests run while generating them, the E2E full flow and stages), reset them, and move lines that belong to one feature into its feature additions.

## Skills

Each AI step can follow **skills**: folders with a `SKILL.md` (YAML frontmatter `name` + `description`, then Markdown instructions) and any files the instructions refer to, the same format Claude Code and Codex use.

- The library lives in `{dataDir}/skills/<name>/`; on first launch it is filled from `skill/`. The **Skills** screen creates, edits, renames and deletes skills, and imports a skill folder or a folder of skills (e.g. `~/.claude/skills`). An import never overwrites an existing name.
- **Skills per step** attaches skills to the AI steps of each workflow (`{dataDir}/skills/assignments.json`, keyed `<workflow>/<step id>`; the workflow editor attaches them too). A step's detail view shows its skills with a link to manage them.
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
| Phase 4: UI implementation & API integration | Works with the real GoApp Figma plugin (go-figma): see [GoApp Figma](#goapp-figma); no provider verification since Feature delivery v10 (features are contract-only) |
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
- The canvas uses a fixed lane layout (one lane per stage); it follows the live steps or fits the window, and its controls zoom for detail.
- The fake CLI writes `fake-output.txt` to simulate code changes; real UI quality can only be judged with a real AI CLI.
