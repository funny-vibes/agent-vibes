/**
 * SEA (Single Executable Application) entry point.
 *
 * This file wraps the NestJS main.ts with SEA-aware initialization:
 * - Detects SEA mode via node:sea API
 * - Extracts SQL migration assets to disk for PersistenceService
 * - Then starts the normal NestJS bootstrap
 */

// CRITICAL: reflect-metadata MUST be imported FIRST for NestJS DI to work in esbuild bundle
import "reflect-metadata"

const sea = (() => {
  try {
    return require("node:sea")
  } catch {
    return null
  }
})()

if (sea && sea.isSea()) {
  const fs = require("fs")
  const path = require("path")
  const os = require("os")

  // Extract migration SQL files to ~/.agent-vibes/pgdata/migrations/
  const migrationsDir = path.join(
    os.homedir(),
    ".agent-vibes",
    "pgdata",
    "migrations"
  )
  fs.mkdirSync(migrationsDir, { recursive: true })

  for (const key of sea.getAssetKeys()) {
    if (key.endsWith(".sql")) {
      const targetPath = path.join(migrationsDir, key)
      if (!fs.existsSync(targetPath)) {
        const content = sea.getAsset(key, "utf-8")
        fs.writeFileSync(targetPath, content)
        console.log(`[SEA] Extracted migration: ${key}`)
      }
    }
  }

  // Set __dirname to the migrations parent so PersistenceService finds them
  // PersistenceService uses path.join(__dirname, "migrations") from persistence.service.js
  // In SEA mode, __dirname is wrong, so we patch it via env var
  process.env.SEA_MIGRATIONS_DIR = migrationsDir
}

// Boot the NestJS application
require("../src/main")
