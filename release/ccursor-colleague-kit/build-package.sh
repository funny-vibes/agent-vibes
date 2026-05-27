#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KIT_DIR="$ROOT_DIR/release/ccursor-colleague-kit"
VERSION="$(ruby -rjson -e 'puts JSON.parse(File.read(ARGV[0]))["version"]' "$ROOT_DIR/apps/vscode-extension/package.json")"
VSIX="$ROOT_DIR/apps/vscode-extension/ccursor-${VERSION}.vsix"
DIST_DIR="$KIT_DIR/dist"
PACKAGE_DIR="$DIST_DIR/CCursor-Colleague-Kit-${VERSION}"
ZIP_PATH="$DIST_DIR/CCursor-Colleague-Kit-${VERSION}.zip"

if [[ ! -f "$VSIX" ]]; then
  echo "ERROR: VSIX not found: $VSIX"
  echo "Run: npm --workspace apps/vscode-extension run package"
  exit 1
fi

VSIX_FILES="$(unzip -Z1 "$VSIX")"

if ! grep -Fxq "extension/bridge/darwin-arm64/agent-vibes-bridge" <<<"$VSIX_FILES"; then
  echo "ERROR: VSIX is missing the macOS arm64 bridge"
  echo "Run: release/ccursor-colleague-kit/build-universal-package.sh"
  exit 1
fi

if ! grep -Fxq "extension/bridge/win32-x64/agent-vibes-bridge.exe" <<<"$VSIX_FILES"; then
  echo "ERROR: VSIX is missing the Windows x64 bridge"
  echo "Run: release/ccursor-colleague-kit/build-universal-package.sh"
  exit 1
fi

rm -rf "$PACKAGE_DIR" "$ZIP_PATH"
mkdir -p "$PACKAGE_DIR"

cp "$VSIX" "$PACKAGE_DIR/"
cp "$KIT_DIR/Install CCursor.command" "$PACKAGE_DIR/"
cp "$KIT_DIR/Open Cursor with CCursor.command" "$PACKAGE_DIR/"
cp "$KIT_DIR/Check CCursor.command" "$PACKAGE_DIR/"
cp "$KIT_DIR/Install CCursor.ps1" "$PACKAGE_DIR/"
cp "$KIT_DIR/Open Cursor with CCursor.ps1" "$PACKAGE_DIR/"
cp "$KIT_DIR/Check CCursor.ps1" "$PACKAGE_DIR/"
cp "$KIT_DIR/README.md" "$PACKAGE_DIR/"
mkdir -p "$PACKAGE_DIR/lib"
cp "$KIT_DIR/lib/sync_codex_openai_compat.rb" "$PACKAGE_DIR/lib/"
cp "$KIT_DIR/lib/Sync-CodexOpenAICompat.ps1" "$PACKAGE_DIR/lib/"

chmod +x "$PACKAGE_DIR/Install CCursor.command" \
  "$PACKAGE_DIR/Open Cursor with CCursor.command" \
  "$PACKAGE_DIR/Check CCursor.command" \
  "$PACKAGE_DIR/lib/sync_codex_openai_compat.rb"

(cd "$DIST_DIR" && zip -qr "$(basename "$ZIP_PATH")" "$(basename "$PACKAGE_DIR")")

echo "$ZIP_PATH"
