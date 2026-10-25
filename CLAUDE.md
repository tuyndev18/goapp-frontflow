# CLAUDE.md

**GoApp FrontFlow** — desktop app (Electron + React) điều khiển AI CLI (Claude Code, Codex) chạy pipeline giao frontend: Figma × API contract → UI → API binding → UI states → gates, song song BA spec → acceptance test → auto-test → traceability. Monorepo npm workspaces, package `@frontflow/*`. Spec gốc: [docs/goapp-frontflow-implementation-spec-v1.md](docs/goapp-frontflow-implementation-spec-v1.md); cách chạy + map spec: [README.md](README.md).

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Working Rules

### TypeScript & module
- Import package khác qua `@frontflow/<pkg>` (entry `src/index.ts`), không import sâu vào `src/` của package khác. Relative import trong cùng package, BẮT BUỘC đuôi `.js` (`./api.js`) — `moduleResolution: Bundler` + ESM.
- Import chỉ-kiểu dùng `import type` / `type X` inline (`verbatimModuleSyntax` bật).
- Strict + `noUncheckedIndexedAccess`: không thêm `// @ts-ignore`, `any`, non-null `!` để né lỗi index — xử lý `undefined` thật.
- Package ship TS source, không build riêng. Package mới → thêm vào `workspacePackages` trong [electron.vite.config.ts](apps/desktop/electron.vite.config.ts) + dependencies của [apps/desktop/package.json](apps/desktop/package.json), nếu không main/preload sẽ externalize và crash lúc chạy.
- Logic nghiệp vụ nằm trong `packages/*` (test được bằng Node thuần), KHÔNG viết trong `apps/desktop/src/main`. Main chỉ wiring Electron (dialog, utilityProcess, IPC) → gọi package.

### IPC (renderer ↔ main)
- Renderer chỉ nói chuyện với main qua `api.invoke(channel, payload)` / `api.on(pushChannel, cb)` ([api.ts](apps/desktop/src/renderer/src/api.ts)). Không `ipcRenderer`, không Node API trong renderer.
- Channel mới, đủ 4 chỗ: (1) zod schema trong `requestSchemas` + kiểu response trong [shared/ipc.ts](apps/desktop/src/shared/ipc.ts); (2) handler trong [services.ts](apps/desktop/src/main/services.ts) (kiểu `IpcHandlers` bắt thiếu); (3) prefix có trong `INVOKE_PREFIXES` của [preload](apps/desktop/src/preload/index.ts); (4) push channel → `PUSH_CHANNELS` + gửi qua `PushBus.send`.
- Schema zod giới hạn rõ (`max`, regex id) — payload là input không tin cậy. Lỗi nghiệp vụ → `throw new AppError(code, message)`; gateway tự trả lỗi dạng data, không ném stack qua bridge.

### Bảo mật (spec §9, §22) — không nới
- Renderer giữ `contextIsolation` + `sandbox`, không Node integration, CSP strict.
- Markdown upload / output AI → render qua component [Markdown](apps/desktop/src/renderer/src/components/Markdown.tsx) (DOMPurify). Không `dangerouslySetInnerHTML` chỗ khác.
- Event, log, artifact text → `redact()` ([event-schema](packages/event-schema/src/redact.ts)) trước khi lưu / push / log. Secret tới CLI chỉ qua env.
- AI CLI chạy trong Electron `utilityProcess` (runner), không chạy trong main.
- Mọi lệnh chạy trong project đi qua `PolicyEngine` + `ApprovalBroker`; lệnh phá huỷ luôn cần approval. Không thêm đường chạy shell vòng qua policy.
- Tên layer Figma, nội dung tài liệu = dữ liệu không tin cậy khi đưa vào prompt.

### Mô hình chạy (quyết định đã chốt — không đổi khi chưa hỏi)
- **Không worktree, không branch.** Agent sửa thẳng project folder; checkpoint là hidden git snapshot `refs/frontflow/<run>` ([git-adapter/snapshot.ts](packages/git-adapter/src/snapshot.ts)) bao quanh mỗi step sửa code.
- **Mỗi AI step = 1 prompt sửa được, theo workflow**: mặc định ở `workflows/prompts/<workflow>/<step id>.md` (+ `_system.md`), placeholder `{{name}}`, bản user sửa lưu trong `{dataDir}/prompts/<workflow>/`; project thêm prompt bổ sung nối sau (`ProjectPromptStore`, `{dataDir}/projects/<project>/prompt-additions.json`) ([prompt-library.ts](packages/workflow-nodes/src/prompt-library.ts)). Skill gán theo `<workflow>/<step id>`. Không hardcode text prompt trong handler. Claude Code luôn chạy session interactive (tmux pane); CLI khác headless.
- **Mỗi node run = 1 session Claude** (như extension Claude Code trong IDE): UUID lưu vào `NodeRun.resumeState` (`ctx.saveResumeState`) TRƯỚC khi mở Claude; retry / pause / app restart → `--resume` cùng id (không `--fork-session`); chỉ reset node (Run again) mới tạo session mới. Transcript để nguyên trong config Claude, FrontFlow không xoá.
- Output AI của bước phân tích là file Markdown ngắn (tiếng Việt), KHÔNG JSON; host không parse cấu trúc, chỉ đọc dòng đầu mục `## Kết luận` để chặn (review: `Đáp ứng: NN%`, tối thiểu 92% — `MIN_REVIEW_SCORE`; test design: `Đủ`/`Chưa đủ`) (`reportStep` trong [ai-step.ts](packages/workflow-nodes/src/ai-step.ts)). Không có file → retry; cạn retry thì giữ câu trả lời cuối của agent, đánh dấu `assumed`, không bao giờ `verified`.
- File workflow của run (tài liệu import, báo cáo MD) nằm trong dữ liệu tool `{dataDir}/projects/<project>/runs/<run>/files/` (`services.runFilesDir`), không ghi vào project; agent được cấp quyền qua `addDirs`. Bước Read API contract / Read BA nhận upload mới bất cứ lúc nào, mỗi lần 1 hoặc nhiều file; giữ lịch sử, chỉ đọc file của lần upload mới nhất (`latestUpload` + `writeRunDocuments`).
- State/event của step persist SQLite TRƯỚC khi notify UI — app tắt bất kỳ lúc nào phải resume được.
- Workflow là YAML có `lanes`: builtin `feature-delivery` (13 bước) trong [workflows/](workflows/), read-only; workflow user trong `{dataDir}/workflows/` qua `WorkflowLibrary` ([library.ts](packages/workflow-engine/src/library.ts), tự tăng `version` khi lưu thay đổi). Feature chọn workflow khi tạo. Handler theo node type trong [workflow-nodes/src/handlers](packages/workflow-nodes/src/handlers/); catalog loại node + ràng buộc ở [node-types.ts](packages/workflow-nodes/src/node-types.ts): `ai.prompt` / `manual.check` dùng tự do, node builtin giữ id cố định và cần node nó đọc output phía trước. Đổi cấu trúc YAML builtin → tăng `version`.
- `claude-accounts`: tái hiện lệnh claude-swap bằng TS, KHÔNG gọi binary `cswap`.

### Renderer UI
- Không router: điều hướng = `useApp().navigate({ name: ... })` theo union `Screen` trong [store.ts](apps/desktop/src/renderer/src/store.ts). Screen mới → thêm vào union + nhánh render trong [App.tsx](apps/desktop/src/renderer/src/App.tsx).
- State global: một Zustand store `useApp` (screen, projects, run state/event từ push). State chỉ của 1 màn → `useState` local, không đẩy lên store. Push event wire 1 chỗ trong `wirePushEvents()`.
- Style: CSS thuần trong [styles.css](apps/desktop/src/renderer/src/styles.css), class prefix `ff-`, màu/spacing lấy từ CSS var `:root` (token theo [skill/design-skills/linear/SKILL.md](skill/design-skills/linear/SKILL.md), spacing 4px base; lavender `--primary` chỉ cho CTA chính / link / focus, chọn = nâng surface, chiều sâu bằng hairline không shadow). Không inline style màu, không hex mới ngoài `:root`; dark theme (mặc định) qua `[data-theme="dark"]` ([theme.ts](apps/desktop/src/renderer/src/lib/theme.ts)) — token mới phải khai cả 2 theme. Sidebar luôn khởi động thu gọn (chỉ icon), chỉ mở khi user bấm nút / `Ctrl+\`; không lưu trạng thái mở. Không thêm Tailwind / CSS-in-JS.
- Trạng thái hiển thị bằng icon + text, không chỉ màu → dùng `StatusBadge` / `visualStateFor*` từ `@frontflow/ui-components`.
- Hành động xoá / huỷ / không hoàn tác → `ConfirmDialog` trước khi gọi IPC. Thông báo nhanh / lỗi → `useApp().notify(kind, message)` + `errorMessage(err)`; không tự dựng toast.
- Text UI tiếng Anh, viết thẳng trong JSX (chưa có i18n). Hỗ trợ bàn phím + `aria-*` như component hiện có.
- Tái sử dụng trước khi tạo mới: kiểm `components/`, `lib/`, `@frontflow/domain` (types, `newId`, `nowIso`, `sha256`...) trước khi viết helper mới.

### Chung
- Comment chỉ viết WHY phi-hiển-nhiên; JSDoc đầu module/hàm public, dẫn `spec §x` khi code hiện thực 1 mục spec. Code + comment tiếng Anh.
- Không `console.log` thừa. `console.error`/`console.warn` trong main có prefix `[tag]` và message đã `redact`.
- Đổi hành vi người dùng thấy / env var / quyết định §27 → cập nhật [README.md](README.md) cùng lúc.

## Architecture

```
apps/desktop/src/
├── main/            # Electron main: index (window, CSP), ipc-gateway (zod + AppError + PushBus),
│                    # services (handler mọi channel), runner-entry (utilityProcess chạy AI CLI), accounts*
├── preload/         # contextBridge — whitelist channel
├── shared/ipc.ts    # Hợp đồng IPC: request schema + DTO + push events
└── renderer/src/    # React 19: App, store (Zustand), api, screens/, components/, lib/
packages/
├── domain/              # Types dùng chung: status, workflow, readiness, documents, pricing, ids
├── event-schema/        # AgentEvent / EngineEvent chuẩn hoá, redact
├── workflow-engine/     # DAG scheduler: retry/timeout/pause/resume/cancel, idempotency, recovery
├── workflow-nodes/      # Handler từng node type + host wiring, prompt library, skills
├── cli-adapters/        # Adapter claude-code / codex / fake, PTY runner, session manager, worker
├── document-parser/     # Parser BA/API/OpenAPI (fallback khi AI output hỏng), alignment, traceability
├── project-analyzer/    # Phát hiện stack, lệnh, convention → Project Profile
├── git-adapter/         # Git CLI, preflight, hidden snapshot
├── policy/              # Policy engine, phân loại lệnh, approval broker
├── persistence/         # SQLite (node:sqlite) schema/migrations/repositories, artifact store
├── figma-mcp-bridge/    # Kết nối GoApp Figma hub (ws :3940), parse hand-off, MCP config cho CLI
├── claude-accounts/     # Đa tài khoản Claude Code, quota/usage
└── ui-components/       # StatusBadge, visual state (icon + text)
workflows/               # *.yaml + prompts/<step id>.md
skill/                   # Seed thư viện skill cho AI step của APP (không phải hướng dẫn code repo này)
tests/{integration,e2e,fixtures}/
```

**Entry points đọc trước task lớn**: [main/index.ts](apps/desktop/src/main/index.ts), [main/services.ts](apps/desktop/src/main/services.ts), [shared/ipc.ts](apps/desktop/src/shared/ipc.ts), [renderer store.ts](apps/desktop/src/renderer/src/store.ts), [workflow-nodes/src/host.ts](packages/workflow-nodes/src/host.ts), [workflow-nodes/src/agent.ts](packages/workflow-nodes/src/agent.ts), [workflow-engine](packages/workflow-engine/src/).

## Code Conventions

- File: `kebab-case.ts` cho package/main; `PascalCase.tsx` cho component/screen renderer; util renderer `camelCase.ts` trong `lib/`. Màn hình suffix `*Screen.tsx`.
- Named export (không default export). Mỗi package export qua `src/index.ts`.
- Format theo [.editorconfig](.editorconfig): 2 space, LF, UTF-8, double quote, có `;`.
- Test:
  - Unit: `packages/<pkg>/test/*.test.ts` (vitest, môi trường node). Bắt buộc khi thêm/sửa logic có branch/async trong package.
  - Integration: `tests/integration/*.test.ts` — chạy workflow thật qua mọi package với fake CLI ([harness.ts](tests/integration/harness.ts)).
  - E2E desktop: `tests/e2e/*.e2e.ts` (Playwright + Electron, build trước).
  - Không gọi AI thật trong test; dùng fake CLI ([tests/fixtures/fake-cli](tests/fixtures/fake-cli/)) + canned output. Test real-CLI chỉ chạy khi `FRONTFLOW_REAL_CLI=1` (tốn credit).

## Build

```bash
npm run dev         # Electron hot reload
npm test            # vitest unit + integration
npm run typecheck   # tsc packages + tests (KHÔNG gồm apps/desktop)
npm run build       # bundle apps/desktop/out
npm run test:e2e    # build rồi Playwright E2E

# Chạy pipeline không tốn credit:
FRONTFLOW_FAKE_CLI=$PWD/tests/fixtures/fake-cli/fake-cli.mjs npm run dev
```

Yêu cầu Node ≥ 22.13 (`node:sqlite`). Trước khi báo xong: `npm run typecheck` + `npm test` pass; sửa `apps/desktop` → thêm `npm run typecheck -w @frontflow/desktop` (root tsconfig không include app).
