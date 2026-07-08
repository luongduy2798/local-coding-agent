#!/usr/bin/env bash
# Local Coding Agent
# Copyright (c) 2026 Long Nguyen
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# One-shot setup (macOS / Linux). Run from the repo root:  bash install.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== Local Coding Agent - setup =="

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node 18+ (e.g. 'brew install node' or your package manager), then re-run." >&2
  exit 1
fi
echo "node $(node -v)"

echo "Installing server dependencies..."
( cd "$ROOT/server" && npm install --no-fund --no-audit )

mkdir -p "$ROOT/tools"
chmod +x "$ROOT/scripts/start-tunnel.sh" 2>/dev/null || true

cat <<'EOF'

Done. Next steps:
  1. Put your OpenAI tunnel client at: tools/tunnel-client   (chmod +x it)
  2. Run:  AGENT_WORKSPACE="/path/to/your/repo" bash scripts/start-tunnel.sh
  3. In ChatGPT: Settings -> Connectors -> Developer mode -> add the MCP connector.
  4. Verify in chat: "call workspace_info".

Dashboard (when running): http://127.0.0.1:8790/ui
EOF
