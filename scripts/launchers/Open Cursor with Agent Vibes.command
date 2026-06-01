#!/usr/bin/env bash
set -euo pipefail

CURSOR_APP="${CURSOR_APP:-/Applications/Cursor.app}"
AGENT_VIBES_USER_DATA_DIR="${AGENT_VIBES_USER_DATA_DIR:-$HOME/.cursor-agent-vibes-profile}"
AGENT_VIBES_EXTENSIONS_DIR="${AGENT_VIBES_EXTENSIONS_DIR:-$AGENT_VIBES_USER_DATA_DIR/extensions}"
AGENT_VIBES_FORWARD_PROXY_PORT="${AGENT_VIBES_FORWARD_PROXY_PORT:-18080}"
PROXY_URL="http://127.0.0.1:${AGENT_VIBES_FORWARD_PROXY_PORT}"
NO_PROXY_VALUE="localhost,127.0.0.1,::1"

if [[ ! -d "$CURSOR_APP" ]]; then
  echo "ERROR: Cursor.app not found at $CURSOR_APP"
  exit 1
fi

mkdir -p "$AGENT_VIBES_USER_DATA_DIR" "$AGENT_VIBES_EXTENSIONS_DIR"

echo "Opening isolated Cursor profile through Agent Vibes proxy..."
echo "Profile: $AGENT_VIBES_USER_DATA_DIR"
echo "Proxy:   $PROXY_URL"

open -na "$CURSOR_APP" \
  --env "HTTP_PROXY=$PROXY_URL" \
  --env "HTTPS_PROXY=$PROXY_URL" \
  --env "ALL_PROXY=$PROXY_URL" \
  --env "http_proxy=$PROXY_URL" \
  --env "https_proxy=$PROXY_URL" \
  --env "all_proxy=$PROXY_URL" \
  --env "NO_PROXY=$NO_PROXY_VALUE" \
  --env "no_proxy=$NO_PROXY_VALUE" \
  --args \
  --user-data-dir="$AGENT_VIBES_USER_DATA_DIR" \
  --extensions-dir="$AGENT_VIBES_EXTENSIONS_DIR" \
  --proxy-server="$PROXY_URL" \
  --ignore-certificate-errors \
  --new-window \
  "$@"

echo "Agent Vibes Cursor profile is starting. Install the VSIX into this profile if it is not already installed."
