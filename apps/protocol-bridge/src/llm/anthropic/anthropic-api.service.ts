import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as crypto from "crypto"
import * as fs from "fs"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"
import type { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"
import type { AnthropicResponse } from "../../shared/anthropic"
import { UsageStatsService } from "../../usage"
import { applyPromptCachingOptimizations } from "./prompt-caching"
import { getAccountConfigPathCandidates } from "../../shared/protocol-bridge-paths"
import { PersistenceService } from "../../persistence"
import {
  type CursorDisplayModel,
  detectModelFamily,
  doesModelIdRequireExplicitThinkingSupport,
} from "../shared/model-registry"
import {
  type CooldownableAccount,
  clearAccountDisablement,
  disableAccount,
  isAccountAvailableForModel,
  isAccountDisabled,
  markAccountCooldown,
  markAccountSuccess,
} from "../shared/account-cooldown"
import {
  BackendAccountStateStore,
  type PersistedBackendAccountState,
} from "../shared/backend-account-state-store"
import {
  BackendAccountPoolUnavailableError,
  BackendApiError,
} from "../shared/backend-errors"
import {
  BackendPoolEntryState,
  BackendPoolStatus,
} from "../shared/backend-pool-status"
import {
  createAbortPromise,
  createAbortSignalWithTimeout,
  toUpstreamRequestAbortedError,
} from "../shared/abort-signal"

export interface AnthropicForwardHeaders {
  [key: string]: string | undefined
}

function stringifyUnknownForLog(value: unknown): string {
  if (value == null) {
    return ""
  }
  if (typeof value === "string") {
    return value
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return `${value}`
  }
  if (typeof value === "symbol") {
    return value.description || value.toString()
  }

  try {
    const serialized = JSON.stringify(value)
    if (typeof serialized === "string") {
      return serialized
    }
  } catch {
    // ignore JSON serialization failures for logging
  }

  return Object.prototype.toString.call(value)
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    const details: string[] = [error.message]
    const cause = (error as Error & { cause?: unknown }).cause
    if (cause) {
      if (cause instanceof Error) {
        details.push(`cause=${cause.message}`)
        const nestedCode = (cause as Error & { code?: unknown }).code
        if (nestedCode != null) {
          details.push(`causeCode=${stringifyUnknownForLog(nestedCode)}`)
        }
      } else {
        details.push(`cause=${stringifyUnknownForLog(cause)}`)
      }
    }
    const code = (error as Error & { code?: unknown }).code
    if (code != null) {
      details.push(`code=${stringifyUnknownForLog(code)}`)
    }
    const errno = (error as Error & { errno?: unknown }).errno
    if (errno != null) {
      details.push(`errno=${stringifyUnknownForLog(errno)}`)
    }
    return details.join(", ")
  }

  return stringifyUnknownForLog(error)
}

interface ClaudeApiModelMapping {
  name: string
  alias?: string
}

interface ClaudeApiDiscoveredModel {
  name: string
  displayName?: string
  createdAt?: number
  isThinking: boolean
}

export interface ClaudeApiPublicModel {
  id: string
  displayName?: string
  createdAt?: number
  isThinking: boolean
}

interface ClaudeApiAccount extends CooldownableAccount {
  label?: string
  apiKey: string
  baseUrl: string
  proxyUrl?: string
  maxContextTokens?: number
  stripThinking: boolean
  prefix?: string
  headers?: Record<string, string>
  models: ClaudeApiModelMapping[]
  excludedModels: string[]
  priority: number
  source: "env" | "file"
  stateKey: string
  discoveredModels: ClaudeApiDiscoveredModel[]
  discoveredModelsFetchedAt?: number
  discoveryPromise?: Promise<void>
}

interface ClaudeApiCandidate {
  account: ClaudeApiAccount
  upstreamModel: string
  publicModelId: string
}

type PersistedClaudeApiAccountState = PersistedBackendAccountState

interface ClaudeApiAccountFileEntry {
  label?: string
  apiKey?: string
  baseUrl?: string
  proxyUrl?: string
  maxContextTokens?: number
  stripThinking?: boolean
  prefix?: string
  priority?: number
  headers?: Record<string, string>
  models?: Array<{ name?: string; alias?: string }>
  excludedModels?: string[]
}

interface ClaudeApiConfigFile {
  forceModelPrefix?: boolean
  accounts?: ClaudeApiAccountFileEntry[]
}

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com"
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01"
export const DEFAULT_CLAUDE_API_CONTEXT_LIMIT_TOKENS = 200_000

const DEFAULT_PUBLIC_CLAUDE_MODEL_IDS = [
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-thinking",
  "claude-opus-4-6-thinking",
  "claude-opus-4-5-thinking",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-haiku-20241022",
] as const

const DEFAULT_FORWARDED_HEADERS: Record<string, string> = {
  "anthropic-version": DEFAULT_ANTHROPIC_VERSION,
  "anthropic-dangerous-direct-browser-access": "true",
  "x-app": "cli",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-lang": "js",
  "x-stainless-timeout": "600",
  "user-agent": "claude-cli/2.1.70 (external, cli)",
}

/**
 * Required beta features that must always be present in Anthropic-Beta header.
 * Updated to match Claude Code 2.1.70 / CLIProxyAPI latest.
 */
const REQUIRED_BETA_FEATURES = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
] as const

const MODEL_DISCOVERY_TIMEOUT_MS = 8_000
const MODEL_DISCOVERY_MAX_PAGES = 5
const MODEL_DISCOVERY_TTL_MS = 15 * 60_000

@Injectable()
export class AnthropicApiService implements OnModuleInit {
  private readonly logger = new Logger(AnthropicApiService.name)

  private accounts: ClaudeApiAccount[] = []
  private accountIndex = 0
  private forceModelPrefix = false
  private accountsConfigPath: string | null = null
  private accountStateStore: BackendAccountStateStore

  private normalizeMaxContextTokens(value: unknown): number | undefined {
    const parsed =
      typeof value === "string" ? Number.parseInt(value.trim(), 10) : value
    if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
      return undefined
    }

    return Math.floor(parsed)
  }

  constructor(
    private readonly configService: ConfigService,
    private readonly persistence: PersistenceService,
    private readonly usageStats: UsageStatsService
  ) {
    this.accountStateStore = new BackendAccountStateStore(
      this.persistence,
      this.logger
    )
  }

  async onModuleInit(): Promise<void> {
    const fileAccounts = this.loadAllAccountsFromFile()
    if (fileAccounts.length > 0) {
      this.accounts = fileAccounts
    }

    const envApiKey = this.configService
      .get<string>("CLAUDE_API_KEY", "")
      .trim()
    const envBaseUrl = this.normalizeBaseUrl(
      this.configService.get<string>("CLAUDE_BASE_URL", "").trim()
    )
    const envProxyUrl = this.configService
      .get<string>("CLAUDE_PROXY_URL", "")
      .trim()
    const envMaxContextTokens = this.normalizeMaxContextTokens(
      this.configService.get<number>("CLAUDE_MAX_CONTEXT_TOKENS")
    )
    const envForceModelPrefix = this.configService
      .get<string>("CLAUDE_FORCE_MODEL_PREFIX", "")
      .trim()

    if (envForceModelPrefix) {
      this.forceModelPrefix = ["true", "1"].includes(
        envForceModelPrefix.toLowerCase()
      )
    }

    if (envApiKey) {
      const alreadyExists = this.accounts.some(
        (account) =>
          account.apiKey === envApiKey && account.baseUrl === envBaseUrl
      )
      if (!alreadyExists) {
        this.accounts.unshift(
          this.buildAccountRecord({
            label: "env",
            apiKey: envApiKey,
            baseUrl: envBaseUrl,
            proxyUrl: envProxyUrl || undefined,
            maxContextTokens: envMaxContextTokens,
            source: "env",
          })
        )
      }
    }

    this.configureAccountStateStore(this.accountsConfigPath)
    const persistedStates = this.loadPersistedAccountStates()
    for (const account of this.accounts) {
      this.applyPersistedAccountState(
        account,
        persistedStates.get(account.stateKey)
      )
    }
    this.persistAccountStates()
    await Promise.allSettled(
      this.accounts.map((account) =>
        this.refreshDiscoveredModelsForAccount(account, { force: true })
      )
    )

    this.logger.log(
      `Claude API backend initialized: ${this.accounts.length} account(s), forceModelPrefix=${this.forceModelPrefix}`
    )
    for (const account of this.accounts) {
      const stateSummary = isAccountDisabled(account)
        ? `disabled (${account.disabledReason || "permanent"})`
        : account.cooldownUntil > 0 || account.modelStates.size > 0
          ? "cooldown"
          : "ready"
      this.logger.log(
        `  -> ${account.label || "unnamed"} [${account.source}]: ${account.baseUrl} (key: ${account.apiKey.slice(0, 8)}..., priority=${account.priority}, state=${stateSummary})`
      )
    }
    if (this.accounts.length === 0) {
      this.logger.log(
        "No Claude API credentials configured. Add entries to data/claude-api-accounts.json to enable."
      )
    }
  }

  isAvailable(): boolean {
    return this.accounts.some((account) => !isAccountDisabled(account))
  }

  /**
   * Hot-reload accounts from config file — full reconcile.
   *
   * Performs a three-way reconciliation (add / update / delete):
   * - ADD: New accounts not yet in the pool are appended and trigger model discovery.
   * - UPDATE: Existing accounts whose mutable config changed (label, baseUrl,
   *   proxyUrl, stripThinking, priority, headers, models, excludedModels) are
   *   patched in-place.  Runtime state (cooldown, disabled, modelStates) is preserved.
   * - DELETE: File-sourced accounts that no longer appear in the config are removed.
   *   Env-sourced accounts are never deleted.
   *
   * Returns the total number of account changes (add/update/remove).
   */
  async reloadAccounts(): Promise<number> {
    const freshAccounts = this.loadAllAccountsFromFile()
    const freshKeys = new Set(freshAccounts.map((a) => a.stateKey))
    const existingByKey = new Map(this.accounts.map((a) => [a.stateKey, a]))
    const persistedStates = this.loadPersistedAccountStates()

    let added = 0
    let updated = 0
    let removed = 0
    const newAccounts: ClaudeApiAccount[] = []

    // ── ADD + UPDATE ──
    for (const fresh of freshAccounts) {
      const existing = existingByKey.get(fresh.stateKey)

      if (!existing) {
        // New account — add
        this.applyPersistedAccountState(
          fresh,
          persistedStates.get(fresh.stateKey)
        )
        this.accounts.push(fresh)
        newAccounts.push(fresh)
        added++
        this.logger.log(
          `[Hot-reload] Added Claude API account: ${fresh.label || fresh.baseUrl}`
        )
      } else {
        // Existing account — patch mutable fields, preserve runtime state
        let changed = false

        if (existing.label !== fresh.label) {
          existing.label = fresh.label
          changed = true
        }
        if (existing.baseUrl !== fresh.baseUrl) {
          existing.baseUrl = fresh.baseUrl
          changed = true
        }
        if (existing.proxyUrl !== fresh.proxyUrl) {
          existing.proxyUrl = fresh.proxyUrl
          changed = true
        }
        if (existing.maxContextTokens !== fresh.maxContextTokens) {
          existing.maxContextTokens = fresh.maxContextTokens
          changed = true
        }
        if (existing.stripThinking !== fresh.stripThinking) {
          existing.stripThinking = fresh.stripThinking
          changed = true
        }
        if (existing.priority !== fresh.priority) {
          existing.priority = fresh.priority
          changed = true
        }
        if (
          JSON.stringify(existing.headers) !== JSON.stringify(fresh.headers)
        ) {
          existing.headers = fresh.headers
          changed = true
        }
        if (JSON.stringify(existing.models) !== JSON.stringify(fresh.models)) {
          existing.models = fresh.models
          changed = true
        }
        if (
          JSON.stringify(existing.excludedModels) !==
          JSON.stringify(fresh.excludedModels)
        ) {
          existing.excludedModels = fresh.excludedModels
          changed = true
        }

        if (changed) {
          updated++
          this.logger.log(
            `[Hot-reload] Updated Claude API account: ${existing.label || existing.baseUrl}`
          )
        }
      }
    }

    // ── DELETE — only remove file-sourced accounts that are no longer in config ──
    const beforeCount = this.accounts.length
    this.accounts = this.accounts.filter((account) => {
      // Never remove env-sourced accounts
      if (account.source === "env") return true
      // Keep accounts that still exist in the fresh config
      if (freshKeys.has(account.stateKey)) return true
      // Remove stale file-sourced accounts
      removed++
      this.logger.log(
        `[Hot-reload] Removed Claude API account: ${account.label || account.baseUrl}`
      )
      return false
    })

    // ── persist + log ──
    const totalChanges = added + updated + removed
    if (totalChanges > 0) {
      this.persistAccountStates()
      this.logger.log(
        `[Hot-reload] Claude API reconcile: +${added} ~${updated} -${removed}, ` +
          `total=${this.accounts.length} (was ${beforeCount})`
      )
    }

    // Trigger model discovery for newly added accounts
    if (newAccounts.length > 0) {
      await Promise.allSettled(
        newAccounts.map((account) =>
          this.refreshDiscoveredModelsForAccount(account, { force: true })
        )
      )
    }

    // Trigger model re-discovery for updated accounts whose model config changed
    if (updated > 0) {
      await Promise.allSettled(
        this.accounts
          .filter((a) => this.shouldDiscoverModelsForAccount(a))
          .map((a) =>
            this.refreshDiscoveredModelsForAccount(a, { force: true })
          )
      )
    }

    return totalChanges
  }

  checkAvailability(): Promise<boolean> {
    return Promise.resolve(this.isAvailable())
  }

  getPoolStatus(): BackendPoolStatus {
    const now = Date.now()
    const entries = this.accounts.map((account) => {
      const modelCooldowns = this.getActiveModelCooldowns(account, now)
      const state = this.getPoolEntryState(account, modelCooldowns, now)
      return {
        id: account.stateKey,
        label: account.label || account.prefix || account.baseUrl,
        state,
        cooldownUntil: account.cooldownUntil,
        disabledAt: account.disabledAt,
        disabledReason: account.disabledReason,
        source: account.source,
        baseUrl: account.baseUrl,
        proxyUrl: account.proxyUrl,
        maxContextTokens: account.maxContextTokens,
        prefix: account.prefix,
        priority: account.priority,
        modelCooldowns,
      }
    })

    return {
      backend: "claude-api",
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
      configPath: this.accountsConfigPath,
      statePath: "~/.agent-vibes/pgdata/agent-vibes.db",
      entries,
    }
  }

  supportsModel(model: string): boolean {
    this.refreshDiscoveredModelsInBackgroundIfNeeded()
    return this.resolveCandidates(model).some(
      (candidate) => !isAccountDisabled(candidate.account)
    )
  }

  getPublicModels(): ClaudeApiPublicModel[] {
    this.refreshDiscoveredModelsInBackgroundIfNeeded()

    const models = new Map<string, ClaudeApiPublicModel>()

    for (const account of this.accounts) {
      if (isAccountDisabled(account)) {
        continue
      }

      for (const model of this.getAdvertisedModelsForAccount(account)) {
        for (const publicId of this.buildVisibleModelIdsForAccount(
          account,
          model.id
        )) {
          if (
            this.isModelExcluded(account, publicId) ||
            !this.isPublicModelIdCompatibleWithAccount(account, publicId)
          ) {
            continue
          }

          const normalized = publicId.toLowerCase()
          if (models.has(normalized)) {
            continue
          }

          models.set(normalized, {
            id: publicId,
            displayName: model.displayName,
            createdAt: model.createdAt,
            isThinking: model.isThinking,
          })
        }
      }
    }

    return Array.from(models.values()).sort((left, right) =>
      left.id.localeCompare(right.id)
    )
  }

  getPublicModelIds(): string[] {
    return this.getPublicModels().map((model) => model.id)
  }

  getConfiguredMaxContextTokens(model: string): number | undefined {
    const candidates = this.getAvailableCandidatesInAttemptOrder(
      this.resolveCandidates(model)
    )
    let resolved: number | undefined
    const seenAccounts = new Set<string>()

    for (const candidate of candidates) {
      if (seenAccounts.has(candidate.account.stateKey)) {
        continue
      }
      seenAccounts.add(candidate.account.stateKey)

      const limit = this.normalizeMaxContextTokens(
        candidate.account.maxContextTokens
      )
      if (limit === undefined) {
        continue
      }
      resolved = resolved === undefined ? limit : Math.min(resolved, limit)
    }

    return resolved
  }

  getCursorDisplayModels(): CursorDisplayModel[] {
    return this.getPublicModels().map((model) => ({
      name: model.id,
      displayName: model.displayName || model.id,
      shortName: model.displayName || model.id,
      family: "claude",
      isThinking: model.isThinking,
    }))
  }

  /**
   * Proxy a count_tokens request to the upstream Anthropic API.
   * Returns the upstream response if a suitable Claude API account is available,
   * or null if no account can serve this model (caller should fall back to local estimation).
   */
  async countTokensUpstream(
    dto: Record<string, unknown>
  ): Promise<{ input_tokens: number } | null> {
    const model = typeof dto.model === "string" ? dto.model : ""
    if (!model) return null

    const candidates = this.getAvailableCandidatesInAttemptOrder(
      this.resolveCandidates(model).filter((candidate) =>
        this.shouldApplyOfficialAnthropicOptimizations(candidate.account)
      )
    )
    if (candidates.length === 0) return null

    for (const candidate of candidates) {
      const account = candidate.account
      const request = this.buildUpstreamRequestPayload(
        dto,
        candidate.upstreamModel,
        account,
        {
          applyPromptCaching: true,
        }
      )
      const url = this.buildCountTokensUrl(account.baseUrl)
      const headers = this.buildHeadersForAccount(
        account,
        false,
        {},
        request.betas
      )
      const fetchOptions: RequestInit & { dispatcher?: unknown } = {
        method: "POST",
        headers,
        body: JSON.stringify(request.body),
      }

      const dispatcher = this.buildProxyAgent(account)
      if (dispatcher) {
        fetchOptions.dispatcher = dispatcher
      }

      try {
        const response = await this.fetchWithResponseHeadersTimeout(
          url,
          fetchOptions,
          10_000,
          "count_tokens upstream timed out"
        )

        if (!response.ok) {
          const errorBody = await response.text()
          this.buildHttpFailureError(
            account,
            response.status,
            errorBody,
            candidate.upstreamModel,
            response.headers.get("retry-after") || undefined
          )
          this.logger.debug(
            `[Claude API] count_tokens upstream failed: account=${account.label || account.baseUrl}, status=${response.status}`
          )
          continue
        }

        const result = (await response.json()) as { input_tokens?: number }
        if (typeof result.input_tokens === "number") {
          this.markAccountHealthy(account, candidate.upstreamModel)
          return { input_tokens: result.input_tokens }
        }

        this.markAccountTemporaryFailure(account, 502, candidate.upstreamModel)
        this.logger.debug(
          `[Claude API] count_tokens upstream returned invalid payload for ${account.label || account.baseUrl}`
        )
      } catch (error) {
        this.markAccountTemporaryFailure(account, 504, candidate.upstreamModel)
        this.logger.debug(
          `[Claude API] count_tokens upstream error for ${account.label || account.baseUrl}: ${formatUnknownError(error)}`
        )
      }
    }

    return null
  }

  async sendClaudeMessage(
    dto: CreateMessageDto,
    forwardHeaders: AnthropicForwardHeaders = {}
  ): Promise<AnthropicResponse> {
    return this.executeWithCooldownRetry(dto, forwardHeaders, new Set())
  }

  async *sendClaudeMessageStream(
    dto: CreateMessageDto,
    forwardHeaders: AnthropicForwardHeaders = {},
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    yield* this.executeStreamWithCooldownRetry(
      dto,
      forwardHeaders,
      new Set(),
      abortSignal
    )
  }

  private async executeWithCooldownRetry(
    dto: CreateMessageDto,
    forwardHeaders: AnthropicForwardHeaders,
    attemptedCandidates: Set<string>,
    candidate: ClaudeApiCandidate = this.nextCandidate(dto.model)
  ): Promise<AnthropicResponse> {
    const requestStartedAt = Date.now()
    attemptedCandidates.add(this.buildCandidateKey(candidate))
    const request = this.buildRequestBody(dto, candidate)
    const url = this.buildMessagesUrl(candidate.account.baseUrl)
    const headers = this.buildHeadersForAccount(
      candidate.account,
      false,
      forwardHeaders,
      request.betas
    )

    this.logger.log(
      `[Claude API] Non-stream request: model=${dto.model} -> ${candidate.upstreamModel}, url=${url}`
    )

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(300_000),
    }

    const dispatcher = this.buildProxyAgent(candidate.account)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    try {
      let response: Response
      try {
        response = await fetch(url, fetchOptions)
      } catch (error) {
        this.logger.error(
          `[Claude API] Non-stream fetch failed: account=${candidate.account.label || candidate.account.baseUrl}, model=${candidate.upstreamModel}, url=${url}, detail=${formatUnknownError(error)}`
        )
        throw this.buildTransientFailureError(
          candidate.account,
          504,
          formatUnknownError(error),
          candidate.upstreamModel
        )
      }

      if (!response.ok) {
        const errorBody = await response.text()
        this.logger.error(
          `[Claude API] Request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
        )
        throw this.buildHttpFailureError(
          candidate.account,
          response.status,
          errorBody,
          candidate.upstreamModel,
          response.headers.get("retry-after") || undefined
        )
      }

      const result = (await response.json()) as AnthropicResponse
      this.markAccountHealthy(candidate.account, candidate.upstreamModel)
      this.recordClaudeApiUsage(
        candidate,
        "messages",
        result.usage as Record<string, unknown> | null | undefined,
        requestStartedAt
      )
      return result
    } catch (error) {
      const nextCandidate = this.shouldRetryWithNextCandidate(
        error,
        candidate,
        candidate.upstreamModel
      )
        ? this.nextRetryCandidate(dto.model, attemptedCandidates)
        : null
      if (nextCandidate) {
        this.logger.warn(
          `[Claude API] Request failed on ${candidate.account.label || "account"} (${candidate.upstreamModel}), retrying with ${nextCandidate.account.label || "account"} (${nextCandidate.upstreamModel})`
        )
        return this.executeWithCooldownRetry(
          dto,
          forwardHeaders,
          attemptedCandidates,
          nextCandidate
        )
      }
      throw error
    }
  }

  private async *executeStreamWithCooldownRetry(
    dto: CreateMessageDto,
    forwardHeaders: AnthropicForwardHeaders,
    attemptedCandidates: Set<string>,
    abortSignal?: AbortSignal,
    candidate: ClaudeApiCandidate = this.nextCandidate(dto.model)
  ): AsyncGenerator<string, void, unknown> {
    const requestStartedAt = Date.now()
    attemptedCandidates.add(this.buildCandidateKey(candidate))
    const request = this.buildRequestBody(dto, candidate)
    const url = this.buildMessagesUrl(candidate.account.baseUrl)
    const headers = this.buildHeadersForAccount(
      candidate.account,
      true,
      forwardHeaders,
      request.betas
    )

    this.logger.log(
      `[Claude API] Stream request: model=${dto.model} -> ${candidate.upstreamModel}, url=${url}`
    )

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: JSON.stringify(request.body),
    }

    const dispatcher = this.buildProxyAgent(candidate.account)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    let emittedEvents = false
    try {
      let response: Response
      try {
        response = await this.fetchWithResponseHeadersTimeout(
          url,
          fetchOptions,
          180_000,
          "Claude API stream timed out waiting for upstream response headers after 180000ms",
          abortSignal
        )
      } catch (error) {
        const abortedError = toUpstreamRequestAbortedError(
          error,
          abortSignal,
          "Claude API stream aborted"
        )
        if (abortedError) {
          throw abortedError
        }
        this.logger.error(
          `[Claude API] Stream fetch failed before headers: account=${candidate.account.label || candidate.account.baseUrl}, model=${candidate.upstreamModel}, url=${url}, detail=${formatUnknownError(error)}`
        )
        throw this.buildTransientFailureError(
          candidate.account,
          504,
          formatUnknownError(error),
          candidate.upstreamModel
        )
      }

      if (!response.ok) {
        const errorBody = await response.text()
        this.logger.error(
          `[Claude API] Stream request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
        )
        throw this.buildHttpFailureError(
          candidate.account,
          response.status,
          errorBody,
          candidate.upstreamModel,
          response.headers.get("retry-after") || undefined
        )
      }

      if (!response.body) {
        throw this.buildTransientFailureError(
          candidate.account,
          502,
          "Claude API response has no body",
          candidate.upstreamModel
        )
      }

      const contentType = response.headers.get("content-type") || ""
      if (contentType.includes("text/html")) {
        const errorBodyText = await response.text()
        throw this.buildTransientFailureError(
          candidate.account,
          503,
          `Claude API returned HTML page: ${errorBodyText.slice(0, 200)}`,
          candidate.upstreamModel
        )
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      const streamUsage = {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
        webSearchRequests: 0,
      }

      try {
        while (true) {
          const { done, value } = await this.readStreamChunkWithTimeout(
            reader,
            180_000,
            "Claude API stream timed out while waiting for the next SSE chunk",
            abortSignal
          )

          if (done) {
            break
          }

          buffer += decoder
            .decode(value, { stream: true })
            .replace(/\r\n/g, "\n")

          let boundary = buffer.indexOf("\n\n")
          while (boundary !== -1) {
            const chunk = buffer.slice(0, boundary + 2)
            buffer = buffer.slice(boundary + 2)
            emittedEvents = true
            this.mergeClaudeStreamUsage(streamUsage, chunk)
            yield chunk.endsWith("\n\n") ? chunk : `${chunk}\n\n`
            boundary = buffer.indexOf("\n\n")
          }
        }

        const trailing = buffer.trim()
        if (trailing) {
          emittedEvents = true
          this.mergeClaudeStreamUsage(streamUsage, trailing)
          yield trailing.endsWith("\n\n") ? trailing : `${trailing}\n\n`
        }

        this.markAccountHealthy(candidate.account, candidate.upstreamModel)
        this.recordClaudeApiUsage(
          candidate,
          "messages",
          {
            input_tokens: streamUsage.inputTokens,
            cache_read_input_tokens: streamUsage.cachedInputTokens,
            cache_creation_input_tokens: streamUsage.cacheCreationInputTokens,
            output_tokens: streamUsage.outputTokens,
            server_tool_use: {
              web_search_requests: streamUsage.webSearchRequests,
            },
          },
          requestStartedAt
        )
        return
      } catch (error) {
        const abortedError = toUpstreamRequestAbortedError(
          error,
          abortSignal,
          "Claude API stream aborted"
        )
        if (abortedError) {
          throw abortedError
        }
        this.markAccountTemporaryFailure(
          candidate.account,
          504,
          candidate.upstreamModel
        )

        const nextCandidate =
          !emittedEvents &&
          this.shouldRetryWithNextCandidate(
            error,
            candidate,
            candidate.upstreamModel
          )
            ? this.nextRetryCandidate(dto.model, attemptedCandidates)
            : null
        if (nextCandidate) {
          this.logger.warn(
            `[Claude API] Stream failed on ${candidate.account.label || "account"} (${candidate.upstreamModel}), retrying with ${nextCandidate.account.label || "account"} (${nextCandidate.upstreamModel})`
          )
          yield* this.executeStreamWithCooldownRetry(
            dto,
            forwardHeaders,
            attemptedCandidates,
            abortSignal,
            nextCandidate
          )
          return
        }

        throw error
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // ignore reader release failures
        }
      }
    } catch (error) {
      const abortedError = toUpstreamRequestAbortedError(
        error,
        abortSignal,
        "Claude API stream aborted"
      )
      if (abortedError) {
        throw abortedError
      }

      const nextCandidate =
        !emittedEvents &&
        this.shouldRetryWithNextCandidate(
          error,
          candidate,
          candidate.upstreamModel
        )
          ? this.nextRetryCandidate(dto.model, attemptedCandidates)
          : null
      if (nextCandidate) {
        this.logger.warn(
          `[Claude API] Stream request failed on ${candidate.account.label || "account"} (${candidate.upstreamModel}), retrying with ${nextCandidate.account.label || "account"} (${nextCandidate.upstreamModel})`
        )
        yield* this.executeStreamWithCooldownRetry(
          dto,
          forwardHeaders,
          attemptedCandidates,
          abortSignal,
          nextCandidate
        )
        return
      }
      throw error
    }
  }

  private buildCandidateKey(candidate: ClaudeApiCandidate): string {
    return [
      candidate.account.stateKey,
      candidate.upstreamModel.trim().toLowerCase(),
      candidate.publicModelId.trim().toLowerCase(),
    ].join("\0")
  }

  private shouldRetryWithNextCandidate(
    error: unknown,
    candidate: ClaudeApiCandidate,
    model: string
  ): boolean {
    if (!isAccountAvailableForModel(candidate.account, model)) {
      return true
    }

    if (!(error instanceof BackendApiError)) {
      return false
    }

    const statusCode = error.statusCode
    if (typeof statusCode !== "number") {
      return false
    }

    return (
      statusCode === 401 ||
      statusCode === 402 ||
      statusCode === 403 ||
      statusCode === 404 ||
      statusCode === 408 ||
      statusCode === 409 ||
      statusCode === 429 ||
      statusCode >= 500
    )
  }

  private recordClaudeApiUsage(
    candidate: ClaudeApiCandidate,
    transport: string,
    usage:
      | {
          input_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
          output_tokens?: number
          server_tool_use?: {
            web_search_requests?: number
          }
        }
      | Record<string, unknown>
      | null
      | undefined,
    requestStartedAt?: number
  ): void {
    const usageRecord =
      usage && typeof usage === "object"
        ? (usage as Record<string, unknown>)
        : null
    const serverToolUse =
      usageRecord?.server_tool_use &&
      typeof usageRecord.server_tool_use === "object"
        ? (usageRecord.server_tool_use as Record<string, unknown>)
        : null
    this.usageStats.recordClaudeApiUsage({
      transport,
      modelName: candidate.upstreamModel,
      accountKey: candidate.account.stateKey,
      accountLabel: candidate.account.label || candidate.account.baseUrl,
      inputTokens:
        typeof usageRecord?.input_tokens === "number"
          ? usageRecord.input_tokens
          : 0,
      cachedInputTokens:
        typeof usageRecord?.cache_read_input_tokens === "number"
          ? usageRecord.cache_read_input_tokens
          : 0,
      cacheCreationInputTokens:
        typeof usageRecord?.cache_creation_input_tokens === "number"
          ? usageRecord.cache_creation_input_tokens
          : 0,
      outputTokens:
        typeof usageRecord?.output_tokens === "number"
          ? usageRecord.output_tokens
          : 0,
      webSearchRequests:
        typeof serverToolUse?.web_search_requests === "number"
          ? serverToolUse.web_search_requests
          : 0,
      durationMs:
        typeof requestStartedAt === "number"
          ? Math.max(0, Date.now() - requestStartedAt)
          : 0,
    })
  }

  private mergeClaudeStreamUsage(
    target: {
      inputTokens: number
      cachedInputTokens: number
      cacheCreationInputTokens: number
      outputTokens: number
      webSearchRequests: number
    },
    chunk: string
  ): void {
    const lines = chunk.split("\n")
    let eventType = ""
    let dataLine = ""

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim()
      } else if (line.startsWith("data:")) {
        dataLine = line.slice(5).trim()
      }
    }

    if (!dataLine) return

    try {
      const payload = JSON.parse(dataLine) as Record<string, unknown>
      if (eventType === "message_start") {
        const message =
          payload.message && typeof payload.message === "object"
            ? (payload.message as Record<string, unknown>)
            : null
        const usage =
          message?.usage && typeof message.usage === "object"
            ? (message.usage as Record<string, unknown>)
            : null
        if (typeof usage?.input_tokens === "number") {
          target.inputTokens = Math.max(0, Math.round(usage.input_tokens))
        }
        if (
          typeof usage?.cache_read_input_tokens === "number" &&
          usage.cache_read_input_tokens > 0
        ) {
          target.cachedInputTokens = Math.max(
            0,
            Math.round(usage.cache_read_input_tokens)
          )
        }
        if (
          typeof usage?.cache_creation_input_tokens === "number" &&
          usage.cache_creation_input_tokens > 0
        ) {
          target.cacheCreationInputTokens = Math.max(
            0,
            Math.round(usage.cache_creation_input_tokens)
          )
        }
        if (typeof usage?.output_tokens === "number") {
          target.outputTokens = Math.max(0, Math.round(usage.output_tokens))
        }
        const serverToolUse =
          usage?.server_tool_use && typeof usage.server_tool_use === "object"
            ? (usage.server_tool_use as Record<string, unknown>)
            : null
        if (
          typeof serverToolUse?.web_search_requests === "number" &&
          serverToolUse.web_search_requests > 0
        ) {
          target.webSearchRequests = Math.max(
            0,
            Math.round(serverToolUse.web_search_requests)
          )
        }
        return
      }

      if (eventType !== "message_delta") {
        return
      }

      const usage =
        payload.usage && typeof payload.usage === "object"
          ? (payload.usage as Record<string, unknown>)
          : null
      if (typeof usage?.input_tokens === "number") {
        target.inputTokens = Math.max(0, Math.round(usage.input_tokens))
      }
      if (
        typeof usage?.cache_read_input_tokens === "number" &&
        usage.cache_read_input_tokens > 0
      ) {
        target.cachedInputTokens = Math.max(
          0,
          Math.round(usage.cache_read_input_tokens)
        )
      }
      if (
        typeof usage?.cache_creation_input_tokens === "number" &&
        usage.cache_creation_input_tokens > 0
      ) {
        target.cacheCreationInputTokens = Math.max(
          0,
          Math.round(usage.cache_creation_input_tokens)
        )
      }
      if (typeof usage?.output_tokens === "number") {
        target.outputTokens = Math.max(0, Math.round(usage.output_tokens))
      }
      const serverToolUse =
        usage?.server_tool_use && typeof usage.server_tool_use === "object"
          ? (usage.server_tool_use as Record<string, unknown>)
          : null
      if (
        typeof serverToolUse?.web_search_requests === "number" &&
        serverToolUse.web_search_requests > 0
      ) {
        target.webSearchRequests = Math.max(
          0,
          Math.round(serverToolUse.web_search_requests)
        )
      }
    } catch {
      // Ignore malformed SSE fragments for analytics bookkeeping
    }
  }

  private nextRetryCandidate(
    model: string,
    attemptedCandidates: Set<string>
  ): ClaudeApiCandidate | null {
    const remainingCandidates = this.resolveCandidates(model).filter(
      (candidate) => !attemptedCandidates.has(this.buildCandidateKey(candidate))
    )
    if (remainingCandidates.length === 0) {
      return null
    }

    return this.selectCandidate(model, remainingCandidates)
  }

  private getActiveModelCooldowns(
    account: ClaudeApiAccount,
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
    account: ClaudeApiAccount,
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
      return "model_cooldown"
    }
    return "ready"
  }

  private buildAccountStateKey(
    apiKey: string,
    baseUrl: string,
    prefix?: string
  ): string {
    return crypto
      .createHash("sha256")
      .update(baseUrl)
      .update("\0")
      .update(prefix || "")
      .update("\0")
      .update(apiKey)
      .digest("hex")
  }

  private normalizeBaseUrl(baseUrl?: string): string {
    const normalized = (baseUrl || "").trim()
    return normalized || DEFAULT_ANTHROPIC_BASE_URL
  }

  private configureAccountStateStore(_configPath?: string | null): void {
    // No-op: PersistenceService handles the unified DB path.
    // Kept for interface compatibility.
  }

  private normalizeModels(
    models?: Array<{ name?: string; alias?: string }>
  ): ClaudeApiModelMapping[] {
    if (!Array.isArray(models)) {
      return []
    }

    const out: ClaudeApiModelMapping[] = []
    for (const model of models) {
      const name = (model?.name || "").trim()
      if (!name) {
        continue
      }
      const alias = (model?.alias || "").trim()
      out.push(alias ? { name, alias } : { name })
    }
    return out
  }

  private normalizeHeaders(
    headers?: Record<string, string>
  ): Record<string, string> | undefined {
    if (!headers || typeof headers !== "object") {
      return undefined
    }

    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
      const normalizedKey = key.trim()
      const normalizedValue = `${value}`.trim()
      if (!normalizedKey || !normalizedValue) {
        continue
      }
      out[normalizedKey] = normalizedValue
    }

    return Object.keys(out).length > 0 ? out : undefined
  }

  private normalizeExcludedModels(models?: string[]): string[] {
    if (!Array.isArray(models) || models.length === 0) {
      return []
    }

    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of models) {
      const normalized = `${raw}`.trim().toLowerCase()
      if (!normalized || seen.has(normalized)) {
        continue
      }
      seen.add(normalized)
      out.push(normalized)
    }
    return out
  }

  private buildAccountRecord(params: {
    label?: string
    apiKey: string
    baseUrl?: string
    proxyUrl?: string
    maxContextTokens?: number
    stripThinking?: boolean
    prefix?: string
    priority?: number
    headers?: Record<string, string>
    models?: Array<{ name?: string; alias?: string }>
    excludedModels?: string[]
    source: "env" | "file"
  }): ClaudeApiAccount {
    const baseUrl = this.normalizeBaseUrl(params.baseUrl)
    const prefix = params.prefix?.trim() || undefined
    return {
      label: params.label?.trim() || undefined,
      apiKey: params.apiKey.trim(),
      baseUrl,
      proxyUrl: params.proxyUrl?.trim() || undefined,
      maxContextTokens: this.normalizeMaxContextTokens(params.maxContextTokens),
      stripThinking: params.stripThinking === true,
      prefix,
      priority:
        typeof params.priority === "number" && Number.isFinite(params.priority)
          ? params.priority
          : 0,
      headers: this.normalizeHeaders(params.headers),
      models: this.normalizeModels(params.models),
      excludedModels: this.normalizeExcludedModels(params.excludedModels),
      source: params.source,
      stateKey: this.buildAccountStateKey(
        params.apiKey.trim(),
        baseUrl,
        prefix
      ),
      discoveredModels: [],
      cooldownUntil: 0,
      modelStates: new Map(),
    }
  }

  private getDiscoveredModelMappings(
    account: ClaudeApiAccount
  ): ClaudeApiModelMapping[] {
    return account.discoveredModels.map((model) => ({ name: model.name }))
  }

  private getResolvedModelMappings(
    account: ClaudeApiAccount
  ): ClaudeApiModelMapping[] {
    if (account.models.length > 0) {
      return account.models
    }

    return this.getDiscoveredModelMappings(account)
  }

  private getAdvertisedModelsForAccount(
    account: ClaudeApiAccount
  ): ClaudeApiPublicModel[] {
    if (account.models.length > 0) {
      return account.models.map((mapping) => ({
        id: mapping.alias || mapping.name,
        displayName: mapping.alias || mapping.name,
        isThinking: doesModelIdRequireExplicitThinkingSupport(
          mapping.alias || mapping.name
        ),
      }))
    }

    if (account.discoveredModels.length > 0) {
      return account.discoveredModels.map((model) => ({
        id: model.name,
        displayName: model.displayName || model.name,
        createdAt: model.createdAt,
        isThinking:
          model.isThinking ||
          doesModelIdRequireExplicitThinkingSupport(model.name),
      }))
    }

    return DEFAULT_PUBLIC_CLAUDE_MODEL_IDS.map((modelId) => ({
      id: modelId,
      displayName: modelId,
      isThinking: doesModelIdRequireExplicitThinkingSupport(modelId),
    }))
  }

  private shouldDiscoverModelsForAccount(account: ClaudeApiAccount): boolean {
    return account.models.length === 0
  }

  private shouldRefreshDiscovery(account: ClaudeApiAccount): boolean {
    return (
      this.shouldDiscoverModelsForAccount(account) &&
      (!account.discoveredModelsFetchedAt ||
        Date.now() - account.discoveredModelsFetchedAt >=
          MODEL_DISCOVERY_TTL_MS)
    )
  }

  private refreshDiscoveredModelsInBackgroundIfNeeded(): void {
    for (const account of this.accounts) {
      if (!this.shouldRefreshDiscovery(account)) {
        continue
      }

      void this.refreshDiscoveredModelsForAccount(account).catch((error) => {
        this.logger.debug(
          `[Claude API] Background model discovery failed for ${account.label || account.baseUrl}: ${error instanceof Error ? error.message : String(error)}`
        )
      })
    }
  }

  private async refreshDiscoveredModelsForAccount(
    account: ClaudeApiAccount,
    options: { force?: boolean } = {}
  ): Promise<void> {
    if (!this.shouldDiscoverModelsForAccount(account)) {
      account.discoveredModels = []
      account.discoveredModelsFetchedAt = Date.now()
      return
    }

    if (!options.force && !this.shouldRefreshDiscovery(account)) {
      return
    }

    if (account.discoveryPromise) {
      return account.discoveryPromise
    }

    account.discoveryPromise = (async () => {
      try {
        account.discoveredModels = await this.fetchModelsForAccount(account)
      } catch (error) {
        this.logger.debug(
          `[Claude API] Model discovery unavailable for ${account.label || account.baseUrl}: ${error instanceof Error ? error.message : String(error)}`
        )
      } finally {
        account.discoveredModelsFetchedAt = Date.now()
        account.discoveryPromise = undefined
      }
    })()

    return account.discoveryPromise
  }

  private async fetchModelsForAccount(
    account: ClaudeApiAccount
  ): Promise<ClaudeApiDiscoveredModel[]> {
    const discovered = new Map<string, ClaudeApiDiscoveredModel>()
    let afterId: string | undefined

    for (let page = 0; page < MODEL_DISCOVERY_MAX_PAGES; page++) {
      const response = await this.fetchModelPage(account, afterId)

      for (const model of response.models) {
        const normalized = model.name.toLowerCase()
        if (!normalized || discovered.has(normalized)) {
          continue
        }
        discovered.set(normalized, model)
      }

      if (
        !response.hasMore ||
        !response.lastId ||
        response.lastId === afterId
      ) {
        break
      }
      afterId = response.lastId
    }

    return Array.from(discovered.values()).sort((left, right) =>
      left.name.localeCompare(right.name)
    )
  }

  private async fetchModelPage(
    account: ClaudeApiAccount,
    afterId?: string
  ): Promise<{
    models: ClaudeApiDiscoveredModel[]
    hasMore: boolean
    lastId?: string
  }> {
    const url = this.buildModelsUrl(account.baseUrl, afterId)
    const headers = this.buildHeadersForAccount(account, false, {}, [])
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "GET",
      headers,
    }

    const dispatcher = this.buildProxyAgent(account)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    const response = await this.fetchWithResponseHeadersTimeout(
      url,
      fetchOptions,
      MODEL_DISCOVERY_TIMEOUT_MS,
      `Claude API model discovery timed out after ${MODEL_DISCOVERY_TIMEOUT_MS}ms`
    )

    if (!response.ok) {
      const detail = await response.text()
      throw new Error(
        `status=${response.status} body=${this.buildErrorPreview(detail)}`
      )
    }

    const payload = (await response.json()) as {
      data?: unknown[]
      has_more?: boolean
      last_id?: string
    }

    return {
      models: this.parseDiscoveredModels(payload.data),
      hasMore: payload?.has_more === true,
      lastId:
        typeof payload?.last_id === "string" && payload.last_id.trim()
          ? payload.last_id.trim()
          : undefined,
    }
  }

  private parseDiscoveredModels(data: unknown): ClaudeApiDiscoveredModel[] {
    if (!Array.isArray(data)) {
      return []
    }

    const models: ClaudeApiDiscoveredModel[] = []
    const seen = new Set<string>()

    for (const entry of data) {
      const model = this.parseDiscoveredModelEntry(entry)
      if (!model) {
        continue
      }

      const normalized = model.name.toLowerCase()
      if (seen.has(normalized)) {
        continue
      }
      seen.add(normalized)
      models.push(model)
    }

    return models
  }

  private parseDiscoveredModelEntry(
    entry: unknown
  ): ClaudeApiDiscoveredModel | null {
    if (!entry || typeof entry !== "object") {
      return null
    }

    const rawEntry = entry as {
      id?: unknown
      name?: unknown
      display_name?: unknown
      displayName?: unknown
      created_at?: unknown
      createdAt?: unknown
      capabilities?: {
        thinking?: {
          supported?: unknown
        }
      }
      thinking?: unknown
    }

    const name =
      typeof rawEntry.id === "string" && rawEntry.id.trim()
        ? rawEntry.id.trim()
        : typeof rawEntry.name === "string" && rawEntry.name.trim()
          ? rawEntry.name.trim()
          : ""
    if (!name) {
      return null
    }

    const displayName =
      typeof rawEntry.display_name === "string" && rawEntry.display_name.trim()
        ? rawEntry.display_name.trim()
        : typeof rawEntry.displayName === "string" &&
            rawEntry.displayName.trim()
          ? rawEntry.displayName.trim()
          : undefined

    const createdAtRaw =
      typeof rawEntry.created_at === "string"
        ? rawEntry.created_at
        : typeof rawEntry.createdAt === "string"
          ? rawEntry.createdAt
          : ""
    const createdAt = createdAtRaw ? Date.parse(createdAtRaw) : NaN

    return {
      name,
      displayName,
      createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
      isThinking:
        rawEntry.capabilities?.thinking?.supported === true ||
        rawEntry.thinking === true ||
        doesModelIdRequireExplicitThinkingSupport(name),
    }
  }

  private loadAllAccountsFromFile(): ClaudeApiAccount[] {
    const configPaths = getAccountConfigPathCandidates(
      "claude-api-accounts.json"
    )

    for (const configPath of configPaths) {
      if (!fs.existsSync(configPath)) continue

      try {
        const data = JSON.parse(
          fs.readFileSync(configPath, "utf8")
        ) as ClaudeApiConfigFile
        if (typeof data.forceModelPrefix === "boolean") {
          this.forceModelPrefix = data.forceModelPrefix
        }
        if (!Array.isArray(data.accounts) || data.accounts.length === 0) {
          continue
        }

        this.accountsConfigPath = configPath
        this.configureAccountStateStore(configPath)
        this.logger.log(
          `Loaded ${data.accounts.length} Claude API account(s) from ${configPath}`
        )

        return data.accounts
          .filter(
            (entry): entry is ClaudeApiAccountFileEntry & { apiKey: string } =>
              typeof entry?.apiKey === "string" && entry.apiKey.trim() !== ""
          )
          .map((entry) =>
            this.buildAccountRecord({
              label: entry.label,
              apiKey: entry.apiKey,
              baseUrl: entry.baseUrl,
              proxyUrl: entry.proxyUrl,
              maxContextTokens: entry.maxContextTokens,
              stripThinking: entry.stripThinking,
              prefix: entry.prefix,
              priority: entry.priority,
              headers: entry.headers,
              models: entry.models,
              excludedModels: entry.excludedModels,
              source: "file",
            })
          )
      } catch (error) {
        this.logger.warn(
          `Failed to parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    return []
  }

  private loadPersistedAccountStates(): Map<
    string,
    PersistedClaudeApiAccountState
  > {
    return this.accountStateStore.loadStates("claude-api")
  }

  private applyPersistedAccountState(
    account: ClaudeApiAccount,
    state?: PersistedClaudeApiAccountState
  ): void {
    if (!state) {
      return
    }

    const now = Date.now()

    if (typeof state.disabledAt === "number" && state.disabledAt > 0) {
      account.disabledAt = state.disabledAt
      account.disabledReason = state.disabledReason
      account.disabledStatusCode = state.disabledStatusCode
      account.disabledMessage = state.disabledMessage
      account.cooldownUntil = 0
      account.modelStates.clear()
      return
    }

    if (typeof state.cooldownUntil === "number" && state.cooldownUntil > now) {
      account.cooldownUntil = state.cooldownUntil
    }

    if (Array.isArray(state.modelStates)) {
      for (const modelState of state.modelStates) {
        if (
          !modelState ||
          typeof modelState.model !== "string" ||
          !modelState.model ||
          typeof modelState.cooldownUntil !== "number" ||
          modelState.cooldownUntil <= now
        ) {
          continue
        }

        account.modelStates.set(modelState.model, {
          cooldownUntil: modelState.cooldownUntil,
          quotaExhausted: !!modelState.quotaExhausted,
          backoffLevel:
            typeof modelState.backoffLevel === "number"
              ? modelState.backoffLevel
              : 0,
        })
      }
    }
  }

  private serializeAccountState(
    account: ClaudeApiAccount
  ): PersistedClaudeApiAccountState | null {
    if (
      !isAccountDisabled(account) &&
      account.cooldownUntil <= 0 &&
      account.modelStates.size === 0
    ) {
      return null
    }

    const record: PersistedClaudeApiAccountState = {
      stateKey: account.stateKey,
      label: account.label,
      updatedAt: Date.now(),
    }

    if (isAccountDisabled(account)) {
      record.disabledAt = account.disabledAt
      record.disabledReason = account.disabledReason
      record.disabledStatusCode = account.disabledStatusCode
      record.disabledMessage = account.disabledMessage
      return record
    }

    if (account.cooldownUntil > 0) {
      record.cooldownUntil = account.cooldownUntil
    }

    if (account.modelStates.size > 0) {
      record.modelStates = Array.from(account.modelStates.entries()).map(
        ([model, modelState]) => ({
          model,
          cooldownUntil: modelState.cooldownUntil,
          quotaExhausted: modelState.quotaExhausted,
          backoffLevel: modelState.backoffLevel,
        })
      )
    }

    return record
  }

  private persistAccountStates(): void {
    this.accountStateStore.replaceStates(
      "claude-api",
      this.accounts
        .map((account) => this.serializeAccountState(account))
        .filter(
          (account): account is PersistedClaudeApiAccountState =>
            account != null
        )
    )
  }

  private normalizeRequestedModel(model: string): {
    prefix?: string
    model: string
  } {
    const normalized = model.trim()
    const slashIndex = normalized.indexOf("/")
    if (slashIndex <= 0 || slashIndex === normalized.length - 1) {
      return { model: normalized.toLowerCase() }
    }

    return {
      prefix: normalized.slice(0, slashIndex).trim().toLowerCase(),
      model: normalized
        .slice(slashIndex + 1)
        .trim()
        .toLowerCase(),
    }
  }

  private applyPrefix(prefix: string | undefined, modelId: string): string {
    const normalizedModel = modelId.trim()
    if (!normalizedModel) {
      return normalizedModel
    }
    return prefix ? `${prefix}/${normalizedModel}` : normalizedModel
  }

  private buildVisibleModelIdsForAccount(
    account: ClaudeApiAccount,
    modelId: string
  ): string[] {
    const baseId = modelId.trim()
    if (!baseId) {
      return []
    }

    const out: string[] = []
    const seen = new Set<string>()
    const add = (value: string) => {
      const normalized = value.trim()
      if (!normalized || seen.has(normalized)) {
        return
      }
      seen.add(normalized)
      out.push(normalized)
    }

    const prefix = account.prefix?.trim()
    if (!prefix) {
      add(baseId)
      return out
    }

    if (!this.forceModelPrefix || prefix === baseId) {
      add(baseId)
    }
    add(`${prefix}/${baseId}`)
    return out
  }

  private matchWildcard(pattern: string, value: string): boolean {
    if (!pattern) {
      return false
    }
    if (!pattern.includes("*")) {
      return pattern === value
    }

    const parts = pattern.split("*")
    let remaining = value

    const prefix = parts[0]
    if (prefix) {
      if (!remaining.startsWith(prefix)) {
        return false
      }
      remaining = remaining.slice(prefix.length)
    }

    const suffix = parts[parts.length - 1]
    if (suffix) {
      if (!remaining.endsWith(suffix)) {
        return false
      }
      remaining = remaining.slice(0, remaining.length - suffix.length)
    }

    for (let index = 1; index < parts.length - 1; index++) {
      const segment = parts[index]
      if (!segment) {
        continue
      }
      const matchIndex = remaining.indexOf(segment)
      if (matchIndex < 0) {
        return false
      }
      remaining = remaining.slice(matchIndex + segment.length)
    }

    return true
  }

  private isModelExcluded(
    account: ClaudeApiAccount,
    publicModelId: string
  ): boolean {
    const normalized = publicModelId.trim().toLowerCase()
    if (!normalized || account.excludedModels.length === 0) {
      return false
    }
    return account.excludedModels.some((pattern) =>
      this.matchWildcard(pattern, normalized)
    )
  }

  private isPublicModelIdCompatibleWithAccount(
    account: ClaudeApiAccount,
    publicModelId: string
  ): boolean {
    if (!account.stripThinking) {
      return true
    }

    return !doesModelIdRequireExplicitThinkingSupport(publicModelId)
  }

  private shouldIncludeUnprefixedRequestForAccount(
    account: ClaudeApiAccount
  ): boolean {
    const prefix = account.prefix?.trim()
    if (!prefix) {
      return true
    }
    return !this.forceModelPrefix
  }

  private resolveCandidates(model: string): ClaudeApiCandidate[] {
    this.refreshDiscoveredModelsInBackgroundIfNeeded()
    const requested = this.normalizeRequestedModel(model)
    const candidates: ClaudeApiCandidate[] = []

    for (const account of this.accounts) {
      const accountPrefix = account.prefix?.toLowerCase()
      if (requested.prefix) {
        if (!accountPrefix || accountPrefix !== requested.prefix) {
          continue
        }
      } else if (!this.shouldIncludeUnprefixedRequestForAccount(account)) {
        continue
      }

      const modelMappings = this.getResolvedModelMappings(account)
      let matchedResolvedMapping = false
      if (modelMappings.length > 0) {
        for (const mapping of modelMappings) {
          const alias = mapping.alias?.trim().toLowerCase()
          const name = mapping.name.trim().toLowerCase()
          if (
            requested.model !== name &&
            (!alias || requested.model !== alias)
          ) {
            continue
          }

          const publicModelBase = mapping.alias || mapping.name
          const publicModelId = requested.prefix
            ? this.applyPrefix(account.prefix, publicModelBase)
            : publicModelBase.trim()
          if (
            this.isModelExcluded(account, publicModelId) ||
            !this.isPublicModelIdCompatibleWithAccount(account, publicModelId)
          ) {
            continue
          }

          matchedResolvedMapping = true
          candidates.push({
            account,
            upstreamModel: mapping.name.trim(),
            publicModelId,
          })
        }
        if (matchedResolvedMapping || account.models.length > 0) {
          continue
        }
      }

      if (detectModelFamily(requested.model) !== "claude") {
        continue
      }

      const publicModelId = requested.prefix
        ? this.applyPrefix(account.prefix, requested.model)
        : requested.model
      if (
        this.isModelExcluded(account, publicModelId) ||
        !this.isPublicModelIdCompatibleWithAccount(account, publicModelId)
      ) {
        continue
      }

      candidates.push({
        account,
        upstreamModel: requested.model,
        publicModelId,
      })
    }

    return candidates
  }

  private nextCandidate(model: string): ClaudeApiCandidate {
    return this.selectCandidate(model, this.resolveCandidates(model))
  }

  private selectCandidate(
    model: string,
    candidates: ClaudeApiCandidate[]
  ): ClaudeApiCandidate {
    if (candidates.length === 0) {
      throw new Error(
        `Claude API backend has no configured account for model ${model}`
      )
    }

    const now = Date.now()
    const availableByPriority = new Map<number, ClaudeApiCandidate[]>()
    const seenDisabled = new Set<string>()
    const seenCooling = new Set<string>()

    for (const candidate of candidates) {
      if (isAccountDisabled(candidate.account)) {
        seenDisabled.add(candidate.account.stateKey)
        continue
      }
      if (
        !isAccountAvailableForModel(
          candidate.account,
          candidate.upstreamModel,
          now
        )
      ) {
        seenCooling.add(candidate.account.stateKey)
        continue
      }

      const list = availableByPriority.get(candidate.account.priority) || []
      list.push(candidate)
      availableByPriority.set(candidate.account.priority, list)
    }

    if (availableByPriority.size === 0) {
      let earliestRecovery = Number.POSITIVE_INFINITY
      const nowForRecovery = Date.now()
      for (const candidate of candidates) {
        const account = candidate.account
        if (isAccountDisabled(account)) {
          continue
        }

        if (account.cooldownUntil > nowForRecovery) {
          earliestRecovery = Math.min(earliestRecovery, account.cooldownUntil)
        }

        const modelState = account.modelStates.get(candidate.upstreamModel)
        if (
          modelState?.cooldownUntil &&
          modelState.cooldownUntil > nowForRecovery
        ) {
          const effectiveRecovery =
            account.cooldownUntil > nowForRecovery
              ? Math.max(account.cooldownUntil, modelState.cooldownUntil)
              : modelState.cooldownUntil
          earliestRecovery = Math.min(earliestRecovery, effectiveRecovery)
        }
      }

      if (Number.isFinite(earliestRecovery)) {
        const retryAfterSeconds = Math.ceil(
          Math.max(0, earliestRecovery - nowForRecovery) / 1000
        )
        throw new BackendAccountPoolUnavailableError(
          `All Claude API accounts are unavailable for model ${model}. Retry after ${retryAfterSeconds} seconds.`,
          {
            backend: "claude-api",
            retryAfterSeconds,
            disabledCount: seenDisabled.size,
            coolingCount: seenCooling.size,
          }
        )
      }

      throw new BackendAccountPoolUnavailableError(
        `All Claude API accounts are permanently disabled for model ${model}.`,
        {
          backend: "claude-api",
          disabledCount: seenDisabled.size,
          coolingCount: 0,
          permanent: true,
        }
      )
    }

    const priorities = Array.from(availableByPriority.keys()).sort(
      (left, right) => right - left
    )
    const selectedPool = availableByPriority.get(priorities[0]!) || []
    const selected =
      selectedPool[this.accountIndex % selectedPool.length] || selectedPool[0]
    this.accountIndex = (this.accountIndex + 1) % Number.MAX_SAFE_INTEGER
    return selected!
  }

  private buildRequestBody(
    dto: CreateMessageDto,
    candidate: ClaudeApiCandidate
  ): {
    body: Record<string, unknown>
    betas: string[]
  } {
    return this.buildUpstreamRequestPayload(
      dto as unknown as Record<string, unknown>,
      candidate.upstreamModel,
      candidate.account,
      {
        applyPromptCaching: true,
      }
    )
  }

  private normalizeBetas(raw: unknown): string[] {
    if (Array.isArray(raw)) {
      return raw
        .map((value) => `${value}`.trim())
        .filter((value) => value.length > 0)
    }

    if (typeof raw === "string") {
      return raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    }

    return []
  }

  private buildHeadersForAccount(
    account: ClaudeApiAccount,
    stream: boolean,
    forwardHeaders: AnthropicForwardHeaders,
    betas: string[]
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      ...DEFAULT_FORWARDED_HEADERS,
    }

    if (stream) {
      headers["accept-encoding"] = "identity"
    }

    for (const [key, value] of Object.entries(forwardHeaders)) {
      if (typeof value !== "string" || value.trim() === "") {
        continue
      }
      headers[key.toLowerCase()] = value.trim()
    }

    if (account.headers) {
      for (const [key, value] of Object.entries(account.headers)) {
        headers[key.toLowerCase()] = value
      }
    }

    // Build the beta header after all header sources are merged so custom
    // account headers cannot accidentally erase required official betas.
    const baseBetaStr =
      headers["anthropic-beta"] ||
      (this.shouldApplyOfficialAnthropicOptimizations(account)
        ? REQUIRED_BETA_FEATURES.join(",")
        : "")
    const existingBetas = baseBetaStr
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
    const betaSet = new Set(existingBetas)

    if (this.shouldApplyOfficialAnthropicOptimizations(account)) {
      for (const required of REQUIRED_BETA_FEATURES) {
        betaSet.add(required)
      }
    }

    // Merge betas extracted from the request body
    for (const beta of betas) {
      betaSet.add(beta)
    }

    if (betaSet.size > 0) {
      headers["anthropic-beta"] = Array.from(betaSet).join(",")
    } else {
      delete headers["anthropic-beta"]
    }

    if (this.isOfficialAnthropicBase(account.baseUrl)) {
      delete headers.authorization
      headers["x-api-key"] = account.apiKey
    } else {
      delete headers["x-api-key"]
      headers.authorization = `Bearer ${account.apiKey}`
    }

    // Re-enforce identity encoding for streams after custom headers.
    // Compressed SSE breaks the line scanner regardless of user preference.
    if (stream) {
      headers["accept-encoding"] = "identity"
    }

    return headers
  }

  private isOfficialAnthropicBase(baseUrl: string): boolean {
    try {
      const parsed = new URL(baseUrl)
      return (
        parsed.protocol === "https:" &&
        parsed.hostname.toLowerCase() === "api.anthropic.com"
      )
    } catch {
      return false
    }
  }

  private buildMessagesUrl(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/+$/, "")
    return /\/v1$/i.test(normalized)
      ? `${normalized}/messages`
      : `${normalized}/v1/messages`
  }

  private buildCountTokensUrl(baseUrl: string): string {
    return `${this.buildMessagesUrl(baseUrl)}/count_tokens`
  }

  private buildModelsUrl(baseUrl: string, afterId?: string): string {
    const normalized = baseUrl.replace(/\/+$/, "")
    const url = new URL(
      /\/v1$/i.test(normalized)
        ? `${normalized}/models`
        : `${normalized}/v1/models`
    )
    url.searchParams.set("limit", "1000")
    if (afterId) {
      url.searchParams.set("after_id", afterId)
    }
    return url.toString()
  }

  private shouldApplyOfficialAnthropicOptimizations(
    account: ClaudeApiAccount
  ): boolean {
    return this.isOfficialAnthropicBase(account.baseUrl)
  }

  private buildUpstreamRequestPayload(
    dto: Record<string, unknown>,
    upstreamModel: string,
    account: ClaudeApiAccount,
    options: {
      applyPromptCaching?: boolean
    } = {}
  ): {
    body: Record<string, unknown>
    betas: string[]
  } {
    const raw = JSON.parse(JSON.stringify(dto)) as Record<string, unknown>
    const betas = this.normalizeBetas(raw.betas)

    delete raw.betas
    delete raw._conversationId
    delete raw._contextTokenBudget
    delete raw._pendingToolUseIds

    raw.model = upstreamModel
    raw.tools = this.normalizeClaudeTools(raw.tools)
    raw.tool_choice = this.normalizeClaudeToolChoice(raw.tool_choice)
    if (account.stripThinking) {
      delete raw.thinking
      delete raw.output_config
    }

    if (
      options.applyPromptCaching &&
      this.shouldApplyOfficialAnthropicOptimizations(account)
    ) {
      // Keep Anthropic-only request shaping away from third-party
      // Claude-compatible providers that only support the base messages API.
      applyPromptCachingOptimizations(raw)
    }

    return {
      body: raw,
      betas,
    }
  }

  private normalizeClaudeTools(tools: unknown): unknown {
    if (!Array.isArray(tools)) {
      return tools
    }

    return tools.map((tool): unknown => {
      if (!tool || typeof tool !== "object") {
        return tool
      }

      const normalized = {
        ...(tool as Record<string, unknown>),
      }

      if (normalized.type === "function") {
        delete normalized.type
      }

      return normalized
    })
  }

  private normalizeClaudeToolChoice(toolChoice: unknown): unknown {
    if (!toolChoice || typeof toolChoice !== "object") {
      return toolChoice
    }

    const normalized = {
      ...(toolChoice as Record<string, unknown>),
    }

    if (normalized.type === "function") {
      normalized.type = "tool"
    }

    return normalized
  }

  private getAvailableCandidatesInAttemptOrder(
    candidates: ClaudeApiCandidate[]
  ): ClaudeApiCandidate[] {
    const now = Date.now()
    const availableByPriority = new Map<number, ClaudeApiCandidate[]>()

    for (const candidate of candidates) {
      if (
        isAccountDisabled(candidate.account) ||
        !isAccountAvailableForModel(
          candidate.account,
          candidate.upstreamModel,
          now
        )
      ) {
        continue
      }

      const list = availableByPriority.get(candidate.account.priority) || []
      list.push(candidate)
      availableByPriority.set(candidate.account.priority, list)
    }

    const priorities = Array.from(availableByPriority.keys()).sort(
      (left, right) => right - left
    )

    return priorities.flatMap((priority, index) => {
      const pool = availableByPriority.get(priority) || []
      if (pool.length <= 1) {
        return pool
      }

      const startIndex = index === 0 ? this.accountIndex % pool.length : 0
      return pool.slice(startIndex).concat(pool.slice(0, startIndex))
    })
  }

  private buildProxyAgent(
    account: ClaudeApiAccount
  ):
    | HttpProxyAgent<string>
    | HttpsProxyAgent<string>
    | SocksProxyAgent
    | undefined {
    const proxyUrl = account.proxyUrl
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
    } catch (error) {
      this.logger.error(
        `Failed to parse proxy URL ${proxyUrl}: ${formatUnknownError(error)}`
      )
      return undefined
    }
  }

  private shouldDisableAccountPermanently(
    statusCode: number,
    detail: string
  ): boolean {
    if (statusCode === 401) {
      return true
    }

    if (statusCode !== 403) {
      return false
    }

    const normalized = detail.toLowerCase()
    return /invalid[_ -]?api[_ -]?key|provided api key|authentication|unauthorized|invalid[_ -]?x-api-key|credential/.test(
      normalized
    )
  }

  private buildErrorPreview(detail: string, maxLength: number = 200): string {
    return detail.length > maxLength ? detail.slice(0, maxLength) : detail
  }

  private disableAccountPermanently(
    account: ClaudeApiAccount,
    statusCode: number,
    detail: string
  ): void {
    disableAccount(account, "invalid_credentials", {
      statusCode,
      message: this.buildErrorPreview(detail, 500),
      accountLabel: account.label,
    })
    this.persistAccountStates()
  }

  private markAccountTemporaryFailure(
    account: ClaudeApiAccount,
    statusCode: number,
    model?: string,
    retryAfterHeader?: string
  ): void {
    if (isAccountDisabled(account)) {
      return
    }

    markAccountCooldown(
      account,
      statusCode,
      model,
      retryAfterHeader,
      account.label
    )
    this.persistAccountStates()
  }

  private markAccountHealthy(account: ClaudeApiAccount, model?: string): void {
    if (
      !isAccountDisabled(account) &&
      account.cooldownUntil <= 0 &&
      account.modelStates.size === 0
    ) {
      return
    }

    clearAccountDisablement(account)
    markAccountSuccess(account, model)
    this.persistAccountStates()
  }

  private buildHttpFailureError(
    account: ClaudeApiAccount,
    statusCode: number,
    detail: string,
    model?: string,
    retryAfterHeader?: string
  ): BackendApiError {
    const permanent = this.shouldDisableAccountPermanently(statusCode, detail)
    if (permanent) {
      this.disableAccountPermanently(account, statusCode, detail)
    } else {
      this.markAccountTemporaryFailure(
        account,
        statusCode,
        model,
        retryAfterHeader
      )
    }

    return new BackendApiError(
      `Claude API error ${statusCode}: ${this.buildErrorPreview(detail)}`,
      {
        backend: "claude-api",
        statusCode,
        permanent,
      }
    )
  }

  private buildTransientFailureError(
    account: ClaudeApiAccount,
    statusCode: number,
    message: string,
    model?: string
  ): BackendApiError {
    this.markAccountTemporaryFailure(account, statusCode, model)
    return new BackendApiError(message, {
      backend: "claude-api",
      statusCode,
    })
  }

  private async fetchWithResponseHeadersTimeout(
    url: string,
    options: RequestInit & { dispatcher?: unknown },
    timeoutMs: number,
    timeoutMessage: string,
    abortSignal?: AbortSignal
  ): Promise<Response> {
    const requestSignal = createAbortSignalWithTimeout(timeoutMs, abortSignal)

    try {
      return await fetch(url, { ...options, signal: requestSignal.signal })
    } catch (error) {
      if (requestSignal.didTimeout()) {
        throw new Error(timeoutMessage)
      }
      const abortedError = toUpstreamRequestAbortedError(
        error,
        abortSignal,
        "Claude API request aborted"
      )
      if (abortedError) {
        throw abortedError
      }
      throw error
    } finally {
      requestSignal.cleanup()
    }
  }

  private async readStreamChunkWithTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    timeoutMs: number,
    timeoutMessage: string,
    abortSignal?: AbortSignal
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    let timer: NodeJS.Timeout | undefined
    const externalAbort = createAbortPromise(
      abortSignal,
      "Claude API stream aborted"
    )

    try {
      return await Promise.race([
        reader.read(),
        ...(externalAbort.promise ? [externalAbort.promise] : []),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
        }),
      ])
    } catch (error) {
      const abortedError = toUpstreamRequestAbortedError(
        error,
        abortSignal,
        "Claude API stream aborted"
      )
      if (abortedError) {
        throw abortedError
      }
      throw error
    } finally {
      externalAbort.cleanup()
      if (timer) {
        clearTimeout(timer)
      }
    }
  }
}
