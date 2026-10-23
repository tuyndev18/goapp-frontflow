# Kiến trúc tham khảo cho hệ thống quản lý đa session AI Coding Agents

> Phạm vi: quản lý đồng thời nhiều phiên Claude Code/Codex và các coding agent khác; chuyển tài khoản an toàn; theo dõi quota, token, chi phí và trạng thái agent; hỗ trợ TUI/Web/VS Code và truy cập từ xa.
>
> Ngày rà soát: 23/10/2026. Tài liệu được tổng hợp từ mã nguồn tại các commit cố định, không chỉ từ README.

## 1. Kết luận nhanh

Không có một repo duy nhất làm tốt tuyệt đối mọi phần. Thiết kế nên ghép các ý tưởng mạnh nhất như sau:

| Năng lực | Nguồn tham khảo tốt nhất | Ý tưởng nên lấy |
|---|---|---|
| Vòng đời nhiều session | Agent of Empires, PurpleMux | Daemon giữ trạng thái bền; tmux/PTY giữ tiến trình sống; client chỉ điều khiển |
| Cô lập phiên theo tài khoản | codex-swap, ccswap | Mỗi tài khoản có `CODEX_HOME`/`CLAUDE_CONFIG_DIR` riêng; chỉ chia sẻ phần cấu hình không nhạy cảm |
| Chuyển tài khoản an toàn | codex-swap | Đồng bộ token mới nhất trước khi switch; ghi nguyên tử; đăng nhập không làm mất refresh token cũ |
| Refresh token chống race/crash | agctl, ccswap | Lock theo namespace, marker ghi trước, compare-and-swap, trạng thái “kết quả không xác định” |
| Tự động chọn tài khoản | ccswap, ai-sub-usage-tracker, claude-session-monitor | Xếp hạng theo headroom nhỏ nhất; cooldown, hysteresis và reset time |
| Theo dõi trạng thái đa provider | AgentHUD, claude-session-monitor | Provider adapter + trạng thái chuẩn hóa; hook ưu tiên, log/process làm fallback |
| Thống kê token/chi phí | sessions | Event schema thống nhất, dedup, incremental SQLite cache, pricing có cảnh báo |
| Dashboard/Web/mobile | Agent of Empires, PurpleMux | REST/WebSocket trên daemon; xác thực trước khi upgrade; loopback mặc định |
| Hồ sơ sử dụng tài khoản | codex-switcher | Quota theo cửa sổ, credits và profile stats; UI desktop/system tray tốt |
| Bảo mật credential | agctl | Chống symlink/TOCTOU, quyền file chặt, không log secret, xử lý refresh outcome rõ ràng |

Kiến trúc khuyến nghị là **một control-plane daemon làm single writer**, kết nối các UI qua API; session runtime chạy trong tmux/PTY/worktree; credential vault và token coordinator là một miền riêng; dữ liệu hoạt động được chuẩn hóa thành event rồi lưu vào SQLite để báo cáo.

## 2. Tiêu chí và phương pháp đọc repo

Mỗi repo được đánh giá theo bốn câu hỏi:

1. Nó giải quyết race condition và nhiều tiến trình cùng ghi như thế nào?
2. Nó xác định “agent đang làm việc/chờ người dùng/đã kết thúc” bằng tín hiệu nào?
3. Nó cô lập credential, config, session và workspace đến mức nào?
4. Nó biến log/quota thô thành dữ liệu thống kê và quyết định chuyển tài khoản ra sao?

Các cơ chế dưới đây được đối chiếu trực tiếp với source code và tài liệu kiến trúc tại commit cụ thể. Việc pin commit giúp tránh tình trạng link vẫn tồn tại nhưng implementation đã thay đổi.

## 3. Kiến trúc đích đề xuất

```text
┌────────────────────────────────────────────────────────────┐
│ Clients: TUI / Desktop / VS Code / Web / Mobile           │
└───────────────────────────┬────────────────────────────────┘
                            │ REST + WebSocket, typed events
┌───────────────────────────▼────────────────────────────────┐
│ Control-plane daemon — single writer                       │
│ - session registry     - commands/idempotency              │
│ - canonical state      - auth/RBAC for remote access       │
└───────┬───────────────────┬───────────────────┬────────────┘
        │                   │                   │
┌───────▼────────┐  ┌───────▼────────┐  ┌──────▼─────────────┐
│ Session runtime│  │ Credential     │  │ Telemetry pipeline │
│ tmux / PTY     │  │ coordinator    │  │ adapters → events  │
│ worktree       │  │ vault / refresh│  │ SQLite / reports   │
│ container      │  │ switch / lease │  │ quota / cost       │
└───────┬────────┘  └───────┬────────┘  └────────────────────┘
        │                   │
┌───────▼───────────────────▼────────────────────────────────┐
│ Provider adapters: Claude / Codex / OpenCode / Kiro / ... │
└────────────────────────────────────────────────────────────┘
```

Nguyên tắc quan trọng:

- **Một writer cho state điều phối.** UI không tự sửa registry, credential hay session metadata.
- **Credential và runtime là hai miền khác nhau.** Session chỉ nhận một profile đã materialize; nó không trực tiếp quản lý kho tài khoản.
- **Event là giao diện chung.** Provider-specific log được parse thành event chuẩn, rồi mới tính trạng thái và báo cáo.
- **Hook là tín hiệu chính, observation là fallback.** Không nên suy luận tất cả trạng thái từ thời gian sửa file.
- **Mọi phép chuyển tài khoản phải có transaction boundary.** Lock, re-read, kiểm tra phiên bản, ghi nguyên tử và audit.

## 4. Phân tích các tính năng tốt nhất

### 4.1. Quản lý vòng đời nhiều session: daemon + tmux/PTY + worktree

**Repo tiêu biểu:** [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires), [PurpleMux](https://github.com/subicura/purplemux).

#### Vấn đề

Nếu TUI/Web tự khởi chạy và giữ child process, việc đóng UI sẽ làm mất phiên hoặc khiến registry không còn đúng. Khi nhiều UI cùng mở, mỗi UI có thể nhìn thấy state khác nhau và cùng ghi đè metadata.

#### Cơ chế hay

Agent of Empires định hướng client/daemon rõ ràng: daemon sở hữu session, tmux, worktree và các mutation; TUI/CLI/Web chỉ gọi API. ADR của dự án chọn local Unix socket có peer credentials, remote TCP cho Web, và dần loại bỏ việc client đọc/ghi thẳng state trên đĩa. Xem [ADR client/daemon](https://github.com/agent-of-empires/agent-of-empires/blob/94995c3b9f4a4a493b0e884e3bf5239d3885620b/docs/adr/0001-crate-and-binary-shape-for-daemon-and-client-builds.md), [ADR transport](https://github.com/agent-of-empires/agent-of-empires/blob/94995c3b9f4a4a493b0e884e3bf5239d3885620b/docs/adr/0003-local-transport-uds-service-and-disk-fallback.md) và [ADR single writer](https://github.com/agent-of-empires/agent-of-empires/blob/94995c3b9f4a4a493b0e884e3bf5239d3885620b/docs/adr/0004-cli-writes-through-the-daemon.md).

PurpleMux dùng tmux làm lớp bền vững cho terminal, sau đó bridge PTY/tmux ra WebSocket. Một cấu hình tmux riêng tránh phá cấu hình tmux cá nhân. Server phân luồng WebSocket cho terminal, timeline, sync và status. Xem [server.ts](https://github.com/subicura/purplemux/blob/52140216d8bb5bfffed30d8d452f77b88339a4ae/server.ts), [terminal-server.ts](https://github.com/subicura/purplemux/blob/52140216d8bb5bfffed30d8d452f77b88339a4ae/src/lib/terminal-server.ts) và [tmux.ts](https://github.com/subicura/purplemux/blob/52140216d8bb5bfffed30d8d452f77b88339a4ae/src/lib/tmux.ts).

#### Hướng triển khai

Mỗi session cần ít nhất:

```ts
type Session = {
  id: string;
  provider: "claude" | "codex" | "opencode" | string;
  accountId: string;
  workspaceId: string;
  runtime: { kind: "tmux" | "pty" | "container"; handle: string };
  isolation: { profileDir: string; worktreePath?: string; containerId?: string };
  state: "starting" | "working" | "waiting" | "stalled" | "ended" | "unknown";
  stateVersion: number;
  startedAt: string;
  lastActivityAt: string;
};
```

Luồng tạo session:

1. Client gửi `CreateSession` kèm `idempotencyKey`.
2. Daemon cấp `sessionId`, tạo worktree/profile trước.
3. Daemon khởi tạo tmux/PTY với environment được kiểm soát.
4. Chỉ sau khi runtime health-check thành công mới phát `SessionStarted`.
5. Nếu lỗi, rollback theo thứ tự ngược; worktree không xóa tự động nếu đã có thay đổi người dùng.

Worktree phù hợp khi nhiều agent sửa cùng repo: mỗi phiên có working tree và branch riêng, trong khi object database Git được dùng chung. Container bổ sung cô lập dependency và process; scratch directory phù hợp cho nhiệm vụ không cần Git. [Hướng dẫn worktree của Agent of Empires](https://github.com/agent-of-empires/agent-of-empires/blob/94995c3b9f4a4a493b0e884e3bf5239d3885620b/docs/guides/worktrees.md) là mẫu tốt cho lifecycle và cleanup có chủ đích.

#### Điểm cần tránh

- Client và daemon cùng ghi một file registry.
- Dùng PID làm định danh bền; PID có thể tái sử dụng.
- Xóa worktree/container ngay khi UI disconnect.
- Đồng nhất “terminal còn sống” với “agent đang làm việc”.

### 4.2. Cô lập tài khoản bằng profile directory

**Repo tiêu biểu:** [codex-swap](https://github.com/PavloPopravkin/codex-swap), [ccswap](https://github.com/errhythm/ccswap).

#### Vấn đề

Nếu nhiều phiên dùng chung `~/.codex/auth.json` hoặc cùng `CLAUDE_CONFIG_DIR`, thao tác login/refresh/switch của một phiên có thể làm phiên khác mất quyền truy cập. Refresh token thường quay vòng; bản cũ ghi đè bản mới sẽ gây `invalid_grant`.

#### Cơ chế hay

codex-swap tạo một `CODEX_HOME` riêng cho từng account profile. Các file cấu hình dùng chung được symlink từ Codex home thật, riêng `auth.json` là file vật lý của profile. Khi chạy, chỉ cần đặt `CODEX_HOME=<profile-dir>`. Xem [session.py](https://github.com/PavloPopravkin/codex-swap/blob/02957ef9fe9ea91c78d711dcb3aa3eb389ed6900/src/codex_swap/session.py).

ccswap dùng cùng ý tưởng cho Claude qua `CLAUDE_CONFIG_DIR`; đồng thời loại bỏ các biến môi trường auth có thể override credential của profile. Nó còn có fast-path cho account đang là active default nhằm tránh tạo thêm một “dòng refresh token” không cần thiết. Xem [session.py](https://github.com/errhythm/ccswap/blob/d6fc99cf2bc5eff9f8ad2e8eadd50bb84da845dd/src/claude_swap/session.py).

#### Hướng triển khai

```text
~/.agent-hub/
  accounts/<stable-account-id>/
    metadata.json             # không chứa raw token nếu có thể
    credential.enc            # vault hoặc OS keychain reference
  profiles/<provider>/<account-id>/
    auth.json                 # materialized cho CLI
    config links ...
  sessions/<session-id>/
    metadata.json
```

Quy tắc:

- Dùng `account_id` ổn định lấy từ JWT/API, không dùng email hay số thứ tự làm khóa chính.
- Allowlist file nào được chia sẻ; không symlink toàn bộ home một cách mù quáng.
- Environment của child process phải được dựng từ allowlist và xóa các biến token kế thừa.
- Profile đang được session sử dụng phải có lease. Không bootstrap/ghi đè profile đó khi chưa chắc session đã quiescent.
- Credential trung tâm là nguồn lưu trữ; profile là bản materialize phục vụ CLI. Tuy nhiên trước khi ghi đè, phải thu hồi token mới hơn từ profile về kho trung tâm.

### 4.3. Chuyển tài khoản không làm mất refresh token

**Repo tiêu biểu:** codex-swap; bổ sung từ claude-session-monitor.

#### Cơ chế hay của codex-swap

Trước mỗi switch, `sync_back()` đọc auth live và auth ở tất cả profile, so sánh `last_refresh`, rồi lưu bản mới nhất về store. Sau đó switch mới ghi credential đích vào Codex home. Store được ghi qua file tạm + `os.replace`, giữ quyền `0600`, có backup và file lock. Xem [store.py](https://github.com/PavloPopravkin/codex-swap/blob/02957ef9fe9ea91c78d711dcb3aa3eb389ed6900/src/codex_swap/store.py) và [switcher.py](https://github.com/PavloPopravkin/codex-swap/blob/02957ef9fe9ea91c78d711dcb3aa3eb389ed6900/src/codex_swap/switcher.py).

Một chi tiết rất đáng lấy: trước `codex login`, auth hiện tại được di chuyển ra chỗ an toàn. Lý do là CLI có thể thu hồi token mà nó thay thế. Nếu login thất bại hoặc bị ngắt, auth cũ được khôi phục.

#### Cơ chế hay của claude-session-monitor

Claude trên macOS có credential trong Keychain và identity trong `~/.claude.json`, hai nơi được cập nhật không đồng thời. Dự án chỉ capture account mới sau khi quan sát cùng một cặp `(accountUuid, refreshToken)` ổn định hai lần qua một khoảng chờ; nhờ vậy không ghép identity mới với token cũ. Khi switch, nó chỉ thay trường OAuth trong Keychain và trường account identity trong JSON, giữ nguyên các trường không liên quan. Xem [capture.ts](https://github.com/Softween/claude-session-monitor/blob/0f9e8d812d26c8642159b356cd0300519db01e4b/src/capture.ts) và [cliVault.ts](https://github.com/Softween/claude-session-monitor/blob/0f9e8d812d26c8642159b356cd0300519db01e4b/src/cliVault.ts).

#### Transaction đề xuất

```text
lock(account namespace)
  re-read live credential
  sync newer live/profile credential → vault
  validate target account and token generation
  write target to temp; fsync(temp)
  atomic rename temp → active auth
  fsync(parent dir)
  update active-account metadata with CAS
  append audit event (không có token)
unlock
```

Nếu provider cần restart để nhận auth mới, API phải trả rõ `restartRequired: true`; không được báo switch thành công theo nghĩa session hiện tại đã đổi account.

### 4.4. Refresh token an toàn khi crash hoặc timeout

**Repo tiêu biểu:** [agctl](https://github.com/zchee/agctl), ccswap.

#### Vấn đề khó nhất

Refresh request đã gửi nhưng client timeout. Ta không biết server đã quay vòng token hay chưa. Gửi lại bằng refresh token cũ có thể làm tình hình tệ hơn; ghi kết quả mới lên bản credential đã được process khác cập nhật cũng nguy hiểm.

#### Cơ chế hay của agctl

agctl tổ chức refresh như một state machine với một POST duy nhất trong đường đi bình thường:

1. Áp deadline budget trước khi lấy lock.
2. Lấy namespace lock và re-read credential.
3. Khôi phục hoặc xử lý `pending` từ lần crash trước.
4. Ghi refresh marker bền trước request.
5. Re-read ngay trước POST để phát hiện thay đổi.
6. Gửi đúng một POST.
7. Phân loại outcome và commit bằng compare-and-swap.

Nếu request có kết quả mơ hồ, marker được giữ lại và hệ thống **không tự resend**. Nếu response thành công nhưng CAS không thể ghi sau số lần retry giới hạn, successor credential được “park” ở pending để lần sau khôi phục. Xem [refresh.rs](https://github.com/zchee/agctl/blob/c967d82b33df760f3940fc059c8013457c594204/src/provider/codex/refresh.rs).

ccswap bổ sung nguyên tắc thực dụng: không giữ lock trong lúc gọi network. Nó pre-refresh ở ngoài lock, rồi re-read và so fingerprint/generation dưới lock trước khi commit. [locking.py](https://github.com/errhythm/ccswap/blob/d6fc99cf2bc5eff9f8ad2e8eadd50bb84da845dd/src/claude_swap/locking.py) cung cấp file lock đa nền tảng.

#### State machine đề xuất

```text
READY
  ├─ refresh due ─→ PREPARED(marker persisted)
  ├─ POST accepted ─→ APPLYING ─→ READY(new generation)
  ├─ invalid_grant ─→ NEEDS_LOGIN
  ├─ 429/server error ─→ RETRYABLE(wait-until)
  └─ timeout/transport ambiguous ─→ UNKNOWN_OUTCOME

UNKNOWN_OUTCOME
  ├─ reconciliation proves new token ─→ READY
  ├─ reconciliation proves request unsent ─→ READY(old generation)
  └─ explicit confirmed resend only ─→ PREPARED
```

Không nên biểu diễn mọi lỗi bằng boolean `refreshFailed`; hệ thống cần biết lỗi chắc chắn trước-send, lỗi chắc chắn bị từ chối và kết quả mơ hồ.

### 4.5. Theo dõi quota thích ứng, không tự DDoS endpoint

**Repo tiêu biểu:** ccswap.

#### Cơ chế hay

[poll_policy.py](https://github.com/errhythm/ccswap/blob/d6fc99cf2bc5eff9f8ad2e8eadd50bb84da845dd/src/claude_swap/poll_policy.py) gom toàn bộ chính sách polling quota vào một nơi:

- Cache phục vụ UI có TTL ngắn hơn chu kỳ poll network.
- Bình thường poll chậm; khi usage gần ngưỡng và đang tăng mới poll nhanh.
- Thêm jitter để nhiều process không cùng đánh endpoint.
- Gặp HTTP 429 thì tăng backoff theo kiểu AIMD và tôn trọng `Retry-After`.
- Không lên lịch poll vượt quá thời điểm reset cộng một khoảng slack.
- Phân biệt 429 do rate-limit API với “subscription usage exhausted”.
- Persist `nextPollAt` và interval theo account để restart không tạo burst.

#### Hướng triển khai

Mỗi `(provider, accountId)` có một poll state:

```ts
type PollState = {
  lastSuccessAt?: number;
  nextPollAt: number;
  intervalMs: number;
  consecutiveFailures: number;
  serverRetryAfter?: number;
  latestSample?: UsageSample;
};
```

UI request không nên trực tiếp gọi API quota. Nó đọc cache và gửi một “refresh intent” cho scheduler. Scheduler coalesce các intent cùng account thành một request.

Các endpoint như `wham/usage` hoặc profile stats có thể là endpoint nội bộ, không phải public contract. Cần adapter có feature flag, timeout, circuit breaker, schema validation và fallback sang log cục bộ.

### 4.6. Tự động chọn và xoay vòng tài khoản

**Repo tiêu biểu:** ccswap, [ai-sub-usage-tracker](https://github.com/SamuelLHuber/ai-sub-usage-tracker), claude-session-monitor.

#### Các chiến lược tốt

ai-sub-usage-tracker chuẩn hóa provider về các cửa sổ 5 giờ/7 ngày. Trong số account còn khả dụng, nó chọn usage tuần thấp nhất, rồi usage 5 giờ thấp nhất; nếu tất cả bị giới hạn, chọn account có cửa sổ ràng buộc reset sớm nhất. Xem [balancer.py](https://github.com/SamuelLHuber/ai-sub-usage-tracker/blob/fb8b2ae8e6fc0e0206c978e1c58d06e4e2ee4d69/ai_usage/core/balancer.py).

claude-session-monitor dùng điểm `headroom = min(100 - usage_i)` trên mọi gauge; chọn headroom lớn nhất, tie-break bằng thời gian reset. Auto-rotate chỉ xảy ra khi account hiện tại vượt ngưỡng, account mới tốt hơn đủ nhiều và đã qua debounce. Xem [rotation.ts](https://github.com/Softween/claude-session-monitor/blob/0f9e8d812d26c8642159b356cd0300519db01e4b/src/rotation.ts).

ccswap bổ sung cooldown, quarantine account lỗi, refresh candidates trước quyết định và xử lý rõ trường hợp tất cả đều cạn. Xem [autoswitch.py](https://github.com/errhythm/ccswap/blob/d6fc99cf2bc5eff9f8ad2e8eadd50bb84da845dd/src/claude_swap/autoswitch.py).

#### Hàm điểm đề xuất

```text
headroom = min(100 - fiveHourPct, 100 - weeklyPct, 100 - modelSpecificPct...)
score = headroom
        - staleDataPenalty
        - recentSwitchPenalty
        - errorPenalty
        - sessionMigrationCost
```

Chỉ switch nếu:

```text
current.headroom < lowWatermark
AND target.score - current.score >= hysteresis
AND now >= cooldownUntil
AND target.status == healthy
AND current session supports safe restart/migration
```

Auto-rotation không nên được dùng để lách chính sách dịch vụ. Hệ thống phải yêu cầu người dùng có quyền hợp lệ với mọi tài khoản, cho phép tắt hoàn toàn, và ghi audit lý do chọn/switch.

### 4.7. Chuẩn hóa trạng thái session đa provider

**Repo tiêu biểu:** [AgentHUD](https://github.com/neochoon/agenthud), claude-session-monitor, Agent of Empires.

#### Provider adapter

AgentHUD định nghĩa interface provider gồm kiểm tra availability, discovery session, parse activity và turn-boundary tùy chọn. Provider không có mặt phải trả kết quả rỗng thay vì làm sập toàn bộ dashboard. Xem [types.ts](https://github.com/neochoon/agenthud/blob/262d1c540e416b3c8aafa9e61fdec3d6232cd579/src/data/providers/types.ts), [claude.ts](https://github.com/neochoon/agenthud/blob/262d1c540e416b3c8aafa9e61fdec3d6232cd579/src/data/providers/claude.ts) và [codex.ts](https://github.com/neochoon/agenthud/blob/262d1c540e416b3c8aafa9e61fdec3d6232cd579/src/data/providers/codex.ts).

Session từ nhiều provider được merge theo project path; nếu một provider còn active thì project được promote lên active. Sorting phải deterministic để UI không nhảy vị trí vô cớ.

#### Suy luận trạng thái

AgentHUD đọc tail JSONL có giới hạn thay vì parse cả file. Nếu có tool call chưa có kết quả hoặc user event mới nhất chưa được trả lời, state là working; assistant final và không còn tool pending thì waiting; recency chỉ là fallback. Cache theo `(path, mtime)` và giới hạn một entry mỗi path để không rò bộ nhớ. Xem [sessionLiveness.ts](https://github.com/neochoon/agenthud/blob/262d1c540e416b3c8aafa9e61fdec3d6232cd579/src/data/sessionLiveness.ts).

claude-session-monitor dùng native hooks cho Codex/Claude và ưu tiên hook nếu còn mới. Một session báo working quá lâu mà không có activity được chuyển thành stalled. Nếu app-server nói `notLoaded`, nó không vội suy ra ended mà trả unknown khi thiếu hook. Xem [codex provider](https://github.com/Softween/claude-session-monitor/blob/0f9e8d812d26c8642159b356cd0300519db01e4b/src/providers/codex.ts).

#### Mô hình trạng thái đề xuất

Tách hai chiều:

```ts
type ActivityAge = "hot" | "warm" | "cool" | "cold";
type AgentState = "starting" | "working" | "waiting_user" | "idle" |
                  "stalled" | "ended" | "error" | "unknown";

type StateEvidence = {
  source: "hook" | "structured_log" | "app_server" | "process" | "mtime";
  observedAt: string;
  confidence: "high" | "medium" | "low";
  sequence?: number;
};
```

“Hot/cold” là độ mới của hoạt động, không phải state. Một agent có thể vừa hot vừa waiting_user. State resolver chọn evidence theo độ tin cậy và độ mới; không cho evidence thấp hơn ghi đè hook mới hơn.

### 4.8. Pipeline thống kê token, chi phí và subagent

**Repo tiêu biểu:** [sessions](https://github.com/nicknisi/sessions).

#### Event schema thống nhất

Repo chuyển log Claude, Codex, OpenCode… thành `UsageEvent` chứa provider, model, timestamp, session/project, input/output/cache tokens, source cost, agent identity và dedup key. Xem [parser types](https://github.com/nicknisi/sessions/blob/9293eb6a8ed7a92c27c9c531061bd20e5b8bd1cb/src/report/parsers/types.ts) và [aggregate.ts](https://github.com/nicknisi/sessions/blob/9293eb6a8ed7a92c27c9c531061bd20e5b8bd1cb/src/report/aggregate.ts).

Các chi tiết đáng lấy:

- Claude: dedup theo message/request identity vì resume/fork có thể nhân bản event; giữ event đầy đủ nhất.
- Subagent: ghép metadata mạnh và yếu theo thứ tự độc lập.
- Codex: input có thể đã gồm cached tokens nên phải trừ đúng; output có thể đã gồm reasoning nên không cộng hai lần.
- OpenCode: SQLite được mở read-only với busy timeout; ưu tiên source cost hợp lệ.
- Scan theo ngày dùng file mtime để pruning nhưng giữ slack, tránh bỏ log ghi trễ.

#### Incremental cache

Một SQLite cache riêng lưu kết quả parse theo `path + mtime + size`, bật WAL và có schema version. Chỉ file thay đổi mới parse lại; cache hỏng phải degrade về full parse chứ không chặn báo cáo. Xem [event-cache.ts](https://github.com/nicknisi/sessions/blob/9293eb6a8ed7a92c27c9c531061bd20e5b8bd1cb/src/report/event-cache.ts).

#### Pricing

Giá nên có version và provenance. Repo dùng snapshot/cache LiteLLM, exact-match trước rồi family fallback, xử lý tier trên 200K và cache multipliers. Model không biết giá phải tạo warning, không được ngầm tính thành `$0`.

Schema đề xuất:

```sql
CREATE TABLE usage_events (
  event_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_id TEXT,
  session_id TEXT NOT NULL,
  project_id TEXT,
  model TEXT,
  occurred_at INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  source_cost_usd REAL,
  estimated_cost_usd REAL,
  pricing_version TEXT,
  raw_source TEXT NOT NULL,
  parser_version INTEGER NOT NULL
);
```

Không lưu prompt/tool output nguyên văn vào bảng usage nếu mục tiêu chỉ là thống kê. Điều này giảm rủi ro rò mã nguồn và secret.

### 4.9. Theo dõi quota cục bộ và profile stats

**Repo tiêu biểu:** codex-swap, [codex-switcher](https://github.com/Lampese/codex-switcher).

codex-swap tìm các `rollout-*.jsonl` mới nhất và đọc event `rate_limits`, có fence `since=last_switch_at` để không gán usage của tài khoản trước cho tài khoản vừa switch. Nó giới hạn số file scan và ưu tiên file mới. Khi network lỗi, dữ liệu rollout là fallback hợp lý. Xem [usage.py](https://github.com/PavloPopravkin/codex-swap/blob/02957ef9fe9ea91c78d711dcb3aa3eb389ed6900/src/codex_swap/usage.py).

codex-switcher có backend Rust/Tauri và UI desktop tốt. Ngoài quota cửa sổ và credits, nó gọi profile stats để hiển thị lifetime tokens, daily usage, streak, longest task, reasoning effort, skills và tổng threads; gặp 401 thì ép refresh một lần rồi retry. Xem [usage.rs](https://github.com/Lampese/codex-switcher/blob/c357686d4bdf306da272da53c9831b12b121526a/src-tauri/src/api/usage.rs) và [account_stats.rs](https://github.com/Lampese/codex-switcher/blob/c357686d4bdf306da272da53c9831b12b121526a/src-tauri/src/commands/account_stats.rs).

Nên phân biệt trên UI:

- **Observed locally:** lấy từ rollout/log; có thể trễ hoặc thiếu.
- **Provider reported:** lấy từ API; đáng tin hơn nhưng phụ thuộc endpoint.
- **Estimated:** tự tính token/cost; phải ghi rõ pricing version.

### 4.10. Streaming timeline và WebSocket

**Repo tiêu biểu:** AgentHUD, PurpleMux, Agent of Empires.

AgentHUD tạo snapshot cây session rồi diff thuần với cursor `emittedCount` theo node, phát NDJSON cho lifecycle/state/activity. Filter nội dung không được làm mất event lifecycle/state. Xem [followStream.ts](https://github.com/neochoon/agenthud/blob/262d1c540e416b3c8aafa9e61fdec3d6232cd579/src/data/followStream.ts).

Cho hệ thống lớn hơn, nên dùng event envelope:

```json
{
  "eventId": "01...",
  "stream": "session/abc",
  "sequence": 184,
  "type": "session.state_changed",
  "occurredAt": "2026-10-23T10:00:00Z",
  "stateVersion": 12,
  "payload": { "from": "working", "to": "waiting_user" }
}
```

Client reconnect gửi `lastSequence`; daemon replay từ event log hoặc trả snapshot mới nếu cursor quá cũ. Command và event tách riêng: WebSocket để stream, REST/RPC idempotent để mutation.

### 4.11. Truy cập từ xa và ranh giới multi-user

**Repo tiêu biểu:** Agent of Empires, PurpleMux.

Agent of Empires mặc định bind loopback; remote dashboard sử dụng token mạnh, cookie `HttpOnly`/`SameSite=Strict`, passphrase Argon2 tùy chế độ, rate limit, token rotation, device binding/revocation, Host/Origin checks và các security headers. Dự án khuyến nghị tunnel HTTPS như Tailscale/Cloudflare. Xem [Web dashboard guide](https://github.com/agent-of-empires/agent-of-empires/blob/94995c3b9f4a4a493b0e884e3bf5239d3885620b/docs/guides/web-dashboard.md).

Một quyết định kiến trúc đáng giữ: daemon workspace là **single-user**. Nếu cần team/multi-user, đặt một control plane riêng phía trên:

```text
Organization identity + RBAC + audit
                  │
        per-user/per-workspace daemon
                  │
        sessions + local credentials
```

Không nên cho nhiều người dùng chung một daemon có quyền đọc toàn bộ Keychain, source code và terminal. Multi-tenancy thật sự đòi hỏi process/container boundary, secret scope, filesystem ACL và audit độc lập.

### 4.12. Bảo vệ file credential và chống symlink/TOCTOU

**Repo tiêu biểu:** agctl.

Ghi file tạm + rename vẫn chưa đủ nếu attacker có thể thay path bằng symlink giữa các bước. agctl dùng cách mở path neo theo descriptor, từ chối symlink, tạo temp độc quyền, `fsync`, và áp quyền directory `0700`/file `0600`. Xem [secure storage source](https://github.com/zchee/agctl/tree/c967d82b33df760f3940fc059c8013457c594204/src/secret).

Checklist tối thiểu:

- Không in access/refresh token vào log, crash report hoặc analytics.
- Mọi file secret dùng quyền tối thiểu; Windows dùng ACL tương đương.
- Không theo symlink tại đường dẫn credential.
- Ghi nguyên tử và `fsync` file + parent directory với dữ liệu quan trọng.
- Lock ordering cố định để tránh deadlock.
- Audit chỉ lưu fingerprint rút gọn, account ID, generation và lý do.
- Backup được mã hóa; rotation/revocation phải bao gồm backup.
- Không gửi raw prompts/source ra telemetry mặc định.
- Có “foreign activity detector”: nếu phát hiện CLI/provider khác đang migrate hoặc khóa credential, fail closed thay vì tranh ghi.

## 5. Data model và API tham khảo

### 5.1. Các thực thể chính

```ts
type Account = {
  id: string;                    // stable provider identity
  provider: string;
  label: string;
  credentialRef: string;         // keychain/vault ref, không phải raw token
  credentialGeneration: number;
  status: "healthy" | "limited" | "refreshing" | "unknown" | "needs_login";
  activeProfileId?: string;
  cooldownUntil?: string;
};

type UsageWindow = {
  kind: "five_hour" | "weekly" | "model" | string;
  usedPercent: number;
  resetsAt?: string;
  observedAt: string;
  source: "provider_api" | "local_log" | "estimate";
};

type Workspace = {
  id: string;
  repoPath: string;
  isolation: "shared" | "worktree" | "container";
};
```

### 5.2. API bề mặt nhỏ nhưng đủ dùng

```text
GET    /v1/providers
GET    /v1/accounts
POST   /v1/accounts/:id/login-intent
POST   /v1/accounts/:id/refresh
POST   /v1/accounts/:id/activate
GET    /v1/accounts/:id/usage

GET    /v1/sessions
POST   /v1/sessions
POST   /v1/sessions/:id/input
POST   /v1/sessions/:id/interrupt
POST   /v1/sessions/:id/archive
DELETE /v1/sessions/:id/runtime   # thao tác phá hủy, cần confirmation token

GET    /v1/reports/usage
WS     /v1/events?after=<sequence>
```

Mọi mutation nhận `Idempotency-Key`, trả `operationId` và có audit event. Các thao tác lâu như tạo worktree/container nên bất đồng bộ.

## 6. Lộ trình triển khai thực tế

### Giai đoạn 1 — Read-only inventory và analytics

- Provider adapter để khám phá session/account.
- Parse log có giới hạn; chuẩn hóa event.
- SQLite WAL + incremental cache.
- Dashboard chỉ đọc: session state, usage, cost estimate.

Đây là phần ít rủi ro nhất và tạo dữ liệu để kiểm chứng state resolver trước khi động vào credential.

### Giai đoạn 2 — Runtime đa session

- Daemon single writer.
- tmux/PTY runtime; reconnect terminal.
- Worktree per session, explicit cleanup.
- Hook receiver và canonical state machine.

### Giai đoạn 3 — Kho tài khoản và manual switch

- OS keychain/vault abstraction.
- Profile directory per account.
- `sync_back`, atomic switch, generation/CAS, audit.
- Login transaction có backup/restore.

Chưa bật auto-rotate ở giai đoạn này.

### Giai đoạn 4 — Refresh coordinator và quota scheduler

- Refresh marker/pending recovery.
- Adaptive polling, jitter, backoff, cache.
- Reconciliation khi request outcome không rõ.
- Cảnh báo `needs_login` và thao tác phục hồi rõ ràng.

### Giai đoạn 5 — Auto-rotation có guardrail

- Headroom scoring, hysteresis, cooldown, quarantine.
- Chỉ áp dụng cho session có thể restart/migrate an toàn.
- Dry-run giải thích “nếu switch thì chọn ai và vì sao”.
- User policy và audit bắt buộc.

### Giai đoạn 6 — Remote và tổ chức

- Loopback mặc định, TLS tunnel.
- Device sessions, revocation, CSRF/Origin/Host protection.
- Nếu cần multi-user: control plane/RBAC bên ngoài; daemon vẫn per-user hoặc per-workspace.

## 7. Ma trận quyết định: nên lấy gì, không nên copy gì

| Repo | Nên học | Không nên copy nguyên trạng |
|---|---|---|
| Agent of Empires | Daemon ownership, worktree/session lifecycle, remote security | Đừng biến daemon single-user thành multi-tenant chỉ bằng thêm bảng `users` |
| PurpleMux | tmux-to-WebSocket, mobile terminal, timeline channels | Đừng để WebSocket upgrade bỏ qua auth/Origin check |
| codex-swap | `sync_back`, profile isolation, safe login, atomic store | Đừng cho nhiều writer ngoài transaction boundary |
| ccswap | Adaptive quota poll, auto-switch guardrails, Claude profile handling | Tránh phụ thuộc endpoint nội bộ mà không có fallback/feature flag |
| codex-switcher | Desktop UX, tray, quota/profile presentation | Switcher ghi auth trực tiếp là mẫu yếu hơn atomic transaction của codex-swap |
| AgentHUD | Provider adapters, bounded tail parsing, structural liveness | `mtime` không đủ để kết luận working/ended |
| sessions | Event schema, dedup, cache, pricing warnings | Không nên coi mọi provider có cùng semantics token |
| ai-sub-usage-tracker | Thuật toán chọn account đơn giản, dễ giải thích | Direct JSON write nên thay bằng atomic write; Claude support còn hạn chế |
| agctl | Refresh state machine, secure filesystem, fail-closed | Mức hardening này phức tạp; triển khai từng lớp nhưng không bỏ state `unknown outcome` |
| claude-session-monitor | Hook-first state, stable credential capture, rotation debounce | Account rotation hiện mang tính nền tảng cụ thể, đặc biệt macOS Keychain |

## 8. Failure modes cần test bắt buộc

1. Hai process switch cùng lúc vào hai account khác nhau.
2. Token refresh thành công ở server nhưng client timeout.
3. Process crash sau khi ghi temp file nhưng trước rename.
4. Crash sau rename nhưng trước update registry/audit.
5. Profile session có token mới hơn central vault.
6. Login bị Ctrl+C giữa chừng.
7. Quota endpoint trả 401, 429, HTML, schema mới hoặc reset time thiếu.
8. JSONL đang được append khi parser đọc; một dòng cuối bị cắt.
9. File log rất lớn hoặc hàng chục nghìn session cũ.
10. Hook đến trễ, trùng hoặc đảo thứ tự.
11. tmux sống nhưng agent child chết; agent sống nhưng UI mất kết nối.
12. Worktree có thay đổi chưa commit khi người dùng yêu cầu xóa session.
13. Symlink được đặt tại path credential/temp/backup.
14. WebSocket reconnect và replay event bị trùng.
15. Model mới chưa có pricing; báo cáo không được ngầm hiện chi phí bằng 0.

Các test credential nên dùng fake OAuth server với khả năng mô phỏng token rotation, timeout sau commit và `invalid_grant`. Test state resolver nên dùng fixture log/hook có sequence đảo và timestamp giả.

## 9. Bộ repo tham khảo và commit đã đọc

| Repo | Commit tham chiếu | Vai trò chính |
|---|---|---|
| [errhythm/ccswap](https://github.com/errhythm/ccswap) | [`d6fc99c`](https://github.com/errhythm/ccswap/tree/d6fc99cf2bc5eff9f8ad2e8eadd50bb84da845dd) | Claude/Codex account, usage, adaptive polling, auto-switch |
| [PavloPopravkin/codex-swap](https://github.com/PavloPopravkin/codex-swap) | [`02957ef`](https://github.com/PavloPopravkin/codex-swap/tree/02957ef9fe9ea91c78d711dcb3aa3eb389ed6900) | Codex profile isolation, safe switching and login |
| [Lampese/codex-switcher](https://github.com/Lampese/codex-switcher) | [`c357686`](https://github.com/Lampese/codex-switcher/tree/c357686d4bdf306da272da53c9831b12b121526a) | Tauri desktop UX, quota and account stats |
| [agent-of-empires/agent-of-empires](https://github.com/agent-of-empires/agent-of-empires) | [`94995c3`](https://github.com/agent-of-empires/agent-of-empires/tree/94995c3b9f4a4a493b0e884e3bf5239d3885620b) | Multi-session daemon, worktree/container, TUI/Web |
| [neochoon/agenthud](https://github.com/neochoon/agenthud) | [`262d1c5`](https://github.com/neochoon/agenthud/tree/262d1c540e416b3c8aafa9e61fdec3d6232cd579) | Multi-provider discovery, liveness and reports |
| [nicknisi/sessions](https://github.com/nicknisi/sessions) | [`9293eb6`](https://github.com/nicknisi/sessions/tree/9293eb6a8ed7a92c27c9c531061bd20e5b8bd1cb) | Token/cost/subagent analytics and incremental cache |
| [subicura/purplemux](https://github.com/subicura/purplemux) | [`5214021`](https://github.com/subicura/purplemux/tree/52140216d8bb5bfffed30d8d452f77b88339a4ae) | tmux/WebSocket/mobile multiplexer |
| [SamuelLHuber/ai-sub-usage-tracker](https://github.com/SamuelLHuber/ai-sub-usage-tracker) | [`fb8b2ae`](https://github.com/SamuelLHuber/ai-sub-usage-tracker/tree/fb8b2ae8e6fc0e0206c978e1c58d06e4e2ee4d69) | Multi-account usage normalization and balancing |
| [zchee/agctl](https://github.com/zchee/agctl) | [`c967d82`](https://github.com/zchee/agctl/tree/c967d82b33df760f3940fc059c8013457c594204) | Hardened credential storage and refresh transaction |
| [Softween/claude-session-monitor](https://github.com/Softween/claude-session-monitor) | [`0f9e8d8`](https://github.com/Softween/claude-session-monitor/tree/0f9e8d812d26c8642159b356cd0300519db01e4b) | VS Code session view, hooks and Claude account rotation |

## 10. Khuyến nghị cuối cùng

Nếu mục tiêu là xây một sản phẩm mới, thứ tự ưu tiên nên là:

1. Lấy **AgentHUD + sessions** làm mẫu cho lớp đọc dữ liệu và analytics.
2. Lấy **Agent of Empires + PurpleMux** làm mẫu cho daemon/runtime/UI.
3. Lấy **codex-swap** làm baseline cho account profiles và manual switch.
4. Nâng độ an toàn theo **agctl** trước khi bật refresh/auto-rotation.
5. Lấy policy từ **ccswap + claude-session-monitor** cho quota scheduler và account scoring.

Phần khó nhất không phải giao diện switch account mà là bảo toàn refresh-token lineage khi có nhiều process, crash và network timeout. Vì vậy credential coordinator nên được xem là một subsystem có state machine, transaction log và test fault-injection riêng; không nên chỉ là một hàm “copy auth.json”.

Cuối cùng, quota và profile endpoint không phải lúc nào cũng là API công khai, ổn định. Thiết kế cần chấp nhận provider thay đổi schema hoặc chặn endpoint: mọi tính năng network phải có adapter, validation, cache và chế độ read-only từ local logs. Điều này giúp hệ thống vẫn hữu dụng ngay cả khi chức năng switch/usage trực tuyến tạm thời không hoạt động.
