# Customer Update Prompt

Prompt này dùng khi đã có clone `local-coding-agent` và muốn nâng cấp an toàn lên runtime.

```text
Hãy update Local Coding Agent an toàn.

Repository:
https://github.com/luongduy2798/local-coding-agent

Mục tiêu:
- Xác minh Node.js >=22.13.0 và npm.
- Dùng `lca update` để dừng supervisor, backup CLI config/.env.local/existing runtime
  state, pull fast-forward, cài dependency, khởi tạo runtime storage và restart nếu
  runtime trước đó đang chạy.
- Giữ nguyên .env.local, tools/tunnel-client, profiles, local config và dữ liệu legacy.
- Giữ rollback point; rollback runtime không được xoá dữ liệu runtime.

Quy tắc:
- Không commit, in, upload hoặc expose API key, Runtime key, Tunnel ID,
  auth token, .env.local hoặc generated profiles.
- Không xoá workspace hoặc state legacy/runtime.
- Không chạy git reset --hard, git clean hoặc xoá file.
- Nếu checkout LCA có local changes, báo git status và dừng; không tự thêm --force.
- Không sửa Runtime API key hoặc connector auth.

Các bước:
1. Vào thư mục local-coding-agent.
2. Chạy `node -v`, `npm -v` và `git status --short --branch`.
3. Nếu Node thấp hơn 22.13.0, báo lệnh nâng cấp phù hợp hệ điều hành;
   không tự thay system Node khi chưa được phép.
4. Nếu worktree sạch, chạy `lca update`.
5. Verify:
   - `lca status`
   - `lca doctor`
   - `http://127.0.0.1:8789/healthz`
   - local server báo version 5.x
   - workspace registry/task storage không báo integrity error
   Lưu ý `/healthz` chỉ là public liveness. Dùng `lca status` cho readiness chi
   tiết; không in instance nonce hoặc gọi `/healthz/details` khi chưa có local
   companion auth.
6. Nhắc tôi refresh ChatGPT custom MCP connector một lần, mở chat mới
   và gọi `lca_status` để xác minh `catalog_version=8`/fixed 36-tool catalog.
7. Báo lại commit hiện tại, supervisor/server/tunnel status, workspace đã chọn,
   active session/task count và vị trí rollback point; không in secret.

Nếu runtime không hoạt động:
1. Thu thập `lca status`, `lca doctor` và log đã redact; không xoá state.
2. Chạy `lca rollback` chỉ khi tôi yêu cầu.
3. Verify runtime cũ đã start lại nếu nó từng chạy.
4. Xác nhận dữ liệu runtime vẫn được giữ nguyên.
5. Nhắc tôi refresh connector lần nữa trước khi mở chat legacy.
```

Chi tiết: [RUNTIME.md](RUNTIME.md). Guide chính: [../README.md](../README.md).
