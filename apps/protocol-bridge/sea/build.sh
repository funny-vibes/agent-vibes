#!/bin/bash
# Build Protocol Bridge as a Single Executable Application (SEA)
#
# Prerequisites:
#   - Node.js 24+ (with node:sqlite built-in)
#   - npm dependencies installed
#
# Output: dist/agent-vibes-bridge (single binary, ~80MB)
#
# Usage:
#   ./sea/build.sh          # Build for current platform
#   ./sea/build.sh --clean  # Clean and rebuild

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_DIR/dist"
GENERATED_SEA_CONFIG="$DIST_DIR/sea-config.generated.json"
SOURCE_MIGRATIONS_DIR="$PROJECT_DIR/src/persistence/migrations"
DIST_MIGRATIONS_DIR="$DIST_DIR/persistence/migrations"

# Output binary name
RAW_PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
RAW_ARCH=$(uname -m)

case "$RAW_PLATFORM" in
  mingw*|msys*|cygwin*) PLATFORM="win32" ;;
  *) PLATFORM="$RAW_PLATFORM" ;;
esac

case "$RAW_ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64) ARCH="arm64" ;;
  *) ARCH="$RAW_ARCH" ;;
esac

BINARY_NAME="agent-vibes-bridge-${PLATFORM}-${ARCH}"

sync_migration_assets() {
  if [[ ! -d "$SOURCE_MIGRATIONS_DIR" ]]; then
    echo "Missing source migrations directory: $SOURCE_MIGRATIONS_DIR" >&2
    exit 1
  fi

  mkdir -p "$DIST_MIGRATIONS_DIR"
  find "$DIST_MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' -delete
  find "$SOURCE_MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' -exec cp {} "$DIST_MIGRATIONS_DIR/" \;

  local migration_count
  migration_count=$(find "$DIST_MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')
  if [[ "$migration_count" == "0" ]]; then
    echo "No SQL migrations were copied into $DIST_MIGRATIONS_DIR" >&2
    exit 1
  fi

  echo "  ✓ Synced ${migration_count} migration(s) to dist/persistence/migrations"
}

echo "🔨 Building Protocol Bridge SEA binary"
echo "   Platform: ${PLATFORM}-${ARCH}"
echo "   Node.js:  $(node --version)"
echo ""

# ── Step 0: Clean (optional) ─────────────────────────────────────────
if [[ "${1:-}" == "--clean" ]]; then
  echo "▸ Cleaning dist/..."
  rm -rf "$DIST_DIR"
fi

# ── Step 1: esbuild bundle ───────────────────────────────────────────
echo "▸ Step 1/4: Bundling with esbuild..."
node "$PROJECT_DIR/sea/esbuild.js"

echo "  ✓ Bundle complete: dist/sea-entry.js"

# ── Step 1.5: Sync migration assets and generate SEA config ──────────
echo "▸ Step 1.5/4: Syncing migration assets..."
sync_migration_assets
echo "▸ Step 1.6/4: Generating SEA config from dist migrations..."
node "$PROJECT_DIR/sea/generate-config.mjs"
echo "  ✓ SEA config ready: $GENERATED_SEA_CONFIG"

# ── Step 2: Generate SEA blob ─────────────────────────────────────────
echo "▸ Step 2/4: Generating SEA preparation blob..."
node --experimental-sea-config "$GENERATED_SEA_CONFIG"
echo "  ✓ SEA blob generated: $DIST_DIR/sea-prep.blob"

# ── Step 3: Copy Node binary ─────────────────────────────────────────
echo "▸ Step 3/4: Creating binary from Node.js..."
NODE_BIN=$(which node)
cp "$NODE_BIN" "$DIST_DIR/$BINARY_NAME"

# Remove code signature on macOS (required before injecting)
if [[ "$PLATFORM" == "darwin" ]]; then
  codesign --remove-signature "$DIST_DIR/$BINARY_NAME" 2>/dev/null || true
fi

echo "  ✓ Binary copied: $DIST_DIR/$BINARY_NAME"

# ── Step 4: Inject SEA blob ──────────────────────────────────────────
echo "▸ Step 4/4: Injecting SEA blob into binary..."
POSTJECT_ARGS=(
  "$DIST_DIR/$BINARY_NAME" NODE_SEA_BLOB "$DIST_DIR/sea-prep.blob"
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
)

# macOS requires --macho-segment-name for code signing to work
if [[ "$PLATFORM" == "darwin" ]]; then
  POSTJECT_ARGS+=(--macho-segment-name NODE_SEA)
fi

npx -y postject "${POSTJECT_ARGS[@]}"

# Re-sign on macOS (ad-hoc)
if [[ "$PLATFORM" == "darwin" ]]; then
  codesign --sign - "$DIST_DIR/$BINARY_NAME" 2>/dev/null || true
fi

echo "  ✓ SEA blob injected"

# ── Done ──────────────────────────────────────────────────────────────
BINARY_SIZE=$(du -sh "$DIST_DIR/$BINARY_NAME" | cut -f1)
echo ""
echo "✅ SEA binary ready: $DIST_DIR/$BINARY_NAME (${BINARY_SIZE})"
echo "   Run with: ./$DIST_DIR/$BINARY_NAME"
