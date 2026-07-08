# Security

> **English below — Tiếng Việt ở dưới.**

This tool gives an AI model the ability to **read/write files and run commands
on the machine where the server runs**. Treat it like handing someone a terminal
on that machine. Read this before using it.

## Threat model (English)

- **It is not a sandbox.** In `full` mode, `run_command` can run essentially any
  command with your user privileges. File tools are confined to the configured
  roots, but commands are not perfectly contained (no OS-level isolation is
  provided out of the box). For isolation, run it inside a VM, container, or WSL2.
- **Prompt injection is real.** If the model reads a malicious file/repo, it can
  be tricked into running harmful commands. Only connect workspaces you trust,
  prefer `safe` mode, and review what the agent does (the dashboard + `data/audit.log`
  show every tool call).
- **Never expose it publicly without auth.** The server binds to `127.0.0.1` by
  design. Do **not** put it behind a public/quick tunnel (e.g. a random public
  URL) without setting `MCP_AUTH_TOKEN`. Doing so is equivalent to publishing a
  remote shell to the internet. The recommended exposure is the official OpenAI
  Secure MCP Tunnel, whose channel is private to your account.

## Safe defaults

- `AGENT_MODE=safe` by default (destructive commands and absolute paths blocked).
- `AGENT_POLICY=balanced` by default. Normal edits/tests can proceed, while
  deletes, installs/network calls, mutating git, risky commands, risky
  background processes, and destructive patch operations require one-time local
  approval in the dashboard.
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
- Notes, checkpoints, patch history, backups, and approval records are isolated
  per workspace.
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

- **Đây không phải sandbox.** Ở chế độ `full`, `run_command` gần như chạy được
  mọi lệnh với quyền user của bạn. Các tool file bị giới hạn trong thư mục gốc đã
  cấu hình, nhưng *lệnh* thì không được cô lập tuyệt đối (mặc định không có cô lập
  ở tầng hệ điều hành). Muốn an toàn thật, chạy trong VM, container hoặc WSL2.
- **Prompt injection là rủi ro thật.** Nếu mô hình đọc một file/repo độc hại, nó
  có thể bị "dụ" chạy lệnh nguy hiểm. Chỉ kết nối workspace bạn tin tưởng, ưu tiên
  `safe` mode, và theo dõi hành vi agent (dashboard + `data/audit.log` ghi lại mọi
  lệnh).
- **Tuyệt đối không expose công khai mà không có auth.** Server mặc định chỉ bind
  `127.0.0.1`. **Đừng** đưa nó ra một tunnel public ngẫu nhiên mà không đặt
  `MCP_AUTH_TOKEN` — làm vậy chẳng khác gì công bố một remote shell ra internet.
  Cách expose khuyến nghị là OpenAI Secure MCP Tunnel chính thức (kênh riêng cho
  tài khoản của bạn).

## Mặc định an toàn

- Mặc định `AGENT_MODE=safe`.
- `AGENT_POLICY=balanced` cho phép sửa/test thông thường; hành động rủi ro vẫn
  cần duyệt cục bộ. Batch approval chỉ chứa các hành động chính xác, có hạn dùng
  và mỗi hành động chỉ được dùng một lần; đây không phải quyền wildcard.
- Lệnh hệ thống thảm hoạ luôn bị chặn kể cả ở `full` mode (trừ khi
  `AGENT_ALLOW_DANGEROUS=1`).
- Server chỉ nghe loopback.
- Tuỳ chọn token `MCP_AUTH_TOKEN`.

## Báo lỗi bảo mật

Vui lòng mở "security advisory" riêng tư trên GitHub hoặc liên hệ người duy trì.
Không tạo issue công khai cho lỗ hổng có thể bị khai thác.
