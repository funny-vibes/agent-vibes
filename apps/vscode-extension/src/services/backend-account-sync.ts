import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { ConfigManager } from "./config-manager"

type JsonObject = Record<string, unknown>

type WorkspaceClaim = {
  id?: unknown
  is_default?: unknown
}

interface SyncResult {
  destinationPath: string
  summary: string
}

function readJsonFile(filePath: string): JsonObject {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as JsonObject
}

function parseJwtClaims(token: string): JsonObject | null {
  if (!token) return null

  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    return JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf-8")
    ) as JsonObject
  } catch {
    return null
  }
}

function inferTokenExpiry(
  ...tokens: Array<string | undefined>
): string | undefined {
  for (const token of tokens) {
    if (!token) continue
    const claims = parseJwtClaims(token)
    if (claims && typeof claims.exp === "number" && claims.exp > 0) {
      return new Date(claims.exp * 1000).toISOString()
    }
  }

  return undefined
}

function extractDefaultWorkspaceId(claims: JsonObject | null): string {
  if (!claims) return ""

  const authClaims =
    claims["https://api.openai.com/auth"] &&
    typeof claims["https://api.openai.com/auth"] === "object"
      ? (claims["https://api.openai.com/auth"] as JsonObject)
      : null

  const candidates = [authClaims?.organizations, claims.organizations]

  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || candidate.length === 0) continue
    const organizations = candidate as WorkspaceClaim[]

    const defaultOrg = organizations.find(
      (org) => typeof org?.id === "string" && Boolean(org?.is_default)
    )
    if (typeof defaultOrg?.id === "string" && defaultOrg.id.trim()) {
      return defaultOrg.id.trim()
    }

    const firstOrg = organizations.find(
      (org) => typeof org?.id === "string" && org.id.trim()
    )
    if (typeof firstOrg?.id === "string" && firstOrg.id.trim()) {
      return firstOrg.id.trim()
    }
  }

  return ""
}

function loadAccountsFile(destPath: string): { accounts: JsonObject[] } {
  if (!fs.existsSync(destPath)) {
    return { accounts: [] }
  }

  const parsed = readJsonFile(destPath)
  return {
    accounts: Array.isArray(parsed.accounts)
      ? (parsed.accounts as JsonObject[])
      : [],
  }
}

function saveAccountsFile(destPath: string, accounts: JsonObject[]): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.writeFileSync(destPath, JSON.stringify({ accounts }, null, 2), "utf-8")
}

function upsertCodexAccount(destPath: string, account: JsonObject): void {
  const existing = loadAccountsFile(destPath)
  const email = typeof account.email === "string" ? account.email : ""
  const accountId =
    typeof account.accountId === "string" ? account.accountId : ""

  const index = existing.accounts.findIndex((candidate) => {
    return (
      candidate.email === email && (candidate.accountId || "") === accountId
    )
  })

  if (index >= 0) {
    existing.accounts[index] = account
  } else {
    existing.accounts.push(account)
  }

  saveAccountsFile(destPath, existing.accounts)
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }
  return ""
}

function looksLikeClaudeFamilyModel(model: string): boolean {
  return /(claude|sonnet|haiku|opus)/i.test(model)
}

function collectExplicitClaudeModels(
  settings: JsonObject,
  env: JsonObject
): Array<{ name: string }> {
  const configuredModels = [
    settings.model,
    env.ANTHROPIC_MODEL,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  ]

  const uniqueModels: Array<{ name: string }> = []
  const seen = new Set<string>()

  for (const model of configuredModels) {
    if (typeof model !== "string") continue
    const normalized = model.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)

    if (!looksLikeClaudeFamilyModel(normalized)) {
      uniqueModels.push({ name: normalized })
    }
  }

  return uniqueModels
}

function upsertClaudeAccount(destPath: string, account: JsonObject): void {
  const managedLabel = "claude-code-sync"
  const existing = loadAccountsFile(destPath)
  const nextAccounts = existing.accounts.filter(
    (candidate) => candidate.label !== managedLabel
  )
  nextAccounts.push(account)
  saveAccountsFile(destPath, nextAccounts)
}

export async function syncCodexAccount(
  config: ConfigManager
): Promise<SyncResult> {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
  const authPath = path.join(codexHome, "auth.json")

  if (!fs.existsSync(authPath)) {
    throw new Error(`Codex auth.json not found: ${authPath}`)
  }

  const auth = readJsonFile(authPath)

  if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim()) {
    upsertCodexAccount(config.codexAccountsPath, {
      email: "api-key",
      apiKey: auth.OPENAI_API_KEY.trim(),
    })

    return {
      destinationPath: config.codexAccountsPath,
      summary: "Codex API key synced",
    }
  }

  const tokens =
    auth.tokens && typeof auth.tokens === "object"
      ? (auth.tokens as JsonObject)
      : null

  const accessToken = pickString(tokens?.access_token)
  if (!accessToken) {
    throw new Error("No Codex credentials found in auth.json")
  }

  const refreshToken = pickString(tokens?.refresh_token)
  const idToken = pickString(tokens?.id_token)
  const claims = idToken ? parseJwtClaims(idToken) : null
  const authClaims =
    claims &&
    typeof claims["https://api.openai.com/auth"] === "object" &&
    claims["https://api.openai.com/auth"] !== null
      ? (claims["https://api.openai.com/auth"] as JsonObject)
      : null

  const account = {
    email: pickString(claims?.email),
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(idToken ? { idToken } : {}),
    accountId: pickString(authClaims?.chatgpt_account_id, tokens?.account_id),
    workspaceId: extractDefaultWorkspaceId(claims),
    planType: pickString(authClaims?.chatgpt_plan_type),
    expire: inferTokenExpiry(accessToken, idToken),
  }

  Object.keys(account).forEach((key) => {
    const typedKey = key as keyof typeof account
    if (!account[typedKey]) {
      delete account[typedKey]
    }
  })

  upsertCodexAccount(config.codexAccountsPath, account)

  return {
    destinationPath: config.codexAccountsPath,
    summary: `Codex account synced${account.email ? ` for ${account.email}` : ""}`,
  }
}

export async function syncClaudeAccount(
  config: ConfigManager
): Promise<SyncResult> {
  const explicitPath = process.env.CLAUDE_SETTINGS_PATH?.trim()
  const configDir =
    process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude")
  const settingsPath = explicitPath || path.join(configDir, "settings.json")

  if (!fs.existsSync(settingsPath)) {
    throw new Error(`Claude settings not found: ${settingsPath}`)
  }

  const settings = readJsonFile(settingsPath)
  const env =
    settings.env && typeof settings.env === "object"
      ? (settings.env as JsonObject)
      : {}

  const apiKey = pickString(
    env.ANTHROPIC_AUTH_TOKEN,
    env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_AUTH_TOKEN,
    process.env.ANTHROPIC_API_KEY
  )

  if (!apiKey) {
    throw new Error("No Claude API credential found in Claude settings")
  }

  const baseUrl =
    pickString(env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_BASE_URL) ||
    "https://api.anthropic.com"
  const proxyUrl = pickString(
    env.ANTHROPIC_PROXY_URL,
    env.HTTPS_PROXY,
    env.HTTP_PROXY,
    process.env.ANTHROPIC_PROXY_URL,
    process.env.HTTPS_PROXY,
    process.env.HTTP_PROXY
  )
  const models = collectExplicitClaudeModels(settings, env)

  const account: JsonObject = {
    label: "claude-code-sync",
    apiKey,
    baseUrl,
  }

  if (proxyUrl) {
    account.proxyUrl = proxyUrl
  }
  if (models.length > 0) {
    account.models = models
  }

  upsertClaudeAccount(config.claudeApiAccountsPath, account)

  return {
    destinationPath: config.claudeApiAccountsPath,
    summary: "Claude account synced",
  }
}
