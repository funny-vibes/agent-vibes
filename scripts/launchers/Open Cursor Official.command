#!/usr/bin/env bash
set -euo pipefail

CURSOR_APP="${CURSOR_APP:-/Applications/Cursor.app}"
OFFICIAL_USER_DATA_DIR="${CURSOR_OFFICIAL_USER_DATA_DIR:-$HOME/.cursor-official-profile}"
OFFICIAL_EXTENSIONS_DIR="${CURSOR_OFFICIAL_EXTENSIONS_DIR:-$OFFICIAL_USER_DATA_DIR/extensions}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FORWARDING_SCRIPT="$REPO_ROOT/apps/vscode-extension/scripts/setup-forwarding.js"

if [[ ! -d "$CURSOR_APP" ]]; then
  echo "ERROR: Cursor.app not found at $CURSOR_APP"
  exit 1
fi

mkdir -p "$OFFICIAL_USER_DATA_DIR" "$OFFICIAL_EXTENSIONS_DIR"

if [[ "${AGENT_VIBES_DISABLE_FORWARDING_FOR_OFFICIAL:-true}" != "false" ]]; then
  if [[ -f "$FORWARDING_SCRIPT" ]] && command -v node >/dev/null 2>&1; then
    if node "$FORWARDING_SCRIPT" status --json >/dev/null 2>&1; then
      echo "Disabling Agent Vibes system forwarding before opening official Cursor..."
      node "$FORWARDING_SCRIPT" off || {
        echo "WARN: forwarding disable failed. Run this script from Terminal if sudo is required."
      }
    fi
  fi
fi

echo "Opening Cursor official profile without Agent Vibes proxy..."
open -na "$CURSOR_APP" --args \
  --user-data-dir="$OFFICIAL_USER_DATA_DIR" \
  --extensions-dir="$OFFICIAL_EXTENSIONS_DIR" \
  --new-window

echo "Official Cursor profile is starting: $OFFICIAL_USER_DATA_DIR"
