#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8789}"
DASHBOARD_PORT="${DASHBOARD_PORT:-8790}"

[ -f "$ROOT/.env.local" ] || { echo "Missing .env.local"; exit 1; }
set -a
. "$ROOT/.env.local"
set +a
[ -n "${CONTROL_PLANE_API_KEY:-}" ] || { echo "Missing CONTROL_PLANE_API_KEY in .env.local"; exit 1; }

configured_workspace="$(
  bash "$ROOT/scripts/lca" config show | node -e '
    let s = "";
    process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => process.stdout.write(JSON.parse(s).workspace || ""));
  '
)"
running_workspace="$(
  curl -fsS "http://127.0.0.1:${PORT}/healthz" 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => { try { process.stdout.write(JSON.parse(s).workspace || ""); } catch {} });
  ' || true
)"

if [ -n "$running_workspace" ] && [ "$running_workspace" != "$configured_workspace" ]; then
  echo "Workspace changed; restarting."
  bash "$ROOT/scripts/lca" stop
fi

if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 && curl -fsS http://127.0.0.1:8788/readyz >/dev/null 2>&1; then
  echo "Already running."
  echo "Workspace: ${running_workspace:-$configured_workspace}"
  echo "MCP:       http://127.0.0.1:${PORT}/mcp"
  echo "Dashboard: http://127.0.0.1:${DASHBOARD_PORT}/ui"
else
  bash "$ROOT/scripts/lca" start
fi
