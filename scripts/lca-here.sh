#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cmd="${1:-run}"
case "$cmd" in
  run|start)
    shift || true
    exec bash "$ROOT/scripts/lca" run "$@"
    ;;
  workspace)
    exec bash "$ROOT/scripts/lca" workspace
    ;;
  stop|status|doctor|logs|url|config|key|skills|install|setup|profile|update)
    exec bash "$ROOT/scripts/lca" "$@"
    ;;
  raw)
    shift
    exec bash "$ROOT/scripts/lca" "$@"
    ;;
  -h|--help|help)
    exec bash "$ROOT/scripts/lca" --help
    ;;
  *)
    exec bash "$ROOT/scripts/lca" "$@"
    ;;
esac
