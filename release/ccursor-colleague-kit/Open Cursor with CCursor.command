#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURSOR_APP="/Applications/Cursor.app"
CCURSOR_USER_DATA_DIR="${CCURSOR_USER_DATA_DIR:-$HOME/.cursor-ccursor-profile}"
CCURSOR_EXTENSIONS_DIR="${CCURSOR_EXTENSIONS_DIR:-$CCURSOR_USER_DATA_DIR/extensions}"

if [[ ! -d "$CURSOR_APP" ]]; then
  echo "ERROR: Cursor.app not found at $CURSOR_APP"
  exit 1
fi

mkdir -p "$CCURSOR_USER_DATA_DIR" "$CCURSOR_EXTENSIONS_DIR"

echo "Refreshing CCursor account from Codex config..."
ruby "$SCRIPT_DIR/lib/sync_codex_openai_compat.rb"

echo
echo "Opening Cursor through CCursor local proxy..."
open -na "$CURSOR_APP" --args \
  --user-data-dir="$CCURSOR_USER_DATA_DIR" \
  --extensions-dir="$CCURSOR_EXTENSIONS_DIR" \
  --proxy-server=http://127.0.0.1:18080 \
  --ignore-certificate-errors

echo
echo "Cursor CCursor profile is starting. Wait 10-20 seconds, then run 'Check CCursor.command' if needed."
