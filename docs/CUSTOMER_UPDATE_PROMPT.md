# Customer Update Prompt

Prompt này dùng khi đã có clone `local-coding-agent` và muốn update an toàn theo flow TUI mới.

```text
Hãy update Local Coding Agent an toàn.

Repository:
https://github.com/luongduy2798/local-coding-agent

Mục tiêu:
- Pull bản mới nếu không có conflict.
- Giữ nguyên .env.local, tools/tunnel-client, profiles và local config.
- Cài lại dependency nếu cần.
- Chạy setup wizard để đồng bộ wrapper/config.
- Không restart nếu tôi chưa đồng ý.

Quy tắc:
- Không commit, in, upload hoặc expose API key, Runtime key, Tunnel ID, auth token, .env.local hoặc generated profiles.
- Không xoá workspace của tôi.
- Không chạy git reset --hard, git clean hoặc xoá file nếu chưa được duyệt.
- Nếu repo có local changes, báo git status rồi hỏi trước.
- Flow chính sau update là cd vào repo cần làm việc rồi chạy lca.

Các bước:
1. Vào thư mục local-coding-agent.
2. Chạy git status --short --branch.
3. Nếu có local changes, tóm tắt và hỏi tôi trước khi tiếp tục.
4. Chạy git fetch origin main --tags.
5. Chạy git log --oneline --decorate --max-count=10 HEAD..origin/main.
6. Chạy git pull --ff-only origin main.
7. Chạy setup wizard:
   - macOS/Linux/WSL: bash scripts/lca setup
   - Windows: scripts\lca.cmd setup
8. Kiểm tra lca có trong PATH.
9. Nếu tôi đồng ý restart, chạy:
   lca stop
   cd /path/to/workspace
   lca
10. Verify:
   - http://127.0.0.1:8789/healthz
   - lca status
11. Báo lại commit hiện tại, health URL, workspace hiện tại, mode/policy và tunnel status.
```

Guide chính: [../README.md](../README.md).
