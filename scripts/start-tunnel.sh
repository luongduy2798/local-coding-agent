#!/usr/bin/env bash
# Local Coding Agent
# Copyright (c) 2026 Lương Duy
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# macOS / Linux launcher: starts the Node MCP server, then the OpenAI Secure
# MCP Tunnel. Edit the variables below, then run:  bash scripts/start-tunnel.sh
set -euo pipefail

# Repo root = parent of this script's folder.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"

# ---- Edit these -----------------------------------------------------------
# Folder the agent may work in (REQUIRED). Or set the AGENT_WORKSPACE env var.
AGENT_WORKSPACE="${AGENT_WORKSPACE:-}"
# Path to YOUR copy of the OpenAI tunnel client (not shipped in this repo).
TUNNEL_BIN="${TUNNEL_BIN:-$REPO_ROOT/tools/tunnel-client}"
PROFILE_NAME="${PROFILE_NAME:-local-coding-agent}"
PROFILE_DIR="${PROFILE_DIR:-$REPO_ROOT/tools/profiles}"
AGENT_MODE="${AGENT_MODE:-safe}"      # "safe" (recommended) or "full"
AGENT_POLICY="${AGENT_POLICY:-balanced}" # strict, balanced, or full
EXTRA_ROOTS="${AGENT_EXTRA_ROOTS:-}"  # extra folders, semicolon-separated
AUTH_TOKEN="${MCP_AUTH_TOKEN:-}"      # optional bearer token
PORT="${PORT:-8789}"
# ---------------------------------------------------------------------------

HEALTH_URL="http://127.0.0.1:$PORT/healthz"

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: '$1' not found on PATH." >&2; exit 1; }; }
need node
need curl

get_field() { # $1 = json field; reads health, prints value or empty
  curl -fsS "$HEALTH_URL" 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d);
    process.stdin.on("end",()=>{try{process.stdout.write(String(JSON.parse(s)["'"$1"'"]??""))}catch{process.stdout.write("")}});' 2>/dev/null || true
}

stop_managed_server() {
  local pid="${1:-}"
  if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    local matches
    matches="$(pgrep -f "$SERVER_DIR/server.mjs" 2>/dev/null || true)"
    [ "$(printf '%s\n' "$matches" | sed '/^$/d' | wc -l | tr -d ' ')" = "1" ] || {
      echo "ERROR: active MCP server PID could not be identified safely; stop the intended server and retry." >&2
      exit 1
    }
    pid="$matches"
  fi

  local command_line
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command_line" in
    *"$SERVER_DIR/server.mjs"*) ;;
    *) echo "ERROR: PID $pid is not this Local Coding Agent server; refusing to stop it." >&2; exit 1 ;;
  esac
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  kill -KILL "$pid" 2>/dev/null || true
}

[ -n "$AGENT_WORKSPACE" ] || { echo "ERROR: set AGENT_WORKSPACE (top of script or env var)." >&2; exit 1; }
[ -d "$AGENT_WORKSPACE" ] || { echo "ERROR: workspace does not exist: $AGENT_WORKSPACE" >&2; exit 1; }
[ -x "$TUNNEL_BIN" ] || { echo "ERROR: tunnel client not found/executable: $TUNNEL_BIN" >&2; exit 1; }

AUTH_ENABLED=0
[ -n "$AUTH_TOKEN" ] && AUTH_ENABLED=1
CONFIG_ID="$(
  LCA_WORKSPACE="$AGENT_WORKSPACE" LCA_MODE="$AGENT_MODE" LCA_POLICY="$AGENT_POLICY" \
  LCA_EXTRA_ROOTS="$EXTRA_ROOTS" LCA_AUTH_ENABLED="$AUTH_ENABLED" LCA_PORT="$PORT" node -e '
    const c=require("node:crypto");
    const keys=["LCA_WORKSPACE","LCA_MODE","LCA_POLICY","LCA_EXTRA_ROOTS","LCA_AUTH_ENABLED","LCA_PORT"];
    const value=JSON.stringify(Object.fromEntries(keys.map(k=>[k,process.env[k]||""])));
    process.stdout.write(c.createHash("sha256").update(value).digest("hex").slice(0,16));'
)"

# First-run install.
[ -d "$SERVER_DIR/node_modules" ] || { echo "Installing server dependencies..."; (cd "$SERVER_DIR" && npm install); }

# Restart only the server behind this health endpoint when startup config changed.
cur_ws="$(get_field workspace)"
cur_config="$(get_field config_id)"
cur_pid="$(get_field pid)"
if [ -n "$cur_ws" ] && [ "$cur_config" != "$CONFIG_ID" ]; then
  echo "Restarting MCP server with the requested config..."
  stop_managed_server "$cur_pid"
  sleep 1
fi

if ! curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
  echo "Starting MCP server (workspace=$AGENT_WORKSPACE mode=$AGENT_MODE)..."
  PORT="$PORT" AGENT_HOST=127.0.0.1 AGENT_WORKSPACE="$AGENT_WORKSPACE" AGENT_MODE="$AGENT_MODE" \
  AGENT_POLICY="$AGENT_POLICY" \
  AGENT_CONFIG_ID="$CONFIG_ID" \
  AGENT_EXTRA_ROOTS="$EXTRA_ROOTS" MCP_AUTH_TOKEN="$AUTH_TOKEN" \
    nohup node "$SERVER_DIR/server.mjs" >"$SERVER_DIR/mcp.log" 2>"$SERVER_DIR/mcp.err.log" &
  sleep 2
fi

curl -fsS "$HEALTH_URL" >/dev/null 2>&1 || { echo "MCP server did not respond. Check server/mcp.err.log" >&2; exit 1; }

echo "MCP server OK:  http://127.0.0.1:$PORT/mcp"
echo
echo "Paste the Runtime API key for the OpenAI Secure MCP Tunnel (input hidden)."
read -r -s -p "CONTROL_PLANE_API_KEY: " CP_KEY
echo

cleanup() { unset CP_KEY; }
trap cleanup EXIT
echo "Running tunnel. Keep this terminal open while using the ChatGPT app."
if [ -n "$AUTH_TOKEN" ]; then
  CONTROL_PLANE_API_KEY="$CP_KEY" \
  MCP_AUTH_HEADER="Bearer $AUTH_TOKEN" \
  MCP_EXTRA_HEADERS="Authorization: env:MCP_AUTH_HEADER" \
    "$TUNNEL_BIN" run --profile "$PROFILE_NAME" --profile-dir "$PROFILE_DIR"
else
  CONTROL_PLANE_API_KEY="$CP_KEY" \
    "$TUNNEL_BIN" run --profile "$PROFILE_NAME" --profile-dir "$PROFILE_DIR"
fi
