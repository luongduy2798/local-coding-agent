---
name: setup-local-coding-agent
description: Install Local Coding Agent for a customer using the universal CLI, safe defaults, and verification checks.
---

# Setup Local Coding Agent

Use this when a customer asks an AI agent to clone, install, configure, and
start Local Coding Agent.

## Rules

- Do not install system dependencies without asking first.
- Let the setup wizard download `tunnel-client` when possible; fall back to a
  customer-provided path if download/extraction fails.
- Do not print, commit, or upload API keys, tunnel IDs, auth tokens, or local config.
- Default to `mode=safe` and `policy=balanced`.
- Prefer the universal CLI over the Windows tray app unless the customer asks for GUI.

## Steps

1. Check prerequisites:
   - `node -v` must be 18 or newer.
   - `git --version` should work.
2. Clone the repo if needed:
   - `git clone https://github.com/luongduy2798/local-coding-agent.git`
3. Enter the repo and run setup wizard:
   - Windows: `scripts\lca.cmd setup`
   - macOS/Linux/WSL: `bash scripts/lca setup`
4. Let the wizard ask the customer for:
   - workspace path
   - Tunnel ID
   - Runtime API key for `.env.local`
   - tunnel-client path only if auto-download fails
5. Start from the target repo:
   - `cd /path/to/workspace`
   - `lca`
6. Verify:
   - `http://127.0.0.1:8789/healthz`
   - `scripts\lca.cmd status` or `bash scripts/lca status`

## Report Back

Return:

- repo path
- workspace path
- MCP URL
- health URL
- mode and policy
- tunnel status
- any missing requirement and the exact next fix
