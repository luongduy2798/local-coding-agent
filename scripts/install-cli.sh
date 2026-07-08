#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${LCA_BIN_DIR:-$HOME/.local/bin}"
CMD_NAME="${LCA_CMD_NAME:-lca}"
TARGET="$BIN_DIR/$CMD_NAME"
MARKER="local-coding-agent lca wrapper"

mkdir -p "$BIN_DIR"

if [ -e "$TARGET" ] && ! grep -q "$MARKER" "$TARGET" 2>/dev/null; then
  echo "Refusing to overwrite: $TARGET"
  echo "Set LCA_CMD_NAME=lca-agent or remove the existing file."
  exit 1
fi

cat > "$TARGET" <<EOF
#!/usr/bin/env bash
# $MARKER
exec bash "$ROOT/scripts/lca-here.sh" "\$@"
EOF
chmod +x "$TARGET"

echo "Installed: $TARGET"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add to PATH: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
