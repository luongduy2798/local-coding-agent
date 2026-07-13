# Security

> **English below — Tiếng Việt ở dưới.**

This tool gives an AI model the ability to **read/write files and run commands
on the machine where the server runs**. Treat it like handing someone a terminal
on that machine. Read this before using it.

## Threat model (English)

- **`full` is deliberately not sandboxed.** In `full` mode, `run_command` can run
  commands with your user privileges. File tools remain root-confined, while
  command execution is direct. `balanced`/`safe` attempt native command isolation
  with macOS Seatbelt or Linux bubblewrap when available; check `sandbox_status`
  because adapter availability varies. Use a VM/container for a stronger boundary.
- **Prompt injection is real.** If the model reads a malicious file/repo, it can
  be tricked into running harmful commands. Only connect workspaces you trust,
  prefer `safe` mode, and review what the agent does (`data/audit.log` records
  tool calls).
- **Never expose it publicly without auth.** The server binds to `127.0.0.1` by
  design. Do **not** put it behind a public/quick tunnel (e.g. a random public
  URL) without setting `MCP_AUTH_TOKEN`. Doing so is equivalent to publishing a
  remote shell to the internet. The recommended exposure is the official OpenAI
  Secure MCP Tunnel, whose channel is private to your account.

## Defaults and optional safety modes

- Trusted-local default is `AGENT_ACCESS_MODE=full`, `AGENT_POLICY=full`, and
  `AGENT_WORKFLOW_MODE=auto`. `safe` and `balanced` remain selectable.
- Verification is explicit-only: tests/build/lint do not run unless requested by
  the prompt, Plan/dashboard action, or an explicitly configured hook.
- `AGENT_POLICY=balanced` can be selected when normal edits should proceed while
  deletes, installs/network calls, mutating git, risky commands, risky
  background processes, and destructive patch operations require one-time local
  approval through `request_approval`/`request_approval_batch` plus
  `approve_request` with `AGENT_APPROVAL_TOKEN`.
- Exact batch approvals may group 2-20 explicitly listed actions into one local
  decision. They expire within 1-30 minutes, each action is consumable once,
  and wildcard or implicit grants are not supported.
- `run_commands` is only a transport optimization: every command still passes
  the same mode, policy, root, timeout, and catastrophic-command checks as
  `run_command`.
- Browser-origin `/mcp` requests are rejected unless explicitly listed in
  `MCP_ALLOWED_ORIGINS`.
- Bearer tokens are accepted only through `Authorization: Bearer <token>`, not
  query strings.
- LCA control-plane/MCP/approval credentials are stripped from project child
  processes. Project-specific environment variables remain inherited in `full`.
- Notes, checkpoints, task/plan state, transactions, worktrees, backups, and
  approval records are isolated per workspace.
- Code mutations use transaction validation, collision/ambiguity checks,
  stale-file hashes, rollback, and undo/redo. These reliability controls do not
  reduce `full` access.
- Catastrophic system commands (disk format, diskpart, shutdown, registry wipes,
  fork bombs) stay blocked even in `full` mode unless `AGENT_ALLOW_DANGEROUS=1`.
- Server listens on loopback only.
- Optional `MCP_AUTH_TOKEN` bearer auth.

## Reporting a vulnerability

Please open a private security advisory on GitHub, or contact the maintainer.
Do not file public issues for exploitable vulnerabilities.

---

## Mô hình rủi ro (Tiếng Việt)

Công cụ này cho phép một mô hình AI **đọc/ghi file và chạy lệnh trên máy chạy
server**. Hãy coi như bạn đưa cho ai đó một cửa sổ dòng lệnh trên máy đó. Đọc kỹ
trước khi dùng.

- **`full` chủ động không dùng sandbox.** Ở chế độ `full`, `run_command` chạy
  trực tiếp với quyền user. Các tool file vẫn bị giới hạn trong root. `balanced`
  và `safe` cố gắng dùng macOS Seatbelt hoặc Linux bubblewrap khi có; gọi
  `sandbox_status` để kiểm tra. Muốn boundary mạnh hơn, chạy trong VM/container.
- **Prompt injection là rủi ro thật.** Nếu mô hình đọc một file/repo độc hại, nó
  có thể bị "dụ" chạy lệnh nguy hiểm. Chỉ kết nối workspace bạn tin tưởng, ưu tiên
  `safe` mode, và theo dõi hành vi agent (`data/audit.log` ghi lại tool call).
- **Tuyệt đối không expose công khai mà không có auth.** Server mặc định chỉ bind
  `127.0.0.1`. **Đừng** đưa nó ra một tunnel public ngẫu nhiên mà không đặt
  `MCP_AUTH_TOKEN` — làm vậy chẳng khác gì công bố một remote shell ra internet.
  Cách expose khuyến nghị là OpenAI Secure MCP Tunnel chính thức (kênh riêng cho
  tài khoản của bạn).

## Mặc định và mode an toàn tùy chọn

- Mặc định trusted-local: `AGENT_ACCESS_MODE=full`, `AGENT_POLICY=full`,
  `AGENT_WORKFLOW_MODE=auto`; vẫn có thể chọn `balanced` hoặc `safe`.
- Test/build/lint chỉ chạy khi được yêu cầu rõ ràng qua prompt, Plan/dashboard
  hoặc hook do người dùng cấu hình.
- Khi chọn `AGENT_POLICY=balanced`, hành động rủi ro vẫn
  cần duyệt cục bộ bằng `AGENT_APPROVAL_TOKEN` qua `approve_request` hoặc
  `deny_request`. Batch approval chỉ chứa các hành động chính xác, có hạn dùng và
  mỗi hành động chỉ được dùng một lần; đây không phải quyền wildcard.
- Lệnh hệ thống thảm hoạ luôn bị chặn kể cả ở `full` mode (trừ khi
  `AGENT_ALLOW_DANGEROUS=1`).
- Server chỉ nghe loopback.
- Tuỳ chọn token `MCP_AUTH_TOKEN`.

## Báo lỗi bảo mật

Vui lòng mở "security advisory" riêng tư trên GitHub hoặc liên hệ người duy trì.
Không tạo issue công khai cho lỗ hổng có thể bị khai thác.
