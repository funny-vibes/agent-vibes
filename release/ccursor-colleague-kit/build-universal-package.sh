#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$ROOT_DIR"

echo "Building macOS bridge..."
npm --workspace apps/vscode-extension run build:bridge

echo "Building Windows x64 bridge..."
node apps/protocol-bridge/sea/build-windows-x64-from-macos.mjs

echo "Syncing available bridge assets into the extension..."
node apps/vscode-extension/scripts/sync-bridge-assets.mjs

echo "Packaging VSIX with macOS arm64 and Windows x64 bridges..."
npm --workspace apps/vscode-extension run package:fast

echo "Building colleague kit zip..."
release/ccursor-colleague-kit/build-package.sh
