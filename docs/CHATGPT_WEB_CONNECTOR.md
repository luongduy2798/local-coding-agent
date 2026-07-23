# ChatGPT Web Connector

Flow chính:

```bash
cd /repo/can-lam-viec
lca
```

Không bật OAuth/Auth trong connector. Không nhập Runtime API key vào Auth của ChatGPT connector.

Yêu cầu runtime: Node.js `>=22.13.0` và npm.

## 1. Setup Local Agent

Trong repo `local-coding-agent`, chạy wizard:

```bash
# macOS / Linux / WSL
bash scripts/lca setup
```

```powershell
# Windows
scripts\lca.cmd setup
```

Wizard sẽ:

- tự nhận hệ điều hành và kiểm tra Node.js
- tạo/cập nhật `.env.local`
- cài dependency
- tải `tunnel-client` nếu có thể
- ghi config local
- cài global command `lca`
- xin one-time consent nếu bật profile `full/full`

Nếu cần mở trang key/tunnel sau setup:

```bash
lca keys
```

## 2. Chạy Cho Repo Cần Làm Việc

```bash
cd /path/to/project
lca
```

Lần đầu, `lca` start một supervisor sở hữu server và tunnel. Nếu supervisor đã chạy, lệnh này chỉ đăng ký/chọn workspace hiện tại cho task mới; PID server/tunnel không đổi và task đang chạy không bị reroute.

Kiểm tra local:

```text
http://127.0.0.1:8789/healthz
lca status
```

`/healthz` là endpoint liveness public, chỉ trả version và catalog identity. Root, task, PID và readiness chi tiết chỉ hiện qua `lca status`; `/healthz/details` dành cho CLI/extension local, yêu cầu loopback + instance nonce của supervisor và không chấp nhận bearer tunnel thay thế.

## 3. Tạo Connector Trong ChatGPT Web

1. Mở ChatGPT Web.
2. Settings -> Connectors.
3. Bật Developer mode.
4. Add custom MCP connector.
5. Chọn hoặc nhập tunnel đã tạo.
6. Auth: chọn `No auth`.
7. Save.

Nếu cần nhập URL thủ công, dùng MCP URL của tunnel trên trang OpenAI tunnel. Dạng thường gặp:

```text
https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_...
```

Không dùng URL local `http://127.0.0.1:8789/mcp` cho ChatGPT Web.

## 4. Kiểm Tra

Trong ChatGPT, hỏi:

```text
call lca
```

Prompt ngắn `call lca` phải chọn `lca_status`. Kết quả phải trả `catalog_version=7`, `catalog_hash`, workspace/task và trạng thái session. Dùng `workspace_list`, sau đó `workspace_select` và `task_open` để bind task mới vào repo trước khi gọi các coding/mutation tool. Khi mở task, ChatGPT chọn `complexity_hint`; LCA chỉ trả scope signal tư vấn và không tự đổi effective profile. Khi phạm vi thực sự thay đổi, ChatGPT xác nhận bằng `task_reclassify` kèm lý do. Task đang mở không tự đổi theo lần `workspace_select` sau đó.

Để kiểm tra Apps SDK và PiP, gọi:

```text
call lca_input
```

Widget sẽ xuất hiện inline trước. Bấm **PiP** và kiểm tra mode được ChatGPT cấp. Khi host hỗ trợ, composer sẽ thành cửa sổ nổi; trên mobile, ChatGPT có thể mở fullscreen thay thế.

## 5. Đổi Repo

```bash
cd /repo/khac
lca
```

ChatGPT connector, server và tunnel giữ nguyên. Repo mới trở thành workspace mặc định cho **task tiếp theo**; task đang mở vẫn bị khóa vào workspace set cũ.

Các lệnh quản lý:

```bash
lca workspace list
lca workspace use /repo/khac
lca workspace archive <path|workspace-id>
lca workspace restore <path|workspace-id>
lca workspace remove <path|workspace-id>
```

Hai chat có thể mở hai task trên hai workspace khác nhau cùng lúc. Một task có thể attach tối đa 8 workspace phụ trước mutation đầu tiên. Chi tiết: [RUNTIME.md](RUNTIME.md).

## 6. Refresh Connector Khi Nâng Cấp

Runtime publish catalog cố định 36 tool. Khi catalog thay đổi:

1. Chạy `lca update`.
2. Refresh custom MCP connector một lần.
3. Mở chat mới để ChatGPT nhận schema hiện tại.

Tên tool legacy không được đăng ký hoặc thực thi; stale client sẽ nhận lỗi kèm hướng dẫn refresh. Nếu `lca rollback` quay về catalog khác, refresh connector lần nữa.

## 7. Dừng

```bash
lca stop
```

## Ghi Chú

- Runtime API key ở `.env.local` dành cho tunnel-client chạy local.
- Nếu bật Auth/OAuth trong connector sẽ lỗi vì server này đang dùng hướng `No auth`.
- Chỉ kết nối workspace tin tưởng.
- Model không thể tự đăng ký một absolute path mới là tin tưởng; chạy `lca workspace use <path>` từ terminal local trước.
- `/changes`, `/changes/events` và `/healthz/details` là API companion local có auth; chúng không phải URL để nhập vào ChatGPT connector và instance nonce không được copy vào connector.
