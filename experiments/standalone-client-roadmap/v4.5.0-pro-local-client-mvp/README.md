# v4.5.0-pro Local Client MVP

Goal: run a local AI coding client without ChatGPT Web.

This app is intentionally separate from the main MCP server. It connects to a
running Local Coding Agent MCP endpoint and performs a basic model/tool loop.

## What Works

- Local web UI at `http://127.0.0.1:5177`
- Connect to MCP endpoint, default `http://127.0.0.1:8787/mcp`
- List MCP tools
- Manually call a tool from the UI
- Chat with an OpenAI model through the Responses API
- Let the model call MCP tools
- Show tool call timeline and raw results

## Requirements

- Node.js 18+
- Main Local Coding Agent server running
- `OPENAI_API_KEY` in the environment

## Start

From repo root:

```powershell
scripts\lca.cmd start --no-tunnel
```

Then:

```powershell
cd experiments\standalone-client-roadmap\v4.5.0-pro-local-client-mvp
npm install
$env:OPENAI_API_KEY="sk-proj-..."
npm start
```

Open:

```text
http://127.0.0.1:5177
```

Or double-click `dist\LocalAgentStudio.exe` after running `..\build-all.ps1`.

## Notes

- This is an experiment, not a replacement for ChatGPT Web yet.
- API usage is billed through the Platform API key, not a ChatGPT subscription.
- Tool safety still lives in the MCP server.
- Keep `AGENT_MODE=safe` and `AGENT_POLICY=balanced` for real customer testing.
