# AGENTS.md — setup guide for AI coding agents

Nếu user yêu cầu cài hoặc hướng dẫn repo này, dùng flow TUI mới dưới đây.

## What This Is

Local MCP server cho ChatGPT Web connector. `server/server.mjs` là compatibility entrypoint; implementation nằm trong `server/src/server.mjs`. User chạy global command `lca` trong repo bất kỳ; workspace tự lấy theo git root hiện tại.

## Prerequisites

- Node.js >= 22.13.0 (`node -v`)
- npm
- Git nếu muốn tự nhận git root
- OpenAI Tunnel ID và Runtime API key nếu dùng ChatGPT Web tunnel

Không commit secret, `.env.local`, `tools/`, generated profiles hoặc logs có secret.

## Setup

Chạy setup wizard trong repo `local-coding-agent`:

```bash
# macOS / Linux / WSL
bash scripts/lca setup
```

```powershell
# Windows
scripts\lca.cmd setup
```

Wizard sẽ cho chọn OS, kiểm tra prerequisite, mở trang Tunnel/API key, tạo/cập nhật `.env.local`, cài dependency, auto-download `tunnel-client` khi có thể, ghi config local và cài global command `lca`.

## Daily Use

Trong repo cần làm việc:

```bash
cd /path/to/repo
lca
```

V5 dùng một supervisor chung. `lca` đăng ký/chọn repo hiện tại cho **task mới**
mà không restart server hoặc tunnel; task đang chạy không bị chuyển workspace.

Lệnh thường dùng:

```bash
lca stop
lca status
lca workspace list
lca workspace use /path/to/repo
lca workspace archive /path/to/repo
lca workspace restore /path/to/repo
lca workspace remove /path/to/repo
lca doctor
```

`workspace remove` là permanent LCA-data purge, không phải alias của Archive. Nó yêu cầu runtime đã dừng và xác nhận đúng label; source repository không bị xóa.

## ChatGPT Web Connector

- ChatGPT Web -> Settings -> Connectors -> Developer mode -> Add custom MCP connector.
- Chọn tunnel đã tạo.
- Auth: `No auth`.
- Không dùng OAuth.
- Không nhập Runtime API key vào connector auth; key này nằm trong `.env.local` cho local tunnel-client.
- Verify bằng cách hỏi ChatGPT `call lca`; prompt này phải gọi `lca_status`.
- Khi dynamic discovery, chọn đúng một exact query `discovery-group:*` theo routing instructions; không tự nghĩ query như `write`/`edit`, không gọi catalog thiếu query và không fallback toàn bộ tool khi group bị thiếu.
- Chỉ gọi `lca_input` khi cần mở rõ Apps SDK widget/composer/PiP.

Chi tiết: [docs/CHATGPT_WEB_CONNECTOR.md](docs/CHATGPT_WEB_CONNECTOR.md).

## Task Orchestration Rules

- Khi mở task, agent phải chọn `complexity_hint`: `quick_edit`, `normal` hoặc `complex`. Nếu chưa đủ căn cứ, dùng `normal` thay vì giao quyết định cho LCA.
- `objective` là bản tóm tắt trung thực behavior và constraint; `title` chỉ là nhãn UI ngắn.
- LCA không hiểu intent như model và không được tự đổi `effective_profile`. `suggested_profile`, `scope_signal` và `scope_reasons` chỉ là telemetry/advisory dựa trên tool evidence.
- Chỉ gọi `task_reclassify` sau khi agent tự đánh giá context và xác nhận profile mới, luôn kèm lý do cụ thể.
- Với `quick_edit`, ưu tiên flow ngắn: discovery `task-mutation` một lần, mở task, đọc evidence mục tiêu, quyết định nội bộ, patch, review diff và đóng task. Không mặc định gọi `task_plan`, kể tiến độ bằng `task_state`, hoặc list `skills`.
- Lint, test, typecheck, build, security audit và format chỉ chạy khi user yêu cầu trực tiếp. Nếu không được yêu cầu, đóng task ngay sau source/diff review; `incomplete` chỉ là evidence state nội bộ, UI vẫn hiển thị Completed.
- Soft budget chỉ tạo cảnh báo. Không được coi việc vượt budget là bằng chứng đủ để đổi profile, dừng task hoặc ép mutation.
- Không đọc/search lặp cùng evidence nếu không có câu hỏi mới. Khi cần đọc tương tự, nêu rõ evidence gap cụ thể.

## URLs

- MCP local: `http://127.0.0.1:8789/mcp`
- Health: `http://127.0.0.1:8789/healthz`

## Safety

- Setup wizard mặc định `mode=full`, `policy=full`.
- Đây không phải OS sandbox.
- Chỉ connect workspace tin tưởng.
- Không expose server public nếu chưa hiểu rủi ro.

## Test Safety Rules

All tests that create, modify, rename, or delete files must use an isolated fixture created with `mkdtemp()` through `server/tests/helpers/test-guard.mjs`.

Tests must never use the active repository, `process.cwd()`, `AGENT_WORKSPACE`, the user's home directory, Desktop, or any Git repository root as a disposable workspace.

Before any recursive delete:

- The target must be inside the test root owned by the current run.
- The marker and run ID must match.
- The target must be inside a registered disposable root and must not be the test root.
- Protected repositories and Git roots must remain intact.
- A target containing `.git` or resolving through a symlink outside the test root must be rejected.

All destructive cleanup must use `safeRemove()` from `server/tests/helpers/test-guard.mjs`. Direct recursive filesystem removal, shell recursive deletion, destructive Git cleanup, `pkill`, and `killall` are forbidden in tests.

Integration tests must use a dynamic port, a temporary `AGENT_WORKSPACE`, a temporary `AGENT_DATA_DIR`, and stop only the exact child process they spawned. Port `8789` and the real `server/data` directory are not test fixtures.

Read [docs/TEST_SAFETY.md](docs/TEST_SAFETY.md) before adding or changing a destructive test. Run `npm run test:safety` from `server/` before security or integration suites.

## Low-Level CLI

CLI gốc vẫn dùng được để debug:

```bash
node scripts/local-coding-agent.mjs status
node scripts/local-coding-agent.mjs logs
```
