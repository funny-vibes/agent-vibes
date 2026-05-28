#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VSIX_PATH="$(find "$SCRIPT_DIR" -maxdepth 1 -name "ccursor-*.vsix" | sort | tail -n 1)"

if [[ -z "$VSIX_PATH" || ! -f "$VSIX_PATH" ]]; then
  echo "ERROR: ccursor-*.vsix not found in $SCRIPT_DIR"
  exit 1
fi

if command -v cursor >/dev/null 2>&1; then
  CURSOR_CLI="$(command -v cursor)"
elif [[ -x "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" ]]; then
  CURSOR_CLI="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
else
  echo "ERROR: Cursor CLI not found. Install Cursor first, then rerun this installer."
  exit 1
fi

echo "Installing CCursor extension..."
"$CURSOR_CLI" --install-extension "$VSIX_PATH" --force

CCURSOR_USER_DATA_DIR="${CCURSOR_USER_DATA_DIR:-$HOME/.cursor-ccursor-profile}"
CCURSOR_EXTENSIONS_DIR="${CCURSOR_EXTENSIONS_DIR:-$CCURSOR_USER_DATA_DIR/extensions}"
mkdir -p "$CCURSOR_USER_DATA_DIR" "$CCURSOR_EXTENSIONS_DIR"

echo "Installing CCursor extension into isolated CCursor profile..."
"$CURSOR_CLI" \
  --user-data-dir "$CCURSOR_USER_DATA_DIR" \
  --extensions-dir "$CCURSOR_EXTENSIONS_DIR" \
  --install-extension "$VSIX_PATH" \
  --force

echo
echo "Reading Codex config and writing CCursor OpenAI-compatible account..."
ruby "$SCRIPT_DIR/lib/sync_codex_openai_compat.rb"

echo
echo "Creating CCursor.app launcher..."
"$SCRIPT_DIR/Create CCursor App.command"

echo
echo "Install finished."
echo "Next:"
echo "  - double-click 'Open Cursor Official.command' for Cursor official models"
echo "  - double-click 'CCursor.app' for your AI gateway"
