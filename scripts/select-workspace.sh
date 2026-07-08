#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

configured_workspace="$(
  bash "$ROOT/scripts/lca" config show 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => {
      try { process.stdout.write(JSON.parse(s).workspace || ""); } catch {}
    });
  ' || true
)"

start="${WORKSPACE_SEARCH_ROOT:-${configured_workspace:-$ROOT}}"
[ -d "$start" ] || start="$ROOT"
current="$(cd "$start" && pwd -P)"

if [ ! -t 0 ] || [ ! -t 1 ]; then
  echo "Interactive terminal required."
  exit 1
fi

old_stty="$(stty -g)"
restored=0

restore_terminal() {
  if [ "$restored" -eq 0 ]; then
    stty "$old_stty"
    printf '\033[?25h\033[0m'
    restored=1
  fi
}

trap restore_terminal EXIT
trap 'restore_terminal; exit 130' INT TERM
stty -echo -icanon time 0 min 1
printf '\033[?25l'

labels=()
types=()
paths=()
selected=0
choice=""

add_item() {
  labels[${#labels[@]}]="$1"
  types[${#types[@]}]="$2"
  paths[${#paths[@]}]="$3"
}

load_items() {
  labels=()
  types=()
  paths=()

  add_item "Select this folder" "select" "$current"
  add_item "Back .." "back" "$(dirname "$current")"

  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    name="${dir##*/}"
    [ "$name" = ".git" ] && continue
    if [ -d "$dir/.git" ]; then
      add_item "$name/  [repo]" "select" "$dir"
    else
      add_item "$name/" "open" "$dir"
    fi
  done <<EOF
$(find "$current" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | sort)
EOF

  if [ "$selected" -ge "${#labels[@]}" ]; then
    selected=0
  fi
}

render() {
  printf '\033[H\033[2J'
  printf 'Choose workspace\n'
  printf 'Path: %s\n\n' "$current"
  printf 'Up/Down: move  Enter: select/open  q: quit\n\n'

  i=0
  while [ "$i" -lt "${#labels[@]}" ]; do
    if [ "$i" -eq "$selected" ]; then
      printf '\033[7m> %s\033[0m\n' "${labels[$i]}"
    else
      printf '  %s\n' "${labels[$i]}"
    fi
    i=$((i + 1))
  done
}

read_key() {
  local key rest
  IFS= read -rsn1 key || return 1
  case "$key" in
    $'\033')
      IFS= read -rsn2 -t 1 rest || true
      case "$rest" in
        "[A") printf 'up' ;;
        "[B") printf 'down' ;;
        *) printf 'other' ;;
      esac
      ;;
    "")
      printf 'enter'
      ;;
    q|Q)
      printf 'quit'
      ;;
    *)
      printf 'other'
      ;;
  esac
}

load_items
while true; do
  render
  key="$(read_key)"
  case "$key" in
    up)
      selected=$((selected - 1))
      if [ "$selected" -lt 0 ]; then
        selected=$((${#labels[@]} - 1))
      fi
      ;;
    down)
      selected=$((selected + 1))
      if [ "$selected" -ge "${#labels[@]}" ]; then
        selected=0
      fi
      ;;
    enter)
      type="${types[$selected]}"
      path="${paths[$selected]}"
      case "$type" in
        select)
          choice="$(cd "$path" && pwd -P)"
          break
          ;;
        back|open)
          current="$(cd "$path" && pwd -P)"
          selected=0
          load_items
          ;;
      esac
      ;;
    quit)
      restore_terminal
      printf '\nCanceled.\n'
      exit 0
      ;;
  esac
done

restore_terminal
printf '\n'
bash "$ROOT/scripts/lca" config set workspace "$choice"
echo "Workspace: $choice"
echo "Run: make run"
