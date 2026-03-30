/**
 * CodexService — Core executor for Codex (OpenAI Responses API) reverse proxy.
 *
 * Handles:
 * - Claude → Codex request translation
 * - HTTP POST to Codex upstream (SSE streaming)
 * - WebSocket transport (with automatic fallback to HTTP)
 * - Codex SSE → Claude SSE response translation
 * - Non-streaming mode
 * - Proxy support (HTTP/HTTPS/SOCKS5)
 * - Request header emulation (codex_cli_rs client)
 * - OAuth token management with auto-refresh
 * - Prompt caching via Conversation_id/Session_id headers
 * - Retry-after handling for rate limits
 *
 * Ported from CLIProxyAPI:
 *   - internal/runtime/executor/codex_executor.go
 *   - internal/runtime/executor/codex_websockets_executor.go
 *   - internal/translator/codex/claude/
 */

import { HttpException, Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"
import type { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"
import type { AnthropicResponse } from "../../shared/anthropic"
import {
  getAccountConfigPathCandidates,
  resolveDefaultAccountConfigPath,
} from "../../shared/protocol-bridge-paths"
import { CodexModelTier, normalizeCodexModelTier } from "../model-registry"
import {
  type CooldownableAccount,
  isAccountDisabled,
  markAccountCooldown,
  markAccountSuccess,
  pickAvailableAccount,
  getEarliestRecovery,
} from "../shared/account-cooldown"
import {
  BackendPoolEntryState,
  BackendPoolStatus,
} from "../shared/backend-pool-status"
import { CodexAuthService, type CodexTokenData } from "./codex-auth.service"
import { CodexCacheService } from "./codex-cache.service"
import { translateClaudeToCodex } from "./codex-request-translator"
import {
  createStreamState,
  translateCodexSseEvent,
  translateCodexToClaudeNonStream,
} from "./codex-response-translator"
import { buildReverseMapFromClaudeTools } from "./tool-name-shortener"
import {
  CodexWebSocketService,
  CodexWebSocketUpgradeError,
} from "./codex-websocket.service"

// ── Constants (matching codex_cli_rs) ──────────────────────────────────

const CODEX_CLIENT_VERSION = "0.101.0"
const CODEX_USER_AGENT =
  "codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464"
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex"
const CODEX_ACCOUNTS_CONFIG_PATHS = getAccountConfigPathCandidates(
  "codex-accounts.json"
)
const CODEX_ACCOUNTS_DEFAULT_PATH = resolveDefaultAccountConfigPath(
  "codex-accounts.json"
)
const CODEX_MODEL_TIER_ORDER: CodexModelTier[] = ["free", "plus", "team", "pro"]

export class CodexApiError extends HttpException {
  constructor(
    statusCode: number,
    message: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(
      {
        type: "error",
        error: {
          type: "api_error",
          message,
        },
        message,
        ...(retryAfterSeconds != null
          ? { retry_after: retryAfterSeconds }
          : {}),
      },
      statusCode
    )
    this.name = "CodexApiError"
  }
}

// ── Service ────────────────────────────────────────────────────────────

interface PersistedCodexAccountRecord {
  label?: string
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  idToken?: string
  accountId?: string
  email?: string
  planType?: string
  expire?: string
  baseUrl?: string
  proxyUrl?: string
}

interface CodexAccountSlot extends CooldownableAccount {
  label?: string
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  accountId?: string
  email?: string
  planType?: CodexModelTier
  baseUrl: string
  proxyUrl?: string
  source: "env" | "file"
  /** Per-slot token data for independent refresh */
  tokenData: CodexTokenData | null
  refreshPromise?: Promise<CodexTokenData | null>
  persistedMatch?: {
    apiKey?: string
    email?: string
    accountId?: string
    accessToken?: string
    refreshToken?: string
  }
}

@Injectable()
export class CodexService implements OnModuleInit {
  private readonly logger = new Logger(CodexService.name)

  /** All loaded accounts (round-robin pool) */
  private accounts: CodexAccountSlot[] = []
  /** Round-robin counter */
  private accountIndex = 0
  /** Backing file used for multi-account OAuth persistence */
  private accountsFilePath: string = CODEX_ACCOUNTS_DEFAULT_PATH

  private sessionId: string = crypto.randomUUID()
  private configuredModelTier: CodexModelTier | null = null

  /** Whether to prefer WebSocket transport over HTTP */
  private useWebSocket: boolean = false
  /** Whether WebSocket was rejected by upstream (fallback to HTTP) */
  private webSocketRejected: boolean = false

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: CodexAuthService,
    private readonly cacheService: CodexCacheService,
    private readonly wsService: CodexWebSocketService
  ) {}

  onModuleInit() {
    const envApiKey = this.configService.get<string>("CODEX_API_KEY", "").trim()
    const envAccessToken = this.configService
      .get<string>("CODEX_ACCESS_TOKEN", "")
      .trim()
    const envIdToken = this.configService
      .get<string>("CODEX_ID_TOKEN", "")
      .trim()
    const envRefreshToken = this.configService
      .get<string>("CODEX_REFRESH_TOKEN", "")
      .trim()
    const envAccountId = this.configService
      .get<string>("CODEX_ACCOUNT_ID", "")
      .trim()
    const envPlanType = normalizeCodexModelTier(
      this.configService.get<string>("CODEX_PLAN_TYPE", "")
    )
    const envBaseUrl =
      this.configService
        .get<string>("CODEX_BASE_URL", DEFAULT_BASE_URL)
        .trim() || DEFAULT_BASE_URL
    const envProxyUrl = this.configService
      .get<string>("CODEX_PROXY_URL", "")
      .trim()

    // WebSocket transport preference
    const wsEnv = this.configService
      .get<string>("CODEX_USE_WEBSOCKET", "")
      .trim()
      .toLowerCase()
    this.useWebSocket = wsEnv === "true" || wsEnv === "1"

    // 1. Load all accounts from codex-accounts.json
    const fileAccounts = this.loadAllCodexAccountsFromFile()

    // 2. Load persisted tokens (for legacy single-account mode)
    const persisted = this.authService.loadPersistedTokens()

    // 3. Add env-var account as first slot if it has credentials
    if (envApiKey || envAccessToken || persisted?.refreshToken) {
      const envSlot: CodexAccountSlot = {
        label: "env",
        apiKey: envApiKey || undefined,
        accessToken: envAccessToken || undefined,
        baseUrl: envBaseUrl,
        proxyUrl: envProxyUrl || undefined,
        source: "env",
        tokenData: null,
        cooldownUntil: 0,
        modelStates: new Map(),
      }

      if (persisted?.refreshToken) {
        this.applyTokenDataToSlot(envSlot, persisted)
      } else if (envAccessToken || envRefreshToken || envIdToken) {
        this.applyTokenDataToSlot(
          envSlot,
          this.hydrateTokenData({
            idToken: envIdToken,
            accessToken: envAccessToken,
            refreshToken: envRefreshToken,
            accountId: envAccountId,
            email: "",
          })
        )
      }

      if (envPlanType) {
        envSlot.planType = envPlanType
      }

      // Only add if not duplicated in file accounts
      const isDuplicate = fileAccounts.some(
        (a) =>
          (a.apiKey && a.apiKey === envSlot.apiKey) ||
          ((a.email || a.accountId) &&
            a.email === envSlot.email &&
            (a.accountId || "") === (envSlot.accountId || ""))
      )
      if (!isDuplicate) {
        this.accounts.unshift(envSlot)
      }
    }

    // 4. Add file accounts
    for (const fa of fileAccounts) {
      const slot: CodexAccountSlot = {
        label: fa.label || fa.email || undefined,
        apiKey: fa.apiKey || undefined,
        accessToken: fa.accessToken || undefined,
        refreshToken: fa.refreshToken || undefined,
        accountId: fa.accountId || undefined,
        email: fa.email || undefined,
        planType: normalizeCodexModelTier(fa.planType) || undefined,
        baseUrl: fa.baseUrl || envBaseUrl,
        proxyUrl: fa.proxyUrl || envProxyUrl || undefined,
        source: "file",
        tokenData: null,
        cooldownUntil: 0,
        modelStates: new Map(),
        persistedMatch: {
          apiKey: fa.apiKey || undefined,
          email: fa.email || undefined,
          accountId: fa.accountId || undefined,
          accessToken: fa.accessToken || undefined,
          refreshToken: fa.refreshToken || undefined,
        },
      }

      if (fa.accessToken || fa.refreshToken || fa.idToken) {
        this.applyTokenDataToSlot(
          slot,
          this.hydrateTokenData({
            idToken: fa.idToken || "",
            accessToken: fa.accessToken || "",
            refreshToken: fa.refreshToken || "",
            accountId: fa.accountId || "",
            email: fa.email || "",
            expire: fa.expire || "",
          })
        )
      }

      this.accounts.push(slot)
    }

    this.configuredModelTier = this.resolveConfiguredModelTier()

    this.logger.log(
      `Codex backend initialized: ${this.accounts.length} account(s), ` +
        `defaultBaseUrl=${envBaseUrl}, useWebSocket=${this.useWebSocket}, ` +
        `modelTier=${this.configuredModelTier || "unknown"}`
    )
    for (const acct of this.accounts) {
      this.logger.log(
        `  → ${acct.label || acct.email || "unnamed"}: ` +
          `${acct.apiKey ? "api-key" : "oauth"} @ ${acct.baseUrl}`
      )
    }
    if (this.accounts.length === 0) {
      this.logger.warn(
        "No Codex credentials configured. " +
          "GPT/O-series models will not be available."
      )
    }
  }

  /**
   * Check if Codex backend is available (has at least one account).
   */
  isAvailable(): boolean {
    return this.accounts.length > 0
  }

  getPoolStatus(): BackendPoolStatus {
    const now = Date.now()
    const entries = this.accounts.map((account) => {
      const modelCooldowns = this.getActiveModelCooldowns(account, now)
      const state = this.getPoolEntryState(account, modelCooldowns, now)
      return {
        id: [
          account.email || "",
          account.accountId || "",
          account.apiKey || "",
          account.baseUrl,
        ].join("\0"),
        label: this.getAccountLabel(account),
        state,
        cooldownUntil: account.cooldownUntil,
        disabledAt: account.disabledAt,
        disabledReason: account.disabledReason,
        source: account.source,
        baseUrl: account.baseUrl,
        proxyUrl: account.proxyUrl,
        planType: account.planType,
        email: account.email,
        accountId: account.accountId,
        modelCooldowns,
      }
    })

    return {
      backend: "codex",
      kind: "account-pool",
      configured: this.accounts.length > 0,
      total: entries.length,
      available: entries.filter(
        (entry) => entry.state === "ready" || entry.state === "degraded"
      ).length,
      ready: entries.filter((entry) => entry.state === "ready").length,
      degraded: entries.filter((entry) => entry.state === "degraded").length,
      cooling: entries.filter((entry) => entry.state === "cooldown").length,
      disabled: entries.filter((entry) => entry.state === "disabled").length,
      unavailable: 0,
      configPath: this.accountsFilePath,
      entries,
    }
  }

  getModelTier(): CodexModelTier | null {
    return this.getHighestLoadedModelTier() || this.configuredModelTier
  }

  private resolveConfiguredModelTier(): CodexModelTier | null {
    const envTier = normalizeCodexModelTier(
      this.configService.get<string>("CODEX_PLAN_TYPE", "")
    )
    if (envTier) {
      return envTier
    }

    return this.readModelTierFromLocalAuthFile()
  }

  private readModelTierFromLocalAuthFile(): CodexModelTier | null {
    const codexHome =
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
    const authFile = path.join(codexHome, "auth.json")

    try {
      if (!fs.existsSync(authFile)) {
        return null
      }

      const raw = fs.readFileSync(authFile, "utf8")
      const parsed = JSON.parse(raw) as {
        tokens?: { id_token?: string }
      }

      return this.authService.getPlanTypeFromIdToken(
        parsed.tokens?.id_token || ""
      )
    } catch (error) {
      this.logger.warn(
        `Failed to infer Codex plan type from ${authFile}: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }

  /**
   * Load all Codex accounts from codex-accounts.json.
   */
  private loadAllCodexAccountsFromFile(): PersistedCodexAccountRecord[] {
    for (const configPath of CODEX_ACCOUNTS_CONFIG_PATHS) {
      if (!fs.existsSync(configPath)) continue

      try {
        const data = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
          accounts?: PersistedCodexAccountRecord[]
        }
        if (Array.isArray(data.accounts) && data.accounts.length > 0) {
          this.accountsFilePath = configPath
          this.logger.log(
            `Loaded ${data.accounts.length} Codex account(s) from ${configPath}`
          )
          return data.accounts
        }
      } catch (err) {
        this.logger.warn(
          `Failed to parse ${configPath}: ${(err as Error).message}`
        )
      }
    }

    return []
  }

  /**
   * Derive per-slot token metadata from persisted or env-backed credentials.
   */
  private hydrateTokenData(tokenData: Partial<CodexTokenData>): CodexTokenData {
    const idToken = tokenData.idToken?.trim() || ""
    const accessToken = tokenData.accessToken?.trim() || ""

    return {
      idToken,
      accessToken,
      refreshToken: tokenData.refreshToken?.trim() || "",
      accountId:
        tokenData.accountId?.trim() ||
        this.authService.getAccountIdFromIdToken(idToken),
      email: tokenData.email?.trim() || "",
      expire:
        tokenData.expire?.trim() || this.inferTokenExpiry(accessToken, idToken),
    }
  }

  private inferTokenExpiry(...tokens: Array<string | undefined>): string {
    for (const token of tokens) {
      if (!token) continue
      const expire = this.authService.getTokenExpiryFromJwt(token)
      if (expire) {
        return expire
      }
    }

    return new Date(Date.now() + 3600 * 1000).toISOString()
  }

  private applyTokenDataToSlot(
    slot: CodexAccountSlot,
    tokenData: CodexTokenData
  ): void {
    slot.tokenData = tokenData
    slot.accessToken = tokenData.accessToken || slot.accessToken
    slot.refreshToken = tokenData.refreshToken || slot.refreshToken
    slot.accountId =
      tokenData.accountId ||
      slot.accountId ||
      this.authService.getAccountIdFromIdToken(tokenData.idToken)
    slot.email = tokenData.email || slot.email
    slot.planType =
      this.authService.getPlanTypeFromTokenData(tokenData) || slot.planType
  }

  private getSlotPlanType(slot: CodexAccountSlot): CodexModelTier | null {
    return (
      slot.planType || this.authService.getPlanTypeFromTokenData(slot.tokenData)
    )
  }

  private getHighestLoadedModelTier(): CodexModelTier | null {
    let highest: CodexModelTier | null = null

    for (const slot of this.accounts) {
      const tier = this.getSlotPlanType(slot)
      if (!tier) continue
      if (
        !highest ||
        CODEX_MODEL_TIER_ORDER.indexOf(tier) >
          CODEX_MODEL_TIER_ORDER.indexOf(highest)
      ) {
        highest = tier
      }
    }

    return highest
  }

  private getSlotAccountId(slot: CodexAccountSlot): string {
    return (
      this.authService.getAccountIdFromTokenData(slot.tokenData) ||
      slot.accountId ||
      ""
    )
  }

  private getAccountLabel(slot: CodexAccountSlot): string {
    return slot.label || slot.email || "slot"
  }

  private getActiveModelCooldowns(
    account: CodexAccountSlot,
    now: number
  ): BackendPoolStatus["entries"][number]["modelCooldowns"] {
    return Array.from(account.modelStates.entries())
      .filter(([, state]) => state.cooldownUntil > now)
      .map(([model, state]) => ({
        model,
        cooldownUntil: state.cooldownUntil,
        quotaExhausted: state.quotaExhausted,
        backoffLevel: state.backoffLevel,
      }))
      .sort((left, right) => left.cooldownUntil - right.cooldownUntil)
  }

  private getPoolEntryState(
    account: CodexAccountSlot,
    modelCooldowns: BackendPoolStatus["entries"][number]["modelCooldowns"],
    now: number
  ): BackendPoolEntryState {
    if (isAccountDisabled(account)) {
      return "disabled"
    }
    if (account.cooldownUntil > now) {
      return "cooldown"
    }
    if (modelCooldowns.length > 0) {
      return "degraded"
    }
    return "ready"
  }

  /**
   * Round-robin: pick the next available account, respecting cooldowns.
   *
   * @param model - The model being requested (for per-model cooldown checks)
   * @returns The slot, or null if all accounts are in cooldown
   */
  private pickNextAvailableAccount(model: string): CodexAccountSlot | null {
    const result = pickAvailableAccount(this.accounts, model, this.accountIndex)

    if (!result) {
      // All accounts in cooldown
      this.logger.warn(
        `[Codex] All ${this.accounts.length} account(s) are in cooldown for model=${model}`
      )
      return null
    }

    const slot = result.account
    this.accountIndex = (result.index + 1) % this.accounts.length
    return slot
  }

  /**
   * Persist refreshed OAuth metadata to the appropriate backing store.
   */
  private persistSlotTokens(slot: CodexAccountSlot): void {
    if (!slot.tokenData) return

    if (slot.source === "env") {
      this.authService.persistTokenData(slot.tokenData)
      return
    }

    this.persistFileBackedAccount(slot)
  }

  /**
   * Persist a refreshed file-backed OAuth slot back into codex-accounts.json.
   */
  private persistFileBackedAccount(slot: CodexAccountSlot): void {
    if (!slot.tokenData) return

    try {
      const filePath = this.accountsFilePath || CODEX_ACCOUNTS_DEFAULT_PATH
      const payload: { accounts: PersistedCodexAccountRecord[] } = {
        accounts: [],
      }

      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
          accounts?: PersistedCodexAccountRecord[]
        }
        payload.accounts = Array.isArray(parsed.accounts) ? parsed.accounts : []
      }

      const existingIndex = payload.accounts.findIndex((account) => {
        if (
          slot.persistedMatch?.apiKey &&
          account.apiKey === slot.persistedMatch.apiKey
        ) {
          return true
        }
        if (
          slot.persistedMatch?.refreshToken &&
          account.refreshToken === slot.persistedMatch.refreshToken
        ) {
          return true
        }
        if (
          slot.persistedMatch?.accessToken &&
          account.accessToken === slot.persistedMatch.accessToken
        ) {
          return true
        }

        const matchEmail = slot.persistedMatch?.email || slot.email || ""
        const matchAccountId =
          slot.persistedMatch?.accountId || slot.accountId || ""
        return (
          (account.email || "") === matchEmail &&
          (account.accountId || "") === matchAccountId
        )
      })

      const currentRecord: PersistedCodexAccountRecord = {
        ...(existingIndex >= 0 ? payload.accounts[existingIndex] : {}),
        ...(slot.label ? { label: slot.label } : {}),
        ...(slot.apiKey ? { apiKey: slot.apiKey } : {}),
        ...(slot.email ? { email: slot.email } : {}),
        ...(slot.baseUrl ? { baseUrl: slot.baseUrl } : {}),
        ...(slot.proxyUrl ? { proxyUrl: slot.proxyUrl } : {}),
        accessToken: slot.tokenData.accessToken,
        refreshToken: slot.tokenData.refreshToken,
        idToken: slot.tokenData.idToken,
        accountId: this.getSlotAccountId(slot) || undefined,
        planType: this.getSlotPlanType(slot) || undefined,
        expire: slot.tokenData.expire || undefined,
      }

      Object.keys(currentRecord).forEach((key) => {
        const typedKey = key as keyof PersistedCodexAccountRecord
        if (!currentRecord[typedKey]) {
          delete currentRecord[typedKey]
        }
      })

      if (existingIndex >= 0) {
        payload.accounts[existingIndex] = currentRecord
      } else {
        payload.accounts.push(currentRecord)
      }

      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8")
      slot.persistedMatch = {
        apiKey: slot.apiKey,
        email: slot.email,
        accountId: slot.accountId,
        accessToken: slot.accessToken,
        refreshToken: slot.refreshToken,
      }
    } catch (error) {
      this.logger.warn(
        `Failed to persist Codex account to ${this.accountsFilePath}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Get the bearer token for authentication.
   * Refreshes OAuth credentials per slot without mutating singleton service state.
   */
  private async getBearerToken(slot: CodexAccountSlot): Promise<string> {
    if (slot.apiKey) return slot.apiKey

    if (slot.tokenData) {
      const tokenData = await this.ensureFreshTokenData(slot)
      if (tokenData?.accessToken) {
        return tokenData.accessToken
      }
    }

    return slot.accessToken || ""
  }

  /**
   * Refresh an OAuth slot once, sharing the in-flight refresh per slot.
   */
  private async ensureFreshTokenData(
    slot: CodexAccountSlot
  ): Promise<CodexTokenData | null> {
    if (!slot.tokenData) {
      return null
    }

    if (!this.authService.isTokenExpired(slot.tokenData)) {
      return slot.tokenData
    }

    if (!slot.tokenData.refreshToken) {
      return slot.tokenData
    }

    if (!slot.refreshPromise) {
      slot.refreshPromise = (async () => {
        this.logger.log(
          `[Codex] Refreshing token for ${this.getAccountLabel(slot)}`
        )
        try {
          const refreshed = await this.authService.refreshTokensWithRetry(
            slot.tokenData?.refreshToken || "",
            3,
            { persist: false, updateState: false }
          )
          this.applyTokenDataToSlot(slot, refreshed)
          this.persistSlotTokens(slot)
          return slot.tokenData
        } catch (error) {
          this.logger.error(
            `[Codex] Token refresh failed for ${this.getAccountLabel(slot)}: ${error instanceof Error ? error.message : String(error)}`
          )
          return null
        } finally {
          slot.refreshPromise = undefined
        }
      })()
    }

    const refreshed = await slot.refreshPromise
    return refreshed || slot.tokenData
  }

  /**
   * Determine if the slot is using an API key (vs OAuth access token).
   */
  private isApiKeyMode(slot: CodexAccountSlot): boolean {
    return !!slot.apiKey
  }

  /**
   * Build the fetch agent for proxy support.
   * Uses the selected slot's proxyUrl.
   */
  private buildProxyAgent(
    slot: CodexAccountSlot
  ):
    | HttpProxyAgent<string>
    | HttpsProxyAgent<string>
    | SocksProxyAgent
    | undefined {
    const proxyUrl = slot.proxyUrl
    if (!proxyUrl) return undefined

    try {
      const url = new URL(proxyUrl)
      switch (url.protocol) {
        case "http:":
          return new HttpProxyAgent(proxyUrl)
        case "https:":
          return new HttpsProxyAgent(proxyUrl)
        case "socks5:":
        case "socks5h:":
        case "socks4:":
          return new SocksProxyAgent(proxyUrl)
        default:
          this.logger.error(`Unsupported proxy scheme: ${url.protocol}`)
          return undefined
      }
    } catch (e) {
      this.logger.error(`Failed to parse proxy URL: ${(e as Error).message}`)
      return undefined
    }
  }

  /**
   * Build request headers matching codex_cli_rs behavior.
   * Ported from: codex_executor.go applyCodexHeaders()
   */
  private buildHeaders(
    slot: CodexAccountSlot,
    token: string,
    stream: boolean,
    cacheHeaders?: Record<string, string>
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Version: CODEX_CLIENT_VERSION,
      Session_id: this.sessionId,
      "User-Agent": CODEX_USER_AGENT,
      Connection: "Keep-Alive",
      Accept: stream ? "text/event-stream" : "application/json",
    }

    // Non-API-key mode: add Originator header (OAuth/access token mode)
    if (!this.isApiKeyMode(slot)) {
      headers["Originator"] = "codex_cli_rs"

      // Add account ID if available
      const accountId = this.getSlotAccountId(slot)
      if (accountId) {
        headers["Chatgpt-Account-Id"] = accountId
      }
    }

    // Merge cache headers
    if (cacheHeaders) {
      for (const [key, value] of Object.entries(cacheHeaders)) {
        headers[key] = value
      }
    }

    return headers
  }

  /**
   * Parse retry-after from Codex rate limit errors.
   * Ported from: codex_executor.go parseCodexRetryAfter()
   */
  private parseRetryAfter(
    statusCode: number,
    errorBody: string
  ): number | null {
    if (statusCode !== 429) return null

    try {
      const parsed = JSON.parse(errorBody) as Record<string, unknown>
      const error = parsed.error as Record<string, unknown> | undefined
      if (!error) return null

      if (error.type !== "usage_limit_reached") return null

      // Check resets_at (Unix timestamp)
      const resetsAt = error.resets_at as number | undefined
      if (resetsAt && resetsAt > 0) {
        const now = Math.floor(Date.now() / 1000)
        if (resetsAt > now) {
          return resetsAt - now
        }
      }

      // Check resets_in_seconds
      const resetsInSeconds = error.resets_in_seconds as number | undefined
      if (resetsInSeconds && resetsInSeconds > 0) {
        return resetsInSeconds
      }
    } catch {
      // Ignore parse errors
    }

    return null
  }

  private summarizeErrorBody(errorBody: string): string {
    const trimmed = errorBody.trim()
    if (!trimmed) {
      return ""
    }

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const error =
        parsed.error && typeof parsed.error === "object"
          ? (parsed.error as Record<string, unknown>)
          : undefined
      const message =
        (typeof error?.message === "string" && error.message.trim()) ||
        (typeof parsed.message === "string" && parsed.message.trim()) ||
        trimmed

      return message.slice(0, 200)
    } catch {
      return trimmed.slice(0, 200)
    }
  }

  private createCodexApiError(
    statusCode: number,
    errorBody: string
  ): CodexApiError {
    const retryAfter = this.parseRetryAfter(statusCode, errorBody)
    const details = this.summarizeErrorBody(errorBody)

    if (retryAfter != null) {
      const suffix = details ? ` ${details}` : ""
      return new CodexApiError(
        statusCode,
        `Codex rate limited. Retry after ${retryAfter} seconds.${suffix}`,
        retryAfter
      )
    }

    const message = details
      ? `Codex API error ${statusCode}: ${details}`
      : `Codex API error ${statusCode}`

    return new CodexApiError(statusCode, message)
  }

  /**
   * Build the Codex request URL.
   * Uses the selected slot's baseUrl.
   */
  private buildUrl(
    slot: CodexAccountSlot,
    endpoint: string = "responses"
  ): string {
    const baseUrl = slot.baseUrl || DEFAULT_BASE_URL
    return `${baseUrl.replace(/\/+$/, "")}/${endpoint}`
  }

  /**
   * Get cache ID for the current request.
   */
  private getCacheId(dto: CreateMessageDto, slot: CodexAccountSlot): string {
    // Extract user ID from metadata if available
    const metadata = dto as unknown as {
      metadata?: { user_id?: string }
    }
    const userId = metadata?.metadata?.user_id

    if (userId) {
      return this.cacheService.getOrCreateCacheId(dto.model, userId)
    }

    // Fallback: use API key-based cache
    if (slot.apiKey) {
      return this.cacheService.getCacheIdFromApiKey(slot.apiKey)
    }

    return ""
  }

  private createAllAccountsRateLimitedError(modelName: string): CodexApiError {
    const info = getEarliestRecovery(this.accounts, modelName)
    const retrySeconds = info ? Math.ceil(info.retryAfterMs / 1000) : 60
    return new CodexApiError(
      429,
      `All Codex accounts are rate-limited for model ${modelName}. ` +
        `Retry after ${retrySeconds} seconds.`,
      retrySeconds
    )
  }

  private selectRequestSlot(modelName: string): CodexAccountSlot {
    if (this.accounts.length === 0) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    const slot = this.pickNextAvailableAccount(modelName)
    if (!slot) {
      throw this.createAllAccountsRateLimitedError(modelName)
    }
    return slot
  }

  // ── Non-streaming ────────────────────────────────────────────────────

  /**
   * Send a non-streaming message through Codex.
   */
  async sendClaudeMessage(dto: CreateMessageDto): Promise<AnthropicResponse> {
    return this.executeWithCooldownRetry(dto, false)
  }

  /**
   * Core execution logic with cooldown-aware account selection and
   * automatic retry on 429 (switches to next available account).
   */
  private async executeWithCooldownRetry(
    dto: CreateMessageDto,
    isRetry: boolean,
    slot: CodexAccountSlot = this.selectRequestSlot(dto.model)
  ): Promise<AnthropicResponse> {
    const modelName = dto.model
    const token = await this.getBearerToken(slot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }

    const reverseToolMap = buildReverseMapFromClaudeTools(dto.tools)
    let codexRequest = translateClaudeToCodex(dto, modelName) as Record<
      string,
      unknown
    >

    const cacheId = this.getCacheId(dto, slot)
    if (cacheId) {
      codexRequest = this.cacheService.injectCacheKey(codexRequest, cacheId)
    }

    try {
      let result: AnthropicResponse

      // Try WebSocket transport first (if enabled and not rejected)
      if (
        this.useWebSocket &&
        !this.webSocketRejected &&
        this.wsService.isWebSocketAvailable()
      ) {
        try {
          result = await this.sendViaWebSocket(
            slot,
            token,
            codexRequest,
            modelName,
            reverseToolMap,
            cacheId
          )
        } catch (e) {
          if (e instanceof CodexWebSocketUpgradeError) {
            if (e.shouldFallbackToHttp()) {
              this.logger.warn(
                "WebSocket upgrade rejected, falling back to HTTP"
              )
              this.webSocketRejected = true
            } else {
              throw this.createCodexApiError(
                e.statusCode || 502,
                e.body || e.message
              )
            }
          } else {
            throw e
          }
          // Fallback to HTTP after WebSocket rejection
          result = await this.sendViaHttp(
            slot,
            token,
            codexRequest,
            modelName,
            reverseToolMap,
            cacheId
          )
        }
      } else {
        result = await this.sendViaHttp(
          slot,
          token,
          codexRequest,
          modelName,
          reverseToolMap,
          cacheId
        )
      }

      // Success — clear any cooldown on this slot
      markAccountSuccess(slot, modelName)
      return result
    } catch (e) {
      // Handle rate-limit errors with automatic retry
      if (e instanceof CodexApiError) {
        const statusCode = e.getStatus()
        const retryAfterHeader = e.retryAfterSeconds?.toString()
        markAccountCooldown(
          slot,
          statusCode,
          modelName,
          retryAfterHeader,
          this.getAccountLabel(slot)
        )

        // Auto-retry once on 429 if another account is available
        if (statusCode === 429 && !isRetry && this.accounts.length > 1) {
          const nextSlot = this.pickNextAvailableAccount(modelName)
          if (nextSlot && nextSlot !== slot) {
            this.logger.log(
              `[Codex] 429 on ${this.getAccountLabel(slot)}, retrying with ${this.getAccountLabel(nextSlot)}`
            )
            return this.executeWithCooldownRetry(dto, true, nextSlot)
          }
        }
      }
      throw e
    }
  }

  /**
   * Send non-streaming via HTTP.
   */
  private async sendViaHttp(
    slot: CodexAccountSlot,
    token: string,
    codexRequest: Record<string, unknown>,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string
  ): Promise<AnthropicResponse> {
    const requestBody = JSON.stringify(codexRequest)
    const url = this.buildUrl(slot, "responses")
    const cacheHeaders = this.cacheService.buildCacheHeaders(cacheId)
    const headers = this.buildHeaders(slot, token, true, cacheHeaders)

    this.logger.log(
      `[Codex] Non-stream request: model=${modelName}, url=${url}`
    )

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(300_000),
    }

    const agent = this.buildProxyAgent(slot)
    if (agent) {
      fetchOptions.dispatcher = agent
    }

    const response = await fetch(url, fetchOptions)

    if (!response.ok) {
      const errorBody = await response.text()
      this.logger.error(
        `[Codex] Request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
      )

      throw this.createCodexApiError(response.status, errorBody)
    }

    // Read the full SSE stream and find response.completed
    const fullBody = await response.text()
    const lines = fullBody.split("\n")

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) continue

      const jsonStr = trimmed.slice(5).trim()
      if (!jsonStr || jsonStr === "[DONE]") continue

      try {
        const event = JSON.parse(jsonStr) as Record<string, unknown>
        if (event.type === "response.completed") {
          const result = translateCodexToClaudeNonStream(event, reverseToolMap)
          if (result) {
            this.logger.log(
              `[Codex] Non-stream response: model=${result.model}, stop=${result.stop_reason}`
            )
            return result
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }

    throw new Error("Codex stream ended without response.completed event")
  }

  /**
   * Send non-streaming via WebSocket.
   */
  private async sendViaWebSocket(
    slot: CodexAccountSlot,
    token: string,
    codexRequest: Record<string, unknown>,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string
  ): Promise<AnthropicResponse> {
    const httpUrl = this.buildUrl(slot, "responses")
    const wsUrl = this.wsService.buildWebSocketUrl(httpUrl)
    const cacheHeaders = this.cacheService.buildCacheHeaders(cacheId)
    const wsHeaders = this.wsService.buildWebSocketHeaders(
      token,
      this.isApiKeyMode(slot),
      this.getSlotAccountId(slot),
      cacheHeaders
    )

    this.logger.log(
      `[Codex] WebSocket non-stream request: model=${modelName}, url=${wsUrl}`
    )

    const ws = await this.wsService.connect(
      wsUrl,
      wsHeaders,
      slot.proxyUrl || undefined
    )

    try {
      const wsBody = this.wsService.buildWebSocketRequestBody(codexRequest)
      const completedEvent = await this.wsService.sendViaWebSocket(ws, wsBody)

      const result = translateCodexToClaudeNonStream(
        completedEvent as Record<string, unknown>,
        reverseToolMap
      )
      if (result) {
        this.logger.log(
          `[Codex] WebSocket non-stream response: model=${result.model}, stop=${result.stop_reason}`
        )
        return result
      }

      throw new Error("WebSocket response did not contain valid completion")
    } finally {
      ws.close()
    }
  }

  // ── Streaming ────────────────────────────────────────────────────────

  /**
   * Send a streaming message through Codex.
   * Returns an async generator yielding Claude SSE event strings.
   */
  async *sendClaudeMessageStream(
    dto: CreateMessageDto
  ): AsyncGenerator<string, void, unknown> {
    yield* this.executeStreamWithCooldownRetry(dto, false)
  }

  private async *executeStreamWithCooldownRetry(
    dto: CreateMessageDto,
    isRetry: boolean,
    slot: CodexAccountSlot = this.selectRequestSlot(dto.model)
  ): AsyncGenerator<string, void, unknown> {
    const modelName = dto.model
    const token = await this.getBearerToken(slot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }

    const reverseToolMap = buildReverseMapFromClaudeTools(dto.tools)
    let codexRequest = translateClaudeToCodex(dto, modelName) as Record<
      string,
      unknown
    >

    const cacheId = this.getCacheId(dto, slot)
    if (cacheId) {
      codexRequest = this.cacheService.injectCacheKey(codexRequest, cacheId)
    }

    let emittedEvents = false

    try {
      // Try WebSocket transport first (if enabled and not rejected)
      if (
        this.useWebSocket &&
        !this.webSocketRejected &&
        this.wsService.isWebSocketAvailable()
      ) {
        try {
          for await (const event of this.streamViaWebSocket(
            slot,
            token,
            codexRequest,
            modelName,
            reverseToolMap,
            cacheId
          )) {
            emittedEvents = true
            yield event
          }
          markAccountSuccess(slot, modelName)
          return
        } catch (e) {
          if (e instanceof CodexWebSocketUpgradeError) {
            if (e.shouldFallbackToHttp()) {
              this.logger.warn(
                "WebSocket upgrade rejected, falling back to HTTP for streaming"
              )
              this.webSocketRejected = true
            } else {
              throw this.createCodexApiError(
                e.statusCode || 502,
                e.body || e.message
              )
            }
          } else {
            throw e
          }
        }
      }

      for await (const event of this.streamViaHttp(
        slot,
        token,
        codexRequest,
        modelName,
        reverseToolMap,
        cacheId
      )) {
        emittedEvents = true
        yield event
      }
      markAccountSuccess(slot, modelName)
    } catch (e) {
      if (e instanceof CodexApiError) {
        const statusCode = e.getStatus()
        markAccountCooldown(
          slot,
          statusCode,
          modelName,
          e.retryAfterSeconds?.toString(),
          this.getAccountLabel(slot)
        )

        if (
          statusCode === 429 &&
          !isRetry &&
          !emittedEvents &&
          this.accounts.length > 1
        ) {
          const nextSlot = this.pickNextAvailableAccount(modelName)
          if (nextSlot && nextSlot !== slot) {
            this.logger.log(
              `[Codex] 429 on ${this.getAccountLabel(slot)}, retrying streamed request with ${this.getAccountLabel(nextSlot)}`
            )
            yield* this.executeStreamWithCooldownRetry(dto, true, nextSlot)
            return
          }
        }
      }
      throw e
    }
  }

  /**
   * Stream via HTTP SSE transport.
   */
  private async *streamViaHttp(
    slot: CodexAccountSlot,
    token: string,
    codexRequest: Record<string, unknown>,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string
  ): AsyncGenerator<string, void, unknown> {
    const requestBody = JSON.stringify(codexRequest)
    const url = this.buildUrl(slot, "responses")
    const cacheHeaders = this.cacheService.buildCacheHeaders(cacheId)
    const headers = this.buildHeaders(slot, token, true, cacheHeaders)

    this.logger.log(`[Codex] Stream request: model=${modelName}, url=${url}`)

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(600_000),
    }

    const agent = this.buildProxyAgent(slot)
    if (agent) {
      fetchOptions.dispatcher = agent
    }

    const response = await fetch(url, fetchOptions)

    if (!response.ok) {
      const errorBody = await response.text()
      this.logger.error(
        `[Codex] Stream request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
      )

      throw this.createCodexApiError(response.status, errorBody)
    }

    if (!response.body) {
      throw new Error("Codex response has no body")
    }

    // Stream SSE events
    const state = createStreamState()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          const claudeEvents = translateCodexSseEvent(
            trimmed,
            state,
            reverseToolMap
          )
          for (const event of claudeEvents) {
            yield event
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const claudeEvents = translateCodexSseEvent(
          buffer.trim(),
          state,
          reverseToolMap
        )
        for (const event of claudeEvents) {
          yield event
        }
      }
    } finally {
      reader.releaseLock()
    }

    this.logger.log(
      `[Codex] Stream completed: model=${modelName}, blocks=${state.blockIndex}, hasToolCall=${state.hasToolCall}`
    )
  }

  /**
   * Stream via WebSocket transport.
   * Converts WebSocket JSON messages to SSE-formatted lines for the
   * existing response translator.
   */
  private async *streamViaWebSocket(
    slot: CodexAccountSlot,
    token: string,
    codexRequest: Record<string, unknown>,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string
  ): AsyncGenerator<string, void, unknown> {
    const httpUrl = this.buildUrl(slot, "responses")
    const wsUrl = this.wsService.buildWebSocketUrl(httpUrl)
    const cacheHeaders = this.cacheService.buildCacheHeaders(cacheId)
    const wsHeaders = this.wsService.buildWebSocketHeaders(
      token,
      this.isApiKeyMode(slot),
      this.getSlotAccountId(slot),
      cacheHeaders
    )

    this.logger.log(
      `[Codex] WebSocket stream request: model=${modelName}, url=${wsUrl}`
    )

    const ws = await this.wsService.connect(
      wsUrl,
      wsHeaders,
      slot.proxyUrl || undefined
    )

    const state = createStreamState()

    try {
      const wsBody = this.wsService.buildWebSocketRequestBody(codexRequest)

      for await (const msg of this.wsService.streamViaWebSocket(ws, wsBody)) {
        // Convert WebSocket message to SSE line for the translator
        const sseLine = `data: ${JSON.stringify(msg)}`
        const claudeEvents = translateCodexSseEvent(
          sseLine,
          state,
          reverseToolMap
        )
        for (const event of claudeEvents) {
          yield event
        }
      }
    } finally {
      ws.close()
    }

    this.logger.log(
      `[Codex] WebSocket stream completed: model=${modelName}, blocks=${state.blockIndex}, hasToolCall=${state.hasToolCall}`
    )
  }

  // ── Availability ─────────────────────────────────────────────────────

  /**
   * Check if the Codex backend is reachable.
   */
  checkAvailability(): Promise<boolean> {
    return Promise.resolve(this.isAvailable())
  }
}
