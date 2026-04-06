#!/usr/bin/env node

/**
 * Sync accounts from Antigravity sources into agent-vibes.
 *
 * Usage:
 *   npm run antigravity:sync -- --ide       Extract from Antigravity IDE (state.vscdb)
 *   npm run antigravity:sync -- --tools     Extract from Antigravity Tools (~/.antigravity_tools)
 *   npm run antigravity:sync -- --ide --accounts-file /abs/path/antigravity-accounts.json
 */

const Database = require("better-sqlite3")
const fs = require("fs")
const path = require("path")
const os = require("os")
const platform = require("../lib/platform")
const {
  formatPathForDisplay,
  resolveDefaultAccountConfigPath,
} = require("./lib/account-config-paths")

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const mode = args.find((a) => a === "--ide" || a === "--tools")

if (!mode) {
  console.log("Usage: npm run antigravity:sync -- <source>\n")
  console.log("Sources:")
  console.log("  --ide     Extract from Antigravity IDE (reads state.vscdb)")
  console.log(
    "  --tools   Extract from Antigravity Tools (~/.antigravity_tools)"
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Output path — default unified runtime path, override with --accounts-file
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, "../..")
const DEST_FILE = resolveDefaultAccountConfigPath(
  PROJECT_ROOT,
  "antigravity-accounts.json",
  args
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expand(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p
}

function extractEnterpriseGcpProjectId(encodedValue) {
  if (!encodedValue || !encodedValue.trim()) return undefined

  try {
    const decoded = Buffer.from(encodedValue.trim(), "base64").toString("utf8")
    if (!decoded.includes("enterpriseGcpProjectId")) {
      return undefined
    }

    const candidates = [
      decoded,
      ...(decoded.match(/[A-Za-z0-9+/=]{4,}/g) || []).map((value) => {
        try {
          return Buffer.from(value, "base64").toString("utf8")
        } catch {
          return ""
        }
      }),
    ]

    for (const candidate of candidates) {
      const matches = candidate.match(/\b[a-z][a-z0-9-]{4,}\b/g) || []
      for (const match of matches) {
        if (match !== "enterpriseGcpProjectId") {
          return match
        }
      }
    }
  } catch {
    return undefined
  }

  return undefined
}

// ---------------------------------------------------------------------------
// --ide: Antigravity IDE (state.vscdb)
// ---------------------------------------------------------------------------

function fromIDE() {
  const DB = path.join(platform.ideDataDir(), "state.vscdb")

  if (!fs.existsSync(DB)) {
    console.error("❌ Antigravity IDE not found (state.vscdb missing)")
    console.error(`   Expected at: ${DB}`)
    process.exit(1)
  }

  const db = new Database(DB, { readonly: true, fileMustExist: true })
  let authRaw = ""
  let oauthB64 = ""
  let enterprisePreferencesB64 = ""

  try {
    const authRow = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("antigravityAuthStatus")
    authRaw =
      authRow && typeof authRow.value === "string" ? authRow.value.trim() : ""

    const oauthRow = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("antigravityUnifiedStateSync.oauthToken")
    oauthB64 =
      oauthRow && typeof oauthRow.value === "string"
        ? oauthRow.value.trim()
        : ""

    const enterprisePreferencesRow = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("antigravityUnifiedStateSync.enterprisePreferences")
    enterprisePreferencesB64 =
      enterprisePreferencesRow &&
      typeof enterprisePreferencesRow.value === "string"
        ? enterprisePreferencesRow.value.trim()
        : ""
  } finally {
    db.close()
  }

  if (!authRaw) {
    console.error("❌ Not logged in — no antigravityAuthStatus found")
    process.exit(1)
  }

  const auth = JSON.parse(authRaw)
  if (!auth.email) {
    console.error("❌ No email in antigravityAuthStatus")
    process.exit(1)
  }

  if (!oauthB64) {
    console.error("❌ No OAuth token found in state.vscdb")
    process.exit(1)
  }

  const buf = Buffer.from(oauthB64, "base64")
  const text = buf.toString("utf-8")

  // Protobuf contains nested base64 blocks with the actual tokens
  const blocks = text.match(/[A-Za-z0-9+/=]{50,}/g) || []
  let accessToken = null
  let refreshToken = null

  for (const b of blocks) {
    try {
      const decoded = Buffer.from(b, "base64").toString("utf-8")
      if (!accessToken) {
        const m = decoded.match(/(ya29\.[A-Za-z0-9_\-/+=]+)/)
        if (m) accessToken = m[1]
      }
      if (!refreshToken) {
        const m = decoded.match(/(1\/\/[A-Za-z0-9_\-/+=]+)/)
        if (m) refreshToken = m[1]
      }
    } catch (_) {
      // not valid base64, skip
    }
  }

  if (!accessToken || !refreshToken) {
    console.error("❌ Could not extract tokens from OAuth protobuf")
    process.exit(1)
  }

  const quotaProjectId = extractEnterpriseGcpProjectId(enterprisePreferencesB64)

  console.log(`✅ ${auth.name} <${auth.email}>`)
  console.log(`   Access Token: ${accessToken.substring(0, 25)}...`)
  console.log(`   Refresh Token: ${refreshToken.substring(0, 15)}...`)
  if (quotaProjectId) {
    console.log(`   Quota Project: ${quotaProjectId}`)
  }

  return [
    {
      email: auth.email,
      accessToken,
      refreshToken,
      quotaProjectId,
      isGcpTos: false,
    },
  ]
}

// ---------------------------------------------------------------------------
// --tools: Antigravity Tools (~/.antigravity_tools)
// ---------------------------------------------------------------------------

function fromTools() {
  const SOURCE = expand("~/.antigravity_tools")
  const indexPath = path.join(SOURCE, "accounts.json")
  const accountsDir = path.join(SOURCE, "accounts")

  if (!fs.existsSync(indexPath)) {
    console.error(`❌ Antigravity Tools not found (${indexPath} missing)`)
    process.exit(1)
  }

  const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"))
  if (!Array.isArray(index.accounts) || index.accounts.length === 0) {
    console.error("❌ No accounts in Antigravity Tools")
    process.exit(1)
  }

  const loaded = []

  for (const entry of index.accounts) {
    const accountPath = path.join(accountsDir, `${entry.id}.json`)
    if (!fs.existsSync(accountPath)) {
      console.warn(`   Skip: file not found for ${entry.email}`)
      continue
    }

    try {
      const file = JSON.parse(fs.readFileSync(accountPath, "utf-8"))
      const token = file.token
      if (!token?.access_token || !token?.refresh_token) {
        console.warn(`   Skip: ${entry.email} missing token`)
        continue
      }

      const expiresAt = token.expiry_timestamp
        ? new Date(token.expiry_timestamp * 1000).toISOString()
        : undefined

      loaded.push({
        email: file.email,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt,
        quotaProjectId: token.project_id,
      })

      console.log(`✅ ${file.email}`)
    } catch (err) {
      console.warn(`   Skip: ${entry.email} - ${err.message}`)
    }
  }

  if (loaded.length === 0) {
    console.error("❌ No valid accounts could be loaded")
    process.exit(1)
  }

  return loaded
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`🔄 Syncing accounts (source: ${mode.slice(2)})...\n`)

const accounts = mode === "--ide" ? fromIDE() : fromTools()

fs.mkdirSync(path.dirname(DEST_FILE), { recursive: true })
fs.writeFileSync(DEST_FILE, JSON.stringify({ accounts }, null, 2), "utf-8")

console.log(
  `\n✅ Synced ${accounts.length} account(s) to ${formatPathForDisplay(PROJECT_ROOT, DEST_FILE)}`
)
