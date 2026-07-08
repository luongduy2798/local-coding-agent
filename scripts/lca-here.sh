#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  lca             Set workspace to current repo and run
  lca run         Set workspace to current repo and run
  lca start       Set workspace to current repo and run
  lca workspace   Open workspace picker
  lca stop        Stop server/tunnel
  lca status      Show status
  lca raw ...     Pass through to scripts/lca
EOF
}

current_workspace() {
  local git_root
  if command -v git >/dev/null 2>&1; then
    git_root="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -n "$git_root" ] && [ -d "$git_root" ]; then
      cd "$git_root" && pwd -P
      return
    fi
  fi
  pwd -P
}

cmd="${1:-run}"
case "$cmd" in
  run|start)
    workspace="$(current_workspace)"
    bash "$ROOT/scripts/lca" config set workspace "$workspace" >/dev/null
    PORT="${PORT:-8789}" DASHBOARD_PORT="${DASHBOARD_PORT:-8790}" bash "$ROOT/scripts/run-lca.sh"
    ;;
  workspace)
    bash "$ROOT/scripts/select-workspace.sh"
    ;;
  stop|status|doctor|logs|url|open|config|key|skills|install|setup|profile|update)
    exec bash "$ROOT/scripts/lca" "$@"
    ;;
  raw)
    shift
    exec bash "$ROOT/scripts/lca" "$@"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    exit 2
    ;;
esac
