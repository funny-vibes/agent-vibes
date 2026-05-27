#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURSOR_APP="/Applications/Cursor.app"
CCURSOR_HOME="${CCURSOR_HOME:-$HOME/.ccursor}"
CCURSOR_USER_DATA_DIR="${CCURSOR_USER_DATA_DIR:-$HOME/.cursor-ccursor-profile}"
CCURSOR_EXTENSIONS_DIR="${CCURSOR_EXTENSIONS_DIR:-$CCURSOR_USER_DATA_DIR/extensions}"
CCURSOR_BRIDGE_PORT="${CCURSOR_BRIDGE_PORT:-2026}"
CCURSOR_FORWARD_PROXY_PORT="${CCURSOR_FORWARD_PROXY_PORT:-18080}"
BRIDGE_LOG_PATH="${TMPDIR:-/tmp}/agent-vibes-bridge.log"
BRIDGE_PLIST_PATH="$HOME/Library/LaunchAgents/com.ccursor.bridge.plist"

if [[ ! -d "$CURSOR_APP" ]]; then
  echo "ERROR: Cursor.app not found at $CURSOR_APP"
  exit 1
fi

mkdir -p "$CCURSOR_HOME/logs" "$CCURSOR_USER_DATA_DIR" "$CCURSOR_EXTENSIONS_DIR"

bridge_health() {
  curl -sk --max-time 3 "https://localhost:${CCURSOR_BRIDGE_PORT}/health" >/dev/null 2>&1 ||
    curl -s --max-time 3 "http://127.0.0.1:${CCURSOR_BRIDGE_PORT}/health" >/dev/null 2>&1
}

proxy_health() {
  curl -sk --max-time 5 \
    --proxy "http://127.0.0.1:${CCURSOR_FORWARD_PROXY_PORT}" \
    "https://api2.cursor.sh/health" >/dev/null 2>&1
}

runtime_ready() {
  bridge_health && proxy_health
}

find_bridge_binary() {
  find "$CCURSOR_EXTENSIONS_DIR" \
    -path "*/bridge/darwin-arm64/agent-vibes-bridge" \
    -type f 2>/dev/null | sort | tail -n 1
}

xml_escape() {
  ruby -rcgi -e 'print CGI.escapeHTML(ARGV.fetch(0))' "$1"
}

write_bridge_launch_agent() {
  local bridge_binary="$1"
  local plist_dir
  plist_dir="$(dirname "$BRIDGE_PLIST_PATH")"
  mkdir -p "$plist_dir" "$CCURSOR_HOME/logs"

  local node_extra_ca=""
  if [[ -f "$CCURSOR_HOME/certs/ca.pem" ]]; then
    node_extra_ca="
        <key>NODE_EXTRA_CA_CERTS</key>
        <string>$(xml_escape "$CCURSOR_HOME/certs/ca.pem")</string>"
  fi

  cat >"$BRIDGE_PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.ccursor.bridge</string>
    <key>ProgramArguments</key>
    <array>
      <string>$(xml_escape "$bridge_binary")</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>$(xml_escape "$CCURSOR_BRIDGE_PORT")</string>
        <key>AGENT_VIBES_DATA_DIR</key>
        <string>$(xml_escape "$CCURSOR_HOME")</string>
        <key>AGENT_VIBES_LOG_DIR</key>
        <string>$(xml_escape "$CCURSOR_HOME/logs")</string>
        <key>AGENT_VIBES_OPENAI_COMPAT_ACCOUNTS_PATH</key>
        <string>$(xml_escape "$CCURSOR_HOME/data/openai-compat-accounts.json")</string>
        <key>CURSOR_PROTOCOL_TRACE_FILE</key>
        <string>$(xml_escape "$CCURSOR_HOME/logs/cursor_protocol_trace.jsonl")</string>
        <key>NO_COLOR</key>
        <string>1</string>
        <key>FORCE_COLOR</key>
        <string>0</string>$node_extra_ca
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$(xml_escape "$BRIDGE_LOG_PATH")</string>
    <key>StandardErrorPath</key>
    <string>$(xml_escape "$BRIDGE_LOG_PATH")</string>
    <key>WorkingDirectory</key>
    <string>$(xml_escape "$CCURSOR_HOME")</string>
  </dict>
</plist>
PLIST
}

start_bridge_service() {
  local bridge_binary="$1"
  write_bridge_launch_agent "$bridge_binary"

  local domain="gui/$(id -u)"
  launchctl bootout "$domain" "$BRIDGE_PLIST_PATH" >/dev/null 2>&1 || true
  if ! launchctl bootstrap "$domain" "$BRIDGE_PLIST_PATH" >/dev/null 2>&1; then
    launchctl unload "$BRIDGE_PLIST_PATH" >/dev/null 2>&1 || true
    launchctl load "$BRIDGE_PLIST_PATH"
  fi
  launchctl kickstart -k "$domain/com.ccursor.bridge" >/dev/null 2>&1 || true
}

ensure_bridge_running() {
  if runtime_ready; then
    echo "CCursor bridge/proxy: already running"
    return
  fi

  local bridge_binary
  bridge_binary="$(find_bridge_binary)"
  if [[ -z "$bridge_binary" || ! -x "$bridge_binary" ]]; then
    echo "WARN: CCursor bridge binary not found in $CCURSOR_EXTENSIONS_DIR"
    echo "WARN: Cursor will still open; rerun Install CCursor.command if the bridge does not start."
    return
  fi

  echo "Starting CCursor bridge before Cursor..."
  start_bridge_service "$bridge_binary"

  local deadline=$((SECONDS + 25))
  while (( SECONDS < deadline )); do
    if runtime_ready; then
      echo "CCursor bridge/proxy: healthy"
      return
    fi
    sleep 1
  done

  echo "WARN: CCursor bridge/proxy did not become healthy within 25 seconds."
  echo "WARN: Continue opening Cursor; run Check CCursor.command if the Agent cannot connect."
}

echo "Refreshing CCursor account from Codex config..."
ruby "$SCRIPT_DIR/lib/sync_codex_openai_compat.rb"

echo
ensure_bridge_running

echo
echo "Opening Cursor through CCursor local proxy..."
open -na "$CURSOR_APP" --args \
  --user-data-dir="$CCURSOR_USER_DATA_DIR" \
  --extensions-dir="$CCURSOR_EXTENSIONS_DIR" \
  --proxy-server="http://127.0.0.1:${CCURSOR_FORWARD_PROXY_PORT}" \
  --ignore-certificate-errors

echo
echo "Cursor CCursor profile is starting. Run 'Check CCursor.command' if needed."
