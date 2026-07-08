<div align="center">

<img src="docs/banner.svg" alt="Local Coding Agent" width="760" />

# Local Coding Agent

Local MCP server giúp ChatGPT Web đọc/sửa code, chạy command và xem git trên máy bạn.

</div>

> Công cụ này có thể chạy command trên máy bạn. Chỉ dùng với repo tin tưởng.
> Đây không phải OS sandbox. Đọc thêm [SECURITY.md](SECURITY.md).

## Cài Nhanh

Yêu cầu:

- Node.js >= 18
- npm
- Git, khuyên dùng để `lca` tự lấy git root làm workspace
- OpenAI Tunnel ID và Runtime API key nếu dùng ChatGPT Web tunnel

Chạy setup wizard trong repo `local-coding-agent`:

```bash
# macOS / Linux / WSL
bash scripts/lca setup
```

```powershell
# Windows
scripts\lca.cmd setup
```

Wizard sẽ cho chọn hệ điều hành, kiểm tra prerequisite, mở trang tạo Tunnel/API key, tạo/cập nhật `.env.local`, cài dependency trong `server/`, tải `tools/tunnel-client`, ghi config local và cài global command `lca`.

Nếu bạn chọn hệ điều hành khác máy đang chạy, wizard chỉ in hướng dẫn cho OS đó và không chạy command sai nền tảng.

## Dùng Hằng Ngày

Vào repo muốn dùng làm workspace:

```bash
cd /path/to/your-repo
lca
```

`lca` tự lấy git root của repo hiện tại làm workspace. Nếu server đang chạy workspace cũ, nó tự restart sang workspace mới.

Lệnh chính:

```bash
lca           # set workspace = repo hiện tại, start server + tunnel
lca stop      # dừng server + tunnel
lca status    # xem trạng thái
lca workspace # mở TUI chọn workspace
lca doctor    # kiểm tra cấu hình local
```

Kiểm tra local:

```text
lca status
http://127.0.0.1:8789/healthz
```

## Tích Hợp ChatGPT Web

Chi tiết: [docs/CHATGPT_WEB_CONNECTOR.md](docs/CHATGPT_WEB_CONNECTOR.md).

Tóm tắt:

1. Chạy `lca setup`.
2. Vào repo cần làm việc, chạy `lca`.
3. Mở ChatGPT Web.
4. Settings -> Connectors -> Developer mode -> Add custom MCP connector.
5. Chọn tunnel đã tạo.
6. Auth: chọn `No auth`.
7. Lưu connector.
8. Trong ChatGPT, gọi tool `workspace_info` để kiểm tra workspace thật.

Runtime API key nằm ở `.env.local` và chỉ dùng cho local tunnel-client. Không nhập Runtime API key vào phần auth của ChatGPT connector.

`scripts/start-tunnel.sh` và `scripts/start-tunnel.ps1` là low-level legacy/debug launcher. Flow bình thường nên dùng `lca setup`, sau đó `lca`.

## Config

Secret runtime nằm ở:

```text
.env.local
```

File này thường có:

```env
CONTROL_PLANE_TUNNEL_ID=tunnel_...
CONTROL_PLANE_API_KEY=sk-proj-...
```

Config CLI nằm trong thư mục app config của hệ điều hành. Xem path:

```bash
lca config path
```

## Workspace Là Gì

Workspace là thư mục ChatGPT được phép đọc/sửa/chạy command.

Khi chạy:

```bash
cd /path/to/repo
lca
```

workspace sẽ là git root của repo đó. Nếu không nằm trong git repo, workspace là thư mục hiện tại.

## Bảo Mật

- Không commit `.env.local`.
- Không in API key, Tunnel ID, token hoặc local config có secret.
- Chỉ mở workspace bạn tin tưởng.
- `mode=safe` là mặc định khuyên dùng.
- `full` mode mạnh hơn nhưng rủi ro hơn.
- Với `policy=balanced`, đặt `AGENT_APPROVAL_TOKEN` nếu muốn duyệt action rủi ro mà không chuyển sang `policy=full`.

## Troubleshooting

| Lỗi | Cách xử lý |
|---|---|
| `lca: command not found` | Chạy lại `lca setup` hoặc `node scripts/local-coding-agent.mjs cli`, rồi thêm path wizard in ra vào `PATH`. |
| Server chạy nhầm repo | `cd` vào repo đúng rồi chạy lại `lca`. |
| Port `8789` bận | Chạy `lca setup` và đổi MCP port, hoặc set `PORT` trước khi chạy. |
| Server không health | Kiểm tra `lca status` và `http://127.0.0.1:8789/healthz`. |
| Connector không thấy tool | Đảm bảo `lca` đang chạy, tunnel connected, connector dùng `No auth`. |
| Sửa nhầm repo | Trong ChatGPT gọi `workspace_info` để xem root thật. |

## Low-Level CLI

CLI gốc vẫn còn cho debug:

```bash
node scripts/local-coding-agent.mjs status
node scripts/local-coding-agent.mjs doctor
node scripts/local-coding-agent.mjs logs
```

Flow bình thường nên dùng global command:

```bash
lca
```

## License

[AGPL-3.0-or-later](LICENSE) © 2026 Long Nguyễn
([@LongNgn204](https://github.com/LongNgn204)).
