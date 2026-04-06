#!/usr/bin/env node

/**
 * Sync Codex CLI credentials into agent-vibes.
 *
 * Reads ~/.codex/auth.json (created by `codex --login`) and writes
 * the account entry into the configured Codex accounts JSON file.
 *
 * Usage:
 *   agent-vibes sync --codex
 *   agent-vibes sync --codex --accounts-file /abs/path/codex-accounts.json
 *   npm run codex:sync
 */

const fs = require("fs")
const path = require("path")
const os = require("os")
const {
  formatPathForDisplay,
  resolveDefaultAccountConfigPath,
} = require("./lib/account-config-paths")

const args = process.argv.slice(2)

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, "../..")
const DEST_FILE = resolveDefaultAccountConfigPath(
  PROJECT_ROOT,
  "codex-accounts.json",
  args
)

/** Codex CLI credential file — respects CODEX_HOME env var */
function codexAuthPath() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
  return path.join(codexHome, "auth.json")
}

function parseJwtClaims(token) {
  if (!token) return null

  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"))
  } catch {
    return null
  }
}

function inferTokenExpiry(...tokens) {
  for (const token of tokens) {
    const claims = parseJwtClaims(token)
    if (claims && typeof claims.exp === "number" && claims.exp > 0) {
      return new Date(claims.exp * 1000).toISOString()
    }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Read Codex auth.json
// ---------------------------------------------------------------------------

function readCodexAuth() {
  const authFile = codexAuthPath()

  if (!fs.existsSync(authFile)) {
    console.error("❌ Codex CLI not logged in (auth.json not found)")
    console.error(`   Expected at: ${authFile}`)
    console.error("")
    console.error("   Run `codex --login` first to authenticate with OpenAI.")
    process.exit(1)
  }

  const raw = fs.readFileSync(authFile, "utf-8")
  let auth

  try {
    auth = JSON.parse(raw)
  } catch (e) {
    console.error(`❌ Failed to parse ${authFile}: ${e.message}`)
    process.exit(1)
  }

  // API key mode
  if (auth.OPENAI_API_KEY) {
    return {
      mode: "api_key",
      apiKey: auth.OPENAI_API_KEY,
    }
  }

  // OAuth mode (from `codex --login` with ChatGPT account)
  const tokens = auth.tokens
  if (!tokens || !tokens.access_token) {
    console.error("❌ No credentials found in auth.json")
    console.error("   Neither OPENAI_API_KEY nor OAuth tokens are present.")
    console.error("")
    console.error("   Run `codex --login` to authenticate.")
    process.exit(1)
  }

  // Extract email and plan from id_token JWT (best-effort)
  let email = ""
  let planType = ""
  let accountId = ""
  let idToken = tokens.id_token || ""
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    if (claims) {
      email = claims.email || ""
      planType = claims["https://api.openai.com/auth"]?.chatgpt_plan_type || ""
      accountId =
        claims["https://api.openai.com/auth"]?.chatgpt_account_id || ""
    }
  }

  // Use tokens.account_id as fallback
  if (!accountId && tokens.account_id) {
    accountId = tokens.account_id
  }

  return {
    mode: "oauth",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || "",
    idToken,
    accountId,
    email,
    planType,
    expire: inferTokenExpiry(tokens.access_token, tokens.id_token),
  }
}

// ---------------------------------------------------------------------------
// Write to data/codex-accounts.json
// ---------------------------------------------------------------------------

function writeAccountsFile(destPath, account) {
  // Load existing accounts (if any) to preserve other entries
  let existing = { accounts: [] }
  if (fs.existsSync(destPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(destPath, "utf-8"))
      if (!Array.isArray(existing.accounts)) {
        existing.accounts = []
      }
    } catch {
      existing = { accounts: [] }
    }
  }

  // Upsert: replace by email + accountId combo (supports multiple teams per email)
  const idx = existing.accounts.findIndex(
    (a) =>
      a.email === account.email &&
      (a.accountId || "") === (account.accountId || "")
  )
  if (idx >= 0) {
    existing.accounts[idx] = account
  } else {
    existing.accounts.push(account)
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.writeFileSync(destPath, JSON.stringify(existing, null, 2), "utf-8")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("🔄 Syncing Codex CLI credentials...\n")

const auth = readCodexAuth()

if (auth.mode === "api_key") {
  console.log("✅ Found API key in Codex CLI config")
  console.log(`   API Key: ${auth.apiKey.substring(0, 10)}...`)

  const account = {
    email: "api-key",
    apiKey: auth.apiKey,
  }

  writeAccountsFile(DEST_FILE, account)
} else {
  // OAuth mode
  const label = auth.email ? `${auth.email}` : "OAuth account"
  console.log(`✅ ${label}`)
  console.log(`   Access Token: ${auth.accessToken.substring(0, 30)}...`)
  if (auth.refreshToken) {
    console.log(`   Refresh Token: ${auth.refreshToken.substring(0, 15)}...`)
  }
  if (auth.accountId) {
    console.log(`   Account ID: ${auth.accountId}`)
  }
  if (auth.planType) {
    console.log(`   Plan Type: ${auth.planType}`)
  }

  const account = {
    email: auth.email,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken || undefined,
    idToken: auth.idToken || undefined,
    accountId: auth.accountId || undefined,
    planType: auth.planType || undefined,
    expire: auth.expire || undefined,
  }

  // Remove undefined keys for clean JSON
  Object.keys(account).forEach(
    (k) => account[k] === undefined && delete account[k]
  )

  writeAccountsFile(DEST_FILE, account)
}

console.log(
  `\n✅ Credentials written to ${formatPathForDisplay(PROJECT_ROOT, DEST_FILE)}`
)
console.log("   Restart the proxy to apply changes.")
console.log("   To deploy to remote, run: npm run deploy:sync")
