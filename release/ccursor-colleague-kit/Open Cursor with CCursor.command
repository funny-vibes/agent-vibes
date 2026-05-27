#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURSOR_APP="/Applications/Cursor.app"

if [[ ! -d "$CURSOR_APP" ]]; then
  echo "ERROR: Cursor.app not found at $CURSOR_APP"
  exit 1
fi

echo "Refreshing CCursor account from Codex config..."
ruby "$SCRIPT_DIR/lib/sync_codex_openai_compat.rb"

echo
echo "Opening Cursor through CCursor local proxy..."
open -na "$CURSOR_APP" --args \
  --proxy-server=http://127.0.0.1:18080 \
  --ignore-certificate-errors

echo
echo "Cursor is starting. Wait 10-20 seconds, then run 'Check CCursor.command' if needed."

