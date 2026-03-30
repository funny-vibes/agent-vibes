import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as crypto from "crypto"
import * as fs from "fs"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"
import type { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"
import type { AnthropicResponse } from "../../shared/anthropic"
import {
  getAccountConfigPathCandidates,
  resolveLegacyAccountStatePath as resolveLegacyAccountStateJsonPath,
  resolveRuntimeDataPath,
} from "../../shared/protocol-bridge-paths"
import {
  detectModelFamily,
  doesModelIdRequireExplicitThinkingSupport,
} from "../model-registry"
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
  BACKEND_ACCOUNT_STATE_DB_FILENAME,
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

export interface AnthropicForwardHeaders {
  [key: string]: string | undefined
}

interface ClaudeApiModelMapping {
  name: string
  alias?: string
}

interface ClaudeApiAccount extends CooldownableAccount {
  label?: string
  apiKey: string
  baseUrl: string
  proxyUrl?: string
  stripThinking: boolean
  prefix?: string
  headers?: Record<string, string>
  models: ClaudeApiModelMapping[]
  excludedModels: string[]
  priority: number
  source: "env" | "file"
  stateKey: string
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

@Injectable()
export class ClaudeApiService implements OnModuleInit {
  private readonly logger = new Logger(ClaudeApiService.name)

  private accounts: ClaudeApiAccount[] = []
  private accountIndex = 0
  private forceModelPrefix = false
  private accountsConfigPath: string | null = null
  private accountStatePath: string = resolveRuntimeDataPath(
    BACKEND_ACCOUNT_STATE_DB_FILENAME
  )
  private legacyAccountStatePath: string = resolveLegacyAccountStateJsonPath(
    "claude-api-account-state.json"
  )
  private accountStateStore = new BackendAccountStateStore(
    this.accountStatePath,
    this.logger
  )

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
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
        (entry) => entry.state === "ready" || entry.state === "degraded"
      ).length,
      ready: entries.filter((entry) => entry.state === "ready").length,
      degraded: entries.filter((entry) => entry.state === "degraded").length,
      cooling: entries.filter((entry) => entry.state === "cooldown").length,
      disabled: entries.filter((entry) => entry.state === "disabled").length,
      unavailable: 0,
      configPath: this.accountsConfigPath,
      statePath: this.accountStatePath,
      entries,
    }
  }

  supportsModel(model: string): boolean {
    return this.resolveCandidates(model).some(
      (candidate) => !isAccountDisabled(candidate.account)
    )
  }

  getPublicModelIds(): string[] {
    const ids = new Set<string>()

    for (const account of this.accounts) {
      if (isAccountDisabled(account)) {
        continue
      }

      if (account.models.length > 0) {
        for (const mapping of account.models) {
          for (const publicId of this.buildVisibleModelIdsForAccount(
            account,
            mapping.alias || mapping.name
          )) {
            if (
              !this.isModelExcluded(account, publicId) &&
              this.isPublicModelIdCompatibleWithAccount(account, publicId)
            ) {
              ids.add(publicId)
            }
          }
        }
        continue
      }

      for (const modelId of DEFAULT_PUBLIC_CLAUDE_MODEL_IDS) {
        for (const publicId of this.buildVisibleModelIdsForAccount(
          account,
          modelId
        )) {
          if (
            !this.isModelExcluded(account, publicId) &&
            this.isPublicModelIdCompatibleWithAccount(account, publicId)
          ) {
            ids.add(publicId)
          }
        }
      }
    }

    return Array.from(ids).sort()
  }

  async sendClaudeMessage(
    dto: CreateMessageDto,
    forwardHeaders: AnthropicForwardHeaders = {}
  ): Promise<AnthropicResponse> {
    return this.executeWithCooldownRetry(dto, forwardHeaders, new Set())
  }

  async *sendClaudeMessageStream(
    dto: CreateMessageDto,
    forwardHeaders: AnthropicForwardHeaders = {}
  ): AsyncGenerator<string, void, unknown> {
    yield* this.executeStreamWithCooldownRetry(dto, forwardHeaders, new Set())
  }

  private async executeWithCooldownRetry(
    dto: CreateMessageDto,
    forwardHeaders: AnthropicForwardHeaders,
    attemptedCandidates: Set<string>,
    candidate: ClaudeApiCandidate = this.nextCandidate(dto.model)
  ): Promise<AnthropicResponse> {
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
        throw this.buildTransientFailureError(
          candidate.account,
          504,
          error instanceof Error ? error.message : String(error),
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
    candidate: ClaudeApiCandidate = this.nextCandidate(dto.model)
  ): AsyncGenerator<string, void, unknown> {
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
          15_000,
          "Claude API stream timed out waiting for upstream response headers after 15000ms"
        )
      } catch (error) {
        throw this.buildTransientFailureError(
          candidate.account,
          504,
          error instanceof Error ? error.message : String(error),
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

      try {
        while (true) {
          const { done, value } = await this.readStreamChunkWithTimeout(
            reader,
            60_000,
            "Claude API stream timed out while waiting for the next SSE chunk"
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
            yield chunk.endsWith("\n\n") ? chunk : `${chunk}\n\n`
            boundary = buffer.indexOf("\n\n")
          }
        }

        const trailing = buffer.trim()
        if (trailing) {
          emittedEvents = true
          yield trailing.endsWith("\n\n") ? trailing : `${trailing}\n\n`
        }

        this.markAccountHealthy(candidate.account, candidate.upstreamModel)
        return
      } catch (error) {
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
      return "degraded"
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

  private resolveAccountStateDbPath(configPath?: string | null): string {
    return resolveRuntimeDataPath(BACKEND_ACCOUNT_STATE_DB_FILENAME, configPath)
  }

  private resolveLegacyAccountStatePath(configPath?: string | null): string {
    return resolveLegacyAccountStateJsonPath(
      "claude-api-account-state.json",
      configPath
    )
  }

  private configureAccountStateStore(configPath?: string | null): void {
    this.accountStatePath = this.resolveAccountStateDbPath(configPath)
    this.legacyAccountStatePath = this.resolveLegacyAccountStatePath(configPath)
    this.accountStateStore = new BackendAccountStateStore(
      this.accountStatePath,
      this.logger
    )
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
      cooldownUntil: 0,
      modelStates: new Map(),
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
    return this.accountStateStore.loadStates(
      "claude-api",
      this.legacyAccountStatePath
    )
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

      if (account.models.length > 0) {
        for (const mapping of account.models) {
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

          candidates.push({
            account,
            upstreamModel: mapping.name.trim(),
            publicModelId,
          })
        }
        continue
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
    const raw = JSON.parse(JSON.stringify(dto)) as Record<string, unknown>
    const betas = this.normalizeBetas(raw.betas)

    delete raw.betas
    delete raw._conversationId
    delete raw._contextTokenBudget
    delete raw._pendingToolUseIds

    raw.model = candidate.upstreamModel
    if (candidate.account.stripThinking) {
      delete raw.thinking
      delete raw.output_config
    }

    return {
      body: raw,
      betas,
    }
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

    if (betas.length > 0) {
      const existing = headers["anthropic-beta"]
        ? headers["anthropic-beta"]
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : []
      const merged = new Set([...existing, ...betas])
      headers["anthropic-beta"] = Array.from(merged).join(",")
    }

    if (account.headers) {
      for (const [key, value] of Object.entries(account.headers)) {
        headers[key.toLowerCase()] = value
      }
    }

    if (this.isOfficialAnthropicBase(account.baseUrl)) {
      delete headers.authorization
      headers["x-api-key"] = account.apiKey
    } else {
      delete headers["x-api-key"]
      headers.authorization = `Bearer ${account.apiKey}`
    }

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
        `Failed to parse proxy URL ${proxyUrl}: ${error instanceof Error ? error.message : String(error)}`
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
    timeoutMessage: string
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      return await fetch(url, { ...options, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(timeoutMessage)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private async readStreamChunkWithTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    let timer: NodeJS.Timeout | undefined

    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
        }),
      ])
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }
}
