# ChatGPT Web Connector

Flow chính:

```bash
cd /repo/can-lam-viec
lca
```

Không dùng OAuth connector. Không nhập Runtime API key vào Auth của ChatGPT connector.

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

- cho chọn hệ điều hành
- tạo/cập nhật `.env.local`
- cài dependency
- tải `tunnel-client` nếu có thể
- ghi config local
- cài global command `lca`

Nếu cần mở trang key/tunnel sau setup:

```bash
lca keys
```

## 2. Chạy Cho Repo Cần Làm Việc

```bash
cd /path/to/project
lca
```

Nếu trước đó đang chạy workspace khác, `lca` sẽ tự restart sang workspace hiện tại.

Kiểm tra local:

```text
http://127.0.0.1:8789/healthz
lca status
```

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
call workspace_info
```

Kết quả phải trả về root đúng với repo bạn vừa chạy `lca`.

## 5. Đổi Repo

```bash
cd /repo/khac
lca
```

ChatGPT connector giữ nguyên. Workspace đổi theo repo mới.

## 6. Dừng

```bash
lca stop
```

## Ghi Chú

- Runtime API key ở `.env.local` dành cho tunnel-client chạy local.
- Nếu bật Auth/OAuth trong connector sẽ lỗi vì server này đang dùng hướng `No auth`.
- Chỉ kết nối workspace tin tưởng.
- `scripts/start-tunnel.sh` và `scripts/start-tunnel.ps1` chỉ còn là legacy/debug launcher.
