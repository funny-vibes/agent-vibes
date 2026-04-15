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
 * - Request header emulation matching CLIProxyAPI Codex behavior
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
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import * as os from "os"
import * as path from "path"
import { SocksProxyAgent } from "socks-proxy-agent"
import type WebSocket from "ws"
import type { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"
import type { AnthropicResponse } from "../../shared/anthropic"
import {
  getAccountConfigPathCandidates,
  resolveDefaultAccountConfigPath,
} from "../../shared/protocol-bridge-paths"
import { UsageStatsService } from "../../usage"
import {
  createAbortPromise,
  createAbortSignalWithTimeout,
  toUpstreamRequestAbortedError,
  UpstreamRequestAbortedError,
} from "../shared/abort-signal"
import {
  type CooldownableAccount,
  isAccountAvailableForModel,
  isAccountDisabled,
  markAccountCooldown,
  markAccountSuccess,
} from "../shared/account-cooldown"
import {
  BackendPoolEntryState,
  BackendPoolStatus,
  type CodexRateLimitAccountSummary,
  type CodexRateLimitModelSummary,
  type CodexRateLimitSnapshot,
  type CodexRateLimitSource,
  type CodexRateLimitWindow,
} from "../shared/backend-pool-status"
import {
  CodexModelTier,
  getCodexModelIdsForTier,
  getPublicModelMetadata,
  isChatGptCodexModelSupported,
  normalizeCodexModelTier,
  supportsCodexModelForTier,
} from "../shared/model-registry"
import { CodexAuthService, type CodexTokenData } from "./codex-auth.service"
import { CodexCacheService } from "./codex-cache.service"
import {
  buildCodexHttpHeaders,
  type CodexForwardHeaders,
} from "./codex-header-utils"
import { translateClaudeToCodex } from "./codex-request-translator"
import {
  createStreamState,
  translateCodexSseEvent,
  translateCodexToClaudeNonStream,
} from "./codex-response-translator"
import {
  CodexWebSocketService,
  CodexWebSocketUpgradeError,
} from "./codex-websocket.service"
import { buildReverseMapFromClaudeTools } from "./tool-name-shortener"

// ── Constants ───────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex"
const CODEX_ACCOUNTS_CONFIG_PATHS = getAccountConfigPathCandidates(
  "codex-accounts.json"
)
const CODEX_ACCOUNTS_DEFAULT_PATH = resolveDefaultAccountConfigPath(
  "codex-accounts.json"
)
const CODEX_MODEL_TIER_ORDER: CodexModelTier[] = ["free", "plus", "team", "pro"]
const DEFAULT_CODEX_RATE_LIMIT_MODEL = "gpt-5.4"

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
  workspaceId?: string
  email?: string
  planType?: string
  expire?: string
  baseUrl?: string
  proxyUrl?: string
}

interface LoadedCodexAccountRecord extends PersistedCodexAccountRecord {
  configPath: string
}

interface CodexAccountSlot extends CooldownableAccount {
  label?: string
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  accountId?: string
  workspaceId?: string
  email?: string
  planType?: CodexModelTier
  baseUrl: string
  proxyUrl?: string
  configPath?: string
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
  /** Rate limit snapshots from x-codex-* response headers, keyed by model */
  rateLimitSnapshots: Map<
    string,
    Partial<Record<CodexRateLimitSource, CodexRateLimitSnapshot>>
  >
}

interface ConversationSlotBinding {
  slotKey: string
  expire: number
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

  /** Sticky conversation -> account binding to keep cache locality intact. */
  private readonly conversationSlotBindings = new Map<
    string,
    ConversationSlotBinding
  >()

  private configuredModelTier: CodexModelTier | null = null

  /** Whether to prefer WebSocket transport over HTTP */
  private useWebSocket: boolean = false

  private readonly CONVERSATION_SLOT_TTL_MS = 60 * 60 * 1000
  private rateLimitProbePromise: Promise<number> | null = null

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: CodexAuthService,
    private readonly cacheService: CodexCacheService,
    private readonly wsService: CodexWebSocketService,
    private readonly usageStats: UsageStatsService
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
        rateLimitSnapshots: new Map(),
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
        workspaceId: fa.workspaceId || undefined,
        email: fa.email || undefined,
        planType: normalizeCodexModelTier(fa.planType) || undefined,
        baseUrl: fa.baseUrl || envBaseUrl,
        proxyUrl: fa.proxyUrl || envProxyUrl || undefined,
        configPath: fa.configPath,
        source: "file",
        tokenData: null,
        cooldownUntil: 0,
        modelStates: new Map(),
        rateLimitSnapshots: new Map(),
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
            workspaceId: fa.workspaceId || "",
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

  /**
   * Hot-reload accounts from config file.
   * Reconciles file-backed slots against the latest account file, preserving
   * runtime state only for matching live slots and removing stale file slots.
   * Returns the number of newly added accounts.
   */
  reloadAccounts(): number {
    const freshRecords = this.loadAllCodexAccountsFromFile()
    const envBaseUrl =
      this.configService
        .get<string>("CODEX_BASE_URL", DEFAULT_BASE_URL)
        .trim() || DEFAULT_BASE_URL
    const envProxyUrl = this.configService
      .get<string>("CODEX_PROXY_URL", "")
      .trim()

    const existingFileSlots = new Map<string, CodexAccountSlot>()
    for (const slot of this.accounts) {
      if (slot.source !== "file") {
        continue
      }
      existingFileSlots.set(this.getFileSlotReloadKey(slot), slot)
    }

    const nextAccounts = this.accounts.filter((slot) => slot.source !== "file")
    const seenReloadKeys = new Set<string>()
    let added = 0

    freshRecords.forEach((record, index) => {
      const reloadKey = this.getLoadedRecordReloadKey(record, envBaseUrl, index)
      if (seenReloadKeys.has(reloadKey)) {
        return
      }
      seenReloadKeys.add(reloadKey)

      const existingSlot = existingFileSlots.get(reloadKey)
      if (existingSlot) {
        this.refreshFileSlotFromRecord(
          existingSlot,
          record,
          envBaseUrl,
          envProxyUrl
        )
        nextAccounts.push(existingSlot)
        existingFileSlots.delete(reloadKey)
        return
      }

      const slot = this.createFileSlotFromLoadedRecord(
        record,
        envBaseUrl,
        envProxyUrl
      )
      nextAccounts.push(slot)
      added++
      this.logger.log(
        `[Hot-reload] Added new Codex account: ${this.getAccountLabel(slot)}`
      )
    })

    const removedSlots = Array.from(existingFileSlots.values())
    if (removedSlots.length > 0) {
      this.pruneConversationBindingsForSlots(removedSlots)
      this.logger.log(
        `[Hot-reload] Codex: removed ${removedSlots.length} stale file account(s)`
      )
    }

    this.accounts = nextAccounts
    this.accountIndex =
      this.accounts.length > 0 ? this.accountIndex % this.accounts.length : 0
    this.configuredModelTier = this.resolveConfiguredModelTier()

    if (added > 0 || removedSlots.length > 0) {
      this.logger.log(
        `[Hot-reload] Codex: +${added} / -${removedSlots.length}, total=${this.accounts.length}`
      )
    }

    return added
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
          account.workspaceId || "",
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
        workspaceId: account.workspaceId,
        modelCooldowns,
        rateLimits: this.getRateLimitAccountSummary(account),
      }
    })

    return {
      backend: "codex",
      kind: "account-pool",
      configured: this.accounts.length > 0,
      total: entries.length,
      available: entries.filter(
        (entry) =>
          entry.state === "ready" ||
          entry.state === "degraded" ||
          entry.state === "model_cooldown"
      ).length,
      ready: entries.filter((entry) => entry.state === "ready").length,
      degraded: entries.filter((entry) => entry.state === "degraded").length,
      modelCooldown: entries.filter((entry) => entry.state === "model_cooldown")
        .length,
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

  supportsModel(modelName: string): boolean {
    const normalized = modelName.toLowerCase().trim()
    if (!normalized) {
      return false
    }

    return this.hasSupportingAccount(normalized)
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
  private loadAllCodexAccountsFromFile(): LoadedCodexAccountRecord[] {
    const loadedRecords: LoadedCodexAccountRecord[] = []
    const loadedPaths: string[] = []

    for (const configPath of CODEX_ACCOUNTS_CONFIG_PATHS) {
      if (!fs.existsSync(configPath)) continue

      try {
        const data = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
          accounts?: PersistedCodexAccountRecord[]
        }
        if (Array.isArray(data.accounts) && data.accounts.length > 0) {
          loadedPaths.push(configPath)
          this.logger.log(
            `Loaded ${data.accounts.length} Codex account(s) from ${configPath}`
          )
          loadedRecords.push(
            ...data.accounts.map((account) => ({
              ...account,
              configPath,
            }))
          )
        }
      } catch (err) {
        this.logger.warn(
          `Failed to parse ${configPath}: ${(err as Error).message}`
        )
      }
    }

    if (loadedRecords.length === 0) {
      return []
    }

    const mergedRecords = this.mergeLoadedAccountRecords(loadedRecords)
    const preferredConfigPath =
      mergedRecords[mergedRecords.length - 1]?.configPath ||
      loadedPaths[loadedPaths.length - 1] ||
      CODEX_ACCOUNTS_DEFAULT_PATH

    this.accountsFilePath = preferredConfigPath

    if (
      loadedPaths.length > 1 ||
      mergedRecords.length !== loadedRecords.length
    ) {
      this.logger.log(
        `Merged ${mergedRecords.length} Codex account(s) from ${loadedPaths.join(", ")}`
      )
    }

    return mergedRecords
  }

  private mergeLoadedAccountRecords(
    records: LoadedCodexAccountRecord[]
  ): LoadedCodexAccountRecord[] {
    const merged = new Map<string, LoadedCodexAccountRecord>()

    records.forEach((record, index) => {
      const key = this.getLoadedAccountOverrideKey(record, index)
      if (merged.has(key)) {
        merged.delete(key)
      }
      merged.set(key, record)
    })

    return Array.from(merged.values())
  }

  private getLoadedAccountOverrideKey(
    account: LoadedCodexAccountRecord,
    index: number
  ): string {
    const email = account.email?.trim().toLowerCase()
    const accountId = account.accountId?.trim()
    if (email && accountId) {
      return `email:${email}:${accountId}`
    }
    if (email) {
      return `email:${email}`
    }

    const apiKey = account.apiKey?.trim()
    if (apiKey) {
      return `api_key:${apiKey}`
    }

    const refreshToken = account.refreshToken?.trim()
    if (refreshToken) {
      return `refresh_token:${refreshToken}`
    }

    const accessToken = account.accessToken?.trim()
    if (accessToken) {
      return `access_token:${accessToken}`
    }

    if (accountId) {
      return `account_id:${accountId}`
    }

    return `path:${account.configPath}:${index}`
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
      workspaceId:
        tokenData.workspaceId?.trim() ||
        this.authService.getWorkspaceIdFromIdToken(idToken),
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
    slot.workspaceId =
      tokenData.workspaceId ||
      slot.workspaceId ||
      this.authService.getWorkspaceIdFromIdToken(tokenData.idToken)
    slot.email = tokenData.email || slot.email

    // 与 CLIProxyAPI 的管理面板保持一致：
    // 如果账号文件里已经明确声明了 planType，就不要再被 token claim 覆盖。
    // 某些账号会出现 token 里仍然是 free，但实际账号/面板展示应保持 plus 的情况。
    if (!slot.planType) {
      slot.planType =
        this.authService.getPlanTypeFromTokenData(tokenData) ?? undefined
    }
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

  private getConversationId(dto: CreateMessageDto): string {
    return typeof dto._conversationId === "string"
      ? dto._conversationId.trim()
      : ""
  }

  private getExecutionSessionId(dto: CreateMessageDto): string {
    return this.getConversationId(dto)
  }

  private shouldRetrySessionWebSocketError(error: unknown): boolean {
    if (error instanceof CodexWebSocketUpgradeError) {
      return false
    }

    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error)

    return (
      message.includes("websocket is not open") ||
      message.includes("readystate") ||
      message.includes("socket has been closed")
    )
  }

  private hashIdentityPart(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)
  }

  private getSlotStickyKey(slot: CodexAccountSlot): string {
    const apiKey = slot.apiKey?.trim()
    if (apiKey) {
      return `api_key:${apiKey}\0base:${slot.baseUrl}`
    }

    const accountId = this.getSlotAccountId(slot).trim()
    if (accountId) {
      return `account_id:${accountId}\0base:${slot.baseUrl}`
    }

    const email = slot.email?.trim().toLowerCase()
    if (email) {
      return `email:${email}\0base:${slot.baseUrl}`
    }

    const refreshToken =
      slot.tokenData?.refreshToken?.trim() || slot.refreshToken?.trim()
    if (refreshToken) {
      return `refresh:${this.hashIdentityPart(refreshToken)}\0base:${slot.baseUrl}`
    }

    const accessToken =
      slot.tokenData?.accessToken?.trim() || slot.accessToken?.trim()
    if (accessToken) {
      return `access:${this.hashIdentityPart(accessToken)}\0base:${slot.baseUrl}`
    }

    return `label:${slot.label || ""}\0base:${slot.baseUrl}`
  }

  private purgeExpiredConversationBindings(now: number = Date.now()): void {
    for (const [conversationId, binding] of this.conversationSlotBindings) {
      if (binding.expire <= now) {
        this.conversationSlotBindings.delete(conversationId)
      }
    }
  }

  private bindConversationToSlot(
    conversationId: string,
    slot: CodexAccountSlot
  ): void {
    const normalizedConversationId = conversationId.trim()
    if (!normalizedConversationId) return

    this.purgeExpiredConversationBindings()
    this.conversationSlotBindings.set(normalizedConversationId, {
      slotKey: this.getSlotStickyKey(slot),
      expire: Date.now() + this.CONVERSATION_SLOT_TTL_MS,
    })
  }

  private getStickyConversationSlot(
    conversationId: string,
    modelName: string
  ): CodexAccountSlot | null {
    const normalizedConversationId = conversationId.trim()
    if (!normalizedConversationId) {
      return null
    }

    const now = Date.now()
    this.purgeExpiredConversationBindings(now)

    const binding = this.conversationSlotBindings.get(normalizedConversationId)
    if (!binding) {
      return null
    }

    const normalizedModelName = modelName.toLowerCase().trim()
    const slot =
      this.accounts.find(
        (candidate) => this.getSlotStickyKey(candidate) === binding.slotKey
      ) || null

    if (
      !slot ||
      !this.isModelSupportedBySlot(slot, normalizedModelName) ||
      !this.isSlotAvailableForModel(slot, normalizedModelName, now)
    ) {
      this.conversationSlotBindings.delete(normalizedConversationId)
      return null
    }

    binding.expire = now + this.CONVERSATION_SLOT_TTL_MS
    this.conversationSlotBindings.set(normalizedConversationId, binding)
    return slot
  }

  private getOAuthCacheIdentity(
    dto: CreateMessageDto,
    slot: CodexAccountSlot
  ): string {
    const slotKey = this.getSlotStickyKey(slot)
    const conversationId = this.getConversationId(dto)

    if (conversationId) {
      return `oauth:${slotKey}:conversation:${conversationId}:model:${dto.model}`
    }

    return `oauth:${slotKey}:model:${dto.model}`
  }

  private isModelSupportedBySlot(
    slot: CodexAccountSlot,
    modelName: string
  ): boolean {
    if (this.isApiKeyMode(slot)) {
      return true
    }

    const tier = this.getSlotPlanType(slot) || this.getModelTier() || "pro"
    return (
      isChatGptCodexModelSupported(modelName) &&
      supportsCodexModelForTier(modelName, tier)
    )
  }

  private hasSupportingAccount(modelName: string): boolean {
    const normalized = modelName.toLowerCase().trim()
    if (!normalized) {
      return false
    }

    return this.accounts.some(
      (slot) =>
        !isAccountDisabled(slot) &&
        this.isModelSupportedBySlot(slot, normalized)
    )
  }

  private getAccountLabel(slot: CodexAccountSlot): string {
    const base = slot.label || slot.email || slot.accountId || "slot"
    const details: string[] = []

    if (slot.accountId) {
      details.push(slot.accountId.slice(0, 8))
    } else if (slot.workspaceId) {
      details.push(`ws:${slot.workspaceId.slice(0, 8)}`)
    } else {
      details.push(slot.source)
    }

    if (slot.planType) {
      details.push(slot.planType)
    }

    return `${base} (${details.join(", ")})`
  }

  private getLoadedRecordReloadKey(
    account: LoadedCodexAccountRecord,
    fallbackBaseUrl: string,
    index: number
  ): string {
    const baseUrl =
      (account.baseUrl || fallbackBaseUrl).trim() || DEFAULT_BASE_URL
    return this.getNormalizedReloadKey({
      apiKey: account.apiKey,
      email: account.email,
      accountId: account.accountId,
      refreshToken: account.refreshToken,
      accessToken: account.accessToken,
      baseUrl,
      configPath: account.configPath,
      index,
    })
  }

  private getFileSlotReloadKey(slot: CodexAccountSlot): string {
    return this.getNormalizedReloadKey({
      apiKey: slot.apiKey,
      email: slot.email,
      accountId: slot.accountId,
      refreshToken: slot.refreshToken || slot.tokenData?.refreshToken,
      accessToken: slot.accessToken || slot.tokenData?.accessToken,
      baseUrl: slot.baseUrl,
      configPath: slot.configPath,
      index: 0,
    })
  }

  private getNormalizedReloadKey(identity: {
    apiKey?: string
    email?: string
    accountId?: string
    refreshToken?: string
    accessToken?: string
    baseUrl?: string
    configPath?: string
    index: number
  }): string {
    const baseUrl = identity.baseUrl?.trim() || DEFAULT_BASE_URL
    const email = identity.email?.trim().toLowerCase() || ""
    const accountId = identity.accountId?.trim() || ""
    const apiKey = identity.apiKey?.trim() || ""
    const refreshToken = identity.refreshToken?.trim() || ""
    const accessToken = identity.accessToken?.trim() || ""

    if (email && accountId) {
      return `email:${email}:${accountId}\0base:${baseUrl}`
    }
    if (email && refreshToken) {
      return `email_refresh:${email}:${this.hashIdentityPart(refreshToken)}\0base:${baseUrl}`
    }
    if (email && accessToken) {
      return `email_access:${email}:${this.hashIdentityPart(accessToken)}\0base:${baseUrl}`
    }
    if (email) {
      return `email:${email}\0base:${baseUrl}`
    }
    if (apiKey) {
      return `api_key:${apiKey}\0base:${baseUrl}`
    }
    if (refreshToken) {
      return `refresh:${this.hashIdentityPart(refreshToken)}\0base:${baseUrl}`
    }
    if (accessToken) {
      return `access:${this.hashIdentityPart(accessToken)}\0base:${baseUrl}`
    }
    if (accountId) {
      return `account_id:${accountId}\0base:${baseUrl}`
    }

    return `path:${identity.configPath || ""}:${identity.index}\0base:${baseUrl}`
  }

  private createFileSlotFromLoadedRecord(
    record: LoadedCodexAccountRecord,
    fallbackBaseUrl: string,
    fallbackProxyUrl: string
  ): CodexAccountSlot {
    const slot: CodexAccountSlot = {
      label: record.label || record.email || undefined,
      apiKey: record.apiKey || undefined,
      accessToken: record.accessToken || undefined,
      refreshToken: record.refreshToken || undefined,
      accountId: record.accountId || undefined,
      workspaceId: record.workspaceId || undefined,
      email: record.email || undefined,
      planType: normalizeCodexModelTier(record.planType) || undefined,
      baseUrl: record.baseUrl || fallbackBaseUrl,
      proxyUrl: record.proxyUrl || fallbackProxyUrl || undefined,
      configPath: record.configPath,
      source: "file",
      tokenData: null,
      cooldownUntil: 0,
      modelStates: new Map(),
      rateLimitSnapshots: new Map(),
      persistedMatch: {
        apiKey: record.apiKey || undefined,
        email: record.email || undefined,
        accountId: record.accountId || undefined,
        accessToken: record.accessToken || undefined,
        refreshToken: record.refreshToken || undefined,
      },
    }

    if (record.accessToken || record.refreshToken || record.idToken) {
      this.applyTokenDataToSlot(
        slot,
        this.hydrateTokenData({
          idToken: record.idToken || "",
          accessToken: record.accessToken || "",
          refreshToken: record.refreshToken || "",
          accountId: record.accountId || "",
          workspaceId: record.workspaceId || "",
          email: record.email || "",
          expire: record.expire || "",
        })
      )
    }

    return slot
  }

  private refreshFileSlotFromRecord(
    slot: CodexAccountSlot,
    record: LoadedCodexAccountRecord,
    fallbackBaseUrl: string,
    fallbackProxyUrl: string
  ): void {
    slot.label = record.label || record.email || undefined
    slot.apiKey = record.apiKey || undefined
    slot.accountId = record.accountId || undefined
    slot.workspaceId = record.workspaceId || undefined
    slot.email = record.email || undefined
    slot.planType = normalizeCodexModelTier(record.planType) || undefined
    slot.baseUrl = record.baseUrl || fallbackBaseUrl
    slot.proxyUrl = record.proxyUrl || fallbackProxyUrl || undefined
    slot.configPath = record.configPath
    slot.persistedMatch = {
      apiKey: record.apiKey || undefined,
      email: record.email || undefined,
      accountId: record.accountId || undefined,
      accessToken: record.accessToken || undefined,
      refreshToken: record.refreshToken || undefined,
    }

    if (record.accessToken || record.refreshToken || record.idToken) {
      this.applyTokenDataToSlot(
        slot,
        this.hydrateTokenData({
          idToken: record.idToken || "",
          accessToken: record.accessToken || "",
          refreshToken: record.refreshToken || "",
          accountId: record.accountId || "",
          workspaceId: record.workspaceId || "",
          email: record.email || "",
          expire: record.expire || "",
        })
      )
      return
    }

    slot.accessToken = undefined
    slot.refreshToken = undefined
    slot.tokenData = null
    slot.refreshPromise = undefined
  }

  private pruneConversationBindingsForSlots(slots: CodexAccountSlot[]): void {
    if (slots.length === 0 || this.conversationSlotBindings.size === 0) {
      return
    }

    const staleKeys = new Set(slots.map((slot) => this.getSlotStickyKey(slot)))
    for (const [conversationId, binding] of this.conversationSlotBindings) {
      if (staleKeys.has(binding.slotKey)) {
        this.conversationSlotBindings.delete(conversationId)
      }
    }
  }

  private normalizeCodexModelName(modelName: string): string {
    return modelName.toLowerCase().trim()
  }

  private getCodexDisplayModel(modelName: string): string {
    const normalized = this.normalizeCodexModelName(modelName)
    return getPublicModelMetadata(normalized)?.displayName || normalized
  }

  private hasRateLimitData(account: CodexAccountSlot): boolean {
    for (const snapshots of account.rateLimitSnapshots.values()) {
      if (snapshots.request || snapshots.probe) {
        return true
      }
    }
    return false
  }

  private getEffectiveRateLimitSnapshot(
    snapshots?: Partial<Record<CodexRateLimitSource, CodexRateLimitSnapshot>>
  ): CodexRateLimitSnapshot | null {
    if (!snapshots) {
      return null
    }

    if (snapshots.request) {
      return snapshots.request
    }

    return snapshots.probe || null
  }

  private getRateLimitModelSummary(
    account: CodexAccountSlot,
    modelName: string
  ): CodexRateLimitModelSummary | null {
    const normalized = this.normalizeCodexModelName(modelName)
    const snapshots = account.rateLimitSnapshots.get(normalized)
    const effective = this.getEffectiveRateLimitSnapshot(snapshots)

    if (!snapshots && !effective) {
      return null
    }

    const request = snapshots?.request
    const probe = snapshots?.probe
    const updatedAt = Math.max(
      request?.updatedAt || 0,
      probe?.updatedAt || 0,
      effective?.updatedAt || 0
    )

    return {
      model: normalized,
      displayModel: this.getCodexDisplayModel(normalized),
      effective,
      request,
      probe,
      updatedAt,
    }
  }

  private getRateLimitAccountSummary(
    account: CodexAccountSlot
  ): CodexRateLimitAccountSummary | undefined {
    const models = Array.from(account.rateLimitSnapshots.keys())
      .map((modelName) => this.getRateLimitModelSummary(account, modelName))
      .filter(
        (summary): summary is CodexRateLimitModelSummary => summary != null
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)

    if (models.length === 0) {
      return undefined
    }

    const preferred =
      models.find(
        (summary) => summary.model === DEFAULT_CODEX_RATE_LIMIT_MODEL
      ) || null
    const effective = preferred?.effective || models[0]?.effective || null
    const updatedAt = preferred?.updatedAt || models[0]?.updatedAt || null
    return {
      effective,
      models,
      updatedAt,
    }
  }

  private setRateLimitSnapshot(
    slot: CodexAccountSlot,
    snapshot: CodexRateLimitSnapshot
  ): void {
    const normalized = this.normalizeCodexModelName(snapshot.model)
    const existing = slot.rateLimitSnapshots.get(normalized) || {}
    existing[snapshot.source] = {
      ...snapshot,
      model: normalized,
      displayModel: this.getCodexDisplayModel(normalized),
    }
    slot.rateLimitSnapshots.set(normalized, existing)
  }

  private getQuotaRemainingPercent(
    account: CodexAccountSlot,
    tier: "primary" | "secondary",
    modelName: string
  ): number | null {
    const effective = this.getRateLimitModelSummary(
      account,
      modelName
    )?.effective
    const usedPercent = effective?.[tier]?.usedPercent
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
      return null
    }

    return Math.max(0, 100 - usedPercent)
  }

  private getQuotaCooldownUntil(
    account: CodexAccountSlot,
    tier: "primary" | "secondary",
    modelName: string
  ): number {
    const effective = this.getRateLimitModelSummary(
      account,
      modelName
    )?.effective
    const remainingPercent = this.getQuotaRemainingPercent(
      account,
      tier,
      modelName
    )
    const resetsAt = effective?.[tier]?.resetsAt

    if (
      remainingPercent === null ||
      remainingPercent >= 1 ||
      typeof resetsAt !== "number" ||
      !Number.isFinite(resetsAt)
    ) {
      return 0
    }

    return resetsAt * 1000
  }

  private getWeeklyQuotaCooldownUntil(
    account: CodexAccountSlot,
    modelName: string
  ): number {
    return this.getQuotaCooldownUntil(account, "secondary", modelName)
  }

  private getPrimaryQuotaCooldownUntil(
    account: CodexAccountSlot,
    modelName: string
  ): number {
    return this.getQuotaCooldownUntil(account, "primary", modelName)
  }

  private getRateLimitQuotaCooldownUntil(
    snapshot: CodexRateLimitSnapshot | null,
    now: number
  ): number {
    if (!snapshot) {
      return 0
    }

    const windows = [snapshot.primary, snapshot.secondary]
    const activeResets = windows
      .map((window) => {
        if (!window) {
          return 0
        }
        const remainingPercent = Math.max(0, 100 - window.usedPercent)
        if (
          remainingPercent >= 1 ||
          typeof window.resetsAt !== "number" ||
          !Number.isFinite(window.resetsAt)
        ) {
          return 0
        }
        return window.resetsAt * 1000
      })
      .filter((cooldownUntil) => cooldownUntil > now)

    return activeResets.length > 0 ? Math.max(...activeResets) : 0
  }

  private isRateLimitExhaustedForModel(
    slot: CodexAccountSlot,
    model: string
  ): boolean {
    const primaryRemaining = this.getQuotaRemainingPercent(
      slot,
      "primary",
      model
    )
    if (primaryRemaining != null && primaryRemaining < 1) {
      return true
    }

    const secondaryRemaining = this.getQuotaRemainingPercent(
      slot,
      "secondary",
      model
    )
    if (secondaryRemaining != null && secondaryRemaining < 1) {
      return true
    }

    return false
  }

  private isSlotAvailableForModel(
    slot: CodexAccountSlot,
    model: string,
    now: number
  ): boolean {
    if (this.isRateLimitExhaustedForModel(slot, model)) {
      return false
    }

    const weeklyQuotaCooldownUntil = this.getWeeklyQuotaCooldownUntil(
      slot,
      model
    )
    if (weeklyQuotaCooldownUntil > now) {
      return false
    }

    const primaryQuotaCooldownUntil = this.getPrimaryQuotaCooldownUntil(
      slot,
      model
    )
    if (primaryQuotaCooldownUntil > now) {
      return false
    }

    return isAccountAvailableForModel(slot, model, now)
  }

  private getSlotRecoveryTimeForModel(
    slot: CodexAccountSlot,
    model: string,
    now: number
  ): number | null {
    if (isAccountDisabled(slot) || !this.isModelSupportedBySlot(slot, model)) {
      return null
    }

    const recoveryCandidates: number[] = []

    if (slot.cooldownUntil > now) {
      recoveryCandidates.push(slot.cooldownUntil)
    }

    const modelState = slot.modelStates.get(model)
    if (modelState?.cooldownUntil && modelState.cooldownUntil > now) {
      recoveryCandidates.push(modelState.cooldownUntil)
    }

    const primaryQuotaCooldownUntil = this.getPrimaryQuotaCooldownUntil(
      slot,
      model
    )
    if (primaryQuotaCooldownUntil > now) {
      recoveryCandidates.push(primaryQuotaCooldownUntil)
    }

    const weeklyQuotaCooldownUntil = this.getWeeklyQuotaCooldownUntil(
      slot,
      model
    )
    if (weeklyQuotaCooldownUntil > now) {
      recoveryCandidates.push(weeklyQuotaCooldownUntil)
    }

    if (recoveryCandidates.length === 0) {
      return null
    }

    return Math.max(...recoveryCandidates)
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

    const activeQuotaCooldowns = Array.from(account.rateLimitSnapshots.values())
      .map((snapshots) =>
        this.getRateLimitQuotaCooldownUntil(
          this.getEffectiveRateLimitSnapshot(snapshots),
          now
        )
      )
      .filter((cooldownUntil) => cooldownUntil > now)

    if (activeQuotaCooldowns.length > 0) {
      account.cooldownUntil = Math.max(
        account.cooldownUntil,
        ...activeQuotaCooldowns
      )
    }

    if (account.cooldownUntil > now) {
      return "cooldown"
    }
    if (modelCooldowns.length > 0) {
      return "model_cooldown"
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
    const now = Date.now()
    const normalized = model.toLowerCase().trim()

    for (let offset = 0; offset < this.accounts.length; offset++) {
      const index = (this.accountIndex + offset) % this.accounts.length
      const slot = this.accounts[index]!

      if (!this.isModelSupportedBySlot(slot, normalized)) {
        continue
      }

      if (this.isSlotAvailableForModel(slot, normalized, now)) {
        this.accountIndex = (index + 1) % this.accounts.length
        return slot
      }
    }

    this.logger.warn(
      `[Codex] All supporting account(s) are in cooldown for model=${normalized}`
    )
    return null
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
      const filePath =
        slot.configPath || this.accountsFilePath || CODEX_ACCOUNTS_DEFAULT_PATH
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
        workspaceId:
          slot.workspaceId || slot.tokenData.workspaceId || undefined,
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
      slot.configPath = filePath
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
   * Build request headers matching CLIProxyAPI Codex behavior.
   */
  private buildHeaders(
    slot: CodexAccountSlot,
    token: string,
    stream: boolean,
    cacheHeaders?: Record<string, string>,
    options?: {
      omitAccountId?: boolean
      forwardHeaders?: CodexForwardHeaders
    }
  ): Record<string, string> {
    return buildCodexHttpHeaders({
      token,
      isApiKey: this.isApiKeyMode(slot),
      accountId: this.getSlotAccountId(slot),
      workspaceId: slot.workspaceId,
      stream,
      cacheHeaders,
      forwardHeaders: options?.forwardHeaders,
      omitAccountId: options?.omitAccountId,
    })
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

  private extractErrorCode(errorBody: string): string | null {
    const trimmed = errorBody.trim()
    if (!trimmed) {
      return null
    }

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const detail =
        parsed.detail && typeof parsed.detail === "object"
          ? (parsed.detail as Record<string, unknown>)
          : undefined
      const error =
        parsed.error && typeof parsed.error === "object"
          ? (parsed.error as Record<string, unknown>)
          : undefined

      const code = detail?.code ?? error?.code
      return typeof code === "string" && code.trim() ? code.trim() : null
    } catch {
      return null
    }
  }

  private isDeactivatedWorkspaceError(errorBody: string): boolean {
    return this.extractErrorCode(errorBody) === "deactivated_workspace"
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

  private toNumber(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : 0
    }
    return 0
  }

  private parseCodexSsePayload(line: string): Record<string, unknown> | null {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) {
      return null
    }

    const jsonStr = trimmed.slice(5).trim()
    if (!jsonStr || jsonStr === "[DONE]") {
      return null
    }

    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>
      return parsed && typeof parsed === "object" ? parsed : null
    } catch {
      return null
    }
  }

  private logCodexUsage(
    transport: "http" | "websocket",
    modelName: string,
    cacheId: string,
    slot: CodexAccountSlot,
    event: Record<string, unknown> | null,
    requestStartedAt?: number
  ): void {
    if (!event || event.type !== "response.completed") {
      return
    }

    const response =
      event.response && typeof event.response === "object"
        ? (event.response as Record<string, unknown>)
        : null
    const usage =
      response?.usage && typeof response.usage === "object"
        ? (response.usage as Record<string, unknown>)
        : null

    const totalInputTokens = this.toNumber(usage?.input_tokens)
    const outputTokens = this.toNumber(usage?.output_tokens)
    const cachedTokens =
      usage?.input_tokens_details &&
      typeof usage.input_tokens_details === "object"
        ? this.toNumber(
            (usage.input_tokens_details as Record<string, unknown>)
              .cached_tokens
          )
        : 0
    const cacheCreationTokens =
      typeof usage?.cache_creation_input_tokens === "number"
        ? this.toNumber(usage.cache_creation_input_tokens)
        : 0
    const webSearchRequests =
      usage?.server_tool_use &&
      typeof usage.server_tool_use === "object" &&
      typeof (usage.server_tool_use as Record<string, unknown>)
        .web_search_requests === "number"
        ? this.toNumber(
            (usage.server_tool_use as Record<string, unknown>)
              .web_search_requests
          )
        : 0
    const inputTokens = Math.max(0, totalInputTokens - cachedTokens)
    const durationMs =
      typeof requestStartedAt === "number"
        ? Math.max(0, Date.now() - requestStartedAt)
        : 0

    const message =
      `[Codex][Cache] transport=${transport} model=${modelName} ` +
      `cache=${cacheId || "(none)"} input=${inputTokens} ` +
      `cached=${cachedTokens} cacheWrite=${cacheCreationTokens} ` +
      `output=${outputTokens} duration=${durationMs}ms`

    this.usageStats.recordCodexUsage({
      transport,
      modelName,
      accountKey: this.getSlotStickyKey(slot),
      accountLabel: this.getAccountLabel(slot),
      inputTokens,
      cachedInputTokens: cachedTokens,
      cacheCreationInputTokens: cacheCreationTokens,
      outputTokens,
      webSearchRequests,
      durationMs,
    })

    if (cachedTokens > 0) {
      this.logger.log(message)
      return
    }

    this.logger.debug(message)
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
    const metadata = dto as unknown as {
      metadata?: { user_id?: string }
    }
    const userId = metadata?.metadata?.user_id?.trim()

    if (userId) {
      return this.cacheService.getOrCreateCacheId(dto.model, userId)
    }

    if (slot.apiKey) {
      return this.cacheService.getCacheIdFromApiKey(slot.apiKey)
    }

    return this.cacheService.getCacheIdFromIdentity(
      this.getOAuthCacheIdentity(dto, slot)
    )
  }

  private createAllAccountsRateLimitedError(modelName: string): CodexApiError {
    const now = Date.now()
    const normalizedModelName = modelName.toLowerCase().trim()
    let earliestRecovery = Infinity

    for (const slot of this.accounts) {
      const slotRecovery = this.getSlotRecoveryTimeForModel(
        slot,
        normalizedModelName,
        now
      )
      if (slotRecovery != null) {
        earliestRecovery = Math.min(earliestRecovery, slotRecovery)
      }
    }

    const retryAfterMs = Number.isFinite(earliestRecovery)
      ? Math.max(0, earliestRecovery - now)
      : 0
    const retrySeconds = retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : 60
    return new CodexApiError(
      429,
      `All Codex accounts are rate-limited for model ${modelName}. ` +
        `Retry after ${retrySeconds} seconds.`,
      retrySeconds
    )
  }

  private selectRequestSlot(
    modelName: string,
    conversationId?: string
  ): CodexAccountSlot {
    if (this.accounts.length === 0) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    if (!this.hasSupportingAccount(modelName)) {
      throw new CodexApiError(
        400,
        `Model ${modelName} is not supported by the configured Codex account(s).`
      )
    }

    if (conversationId) {
      const stickySlot = this.getStickyConversationSlot(
        conversationId,
        modelName
      )
      if (stickySlot) {
        return stickySlot
      }
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
  async sendClaudeMessage(
    dto: CreateMessageDto,
    forwardHeaders?: CodexForwardHeaders
  ): Promise<AnthropicResponse> {
    return this.executeWithCooldownRetry(dto, forwardHeaders, 1)
  }

  /**
   * Core execution logic with cooldown-aware account selection and
   * automatic retry on 429 (switches to next available account).
   */
  private async executeWithCooldownRetry(
    dto: CreateMessageDto,
    forwardHeaders?: CodexForwardHeaders,
    attempt: number = 1,
    slot: CodexAccountSlot = this.selectRequestSlot(
      dto.model,
      this.getConversationId(dto)
    )
  ): Promise<AnthropicResponse> {
    const modelName = dto.model
    const token = await this.getBearerToken(slot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    this.bindConversationToSlot(this.getConversationId(dto), slot)

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

      // Try WebSocket transport first when enabled.
      if (this.useWebSocket && this.wsService.isWebSocketAvailable()) {
        try {
          result = await this.sendViaWebSocket(
            slot,
            token,
            codexRequest,
            modelName,
            reverseToolMap,
            cacheId,
            dto,
            forwardHeaders
          )
        } catch (e) {
          if (e instanceof CodexWebSocketUpgradeError) {
            if (
              !this.isApiKeyMode(slot) &&
              this.isDeactivatedWorkspaceError(e.body)
            ) {
              this.logger.warn(
                `[Codex] WebSocket returned deactivated_workspace for ${this.getAccountLabel(slot)}, retrying over HTTP without Chatgpt-Account-Id`
              )
              result = await this.sendViaHttp(
                slot,
                token,
                codexRequest,
                modelName,
                reverseToolMap,
                cacheId,
                true,
                forwardHeaders
              )
            } else if (e.shouldFallbackToHttp()) {
              this.logger.warn(
                "WebSocket upgrade rejected, falling back to HTTP"
              )
              result = await this.sendViaHttp(
                slot,
                token,
                codexRequest,
                modelName,
                reverseToolMap,
                cacheId,
                false,
                forwardHeaders
              )
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
      } else {
        result = await this.sendViaHttp(
          slot,
          token,
          codexRequest,
          modelName,
          reverseToolMap,
          cacheId,
          false,
          forwardHeaders
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

        // Auto-retry on 429 if another account is available
        if (statusCode === 429 && attempt < this.accounts.length) {
          const nextSlot = this.pickNextAvailableAccount(modelName)
          if (nextSlot && nextSlot !== slot) {
            this.logger.log(
              `[Codex] 429 on ${this.getAccountLabel(slot)}, retrying with ${this.getAccountLabel(nextSlot)} (attempt ${attempt + 1}/${this.accounts.length})`
            )
            return this.executeWithCooldownRetry(
              dto,
              forwardHeaders,
              attempt + 1,
              nextSlot
            )
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
    cacheId: string,
    omitAccountId: boolean = false,
    forwardHeaders?: CodexForwardHeaders
  ): Promise<AnthropicResponse> {
    const requestStartedAt = Date.now()
    const requestBody = JSON.stringify(codexRequest)
    const url = this.buildUrl(slot, "responses")
    const cacheHeaders = this.cacheService.buildHttpCacheHeaders(cacheId)
    const headers = this.buildHeaders(slot, token, true, cacheHeaders, {
      omitAccountId,
      forwardHeaders,
    })

    this.logger.log(
      `[Codex][Dispatch] slot=${this.getAccountLabel(slot)} model=${modelName} transport=http omitAccountId=${omitAccountId} accountId=${JSON.stringify(this.getSlotAccountId(slot) || null)} workspaceId=${JSON.stringify(slot.workspaceId || null)} orgHeader=${JSON.stringify(headers["OpenAI-Organization"] || null)} accountHeader=${JSON.stringify(headers["Chatgpt-Account-Id"] || null)}`
    )
    this.logger.log(
      `[Codex] Non-stream request: model=${modelName}, url=${url}, reasoning=${JSON.stringify((codexRequest as { reasoning?: unknown }).reasoning ?? null)}, service_tier=${JSON.stringify((codexRequest as { service_tier?: unknown }).service_tier ?? null)}`
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

      if (
        !omitAccountId &&
        !this.isApiKeyMode(slot) &&
        this.isDeactivatedWorkspaceError(errorBody)
      ) {
        this.logger.warn(
          `[Codex] deactivated_workspace for ${this.getAccountLabel(slot)}, retrying without Chatgpt-Account-Id`
        )
        return this.sendViaHttp(
          slot,
          token,
          codexRequest,
          modelName,
          reverseToolMap,
          cacheId,
          true,
          forwardHeaders
        )
      }

      throw this.createCodexApiError(response.status, errorBody)
    }

    // Read the full SSE stream and find response.completed
    this.captureCodexRateLimitHeaders(
      response.headers,
      slot,
      modelName,
      "request"
    )
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
          this.logCodexUsage(
            "http",
            modelName,
            cacheId,
            slot,
            event,
            requestStartedAt
          )
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
    cacheId: string,
    dto: CreateMessageDto,
    forwardHeaders?: CodexForwardHeaders
  ): Promise<AnthropicResponse> {
    const requestStartedAt = Date.now()
    const httpUrl = this.buildUrl(slot, "responses")
    const wsUrl = this.wsService.buildWebSocketUrl(httpUrl)
    const cacheHeaders = this.cacheService.buildWebSocketCacheHeaders(cacheId)
    const wsHeaders = this.wsService.buildWebSocketHeaders(
      token,
      this.isApiKeyMode(slot),
      this.getSlotAccountId(slot),
      slot.workspaceId,
      cacheHeaders,
      forwardHeaders
    )
    const wsBody = this.wsService.buildWebSocketRequestBody(codexRequest)
    const sessionId = this.getExecutionSessionId(dto)

    this.logger.log(
      `[Codex][Dispatch] slot=${this.getAccountLabel(slot)} model=${modelName} transport=websocket omitAccountId=false accountId=${JSON.stringify(this.getSlotAccountId(slot) || null)} workspaceId=${JSON.stringify(slot.workspaceId || null)} orgHeader=${JSON.stringify(wsHeaders["OpenAI-Organization"] || null)} accountHeader=${JSON.stringify(wsHeaders["Chatgpt-Account-Id"] || null)}`
    )
    this.logger.log(
      `[Codex] WebSocket non-stream request: model=${modelName}, url=${wsUrl}`
    )

    const executeRequest = async (
      ws: WebSocket
    ): Promise<AnthropicResponse> => {
      const completedEvent = await this.wsService.sendViaWebSocket(ws, wsBody)
      this.logCodexUsage(
        "websocket",
        modelName,
        cacheId,
        slot,
        completedEvent as Record<string, unknown>,
        requestStartedAt
      )

      const result = translateCodexToClaudeNonStream(
        completedEvent as Record<string, unknown>,
        reverseToolMap
      )
      if (!result) {
        throw new Error("WebSocket response did not contain valid completion")
      }

      this.logger.log(
        `[Codex] WebSocket non-stream response: model=${result.model}, stop=${result.stop_reason}`
      )
      return result
    }

    if (!sessionId) {
      const ws = await this.wsService.connect(
        wsUrl,
        wsHeaders,
        slot.proxyUrl || undefined
      )
      try {
        return await executeRequest(ws)
      } finally {
        ws.close()
      }
    }

    const { release } = await this.wsService.acquireSession(sessionId)
    try {
      let ws = await this.wsService.ensureSessionConnection(
        sessionId,
        wsUrl,
        wsHeaders,
        slot.proxyUrl || undefined
      )

      try {
        return await executeRequest(ws)
      } catch (error) {
        if (!this.shouldRetrySessionWebSocketError(error)) {
          throw error
        }

        this.logger.warn(
          `[Codex] Reconnecting stale WebSocket session ${sessionId} before retry`
        )
        this.wsService.invalidateSessionConnection(sessionId, ws)
        ws = await this.wsService.ensureSessionConnection(
          sessionId,
          wsUrl,
          wsHeaders,
          slot.proxyUrl || undefined
        )
        return executeRequest(ws)
      }
    } finally {
      release()
    }
  }

  // ── Streaming ────────────────────────────────────────────────────────

  /**
   * Send a streaming message through Codex.
   * Returns an async generator yielding Claude SSE event strings.
   */
  async *sendClaudeMessageStream(
    dto: CreateMessageDto,
    forwardHeadersOrAbortSignal?: CodexForwardHeaders | AbortSignal,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const forwardHeaders =
      forwardHeadersOrAbortSignal instanceof AbortSignal
        ? undefined
        : forwardHeadersOrAbortSignal
    const resolvedAbortSignal =
      forwardHeadersOrAbortSignal instanceof AbortSignal
        ? forwardHeadersOrAbortSignal
        : abortSignal

    yield* this.executeStreamWithCooldownRetry(
      dto,
      forwardHeaders,
      resolvedAbortSignal,
      1
    )
  }

  private async *executeStreamWithCooldownRetry(
    dto: CreateMessageDto,
    forwardHeaders?: CodexForwardHeaders,
    abortSignal?: AbortSignal,
    attempt: number = 1,
    slot: CodexAccountSlot = this.selectRequestSlot(
      dto.model,
      this.getConversationId(dto)
    )
  ): AsyncGenerator<string, void, unknown> {
    const modelName = dto.model
    const token = await this.getBearerToken(slot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    this.bindConversationToSlot(this.getConversationId(dto), slot)

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
      // Try WebSocket transport first when enabled.
      if (this.useWebSocket && this.wsService.isWebSocketAvailable()) {
        try {
          for await (const event of this.streamViaWebSocket(
            slot,
            token,
            codexRequest,
            modelName,
            reverseToolMap,
            cacheId,
            dto,
            forwardHeaders,
            abortSignal
          )) {
            emittedEvents = true
            yield event
          }
          markAccountSuccess(slot, modelName)
          return
        } catch (e) {
          const abortedError = toUpstreamRequestAbortedError(
            e,
            abortSignal,
            "Codex WebSocket stream aborted"
          )
          if (abortedError) {
            throw abortedError
          }

          if (e instanceof CodexWebSocketUpgradeError) {
            if (
              !this.isApiKeyMode(slot) &&
              this.isDeactivatedWorkspaceError(e.body)
            ) {
              this.logger.warn(
                `[Codex] WebSocket returned deactivated_workspace for ${this.getAccountLabel(slot)}, retrying stream over HTTP without Chatgpt-Account-Id`
              )
              for await (const event of this.streamViaHttp(
                slot,
                token,
                codexRequest,
                modelName,
                reverseToolMap,
                cacheId,
                true,
                forwardHeaders,
                abortSignal
              )) {
                emittedEvents = true
                yield event
              }
              markAccountSuccess(slot, modelName)
              return
            }

            if (e.shouldFallbackToHttp()) {
              this.logger.warn(
                "WebSocket upgrade rejected, falling back to HTTP for streaming"
              )
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
        cacheId,
        false,
        forwardHeaders,
        abortSignal
      )) {
        emittedEvents = true
        yield event
      }
      markAccountSuccess(slot, modelName)
    } catch (e) {
      const abortedError = toUpstreamRequestAbortedError(
        e,
        abortSignal,
        "Codex stream aborted"
      )
      if (abortedError) {
        throw abortedError
      }

      if (e instanceof CodexApiError) {
        const statusCode = e.getStatus()
        markAccountCooldown(
          slot,
          statusCode,
          modelName,
          e.retryAfterSeconds?.toString(),
          this.getAccountLabel(slot)
        )

        // Auto-retry on 429 if another account is available
        if (
          statusCode === 429 &&
          attempt < this.accounts.length &&
          !emittedEvents
        ) {
          const nextSlot = this.pickNextAvailableAccount(modelName)
          if (nextSlot && nextSlot !== slot) {
            this.logger.log(
              `[Codex] 429 on ${this.getAccountLabel(slot)}, retrying streamed request with ${this.getAccountLabel(nextSlot)} (attempt ${attempt + 1}/${this.accounts.length})`
            )
            yield* this.executeStreamWithCooldownRetry(
              dto,
              forwardHeaders,
              abortSignal,
              attempt + 1,
              nextSlot
            )
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
    cacheId: string,
    omitAccountId: boolean = false,
    forwardHeaders?: CodexForwardHeaders,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const requestStartedAt = Date.now()
    const requestBody = JSON.stringify(codexRequest)
    const url = this.buildUrl(slot, "responses")
    const cacheHeaders = this.cacheService.buildHttpCacheHeaders(cacheId)
    const headers = this.buildHeaders(slot, token, true, cacheHeaders, {
      omitAccountId,
      forwardHeaders,
    })

    this.logger.log(
      `[Codex][Dispatch] slot=${this.getAccountLabel(slot)} model=${modelName} transport=http-stream omitAccountId=${omitAccountId} accountId=${JSON.stringify(this.getSlotAccountId(slot) || null)} workspaceId=${JSON.stringify(slot.workspaceId || null)} orgHeader=${JSON.stringify(headers["OpenAI-Organization"] || null)} accountHeader=${JSON.stringify(headers["Chatgpt-Account-Id"] || null)}`
    )
    this.logger.log(
      `[Codex] Stream request: model=${modelName}, url=${url}, reasoning=${JSON.stringify((codexRequest as { reasoning?: unknown }).reasoning ?? null)}, service_tier=${JSON.stringify((codexRequest as { service_tier?: unknown }).service_tier ?? null)}`
    )

    const requestSignal = createAbortSignalWithTimeout(600_000, abortSignal)
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: requestBody,
      signal: requestSignal.signal,
    }

    const agent = this.buildProxyAgent(slot)
    if (agent) {
      fetchOptions.dispatcher = agent
    }

    const state = createStreamState()

    try {
      const response = await fetch(url, fetchOptions)

      if (!response.ok) {
        const errorBody = await response.text()
        this.logger.error(
          `[Codex] Stream request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
        )

        if (
          !omitAccountId &&
          !this.isApiKeyMode(slot) &&
          this.isDeactivatedWorkspaceError(errorBody)
        ) {
          this.logger.warn(
            `[Codex] deactivated_workspace for ${this.getAccountLabel(slot)}, retrying stream without Chatgpt-Account-Id`
          )
          yield* this.streamViaHttp(
            slot,
            token,
            codexRequest,
            modelName,
            reverseToolMap,
            cacheId,
            true,
            forwardHeaders,
            abortSignal
          )
          return
        }

        throw this.createCodexApiError(response.status, errorBody)
      }

      if (!response.body) {
        throw new Error("Codex response has no body")
      }

      // Capture rate-limit headers from successful response
      this.captureCodexRateLimitHeaders(
        response.headers,
        slot,
        modelName,
        "request"
      )

      // Stream SSE events
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      try {
        while (true) {
          const externalAbort = createAbortPromise(
            abortSignal,
            "Codex HTTP stream aborted"
          )
          try {
            const { done, value } = await Promise.race([
              reader.read(),
              ...(externalAbort.promise ? [externalAbort.promise] : []),
            ])
            if (done) break

            buffer += decoder.decode(value, { stream: true })

            const lines = buffer.split("\n")
            buffer = lines.pop() || ""

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed) continue

              this.logCodexUsage(
                "http",
                modelName,
                cacheId,
                slot,
                this.parseCodexSsePayload(trimmed),
                requestStartedAt
              )

              const claudeEvents = translateCodexSseEvent(
                trimmed,
                state,
                reverseToolMap
              )
              for (const event of claudeEvents) {
                yield event
              }
            }
          } finally {
            externalAbort.cleanup()
          }
        }

        // Process remaining buffer
        if (buffer.trim()) {
          this.logCodexUsage(
            "http",
            modelName,
            cacheId,
            slot,
            this.parseCodexSsePayload(buffer.trim()),
            requestStartedAt
          )
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
    } catch (error) {
      if (requestSignal.didTimeout()) {
        throw new Error(
          "Codex stream timed out waiting for upstream response after 600000ms"
        )
      }
      const abortedError = toUpstreamRequestAbortedError(
        error,
        abortSignal,
        "Codex HTTP stream aborted"
      )
      if (abortedError) {
        throw abortedError
      }
      throw error
    } finally {
      requestSignal.cleanup()
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
    cacheId: string,
    dto: CreateMessageDto,
    forwardHeaders?: CodexForwardHeaders,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const requestStartedAt = Date.now()
    const httpUrl = this.buildUrl(slot, "responses")
    const wsUrl = this.wsService.buildWebSocketUrl(httpUrl)
    const cacheHeaders = this.cacheService.buildWebSocketCacheHeaders(cacheId)
    const wsHeaders = this.wsService.buildWebSocketHeaders(
      token,
      this.isApiKeyMode(slot),
      this.getSlotAccountId(slot),
      slot.workspaceId,
      cacheHeaders,
      forwardHeaders
    )
    const sessionId = this.getExecutionSessionId(dto)

    this.logger.log(
      `[Codex][Dispatch] slot=${this.getAccountLabel(slot)} model=${modelName} transport=websocket-stream omitAccountId=false accountId=${JSON.stringify(this.getSlotAccountId(slot) || null)} workspaceId=${JSON.stringify(slot.workspaceId || null)} orgHeader=${JSON.stringify(wsHeaders["OpenAI-Organization"] || null)} accountHeader=${JSON.stringify(wsHeaders["Chatgpt-Account-Id"] || null)}`
    )
    this.logger.log(
      `[Codex] WebSocket stream request: model=${modelName}, url=${wsUrl}`
    )

    if (!sessionId) {
      const ws = await this.wsService.connect(
        wsUrl,
        wsHeaders,
        slot.proxyUrl || undefined
      )
      yield* this.streamViaWebSocketConnection(
        ws,
        slot,
        modelName,
        reverseToolMap,
        cacheId,
        codexRequest,
        requestStartedAt,
        "",
        abortSignal
      )
      return
    }

    const { release } = await this.wsService.acquireSession(sessionId)
    try {
      let ws = await this.wsService.ensureSessionConnection(
        sessionId,
        wsUrl,
        wsHeaders,
        slot.proxyUrl || undefined
      )

      try {
        yield* this.streamViaWebSocketConnection(
          ws,
          slot,
          modelName,
          reverseToolMap,
          cacheId,
          codexRequest,
          requestStartedAt,
          sessionId,
          abortSignal
        )
        return
      } catch (error) {
        if (!this.shouldRetrySessionWebSocketError(error)) {
          throw error
        }

        this.logger.warn(
          `[Codex] Reconnecting stale WebSocket session ${sessionId} before streamed retry`
        )
        this.wsService.invalidateSessionConnection(sessionId, ws)
        ws = await this.wsService.ensureSessionConnection(
          sessionId,
          wsUrl,
          wsHeaders,
          slot.proxyUrl || undefined
        )
        yield* this.streamViaWebSocketConnection(
          ws,
          slot,
          modelName,
          reverseToolMap,
          cacheId,
          codexRequest,
          requestStartedAt,
          sessionId,
          abortSignal
        )
      }
    } finally {
      release()
    }
  }

  private async *streamViaWebSocketConnection(
    ws: WebSocket,
    slot: CodexAccountSlot,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string,
    codexRequest: Record<string, unknown>,
    requestStartedAt: number,
    sessionId: string,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const state = createStreamState()
    const onAbort = () => {
      if (sessionId) {
        this.wsService.invalidateSessionConnection(sessionId, ws)
      } else {
        ws.close()
      }
    }

    try {
      if (abortSignal?.aborted) {
        throw new UpstreamRequestAbortedError(
          abortSignal.reason instanceof Error
            ? abortSignal.reason.message
            : "Codex WebSocket stream aborted"
        )
      }

      abortSignal?.addEventListener("abort", onAbort, { once: true })
      const wsBody = this.wsService.buildWebSocketRequestBody(codexRequest)

      for await (const msg of this.wsService.streamViaWebSocket(ws, wsBody)) {
        this.logCodexUsage(
          "websocket",
          modelName,
          cacheId,
          slot,
          msg as Record<string, unknown>,
          requestStartedAt
        )

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

      if (abortSignal?.aborted) {
        throw new UpstreamRequestAbortedError(
          abortSignal.reason instanceof Error
            ? abortSignal.reason.message
            : "Codex WebSocket stream aborted"
        )
      }
    } finally {
      abortSignal?.removeEventListener("abort", onAbort)
      if (!sessionId) {
        ws.close()
      }
    }

    this.logger.log(
      `[Codex] WebSocket stream completed: model=${modelName}, blocks=${state.blockIndex}, hasToolCall=${state.hasToolCall}`
    )
  }

  // ── Rate Limit Header Parsing ───────────────────────────────────────

  /**
   * Parse x-codex-* rate limit headers from Codex API responses.
   * Headers follow the pattern:
   *   x-codex-primary-used-percent / x-codex-primary-window-minutes / x-codex-primary-reset-at
   *   x-codex-secondary-used-percent / x-codex-secondary-window-minutes / x-codex-secondary-reset-at
   */
  private captureCodexRateLimitHeaders(
    headers: Headers,
    slot: CodexAccountSlot,
    modelName: string,
    source: CodexRateLimitSource
  ): void {
    try {
      const primary = this.parseRateLimitWindow(headers, "primary")
      const secondary = this.parseRateLimitWindow(headers, "secondary")

      if (!primary && !secondary) {
        return
      }

      const normalizedModel = this.normalizeCodexModelName(modelName)
      const snapshot: CodexRateLimitSnapshot = {
        model: normalizedModel,
        displayModel: this.getCodexDisplayModel(normalizedModel),
        source,
        updatedAt: Date.now(),
      }
      if (primary) {
        snapshot.primary = primary
      }
      if (secondary) {
        snapshot.secondary = secondary
      }

      this.setRateLimitSnapshot(slot, snapshot)

      const label = this.getAccountLabel(slot)
      const parts: string[] = []
      if (primary) {
        parts.push(this.formatRateLimitWindow("primary", primary))
      }
      if (secondary) {
        parts.push(this.formatRateLimitWindow("secondary", secondary))
      }
      const sourceLabel = source === "request" ? "live" : "healthcheck"
      const message = `[Codex][RateLimit] ${label}: model=${normalizedModel}, source=${sourceLabel}, ${parts.join(", ")}`
      if (
        source === "request" ||
        (source === "probe" &&
          normalizedModel === DEFAULT_CODEX_RATE_LIMIT_MODEL)
      ) {
        this.logger.log(message)
      } else {
        this.logger.debug(message)
      }
    } catch {
      // Non-critical: silently ignore parse failures
    }
  }

  private formatRateLimitWindow(
    tier: "primary" | "secondary",
    window: CodexRateLimitWindow
  ): string {
    const left = Math.max(0, 100 - window.usedPercent).toFixed(0)
    const windowMinutes =
      typeof window.windowMinutes === "number" &&
      Number.isFinite(window.windowMinutes)
        ? `${window.windowMinutes}m`
        : "unknown"
    const resetAt =
      typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)
        ? new Date(window.resetsAt * 1000).toISOString()
        : "unknown"

    return `${tier}=${left}% left (window=${windowMinutes}, resetAt=${resetAt})`
  }

  private parseRateLimitWindow(
    headers: Headers,
    tier: "primary" | "secondary"
  ): CodexRateLimitWindow | null {
    const usedPercentStr = headers.get(`x-codex-${tier}-used-percent`)
    if (!usedPercentStr) {
      return null
    }

    const usedPercent = parseFloat(usedPercentStr)
    if (!Number.isFinite(usedPercent)) {
      return null
    }

    const windowMinutesStr = headers.get(`x-codex-${tier}-window-minutes`)
    const windowMinutes = windowMinutesStr
      ? parseInt(windowMinutesStr, 10)
      : null

    const resetsAtStr = headers.get(`x-codex-${tier}-reset-at`)
    const resetsAt = resetsAtStr ? parseInt(resetsAtStr, 10) : null

    return {
      usedPercent,
      windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : null,
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    }
  }

  // ── Availability ─────────────────────────────────────────────────────

  /**
   * Check if the Codex backend is reachable.
   */
  checkAvailability(): Promise<boolean> {
    return Promise.resolve(this.isAvailable())
  }

  // ── Rate Limit Probing ────────────────────────────────────────────────

  /**
   * Probe rate limits for accounts.
   * When force=false (default), only probes accounts without existing data.
   * When force=true, re-probes all non-disabled accounts to refresh data.
   *
   * Sends a lightweight completions request with max_output_tokens=1 and
   * immediately aborts the stream to capture x-codex-* rate limit headers.
   */
  async probeRateLimits(force = false): Promise<number> {
    if (this.rateLimitProbePromise) {
      return this.rateLimitProbePromise
    }

    this.rateLimitProbePromise = this.runRateLimitProbe(force)
    try {
      return await this.rateLimitProbePromise
    } finally {
      this.rateLimitProbePromise = null
    }
  }

  private async runRateLimitProbe(force = false): Promise<number> {
    const supportedModels = new Set(
      getCodexModelIdsForTier(this.getModelTier())
    )
    const probeModels = supportedModels.has(DEFAULT_CODEX_RATE_LIMIT_MODEL)
      ? [DEFAULT_CODEX_RATE_LIMIT_MODEL]
      : Array.from(supportedModels)
    const slotsToProbe = this.accounts.filter(
      (slot) =>
        (force || !this.hasRateLimitData(slot)) && !isAccountDisabled(slot)
    )

    if (slotsToProbe.length === 0) {
      return 0
    }

    this.logger.log(
      `[Codex] Probing rate limits for ${slotsToProbe.length} account(s) across ${probeModels.length} model(s)...`
    )

    let probed = 0

    // Probe sequentially to avoid parallel token refresh races
    for (const slot of slotsToProbe) {
      const label = this.getAccountLabel(slot)
      try {
        let token = await this.getBearerToken(slot)
        if (!token) {
          this.logger.warn(
            `[Codex] Probe skipped for ${label}: no bearer token`
          )
          continue
        }

        // Send the smallest valid streaming responses request we can. The
        // ChatGPT Codex backend rejects max_output_tokens on this endpoint, but
        // it still returns x-codex-* headers on the initial 200 response.
        // Abort immediately after headers are captured to avoid spending quota.
        const agent = this.buildProxyAgent(slot)

        const doProbe = async (
          bearerToken: string,
          probeModel: string
        ): Promise<Response> => {
          const abortController = new AbortController()
          const timeout = setTimeout(() => abortController.abort(), 15_000)
          const url = this.buildUrl(slot, "responses")
          const headers = this.buildHeaders(slot, bearerToken, true)
          const fetchOptions: RequestInit & { dispatcher?: unknown } = {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: probeModel,
              instructions: "",
              input: [
                {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: "." }],
                },
              ],
              stream: true,
              store: false,
              parallel_tool_calls: false,
              reasoning: { effort: "low", summary: "auto" },
            }),
            signal: abortController.signal,
          }
          if (agent) {
            fetchOptions.dispatcher = agent
          }
          const resp = await fetch(url, fetchOptions)
          // Capture rate limit headers BEFORE aborting the stream
          this.captureCodexRateLimitHeaders(
            resp.headers,
            slot,
            probeModel,
            "probe"
          )
          // Now abort the stream to avoid generating output
          abortController.abort()
          clearTimeout(timeout)
          return resp
        }

        for (const probeModel of probeModels) {
          const response = await doProbe(token, probeModel)

          // If 401/403, force token refresh and retry once
          if (
            (response.status === 401 || response.status === 403) &&
            slot.tokenData?.refreshToken
          ) {
            this.logger.log(
              `[Codex] Probe ${label}: forcing token refresh after HTTP ${response.status}`
            )
            try {
              const refreshed = await this.authService.refreshTokensWithRetry(
                slot.tokenData.refreshToken,
                2,
                { persist: false, updateState: false }
              )
              this.applyTokenDataToSlot(slot, refreshed)
              this.persistSlotTokens(slot)
              if (refreshed.accessToken) {
                token = refreshed.accessToken
                await doProbe(token, probeModel)
              }
            } catch (refreshErr) {
              this.logger.warn(
                `[Codex] Probe ${label}: token refresh failed: ${(refreshErr as Error).message}`
              )
            }
          }

          const summary = this.getRateLimitModelSummary(slot, probeModel)
          if (summary?.probe) {
            this.logger.log(
              `[Codex] Probe ${label}: rate limits captured for model=${probeModel}`
            )
          } else {
            this.logger.warn(
              `[Codex] Probe ${label}: no x-codex-* headers in response for model=${probeModel} (HTTP ${response.status})`
            )
          }
        }
        probed++
      } catch (err) {
        this.logger.warn(
          `[Codex] Rate limit probe failed for ${label}: ${(err as Error).message}`
        )
      }
    }

    this.logger.log(`[Codex] Rate limit probe completed: ${probed} account(s)`)
    return probed
  }
}
