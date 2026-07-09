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

Wizard sẽ tự detect hệ điều hành hiện tại, kiểm tra prerequisite, mở trang tạo Tunnel/API key, tạo/cập nhật `.env.local`, cài dependency trong `server/`, tải `tools/tunnel-client`, ghi config local và cài global command `lca`. Trên Windows, wizard sẽ thêm thư mục `lca.cmd` vào User PATH; mở terminal mới trước khi gõ `lca`.

Nếu cần xem hướng dẫn cho hệ điều hành khác máy đang chạy, dùng `node scripts/local-coding-agent.mjs setup --choose-os`.

## Dùng Hằng Ngày

Vào repo muốn dùng làm workspace. Trên Windows, mở terminal mới sau setup rồi chạy:

```powershell
cd /d <path-to-your-repo>
lca
```

macOS/Linux:

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
lca config    # mở TUI cấu hình mode/policy/workspace/port
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
8. Trong ChatGPT, gọi tool `lca` hoặc `workspace_info` để kiểm tra workspace thật.

Runtime API key nằm ở `.env.local` và chỉ dùng cho local tunnel-client. Không nhập Runtime API key vào phần auth của ChatGPT connector.

## ChatGPT Tools

Sau khi connector hoạt động, các tool thường dùng trong ChatGPT:

```text
lca        # alias ngắn của workspace_info, kiểm tra workspace thật
lca_input  # mở Apps SDK widget để nhập task, chọn @ context và / workflow
```

`workspace_info` vẫn tồn tại cho tên rõ nghĩa hơn, còn `lca` tiện dùng khi mở chat mới.

## LCA Input: `@` Context và `/` Workflow

`lca_input` mở widget ngay trong ChatGPT. Widget này dùng:

- `@...` để chọn file, folder, symbol hoặc skill trong workspace.
- `/...` để gọi workflow hoặc skill, ví dụ `/plan`, `/debug`, `/review`, `/implement`, `/refactor`, `/skill:<name>`.
- Nút nhanh **Plan** và **Review** chỉ là quick action; không chèn chữ vào input.
- Nút send sẽ tự compose prompt rồi gửi vào ChatGPT, không cần hiện Prompt output.

Các tool nền phía sau:

- `workspace_search`: autocomplete cho `@...`.
- `slash_commands`: autocomplete cho `/...`.
- `compose_prompt`: parse input, resolve context đã chọn, và tạo prompt sẵn để gửi vào ChatGPT.

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

### Mode Và Policy

`Mode` là lớp an toàn cho command:

- `safe`: mặc định khuyên dùng. Chặn nhiều command nguy hiểm như xoá hệ thống, thao tác destructive, hoặc shell pattern rủi ro.
- `full`: ít chặn hơn ở tầng command. Chỉ dùng khi bạn tin workspace và chấp nhận rủi ro cao hơn.

`Policy` là lớp quyền cho tool/action:

- `balanced`: mặc định khuyên dùng. Cho workflow coding bình thường, nhưng action rủi ro cần approval token.
- `strict`: chặt hơn, phù hợp khi chỉ muốn agent đọc/review/inspect.
- `full`: bỏ policy approval gate, ít bị hỏi duyệt hơn nhưng rủi ro hơn.

Setup wizard mặc định chọn:

```text
Mode: full
Policy: full
```

Nếu muốn chặt hơn, có thể đổi lại `safe` hoặc `balanced` sau setup bằng TUI:

```bash
lca config
```

Chọn `Mode` hoặc `Policy`, lưu lại, và nếu agent đang chạy thì `lca config` sẽ tự restart để áp dụng cấu hình mới.

## Troubleshooting

| Lỗi                                                  | Cách xử lý                                                                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lca: command not found` / `'lca' is not recognized` | Trên Windows: đóng terminal cũ, mở terminal mới rồi chạy lại `lca`. Nếu vẫn lỗi, chạy `scripts\lca.cmd cli` để cài lại wrapper hoặc gọi trực tiếp path wizard in ra. |
| Server chạy nhầm repo                                | `cd` vào repo đúng rồi chạy lại `lca`.                                                                                                                               |
| Port `8789` bận                                      | Chạy `lca setup` và đổi MCP port, hoặc set `PORT` trước khi chạy.                                                                                                    |
| Server không health                                  | Kiểm tra `lca status` và `http://127.0.0.1:8789/healthz`.                                                                                                            |
| Connector không thấy tool                            | Đảm bảo `lca` đang chạy, tunnel connected, connector dùng `No auth`.                                                                                                 |
| Sửa nhầm repo                                        | Trong ChatGPT gọi `lca` hoặc `workspace_info` để xem root thật.                                                                                                      |

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

[AGPL-3.0-or-later](LICENSE) © 2026 Lương Duy
([@luongduy2798](https://github.com/luongduy2798)).
