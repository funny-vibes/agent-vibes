#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_PATH="${CCURSOR_APP_PATH:-$SCRIPT_DIR/CCursor.app}"
MACOS_DIR="$APP_PATH/Contents/MacOS"
RESOURCES_DIR="$APP_PATH/Contents/Resources"
VERSION="$(basename "$(find "$SCRIPT_DIR" -maxdepth 1 -name "ccursor-*.vsix" | sort | tail -n 1)" | sed -E 's/^ccursor-([0-9.]+)\\.vsix$/\\1/')"
if [[ -z "$VERSION" || "$VERSION" == ccursor-* ]]; then
  VERSION="0.1.25"
fi

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cat >"$APP_PATH/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleExecutable</key>
    <string>CCursor</string>
    <key>CFBundleIdentifier</key>
    <string>com.local-ai.ccursor.launcher</string>
    <key>CFBundleName</key>
    <string>CCursor</string>
    <key>CFBundleDisplayName</key>
    <string>CCursor</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
  </dict>
</plist>
PLIST

cat >"$MACOS_DIR/CCursor" <<SH
#!/usr/bin/env bash
set -euo pipefail

LAUNCHER_PATH="$SCRIPT_DIR/Open Cursor with CCursor.command"
if [[ ! -x "\$LAUNCHER_PATH" ]]; then
  APP_PARENT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")/../../.." && pwd)"
  LAUNCHER_PATH="\$APP_PARENT_DIR/Open Cursor with CCursor.command"
fi

exec "\$LAUNCHER_PATH" "\$@"
SH

chmod +x "$MACOS_DIR/CCursor"

echo "Created: $APP_PATH"
echo "Open this app for the AI gateway Cursor window."
