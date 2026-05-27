#!/usr/bin/env bash
set -euo pipefail

CURSOR_APP="/Applications/Cursor.app"
OFFICIAL_USER_DATA_DIR="${CURSOR_OFFICIAL_USER_DATA_DIR:-$HOME/.cursor-official-profile}"
OFFICIAL_EXTENSIONS_DIR="${CURSOR_OFFICIAL_EXTENSIONS_DIR:-$OFFICIAL_USER_DATA_DIR/extensions}"

if [[ ! -d "$CURSOR_APP" ]]; then
  echo "ERROR: Cursor.app not found at $CURSOR_APP"
  exit 1
fi

mkdir -p "$OFFICIAL_USER_DATA_DIR" "$OFFICIAL_EXTENSIONS_DIR"

echo "Opening Cursor official profile without CCursor proxy..."
open -na "$CURSOR_APP" --args \
  --user-data-dir="$OFFICIAL_USER_DATA_DIR" \
  --extensions-dir="$OFFICIAL_EXTENSIONS_DIR"

echo
echo "Cursor official profile is starting. This window uses Cursor official models and account settings."
