# AGENTS.md — setup guide for AI coding agents

Nếu user yêu cầu cài hoặc hướng dẫn repo này, dùng flow TUI mới dưới đây.

## What This Is

Local MCP server (`server/server.mjs`) cho ChatGPT Web connector. User chạy global command `lca` trong repo bất kỳ; workspace tự lấy theo git root hiện tại.

## Prerequisites

- Node.js >= 18 (`node -v`)
- npm
- Git nếu muốn tự nhận git root
- OpenAI Tunnel ID và Runtime API key nếu dùng ChatGPT Web tunnel

Không commit secret, `.env.local`, `tools/`, generated profiles hoặc logs có secret.

## Setup

Chạy setup wizard trong repo `local-coding-agent`:

```bash
# macOS / Linux / WSL
bash scripts/lca setup
```

```powershell
# Windows
scripts\lca.cmd setup
```

Wizard sẽ cho chọn OS, kiểm tra prerequisite, mở trang Tunnel/API key, tạo/cập nhật `.env.local`, cài dependency, auto-download `tunnel-client` khi có thể, ghi config local và cài global command `lca`.

Legacy wrappers như `make setup`, `bash install.sh`, và `.\install.ps1` chỉ forward vào wizard. Không dùng chúng làm tài liệu flow chính.

## Daily Use

Trong repo cần làm việc:

```bash
cd /path/to/repo
lca
```

Nếu server đang chạy workspace cũ, `lca` tự restart với workspace mới.

Lệnh thường dùng:

```bash
lca stop
lca status
lca workspace
lca doctor
```

## ChatGPT Web Connector

- ChatGPT Web -> Settings -> Connectors -> Developer mode -> Add custom MCP connector.
- Chọn tunnel đã tạo.
- Auth: `No auth`.
- Không dùng OAuth.
- Không nhập Runtime API key vào connector auth; key này nằm trong `.env.local` cho local tunnel-client.
- Verify bằng cách hỏi ChatGPT gọi `workspace_info`.

Chi tiết: [docs/CHATGPT_WEB_CONNECTOR.md](docs/CHATGPT_WEB_CONNECTOR.md).

## URLs

- MCP local: `http://127.0.0.1:8789/mcp`
- Health: `http://127.0.0.1:8789/healthz`
- Tunnel health/admin: `http://127.0.0.1:8788`

Tunnel-client dùng port `8788`; tránh dùng lại port này cho dịch vụ khác.

## Safety

- Default `mode=safe`, `policy=balanced`.
- Đây không phải OS sandbox.
- Chỉ connect workspace tin tưởng.
- Không expose server public nếu chưa hiểu rủi ro.
- Với `policy=balanced`, đặt `AGENT_APPROVAL_TOKEN` nếu muốn duyệt action rủi ro mà không chuyển sang `policy=full`.

## Legacy Flow To Avoid As Primary Docs

Các script dưới đây chỉ để compatibility/debug:

- `scripts/start-tunnel.sh`
- `scripts/start-tunnel.ps1`
- `make setup`
- `make run`
- `make stop`
- OAuth connector

CLI gốc vẫn dùng được để debug:

```bash
node scripts/local-coding-agent.mjs status
node scripts/local-coding-agent.mjs logs
```
