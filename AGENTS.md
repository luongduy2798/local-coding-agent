# AGENTS.md — setup guide for AI coding agents

Nếu user yêu cầu cài hoặc hướng dẫn repo này, dùng flow mới dưới đây.

## What this is

Local MCP server (`server/server.mjs`) cho ChatGPT Web connector. User chạy global command `lca` trong repo bất kỳ; workspace tự lấy theo repo hiện tại.

## Prerequisites

- Node.js >= 18 (`node -v`)
- `make`, `bash`, `curl`, `unzip`
- OpenAI Tunnel ID
- Runtime API key

Không commit secret, `.env.local`, `tools/`, generated profiles hoặc logs có secret.

## Setup

```bash
cp .env.example .env.local
make keys
```

Yêu cầu user điền vào `.env.local`:

```env
CONTROL_PLANE_TUNNEL_ID=tunnel_...
CONTROL_PLANE_API_KEY=sk-proj-...
```

Sau đó:

```bash
make setup
```

`make setup` cài dependency, tải `tools/tunnel-client`, ghi config local và cài global command `lca` vào `~/.local/bin/lca`.

## Daily Use

Trong repo cần làm việc:

```bash
cd /path/to/repo
lca
```

Nếu server đang chạy workspace cũ, `lca` tự stop/start lại với workspace mới.

Stop:

```bash
lca stop
```

Status:

```bash
lca status
```

TUI chọn workspace:

```bash
lca workspace
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
- Dashboard: `http://127.0.0.1:8790/ui`
- Tunnel health/admin: `http://127.0.0.1:8788`

Không dùng port `8788` cho dashboard vì tunnel-client dùng port đó.

## Safety

- Default `mode=safe`, `policy=balanced`.
- Đây không phải OS sandbox.
- Chỉ connect workspace tin tưởng.
- Không expose server public nếu chưa hiểu rủi ro.

## Old Flow To Avoid

Không dùng các hướng dẫn cũ làm flow chính:

- `scripts/lca setup`
- `scripts/lca start`
- `make run`
- `make stop`
- OAuth connector

CLI gốc vẫn dùng được để debug qua:

```bash
lca raw ...
```
