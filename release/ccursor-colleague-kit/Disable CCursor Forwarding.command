#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CCURSOR_BRIDGE_PORT="${CCURSOR_BRIDGE_PORT:-2026}"
SCRIPT_PATH="$SCRIPT_DIR/scripts/setup-forwarding.js"
if [[ ! -f "$SCRIPT_PATH" && -f "$SCRIPT_DIR/../../apps/vscode-extension/scripts/setup-forwarding.js" ]]; then
  SCRIPT_PATH="$(cd "$SCRIPT_DIR/../.." && pwd)/apps/vscode-extension/scripts/setup-forwarding.js"
fi

if [[ ! -f "$SCRIPT_PATH" ]]; then
  echo "ERROR: forwarding script not found: $SCRIPT_PATH"
  echo "Reinstall the full CCursor colleague kit."
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node is required but was not found in PATH."
  exit 1
fi

echo "Disabling CCursor system forwarding..."
echo "This requires your macOS administrator password."
echo

sudo "$NODE_BIN" "$SCRIPT_PATH" off --port="$CCURSOR_BRIDGE_PORT"

echo
echo "Checking forwarding status..."
"$NODE_BIN" "$SCRIPT_PATH" status --port="$CCURSOR_BRIDGE_PORT" || true
