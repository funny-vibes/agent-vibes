#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CCURSOR_USER_DATA_DIR="${CCURSOR_USER_DATA_DIR:-$HOME/.cursor-ccursor-profile}"
CCURSOR_EXTENSIONS_DIR="${CCURSOR_EXTENSIONS_DIR:-$CCURSOR_USER_DATA_DIR/extensions}"
OFFICIAL_USER_DATA_DIR="${CURSOR_OFFICIAL_USER_DATA_DIR:-$HOME/.cursor-official-profile}"
OFFICIAL_EXTENSIONS_DIR="${CURSOR_OFFICIAL_EXTENSIONS_DIR:-$OFFICIAL_USER_DATA_DIR/extensions}"

echo "Checking Codex config..."
ruby "$SCRIPT_DIR/lib/sync_codex_openai_compat.rb" --check-only

echo
echo "Checking CCursor account file..."
ruby -rjson -e '
ccursor_home = ENV.fetch("CCURSOR_HOME", File.join(Dir.home, ".ccursor"))
path = ENV.fetch("CCURSOR_OPENAI_COMPAT_ACCOUNTS_PATH", File.join(ccursor_home, "data", "openai-compat-accounts.json"))
abort("ERROR: #{path} not found") unless File.exist?(path)
data = JSON.parse(File.read(path))
accounts = data["accounts"].is_a?(Array) ? data["accounts"] : []
managed = accounts.select { |item| item.is_a?(Hash) && item["managedBy"] == "ccursor-colleague-kit" }
abort("ERROR: no ccursor-colleague-kit account found in #{path}") if managed.empty?
managed.each do |item|
  puts "Account: #{item["label"]} #{item["baseUrl"]} responses=#{item["preferResponsesApi"]}"
end
'

echo
echo "Checking installed Cursor extension..."
if command -v cursor >/dev/null 2>&1; then
  extensions="$(cursor --list-extensions)"
  if grep -Fxq "local-ai.ccursor" <<<"$extensions"; then
    echo "Extension: local-ai.ccursor installed"
  else
    echo "WARN: local-ai.ccursor not listed by Cursor CLI"
  fi
else
  echo "WARN: cursor CLI not in PATH; extension list skipped"
fi

if command -v cursor >/dev/null 2>&1; then
  profile_extensions="$(cursor \
    --user-data-dir "$CCURSOR_USER_DATA_DIR" \
    --extensions-dir "$CCURSOR_EXTENSIONS_DIR" \
    --list-extensions 2>/dev/null || true)"
  if grep -Fxq "local-ai.ccursor" <<<"$profile_extensions"; then
    echo "Extension: local-ai.ccursor installed in CCursor profile"
  else
    echo "WARN: local-ai.ccursor not listed in CCursor profile. Rerun Install CCursor.command."
  fi
fi

echo
echo "Checking Cursor launch profiles..."
echo "Official profile data: $OFFICIAL_USER_DATA_DIR"
echo "Official profile extensions: $OFFICIAL_EXTENSIONS_DIR"
echo "CCursor profile data: $CCURSOR_USER_DATA_DIR"
echo "CCursor profile extensions: $CCURSOR_EXTENSIONS_DIR"

echo
echo "Checking CCursor bridge..."
if curl -sk --max-time 5 https://localhost:2026/pool/status >/tmp/ccursor-pool-status.json; then
  ruby -rjson -e '
data = JSON.parse(File.read("/tmp/ccursor-pool-status.json"))
pool = data.dig("backends", "openaiCompat") || data["openaiCompat"] || {}
puts "Bridge: running"
puts "OpenAI-compatible: configured=#{pool["configured"]} total=#{pool["total"]} ready=#{pool["ready"]} available=#{pool["available"]}"
'
else
  echo "WARN: bridge is not reachable yet. Open Cursor with the provided launcher and wait 10-20 seconds."
fi

echo
echo "Checking Cursor proxy path..."
if curl -sk --max-time 8 --proxy http://127.0.0.1:18080 https://api2.cursor.sh/health >/tmp/ccursor-proxy-health.txt 2>/tmp/ccursor-proxy-health.err; then
  echo "Proxy: reachable"
  head -c 300 /tmp/ccursor-proxy-health.txt
  echo
else
  echo "WARN: proxy health check failed. This is expected if Cursor/CCursor bridge is not running."
fi
