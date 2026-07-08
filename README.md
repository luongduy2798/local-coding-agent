<div align="center">

<img src="docs/banner.svg" alt="Local Coding Agent" width="760" />

# Local Coding Agent

Local MCP server giúp ChatGPT Web đọc/sửa code, chạy command, xem git và dashboard trên máy bạn.

</div>

> Công cụ này có thể chạy command trên máy bạn. Chỉ dùng với repo tin tưởng.
> Đây không phải OS sandbox. Đọc thêm [SECURITY.md](SECURITY.md).

## Cài Nhanh

Yêu cầu:

- Node.js >= 18
- `make`, `bash`, `curl`, `unzip`
- OpenAI Tunnel ID
- Runtime API key cho tunnel

Tạo key/tunnel:

```bash
make keys
```

Tạo `.env.local`:

```bash
cp .env.example .env.local
```

Điền tối thiểu:

```env
CONTROL_PLANE_TUNNEL_ID=tunnel_...
CONTROL_PLANE_API_KEY=sk-proj-...
```

Cài đặt:

```bash
make setup
```

`make setup` sẽ:

- cài dependency trong `server/`
- tải `tools/tunnel-client`
- ghi config local
- cài global command `lca` vào `~/.local/bin/lca`

Nếu terminal báo `~/.local/bin` chưa có trong `PATH`, thêm dòng nó in ra vào shell config rồi mở terminal mới.

## Dùng Hằng Ngày

Vào repo muốn dùng làm workspace:

```bash
cd /path/to/your-repo
lca
```

`lca` tự lấy git root của repo hiện tại làm workspace. Nếu server đang chạy workspace cũ, nó tự stop rồi start lại workspace mới.

Lệnh chính:

```bash
lca          # set workspace = repo hiện tại, start server + tunnel
lca stop     # dừng server + tunnel
lca status   # xem trạng thái
lca workspace # mở TUI chọn workspace bằng phím lên/xuống/Enter
lca raw ...  # gọi CLI gốc nếu cần
```

Dashboard:

```text
http://127.0.0.1:8790/ui
```

Health check local:

```text
http://127.0.0.1:8789/healthz
```

## Tích Hợp ChatGPT Web

Chi tiết: [docs/CHATGPT_WEB_CONNECTOR.md](docs/CHATGPT_WEB_CONNECTOR.md).

Tóm tắt:

1. Chạy `make setup`.
2. Vào repo cần làm việc, chạy `lca`.
3. Mở ChatGPT Web.
4. Settings -> Connectors -> Developer mode -> Add custom MCP connector.
5. Chọn tunnel đã tạo.
6. Auth: chọn `No auth`.
7. Lưu connector.
8. Trong ChatGPT, gọi tool `workspace_info` để kiểm tra workspace thật.

Runtime API key nằm ở `.env.local` và chỉ dùng cho local tunnel-client. Không nhập Runtime API key vào phần auth của ChatGPT connector.

## Make Targets

```bash
make keys      # mở trang tạo Tunnel ID và Runtime API key
make setup     # cài server, tunnel-client, config, global command lca
make workspace # TUI chọn workspace
make cli       # cài lại global command lca
```

Không dùng `make run` hoặc `make stop` nữa. Dùng `lca` và `lca stop` ở bất kỳ repo nào.

## Config

Config runtime nằm ở:

```text
.env.local
```

File này chỉ cần 2 dòng:

```env
CONTROL_PLANE_TUNNEL_ID=tunnel_...
CONTROL_PLANE_API_KEY=sk-proj-...
```

Config CLI nằm trong thư mục app config của hệ điều hành. Xem path:

```bash
lca raw config path
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
- Tunnel client dùng port `8788`; không dùng port này cho dashboard.

## Troubleshooting

| Lỗi | Cách xử lý |
|---|---|
| `lca: command not found` | Chạy `make cli`, hoặc thêm `~/.local/bin` vào `PATH`. |
| Server chạy nhầm repo | `cd` vào repo đúng rồi chạy lại `lca`. |
| Port `8789` bận | Đổi `PORT` trong shell hoặc Makefile, rồi chạy lại `lca`. |
| Dashboard không mở | Kiểm tra `lca status` và `http://127.0.0.1:8789/healthz`. |
| Connector không thấy tool | Đảm bảo `lca` đang chạy, tunnel connected, connector dùng `No auth`. |
| Sửa nhầm repo | Trong ChatGPT gọi `workspace_info` để xem root thật. |

## Low-Level CLI

CLI gốc vẫn còn cho debug:

```bash
bash scripts/lca status
bash scripts/lca doctor
bash scripts/lca logs
```

Nhưng flow bình thường nên dùng global command:

```bash
lca
```

## License

[AGPL-3.0-or-later](LICENSE) © 2026 Long Nguyễn
([@LongNgn204](https://github.com/LongNgn204)).
