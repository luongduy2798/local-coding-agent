<div align="center">

<img src="docs/banner.svg" alt="Local Coding Agent" width="760" />

# Local Coding Agent

Local MCP server giúp ChatGPT Web đọc/sửa code, chạy command và xem git trên máy bạn. Mục tiêu là biến ChatGPT thành coding agent làm việc trực tiếp trên workspace local, nhưng vẫn giữ quyền kiểm soát ở phía bạn.

</div>

> Công cụ này có thể chạy command trên máy bạn. Chỉ dùng với repo tin tưởng.
> Đây không phải OS sandbox. Đọc thêm [SECURITY.md](SECURITY.md).

## Cài Nhanh

Bạn chỉ cần làm 3 bước:

1. Chạy setup wizard trong repo `local-coding-agent`.
2. Vào repo muốn làm việc và chạy `lca`.
3. Thêm custom MCP connector trong ChatGPT Web.

Yêu cầu:

- Node.js >= 18
- npm
- Git, khuyên dùng để `lca` tự lấy git root làm workspace
- OpenAI Tunnel ID và Runtime API key nếu dùng ChatGPT Web tunnel

Chạy setup wizard:

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

Mỗi lần muốn ChatGPT làm việc trên repo nào, hãy mở terminal tại repo đó rồi chạy `lca`. LCA sẽ tự nhận git root làm workspace.

Trên Windows, mở terminal mới sau setup rồi chạy:

```powershell
cd /d <path-to-your-repo>
lca
```

macOS/Linux:

```bash
cd /path/to/your-repo
lca
```

Nếu server đang chạy workspace cũ, `lca` sẽ tự restart sang workspace mới.

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
8. Trong ChatGPT, gọi tool `lca` để kiểm tra workspace thật.

Runtime API key nằm ở `.env.local` và chỉ dùng cho local tunnel-client. Không nhập Runtime API key vào phần auth của ChatGPT connector.

## ChatGPT Tools

Sau khi connector hoạt động, bạn thường chỉ cần gọi 2 tool này trong ChatGPT:

```text
lca        # kiểm tra workspace thật, policy và output limits
lca_input  # mở Apps SDK widget, có thể ghim PiP để nhập task trong lúc chat
```

`lca` là tool trạng thái duy nhất, dùng khi mở chat mới hoặc muốn kiểm tra nhanh connector đang trỏ vào workspace nào.

## LCA Input: `@` Context và `/` Workflow

`lca_input` mở widget ngay trong ChatGPT để nhập task có context rõ hơn. Widget này dùng:

- `@...` để chọn file, folder, symbol hoặc skill trong workspace.
- `/...` để gọi workflow hoặc skill, ví dụ `/debug`, `/review`, `/implement`, `/refactor`, `/skill:<name>`.
- Nút **PiP** yêu cầu ChatGPT ghim composer thành cửa sổ nổi để vẫn dùng được trong lúc tiếp tục chat.
- Nút nhanh **Plan** là quick action; không chèn chữ vào input.
- Nút send sẽ tự compose prompt rồi gửi vào ChatGPT, không cần hiện Prompt output.

Ví dụ task trong widget:

```text
/refactor @README.md làm README ngắn gọn hơn, giữ nguyên ý chính
```

ChatGPT luôn mở app ở inline trước, nên cần bấm **PiP** một lần để chuyển mode. Host sẽ quyết định mode cuối cùng; trên mobile, yêu cầu PiP có thể được chuyển thành fullscreen.

Các tool nền phía sau:

- `workspace_search`: autocomplete cho `@...`.
- `slash_commands`: autocomplete cho `/...`.
- `compose_prompt`: parse input, resolve context đã chọn, và tạo prompt sẵn để gửi vào ChatGPT.

## Figma Desktop MCP

LCA kết nối trực tiếp với **Figma Desktop MCP chính thức**, không gọi REST API và không cần tạo OAuth App, Client ID, Client Secret hay Personal Access Token. Figma Desktop dùng chính phiên đăng nhập hiện tại của bạn.

Endpoint mặc định:

```text
http://127.0.0.1:3845/mcp
```

### Bật trong Figma Desktop

1. Mở Figma Desktop và đăng nhập.
2. Mở một Figma Design file.
3. Chuyển sang Dev Mode bằng `Shift+D`.
4. Trong phần **MCP server**, chọn **Enable desktop MCP server**.

Sau đó chạy:

```bash
lca figma
```

`lca figma` sẽ kiểm tra kết nối, mở Figma Desktop nếu server chưa chạy, chờ bạn bật MCP rồi thử lại. Các lệnh khác:

```bash
lca figma status   # trạng thái JSON
lca figma tools    # tool và schema thật Figma đang cung cấp
lca figma open     # mở Figma và in hướng dẫn bật MCP
```

`lca setup` cũng có bước **Connect Figma Desktop MCP** sau khi cài dependency. Bước này không bắt buộc; có thể hoàn tất sau bằng `lca figma`.

Các tool chính trong ChatGPT:

```text
figma_get_design_context   # code/design context theo URL, node id hoặc selection hiện tại
figma_get_screenshot       # lấy ảnh selection/node và giữ nguyên image content
figma_get_metadata         # cây layer gọn để khoanh vùng frame lớn
figma_get_variable_defs    # variables và styles đang dùng
figma_list_tools           # đọc tool/schema live từ Figma Desktop
figma_call_tool            # gọi tool mới của Figma mà không phải cập nhật LCA trước
```

Ví dụ:

```text
@Macmini dùng figma_get_design_context và figma_get_screenshot đọc URL Figma này, rồi code màn hình Flutter theo source hiện tại.
```

Selection-based cũng hoạt động: chọn frame trong Figma Desktop rồi yêu cầu ChatGPT đọc selection mà không cần truyền URL.

## Review Changes

Các mutation tool chuyên dụng được backend ghi lịch sử tự động:

```text
apply_patch   # create/update/delete/rename, hỗ trợ batch nhiều file
make_dir      # tạo directory rỗng khi cần
```

Kết quả mutation có `change_id` cho operation và `task_id` cho toàn bộ công việc. Nhiều lần `apply_patch` trong cùng yêu cầu của người dùng được gom vào một task change set, nên extension chỉ hiện một card. Có thể đặt tên task bằng `task_plan` hoặc `apply_patch.task_title`; `session_report` đóng task sau khi hoàn thành. `read_file` và từng file đọc thành công qua `read_many` trả SHA-256 `version`. Nếu file bị sửa bên ngoài sau lần ChatGPT đọc gần nhất, mutation sẽ bị chặn bằng `STALE_FILE`; ChatGPT phải đọc lại rồi thử lại. Khi cần kiểm tra lại đúng nội dung/range cũ, truyền `known_version` cùng `skip_if_unchanged=true` để LCA trả metadata `unchanged` thay vì gửi lặp nội dung qua tunnel. Không bật cờ này khi đang yêu cầu một range mới.

LCA dùng một tool catalog cố định để ChatGPT không phải Refresh connector khi đổi chế độ. Các alias và wrapper bị thay thế hoàn toàn được ẩn; những capability chuyên biệt như `workspace_doctor`, `preview_patch`, `run_changed_tests`, `security_scan`, profile, Figma, skill và notes vẫn được giữ. Backend autocomplete của Apps SDK được đánh dấu app-only.

`workspace_snapshot` hỗ trợ `focus` để gom repo context và các match liên quan trong một evidence pack. `session_report` có thể gom git state, change summary và heuristic review trong một call; quality gate chỉ chạy khi được yêu cầu rõ ràng.

Review Changes không phụ thuộc Git. Mỗi task giữ các operation riêng, nhưng card được tổng hợp từ trạng thái trước operation đầu tiên đến trạng thái sau operation cuối cùng. Undo task chạy operation theo thứ tự mới → cũ; Reapply chạy cũ → mới. File text nhỏ có before/after snapshot để hỗ trợ Diff, Undo, Partial Undo và Reapply. File lớn, binary và directory chỉ lưu metadata nên không bị backend giả vờ rằng có thể phục hồi an toàn. Rename được quản lý như atomic group và Undo/Reapply luôn kiểm tra conflict trước khi ghi đè.

HTTP API:

```text
GET    /changes
GET    /changes/:id
GET    /changes/:id/diff
GET    /changes/:id/content?path=src/file.js&side=before|after
POST   /changes/:id/undo
POST   /changes/:id/reapply
POST   /changes/undo-all
DELETE /changes
```

`run_command` và `run_commands` chỉ tạo activity record tối giản; lịch sử thay đổi không lưu command text, stdout, stderr, environment hoặc secret.

VS Code extension là tích hợp tùy chọn. Cài và mở bằng:

```bash
lca extension setup
lca extension
```

Gỡ extension:

```bash
lca extension uninstall
```

`lca setup` thông thường không cài extension. View **Local Coding Agent → Review Changes** hiển thị một card cho toàn bộ task, hỗ trợ native diff, Undo/Reapply cả task hoặc từng file, Undo All và Clear History. Nếu LCA đang chạy cho workspace khác, chọn **Connect LCA to this workspace** để stop instance cũ và start lại theo repo đang mở trong VS Code.

Chi tiết: [docs/REVIEW_CHANGES.md](docs/REVIEW_CHANGES.md).

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

Workspace là thư mục ChatGPT được phép đọc/sửa/chạy command thông qua connector.

Khi chạy:

```bash
cd /path/to/repo
lca
```

workspace sẽ là git root của repo đó. Nếu không nằm trong git repo, workspace là thư mục hiện tại.

## Bảo Mật

Nguyên tắc an toàn:

- Không commit `.env.local`.
- Không in API key, Tunnel ID, token hoặc local config có secret.
- Chỉ mở workspace bạn tin tưởng.
- Luôn gọi `lca` trong ChatGPT để kiểm tra root trước khi yêu cầu sửa file.

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

## Writing Tests Safely

Test có mutation filesystem phải dùng `server/tests/helpers/test-guard.mjs`, workspace tạm, data directory tạm và port động. Không dùng checkout thật, Git root, port `8789` hoặc `server/data` làm fixture disposable.

Chạy safety gate trước integration hoặc security test:

```bash
cd server
npm run test:safety
```

Security suite chỉ chạy qua wrapper cô lập:

```bash
npm run test:security
```

Chi tiết: [docs/TEST_SAFETY.md](docs/TEST_SAFETY.md).

## Troubleshooting

| Lỗi                                                  | Cách xử lý                                                                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lca: command not found` / `'lca' is not recognized` | Trên Windows: đóng terminal cũ, mở terminal mới rồi chạy lại `lca`. Nếu vẫn lỗi, chạy `scripts\lca.cmd cli` để cài lại wrapper hoặc gọi trực tiếp path wizard in ra. |
| Server chạy nhầm repo                                | `cd` vào repo đúng rồi chạy lại `lca`.                                                                                                                               |
| Port `8789` bận                                      | Chạy `lca setup` và đổi MCP port, hoặc set `PORT` trước khi chạy.                                                                                                    |
| Server không health                                  | Kiểm tra `lca status` và `http://127.0.0.1:8789/healthz`.                                                                                                            |
| Connector không thấy tool                            | Đảm bảo `lca` đang chạy, tunnel connected, connector dùng `No auth`.                                                                                                 |
| Sửa nhầm repo                                        | Trong ChatGPT gọi `lca` để xem root thật.                                                                                                                             |

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
