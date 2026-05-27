#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
  cursor --list-extensions | grep -q '^local-ai.ccursor$' && echo "Extension: local-ai.ccursor installed" || echo "WARN: local-ai.ccursor not listed by Cursor CLI"
else
  echo "WARN: cursor CLI not in PATH; extension list skipped"
fi

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
