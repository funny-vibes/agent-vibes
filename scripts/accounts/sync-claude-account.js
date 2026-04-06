#!/usr/bin/env node

/**
 * Sync Claude Code third-party API settings into agent-vibes.
 *
 * Reads ~/.claude/settings.json (or CLAUDE_SETTINGS_PATH) and writes/updates
 * the configured Claude API accounts JSON file.
 *
 * Usage:
 *   agent-vibes sync --claude
 *   agent-vibes sync --claude --accounts-file /abs/path/claude-api-accounts.json
 *   npm run claude:sync
 */

const fs = require("fs")
const path = require("path")
const os = require("os")
const {
  formatPathForDisplay,
  resolveDefaultAccountConfigPath,
} = require("./lib/account-config-paths")

const PROJECT_ROOT = path.resolve(__dirname, "../..")
const DEST_FILE = resolveDefaultAccountConfigPath(
  PROJECT_ROOT,
  "claude-api-accounts.json",
  process.argv.slice(2)
)

const DEFAULT_BASE_URL = "https://api.anthropic.com"
const MANAGED_LABEL = "claude-code-sync"

function claudeSettingsPath() {
  const explicitPath = process.env.CLAUDE_SETTINGS_PATH?.trim()
  if (explicitPath) {
    return explicitPath
  }

  const configDir =
    process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude")
  return path.join(configDir, "settings.json")
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"))
  } catch (error) {
    console.error(
      `❌ Failed to parse ${label}: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exit(1)
  }
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }
  return ""
}

function normalizeBaseUrl(baseUrl) {
  return pickString(baseUrl) || DEFAULT_BASE_URL
}

function looksLikeClaudeFamilyModel(model) {
  return /(claude|sonnet|haiku|opus)/i.test(model)
}

function collectExplicitModels(settings, env) {
  const configuredModels = [
    settings.model,
    env.ANTHROPIC_MODEL,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  ]

  const uniqueModels = []
  const seen = new Set()

  for (const model of configuredModels) {
    if (typeof model !== "string") {
      continue
    }

    const normalized = model.trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)

    if (!looksLikeClaudeFamilyModel(normalized)) {
      uniqueModels.push({ name: normalized })
    }
  }

  return uniqueModels
}

function readClaudeSettings() {
  const settingsPath = claudeSettingsPath()

  if (!fs.existsSync(settingsPath)) {
    console.error("❌ Claude Code settings not found")
    console.error(`   Expected at: ${settingsPath}`)
    console.error("")
    console.error("   Make sure Claude Code CLI is installed and configured.")
    process.exit(1)
  }

  const settings = readJsonFile(settingsPath, settingsPath)
  const env =
    settings && typeof settings.env === "object" && settings.env !== null
      ? settings.env
      : {}

  const apiKey = pickString(
    env.ANTHROPIC_AUTH_TOKEN,
    env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_AUTH_TOKEN,
    process.env.ANTHROPIC_API_KEY
  )

  if (!apiKey) {
    console.error("❌ No Claude API credential found in Claude Code settings")
    console.error(
      "   Expected env.ANTHROPIC_AUTH_TOKEN or env.ANTHROPIC_API_KEY in settings.json"
    )
    process.exit(1)
  }

  return {
    settingsPath,
    account: {
      label: MANAGED_LABEL,
      apiKey,
      baseUrl: normalizeBaseUrl(
        pickString(env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_BASE_URL)
      ),
      proxyUrl: pickString(
        env.ANTHROPIC_PROXY_URL,
        env.HTTPS_PROXY,
        env.HTTP_PROXY,
        process.env.ANTHROPIC_PROXY_URL,
        process.env.HTTPS_PROXY,
        process.env.HTTP_PROXY
      ),
      models: collectExplicitModels(settings, env),
    },
  }
}

function loadExistingAccountsFile(destPath) {
  if (!fs.existsSync(destPath)) {
    return { accounts: [] }
  }

  const existing = readJsonFile(destPath, destPath)
  if (!existing || typeof existing !== "object") {
    console.error(`❌ ${destPath} does not contain a JSON object`)
    process.exit(1)
  }

  if (!Array.isArray(existing.accounts)) {
    existing.accounts = []
  }

  return existing
}

function normalizeModelEntry(model) {
  if (!model || typeof model !== "object") {
    return null
  }

  const name = typeof model.name === "string" ? model.name.trim() : ""
  const alias = typeof model.alias === "string" ? model.alias.trim() : ""

  if (!name) {
    return null
  }

  return alias ? { name, alias } : { name }
}

const CURSOR_CLAUDE_THINKING_MODEL_IDS = new Set([
  "claude-4.6-opus",
  "claude-opus-4-6-thinking",
  "claude-4.6-opus-thinking",
  "claude-4.5-opus-high-thinking",
  "claude-sonnet-4-5-thinking",
])

function modelIdRequiresExplicitThinkingSupport(modelId) {
  const normalized =
    typeof modelId === "string" ? modelId.trim().toLowerCase() : ""

  if (!normalized) {
    return false
  }

  return (
    normalized.includes("thinking") ||
    CURSOR_CLAUDE_THINKING_MODEL_IDS.has(normalized)
  )
}

function sanitizeModelEntriesForAccount(models, account) {
  if (!Array.isArray(models) || account?.stripThinking !== true) {
    return models
  }

  return models.filter((model) => {
    const publicModelId =
      typeof model?.alias === "string" && model.alias.trim()
        ? model.alias
        : model?.name
    return !modelIdRequiresExplicitThinkingSupport(publicModelId)
  })
}

function writeAccountsFile(destPath, managedAccount) {
  const existing = loadExistingAccountsFile(destPath)
  const previousManaged = existing.accounts.find(
    (account) => account?.label === MANAGED_LABEL
  )
  const nextAccounts = existing.accounts.filter(
    (account) => account?.label !== MANAGED_LABEL
  )

  const outputAccount = {
    ...(previousManaged &&
    typeof previousManaged === "object" &&
    !Array.isArray(previousManaged)
      ? previousManaged
      : {}),
    label: managedAccount.label,
    apiKey: managedAccount.apiKey,
    baseUrl: managedAccount.baseUrl,
  }

  if (managedAccount.proxyUrl) {
    outputAccount.proxyUrl = managedAccount.proxyUrl
  } else {
    delete outputAccount.proxyUrl
  }
  const sanitizedModels = sanitizeModelEntriesForAccount(
    managedAccount.models,
    outputAccount
  )
  if (sanitizedModels.length > 0) {
    outputAccount.models = sanitizedModels
  } else {
    delete outputAccount.models
  }

  nextAccounts.push(outputAccount)
  existing.accounts = nextAccounts

  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.writeFileSync(destPath, JSON.stringify(existing, null, 2), "utf-8")
}

console.log("🔄 Syncing Claude Code settings...\n")

const { settingsPath, account } = readClaudeSettings()
writeAccountsFile(DEST_FILE, account)

console.log(`✅ Source: ${settingsPath}`)
console.log(`   Base URL: ${account.baseUrl}`)
console.log(
  `   Credential: ${account.apiKey.slice(0, 8)}... (${account.baseUrl === DEFAULT_BASE_URL ? "official" : "third-party"})`
)
if (account.proxyUrl) {
  console.log(`   Proxy: ${account.proxyUrl}`)
}
if (account.models.length > 0) {
  console.log(
    `   Explicit model IDs: ${account.models.map((model) => model.name).join(", ")}`
  )
} else {
  console.log(
    "   Explicit model IDs: none (dynamic discovery + Claude-family passthrough enabled)"
  )
}
console.log(
  `\n✅ Credentials written to ${formatPathForDisplay(PROJECT_ROOT, DEST_FILE)}`
)
console.log("   Restart the proxy to apply changes.")
console.log("   To deploy to remote, run: npm run deploy:sync")
