import { readCodexResponseEvents } from "./codex-sse-reader"
import { CodexModelCatalogCache } from "./codex-model-catalog-cache"
import {
  getCodexModelProfile,
  hasRemoteCodexModelCatalog,
} from "./codex-model-catalog"
import { readCodexResponseOutcome } from "./codex-response-outcome"
/**
 * CodexService — Core executor for Codex (OpenAI Responses API) reverse proxy.
 *
 * Handles:
 * - Canonical Codex request execution
 * - HTTP POST to Codex upstream (SSE streaming)
 * - WebSocket transport, with HTTP selected by a later physical attempt
 * - Codex SSE → Claude SSE response translation
 * - Non-streaming mode
 * - Proxy support (HTTP/HTTPS/SOCKS5)
 * - Request header emulation matching CLIProxyAPI Codex behavior
 * - OAuth token management with auto-refresh
 * - Prompt caching via prompt_cache_key
 * - Retry-after decisions reported to the physical-attempt owner
 *
 * Ported from CLIProxyAPI:
 *   - internal/runtime/executor/codex_executor.go
 *   - internal/runtime/executor/codex_websockets_executor.go
 *   - internal/translator/codex/claude/
 */

import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import WebSocket from "ws"
import type { ProviderAdapter } from "../shared/provider-adapter.interface"
import type { AnthropicResponse } from "../../shared/anthropic"
import {
  requireExactDurableIdentifier,
  requireOptionalExactDurableIdentifier,
} from "../../context/durable-identifier"
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
  classifyBackendError,
  RETRY_POLICY,
  type BackendErrorClass,
} from "../shared/backend-error-class"
import {
  type CooldownableAccount,
  clearAccountDisablement,
  disableAccount,
  isAccountAvailableForModel,
  isAccountDisabled,
  markAccountCooldown,
  markAccountSuccess,
} from "../shared/account-cooldown"
import { BackendAccountStateStore } from "../shared/backend-account-state-store"
import { PersistenceService } from "../../persistence"
import {
  BackendPoolStatus,
  type CodexRateLimitAccountSummary,
  type CodexRateLimitModelSummary,
  type CodexRateLimitSnapshot,
  type CodexRateLimitSource,
} from "../shared/backend-pool-status"
import { buildBackendPoolStatus } from "../shared/backend-pool-status-summary"
import {
  assertProviderPhysicalDispatch,
  isProviderAttemptRetryableError,
  ProviderAttemptRetryableError,
  runProviderPhysicalDispatch,
  type ProviderPhysicalDispatch,
} from "../shared/provider-physical-dispatch"
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
import { CodexClientIdentityService } from "./codex-client-identity.service"
import {
  buildCodexStandaloneSearchRequest,
  decodeCodexStandaloneSearchResponse,
  type CodexStandaloneSearchRequest,
} from "./codex-standalone-web-search"
import { buildCodexDispatchLogLine } from "./codex-dispatch-log-summary"
import { resolveCodexPromptCacheKey } from "./codex-cache-identity-policy"
import {
  buildCodexBridgeNativeHttpHeaders,
  buildCodexNonTurnHttpHeaders,
  type CodexForwardHeaders,
} from "./codex-header-utils"
import {
  createCodexApiErrorFromBody,
  resolveCodexHttpErrorResponse,
} from "./codex-api-error-response"
import {
  formatCodexRateLimitWindow,
  parseCodexRateLimitHeaders,
} from "./codex-rate-limit-headers"
import {
  getAllCodexAccountsRateLimitedRetrySeconds,
  getCodexWeeklyQuotaCooldownUntil,
  getCodexWeeklyRateLimitWindow,
  isCodexRateLimitSnapshotExhausted,
} from "./codex-rate-limit-policy"
import {
  getActiveCodexModelCooldowns,
  resolveCodexPoolEntryState,
} from "./codex-pool-status-policy"
import {
  getCodexSlotRecoveryTimeForModel,
  isCodexSlotAvailableForModel,
} from "./codex-slot-availability-policy"
import {
  getCodexRateLimitAccountSummary,
  getCodexRateLimitModelSummary,
  hasCodexRateLimitData,
  normalizeCodexRateLimitModelName,
  setCodexRateLimitSnapshot,
} from "./codex-rate-limit-summary"
import {
  extractCodexCompletedUsage,
  parseCodexSsePayload,
} from "./codex-sse-parsing"
import {
  buildCodexHttpRequestLogLine,
  summarizeCodexCompletedResponseForLogs,
  summarizeCodexRequestForLogs,
} from "./codex-request-log-summary"
import { prepareCodexRequestForSend } from "./codex-request-sanitizer"
import { CodexApiError } from "./codex-api-error"
import { CodexRuntimeCacheStore } from "./codex-runtime-cache-store"
import {
  assertCodexRemoteCompactionV2RequestInput,
  assertCodexRemoteCompactionV2WireInput,
  buildCodexRemoteCompactionV2Input,
  CODEX_RESPONSE_COMPLETED_EVENT,
  CODEX_RESPONSE_TERMINAL_EVENT,
  createCodexRemoteCompactionV2Collector,
  CodexRemoteCompactionV2WireInputCapture,
  type CodexRemoteCompactionV2Result,
} from "./codex-compact-payload"
import type { CodexTurnContext } from "./codex-turn-context"
import { CodexTurnContextManager } from "./codex-turn-context-manager"
import { buildCodexRequest } from "./codex-request-builder"
import { CodexSlotRouter } from "./codex-slot-router"
import {
  createCodexPersistedAccountStates,
  getCodexCredentialFingerprint,
  restoreCodexPersistedAccountStates,
  shouldClearCodexDisablementForCredentialChange,
} from "./codex-account-state-policy"
import {
  buildCodexSlotStateKey,
  buildCodexSlotStickyKey,
  type CodexReloadKey,
  type CodexSlotKey,
} from "./codex-slot-identity"
import {
  extractCodexServiceTierFromToml,
  normalizeCodexServiceTier,
} from "./codex-service-tier"
import type {
  CodexContinuationPolicy,
  CodexExecutionRequest,
  CodexInputItem,
  CodexNativeInputExecutionRequest,
  CodexProviderExecutionRequest,
  CodexRemoteCompactionV2Request,
} from "./codex-native-types"
import {
  assertCodexProviderIdentity,
  createCodexRootProviderIdentity,
  createCodexUuidV7,
  type CodexProviderIdentity,
} from "./codex-provider-identity"
import {
  appendCodexResponseOutputItemToLedger,
  getCodexCompletedResponseId,
} from "./codex-turn-ledger"
import { buildCodexContinuationDecisionLogLine } from "./codex-turn-state"
import {
  captureCodexTurnState,
  buildCodexClientMetadata,
  extractCodexTurnStateFromMetadataEvent,
  extractCodexTurnKey,
  applyCodexTurnStateHeader as writeCodexTurnStateHeader,
  readCodexTurnStateFromHeaders,
} from "./codex-turn-metadata"
import { isCodexRefreshTokenInvalidationMessage } from "./codex-token-refresh-policy"
import {
  CHATGPT_WEB_REALTIME_POOL_MODEL,
  CODEX_VOICE_POOL_MODEL,
  type CodexRealtimeAccountLease,
  type CodexVoiceAccountLease,
  resolveChatGptWebDeviceId,
} from "./codex-realtime-account"
import {
  isCodexStaleResponseIdError,
  resolveCodexWebSocketFailure,
} from "./codex-transport-error-policy"
import { resolveCodexSlotSelection } from "./codex-slot-selection-policy"
import { shouldSendCodexWarmupPayload } from "./codex-warmup-policy"
import {
  applyCodexFileSlotRecordMetadata,
  buildCodexFileSlotRecordFields,
  buildCodexLoadedAccountTokenSeed,
  buildCodexFileSlotReloadKey,
  buildCodexLoadedRecordReloadKey,
  hydrateCodexTokenData,
  type LoadedCodexAccountRecord,
  mergeCodexLoadedAccountRecords,
  type PersistedCodexAccountRecord,
  upsertCodexPersistedAccountRecord,
} from "./codex-account-records"
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
const DEFAULT_CODEX_RATE_LIMIT_MODEL = "gpt-5.5"
const DEFAULT_CODEX_ALL_RATE_LIMIT_MAX_RETRIES = 3
const DEFAULT_CODEX_ALL_RATE_LIMIT_MAX_WAIT_SECONDS = 120

function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number
): number {
  const parsed = Number.parseInt(value?.trim() || "", 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

// ── Service ────────────────────────────────────────────────────────────

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
  deviceId?: string
  configPath?: string
  source: "env" | "file"
  /** 持久化 disabled 状态的唯一标识 key */
  stateKey: string
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

interface CodexStreamDispatchOptions {
  readonly forwardHeaders?: CodexForwardHeaders
  readonly abortSignal?: AbortSignal
}

interface CodexNonStreamDispatchOptions {
  readonly forwardHeaders?: CodexForwardHeaders
}

/**
 * A server-side Responses tool operation still performs a model request. It
 * therefore has the same physical-dispatch boundary as an ordinary turn,
 * while retaining its native result parser outside the generic transport.
 */
interface CodexServerToolExecutionOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs: number
}

/**
 * A continuation transition belongs to one physical provider dispatch. Its
 * derived wire request and eventual response are private until the caller's
 * lifecycle has accepted that exact dispatch.
 */
interface CodexPendingContinuationAttempt {
  readonly conversationId: string
  readonly context: CodexTurnContext
  readonly prepared: ReturnType<CodexTurnContextManager["planRequest"]>
  response?: {
    readonly responseId: string
    readonly itemsAdded: CodexInputItem[]
  }
}

interface CodexPreparedTransportRequest {
  readonly request: Record<string, unknown>
  readonly continuation?: CodexPendingContinuationAttempt
}

/** A full-input HTTP turn retires an old WebSocket chain only on acceptance. */
interface CodexPendingHttpTransportAttempt {
  readonly conversationId: string
  readonly slot: CodexAccountSlot
  readonly modelName: string
  readonly reason: string
}

/** All attempt-local state waiting for the physical acceptance boundary. */
interface CodexPhysicalAttemptReceipt {
  continuation?: CodexPendingContinuationAttempt
  httpTransport?: CodexPendingHttpTransportAttempt
}

@Injectable()
export class CodexService implements OnModuleInit, ProviderAdapter {
  private readonly logger = new Logger(CodexService.name)

  /** All loaded accounts (round-robin pool) */
  private accounts: CodexAccountSlot[] = []
  /** Backing file used for multi-account OAuth persistence */
  private accountsFilePath: string = CODEX_ACCOUNTS_DEFAULT_PATH

  private readonly slotRouter = new CodexSlotRouter({
    affinityTtlMs: 60 * 60 * 1000,
  })

  private configuredModelTier: CodexModelTier | null = null
  private configuredDefaultServiceTier: string | undefined

  /** Whether to prefer WebSocket transport over HTTP */
  private useWebSocket: boolean = false
  private readonly sessionWarmupPromises = new Map<string, Promise<void>>()

  private readonly modelCatalogCache = new CodexModelCatalogCache()
  private readonly runtimeCache = new CodexRuntimeCacheStore()
  /** Stable only for this bridge process; native request identity is typed. */
  private readonly nativeInstallationId = crypto.randomUUID()
  /**
   * Per-request observer used only by Remote Compaction V2 to retain the
   * actual final transport input. A WebSocket continuation can legitimately
   * reduce the full logical request to an incremental delta, so this cannot
   * be inferred from the pre-dispatch request object.
   */
  private readonly preparedWireInputCaptures = new WeakMap<
    object,
    (input: readonly CodexInputItem[]) => void
  >()
  private readonly allRateLimitMaxRetries: number
  private readonly allRateLimitMaxWaitSeconds: number

  /**
   * Logical Codex turn lifecycle. Physical WebSocket transport still belongs
   * to wsService; this manager owns the conversation-scoped ModelClientSession
   * state that mirrors the upstream Codex CLI runtime.
   */
  private readonly turnContexts: CodexTurnContextManager

  private rateLimitProbePromise: Promise<number> | null = null
  private activeLiveRequests = 0
  private activeRateLimitProbeAbortController: AbortController | null = null

  /** 持久化 Codex 账号 disabled 状态的 store */
  private readonly accountStateStore: BackendAccountStateStore

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: CodexAuthService,
    private readonly cacheService: CodexCacheService,
    private readonly wsService: CodexWebSocketService,
    private readonly identity: CodexClientIdentityService,
    private readonly usageStats: UsageStatsService,
    persistence: PersistenceService
  ) {
    this.turnContexts = new CodexTurnContextManager({
      runtimeCache: this.runtimeCache,
      closeWsSession: (sessionId) => this.wsService.closeSession(sessionId),
    })
    this.allRateLimitMaxRetries = parseNonNegativeInteger(
      this.configService.get<string>("CODEX_ALL_RATE_LIMIT_MAX_RETRIES", ""),
      DEFAULT_CODEX_ALL_RATE_LIMIT_MAX_RETRIES
    )
    this.allRateLimitMaxWaitSeconds = parseNonNegativeInteger(
      this.configService.get<string>(
        "CODEX_ALL_RATE_LIMIT_MAX_WAIT_SECONDS",
        ""
      ),
      DEFAULT_CODEX_ALL_RATE_LIMIT_MAX_WAIT_SECONDS
    )
    this.accountStateStore = new BackendAccountStateStore(
      persistence,
      this.logger
    )
  }

  async onModuleInit() {
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
    const envDeviceId = this.configService
      .get<string>("CODEX_DEVICE_ID", "")
      .trim()

    // WebSocket transport preference.
    // Default to enabled because it offers lower latency and will
    // automatically fall back to HTTP when the upstream rejects upgrades.
    const wsEnv = this.configService
      .get<string>("CODEX_USE_WEBSOCKET", "")
      .trim()
      .toLowerCase()
    this.useWebSocket = !["false", "0", "off", "no"].includes(wsEnv)

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
        deviceId: envDeviceId || undefined,
        source: "env",
        stateKey: this.buildCodexSlotStateKey({
          apiKey: envApiKey,
          email: "",
          accountId: envAccountId,
          baseUrl: envBaseUrl,
        }),
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
      this.accounts.push(
        this.createFileSlotFromLoadedRecord(fa, envBaseUrl, envProxyUrl)
      )
    }

    this.configuredModelTier = this.resolveConfiguredModelTier()
    this.configuredDefaultServiceTier =
      this.resolveConfiguredDefaultServiceTier()

    this.logger.log(
      `Codex backend initialized: ${this.accounts.length} account(s), ` +
        `defaultBaseUrl=${envBaseUrl}, useWebSocket=${this.useWebSocket}, ` +
        `modelTier=${this.configuredModelTier || "unknown"}, ` +
        `serviceTier=${this.configuredDefaultServiceTier || "default"}`
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

    // 5. 恢复持久化的 disabled 状态，避免重启后再次用失效账号做 warmup 导致无意义 401
    this.restorePersistedAccountStates()
    await this.refreshModelCatalogs()
  }

  /**
   * Check if Codex backend is available (has at least one account).
   */
  isAvailable(): boolean {
    return this.accounts.length > 0
  }

  getChatGptWebRealtimeAccountCount(): number {
    return this.accounts.filter((slot) => this.hasChatGptWebCredential(slot))
      .length
  }

  /**
   * Lease one OAuth account for a ChatGPT Web SDP handshake. The lease uses
   * the same round-robin cursor, refresh serialization, proxy metadata and
   * cooldown state as ordinary Codex traffic.
   */
  async acquireChatGptWebRealtimeAccount(
    excludedAccountKeys: ReadonlySet<string> = new Set()
  ): Promise<CodexRealtimeAccountLease | null> {
    const leased = await this.leaseRealtimeSlot(
      CHATGPT_WEB_REALTIME_POOL_MODEL,
      "ChatGPT Web Realtime",
      excludedAccountKeys
    )
    return leased?.lease ?? null
  }

  /**
   * Lease one OAuth account for a Codex voice (GPT-Live) call — the voice
   * Codex itself opens — with what a request to the account's Codex backend
   * needs: its call endpoint, its identity headers and its proxy.
   */
  async acquireCodexVoiceAccount(
    excludedAccountKeys: ReadonlySet<string> = new Set()
  ): Promise<CodexVoiceAccountLease | null> {
    const leased = await this.leaseRealtimeSlot(
      CODEX_VOICE_POOL_MODEL,
      "Codex voice",
      excludedAccountKeys
    )
    if (!leased) return null
    const { slot, lease } = leased
    return {
      ...lease,
      callUrl: this.buildUrl(slot, "realtime/calls"),
      headers: (accessToken) =>
        buildCodexNonTurnHttpHeaders({
          token: accessToken,
          isApiKey: false,
          accept: "application/json",
          identity: {
            version: this.identity.version(),
            userAgent: this.identity.userAgent(),
            originator: this.identity.originator(),
          },
          accountId: this.getSlotAccountId(slot),
          workspaceId: slot.workspaceId,
        }),
      dispatcher: this.buildProxyDispatcher(slot),
    }
  }

  private async leaseRealtimeSlot(
    poolModel: string,
    purpose: string,
    excludedAccountKeys: ReadonlySet<string>
  ): Promise<{
    slot: CodexAccountSlot
    lease: CodexRealtimeAccountLease
  } | null> {
    const attempted = new Set(excludedAccountKeys)
    let inspected = 0

    while (inspected < this.accounts.length) {
      const now = Date.now()
      const slot = this.slotRouter.pickFromCurrentIndex({
        candidates: this.accounts,
        isSlotUsable: (candidate) => {
          const key = this.getSlotStickyKey(candidate)
          return (
            !attempted.has(key) &&
            this.hasChatGptWebCredential(candidate) &&
            isAccountAvailableForModel(candidate, poolModel, now)
          )
        },
      })
      if (!slot) return null

      inspected++
      const accountKey = this.getSlotStickyKey(slot)
      attempted.add(accountKey)
      const accessToken = await this.getChatGptWebAccessToken(slot)
      if (!accessToken) {
        markAccountCooldown(
          slot,
          401,
          poolModel,
          undefined,
          this.getAccountLabel(slot)
        )
        continue
      }

      let settled = false
      return {
        slot,
        lease: {
          accountKey,
          label: this.getAccountLabel(slot),
          accessToken,
          deviceId: resolveChatGptWebDeviceId(slot.deviceId, accountKey),
          proxyUrl: slot.proxyUrl?.trim() || undefined,
          refreshAccessToken: (reason) =>
            this.tryRefreshSlotToken(slot, reason, {
              allowOAuthOnApiKeySlot: true,
            }),
          accept: () => {
            if (settled) return
            settled = true
            markAccountSuccess(slot, poolModel)
          },
          abandon: () => {
            settled = true
          },
          reject: (statusCode, detail, retryAfterSeconds) => {
            if (settled) return
            settled = true
            markAccountCooldown(
              slot,
              statusCode,
              poolModel,
              retryAfterSeconds?.toString(),
              this.getAccountLabel(slot)
            )
            this.logger.warn(
              `[Codex] ${purpose} rejected ${this.getAccountLabel(slot)}: HTTP ${statusCode}${detail ? ` ${detail.slice(0, 300)}` : ""}`
            )
          },
        },
      }
    }

    return null
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

    const existingFileSlots = new Map<CodexReloadKey, CodexAccountSlot>()
    for (const slot of this.accounts) {
      if (slot.source !== "file") {
        continue
      }
      existingFileSlots.set(
        buildCodexFileSlotReloadKey(slot, DEFAULT_BASE_URL),
        slot
      )
    }

    const nextAccounts = this.accounts.filter((slot) => slot.source !== "file")
    const seenReloadKeys = new Set<CodexReloadKey>()
    let added = 0

    freshRecords.forEach((record, index) => {
      const reloadKey = buildCodexLoadedRecordReloadKey(
        record,
        envBaseUrl,
        DEFAULT_BASE_URL,
        index
      )
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

    for (const slot of removedSlots)
      this.modelCatalogCache.remove(this.modelCatalogScope(slot))
    this.accounts = nextAccounts
    this.slotRouter.normalizeAccountIndex(this.accounts.length)
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
      const modelCooldowns = getActiveCodexModelCooldowns(account, now)
      const state = resolveCodexPoolEntryState(account, modelCooldowns, now)
      return {
        id: this.getSlotStickyKey(account),
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

    return buildBackendPoolStatus({
      backend: "codex",
      kind: "account-pool",
      configured: this.accounts.length > 0,
      configPath: this.accountsFilePath,
      entries,
    })
  }

  getModelTier(): CodexModelTier | null {
    return this.getHighestLoadedModelTier() || this.configuredModelTier
  }

  getDefaultServiceTier(): string | undefined {
    return this.configuredDefaultServiceTier
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

  private resolveConfiguredDefaultServiceTier(): string | undefined {
    const envTier = normalizeCodexServiceTier(
      this.configService.get<string>("CODEX_SERVICE_TIER", "")
    )
    if (envTier) {
      return envTier
    }

    return this.readServiceTierFromLocalConfig()
  }

  private readServiceTierFromLocalConfig(): string | undefined {
    const codexHome =
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
    const configFile = path.join(codexHome, "config.toml")

    try {
      if (!fs.existsSync(configFile)) {
        return undefined
      }

      const raw = fs.readFileSync(configFile, "utf8")
      return extractCodexServiceTierFromToml(raw)
    } catch (error) {
      this.logger.warn(
        `Failed to infer Codex service tier from ${configFile}: ${error instanceof Error ? error.message : String(error)}`
      )
      return undefined
    }
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

    const mergedRecords = mergeCodexLoadedAccountRecords(loadedRecords)
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

  /**
   * Derive per-slot token metadata from persisted or env-backed credentials.
   */
  private hydrateTokenData(tokenData: Partial<CodexTokenData>): CodexTokenData {
    return hydrateCodexTokenData(tokenData, {
      getAccountIdFromIdToken: (idToken) =>
        this.authService.getAccountIdFromIdToken(idToken),
      getWorkspaceIdFromIdToken: (idToken) =>
        this.authService.getWorkspaceIdFromIdToken(idToken),
      getTokenExpiryFromJwt: (token) =>
        this.authService.getTokenExpiryFromJwt(token),
    })
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

  private getLocalProjectionKey(
    request: Pick<CodexExecutionRequest, "localProjectionKey">
  ): string {
    return requireExactDurableIdentifier(
      request.localProjectionKey,
      "Codex localProjectionKey"
    )
  }

  /**
   * Freeze native turn metadata into a generic Codex request before the
   * physical-attempt coordinator snapshots it. Transport code may consume
   * this metadata but can never invent a new turn/window identity.
   */
  prepareBridgeNativeExecutionRequest<T extends CodexProviderExecutionRequest>(
    request: T
  ): T {
    this.getLocalProjectionKey(request)
    const identity = this.getUpstreamIdentity(request)
    if (request.clientMetadata !== undefined) {
      throw new Error(
        "Generic Codex request preparation received pre-existing client metadata"
      )
    }
    return {
      ...request,
      clientMetadata: buildCodexClientMetadata({
        identity,
        installationId: this.nativeInstallationId,
        turnId: createCodexUuidV7(),
        windowId: `${identity.threadId}:0`,
        requestKind: "turn",
        turnStartedAtUnixMs: Date.now(),
      }),
    }
  }

  private getUpstreamIdentity(
    request: Pick<CodexExecutionRequest, "upstreamIdentity">
  ): CodexProviderIdentity {
    assertCodexProviderIdentity(request.upstreamIdentity)
    return request.upstreamIdentity
  }

  private getCodexTurnKey(codexRequest: Record<string, unknown>): string {
    return extractCodexTurnKey(codexRequest)
  }

  private modelCatalogScope(slot: CodexAccountSlot): string {
    return `${this.getSlotStickyKey(slot)}:${slot.workspaceId ?? ""}:${this.identity.version()}`
  }

  /** Refresh before history budgeting so a new comp_hash is checked before dispatch. */
  async refreshModelCatalogs(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const refresh = Promise.all(
      this.accounts
        .filter((slot) => !isAccountDisabled(slot) && !this.isApiKeyMode(slot))
        .map((slot) =>
          this.modelCatalogCache.refresh({
            scope: this.modelCatalogScope(slot),
            directory: path.join(
              path.dirname(this.accountsFilePath),
              "codex-model-catalogs"
            ),
            clientVersion: this.identity.version(),
            fetchCatalog: async (etag) => {
              const token = await this.getBearerToken(slot)
              if (!token)
                throw new Error(
                  "Codex model catalog requires the configured account token"
                )
              const headers = buildCodexNonTurnHttpHeaders({
                token,
                isApiKey: false,
                accept: "application/json",
                identity: {
                  version: this.identity.version(),
                  userAgent: this.identity.userAgent(),
                  originator: this.identity.originator(),
                },
                accountId: this.getSlotAccountId(slot),
                workspaceId: slot.workspaceId,
              })
              if (etag) headers["If-None-Match"] = etag
              const url = new URL(this.buildUrl(slot, "models"))
              url.searchParams.set("client_version", this.identity.version())
              const init: RequestInit & { dispatcher?: unknown } = {
                headers,
                signal: AbortSignal.timeout(10_000),
              }
              const dispatcher = this.buildProxyDispatcher(slot)
              if (dispatcher) init.dispatcher = dispatcher
              return fetch(url, init)
            },
            onError: (error) =>
              this.logger.warn(
                `Codex model catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`
              ),
          })
        )
    )
    const abort = createAbortPromise(signal, "Codex catalog wait aborted")
    try {
      await Promise.race([refresh, ...(abort.promise ? [abort.promise] : [])])
    } finally {
      abort.cleanup()
    }
  }

  private usesResponsesLite(
    modelName: string,
    slot?: CodexAccountSlot
  ): boolean {
    return (
      getCodexModelProfile(
        modelName,
        slot ? this.modelCatalogScope(slot) : undefined
      )?.use_responses_lite === true
    )
  }

  private applyCodexTurnStateHeader(
    headers: Record<string, string>,
    context: CodexTurnContext | undefined
  ): void {
    writeCodexTurnStateHeader(headers, context?.turnState)
  }

  private captureCodexTurnStateFromConnection(
    context: CodexTurnContext | undefined,
    ws: WebSocket
  ): void {
    if (!context) {
      return
    }
    const turnState = this.wsService
      .getConnectionMetadata(ws)
      ?.turnState?.trim()
    if (!captureCodexTurnState(context, turnState)) {
      return
    }
    this.logger.debug(
      `[Codex][TurnContext] Captured x-codex-turn-state for session=${context.wsSessionId} turn=${context.turnKey || "unknown"}`
    )
  }

  private captureCodexTurnStateFromHttpHeaders(
    context: CodexTurnContext | undefined,
    headers: Pick<Headers, "get">
  ): void {
    if (!context) {
      return
    }
    const turnState = readCodexTurnStateFromHeaders(headers)
    if (!captureCodexTurnState(context, turnState)) {
      return
    }
    this.logger.debug(
      `[Codex][TurnContext] Captured x-codex-turn-state from HTTP for session=${context.wsSessionId} turn=${context.turnKey || "unknown"}`
    )
  }

  private captureCodexTurnStateFromSsePayload(
    context: CodexTurnContext | undefined,
    payload: Record<string, unknown> | null
  ): void {
    if (!context) {
      return
    }
    const turnState = extractCodexTurnStateFromMetadataEvent(payload)
    if (!captureCodexTurnState(context, turnState)) {
      return
    }
    this.logger.debug(
      `[Codex][TurnContext] Captured x-codex-turn-state from response.metadata for session=${context.wsSessionId} turn=${context.turnKey || "unknown"}`
    )
  }

  // ── CodexTurnContext lifecycle management ──────────────────────────────
  //
  // Mirrors the official Codex CLI ModelClient.new_session() / ModelClientSession.Drop.
  // All requests for a conversation (prewarm + stream) share a single CodexTurnContext.
  // When a turn ends the connection is returned to cachedWsSessions.
  // Eliminates the warm pool promotion mechanism entirely.

  /**
   * Generate the cross-turn connection cache key.
   * Conversation-scoped requests must not share previous_response_id state.
   * Global keys are only used for startup/model-picker warmups with no conversation.
   */
  private getCachedWsKey(
    slot: CodexAccountSlot,
    modelName: string,
    conversationId?: string
  ): string {
    return this.turnContexts.buildWsCacheKey({
      slotKey: this.getSlotStickyKey(slot),
      modelName,
      conversationId,
    })
  }

  /**
   * Get or create a turn context for the given conversation.
   * Mirrors the official ModelClient.new_session().
   *
   * If cachedWsSessions has a matching connection, it is taken and reused.
   * If an active turn context already exists, it is returned directly.
   */
  private getOrCreateTurnContext(
    conversationId: string,
    slot: CodexAccountSlot,
    modelName: string,
    turnKey?: string
  ): CodexTurnContext {
    return this.turnContexts.getOrCreateContext({
      conversationId,
      slotKey: this.getSlotStickyKey(slot),
      modelName,
      turnKey,
    })
  }

  /**
   * Resolve the logical ModelClientSession owned by this request.
   *
   * An isolated request may share account routing with its conversation, but
   * it is not a turn in that conversation's native response chain. It must
   * therefore stay outside CodexTurnContext entirely: entering the manager
   * with a different turn key would reset the accepted previous_response_id
   * baseline before the isolated request was even dispatched.
   */
  private resolveSharedTurnContext(
    request: Pick<CodexExecutionRequest, "continuationPolicy">,
    conversationId: string | undefined,
    slot: CodexAccountSlot,
    modelName: string,
    turnKey?: string
  ): CodexTurnContext | undefined {
    if (
      conversationId === undefined ||
      this.resolveContinuationPolicy(request) === "isolated"
    ) {
      return undefined
    }
    return this.getOrCreateTurnContext(conversationId, slot, modelName, turnKey)
  }

  /**
   * Return the turn context's connection to cachedWsSessions.
   * Mirrors the official ModelClientSession.Drop.
   */
  private disposeTurnContext(
    conversationId: string,
    slot: CodexAccountSlot,
    modelName: string
  ): void {
    this.turnContexts.disposeContext({
      conversationId,
      slotKey: this.getSlotStickyKey(slot),
      modelName,
    })
  }

  /**
   * Derive the exact wire request for one WebSocket dispatch without touching
   * the shared response chain. The returned receipt is committed only after
   * the physical lifecycle is accepted, never on preparation or abandon.
   */
  private planRequestWithTurnContext(
    codexRequest: Record<string, unknown>,
    context: CodexTurnContext,
    conversationId: string,
    continuationPolicy: CodexContinuationPolicy
  ): CodexPreparedTransportRequest {
    if (continuationPolicy === "isolated") {
      return { request: codexRequest }
    }

    const prepared =
      continuationPolicy === "full"
        ? this.turnContexts.planFullRequest(codexRequest, context)
        : this.turnContexts.planRequest(codexRequest, context)
    this.logger.debug(
      buildCodexContinuationDecisionLogLine(conversationId, prepared.decision)
    )
    return {
      request: prepared.request,
      continuation: {
        conversationId,
        context,
        prepared,
      },
    }
  }

  private resolveContinuationPolicy(
    request: Pick<CodexExecutionRequest, "continuationPolicy">
  ): CodexContinuationPolicy {
    return request.continuationPolicy ?? "auto"
  }

  /**
   * Publish the request-local continuation receipt only once the outer
   * provider lifecycle is fully accepted. The response may have completed
   * before this point, but it remains candidate-local until this commit.
   */
  private commitPendingContinuationAttempt(
    attempt: CodexPendingContinuationAttempt | undefined
  ): void {
    if (!attempt) return

    this.turnContexts.commitPreparedRequest(attempt.context, attempt.prepared)
    if (attempt.response) {
      this.turnContexts.captureResponseForContext(
        attempt.context,
        attempt.response.responseId,
        attempt.response.itemsAdded
      )
    }
    this.logger.debug(
      `[Codex][TurnContext] Accepted continuation receipt for ${attempt.conversationId}` +
        `${attempt.response ? ` response_id=${attempt.response.responseId}` : ""}`
    )
  }

  private beginFullCodexResponseChain(
    context: CodexTurnContext | undefined,
    conversationId: string | undefined,
    codexRequest: Record<string, unknown>,
    reason: string
  ): void {
    if (!context) {
      return
    }

    const previousResponseId = this.turnContexts.beginFullResponseChain(
      context,
      codexRequest
    )
    if (conversationId && previousResponseId) {
      this.logger.debug(
        `[Codex][TurnContext] Reset response chain for ${conversationId}: ${reason}; ` +
          `discarded previous_response_id=${previousResponseId}`
      )
    }
  }

  /**
   * Capture the response_id and output items from a response.completed event.
   * Mirrors map_response_stream() ResponseEvent::Completed → LastResponse.
   */
  private captureResponseInTurnContext(
    conversationId: string,
    responseId: string,
    itemsAdded: CodexInputItem[],
    pendingAttempt?: CodexPendingContinuationAttempt
  ): void {
    // `isolated` requests deliberately have no continuation receipt. Their
    // response must not become the shared previous_response_id baseline merely
    // because they reused the conversation's physical WebSocket. Normal
    // auto/full requests always carry a candidate-local receipt and publish it
    // only after the outer provider lifecycle accepts.
    if (!pendingAttempt) {
      return
    }
    pendingAttempt.response = {
      responseId,
      itemsAdded: structuredClone(itemsAdded),
    }
    this.logger.debug(
      `[Codex][TurnContext] Staged response_id=${responseId} ` +
        `for conversation=${conversationId}; items_added=${itemsAdded.length}`
    )
  }

  /**
   * Clear response state in the turn context when the transcript baseline is
   * no longer safe for incremental append.
   */
  private resetTurnContextResponseState(
    conversationId: string,
    reason?: string
  ): void {
    const previousResponseId =
      this.turnContexts.resetResponseState(conversationId)
    if (previousResponseId && reason) {
      this.logger.debug(
        `[Codex][TurnContext] ${reason} for ${conversationId}, ` +
          `discarding stale previous_response_id=${previousResponseId}`
      )
    }
  }

  /**
   * A rebuilt WebSocket must not reuse its earlier request delta for this
   * physical dispatch. This remains request-local: if the dispatch is
   * abandoned, its accepted baseline is still available to the next attempt.
   */
  private resolveWebSocketContinuationPolicy(
    request: Pick<CodexExecutionRequest, "continuationPolicy">,
    connectionRebuilt: boolean
  ): CodexContinuationPolicy {
    const requestedPolicy = this.resolveContinuationPolicy(request)
    if (!connectionRebuilt || requestedPolicy === "isolated") {
      return requestedPolicy
    }
    return "full"
  }

  private isHttpFallbackTransport(
    conversationId: string | undefined,
    slot: CodexAccountSlot,
    modelName: string
  ): boolean {
    const exactConversationId = requireOptionalExactDurableIdentifier(
      conversationId,
      "Codex HTTP fallback conversationId"
    )
    if (exactConversationId === undefined) {
      return false
    }

    return this.turnContexts.isHttpFallbackTransport({
      conversationId: exactConversationId,
      slotKey: this.getSlotStickyKey(slot),
      modelName,
    })
  }

  private shouldOmitAccountIdForHttpTransport(
    conversationId: string | undefined,
    slot: CodexAccountSlot,
    modelName: string
  ): boolean {
    const exactConversationId = requireOptionalExactDurableIdentifier(
      conversationId,
      "Codex HTTP account-scope conversationId"
    )
    if (exactConversationId === undefined) {
      return false
    }
    return this.turnContexts.shouldOmitAccountIdForHttpTransport({
      conversationId: exactConversationId,
      slotKey: this.getSlotStickyKey(slot),
      modelName,
    })
  }

  /**
   * A failed transport may establish only the routing preference for the next
   * physical attempt. It must not mutate response-chain state.
   */
  private recordHttpFallbackTransport(
    conversationId: string | undefined,
    slot: CodexAccountSlot,
    modelName: string,
    reason: string,
    omitAccountId: boolean = false
  ): void {
    const exactConversationId = requireOptionalExactDurableIdentifier(
      conversationId,
      "Codex HTTP fallback conversationId"
    )
    if (exactConversationId === undefined) {
      return
    }

    const result = this.turnContexts.recordHttpFallbackTransport({
      conversationId: exactConversationId,
      slotKey: this.getSlotStickyKey(slot),
      modelName,
      omitAccountId,
    })

    if (!result.httpFallbackActivated && !result.omitAccountId) {
      return
    }

    this.logger.debug(
      `[Codex][TurnContext] ${reason} for ${exactConversationId}; ` +
        `recorded HTTP transport routing${
          result.omitAccountId ? " without Chatgpt-Account-Id" : ""
        }`
    )
  }

  /**
   * Stage an HTTP transition for the physical attempt that will send a full
   * input. Isolated requests deliberately leave the shared response chain
   * untouched even when they use HTTP.
   */
  private stageAcceptedHttpTransportTurn(
    receipt: CodexPhysicalAttemptReceipt,
    conversationId: string | undefined,
    slot: CodexAccountSlot,
    modelName: string,
    reason: string,
    continuationPolicy: CodexContinuationPolicy
  ): void {
    const exactConversationId = requireOptionalExactDurableIdentifier(
      conversationId,
      "Codex accepted HTTP conversationId"
    )
    if (
      exactConversationId === undefined ||
      continuationPolicy === "isolated"
    ) {
      return
    }
    receipt.httpTransport = {
      conversationId: exactConversationId,
      slot,
      modelName,
      reason,
    }
  }

  /** Publish the staged HTTP transition only after the outer lifecycle accepts. */
  private commitAcceptedHttpTransportTurn(
    attempt: CodexPendingHttpTransportAttempt | undefined
  ): void {
    if (!attempt) return
    const result = this.turnContexts.commitHttpTransportTurn({
      conversationId: attempt.conversationId,
      slotKey: this.getSlotStickyKey(attempt.slot),
      modelName: attempt.modelName,
    })
    if (
      !result.clearedActiveContext &&
      !result.deletedCachedContext &&
      result.closedSessionIds.length === 0
    ) {
      return
    }
    const discarded = result.discardedPreviousResponseId
      ? ` discarded previous_response_id=${result.discardedPreviousResponseId}`
      : ""
    const closed =
      result.closedSessionIds.length > 0
        ? ` closed_sessions=${result.closedSessionIds.join(",")}`
        : ""
    this.logger.debug(
      `[Codex][TurnContext] ${attempt.reason} accepted for ${attempt.conversationId}; ` +
        `retired prior WebSocket continuation${discarded}${closed}`
    )
  }

  /**
   * Reset Codex continuation state after the model-facing transcript was
   * rewritten by compaction, snip, microcompact, or hard-fit projection.
   *
   * This mirrors Codex CLI's ModelClientSession.reset_websocket_session():
   * once history is rewritten, the previous WebSocket response chain is no
   * longer a valid baseline for previous_response_id deltas.
   */
  resetConversationContinuationState(
    conversationId: string | undefined,
    modelName?: string,
    reason?: string
  ): void {
    const exactConversationId = requireOptionalExactDurableIdentifier(
      conversationId,
      "Codex continuation reset conversationId"
    )
    if (exactConversationId === undefined) {
      return
    }

    const result = this.turnContexts.resetContinuationState({
      conversationId: exactConversationId,
      modelName,
      slotKeys: this.accounts.map((slot) => this.getSlotStickyKey(slot)),
    })

    if (result.discardedActivePreviousResponseId && reason) {
      this.logger.debug(
        `[Codex][TurnContext] ${reason} for ${exactConversationId}, ` +
          `discarding stale previous_response_id=${result.discardedActivePreviousResponseId}`
      )
    }

    if (result.resetCount > 0 || reason) {
      this.logger.debug(
        `[Codex][TurnContext] Reset continuation state for ${exactConversationId}` +
          `${result.modelName ? ` model=${result.modelName}` : ""}` +
          `${reason ? `: ${reason}` : ""}`
      )
    }
  }

  /**
   * Discard the previous_response_id baseline without closing the current
   * upstream transport. Use this when the next turn's prompt surface changes
   * while the current Codex response stream is still open.
   */
  clearConversationContinuationBaseline(
    conversationId: string | undefined,
    modelName?: string,
    reason?: string
  ): void {
    const exactConversationId = requireOptionalExactDurableIdentifier(
      conversationId,
      "Codex continuation baseline conversationId"
    )
    if (exactConversationId === undefined) {
      return
    }

    const result = this.turnContexts.clearContinuationBaseline({
      conversationId: exactConversationId,
      modelName,
      slotKeys: this.accounts.map((slot) => this.getSlotStickyKey(slot)),
    })

    const discarded = result.discardedPreviousResponseId
      ? ` discarded_previous_response_id=${result.discardedPreviousResponseId}`
      : ""
    if (result.resetCount > 0 || reason) {
      this.logger.debug(
        `[Codex][TurnContext] Cleared continuation baseline for ${exactConversationId}` +
          `${result.modelName ? ` model=${result.modelName}` : ""}` +
          `${reason ? `: ${reason}` : ""}${discarded}`
      )
    }
  }

  private hasConversationContinuationState(
    conversationId: string,
    slot?: CodexAccountSlot,
    modelName?: string
  ): boolean {
    return this.turnContexts.hasContinuationState(
      conversationId,
      slot && modelName
        ? {
            slotKey: this.getSlotStickyKey(slot),
            modelName,
          }
        : undefined
    )
  }

  private async acquireConversationStreamLock(
    conversationId: string
  ): Promise<() => void> {
    return this.turnContexts.acquireStreamLock(conversationId)
  }

  private onLiveRequestStart(): void {
    this.activeLiveRequests += 1
    if (this.activeRateLimitProbeAbortController) {
      this.activeRateLimitProbeAbortController.abort()
    }
  }

  private onLiveRequestEnd(): void {
    this.activeLiveRequests = Math.max(0, this.activeLiveRequests - 1)
  }

  private getSlotStickyKey(slot: CodexAccountSlot): CodexSlotKey {
    return buildCodexSlotStickyKey({
      apiKey: slot.apiKey,
      accountId: this.getSlotAccountId(slot),
      email: slot.email,
      refreshToken: slot.tokenData?.refreshToken || slot.refreshToken,
      accessToken: slot.tokenData?.accessToken || slot.accessToken,
      label: slot.label,
      baseUrl: slot.baseUrl,
    })
  }

  private purgeExpiredConversationBindings(now: number = Date.now()): void {
    this.slotRouter.pruneExpiredBindings(now, (conversationId) => {
      // 同步清理 conversationSession 的 active turn 字段（仅文本元数据，无连接句柄）。
      // 物理 WS 连接由 wsService 自己的 STALE_TIMEOUT_MS 兜底。
      this.turnContexts.clearActiveContext(conversationId)
    })
  }

  private bindConversationToSlot(
    conversationId: string,
    slot: CodexAccountSlot
  ): void {
    const exactConversationId = requireExactDurableIdentifier(
      conversationId,
      "Codex slot binding conversationId"
    )

    this.purgeExpiredConversationBindings()
    this.slotRouter.bindConversation(
      exactConversationId,
      this.getSlotStickyKey(slot)
    )
  }

  private getStickyConversationSlot(
    conversationId: string,
    modelName: string
  ): CodexAccountSlot | null {
    const exactConversationId = requireExactDurableIdentifier(
      conversationId,
      "Codex sticky slot conversationId"
    )

    const normalizedModelName = modelName.toLowerCase().trim()
    const now = Date.now()
    this.purgeExpiredConversationBindings(now)
    return this.slotRouter.getStickySlot(exactConversationId, {
      candidates: this.accounts,
      getSlotKey: (candidate) => this.getSlotStickyKey(candidate),
      isSlotUsable: (candidate) =>
        this.isModelSupportedBySlot(candidate, normalizedModelName) &&
        this.isSlotAvailableForModel(candidate, normalizedModelName, now),
    })
  }

  private isModelSupportedBySlot(
    slot: CodexAccountSlot,
    modelName: string
  ): boolean {
    if (this.isApiKeyMode(slot)) {
      return true
    }

    const scope = this.modelCatalogScope(slot)
    if (hasRemoteCodexModelCatalog(scope))
      return getCodexModelProfile(modelName, scope) !== undefined
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

  // ── Codex 账号 disabled 状态持久化 ──────────────────────────────────

  /**
   * 生成 slot 的持久化 stateKey。
   * 优先使用 email+accountId（与 Codex 账号一一对应），
   * fallback 到 apiKey hash，最终 fallback 到 baseUrl hash。
   */
  private buildCodexSlotStateKey(identity: {
    apiKey?: string
    email?: string
    accountId?: string
    baseUrl?: string
  }): string {
    return buildCodexSlotStateKey(identity, DEFAULT_BASE_URL)
  }

  /**
   * 从 SQLite 恢复持久化的 disabled 状态。
   * 重启后已经被永久 disable 的账号直接跳过，不再做 warmup。
   *
   * 凭据指纹比对：如果当前文件里的凭据与被 disable 时记录的指纹不一致，
   * 说明用户已经重新同步了新凭据（例如官方 CLI 抢先轮换 refresh token 导致
   * 旧凭据失效后用户重新登录），原 disable 原因已不成立，跳过恢复并清除这条
   * 过期记录。这样重新 sync 凭据 + 重启即可自愈，无需手动清库。
   */
  private restorePersistedAccountStates(): void {
    const persistedStates = this.accountStateStore.loadStates("codex")
    if (persistedStates.size === 0) return

    const result = restoreCodexPersistedAccountStates(
      this.accounts,
      persistedStates
    )

    for (const { slot, state } of result.stale) {
      this.logger.log(
        `[Codex] 检测到凭据已更新，清除过期 disabled 状态: ${this.getAccountLabel(slot)} (reason=${state.disabledReason})`
      )
    }

    for (const { slot, state } of result.restored) {
      this.logger.warn(
        `[Codex] 恢复已 disabled 账号: ${this.getAccountLabel(slot)} (reason=${state.disabledReason})`
      )
    }

    // 有过期记录被清除时，把内存状态重新写回 DB，保证持久化层与内存对齐。
    if (result.stale.length > 0) {
      this.persistCodexAccountStates()
    }
  }

  /**
   * 将所有 Codex 账号的 disabled 状态持久化到 SQLite。
   * 仅在 disableAccount 后调用，保证下次重启时跳过失效账号。
   */
  private persistCodexAccountStates(): void {
    const states = createCodexPersistedAccountStates(this.accounts, Date.now())
    this.accountStateStore.replaceStates("codex", states)
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

  private createFileSlotFromLoadedRecord(
    record: LoadedCodexAccountRecord,
    fallbackBaseUrl: string,
    fallbackProxyUrl: string
  ): CodexAccountSlot {
    const fields = buildCodexFileSlotRecordFields(
      record,
      fallbackBaseUrl,
      fallbackProxyUrl
    )
    const slot: CodexAccountSlot = {
      ...fields,
      source: "file",
      stateKey: this.buildCodexSlotStateKey({
        apiKey: record.apiKey,
        email: record.email,
        accountId: record.accountId,
        baseUrl: fields.baseUrl,
      }),
      tokenData: null,
      cooldownUntil: 0,
      modelStates: new Map(),
      rateLimitSnapshots: new Map(),
    }

    const tokenSeed = buildCodexLoadedAccountTokenSeed(record)
    if (tokenSeed) {
      this.applyTokenDataToSlot(slot, this.hydrateTokenData(tokenSeed))
    }

    return slot
  }

  private refreshFileSlotFromRecord(
    slot: CodexAccountSlot,
    record: LoadedCodexAccountRecord,
    fallbackBaseUrl: string,
    fallbackProxyUrl: string
  ): void {
    // 捕获更新前的凭据指纹，用于热重载（如 Sync Codex CLI）时判断凭据是否已变更。
    const wasDisabled = isAccountDisabled(slot)
    const previousFingerprint = wasDisabled
      ? getCodexCredentialFingerprint(slot)
      : ""

    const fields = buildCodexFileSlotRecordFields(
      record,
      fallbackBaseUrl,
      fallbackProxyUrl
    )
    applyCodexFileSlotRecordMetadata(slot, fields)

    const tokenSeed = buildCodexLoadedAccountTokenSeed(record)
    if (tokenSeed) {
      this.applyTokenDataToSlot(slot, this.hydrateTokenData(tokenSeed))
      this.clearDisablementIfCredentialChanged(
        slot,
        wasDisabled,
        previousFingerprint
      )
      return
    }

    slot.accessToken = undefined
    slot.refreshToken = undefined
    slot.tokenData = null
    slot.refreshPromise = undefined
    this.clearDisablementIfCredentialChanged(
      slot,
      wasDisabled,
      previousFingerprint
    )
  }

  /**
   * 热重载时，如果账号此前被 disable，且更新后的凭据指纹与之前不同，
   * 说明用户重新同步了新凭据（如官方 CLI 抢先轮换 refresh token 后重新登录），
   * 原 disable 原因已不成立。清除内存中的 disabled 状态并同步落库。
   */
  private clearDisablementIfCredentialChanged(
    slot: CodexAccountSlot,
    wasDisabled: boolean,
    previousFingerprint: string
  ): void {
    if (
      !shouldClearCodexDisablementForCredentialChange(
        slot,
        wasDisabled,
        previousFingerprint
      )
    ) {
      return
    }
    clearAccountDisablement(slot)
    this.persistCodexAccountStates()
    this.logger.log(
      `[Hot-reload] 检测到凭据已更新，清除 disabled 状态: ${this.getAccountLabel(slot)}`
    )
  }

  private pruneConversationBindingsForSlots(slots: CodexAccountSlot[]): void {
    if (slots.length === 0 || this.slotRouter.bindingCount === 0) {
      return
    }

    this.slotRouter.pruneBindingsForSlotKeys(
      slots.map((slot) => this.getSlotStickyKey(slot))
    )
  }

  private normalizeCodexModelName(modelName: string): string {
    return normalizeCodexRateLimitModelName(modelName)
  }

  private getCodexDisplayModel(modelName: string): string {
    const normalized = this.normalizeCodexModelName(modelName)
    return getPublicModelMetadata(normalized)?.displayName || normalized
  }

  private hasRateLimitData(account: CodexAccountSlot): boolean {
    return hasCodexRateLimitData(account.rateLimitSnapshots)
  }

  private getRateLimitModelSummary(
    account: CodexAccountSlot,
    modelName: string
  ): CodexRateLimitModelSummary | null {
    return getCodexRateLimitModelSummary(
      account.rateLimitSnapshots,
      modelName,
      (normalizedModel) => this.getCodexDisplayModel(normalizedModel)
    )
  }

  private getRateLimitAccountSummary(
    account: CodexAccountSlot
  ): CodexRateLimitAccountSummary | undefined {
    return getCodexRateLimitAccountSummary(
      account.rateLimitSnapshots,
      DEFAULT_CODEX_RATE_LIMIT_MODEL,
      (normalizedModel) => this.getCodexDisplayModel(normalizedModel)
    )
  }

  private setRateLimitSnapshot(
    slot: CodexAccountSlot,
    snapshot: CodexRateLimitSnapshot
  ): void {
    setCodexRateLimitSnapshot(
      slot.rateLimitSnapshots,
      snapshot,
      (normalizedModel) => this.getCodexDisplayModel(normalizedModel)
    )
  }

  private getWeeklyQuotaCooldownUntil(
    account: CodexAccountSlot,
    modelName: string
  ): number {
    const effective = this.getRateLimitModelSummary(
      account,
      modelName
    )?.effective
    return getCodexWeeklyQuotaCooldownUntil(effective || null)
  }

  private isRateLimitExhaustedForModel(
    slot: CodexAccountSlot,
    model: string
  ): boolean {
    const effective = this.getRateLimitModelSummary(slot, model)?.effective
    return isCodexRateLimitSnapshotExhausted(effective || null)
  }

  private isSlotAvailableForModel(
    slot: CodexAccountSlot,
    model: string,
    now: number
  ): boolean {
    return isCodexSlotAvailableForModel({
      slot,
      model,
      now,
      isRateLimitExhausted: (candidate, candidateModel) =>
        this.isRateLimitExhaustedForModel(candidate, candidateModel),
      getWeeklyQuotaCooldownUntil: (candidate, candidateModel) =>
        this.getWeeklyQuotaCooldownUntil(candidate, candidateModel),
    })
  }

  private getSlotRecoveryTimeForModel(
    slot: CodexAccountSlot,
    model: string,
    now: number
  ): number | null {
    return getCodexSlotRecoveryTimeForModel({
      slot,
      model,
      now,
      isModelSupported: (candidate, candidateModel) =>
        this.isModelSupportedBySlot(candidate, candidateModel),
      getWeeklyQuotaCooldownUntil: (candidate, candidateModel) =>
        this.getWeeklyQuotaCooldownUntil(candidate, candidateModel),
    })
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
    const slot = this.slotRouter.pickFromCurrentIndex({
      candidates: this.accounts,
      isSlotUsable: (candidate) =>
        this.isModelSupportedBySlot(candidate, normalized) &&
        this.isSlotAvailableForModel(candidate, normalized, now),
    })
    if (slot) {
      return slot
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
    const tokenData = slot.tokenData
    if (!tokenData) return

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

      payload.accounts = upsertCodexPersistedAccountRecord({
        accounts: payload.accounts,
        account: slot,
        tokenData,
        accountId: this.getSlotAccountId(slot) || undefined,
        workspaceId: slot.workspaceId || tokenData.workspaceId || undefined,
        planType: this.getSlotPlanType(slot) || undefined,
      })

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

  private hasChatGptWebCredential(slot: CodexAccountSlot): boolean {
    return !!(
      slot.tokenData?.accessToken ||
      slot.tokenData?.refreshToken ||
      slot.accessToken ||
      slot.refreshToken
    )
  }

  private async getChatGptWebAccessToken(
    slot: CodexAccountSlot
  ): Promise<string> {
    if (slot.tokenData) {
      const tokenData = await this.ensureFreshTokenData(slot)
      if (tokenData?.accessToken) return tokenData.accessToken
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
   * Attempt to refresh a slot's token on 401/403.
   * Reuses slot.refreshPromise to prevent concurrent refresh-token rotation violations.
   * Returns the new accessToken on success, null on failure.
   */
  private async tryRefreshSlotToken(
    slot: CodexAccountSlot,
    reason: string,
    options?: { allowOAuthOnApiKeySlot?: boolean }
  ): Promise<string | null> {
    if (
      (this.isApiKeyMode(slot) && !options?.allowOAuthOnApiKeySlot) ||
      !slot.tokenData?.refreshToken
    ) {
      return null
    }

    // Reuse existing refresh promise to prevent concurrent rotation violations
    if (slot.refreshPromise) {
      const existing = await slot.refreshPromise
      return existing?.accessToken || null
    }

    slot.refreshPromise = (async () => {
      this.logger.log(
        `[Codex] ${reason}: forcing token refresh for ${this.getAccountLabel(slot)}`
      )
      try {
        const refreshed = await this.authService.refreshTokensWithRetry(
          slot.tokenData?.refreshToken || "",
          2,
          { persist: false, updateState: false }
        )
        this.applyTokenDataToSlot(slot, refreshed)
        this.persistSlotTokens(slot)
        return slot.tokenData
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        this.logger.warn(
          `[Codex] ${reason}: token refresh failed for ${this.getAccountLabel(slot)}: ${errorMsg}`
        )

        // Refresh token rotation violation or revoked → permanently disable
        // this account to stop the pool from repeatedly selecting a slot
        // whose credentials are permanently invalid.
        if (isCodexRefreshTokenInvalidationMessage(errorMsg)) {
          disableAccount(slot, "token_invalidated", {
            statusCode: 401,
            message: errorMsg,
            accountLabel: this.getAccountLabel(slot),
          })
          this.persistCodexAccountStates()
        }
        return null
      } finally {
        slot.refreshPromise = undefined
      }
    })()

    const result = await slot.refreshPromise
    return result?.accessToken || null
  }

  /**
   * Determine if the slot is using an API key (vs OAuth access token).
   */
  private isApiKeyMode(slot: CodexAccountSlot): boolean {
    return !!slot.apiKey
  }

  private readProxyEnvValue(keys: string[]): string | undefined {
    for (const key of keys) {
      const value = process.env[key] || process.env[key.toLowerCase()]
      const normalized = value?.trim()
      if (normalized) {
        return normalized
      }
    }

    return undefined
  }

  /**
   * Build an undici dispatcher for Codex HTTP fetches.
   * Uses the selected slot's proxyUrl, then falls back to standard proxy env vars.
   */
  private buildProxyDispatcher(
    slot: CodexAccountSlot
  ): import("undici").Dispatcher | undefined {
    const explicitProxyUrl = slot.proxyUrl?.trim()
    if (explicitProxyUrl) {
      if (explicitProxyUrl.toLowerCase() === "direct") {
        return undefined
      }

      return this.buildExplicitProxyDispatcher(explicitProxyUrl)
    }

    return this.buildEnvProxyDispatcher()
  }

  private buildExplicitProxyDispatcher(
    proxyUrl: string
  ): import("undici").Dispatcher | undefined {
    try {
      const parsed = new URL(proxyUrl)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        this.logger.error(
          `Unsupported Codex HTTP proxy scheme for fetch: ${parsed.protocol}`
        )
        return undefined
      }

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ProxyAgent } = require("undici") as typeof import("undici")
      return new ProxyAgent(proxyUrl)
    } catch (e) {
      this.logger.error(`Failed to parse proxy URL: ${(e as Error).message}`)
      return undefined
    }
  }

  private buildEnvProxyDispatcher(): import("undici").Dispatcher | undefined {
    const allProxy = this.readProxyEnvValue(["ALL_PROXY"])
    const httpProxy = this.readProxyEnvValue(["HTTP_PROXY"]) || allProxy
    const httpsProxy =
      this.readProxyEnvValue(["HTTPS_PROXY"]) || allProxy || httpProxy
    const noProxy = this.readProxyEnvValue(["NO_PROXY"])

    if (!httpProxy && !httpsProxy) {
      return undefined
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { EnvHttpProxyAgent } = require("undici") as typeof import("undici")
      return new EnvHttpProxyAgent({
        ...(httpProxy ? { httpProxy } : {}),
        ...(httpsProxy ? { httpsProxy } : {}),
        ...(noProxy ? { noProxy } : {}),
      })
    } catch (e) {
      this.logger.error(
        `Failed to configure proxy dispatcher from env: ${(e as Error).message}`
      )
      return undefined
    }
  }

  /**
   * Build request headers matching the upstream Codex Responses client.
   */
  private buildHeaders(
    slot: CodexAccountSlot,
    token: string,
    stream: boolean,
    options: {
      localProjectionKey: string
      upstreamIdentity: CodexProviderIdentity
      omitAccountId?: boolean
      forwardHeaders?: CodexForwardHeaders
      clientMetadata: CodexForwardHeaders
      useResponsesLite?: boolean
      includeInstallationIdHeader?: boolean
    }
  ): Record<string, string> {
    return buildCodexBridgeNativeHttpHeaders({
      token,
      isApiKey: this.isApiKeyMode(slot),
      localProjectionKey: options.localProjectionKey,
      upstreamIdentity: options.upstreamIdentity,
      clientMetadata: options.clientMetadata,
      accountId: this.getSlotAccountId(slot),
      workspaceId: slot.workspaceId,
      stream,
      forwardHeaders: options.forwardHeaders,
      omitAccountId: options.omitAccountId,
      useResponsesLite: options.useResponsesLite,
      includeInstallationIdHeader: options.includeInstallationIdHeader,
      identity: {
        version: this.identity.version(),
        userAgent: this.identity.userAgent(),
        originator: this.identity.originator(),
      },
    })
  }

  private getCodexRequestClientMetadata(
    request: Record<string, unknown> | undefined
  ): CodexForwardHeaders | undefined {
    const metadata = request?.client_metadata
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return undefined
    }

    const entries = Object.entries(metadata as Record<string, unknown>).flatMap(
      ([key, value]): Array<[string, string]> =>
        typeof value === "string" && value.trim().length > 0
          ? [[key, value]]
          : []
    )

    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  }

  /**
   * Attach metadata already frozen into the physical request candidate.
   * Cursor and generic adapters both prepare this before dispatch; transport
   * execution is intentionally forbidden from creating request identity.
   */
  private attachBridgeNativeClientMetadata(
    request: Pick<CodexExecutionRequest, "upstreamIdentity" | "clientMetadata">,
    codexRequest: Record<string, unknown>
  ): {
    codexRequest: Record<string, unknown>
    clientMetadata: CodexForwardHeaders
  } {
    const clientMetadata = this.getCodexRequestClientMetadata(codexRequest)
    if (!clientMetadata || request.clientMetadata === undefined) {
      throw new Error(
        "Codex physical request is missing pre-dispatch client metadata"
      )
    }
    return {
      codexRequest: {
        ...codexRequest,
        client_metadata: clientMetadata,
      },
      clientMetadata,
    }
  }

  private requireCodexRequestClientMetadata(
    codexRequest: Record<string, unknown>
  ): CodexForwardHeaders {
    const clientMetadata = this.getCodexRequestClientMetadata(codexRequest)
    if (!clientMetadata) {
      throw new Error(
        "Codex bridge-native request is missing canonical client metadata"
      )
    }
    return clientMetadata
  }

  private logCodexUsage(
    transport: "http" | "websocket",
    modelName: string,
    cacheId: string,
    slot: CodexAccountSlot,
    event: Record<string, unknown> | null,
    requestStartedAt?: number
  ): void {
    if (event?.type === "response.completed") {
      this.logger.log(
        `[Codex][${transport === "websocket" ? "WS" : "HTTP"} Response][Completed] ` +
          summarizeCodexCompletedResponseForLogs(event)
      )
    }

    const usage = extractCodexCompletedUsage(event)
    if (!usage) return

    const durationMs =
      typeof requestStartedAt === "number"
        ? Math.max(0, Date.now() - requestStartedAt)
        : 0

    const message =
      `[Codex][Cache] transport=${transport} model=${modelName} ` +
      `cache=${cacheId || "(none)"} input=${usage.inputTokens} ` +
      `cached=${usage.cachedInputTokens} cacheWrite=${usage.cacheCreationInputTokens} ` +
      `output=${usage.outputTokens} duration=${durationMs}ms`

    this.usageStats.recordCodexUsage({
      transport,
      modelName,
      accountKey: this.getSlotStickyKey(slot),
      accountLabel: this.getAccountLabel(slot),
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      outputTokens: usage.outputTokens,
      webSearchRequests: usage.webSearchRequests,
      durationMs,
    })

    if (usage.cachedInputTokens > 0) {
      this.logger.log(message)
      return
    }

    this.logger.debug(message)
  }

  /**
   * Preserve the terminal Responses fact for internal consumers that require
   * stricter semantics than the Anthropic-facing translator. In particular,
   * Remote Compaction V2 must distinguish a stream that merely closes from a
   * completed response with one compaction output item.
   */
  private formatCodexResponseCompletedEvent(
    payload: Record<string, unknown> | null
  ): string | undefined {
    if (payload?.type !== "response.completed") return undefined
    const outcome = readCodexResponseOutcome(payload)
    if (!outcome) return undefined
    const { status: _status, ...completion } = outcome
    return `event: ${CODEX_RESPONSE_COMPLETED_EVENT}\ndata: ${JSON.stringify({ type: CODEX_RESPONSE_COMPLETED_EVENT, ...completion })}\n\n`
  }

  private formatCodexResponseTerminalEvent(
    payload: Record<string, unknown> | null
  ): string | undefined {
    if (!payload) return undefined
    const outcome = readCodexResponseOutcome(payload, {
      allowMaxOutputIncomplete: true,
    })
    if (!outcome) return undefined
    return `event: ${CODEX_RESPONSE_TERMINAL_EVENT}\ndata: ${JSON.stringify({ type: CODEX_RESPONSE_TERMINAL_EVENT, ...outcome })}\n\n`
  }

  /**
   * Snapshot the exact input at the last point before an HTTP or WebSocket
   * transport sends it. The collector is opt-in so ordinary request paths do
   * not retain additional request history.
   */
  private capturePreparedWireInput(
    capture: ((input: readonly CodexInputItem[]) => void) | undefined,
    request: Record<string, unknown>
  ): void {
    if (!capture) return
    const input = request.input
    if (!Array.isArray(input)) {
      throw new Error("Codex prepared wire request did not include input")
    }
    const snapshot = input.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(
          `Codex prepared wire input item ${index} must be an object`
        )
      }
      try {
        return JSON.parse(JSON.stringify(item)) as CodexInputItem
      } catch (error) {
        throw new Error(
          `Codex prepared wire input item ${index} is not JSON-serializable: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    })
    capture(snapshot)
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
  private getCacheId(
    request: Pick<CodexExecutionRequest, "upstreamIdentity">
  ): string {
    this.turnContexts.pruneRuntimeState()
    return resolveCodexPromptCacheKey(
      this.getUpstreamIdentity(request).sessionId
    )
  }

  private createAllAccountsRateLimitedError(modelName: string): CodexApiError {
    const now = Date.now()
    const normalizedModelName = modelName.toLowerCase().trim()
    const retrySeconds = getAllCodexAccountsRateLimitedRetrySeconds(
      this.accounts.map((slot) =>
        this.getSlotRecoveryTimeForModel(slot, normalizedModelName, now)
      ),
      now
    )
    return new CodexApiError(
      429,
      `All Codex accounts are rate-limited for model ${modelName}. ` +
        `Retry after ${retrySeconds} seconds.`,
      retrySeconds
    )
  }

  private findNextAvailableAccount(
    model: string
  ): { slot: CodexAccountSlot; index: number } | null {
    const now = Date.now()
    const normalized = model.toLowerCase().trim()
    const selection = this.slotRouter.findFromCurrentIndex({
      candidates: this.accounts,
      isSlotUsable: (slot) =>
        this.isModelSupportedBySlot(slot, normalized) &&
        this.isSlotAvailableForModel(slot, normalized, now),
    })

    return selection
      ? { slot: selection.account, index: selection.index }
      : null
  }

  private isWarmPoolSlotUsable(
    slot: CodexAccountSlot,
    normalizedModel: string,
    now: number
  ): boolean {
    if (!this.isModelSupportedBySlot(slot, normalizedModel)) {
      return false
    }

    if (!this.isSlotAvailableForModel(slot, normalizedModel, now)) {
      return false
    }

    const wsUrl = this.wsService.buildWebSocketUrl(
      this.buildUrl(slot, "responses")
    )
    return this.turnContexts.getWarmPoolAvailability({
      slotKey: this.getSlotStickyKey(slot),
      modelName: normalizedModel,
      wsUrl,
      hasOpenSessionConnection: (sessionId, targetWsUrl) =>
        this.wsService.hasOpenSessionConnection(sessionId, targetWsUrl),
    }).available
  }

  private findWarmPoolAccount(
    model: string
  ): { slot: CodexAccountSlot; index: number } | null {
    if (!this.useWebSocket || !this.wsService.isWebSocketAvailable()) {
      return null
    }

    const now = Date.now()
    const normalized = model.toLowerCase().trim()
    const selection = this.slotRouter.findFromCurrentIndex({
      candidates: this.accounts,
      isSlotUsable: (slot) => this.isWarmPoolSlotUsable(slot, normalized, now),
    })

    return selection
      ? { slot: selection.account, index: selection.index }
      : null
  }

  private pickWarmPoolAccount(model: string): CodexAccountSlot | null {
    if (!this.useWebSocket || !this.wsService.isWebSocketAvailable()) {
      return null
    }

    const now = Date.now()
    const normalized = model.toLowerCase().trim()
    return this.slotRouter.pickFromCurrentIndex({
      candidates: this.accounts,
      isSlotUsable: (slot) => this.isWarmPoolSlotUsable(slot, normalized, now),
    })
  }

  private selectWarmupSlot(
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

    const selection = resolveCodexSlotSelection({
      getStickySlot: () =>
        conversationId
          ? this.getStickyConversationSlot(conversationId, modelName)
          : null,
      getWarmPoolSlot: () => this.findWarmPoolAccount(modelName)?.slot ?? null,
      getNextAvailableSlot: () =>
        this.findNextAvailableAccount(modelName)?.slot ?? null,
      preferWarmPool: true,
    })
    if (selection.kind === "none") {
      throw this.createAllAccountsRateLimitedError(modelName)
    }

    return selection.slot
  }

  private selectRequestSlot(
    modelName: string,
    conversationId?: string,
    options?: {
      preferWarmPool?: boolean
    }
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

    const selection = resolveCodexSlotSelection({
      getStickySlot: () =>
        conversationId
          ? this.getStickyConversationSlot(conversationId, modelName)
          : null,
      getWarmPoolSlot: () => this.pickWarmPoolAccount(modelName),
      getNextAvailableSlot: () => this.pickNextAvailableAccount(modelName),
      preferWarmPool: options?.preferWarmPool,
    })
    if (selection.kind === "none") {
      throw this.createAllAccountsRateLimitedError(modelName)
    }
    return selection.slot
  }

  private codexPhysicalErrorClass(error: unknown): BackendErrorClass {
    if (error instanceof CodexApiError) {
      if (error.errorClass) return error.errorClass
      const statusCode = error.getStatus()
      if (statusCode === 401 || statusCode === 403) return "auth_failed"
      if (statusCode === 429) return "rate_limited"
      if (statusCode >= 500 && statusCode < 600) return "transient_5xx"
    }
    return classifyBackendError(error)
  }

  /**
   * Convert one completed physical-send failure into a decision for the
   * caller-owned attempt runner. This method never sends another request.
   */
  private async toRetryableCodexPhysicalFailure(
    error: unknown,
    modelName: string,
    slot?: CodexAccountSlot
  ): Promise<ProviderAttemptRetryableError> {
    if (isProviderAttemptRetryableError(error)) {
      return error
    }
    const errorClass = this.codexPhysicalErrorClass(error)
    const policy = RETRY_POLICY[errorClass]
    if (!policy.retryableSameRequest && !policy.retryableDifferentAccount) {
      throw error
    }

    const statusCode =
      error instanceof CodexApiError ? error.getStatus() : undefined
    const retryAfterMs =
      error instanceof CodexApiError && error.retryAfterSeconds !== undefined
        ? Math.min(
            error.retryAfterSeconds * 1_000,
            this.allRateLimitMaxWaitSeconds * 1_000
          )
        : undefined

    if (slot && statusCode !== undefined) {
      let refreshed = false
      if (errorClass === "auth_failed" && !this.isApiKeyMode(slot)) {
        refreshed = !!(await this.tryRefreshSlotToken(
          slot,
          `${statusCode} physical dispatch failure`
        ))
      }
      if (!refreshed) {
        markAccountCooldown(
          slot,
          statusCode,
          modelName,
          error instanceof CodexApiError
            ? error.retryAfterSeconds?.toString()
            : undefined,
          this.getAccountLabel(slot)
        )
      }
    }

    return new ProviderAttemptRetryableError(
      `Codex physical dispatch failed before acceptance: ${
        error instanceof Error ? error.message : String(error)
      }`,
      {
        backend: "codex",
        errorClass,
        statusCode,
        retryAfterMs,
        maxRetries:
          errorClass === "rate_limited" && !slot
            ? this.allRateLimitMaxRetries
            : policy.maxRetries,
      }
    )
  }

  // ── Non-streaming ────────────────────────────────────────────────────

  /**
   * Send exactly one non-streaming Codex request.
   *
   * Lifecycle ownership deliberately remains above this provider boundary.
   * A caller must activate the dispatch before invoking this method, accept
   * the resulting response once it crosses its protocol boundary, and create
   * a new dispatch if this method reports a retryable physical failure.
   */
  async sendMessage(
    dispatch: ProviderPhysicalDispatch<CodexExecutionRequest>,
    options: CodexNonStreamDispatchOptions = {}
  ): Promise<AnthropicResponse> {
    assertProviderPhysicalDispatch({
      dispatch,
      backend: "codex",
      label: "Codex non-stream dispatch",
    })
    if (dispatch.request.model !== dispatch.attempt.model) {
      throw new Error(
        "Codex non-stream request model does not match its physical attempt model"
      )
    }
    this.onLiveRequestStart()
    try {
      return await this.executeNonStreamOnce(dispatch, options.forwardHeaders)
    } finally {
      this.onLiveRequestEnd()
    }
  }

  async compactConversationHistory(
    request: CodexRemoteCompactionV2Request,
    forwardHeaders?: CodexForwardHeaders
  ): Promise<CodexRemoteCompactionV2Result> {
    request.signal.throwIfAborted()

    // Codex Remote Compaction V2 uses the ordinary Responses streaming API.
    // It starts from the exact native prompt history and appends one terminal
    // trigger; it never reprojects a UnifiedMessage transcript or calls the
    // retired dedicated compaction endpoint.
    const requestInput = buildCodexRemoteCompactionV2Input(request.nativeInput)
    const preTriggerInput = requestInput.slice(0, -1)
    assertCodexRemoteCompactionV2RequestInput(preTriggerInput, requestInput)
    const compactRequest: CodexNativeInputExecutionRequest = {
      model: request.model,
      system: request.system,
      nativeInput: requestInput,
      // A remote compaction query consumes an exact rollout but is not an
      // assistant turn in the conversation response chain.
      continuationPolicy: "isolated",
      tools: request.tools,
      upstreamIdentity: request.upstreamIdentity,
      localProjectionKey: request.localProjectionKey,
      thinkingIntent: request.thinkingIntent,
      includeThinkingSummary: request.includeThinkingSummary,
      serviceTier: request.serviceTier,
      parallelToolCalls: request.parallelToolCalls,
      clientMetadata: request.clientMetadata,
      textVerbosity: request.textVerbosity,
    }

    // Keep a preview for request logging. The result's `wireInput` is captured
    // later at the actual HTTP/WS send boundary, because a live WebSocket may
    // use the upstream ModelClientSession incremental representation.
    const previewRequest = prepareCodexRequestForSend(
      buildCodexRequest(compactRequest, request.model)
    )
    assertCodexRemoteCompactionV2WireInput(previewRequest.input)

    this.logger.debug(
      `[Codex][RemoteCompactionV2 Request] ${summarizeCodexRequestForLogs(previewRequest)}`
    )

    return runProviderPhysicalDispatch({
      plan: {
        scope: `codex:remote-compaction:${request.localProjectionKey}:${crypto.randomUUID()}`,
        backend: "codex",
        model: request.model,
        request: compactRequest,
      },
      signal: request.signal,
      execute: async (dispatch) => {
        const collector = createCodexRemoteCompactionV2Collector()
        const wireInputCapture = new CodexRemoteCompactionV2WireInputCapture()
        this.preparedWireInputCaptures.set(dispatch.request, (input) => {
          wireInputCapture.record(input)
        })
        try {
          for await (const event of this.sendMessageStream(dispatch, {
            forwardHeaders,
            abortSignal: request.signal,
          })) {
            // A remote compaction can become durable upstream before its
            // terminal response.completed frame. Do not replay it after any
            // provider output has crossed this boundary.
            if (!dispatch.lifecycle.acceptanceStarted) {
              await dispatch.lifecycle.accept({})
            }
            collector.acceptSseEvent(event)
          }
          request.signal.throwIfAborted()
          const wireInput = wireInputCapture.take()
          assertCodexRemoteCompactionV2WireInput(wireInput)
          return collector.finish({ preTriggerInput, requestInput, wireInput })
        } finally {
          this.preparedWireInputCaptures.delete(dispatch.request)
        }
      },
    })
  }

  /** Execute one native Codex standalone search against `alpha/search`. */
  async executeWebSearch(input: {
    query: string
    model?: string
    conversationId?: string
    signal?: AbortSignal
    allowedDomains?: readonly string[]
    blockedDomains?: readonly string[]
    searchType?: "auto" | "fast" | "deep"
  }): Promise<{
    text: string
    references: Array<{ title: string; url: string; chunk: string }>
  }> {
    const query = input.query.trim()
    if (!query) {
      return { text: "", references: [] }
    }

    const requestedModel = input.model?.trim() || ""
    const modelName =
      requestedModel && this.hasSupportingAccount(requestedModel)
        ? requestedModel
        : DEFAULT_CODEX_RATE_LIMIT_MODEL
    const conversationId =
      input.conversationId || `web-search-${crypto.randomUUID()}`
    const upstreamIdentity = createCodexRootProviderIdentity()
    const searchRequest = buildCodexStandaloneSearchRequest({
      query,
      model: modelName,
      conversationId,
      upstreamIdentity,
      allowedDomains: input.allowedDomains,
      blockedDomains: input.blockedDomains,
      searchType: input.searchType,
    })
    this.onLiveRequestStart()
    try {
      const response = await runProviderPhysicalDispatch({
        plan: {
          scope: `codex:web-search:${conversationId}:${crypto.randomUUID()}`,
          backend: "codex",
          model: modelName,
          request: searchRequest,
        },
        signal: input.signal,
        execute: (dispatch) =>
          this.dispatchCodexStandaloneSearchRequest(dispatch, {
            signal: input.signal,
            timeoutMs: 300_000,
          }),
      })
      return decodeCodexStandaloneSearchResponse(await response.json())
    } finally {
      this.onLiveRequestEnd()
    }
  }

  async generateImage(input: {
    prompt: string
    model?: string
    conversationId?: string
    outputFormat?: string
  }): Promise<{
    imageData: string
    revisedPrompt?: string
    status?: string
  }> {
    const prompt = input.prompt.trim()
    if (!prompt) {
      throw new Error("Image generation prompt is required")
    }

    const requestedModel = input.model?.trim() || ""
    const modelName =
      requestedModel && this.hasSupportingAccount(requestedModel)
        ? requestedModel
        : DEFAULT_CODEX_RATE_LIMIT_MODEL
    const conversationId =
      input.conversationId || `image-${crypto.randomUUID()}`
    const upstreamIdentity = createCodexRootProviderIdentity()
    const executionRequest = this.prepareBridgeNativeExecutionRequest({
      model: modelName,
      upstreamIdentity,
      localProjectionKey: conversationId,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      tools: [
        {
          type: "image_generation",
          name: "image_generation",
          description: "Generate an image from the user prompt.",
          output_format: input.outputFormat?.trim() || "png",
        },
      ],
      parallelToolCalls: false,
      textVerbosity: "low",
    })
    this.onLiveRequestStart()
    try {
      const response = await runProviderPhysicalDispatch({
        plan: {
          scope: `codex:image-generation:${conversationId}:${crypto.randomUUID()}`,
          backend: "codex",
          model: modelName,
          request: executionRequest,
        },
        execute: (dispatch) =>
          this.dispatchCodexServerToolRequest(dispatch, {
            timeoutMs: 600_000,
          }),
      })
      const fullBody = await response.text()
      let imageData = ""
      let revisedPrompt: string | undefined
      let status: string | undefined

      for (const line of fullBody.split("\n")) {
        const payload = parseCodexSsePayload(line.trim())
        const item =
          payload?.type === "response.output_item.done" &&
          payload.item &&
          typeof payload.item === "object"
            ? (payload.item as Record<string, unknown>)
            : undefined
        if (item?.type === "image_generation_call") {
          if (typeof item.result === "string" && item.result.trim()) {
            imageData = item.result.trim()
          }
          if (typeof item.revised_prompt === "string") {
            revisedPrompt = item.revised_prompt
          }
          if (typeof item.status === "string") {
            status = item.status
          }
        }

        const responseOutput =
          payload?.type === "response.completed" &&
          payload.response &&
          typeof payload.response === "object"
            ? (payload.response as Record<string, unknown>).output
            : undefined
        if (Array.isArray(responseOutput)) {
          for (const outputItem of responseOutput) {
            if (
              outputItem &&
              typeof outputItem === "object" &&
              (outputItem as Record<string, unknown>).type ===
                "image_generation_call"
            ) {
              const record = outputItem as Record<string, unknown>
              if (typeof record.result === "string" && record.result.trim()) {
                imageData = record.result.trim()
              }
              if (typeof record.revised_prompt === "string") {
                revisedPrompt = record.revised_prompt
              }
              if (typeof record.status === "string") {
                status = record.status
              }
            }
          }
        }
      }

      if (!imageData) {
        throw new Error("Codex image_generation completed without image data")
      }

      return { imageData, revisedPrompt, status }
    } finally {
      this.onLiveRequestEnd()
    }
  }

  /**
   * Dispatch exactly one server-side Responses tool request. A successful HTTP
   * response is the upstream acceptance boundary even when its SSE body is
   * still being parsed locally, so a malformed or interrupted body can never
   * cause this model request to be replayed.
   */
  private async dispatchCodexServerToolRequest(
    dispatch: ProviderPhysicalDispatch<CodexExecutionRequest>,
    options: CodexServerToolExecutionOptions
  ): Promise<Response> {
    assertProviderPhysicalDispatch({
      dispatch,
      backend: "codex",
      label: "Codex server tool dispatch",
    })
    if (dispatch.request.model !== dispatch.attempt.model) {
      throw new Error(
        "Codex server tool request model does not match its physical attempt model"
      )
    }

    const request = dispatch.request
    const modelName = request.model
    let slot: CodexAccountSlot | undefined

    try {
      options.signal?.throwIfAborted()
      slot = this.selectRequestSlot(
        modelName,
        this.getLocalProjectionKey(request),
        { preferWarmPool: false }
      )
      const token = await this.getBearerToken(slot)
      if (!token) {
        throw new Error(
          "Codex backend not configured: no API key or access token"
        )
      }

      const { codexRequest: assembledCodexRequest, clientMetadata } =
        this.attachBridgeNativeClientMetadata(
          request,
          buildCodexRequest(
            {
              ...request,
              modelProfile: getCodexModelProfile(
                modelName,
                this.modelCatalogScope(slot)
              ),
            },
            modelName
          ) as Record<string, unknown>
        )
      const codexRequest = this.cacheService.injectSessionCacheKey(
        assembledCodexRequest,
        this.getUpstreamIdentity(request)
      )
      const url = this.buildUrl(slot, "responses")
      const headers = this.buildHeaders(slot, token, true, {
        localProjectionKey: this.getLocalProjectionKey(request),
        upstreamIdentity: this.getUpstreamIdentity(request),
        clientMetadata,
        useResponsesLite: this.usesResponsesLite(modelName, slot),
      })
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs)
      const fetchOptions: RequestInit & { dispatcher?: unknown } = {
        method: "POST",
        headers,
        body: JSON.stringify(prepareCodexRequestForSend(codexRequest)),
        signal: options.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal,
      }
      const dispatcher = this.buildProxyDispatcher(slot)
      if (dispatcher) {
        fetchOptions.dispatcher = dispatcher
      }

      const response = await fetch(url, fetchOptions)
      if (!response.ok) {
        const errorBody = await response.text()
        throw createCodexApiErrorFromBody(response.status, errorBody)
      }

      this.captureCodexRateLimitHeaders(
        response.headers,
        slot,
        modelName,
        "request"
      )
      await dispatch.lifecycle.accept({})
      markAccountSuccess(slot, modelName)
      return response
    } catch (error) {
      if (
        dispatch.lifecycle.acceptanceStarted ||
        isProviderAttemptRetryableError(error)
      ) {
        throw error
      }
      options.signal?.throwIfAborted()
      throw await this.toRetryableCodexPhysicalFailure(error, modelName, slot)
    }
  }

  /** Complete one physical native `alpha/search` dispatch. */
  private async dispatchCodexStandaloneSearchRequest(
    dispatch: ProviderPhysicalDispatch<CodexStandaloneSearchRequest>,
    options: CodexServerToolExecutionOptions
  ): Promise<Response> {
    assertProviderPhysicalDispatch({
      dispatch,
      backend: "codex",
      label: "Codex standalone search dispatch",
    })
    const request = dispatch.request
    if (request.model !== dispatch.attempt.model) {
      throw new Error(
        "Codex standalone search model does not match its physical attempt model"
      )
    }

    const modelName = request.model
    let slot: CodexAccountSlot | undefined
    try {
      options.signal?.throwIfAborted()
      slot = this.selectRequestSlot(modelName, request.localProjectionKey, {
        preferWarmPool: false,
      })
      const token = await this.getBearerToken(slot)
      if (!token) {
        throw new Error(
          "Codex backend not configured: no API key or access token"
        )
      }

      const headers = buildCodexNonTurnHttpHeaders({
        token,
        isApiKey: this.isApiKeyMode(slot),
        accept: "application/json",
        identity: {
          version: this.identity.version(),
          userAgent: this.identity.userAgent(),
          originator: this.identity.originator(),
        },
        accountId: this.getSlotAccountId(slot),
        workspaceId: slot.workspaceId,
      })
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs)
      const fetchOptions: RequestInit & { dispatcher?: unknown } = {
        method: "POST",
        headers,
        body: JSON.stringify(request.search),
        signal: options.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal,
      }
      const dispatcher = this.buildProxyDispatcher(slot)
      if (dispatcher) {
        fetchOptions.dispatcher = dispatcher
      }

      const response = await fetch(
        this.buildUrl(slot, "alpha/search"),
        fetchOptions
      )
      if (!response.ok) {
        const errorBody = await response.text()
        throw createCodexApiErrorFromBody(response.status, errorBody)
      }

      this.captureCodexRateLimitHeaders(
        response.headers,
        slot,
        modelName,
        "request"
      )
      await dispatch.lifecycle.accept({})
      markAccountSuccess(slot, modelName)
      return response
    } catch (error) {
      if (
        dispatch.lifecycle.acceptanceStarted ||
        isProviderAttemptRetryableError(error)
      ) {
        throw error
      }
      options.signal?.throwIfAborted()
      throw await this.toRetryableCodexPhysicalFailure(error, modelName, slot)
    }
  }

  /**
   * Complete one physical non-stream transport dispatch. Slot selection,
   * connection establishment, and the wire send happen once. Any retryable
   * result is returned to the attempt owner as a typed failure instead of
   * recursively sending the same request through another slot or transport.
   */
  private async executeNonStreamOnce(
    dispatch: ProviderPhysicalDispatch<CodexExecutionRequest>,
    forwardHeaders?: CodexForwardHeaders
  ): Promise<AnthropicResponse> {
    const request = dispatch.request
    await this.refreshModelCatalogs()
    const modelName = request.model
    let slot: CodexAccountSlot
    try {
      slot = this.selectRequestSlot(
        request.model,
        this.getLocalProjectionKey(request),
        {
          preferWarmPool: !this.hasConversationContinuationState(
            this.getLocalProjectionKey(request)
          ),
        }
      )
    } catch (error) {
      throw await this.toRetryableCodexPhysicalFailure(error, modelName)
    }

    const token = await this.getBearerToken(slot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    this.bindConversationToSlot(this.getLocalProjectionKey(request), slot)

    const reverseToolMap = buildReverseMapFromClaudeTools(request.tools)
    let codexRequest = buildCodexRequest(
      {
        ...request,
        modelProfile: getCodexModelProfile(
          modelName,
          this.modelCatalogScope(slot)
        ),
      },
      modelName
    ) as Record<string, unknown>
    codexRequest = this.attachBridgeNativeClientMetadata(
      request,
      codexRequest
    ).codexRequest

    const cacheId = this.getCacheId(request)
    codexRequest = this.cacheService.injectSessionCacheKey(
      codexRequest,
      this.getUpstreamIdentity(request)
    )
    const conversationId = this.getLocalProjectionKey(request)
    const turnKey = this.getCodexTurnKey(codexRequest)
    const shouldTryWebSocket =
      this.useWebSocket &&
      this.wsService.isWebSocketAvailable() &&
      !this.isHttpFallbackTransport(conversationId, slot, modelName)
    const turnContext = shouldTryWebSocket
      ? this.resolveSharedTurnContext(
          request,
          conversationId,
          slot,
          modelName,
          turnKey
        )
      : undefined
    const attemptReceipt: CodexPhysicalAttemptReceipt = {}

    try {
      let result: AnthropicResponse

      // Try WebSocket transport first when enabled for this Codex session.
      if (shouldTryWebSocket) {
        try {
          result = await this.sendViaWebSocket(
            slot,
            token,
            codexRequest,
            modelName,
            reverseToolMap,
            cacheId,
            request,
            forwardHeaders,
            turnContext,
            attemptReceipt
          )
        } catch (e) {
          const failureAction = resolveCodexWebSocketFailure(e, {
            isApiKeyMode: this.isApiKeyMode(slot),
          })

          switch (failureAction.kind) {
            case "retry_http_without_account":
              this.logger.warn(
                `[Codex] WebSocket returned deactivated_workspace for ${this.getAccountLabel(slot)}; retrying on a new HTTP attempt without Chatgpt-Account-Id`
              )
              this.recordHttpFallbackTransport(
                conversationId,
                slot,
                modelName,
                "WebSocket deactivated_workspace forced a new HTTP attempt",
                true
              )
              throw new ProviderAttemptRetryableError(
                "Codex WebSocket rejected the account header; retry on a new HTTP attempt",
                {
                  backend: "codex",
                  errorClass: "auth_failed",
                  statusCode: failureAction.statusCode,
                  maxRetries: 1,
                  nextTransport: "http",
                }
              )
            case "fallback_http":
              if (failureAction.reason === "upgrade_rejected") {
                this.logger.warn(
                  "WebSocket upgrade rejected; retrying on a new HTTP attempt"
                )
              } else {
                this.logger.warn(
                  `[Codex] WebSocket transport unavailable; retrying on a new HTTP attempt: ${e instanceof Error ? e.message : String(e)}`
                )
              }
              this.recordHttpFallbackTransport(
                conversationId,
                slot,
                modelName,
                "WebSocket transport requires a new HTTP attempt"
              )
              throw new ProviderAttemptRetryableError(
                "Codex WebSocket transport failed; retry on a new HTTP attempt",
                {
                  backend: "codex",
                  errorClass: "transient_network",
                  maxRetries: RETRY_POLICY.transient_network.maxRetries,
                  nextTransport: "http",
                }
              )
            case "throw_codex_api_error":
              throw createCodexApiErrorFromBody(
                failureAction.statusCode,
                failureAction.body
              )
            case "throw_original":
              throw e
          }
        }
      } else {
        this.stageAcceptedHttpTransportTurn(
          attemptReceipt,
          conversationId,
          slot,
          modelName,
          this.isHttpFallbackTransport(conversationId, slot, modelName)
            ? "Codex session pinned to HTTP transport"
            : "WebSocket transport disabled or unavailable",
          this.resolveContinuationPolicy(request)
        )
        result = await this.sendViaHttp(
          slot,
          token,
          codexRequest,
          modelName,
          reverseToolMap,
          cacheId,
          request,
          this.shouldOmitAccountIdForHttpTransport(
            conversationId,
            slot,
            modelName
          ),
          forwardHeaders,
          turnContext
        )
      }

      // Success — clear any cooldown on this slot
      await dispatch.lifecycle.accept({})
      if (dispatch.lifecycle.state === "accepted") {
        this.commitPendingContinuationAttempt(attemptReceipt.continuation)
        this.commitAcceptedHttpTransportTurn(attemptReceipt.httpTransport)
      }
      markAccountSuccess(slot, modelName)
      return result
    } catch (error) {
      if (dispatch.lifecycle.acceptanceStarted) {
        throw error
      }
      if (isProviderAttemptRetryableError(error)) {
        throw error
      }
      if (isCodexStaleResponseIdError(error)) {
        throw error
      }
      throw await this.toRetryableCodexPhysicalFailure(error, modelName, slot)
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
    request: Pick<
      CodexExecutionRequest,
      "model" | "localProjectionKey" | "upstreamIdentity" | "clientMetadata"
    >,
    omitAccountId: boolean = false,
    forwardHeaders?: CodexForwardHeaders,
    turnContext?: CodexTurnContext
  ): Promise<AnthropicResponse> {
    const requestStartedAt = Date.now()
    const conversationId = this.getLocalProjectionKey(request)
    const preparedCodexRequest = prepareCodexRequestForSend(codexRequest)
    const requestBody = JSON.stringify(preparedCodexRequest)
    const url = this.buildUrl(slot, "responses")
    const headers = this.buildHeaders(slot, token, true, {
      localProjectionKey: conversationId,
      upstreamIdentity: this.getUpstreamIdentity(request),
      omitAccountId,
      forwardHeaders,
      clientMetadata: this.requireCodexRequestClientMetadata(codexRequest),
      useResponsesLite: this.usesResponsesLite(modelName, slot),
    })
    this.applyCodexTurnStateHeader(headers, turnContext)

    this.logger.log(
      buildCodexDispatchLogLine({
        slotLabel: this.getAccountLabel(slot),
        modelName,
        transport: "http",
        omitAccountId,
        accountId: this.getSlotAccountId(slot),
        workspaceId: slot.workspaceId,
        headers,
      })
    )
    this.logger.log(
      buildCodexHttpRequestLogLine({
        kind: "non_stream",
        modelName,
        url,
        codexRequest: preparedCodexRequest,
      })
    )
    this.logger.debug(
      `[Codex][HTTP Request][Payload] ${summarizeCodexRequestForLogs(preparedCodexRequest)}`
    )

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(300_000),
    }

    const dispatcher = this.buildProxyDispatcher(slot)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    const response = await fetch(url, fetchOptions)

    if (!response.ok) {
      const errorBody = await response.text()
      this.logger.error(
        `[Codex] Request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
      )

      const failureAction = resolveCodexHttpErrorResponse(
        response.status,
        errorBody,
        {
          omitAccountId,
          isApiKeyMode: this.isApiKeyMode(slot),
        }
      )

      switch (failureAction.kind) {
        case "retry_http_without_account":
          this.logger.warn(
            `[Codex] deactivated_workspace for ${this.getAccountLabel(slot)}; retrying on a new physical attempt without Chatgpt-Account-Id`
          )
          this.recordHttpFallbackTransport(
            conversationId,
            slot,
            modelName,
            "HTTP rejected the account header",
            true
          )
          throw new ProviderAttemptRetryableError(
            "Codex HTTP rejected the account header; retry on a new physical attempt",
            {
              backend: "codex",
              errorClass: "auth_failed",
              statusCode: response.status,
              maxRetries: 1,
              nextTransport: "http",
            }
          )
        case "throw_codex_api_error":
          throw createCodexApiErrorFromBody(
            failureAction.statusCode,
            failureAction.body,
            { retryAfterHeader: response.headers.get("retry-after") }
          )
      }
    }

    // Read the full SSE stream and find response.completed
    this.captureCodexRateLimitHeaders(
      response.headers,
      slot,
      modelName,
      "request"
    )
    this.modelCatalogCache.invalidate(
      this.modelCatalogScope(slot),
      response.headers.get("x-models-etag")
    )
    this.captureCodexTurnStateFromHttpHeaders(turnContext, response.headers)
    if (!response.body)
      throw new CodexApiError(502, "Codex response has no body")
    const collectedItems: Record<string, unknown>[] = []
    for await (const event of readCodexResponseEvents(
      response.body,
      fetchOptions.signal ?? undefined
    )) {
      readCodexResponseOutcome(event)
      this.captureCodexTurnStateFromSsePayload(turnContext, event)
      if (
        event.type === "response.output_item.done" &&
        event.item &&
        typeof event.item === "object"
      )
        collectedItems.push(event.item as Record<string, unknown>)
      if (event.type === "response.completed") {
        this.logCodexUsage(
          "http",
          modelName,
          cacheId,
          slot,
          event,
          requestStartedAt
        )
        const completedResponse = event.response as Record<string, unknown>
        const output = completedResponse.output
        const completedEvent =
          Array.isArray(output) && output.length
            ? event
            : {
                ...event,
                response: { ...completedResponse, output: collectedItems },
              }
        const result = translateCodexToClaudeNonStream(
          completedEvent,
          reverseToolMap
        )
        if (result) return result
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
    request: Pick<
      CodexExecutionRequest,
      | "model"
      | "localProjectionKey"
      | "upstreamIdentity"
      | "clientMetadata"
      | "continuationPolicy"
      | "responseFormat"
    >,
    forwardHeaders?: CodexForwardHeaders,
    turnContextOverride?: CodexTurnContext,
    attemptReceipt: CodexPhysicalAttemptReceipt = {}
  ): Promise<AnthropicResponse> {
    const requestStartedAt = Date.now()
    const httpUrl = this.buildUrl(slot, "responses")
    const wsUrl = this.wsService.buildWebSocketUrl(httpUrl)
    const conversationId = this.getLocalProjectionKey(request)
    const turnKey = this.getCodexTurnKey(codexRequest)
    const turnContext =
      turnContextOverride ??
      this.resolveSharedTurnContext(
        request,
        conversationId,
        slot,
        modelName,
        turnKey
      )
    const wsHeaders = this.wsService.buildBridgeNativeWebSocketHeaders(
      token,
      this.isApiKeyMode(slot),
      {
        localProjectionKey: conversationId,
        upstreamIdentity: this.getUpstreamIdentity(request),
        clientMetadata: this.requireCodexRequestClientMetadata(codexRequest),
      },
      this.getSlotAccountId(slot),
      slot.workspaceId,
      forwardHeaders,
      false,
      this.usesResponsesLite(modelName, slot)
    )
    this.applyCodexTurnStateHeader(wsHeaders, turnContext)
    const sessionId =
      turnContext?.wsSessionId ||
      (this.resolveContinuationPolicy(request) === "isolated"
        ? ""
        : this.getCachedWsKey(slot, request.model))

    const buildWsBody = (requestForSend: Record<string, unknown>) =>
      this.wsService.buildWebSocketRequestBody(
        prepareCodexRequestForSend(requestForSend),
        {
          useResponsesLite: this.usesResponsesLite(modelName, slot),
          forwardHeaders,
          streamRequestStartMs: Date.now(),
          turnState: turnContext?.turnState,
        }
      )

    const logWsRequest = (wsBody: Record<string, unknown>) => {
      this.logger.log(
        buildCodexDispatchLogLine({
          slotLabel: this.getAccountLabel(slot),
          modelName,
          transport: "websocket",
          omitAccountId: false,
          accountId: this.getSlotAccountId(slot),
          workspaceId: slot.workspaceId,
          headers: wsHeaders,
        })
      )
      this.logger.log(
        `[Codex] WebSocket non-stream request: model=${modelName}, url=${wsUrl}`
      )
      this.logger.debug(
        `[Codex][WS Request][Payload] ${summarizeCodexRequestForLogs(wsBody)}`
      )
    }

    const captureNonStreamResponse = (
      completedEvent: Record<string, unknown>
    ) => {
      if (!conversationId || !turnContext) {
        return
      }

      const response = completedEvent.response as
        | Record<string, unknown>
        | undefined
      const output = response?.output
      const itemsAdded: CodexInputItem[] = []
      if (Array.isArray(output)) {
        for (const item of output) {
          appendCodexResponseOutputItemToLedger(
            itemsAdded,
            item as Record<string, unknown> | undefined
          )
        }
      }

      const capturedId = getCodexCompletedResponseId(completedEvent)
      if (capturedId) {
        this.captureResponseInTurnContext(
          conversationId,
          capturedId,
          itemsAdded,
          attemptReceipt.continuation
        )
      }
    }

    const executeRequest = async (
      ws: WebSocket,
      requestForSend: Record<string, unknown>
    ): Promise<AnthropicResponse> => {
      const wsBody = buildWsBody(requestForSend)
      logWsRequest(wsBody)
      const completedEvent = await this.wsService.sendViaWebSocket(ws, wsBody, {
        onMessage: (msg) =>
          this.captureCodexTurnStateFromSsePayload(
            turnContext,
            msg as Record<string, unknown>
          ),
      })
      this.logCodexUsage(
        "websocket",
        modelName,
        cacheId,
        slot,
        completedEvent as Record<string, unknown>,
        requestStartedAt
      )
      captureNonStreamResponse(completedEvent as Record<string, unknown>)

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

    if (sessionId && conversationId && sessionId !== conversationId) {
      this.logger.debug(
        `[Codex] Reusing warm WebSocket pool session ${sessionId} for initial request conversation=${conversationId}`
      )
    }

    const planWebSocketRequest = (
      requestForSend: Record<string, unknown>,
      continuationPolicy: CodexContinuationPolicy = this.resolveContinuationPolicy(
        request
      )
    ): CodexPreparedTransportRequest =>
      turnContext && conversationId
        ? this.planRequestWithTurnContext(
            requestForSend,
            turnContext,
            conversationId,
            continuationPolicy
          )
        : { request: requestForSend }

    try {
      if (!sessionId) {
        const ws = await this.wsService.connect(
          wsUrl,
          wsHeaders,
          slot.proxyUrl || undefined
        )
        this.modelCatalogCache.invalidate(
          this.modelCatalogScope(slot),
          this.wsService.getConnectionMetadata(ws)?.modelsEtag
        )
        this.captureCodexTurnStateFromConnection(turnContext, ws)
        try {
          const prepared = planWebSocketRequest(codexRequest)
          attemptReceipt.continuation = prepared.continuation
          return await executeRequest(ws, prepared.request)
        } finally {
          ws.close()
        }
      }

      const { release } = await this.wsService.acquireSession(sessionId)
      try {
        const sessionState = this.wsService.getOrCreateSession(sessionId)
        const hadOpenConnection =
          !!sessionState.conn &&
          sessionState.wsUrl === wsUrl &&
          sessionState.conn.readyState === 1

        const ws = await this.wsService.ensureSessionConnection(
          sessionId,
          wsUrl,
          wsHeaders,
          slot.proxyUrl || undefined
        )
        this.modelCatalogCache.invalidate(
          this.modelCatalogScope(slot),
          this.wsService.getConnectionMetadata(ws)?.modelsEtag
        )
        this.captureCodexTurnStateFromConnection(turnContext, ws)

        const originalCodexRequest = codexRequest
        const continuationPolicy = this.resolveWebSocketContinuationPolicy(
          request,
          !hadOpenConnection
        )
        if (!hadOpenConnection && continuationPolicy === "full") {
          this.logger.debug(
            `[Codex][TurnContext] WebSocket non-stream connection rebuilt for ${conversationId}; ` +
              "staged a full-input continuation candidate"
          )
        }
        const prepared = planWebSocketRequest(codexRequest, continuationPolicy)
        attemptReceipt.continuation = prepared.continuation
        const requestForSend = prepared.request

        try {
          return await executeRequest(ws, requestForSend)
        } catch (error) {
          if (
            typeof requestForSend.previous_response_id === "string" &&
            isCodexStaleResponseIdError(error)
          ) {
            this.logger.warn(
              `[Codex] Previous response_id rejected by server for ${conversationId}; ` +
                `clearing the continuation baseline for a later full request`
            )
            this.beginFullCodexResponseChain(
              turnContext,
              conversationId,
              originalCodexRequest,
              "Server rejected stale previous_response_id on non-stream request"
            )
            throw error
          }
          // The session can be rebuilt by the next physical attempt, but this
          // dispatch may never resend its immutable request after a WebSocket
          // failure. The outer attempt owner decides whether that next attempt
          // is allowed and gives it a new identity.
          throw error
        }
      } finally {
        release()
      }
    } finally {
      if (conversationId && turnContext) {
        this.disposeTurnContext(conversationId, slot, modelName)
      }
    }
  }

  // ── Streaming ────────────────────────────────────────────────────────

  /**
   * Execute exactly one physical Codex stream dispatch. Account, transport,
   * and session selection happen once inside this method; any later retry is
   * represented by a typed outcome for the caller's attempt coordinator.
   */
  async *sendMessageStream(
    dispatch: ProviderPhysicalDispatch<CodexProviderExecutionRequest>,
    options: CodexStreamDispatchOptions
  ): AsyncGenerator<string, void, unknown> {
    assertProviderPhysicalDispatch({
      dispatch,
      backend: "codex",
      label: "Codex stream dispatch",
    })
    if (dispatch.request.model !== dispatch.attempt.model) {
      throw new Error(
        "Codex stream request model does not match its physical attempt model"
      )
    }
    const request = dispatch.request
    const forwardHeaders = options.forwardHeaders
    const resolvedAbortSignal = options.abortSignal

    const conversationId = this.getLocalProjectionKey(request)
    const releaseConversationLock =
      await this.acquireConversationStreamLock(conversationId)
    const attemptReceipt: CodexPhysicalAttemptReceipt = {}

    this.onLiveRequestStart()
    try {
      yield* this.executeStreamOnce(
        request,
        forwardHeaders,
        resolvedAbortSignal,
        dispatch.lifecycle,
        attemptReceipt
      )
    } finally {
      this.onLiveRequestEnd()
      releaseConversationLock()
    }
  }

  async prewarmExactNativeRequest(input: {
    request: Pick<
      CodexExecutionRequest,
      | "model"
      | "localProjectionKey"
      | "upstreamIdentity"
      | "clientMetadata"
      | "responseFormat"
    >
    /** Exact request emitted by the native Codex request assembler. */
    nativeRequest: Record<string, unknown>
    forwardHeaders?: CodexForwardHeaders
    reason?: string
  }): Promise<void> {
    const { request, nativeRequest } = input
    const warmupReason = input.reason?.trim() || "request"
    const turnKey = this.getCodexTurnKey(nativeRequest)
    if (!turnKey) {
      throw new Error(
        "Codex exact native warmup requires x-codex-turn-metadata"
      )
    }
    if (!this.useWebSocket || !this.wsService.isWebSocketAvailable()) {
      return
    }

    let slot: CodexAccountSlot
    let wsUrl: string
    let sessionId: string
    try {
      const modelName = request.model
      const conversationId = this.getLocalProjectionKey(request)
      slot = this.selectWarmupSlot(modelName, conversationId)
      if (this.isHttpFallbackTransport(conversationId, slot, modelName)) {
        this.logger.debug(
          `[Codex][Warmup] reason=${warmupReason} model=${modelName} skipped: Codex session is pinned to HTTP transport`
        )
        return
      }
      const httpUrl = this.buildUrl(slot, "responses")
      wsUrl = this.wsService.buildWebSocketUrl(httpUrl)
      sessionId = this.turnContexts.prepareWarmupContext({
        slotKey: this.getSlotStickyKey(slot),
        modelName: request.model,
        conversationId: conversationId || undefined,
        turnKey,
      }).sessionId
    } catch (error) {
      this.logger.debug(
        `[Codex][Warmup] reason=${warmupReason} model=${request.model} skipped before dispatch: ${error instanceof Error ? error.message : String(error)}`
      )
      return
    }

    const existingWarmup = this.sessionWarmupPromises.get(sessionId)
    if (existingWarmup) {
      return existingWarmup
    }

    const warmupPromise = this.runSessionWarmup(
      request,
      slot,
      wsUrl,
      sessionId,
      input.forwardHeaders,
      warmupReason,
      nativeRequest
    )
      .catch((error) => {
        // Warmup 401 时主动 refresh token，为后续实际请求做准备
        if (
          error instanceof CodexWebSocketUpgradeError &&
          (error.statusCode === 401 || error.statusCode === 403)
        ) {
          this.tryRefreshSlotToken(slot, "warmup-401").catch(() => {})
        }
        this.logger.debug(
          `[Codex][Warmup] reason=${warmupReason} session=${sessionId} model=${request.model} skipped: ${error instanceof Error ? error.message : String(error)}`
        )
      })
      .finally(() => {
        if (this.sessionWarmupPromises.get(sessionId) === warmupPromise) {
          this.sessionWarmupPromises.delete(sessionId)
        }
      })

    this.sessionWarmupPromises.set(sessionId, warmupPromise)
    return warmupPromise
  }

  private async runSessionWarmup(
    request: Pick<
      CodexExecutionRequest,
      | "model"
      | "localProjectionKey"
      | "upstreamIdentity"
      | "clientMetadata"
      | "responseFormat"
    >,
    slot: CodexAccountSlot,
    wsUrl: string,
    sessionId: string,
    forwardHeaders: CodexForwardHeaders | undefined,
    warmupReason: string,
    nativeRequest: Record<string, unknown>
  ): Promise<void> {
    const modelName = request.model
    const conversationId = this.getLocalProjectionKey(request)
    const token = await this.getBearerToken(slot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }

    this.bindConversationToSlot(conversationId, slot)

    const wsHeaders = this.wsService.buildBridgeNativeWebSocketHeaders(
      token,
      this.isApiKeyMode(slot),
      {
        localProjectionKey: conversationId,
        upstreamIdentity: this.getUpstreamIdentity(request),
        clientMetadata: this.requireCodexRequestClientMetadata(nativeRequest),
      },
      this.getSlotAccountId(slot),
      slot.workspaceId,
      forwardHeaders,
      false,
      this.usesResponsesLite(modelName, slot)
    )

    const { release } = await this.wsService.acquireSession(sessionId)
    const startedAt = Date.now()
    try {
      const session = this.wsService.getOrCreateSession(sessionId)
      const reusedConnection =
        !!session.conn &&
        session.wsUrl === wsUrl &&
        session.conn.readyState === 1
      const conversationHadContinuation =
        !!conversationId &&
        this.hasConversationContinuationState(conversationId, slot, modelName)

      const ws = await this.wsService.ensureSessionConnection(
        sessionId,
        wsUrl,
        wsHeaders,
        slot.proxyUrl || undefined
      )

      // Send generate:false warmup payload to prime the server-side prompt cache (mirrors Codex CLI).
      //
      // IMPORTANT: Only send warmup payload for initial-chat warmups (session startup).
      // The official Codex CLI only does prewarm_websocket() when last_request.is_none()
      // (i.e., before the first request in a session). For continuation warmups
      // (shell-continuation, tool-continuation), sending generate:false creates a new
      // response on the server that breaks the previous_response_id chain — the server
      // won't recognize the response_id from the actual request because it belongs to
      // a different chain than the warmup response.
      //
      const warmupPayloadDecision = shouldSendCodexWarmupPayload({
        warmupPayloadAvailable: true,
        reusedConnection,
        warmupReason,
        conversationHasContinuation: conversationHadContinuation,
      })
      if (warmupPayloadDecision.sendPayload) {
        let warmupBody = this.cacheService.injectSessionCacheKey(
          { ...nativeRequest },
          this.getUpstreamIdentity(request)
        )
        warmupBody = prepareCodexRequestForSend(warmupBody)
        const wsBody = this.wsService.buildWarmupRequestBody(warmupBody, {
          useResponsesLite: this.usesResponsesLite(modelName, slot),
          forwardHeaders,
          streamRequestStartMs: Date.now(),
        })

        this.logger.debug(
          `[Codex][Warmup] reason=${warmupReason} session=${sessionId} model=${modelName} sending generate:false payload`
        )

        try {
          await this.wsService.sendWarmupRequest(ws, wsBody)
          this.logger.debug(
            `[Codex][Warmup] reason=${warmupReason} session=${sessionId} model=${modelName} warmup payload completed duration=${Date.now() - startedAt}ms`
          )
        } catch (warmupError) {
          // warmup payload 失败不应阻塞后续实际请求，连接已建立就够了
          this.logger.warn(
            `[Codex][Warmup] reason=${warmupReason} session=${sessionId} warmup payload failed: ${warmupError instanceof Error ? warmupError.message : String(warmupError)}`
          )
        }
      } else {
        this.logger.debug(
          `[Codex][Warmup] reason=${warmupReason} session=${sessionId} model=${modelName} slot=${this.getAccountLabel(slot)} reused=${reusedConnection} connection-only duration=${Date.now() - startedAt}ms`
        )
      }
    } finally {
      release()
    }
  }

  /**
   * ProviderAdapter.dispose() — release all resources for a conversation.
   * Returns WS connection to cache (via disposeTurnContext) and clears warmup cache.
   * Called by SessionLifecycleService when a session expires or is deleted.
   */
  dispose(conversationId: string): void {
    this.turnContexts.deleteConversation(
      requireExactDurableIdentifier(
        conversationId,
        "Codex disposed conversationId"
      )
    )
  }

  private async *executeStreamOnce(
    request: CodexProviderExecutionRequest,
    forwardHeaders?: CodexForwardHeaders,
    abortSignal?: AbortSignal,
    lifecycle?: Pick<ProviderPhysicalDispatch<object>["lifecycle"], "state">,
    attemptReceipt: CodexPhysicalAttemptReceipt = {}
  ): AsyncGenerator<string, void, unknown> {
    // Cursor refreshes before building its native history candidate. Refreshing
    // here would change compaction compatibility after that check has passed.
    if (!request.projectionState) await this.refreshModelCatalogs(abortSignal)
    const modelName = request.model
    let slot: CodexAccountSlot
    try {
      slot = this.selectRequestSlot(
        request.model,
        this.getLocalProjectionKey(request),
        {
          preferWarmPool: !this.hasConversationContinuationState(
            this.getLocalProjectionKey(request)
          ),
        }
      )
    } catch (error) {
      throw await this.toRetryableCodexPhysicalFailure(error, modelName)
    }

    const token = await this.getBearerToken(slot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    this.bindConversationToSlot(this.getLocalProjectionKey(request), slot)

    const reverseToolMap = buildReverseMapFromClaudeTools(request.tools)
    let codexRequest = buildCodexRequest(
      {
        ...request,
        modelProfile: getCodexModelProfile(
          modelName,
          this.modelCatalogScope(slot)
        ),
      },
      modelName
    ) as Record<string, unknown>
    codexRequest = this.attachBridgeNativeClientMetadata(
      request,
      codexRequest
    ).codexRequest

    const conversationId = this.getLocalProjectionKey(request)

    const cacheId = this.getCacheId(request)
    codexRequest = this.cacheService.injectSessionCacheKey(
      codexRequest,
      this.getUpstreamIdentity(request)
    )

    // ── Turn-scoped context management ─────────────────────────────────
    // Each executeStreamOnce() call = one physical dispatch.
    // Create a fresh turn context at entry; dispose in finally.
    // This matches the official Codex CLI ModelClientSession lifecycle:
    //   client.new_session() → turn → Drop → store_cached_websocket_session
    const turnKey = this.getCodexTurnKey(codexRequest)
    const turnContext = this.resolveSharedTurnContext(
      request,
      conversationId,
      slot,
      modelName,
      turnKey
    )

    const capturePreparedWireInput = this.preparedWireInputCaptures.get(request)

    try {
      // Try WebSocket transport first when enabled for this Codex session.
      if (
        this.useWebSocket &&
        this.wsService.isWebSocketAvailable() &&
        !this.isHttpFallbackTransport(conversationId, slot, modelName)
      ) {
        try {
          for await (const event of this.streamViaWebSocket(
            slot,
            token,
            codexRequest,
            modelName,
            reverseToolMap,
            cacheId,
            request,
            forwardHeaders,
            abortSignal,
            capturePreparedWireInput,
            attemptReceipt
          )) {
            yield event
          }
          markAccountSuccess(slot, modelName)
          return
        } catch (error) {
          const abortedError = toUpstreamRequestAbortedError(
            error,
            abortSignal,
            "Codex WebSocket stream aborted"
          )
          if (abortedError) {
            throw abortedError
          }
          const failureAction = resolveCodexWebSocketFailure(error, {
            isApiKeyMode: this.isApiKeyMode(slot),
          })
          switch (failureAction.kind) {
            case "retry_http_without_account":
              this.recordHttpFallbackTransport(
                conversationId,
                slot,
                modelName,
                "WebSocket rejected the account header",
                true
              )
              throw new ProviderAttemptRetryableError(
                "Codex WebSocket rejected the account header; retry on a new HTTP attempt",
                {
                  backend: "codex",
                  errorClass: "auth_failed",
                  statusCode: failureAction.statusCode,
                  maxRetries: 1,
                  nextTransport: "http",
                }
              )
            case "fallback_http":
              this.recordHttpFallbackTransport(
                conversationId,
                slot,
                modelName,
                "WebSocket transport became unavailable"
              )
              throw new ProviderAttemptRetryableError(
                "Codex WebSocket transport failed; retry on a new HTTP attempt",
                {
                  backend: "codex",
                  errorClass: "transient_network",
                  maxRetries: RETRY_POLICY.transient_network.maxRetries,
                  nextTransport: "http",
                }
              )
            case "throw_codex_api_error":
              throw createCodexApiErrorFromBody(
                failureAction.statusCode,
                failureAction.body
              )
            case "throw_original":
              throw error
          }
        }
      }

      this.stageAcceptedHttpTransportTurn(
        attemptReceipt,
        conversationId,
        slot,
        modelName,
        this.isHttpFallbackTransport(conversationId, slot, modelName)
          ? "Codex session pinned to HTTP transport"
          : "WebSocket transport disabled or unavailable",
        this.resolveContinuationPolicy(request)
      )
      for await (const event of this.streamViaHttp(
        slot,
        token,
        codexRequest,
        modelName,
        reverseToolMap,
        cacheId,
        request,
        this.shouldOmitAccountIdForHttpTransport(
          conversationId,
          slot,
          modelName
        ),
        forwardHeaders,
        abortSignal,
        turnContext,
        capturePreparedWireInput
      )) {
        yield event
      }
      markAccountSuccess(slot, modelName)
    } catch (e) {
      if (
        request.responseFormat === "native" &&
        e instanceof CodexApiError &&
        e.providerDetails?.event
      ) {
        if (e.getStatus() === 429)
          markAccountCooldown(
            slot,
            429,
            modelName,
            e.retryAfterSeconds?.toString(),
            this.getAccountLabel(slot)
          )
        const event = e.providerDetails.event as Record<string, unknown>
        yield `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
        return
      }
      if (lifecycle?.state === "accepted") throw e
      const abortedError = toUpstreamRequestAbortedError(
        e,
        abortSignal,
        "Codex stream aborted"
      )
      if (abortedError) {
        throw abortedError
      }

      // A stale response id is a local continuation eligibility failure, not
      // an upstream/account failure. The server has authoritatively rejected
      // that chain, so surface the request and let the next turn start from
      // the full installed projection.
      if (isCodexStaleResponseIdError(e)) {
        throw e
      }

      if (isProviderAttemptRetryableError(e)) {
        throw e
      }
      throw await this.toRetryableCodexPhysicalFailure(e, modelName, slot)
    } finally {
      if (lifecycle?.state === "accepted") {
        this.commitPendingContinuationAttempt(attemptReceipt.continuation)
        this.commitAcceptedHttpTransportTurn(attemptReceipt.httpTransport)
      }
      // ── Turn end: return WS connection to cache ──────────────────────
      // Mirrors Drop for ModelClientSession → store_cached_websocket_session.
      // The connection is returned to cachedWsSessions for reuse by the next turn.
      if (conversationId && turnContext) {
        this.disposeTurnContext(conversationId, slot, modelName)
      }
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
    request: Pick<
      CodexExecutionRequest,
      | "model"
      | "localProjectionKey"
      | "upstreamIdentity"
      | "clientMetadata"
      | "responseFormat"
    >,
    omitAccountId: boolean = false,
    forwardHeaders?: CodexForwardHeaders,
    abortSignal?: AbortSignal,
    turnContext?: CodexTurnContext,
    capturePreparedWireInput?: (input: readonly CodexInputItem[]) => void
  ): AsyncGenerator<string, void, unknown> {
    const requestStartedAt = Date.now()
    const conversationId = this.getLocalProjectionKey(request)
    const preparedCodexRequest = prepareCodexRequestForSend(codexRequest)
    this.capturePreparedWireInput(
      capturePreparedWireInput,
      preparedCodexRequest
    )
    const requestBody = JSON.stringify(preparedCodexRequest)
    const url = this.buildUrl(slot, "responses")
    const headers = this.buildHeaders(slot, token, true, {
      localProjectionKey: conversationId,
      upstreamIdentity: this.getUpstreamIdentity(request),
      omitAccountId,
      forwardHeaders,
      clientMetadata: this.requireCodexRequestClientMetadata(codexRequest),
      useResponsesLite: this.usesResponsesLite(modelName, slot),
    })
    this.applyCodexTurnStateHeader(headers, turnContext)

    this.logger.log(
      buildCodexDispatchLogLine({
        slotLabel: this.getAccountLabel(slot),
        modelName,
        transport: "http-stream",
        omitAccountId,
        accountId: this.getSlotAccountId(slot),
        workspaceId: slot.workspaceId,
        headers,
      })
    )
    this.logger.log(
      buildCodexHttpRequestLogLine({
        kind: "stream",
        modelName,
        url,
        codexRequest: preparedCodexRequest,
      })
    )
    this.logger.debug(
      `[Codex][HTTP Request][Payload] ${summarizeCodexRequestForLogs(preparedCodexRequest)}`
    )

    const requestSignal = createAbortSignalWithTimeout(600_000, abortSignal)
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: requestBody,
      signal: requestSignal.signal,
    }

    const dispatcher = this.buildProxyDispatcher(slot)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    const state = createStreamState()
    let firstUpstreamMs: number | undefined
    let firstContentMs: number | undefined
    let firstContentType: string | undefined

    try {
      const response = await fetch(url, fetchOptions)

      if (!response.ok) {
        const errorBody = await response.text()
        this.logger.error(
          `[Codex] Stream request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
        )

        const failureAction = resolveCodexHttpErrorResponse(
          response.status,
          errorBody,
          {
            omitAccountId,
            isApiKeyMode: this.isApiKeyMode(slot),
          }
        )

        switch (failureAction.kind) {
          case "retry_http_without_account":
            this.recordHttpFallbackTransport(
              conversationId,
              slot,
              modelName,
              "HTTP rejected the account header",
              true
            )
            throw new ProviderAttemptRetryableError(
              "Codex HTTP rejected the account header; retry on a new physical attempt",
              {
                backend: "codex",
                errorClass: "auth_failed",
                statusCode: response.status,
                maxRetries: 1,
                nextTransport: "http",
              }
            )
          case "throw_codex_api_error":
            throw createCodexApiErrorFromBody(
              failureAction.statusCode,
              failureAction.body,
              { retryAfterHeader: response.headers.get("retry-after") }
            )
        }
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
      this.modelCatalogCache.invalidate(
        this.modelCatalogScope(slot),
        response.headers.get("x-models-etag")
      )
      this.captureCodexTurnStateFromHttpHeaders(turnContext, response.headers)

      for await (const payload of readCodexResponseEvents(
        response.body,
        requestSignal.signal
      )) {
        this.captureCodexTurnStateFromSsePayload(turnContext, payload)
        if (firstUpstreamMs === undefined)
          firstUpstreamMs = Date.now() - requestStartedAt
        if (
          firstContentMs === undefined &&
          [
            "response.output_text.delta",
            "response.reasoning_summary_text.delta",
            "response.function_call_arguments.delta",
          ].includes(String(payload.type))
        ) {
          firstContentMs = Date.now() - requestStartedAt
          firstContentType = String(payload.type)
        }
        this.logCodexUsage(
          "http",
          modelName,
          cacheId,
          slot,
          payload,
          requestStartedAt
        )
        if (request.responseFormat === "native") {
          yield `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`
          continue
        }
        if (
          payload.type === "response.output_item.done" &&
          payload.item &&
          typeof payload.item === "object"
        ) {
          yield `event: codex_response_item\ndata: ${JSON.stringify({ type: "codex_response_item", item: payload.item })}\n\n`
        }
        const completedEvent = this.formatCodexResponseCompletedEvent(payload)
        if (completedEvent) yield completedEvent
        const terminalEvent = this.formatCodexResponseTerminalEvent(payload)
        if (terminalEvent) yield terminalEvent
        yield* translateCodexSseEvent(
          `data: ${JSON.stringify(payload)}`,
          state,
          reverseToolMap
        )
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
    const totalMs = Date.now() - requestStartedAt
    this.logger.log(
      `[Codex][TurnTiming] conv=${conversationId || "none"} ` +
        `transport=http model=${modelName} ` +
        `firstFrameMs=${firstUpstreamMs ?? -1} ` +
        `firstContentMs=${firstContentMs ?? -1} ` +
        `firstContentType=${firstContentType || "none"} ` +
        `totalMs=${totalMs} completed=true ` +
        `blocks=${state.blockIndex} hasToolCall=${state.hasToolCall} ` +
        `slot=${this.getAccountLabel(slot)}`
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
    request: Pick<
      CodexExecutionRequest,
      | "model"
      | "localProjectionKey"
      | "upstreamIdentity"
      | "clientMetadata"
      | "continuationPolicy"
      | "responseFormat"
    >,
    forwardHeaders?: CodexForwardHeaders,
    abortSignal?: AbortSignal,
    capturePreparedWireInput?: (input: readonly CodexInputItem[]) => void,
    attemptReceipt: CodexPhysicalAttemptReceipt = {}
  ): AsyncGenerator<string, void, unknown> {
    const requestStartedAt = Date.now()
    const httpUrl = this.buildUrl(slot, "responses")
    const wsUrl = this.wsService.buildWebSocketUrl(httpUrl)
    const conversationId = this.getLocalProjectionKey(request)
    const turnKey = this.getCodexTurnKey(codexRequest)
    // Durable turns obtain the conversation ModelClientSession. Isolated
    // control requests use a standalone socket and never enter shared state.
    const turnContext = this.resolveSharedTurnContext(
      request,
      conversationId,
      slot,
      modelName,
      turnKey
    )
    const wsHeaders = this.wsService.buildBridgeNativeWebSocketHeaders(
      token,
      this.isApiKeyMode(slot),
      {
        localProjectionKey: conversationId,
        upstreamIdentity: this.getUpstreamIdentity(request),
        clientMetadata: this.requireCodexRequestClientMetadata(codexRequest),
      },
      this.getSlotAccountId(slot),
      slot.workspaceId,
      forwardHeaders,
      false,
      this.usesResponsesLite(modelName, slot)
    )
    this.applyCodexTurnStateHeader(wsHeaders, turnContext)
    const sessionId = turnContext?.wsSessionId || ""
    if (!sessionId) {
      const ws = await this.wsService.connect(
        wsUrl,
        wsHeaders,
        slot.proxyUrl || undefined
      )
      this.modelCatalogCache.invalidate(
        this.modelCatalogScope(slot),
        this.wsService.getConnectionMetadata(ws)?.modelsEtag
      )
      this.captureCodexTurnStateFromConnection(turnContext, ws)
      const prepared =
        turnContext && conversationId
          ? this.planRequestWithTurnContext(
              codexRequest,
              turnContext,
              conversationId,
              this.resolveContinuationPolicy(request)
            )
          : { request: codexRequest }
      attemptReceipt.continuation = prepared.continuation
      yield* this.streamViaWebSocketConnection(
        ws,
        slot,
        modelName,
        reverseToolMap,
        cacheId,
        prepared.request,
        requestStartedAt,
        "",
        abortSignal,
        conversationId,
        forwardHeaders,
        turnContext,
        capturePreparedWireInput,
        prepared.continuation,
        request.responseFormat
      )
      return
    }

    const { release } = await this.wsService.acquireSession(sessionId)
    try {
      // Check if the previous connection is still alive BEFORE ensureSessionConnection
      const sessionState = this.wsService.getOrCreateSession(sessionId)
      const hadOpenConnection =
        !!sessionState.conn &&
        sessionState.wsUrl === wsUrl &&
        sessionState.conn.readyState === 1 // WebSocket.OPEN

      const ws = await this.wsService.ensureSessionConnection(
        sessionId,
        wsUrl,
        wsHeaders,
        slot.proxyUrl || undefined
      )
      this.modelCatalogCache.invalidate(
        this.modelCatalogScope(slot),
        this.wsService.getConnectionMetadata(ws)?.modelsEtag
      )
      this.captureCodexTurnStateFromConnection(turnContext, ws)

      const originalCodexRequest = codexRequest
      const continuationPolicy = this.resolveWebSocketContinuationPolicy(
        request,
        !hadOpenConnection
      )
      if (!hadOpenConnection && continuationPolicy === "full") {
        this.logger.debug(
          `[Codex][TurnContext] WebSocket connection rebuilt for ${conversationId}; ` +
            "staged a full-input continuation candidate"
        )
      }
      const prepared =
        turnContext && conversationId
          ? this.planRequestWithTurnContext(
              codexRequest,
              turnContext,
              conversationId,
              continuationPolicy
            )
          : { request: codexRequest }
      codexRequest = prepared.request
      attemptReceipt.continuation = prepared.continuation

      try {
        this.logger.log(
          buildCodexDispatchLogLine({
            slotLabel: this.getAccountLabel(slot),
            modelName,
            transport: "websocket-stream",
            omitAccountId: false,
            accountId: this.getSlotAccountId(slot),
            workspaceId: slot.workspaceId,
            headers: wsHeaders,
          })
        )
        this.logger.log(
          `[Codex] WebSocket stream request: model=${modelName}, url=${wsUrl}`
        )
        this.logger.debug(
          `[Codex][WS Request][Payload] ${summarizeCodexRequestForLogs(
            this.wsService.buildWebSocketRequestBody(
              prepareCodexRequestForSend(codexRequest),
              {
                useResponsesLite: this.usesResponsesLite(modelName, slot),
                forwardHeaders,
                turnState: turnContext?.turnState,
              }
            )
          )}`
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
          abortSignal,
          conversationId,
          forwardHeaders,
          turnContext,
          capturePreparedWireInput,
          prepared.continuation,
          request.responseFormat
        )
        return
      } catch (error) {
        if (
          typeof codexRequest.previous_response_id === "string" &&
          isCodexStaleResponseIdError(error)
        ) {
          this.logger.warn(
            `[Codex] Previous response_id rejected by server for ${conversationId}, ` +
              `clearing the continuation baseline for a later full request`
          )
          this.beginFullCodexResponseChain(
            turnContext,
            conversationId,
            originalCodexRequest,
            "Server rejected stale previous_response_id"
          )
          throw error
        }

        // The caller-owned physical-attempt coordinator decides whether a
        // later attempt is permitted. This transport never resends here.
        throw error
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
    abortSignal?: AbortSignal,
    conversationId?: string,
    forwardHeaders?: CodexForwardHeaders,
    turnContext?: CodexTurnContext,
    capturePreparedWireInput?: (input: readonly CodexInputItem[]) => void,
    pendingContinuationAttempt?: CodexPendingContinuationAttempt,
    responseFormat?: "native"
  ): AsyncGenerator<string, void, unknown> {
    const state = createStreamState()
    const itemsAdded: CodexInputItem[] = []
    let firstUpstreamMs: number | undefined
    let firstContentMs: number | undefined
    let firstContentType: string | undefined
    let responseCompleted = false
    let abortListenerAttached = false
    const onAbort = () => {
      if (responseCompleted) {
        this.logger.debug(
          `[Codex][WS] Ignored abort after response.completed for session=${sessionId || "standalone"} conversation=${conversationId || "none"}`
        )
        return
      }

      if (sessionId) {
        this.wsService.invalidateSessionConnection(
          sessionId,
          ws,
          "abort_signal"
        )
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

      if (abortSignal) {
        abortSignal.addEventListener("abort", onAbort, { once: true })
        abortListenerAttached = true
      }
      const preparedCodexRequest = prepareCodexRequestForSend(codexRequest)
      this.capturePreparedWireInput(
        capturePreparedWireInput,
        preparedCodexRequest
      )
      const wsBody = this.wsService.buildWebSocketRequestBody(
        preparedCodexRequest,
        {
          useResponsesLite: this.usesResponsesLite(modelName, slot),
          forwardHeaders,
          streamRequestStartMs: Date.now(),
          turnState: turnContext?.turnState,
        }
      )

      for await (const msg of this.wsService.streamViaWebSocket(ws, wsBody)) {
        this.captureCodexTurnStateFromSsePayload(
          turnContext,
          msg as Record<string, unknown>
        )

        if (msg.type === "response.output_item.done") {
          const item = (msg as Record<string, unknown>).item as
            | Record<string, unknown>
            | undefined
          appendCodexResponseOutputItemToLedger(itemsAdded, item)
          if (responseFormat !== "native" && item && typeof item === "object") {
            yield `event: codex_response_item\ndata: ${JSON.stringify({
              type: "codex_response_item",
              item,
            })}\n\n`
          }
        }

        if (msg.type === "response.completed") {
          responseCompleted = true
          if (abortSignal && abortListenerAttached) {
            abortSignal.removeEventListener("abort", onAbort)
            abortListenerAttached = false
          }
          // Mirrors map_response_stream() ResponseEvent::Completed → LastResponse.
          if (conversationId && sessionId) {
            const capturedId = getCodexCompletedResponseId(
              msg as Record<string, unknown>
            )
            if (capturedId) {
              this.captureResponseInTurnContext(
                conversationId,
                capturedId,
                itemsAdded,
                pendingContinuationAttempt
              )
            }
          }
        }
        if (responseFormat === "native") {
          this.logCodexUsage(
            "websocket",
            modelName,
            cacheId,
            slot,
            msg as Record<string, unknown>,
            requestStartedAt
          )
          yield `event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`
          continue
        }
        const completedEvent = this.formatCodexResponseCompletedEvent(
          msg as Record<string, unknown>
        )
        if (completedEvent) {
          yield completedEvent
        }
        const terminalEvent = this.formatCodexResponseTerminalEvent(
          msg as Record<string, unknown>
        )
        if (terminalEvent) {
          yield terminalEvent
        }
        if (firstUpstreamMs === undefined && msg.type) {
          firstUpstreamMs = Date.now() - requestStartedAt
          this.logger.debug(
            `[Codex] First upstream WebSocket event after ${firstUpstreamMs}ms: type=${msg.type}`
          )
        }
        if (
          firstContentMs === undefined &&
          (msg.type === "response.output_text.delta" ||
            msg.type === "response.reasoning_summary_text.delta" ||
            msg.type === "response.function_call_arguments.delta")
        ) {
          firstContentMs = Date.now() - requestStartedAt
          firstContentType = msg.type
          this.logger.debug(
            `[Codex] First content WebSocket event after ${firstContentMs}ms: type=${msg.type}`
          )
        }
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
      if (abortSignal && abortListenerAttached) {
        abortSignal.removeEventListener("abort", onAbort)
        abortListenerAttached = false
      }
      if (sessionId) {
        if (!responseCompleted) {
          this.wsService.invalidateSessionConnection(
            sessionId,
            ws,
            "stream_finally_incomplete"
          )
        }
      } else {
        ws.close()
      }
    }

    const totalMs = Date.now() - requestStartedAt
    // 结构化 turn timing：grep '[Codex][TurnTiming]' 即可拉出每个 turn 的耗时分布
    this.logger.log(
      `[Codex][TurnTiming] conv=${conversationId || "none"} ` +
        `transport=ws model=${modelName} ` +
        `firstFrameMs=${firstUpstreamMs ?? -1} ` +
        `firstContentMs=${firstContentMs ?? -1} ` +
        `firstContentType=${firstContentType || "none"} ` +
        `totalMs=${totalMs} ` +
        `completed=${responseCompleted} ` +
        `blocks=${state.blockIndex} hasToolCall=${state.hasToolCall} ` +
        `slot=${this.getAccountLabel(slot)}`
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
      const { primary, secondary } = parseCodexRateLimitHeaders(headers)

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
      const weekly = getCodexWeeklyRateLimitWindow(snapshot)
      const quotaSummary = weekly
        ? formatCodexRateLimitWindow("weekly", weekly)
        : "weekly=unavailable"
      const sourceLabel = source === "request" ? "live" : "healthcheck"
      const message = `[Codex][RateLimit] ${label}: model=${normalizedModel}, source=${sourceLabel}, ${quotaSummary}`
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
      if (!force && this.activeLiveRequests > 0) {
        this.logger.log(
          "[Codex] Rate limit probe paused while live requests are active"
        )
        break
      }

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
        const dispatcher = this.buildProxyDispatcher(slot)

        const doProbe = async (
          bearerToken: string,
          probeModel: string
        ): Promise<Response> => {
          const abortController = new AbortController()
          this.activeRateLimitProbeAbortController = abortController
          const timeout = setTimeout(() => abortController.abort(), 15_000)
          try {
            const url = this.buildUrl(slot, "responses")
            // Rate probes are not bridge-native turns and use the dedicated
            // no-session header shape; execution requests cannot select it.
            const headers = buildCodexNonTurnHttpHeaders({
              token: bearerToken,
              isApiKey: this.isApiKeyMode(slot),
              accept: "text/event-stream",
              accountId: this.getSlotAccountId(slot),
              workspaceId: slot.workspaceId,
              identity: {
                version: this.identity.version(),
                userAgent: this.identity.userAgent(),
                originator: this.identity.originator(),
              },
            })
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
            if (dispatcher) {
              fetchOptions.dispatcher = dispatcher
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
            return resp
          } finally {
            clearTimeout(timeout)
            if (this.activeRateLimitProbeAbortController === abortController) {
              this.activeRateLimitProbeAbortController = null
            }
          }
        }

        for (const probeModel of probeModels) {
          const response = await doProbe(token, probeModel)

          // 401/403: 复用 tryRefreshSlotToken 统一 refresh 逻辑（含旋转竞态保护）
          if (response.status === 401 || response.status === 403) {
            const refreshedToken = await this.tryRefreshSlotToken(
              slot,
              `Probe ${label} HTTP ${response.status}`
            )
            if (refreshedToken) {
              token = refreshedToken
              await doProbe(token, probeModel)
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
        if (
          !force &&
          this.activeLiveRequests > 0 &&
          err instanceof Error &&
          err.name === "AbortError"
        ) {
          this.logger.log(
            "[Codex] Rate limit probe aborted to prioritize a live request"
          )
          break
        }
        this.logger.warn(
          `[Codex] Rate limit probe failed for ${label}: ${(err as Error).message}`
        )
      }
    }

    this.logger.log(`[Codex] Rate limit probe completed: ${probed} account(s)`)
    return probed
  }
}
