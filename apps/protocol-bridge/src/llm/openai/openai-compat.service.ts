/**
 * OpenAI-Compatible Backend Service
 *
 * Translates Claude/Anthropic Messages API requests into standard OpenAI
 * Chat Completions API format for forwarding to third-party providers
 * (e.g. one-api, new-api, or any OpenAI-compatible endpoint).
 *
 * Unlike CodexService which targets chatgpt.com's proprietary Responses API,
 * this service uses the standard /chat/completions endpoint with simple
 * Bearer token authentication.
 */

import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as crypto from "crypto"
import * as fs from "fs"
import type { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"
import type { AnthropicResponse, ContentBlock } from "../../shared/anthropic"
import { getAccountConfigPathCandidates } from "../../shared/protocol-bridge-paths"
import { PersistenceService } from "../../persistence"
import { UsageStatsService } from "../../usage"
import { translateClaudeToCodex } from "./codex-request-translator"
import { resolveThinkingIntentFromDto } from "../shared/thinking-intent"
import {
  createStreamState as createCodexStreamState,
  translateCodexSseEvent,
  translateCodexToClaudeNonStream,
} from "./codex-response-translator"
import { buildReverseMapFromClaudeTools } from "./tool-name-shortener"
import {
  type CooldownableAccount,
  clearAccountDisablement,
  disableAccount,
  isAccountAvailableForModel,
  isAccountDisabled,
  getEarliestRecovery,
  markAccountCooldown,
  markAccountSuccess,
  pickAvailableAccount,
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
import { sanitizeOpenAiChatToolCallIntegrity } from "../shared/openai-tool-call-integrity"

// ── Types for OpenAI Chat Completions API ──────────────────────────────

interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool"
  content?:
    | string
    | Array<{ type: string; text?: string; image_url?: { url: string } }>
  name?: string
  tool_calls?: ChatCompletionToolCall[]
  tool_call_id?: string
}

interface ChatCompletionToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

interface ChatCompletionTool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

interface ChatCompletionRequest {
  model: string
  messages: ChatCompletionMessage[]
  tools?: ChatCompletionTool[]
  tool_choice?: string | Record<string, unknown>
  stream: boolean
  max_tokens?: number
  temperature?: number
  top_p?: number
  reasoning?: { effort: string }
  reasoning_effort?: string
  [key: string]: unknown
}

function supportsOpenAiCompatReasoning(modelName: string): boolean {
  const normalized = modelName.toLowerCase().trim()
  return (
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4") ||
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("codex")
  )
}

function normalizeOpenAiCompatReasoningEffort(effort: string): string {
  const normalized = effort.toLowerCase().trim()

  switch (normalized) {
    case "none":
      return "none"
    case "minimal":
      return "low"
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return normalized
    case "max":
    case "auto":
      return "xhigh"
    default:
      return "medium"
  }
}

function convertOpenAiCompatBudgetToEffort(budgetTokens: number): string {
  if (budgetTokens < 0) return normalizeOpenAiCompatReasoningEffort("auto")
  if (budgetTokens === 0) return normalizeOpenAiCompatReasoningEffort("none")
  if (budgetTokens <= 512)
    return normalizeOpenAiCompatReasoningEffort("minimal")
  if (budgetTokens <= 1024) return "low"
  if (budgetTokens <= 8192) return "medium"
  if (budgetTokens <= 24576) return "high"
  return "xhigh"
}

function resolveOpenAiCompatReasoningEffort(dto: CreateMessageDto): string {
  const intent = resolveThinkingIntentFromDto(dto)
  if (!intent) {
    return "medium"
  }

  switch (intent.mode) {
    case "explicit_effort":
      return normalizeOpenAiCompatReasoningEffort(intent.effort)
    case "explicit_budget":
      return convertOpenAiCompatBudgetToEffort(intent.budgetTokens)
    case "disabled":
      return normalizeOpenAiCompatReasoningEffort("none")
    case "adaptive":
      return normalizeOpenAiCompatReasoningEffort(intent.effort ?? "auto")
    default:
      return "medium"
  }
}

const THINKING_OPEN_TAG = "<thinking>"
const THINKING_CLOSE_TAG = "</thinking>"

interface LeadingThinkingTaggedText {
  thinking: string
  remainder: string
}

export interface ThinkingTagStreamState {
  inThinking: boolean
  pending: string
}

export type ThinkingTagStreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "thinking_end" }

export function createThinkingTagStreamState(): ThinkingTagStreamState {
  return {
    inThinking: false,
    pending: "",
  }
}

function longestTagPrefixSuffix(text: string, tags: string[]): number {
  const maxLen = Math.min(
    text.length,
    Math.max(...tags.map((tag) => tag.length - 1), 0)
  )

  for (let len = maxLen; len > 0; len--) {
    const suffix = text.slice(-len)
    if (tags.some((tag) => tag.startsWith(suffix))) {
      return len
    }
  }

  return 0
}

export function consumeThinkingTagTextDelta(
  state: ThinkingTagStreamState,
  delta: string
): ThinkingTagStreamEvent[] {
  if (!delta) return []

  const events: ThinkingTagStreamEvent[] = []
  let remaining = state.pending + delta
  state.pending = ""

  while (remaining.length > 0) {
    if (state.inThinking) {
      const closeIdx = remaining.indexOf(THINKING_CLOSE_TAG)
      if (closeIdx === -1) {
        const pendingLen = longestTagPrefixSuffix(remaining, [
          THINKING_CLOSE_TAG,
        ])
        const thinkingText = remaining.slice(0, remaining.length - pendingLen)
        if (thinkingText) {
          events.push({ type: "thinking", text: thinkingText })
        }
        state.pending = remaining.slice(remaining.length - pendingLen)
        return events
      }

      const thinkingText = remaining.slice(0, closeIdx)
      if (thinkingText) {
        events.push({ type: "thinking", text: thinkingText })
      }
      events.push({ type: "thinking_end" })
      state.inThinking = false
      remaining = remaining.slice(closeIdx + THINKING_CLOSE_TAG.length)
      continue
    }

    const openIdx = remaining.indexOf(THINKING_OPEN_TAG)
    if (openIdx === -1) {
      const pendingLen = longestTagPrefixSuffix(remaining, [THINKING_OPEN_TAG])
      const text = remaining.slice(0, remaining.length - pendingLen)
      if (text) {
        events.push({ type: "text", text })
      }
      state.pending = remaining.slice(remaining.length - pendingLen)
      return events
    }

    const text = remaining.slice(0, openIdx)
    if (text) {
      events.push({ type: "text", text })
    }
    state.inThinking = true
    remaining = remaining.slice(openIdx + THINKING_OPEN_TAG.length)
  }

  return events
}

export function flushThinkingTagTextDelta(
  state: ThinkingTagStreamState
): ThinkingTagStreamEvent[] {
  if (!state.pending) return []

  const pending = state.pending
  state.pending = ""
  return state.inThinking
    ? [{ type: "thinking", text: pending }]
    : [{ type: "text", text: pending }]
}

function extractLeadingThinkingTaggedText(
  text: string
): LeadingThinkingTaggedText | null {
  if (!text.startsWith(THINKING_OPEN_TAG)) {
    return null
  }

  const closeIdx = text.indexOf(THINKING_CLOSE_TAG, THINKING_OPEN_TAG.length)
  if (closeIdx === -1) {
    return null
  }

  return {
    thinking: text.slice(THINKING_OPEN_TAG.length, closeIdx),
    remainder: text.slice(closeIdx + THINKING_CLOSE_TAG.length),
  }
}

function stripLeadingThinkingTaggedText(text: string): string {
  return extractLeadingThinkingTaggedText(text)?.remainder ?? text
}

export function splitThinkingTaggedText(text: string): ContentBlock[] {
  if (!text) return []

  const blocks: ContentBlock[] = []
  const leadingTaggedText = extractLeadingThinkingTaggedText(text)

  if (!leadingTaggedText) {
    return [{ type: "text", text }]
  }

  if (leadingTaggedText.thinking) {
    blocks.push({ type: "thinking", thinking: leadingTaggedText.thinking })
  }
  if (leadingTaggedText.remainder) {
    blocks.push({ type: "text", text: leadingTaggedText.remainder })
  }

  return blocks
}

function extractReasoningText(reasoning: unknown): string | null {
  if (typeof reasoning === "string" && reasoning) {
    return reasoning
  }

  if (
    reasoning &&
    typeof reasoning === "object" &&
    typeof (reasoning as Record<string, unknown>).content === "string"
  ) {
    return (reasoning as Record<string, unknown>).content as string
  }

  return null
}

// ── Streaming state ────────────────────────────────────────────────────

type LeadingTaggedContentState = "plain" | "detecting" | "suppressing"

interface StreamState {
  blockIndex: number
  hasToolCall: boolean
  activeToolCalls: Map<number, { id: string; name: string; arguments: string }>
  responseId: string
  model: string
  messageStartEmitted: boolean
  thinkingBlockActive: boolean
  textBlockActive: boolean
  contentStarted: boolean
  explicitReasoningSeen: boolean
  leadingTaggedContentState: LeadingTaggedContentState
  leadingTaggedContentBuffer: string
  thinkingTagState: ThinkingTagStreamState
  lastInputTokens: number
  lastCachedInputTokens: number
  lastOutputTokens: number
}

export function createStreamState(): StreamState {
  return {
    blockIndex: 0,
    hasToolCall: false,
    activeToolCalls: new Map(),
    responseId: "",
    model: "",
    messageStartEmitted: false,
    thinkingBlockActive: false,
    textBlockActive: false,
    contentStarted: false,
    explicitReasoningSeen: false,
    leadingTaggedContentState: "plain",
    leadingTaggedContentBuffer: "",
    thinkingTagState: createThinkingTagStreamState(),
    lastInputTokens: 0,
    lastCachedInputTokens: 0,
    lastOutputTokens: 0,
  }
}

// ── SSE helpers ────────────────────────────────────────────────────────

function formatSseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// ── Service ────────────────────────────────────────────────────────────

interface OpenaiCompatAccount extends CooldownableAccount {
  label?: string
  apiKey: string
  baseUrl: string
  proxyUrl?: string
  preferResponsesApi?: boolean
  maxContextTokens?: number
  source: "env" | "file"
  stateKey: string
}

type PersistedOpenaiCompatAccountState = PersistedBackendAccountState

interface OpenaiCompatAccountFileEntry {
  label?: string
  apiKey?: string
  baseUrl?: string
  proxyUrl?: string
  preferResponsesApi?: boolean
  maxContextTokens?: number
}

interface OpenaiCompatConfigFile {
  accounts?: OpenaiCompatAccountFileEntry[]
}

@Injectable()
export class OpenaiCompatService implements OnModuleInit {
  private readonly logger = new Logger(OpenaiCompatService.name)

  /** All loaded accounts (round-robin pool) */
  private accounts: OpenaiCompatAccount[] = []
  /** Round-robin counter */
  private accountIndex = 0
  /** Resolved config file path used to load file-backed accounts */
  private accountsConfigPath: string | null = null
  /** Runtime account health state persistence */
  private accountStateStore!: BackendAccountStateStore

  /**
   * Responses API routing mode:
   * - "auto": Try Chat Completions first, fallback to Responses API on 503/provider errors (default)
   * - "always": Always use Responses API for reasoning models
   * - "never": Only use Chat Completions
   */
  private responsesApiMode: "auto" | "always" | "never" = "auto"

  /**
   * Per-model endpoint preference cache.
   * When auto mode detects a 503 on Chat Completions and succeeds with Responses API,
   * it remembers this for subsequent requests to avoid repeated fallback overhead.
   * Explicit per-account overrides are not learned into this cache.
   * Key: model name (lowercase), Value: "responses" | "chat-completions"
   */
  private endpointPreference = new Map<
    string,
    "responses" | "chat-completions"
  >()

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

  private buildAccountStateKey(apiKey: string, baseUrl: string): string {
    return crypto
      .createHash("sha256")
      .update(baseUrl)
      .update("\0")
      .update(apiKey)
      .digest("hex")
  }

  private configureAccountStateStore(_configPath?: string | null): void {
    // No-op: PersistenceService handles the unified DB path.
  }

  private normalizeMaxContextTokens(value: unknown): number | undefined {
    const parsed =
      typeof value === "string" ? Number.parseInt(value.trim(), 10) : value
    if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
      return undefined
    }

    return Math.floor(parsed)
  }

  private buildAccountRecord(params: {
    label?: string
    apiKey: string
    baseUrl: string
    proxyUrl?: string
    preferResponsesApi?: boolean
    maxContextTokens?: number
    source: "env" | "file"
  }): OpenaiCompatAccount {
    return {
      label: params.label,
      apiKey: params.apiKey,
      baseUrl: params.baseUrl,
      proxyUrl: params.proxyUrl,
      preferResponsesApi: params.preferResponsesApi,
      maxContextTokens: this.normalizeMaxContextTokens(params.maxContextTokens),
      source: params.source,
      stateKey: this.buildAccountStateKey(params.apiKey, params.baseUrl),
      cooldownUntil: 0,
      modelStates: new Map(),
    }
  }

  private pruneAccountState(
    account: OpenaiCompatAccount,
    now: number = Date.now()
  ): void {
    if (!isAccountDisabled(account) && account.cooldownUntil > 0) {
      if (account.cooldownUntil <= now) {
        account.cooldownUntil = 0
      }
    }

    for (const [model, modelState] of account.modelStates.entries()) {
      if (modelState.cooldownUntil <= now) {
        account.modelStates.delete(model)
      }
    }
  }

  private loadPersistedAccountStates(): Map<
    string,
    PersistedOpenaiCompatAccountState
  > {
    return this.accountStateStore.loadStates("openai-compat")
  }

  private applyPersistedAccountState(
    account: OpenaiCompatAccount,
    state?: PersistedOpenaiCompatAccountState
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
      this.logger.warn(
        `[OpenAI-Compat] Restored permanently disabled account ${account.label || "unnamed"} (${account.baseUrl})`
      )
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

    this.pruneAccountState(account, now)
  }

  private hasPersistableAccountState(account: OpenaiCompatAccount): boolean {
    this.pruneAccountState(account)
    return (
      isAccountDisabled(account) ||
      account.cooldownUntil > 0 ||
      account.modelStates.size > 0
    )
  }

  private serializeAccountState(
    account: OpenaiCompatAccount
  ): PersistedOpenaiCompatAccountState | null {
    this.pruneAccountState(account)

    if (!this.hasPersistableAccountState(account)) {
      return null
    }

    const record: PersistedOpenaiCompatAccountState = {
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
      "openai-compat",
      this.accounts
        .map((account) => this.serializeAccountState(account))
        .filter(
          (account): account is PersistedOpenaiCompatAccountState =>
            account != null
        )
    )
  }

  private buildErrorPreview(detail: string, maxLength: number = 200): string {
    return detail.length > maxLength ? detail.slice(0, maxLength) : detail
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
    return /invalid[_ -]?api[_ -]?key|api key.*(?:invalid|deleted|disabled|expired|not exist)|provided api key|invalid credentials|authentication|unauthorized|credential/.test(
      normalized
    )
  }

  private disableAccountPermanently(
    account: OpenaiCompatAccount,
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
    account: OpenaiCompatAccount,
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

  private markAccountHealthy(
    account: OpenaiCompatAccount,
    model?: string
  ): void {
    if (!this.hasPersistableAccountState(account)) {
      return
    }

    clearAccountDisablement(account)
    markAccountSuccess(account, model)
    this.persistAccountStates()
  }

  private buildHttpFailureError(
    account: OpenaiCompatAccount,
    statusCode: number,
    detail: string,
    model?: string,
    retryAfterHeader?: string,
    suppressTemporaryState: boolean = false
  ): BackendApiError {
    const permanent = this.shouldDisableAccountPermanently(statusCode, detail)
    if (permanent) {
      this.disableAccountPermanently(account, statusCode, detail)
    } else if (!suppressTemporaryState) {
      this.markAccountTemporaryFailure(
        account,
        statusCode,
        model,
        retryAfterHeader
      )
    }

    return new BackendApiError(
      `OpenAI-compatible API error ${statusCode}: ${this.buildErrorPreview(detail)}`,
      {
        backend: "openai-compat",
        statusCode,
        permanent,
      }
    )
  }

  private buildTransientFailureError(
    account: OpenaiCompatAccount,
    statusCode: number,
    message: string,
    model?: string
  ): BackendApiError {
    this.markAccountTemporaryFailure(account, statusCode, model)
    return new BackendApiError(message, {
      backend: "openai-compat",
      statusCode,
    })
  }

  private parsePositiveTimeoutMs(envName: string, fallbackMs: number): number {
    const raw = this.configService.get<string>(envName, "").trim()
    if (!raw) return fallbackMs

    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs
  }

  private getStreamResponseHeadersTimeoutMs(): number {
    return this.parsePositiveTimeoutMs(
      "OPENAI_COMPAT_STREAM_HEADERS_TIMEOUT_MS",
      60_000
    )
  }

  private getStreamFirstChunkTimeoutMs(): number {
    return this.parsePositiveTimeoutMs(
      "OPENAI_COMPAT_STREAM_FIRST_CHUNK_TIMEOUT_MS",
      15_000
    )
  }

  private getStreamIdleTimeoutMs(): number {
    return this.parsePositiveTimeoutMs(
      "OPENAI_COMPAT_STREAM_IDLE_TIMEOUT_MS",
      60_000
    )
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
        "OpenAI-compatible request aborted"
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
      "OpenAI-compatible stream aborted"
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
        "OpenAI-compatible stream aborted"
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

  onModuleInit() {
    // 1. Load from JSON file (all accounts)
    const fileAccounts = this.loadAllAccountsFromFile()
    if (fileAccounts.length > 0) {
      this.accounts = fileAccounts
    }

    // 2. Env vars as fallback / additional account
    const envApiKey = this.configService
      .get<string>("OPENAI_COMPAT_API_KEY", "")
      .trim()
    const envBaseUrl = this.configService
      .get<string>("OPENAI_COMPAT_BASE_URL", "")
      .trim()
    const envProxyUrl = this.configService
      .get<string>("OPENAI_COMPAT_PROXY_URL", "")
      .trim()
    const envMaxContextTokens = this.normalizeMaxContextTokens(
      this.configService.get<number>("OPENAI_COMPAT_MAX_CONTEXT_TOKENS")
    )

    if (envApiKey && envBaseUrl) {
      // Only add env account if it's not already in the list
      const alreadyExists = this.accounts.some(
        (a) => a.apiKey === envApiKey && a.baseUrl === envBaseUrl
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

    // Responses API routing mode
    const responsesApiEnv = this.configService
      .get<string>("OPENAI_COMPAT_USE_RESPONSES_API", "")
      .trim()
      .toLowerCase()
    if (
      responsesApiEnv === "always" ||
      responsesApiEnv === "true" ||
      responsesApiEnv === "1"
    ) {
      this.responsesApiMode = "always"
    } else if (
      responsesApiEnv === "never" ||
      responsesApiEnv === "false" ||
      responsesApiEnv === "0"
    ) {
      this.responsesApiMode = "never"
    } else {
      this.responsesApiMode = "auto"
    }

    this.logger.log(
      `OpenAI-compatible backend initialized: ${this.accounts.length} account(s), ` +
        `responsesApiMode=${this.responsesApiMode}`
    )
    for (const acct of this.accounts) {
      const stateSummary = isAccountDisabled(acct)
        ? `disabled (${acct.disabledReason || "permanent"})`
        : this.hasPersistableAccountState(acct)
          ? "cooldown"
          : "ready"
      this.logger.log(
        `  → ${acct.label || "unnamed"} [${acct.source}]: ${acct.baseUrl} (key: ${acct.apiKey.substring(0, 8)}..., state=${stateSummary})`
      )
    }
    if (this.accounts.length === 0) {
      this.logger.log(
        "No OpenAI-compatible credentials configured. " +
          "Add entries to data/openai-compat-accounts.json to enable."
      )
    }
  }

  /**
   * Load all accounts from openai-compat-accounts.json.
   */
  private loadAllAccountsFromFile(): OpenaiCompatAccount[] {
    const configPaths = getAccountConfigPathCandidates(
      "openai-compat-accounts.json"
    )

    for (const configPath of configPaths) {
      if (!fs.existsSync(configPath)) continue

      try {
        const data = JSON.parse(
          fs.readFileSync(configPath, "utf-8")
        ) as OpenaiCompatConfigFile
        if (Array.isArray(data.accounts) && data.accounts.length > 0) {
          this.accountsConfigPath = configPath
          this.configureAccountStateStore(configPath)
          this.logger.log(
            `Loaded ${data.accounts.length} OpenAI-compat account(s) from ${configPath}`
          )
          return data.accounts
            .filter(
              (
                a
              ): a is OpenaiCompatAccountFileEntry & {
                apiKey: string
                baseUrl: string
              } =>
                typeof a.apiKey === "string" &&
                !!a.apiKey &&
                typeof a.baseUrl === "string" &&
                !!a.baseUrl
            )
            .map((a) =>
              this.buildAccountRecord({
                label: a.label,
                apiKey: a.apiKey,
                baseUrl: a.baseUrl,
                proxyUrl: a.proxyUrl,
                preferResponsesApi: a.preferResponsesApi === true,
                maxContextTokens: a.maxContextTokens,
                source: "file",
              })
            )
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
   * Round-robin: pick the next available account, respecting cooldowns.
   * Skips permanently disabled accounts and throws a typed error when no account is usable.
   */
  private nextAccount(model?: string): OpenaiCompatAccount {
    const targetModel = model || ""
    const result = pickAvailableAccount(
      this.accounts,
      targetModel,
      this.accountIndex
    )
    if (result) {
      this.accountIndex = (result.index + 1) % this.accounts.length
      return result.account
    }

    const disabledCount = this.accounts.filter((account) =>
      isAccountDisabled(account)
    ).length
    const coolingCount = this.accounts.length - disabledCount
    const info = targetModel
      ? getEarliestRecovery(this.accounts, targetModel)
      : getEarliestRecovery(this.accounts, "")

    if (info) {
      const retrySeconds = Math.ceil(info.retryAfterMs / 1000)
      throw new BackendAccountPoolUnavailableError(
        `All OpenAI-compat accounts are unavailable for model ${targetModel || "unknown"} ` +
          `(${disabledCount} disabled, ${coolingCount} cooling down). ` +
          `Retry after ${retrySeconds} seconds.`,
        {
          backend: "openai-compat",
          retryAfterSeconds: retrySeconds,
          disabledCount,
          coolingCount,
        }
      )
    }

    throw new BackendAccountPoolUnavailableError(
      `All OpenAI-compat accounts are permanently disabled for model ${targetModel || "unknown"}.`,
      {
        backend: "openai-compat",
        disabledCount,
        coolingCount: 0,
        permanent: true,
      }
    )
  }

  /**
   * Check if the backend is available (has at least one account configured).
   */
  isAvailable(): boolean {
    return this.accounts.some((account) => !isAccountDisabled(account))
  }

  getConfiguredMaxContextTokens(model?: string): number | undefined {
    let resolved: number | undefined

    for (const account of this.accounts) {
      if (isAccountDisabled(account)) {
        continue
      }
      if (model && !isAccountAvailableForModel(account, model)) {
        continue
      }

      const limit = this.normalizeMaxContextTokens(account.maxContextTokens)
      if (limit === undefined) {
        continue
      }
      resolved = resolved === undefined ? limit : Math.min(resolved, limit)
    }

    return resolved
  }

  /**
   * Hot-reload accounts from config file.
   * Adds new accounts and patches mutable config without disturbing existing
   * account state (cooldown, disabled, etc.).
   * Returns the number of account changes.
   */
  reloadAccounts(): number {
    const freshAccounts = this.loadAllAccountsFromFile()
    const existingByKey = new Map(this.accounts.map((a) => [a.stateKey, a]))
    const persistedStates = this.loadPersistedAccountStates()
    let changedCount = 0

    for (const account of freshAccounts) {
      const existing = existingByKey.get(account.stateKey)
      if (!existing) {
        this.applyPersistedAccountState(
          account,
          persistedStates.get(account.stateKey)
        )
        this.accounts.push(account)
        changedCount++
        this.logger.log(
          `[Hot-reload] Added new OpenAI-compat account: ${account.label || account.baseUrl}`
        )
        continue
      }

      let changed = false
      if (existing.label !== account.label) {
        existing.label = account.label
        changed = true
      }
      if (existing.proxyUrl !== account.proxyUrl) {
        existing.proxyUrl = account.proxyUrl
        changed = true
      }
      if (existing.preferResponsesApi !== account.preferResponsesApi) {
        existing.preferResponsesApi = account.preferResponsesApi
        changed = true
      }
      if (existing.maxContextTokens !== account.maxContextTokens) {
        existing.maxContextTokens = account.maxContextTokens
        changed = true
      }

      if (changed) {
        changedCount++
        this.logger.log(
          `[Hot-reload] Updated OpenAI-compat account: ${existing.label || existing.baseUrl}`
        )
      }
    }

    if (changedCount > 0) {
      this.persistAccountStates()
      this.logger.log(
        `[Hot-reload] OpenAI-compat: ${changedCount} account change(s), total=${this.accounts.length}`
      )
    }

    return changedCount
  }

  /**
   * Check if the backend is reachable.
   */
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
        label: account.label || account.baseUrl,
        state,
        cooldownUntil: account.cooldownUntil,
        disabledAt: account.disabledAt,
        disabledReason: account.disabledReason,
        source: account.source,
        baseUrl: account.baseUrl,
        proxyUrl: account.proxyUrl,
        maxContextTokens: account.maxContextTokens,
        modelCooldowns,
      }
    })

    return {
      backend: "openai-compat",
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

  // ── Proxy agent ──────────────────────────────────────────────────────

  private buildProxyAgentForAccount(
    account: OpenaiCompatAccount
  ): import("undici").ProxyAgent | undefined {
    if (!account.proxyUrl) return undefined

    try {
      new URL(account.proxyUrl)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ProxyAgent } = require("undici") as typeof import("undici")
      return new ProxyAgent(account.proxyUrl)
    } catch (e) {
      this.logger.error(`Failed to create proxy agent: ${(e as Error).message}`)
      return undefined
    }
  }

  private getActiveModelCooldowns(
    account: OpenaiCompatAccount,
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
    account: OpenaiCompatAccount,
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

  private recordOpenAiCompatUsage(
    account: OpenaiCompatAccount,
    modelName: string,
    transport: string,
    usage: {
      inputTokens: number
      cachedInputTokens?: number
      cacheCreationInputTokens?: number
      outputTokens: number
      webSearchRequests?: number
      durationMs?: number
    }
  ): void {
    this.usageStats.recordOpenAiCompatUsage({
      transport,
      modelName,
      accountKey: account.stateKey,
      accountLabel: account.label || account.baseUrl,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      outputTokens: usage.outputTokens,
      webSearchRequests: usage.webSearchRequests,
      durationMs: usage.durationMs,
    })
  }

  private extractChatCompletionUsage(completion: Record<string, unknown>): {
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
  } {
    const usage = completion.usage as Record<string, unknown> | undefined
    const totalInputTokens = this.toWholeNumber(usage?.prompt_tokens)
    const cachedInputTokens = this.toWholeNumber(
      usage?.prompt_tokens_details &&
        typeof usage.prompt_tokens_details === "object"
        ? (usage.prompt_tokens_details as Record<string, unknown>).cached_tokens
        : 0
    )
    return {
      inputTokens: Math.max(0, totalInputTokens - cachedInputTokens),
      cachedInputTokens,
      outputTokens: this.toWholeNumber(usage?.completion_tokens),
    }
  }

  private extractResponsesUsage(event: Record<string, unknown>): {
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
  } {
    const response =
      event.response && typeof event.response === "object"
        ? (event.response as Record<string, unknown>)
        : null
    const usage =
      response?.usage && typeof response.usage === "object"
        ? (response.usage as Record<string, unknown>)
        : null
    const totalInputTokens = this.toWholeNumber(usage?.input_tokens)
    const cachedInputTokens = this.toWholeNumber(
      usage?.input_tokens_details &&
        typeof usage.input_tokens_details === "object"
        ? (usage.input_tokens_details as Record<string, unknown>).cached_tokens
        : 0
    )

    return {
      inputTokens: Math.max(0, totalInputTokens - cachedInputTokens),
      cachedInputTokens,
      outputTokens: this.toWholeNumber(usage?.output_tokens),
    }
  }

  private toWholeNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.round(value))
      : 0
  }

  // ── Request translation ──────────────────────────────────────────────

  /**
   * Translate Claude/Anthropic DTO → OpenAI Chat Completions request body.
   */
  private translateRequest(
    dto: CreateMessageDto,
    stream: boolean
  ): ChatCompletionRequest {
    const messages: ChatCompletionMessage[] = []

    // System prompt
    if (dto.system) {
      let systemText: string
      if (typeof dto.system === "string") {
        systemText = dto.system
      } else if (Array.isArray(dto.system)) {
        systemText = dto.system
          .filter(
            (block): block is { type: string; text: string } =>
              typeof block === "object" &&
              block !== null &&
              block.type === "text"
          )
          .map((block) => block.text)
          .join("\n")
      } else {
        systemText = ""
      }
      if (systemText.trim()) {
        messages.push({ role: "system", content: systemText })
      }
    }

    // Messages
    for (const msg of dto.messages) {
      const role = msg.role as "user" | "assistant"

      if (typeof msg.content === "string") {
        messages.push({ role, content: msg.content })
        continue
      }

      if (!Array.isArray(msg.content)) {
        messages.push({ role, content: "" })
        continue
      }

      const blocks = msg.content as Array<{
        type?: string
        text?: string
        id?: string
        name?: string
        input?: unknown
        tool_use_id?: string
        content?: string | Array<{ type: string; text?: string }>
        source?: {
          data?: string
          base64?: string
          media_type?: string
          mime_type?: string
        }
      }>

      // Separate text/image, tool_use, and tool_result blocks
      const textParts: string[] = []
      const imageParts: Array<{ type: string; image_url: { url: string } }> = []
      const toolCalls: ChatCompletionToolCall[] = []
      const toolResults: ChatCompletionMessage[] = []

      for (const block of blocks) {
        switch (block.type) {
          case "text":
            if (block.text) textParts.push(block.text)
            break

          case "image": {
            const source = block.source
            if (source) {
              const data = source.data || source.base64
              if (data) {
                const mediaType =
                  source.media_type || source.mime_type || "image/png"
                // Use OpenAI vision format with data URI
                imageParts.push({
                  type: "image_url",
                  image_url: {
                    url: `data:${mediaType};base64,${data}`,
                  },
                })
              }
            }
            break
          }

          case "tool_use":
            toolCalls.push({
              id: block.id || `call_${crypto.randomUUID()}`,
              type: "function",
              function: {
                name: block.name || "",
                arguments:
                  typeof block.input === "string"
                    ? block.input
                    : JSON.stringify(block.input || {}),
              },
            })
            break

          case "tool_result": {
            let resultContent = ""
            if (typeof block.content === "string") {
              resultContent = block.content
            } else if (Array.isArray(block.content)) {
              resultContent = block.content
                .filter((p) => p.type === "text" && p.text)
                .map((p) => p.text)
                .join("\n")
            }
            toolResults.push({
              role: "tool",
              tool_call_id: block.tool_use_id || "",
              content: resultContent,
            })
            break
          }

          default:
            if (block.text) textParts.push(block.text)
            break
        }
      }

      // Emit assistant message with tool_calls (if any)
      if (role === "assistant" && toolCalls.length > 0) {
        const assistantMsg: ChatCompletionMessage = {
          role: "assistant",
          tool_calls: toolCalls,
        }
        if (textParts.length > 0) {
          assistantMsg.content = textParts.join("\n")
        }
        messages.push(assistantMsg)
      } else if (imageParts.length > 0) {
        // Multimodal content: text + images in OpenAI vision format
        const contentArray: Array<{
          type: string
          text?: string
          image_url?: { url: string }
        }> = []
        if (textParts.length > 0) {
          contentArray.push({ type: "text", text: textParts.join("\n") })
        }
        contentArray.push(...imageParts)
        messages.push({ role, content: contentArray })
      } else if (textParts.length > 0) {
        messages.push({ role, content: textParts.join("\n") })
      } else if (role === "assistant") {
        // Empty assistant message (no text, no tool calls)
        messages.push({ role, content: "" })
      }

      // Emit tool results as separate messages
      for (const toolResult of toolResults) {
        messages.push(toolResult)
      }
    }

    // ── Integrity check: strip orphan tool_calls ─────────────────────
    // Context truncation may drop tool_result messages while keeping the
    // corresponding assistant tool_calls block. OpenAI API requires every
    // tool_call to have a matching tool response. Strip orphan tool_calls
    // and orphan tool responses to prevent 400 errors.
    this.sanitizeToolCallIntegrity(messages, dto._pendingToolUseIds)

    // Build request
    const request: ChatCompletionRequest = {
      model: dto.model,
      messages,
      stream,
    }

    if (supportsOpenAiCompatReasoning(dto.model)) {
      const effort = resolveOpenAiCompatReasoningEffort(dto)
      request.reasoning = { effort }
      request.reasoning_effort = effort
    }

    if (dto.max_tokens) {
      request.max_tokens = dto.max_tokens
    }
    if (dto.temperature != null) {
      request.temperature = dto.temperature
    }
    if (dto.top_p != null) {
      request.top_p = dto.top_p
    }

    // Stream options for usage in streaming mode
    if (stream) {
      request.stream_options = { include_usage: true }
    }

    // Tools
    if (dto.tools && dto.tools.length > 0) {
      const tools: ChatCompletionTool[] = []
      for (const tool of dto.tools) {
        if (tool.type === "web_search_20250305") continue
        tools.push({
          type: "function",
          function: {
            name: tool.name || "",
            description: tool.description,
            parameters: tool.input_schema || { type: "object", properties: {} },
          },
        })
      }
      if (tools.length > 0) {
        request.tools = tools
        request.tool_choice = "auto"
      }
    }

    return request
  }

  // ── Tool call integrity sanitizer ─────────────────────────────────

  /**
   * Ensure every assistant tool_call has a matching tool response and
   * every tool response has a matching tool_call. Strip any orphans.
   * Tool calls whose IDs appear in pendingToolUseIds are preserved
   * (they are still awaiting a response from the model).
   * Mutates the array in-place.
   */
  private sanitizeToolCallIntegrity(
    messages: ChatCompletionMessage[],
    pendingToolUseIds?: string[]
  ): void {
    const sanitized = sanitizeOpenAiChatToolCallIntegrity(
      messages,
      pendingToolUseIds
    )

    if (sanitized.changed) {
      this.logger.warn(
        `[sanitize] Stripped ${sanitized.removedToolCalls} orphan/non-adjacent tool_call(s), ` +
          `${sanitized.removedToolResponses} orphan/non-adjacent tool response(s), ` +
          `${sanitized.removedEmptyMessages} empty assistant message(s)`
      )
      messages.splice(0, messages.length, ...sanitized.items)
    }
  }

  // ── Simple streaming completion (no Anthropic translation) ──────────

  /**
   * Stream a simple chat completion request directly, yielding text deltas.
   * Used for non-chat features like diff review that don't need Anthropic translation.
   */
  async *streamSimpleCompletion(
    model: string,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options?: { temperature?: number; max_tokens?: number }
  ): AsyncGenerator<string> {
    if (!this.isAvailable()) {
      throw new Error("OpenAI-compatible backend not configured")
    }

    const account = this.nextAccount(model)
    const url = this.buildUrlForAccount(account)
    const headers = this.buildHeadersForAccount(account, true)
    const body: ChatCompletionRequest = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }
    if (options?.temperature != null) body.temperature = options.temperature
    if (options?.max_tokens != null) body.max_tokens = options.max_tokens

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }
    const agent = this.buildProxyAgentForAccount(account)
    if (agent) {
      fetchOptions.dispatcher = agent
    }

    this.logger.log(
      `[SimpleCompletion] Streaming request to ${url} (model=${model})`
    )

    const responseHeadersTimeoutMs = this.getStreamResponseHeadersTimeoutMs()
    let response: Response
    try {
      response = await this.fetchWithResponseHeadersTimeout(
        url,
        fetchOptions,
        responseHeadersTimeoutMs,
        `OpenAI-compatible stream timed out waiting for upstream response headers after ${responseHeadersTimeoutMs}ms`
      )
    } catch (error) {
      throw this.buildTransientFailureError(
        account,
        504,
        error instanceof Error ? error.message : String(error),
        model
      )
    }

    if (!response.ok) {
      const errorBody = await response.text()
      throw this.buildHttpFailureError(
        account,
        response.status,
        errorBody,
        model,
        response.headers.get("retry-after") || undefined
      )
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw this.buildTransientFailureError(
        account,
        502,
        "OpenAI-compatible response has no body reader",
        model
      )
    }

    const decoder = new TextDecoder()
    let buffer = ""
    const firstChunkTimeoutMs = this.getStreamFirstChunkTimeoutMs()
    const idleTimeoutMs = this.getStreamIdleTimeoutMs()
    let receivedChunk = false

    try {
      while (true) {
        const { done, value } = await this.readStreamChunkWithTimeout(
          reader,
          receivedChunk ? idleTimeoutMs : firstChunkTimeoutMs,
          receivedChunk
            ? "OpenAI-compatible stream timed out while waiting for the next SSE chunk"
            : `OpenAI-compatible stream timed out waiting for the first SSE chunk after ${firstChunkTimeoutMs}ms`
        )
        if (done) break
        receivedChunk = true

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("data: ")) continue
          const data = trimmed.slice(6)
          if (data === "[DONE]") return

          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>
            }
            const content = parsed.choices?.[0]?.delta?.content
            if (content) yield content
          } catch {
            // skip malformed chunks
          }
        }
      }
      this.markAccountHealthy(account, model)
    } catch (error) {
      if (
        error instanceof BackendApiError ||
        error instanceof BackendAccountPoolUnavailableError
      ) {
        throw error
      }
      throw this.buildTransientFailureError(
        account,
        504,
        error instanceof Error ? error.message : String(error),
        model
      )
    } finally {
      reader.releaseLock()
    }
  }

  // ── URL builder ──────────────────────────────────────────────────────

  private buildUrlForAccount(account: OpenaiCompatAccount): string {
    return `${account.baseUrl.replace(/\/+$/, "")}/chat/completions`
  }

  private buildResponsesUrlForAccount(account: OpenaiCompatAccount): string {
    return `${account.baseUrl.replace(/\/+$/, "")}/responses`
  }

  /**
   * Check if a model is eligible for Responses API routing.
   */
  private isResponsesApiEligible(model: string): boolean {
    return supportsOpenAiCompatReasoning(model)
  }

  /**
   * Determine which endpoint to try first for a model.
   * Returns "responses" if Responses API should be tried first,
   * "chat-completions" otherwise.
   */
  private resolveEndpoint(
    model: string,
    account?: OpenaiCompatAccount
  ): "responses" | "chat-completions" {
    const normalizedModel = model.toLowerCase().trim()

    // Per-account override: preferResponsesApi takes highest priority
    if (account?.preferResponsesApi && this.isResponsesApiEligible(model)) {
      return "responses"
    }

    // Mode: always → force Responses API for eligible models
    if (
      this.responsesApiMode === "always" &&
      this.isResponsesApiEligible(model)
    ) {
      return "responses"
    }
    // Mode: never → always Chat Completions
    if (this.responsesApiMode === "never") {
      return "chat-completions"
    }
    // Mode: auto → check per-model cache, default to chat-completions
    const cached = this.endpointPreference.get(normalizedModel)
    if (cached) return cached
    return "chat-completions"
  }

  /**
   * Record successful endpoint for a model (auto mode learning).
   */
  private recordEndpointSuccess(
    model: string,
    endpoint: "responses" | "chat-completions",
    account?: OpenaiCompatAccount
  ): void {
    if (this.responsesApiMode !== "auto") return
    if (account?.preferResponsesApi) return

    const normalizedModel = model.toLowerCase().trim()
    const current = this.endpointPreference.get(normalizedModel)
    if (current !== endpoint) {
      this.endpointPreference.set(normalizedModel, endpoint)
      this.logger.log(
        `[OpenAI-Compat] Learned endpoint preference: ${model} → ${endpoint}`
      )
    }
  }

  /**
   * Check if an error from Chat Completions should trigger Responses API fallback.
   */
  private shouldFallbackToResponsesApi(
    status: number,
    errorBody: string,
    model: string
  ): boolean {
    if (this.responsesApiMode === "never") return false
    if (!this.isResponsesApiEligible(model)) return false

    // 503 with "no_available_providers" is the classic case
    if (status === 503) return true
    // 404 could mean endpoint not found for the model
    if (status === 404) return true
    // Some providers return 400 for unsupported model on chat/completions
    if (status === 400 && errorBody.includes("model")) return true

    return false
  }

  private getBackendErrorStatus(error: unknown): number {
    if (
      error instanceof BackendApiError &&
      typeof error.statusCode === "number"
    ) {
      return error.statusCode
    }

    const errorMsg =
      error instanceof Error ? error.message || "" : String(error)
    const statusMatch = errorMsg.match(/API error (\d+)/)
    return statusMatch ? parseInt(statusMatch[1]!, 10) : 0
  }

  private shouldFallbackToChatCompletionsApi(
    error: unknown,
    model: string
  ): boolean {
    if (this.responsesApiMode === "always") return false
    if (!this.isResponsesApiEligible(model)) return false
    if (error instanceof BackendAccountPoolUnavailableError) return false
    if (error instanceof BackendApiError && error.permanent) return false

    const status = this.getBackendErrorStatus(error)
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error)

    if (status === 503 || status === 501 || status === 404) return true
    if (
      status === 400 &&
      /model|unsupported|unknown parameter|response format|reasoning/.test(
        message
      )
    ) {
      return true
    }

    return false
  }

  // ── Headers ──────────────────────────────────────────────────────────

  private buildHeadersForAccount(
    account: OpenaiCompatAccount,
    stream: boolean
  ): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${account.apiKey}`,
      Accept: stream ? "text/event-stream" : "application/json",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    }
  }

  // ── Non-streaming ────────────────────────────────────────────────────

  /**
   * Send a non-streaming message through the OpenAI-compatible backend.
   */
  async sendClaudeMessage(dto: CreateMessageDto): Promise<AnthropicResponse> {
    if (!this.isAvailable()) {
      throw new Error(
        "OpenAI-compatible backend not configured: missing API key or base URL"
      )
    }

    const account = this.nextAccount(dto.model)
    const endpoint = this.resolveEndpoint(dto.model, account)

    if (endpoint === "responses") {
      try {
        const result = await this.sendClaudeMessageViaResponses(
          dto,
          account,
          this.responsesApiMode !== "always"
        )
        this.recordEndpointSuccess(dto.model, "responses", account)
        return result
      } catch (e) {
        if (!this.shouldFallbackToChatCompletionsApi(e, dto.model)) {
          throw e
        }
        this.logger.warn(
          `[OpenAI-Compat] Responses API failed for ${dto.model}, trying Chat Completions: ${(e as Error).message?.slice(0, 100)}`
        )
      }
    }

    // Try Chat Completions
    try {
      const result = await this.sendClaudeMessageViaChatCompletions(
        dto,
        account,
        endpoint !== "responses"
      )
      this.recordEndpointSuccess(dto.model, "chat-completions", account)
      return result
    } catch (e) {
      // Check if we should fallback to Responses API
      const errorMsg = (e as Error).message || ""
      const status = this.getBackendErrorStatus(e)

      if (
        endpoint !== "responses" &&
        this.shouldFallbackToResponsesApi(status, errorMsg, dto.model)
      ) {
        this.logger.warn(
          `[OpenAI-Compat] Chat Completions returned ${status} for ${dto.model}, falling back to Responses API`
        )
        const result = await this.sendClaudeMessageViaResponses(dto, account)
        this.recordEndpointSuccess(dto.model, "responses", account)
        return result
      }
      throw e
    }
  }

  /**
   * Non-streaming via Chat Completions endpoint.
   */
  private async sendClaudeMessageViaChatCompletions(
    dto: CreateMessageDto,
    account: OpenaiCompatAccount = this.nextAccount(dto.model),
    suppressCooldownForResponsesFallback: boolean = false
  ): Promise<AnthropicResponse> {
    const requestStartedAt = Date.now()
    const request = this.translateRequest(dto, false)
    const url = this.buildUrlForAccount(account)
    const headers = this.buildHeadersForAccount(account, false)

    this.logger.log(
      `[OpenAI-Compat] Non-stream request: model=${request.model}, url=${url}, reasoning=${JSON.stringify(request.reasoning || null)}`
    )

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(300_000),
    }

    const agent = this.buildProxyAgentForAccount(account)
    if (agent) {
      fetchOptions.dispatcher = agent
    }

    let response: Response
    try {
      response = await fetch(url, fetchOptions)
    } catch (error) {
      throw this.buildTransientFailureError(
        account,
        504,
        error instanceof Error ? error.message : String(error),
        request.model
      )
    }

    if (!response.ok) {
      const errorBody = await response.text()
      this.logger.error(
        `[OpenAI-Compat] Request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
      )
      throw this.buildHttpFailureError(
        account,
        response.status,
        errorBody,
        request.model,
        response.headers.get("retry-after") || undefined,
        suppressCooldownForResponsesFallback &&
          this.shouldFallbackToResponsesApi(
            response.status,
            errorBody,
            request.model
          )
      )
    }

    const result = (await response.json()) as Record<string, unknown>
    this.markAccountHealthy(account, request.model)
    this.recordOpenAiCompatUsage(account, request.model, "chat-completions", {
      ...this.extractChatCompletionUsage(result),
      durationMs: Math.max(0, Date.now() - requestStartedAt),
    })
    return this.translateNonStreamResponse(result)
  }

  /**
   * Translate OpenAI Chat Completion response → Anthropic response.
   */
  private translateNonStreamResponse(
    completion: Record<string, unknown>
  ): AnthropicResponse {
    const choices = completion.choices as Array<Record<string, unknown>>
    const choice = choices?.[0]
    const message = choice?.message as Record<string, unknown>
    const content: ContentBlock[] = []
    let hasToolCall = false

    const providerReasoningText = extractReasoningText(message?.reasoning)
    if (providerReasoningText) {
      content.push({ type: "thinking", thinking: providerReasoningText })
    }

    // Some providers prefix visible content with a single tagged reasoning block.
    // Only normalize a leading wrapper; treat any later <thinking> mentions as text.
    const text = message?.content as string
    if (text) {
      const visibleText = providerReasoningText
        ? stripLeadingThinkingTaggedText(text)
        : null

      if (visibleText !== null) {
        if (visibleText) {
          content.push({ type: "text", text: visibleText })
        }
      } else {
        content.push(...splitThinkingTaggedText(text))
      }
    }

    // Tool calls
    const toolCalls = message?.tool_calls as Array<Record<string, unknown>>
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        hasToolCall = true
        const func = tc.function as Record<string, unknown>
        let input: Record<string, unknown> = {}
        const argsStr = func?.arguments as string
        if (argsStr) {
          try {
            input = JSON.parse(argsStr) as Record<string, unknown>
          } catch {
            // Leave input empty
          }
        }
        content.push({
          type: "tool_use",
          id: (tc.id as string) || `call_${crypto.randomUUID()}`,
          name: (func?.name as string) || "",
          input,
        })
      }
    }

    // Usage
    const usage = completion.usage as Record<string, unknown>
    const inputTokens = (usage?.prompt_tokens as number) || 0
    const outputTokens = (usage?.completion_tokens as number) || 0

    // Stop reason
    const finishReason = choice?.finish_reason as string
    let stopReason: string
    if (hasToolCall) {
      stopReason = "tool_use"
    } else if (finishReason === "length") {
      stopReason = "max_tokens"
    } else {
      stopReason = "end_turn"
    }

    return {
      id: (completion.id as string) || `chatcmpl-${crypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      model: (completion.model as string) || "",
      content,
      stop_reason: stopReason,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
    }
  }

  // ── Streaming ────────────────────────────────────────────────────────

  /**
   * Send a streaming message through the OpenAI-compatible backend.
   * Returns an async generator yielding Claude SSE event strings.
   */
  async *sendClaudeMessageStream(
    dto: CreateMessageDto,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    if (!this.isAvailable()) {
      throw new Error(
        "OpenAI-compatible backend not configured: missing API key or base URL"
      )
    }

    const account = this.nextAccount(dto.model)
    const endpoint = this.resolveEndpoint(dto.model, account)

    if (endpoint === "responses") {
      let emittedResponsesEvents = false
      try {
        for await (const event of this.sendClaudeMessageStreamViaResponses(
          dto,
          account,
          this.responsesApiMode !== "always",
          abortSignal
        )) {
          emittedResponsesEvents = true
          yield event
        }
        this.recordEndpointSuccess(dto.model, "responses", account)
        return
      } catch (e) {
        const abortedError = toUpstreamRequestAbortedError(
          e,
          abortSignal,
          "OpenAI-compatible stream aborted"
        )
        if (abortedError) {
          throw abortedError
        }
        if (
          emittedResponsesEvents ||
          !this.shouldFallbackToChatCompletionsApi(e, dto.model)
        ) {
          throw e
        }
        this.logger.warn(
          `[OpenAI-Compat] Responses API stream failed for ${dto.model}, trying Chat Completions: ${(e as Error).message?.slice(0, 100)}`
        )
      }
    }

    // Try Chat Completions with fallback
    let emittedChatEvents = false
    try {
      for await (const event of this.sendClaudeMessageStreamViaChatCompletions(
        dto,
        account,
        endpoint !== "responses",
        abortSignal
      )) {
        emittedChatEvents = true
        yield event
      }
      this.recordEndpointSuccess(dto.model, "chat-completions", account)
    } catch (e) {
      const abortedError = toUpstreamRequestAbortedError(
        e,
        abortSignal,
        "OpenAI-compatible stream aborted"
      )
      if (abortedError) {
        throw abortedError
      }

      const errorMsg = (e as Error).message || ""
      const status = this.getBackendErrorStatus(e)

      if (
        !emittedChatEvents &&
        endpoint !== "responses" &&
        this.shouldFallbackToResponsesApi(status, errorMsg, dto.model)
      ) {
        this.logger.warn(
          `[OpenAI-Compat] Chat Completions stream returned ${status} for ${dto.model}, falling back to Responses API`
        )
        yield* this.sendClaudeMessageStreamViaResponses(
          dto,
          account,
          false,
          abortSignal
        )
        this.recordEndpointSuccess(dto.model, "responses", account)
        return
      }
      throw e
    }
  }

  /**
   * Stream via Chat Completions endpoint.
   */
  private async *sendClaudeMessageStreamViaChatCompletions(
    dto: CreateMessageDto,
    account: OpenaiCompatAccount = this.nextAccount(dto.model),
    suppressCooldownForResponsesFallback: boolean = false,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const requestStartedAt = Date.now()
    const request = this.translateRequest(dto, true)
    const url = this.buildUrlForAccount(account)
    const headers = this.buildHeadersForAccount(account, true)

    this.logger.log(
      `[OpenAI-Compat] Stream request: model=${request.model}, url=${url}, reasoning=${JSON.stringify(request.reasoning || null)}`
    )

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    }

    const agent = this.buildProxyAgentForAccount(account)
    if (agent) {
      fetchOptions.dispatcher = agent
    }

    const responseHeadersTimeoutMs = this.getStreamResponseHeadersTimeoutMs()
    let response: Response

    try {
      response = await this.fetchWithResponseHeadersTimeout(
        url,
        fetchOptions,
        responseHeadersTimeoutMs,
        `OpenAI-compatible stream timed out waiting for upstream response headers after ${responseHeadersTimeoutMs}ms`,
        abortSignal
      )
    } catch (error) {
      const abortedError = toUpstreamRequestAbortedError(
        error,
        abortSignal,
        "OpenAI-compatible Chat Completions stream aborted"
      )
      if (abortedError) {
        throw abortedError
      }
      throw this.buildTransientFailureError(
        account,
        504,
        error instanceof Error ? error.message : String(error),
        request.model
      )
    }

    if (!response.ok) {
      const errorBody = await response.text()
      this.logger.error(
        `[OpenAI-Compat] Stream request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
      )
      throw this.buildHttpFailureError(
        account,
        response.status,
        errorBody,
        request.model,
        response.headers.get("retry-after") || undefined,
        suppressCooldownForResponsesFallback &&
          this.shouldFallbackToResponsesApi(
            response.status,
            errorBody,
            request.model
          )
      )
    }

    if (!response.body) {
      throw this.buildTransientFailureError(
        account,
        502,
        "OpenAI-compatible response has no body",
        request.model
      )
    }

    // Check content-type to ensure we are actually getting a stream,
    // not an HTML challenge page (e.g. from Cloudflare)
    const contentType = response.headers.get("content-type") || ""
    if (contentType.includes("text/html")) {
      const errorBodyText = await response.text()
      this.logger.error(
        `[OpenAI-Compat] Expected stream but got HTML (possible captcha/WAF block). HTML start: ${errorBodyText.slice(0, 200)}`
      )
      throw this.buildTransientFailureError(
        account,
        503,
        "OpenAI-compatible API returned HTML page. API may be blocked by anti-bot protection.",
        request.model
      )
    }

    // Stream SSE events
    const state = createStreamState()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    // We implement an idle timeout for reader.read(). If no chunk is received
    // within IDLE_TIMEOUT_MS, we throw an error to prevent the bridge from hanging forever.
    const FIRST_CHUNK_TIMEOUT_MS = this.getStreamFirstChunkTimeoutMs()
    const IDLE_TIMEOUT_MS = this.getStreamIdleTimeoutMs()
    let receivedChunk = false

    try {
      while (true) {
        const timeoutMs = receivedChunk
          ? IDLE_TIMEOUT_MS
          : FIRST_CHUNK_TIMEOUT_MS
        const timeoutMessage = receivedChunk
          ? "OpenAI-compatible stream timed out while waiting for the next SSE chunk"
          : `OpenAI-compatible stream timed out waiting for the first SSE chunk after ${FIRST_CHUNK_TIMEOUT_MS}ms`

        const readResult = await this.readStreamChunkWithTimeout(
          reader,
          timeoutMs,
          timeoutMessage,
          abortSignal
        )

        const { done, value } = readResult
        if (done) break
        receivedChunk = true

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          const events = this.translateStreamChunk(trimmed, state)
          for (const event of events) {
            yield event
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const events = this.translateStreamChunk(buffer.trim(), state)
        for (const event of events) {
          yield event
        }
      }

      // Emit final message_delta + message_stop if not already emitted
      if (state.messageStartEmitted) {
        yield* this.emitStreamEnd(state)
      }
      this.markAccountHealthy(account, request.model)
      this.recordOpenAiCompatUsage(account, request.model, "chat-completions", {
        inputTokens: state.lastInputTokens,
        cachedInputTokens: state.lastCachedInputTokens,
        outputTokens: state.lastOutputTokens,
        durationMs: Math.max(0, Date.now() - requestStartedAt),
      })
    } catch (error) {
      const abortedError = toUpstreamRequestAbortedError(
        error,
        abortSignal,
        "OpenAI-compatible Chat Completions stream aborted"
      )
      if (abortedError) {
        throw abortedError
      }
      if (
        error instanceof BackendApiError ||
        error instanceof BackendAccountPoolUnavailableError
      ) {
        throw error
      }
      throw this.buildTransientFailureError(
        account,
        504,
        error instanceof Error ? error.message : String(error),
        request.model
      )
    } finally {
      reader.releaseLock()
    }

    this.logger.log(
      `[OpenAI-Compat] Stream completed: model=${state.model}, blocks=${state.blockIndex}, hasToolCall=${state.hasToolCall}`
    )
  }

  /**
   * Translate a single OpenAI SSE chunk line → Claude SSE event(s).
   *
   * OpenAI stream format:
   *   data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"content":"..."}}]}
   *   data: [DONE]
   */
  private previewReasoningValue(value: unknown): string {
    if (typeof value === "string") {
      return value.slice(0, 200)
    }

    try {
      return JSON.stringify(value).slice(0, 200)
    } catch {
      return String(value).slice(0, 200)
    }
  }

  private logReasoningHit(source: string, value: unknown): void {
    this.logger.debug(
      `[OpenAI-Compat] Reasoning chunk detected: source=${source}, type=${typeof value}, preview=${this.previewReasoningValue(value)}`
    )
  }

  private emitThinkingDelta(
    state: StreamState,
    thinkingText: string
  ): string[] {
    if (!thinkingText) return []

    const results: string[] = []
    if (!state.thinkingBlockActive) {
      results.push(
        formatSseEvent("content_block_start", {
          type: "content_block_start",
          index: state.blockIndex,
          content_block: { type: "thinking", thinking: "" },
        })
      )
      state.thinkingBlockActive = true
    }

    results.push(
      formatSseEvent("content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta: { type: "thinking_delta", thinking: thinkingText },
      })
    )

    return results
  }

  private emitTextDelta(state: StreamState, text: string): string[] {
    if (!text) return []

    const results: string[] = []
    if (!state.textBlockActive) {
      results.push(
        formatSseEvent("content_block_start", {
          type: "content_block_start",
          index: state.blockIndex,
          content_block: { type: "text", text: "" },
        })
      )
      state.textBlockActive = true
    }

    results.push(
      formatSseEvent("content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta: { type: "text_delta", text },
      })
    )

    state.contentStarted = true
    return results
  }

  private closeThinkingBlock(state: StreamState): string[] {
    if (!state.thinkingBlockActive) return []

    state.thinkingBlockActive = false
    const results = [
      formatSseEvent("content_block_stop", {
        type: "content_block_stop",
        index: state.blockIndex,
      }),
    ]
    state.blockIndex++
    return results
  }

  private closeTextBlock(state: StreamState): string[] {
    if (!state.textBlockActive) return []

    state.textBlockActive = false
    const results = [
      formatSseEvent("content_block_stop", {
        type: "content_block_stop",
        index: state.blockIndex,
      }),
    ]
    state.blockIndex++
    return results
  }

  private consumeTaggedContentDelta(
    state: StreamState,
    contentDelta: string
  ): string[] {
    if (
      state.explicitReasoningSeen &&
      !state.contentStarted &&
      state.leadingTaggedContentState !== "plain"
    ) {
      return this.consumeSuppressedLeadingTaggedContentDelta(
        state,
        contentDelta
      )
    }

    state.leadingTaggedContentState = "plain"
    state.leadingTaggedContentBuffer = ""
    const results: string[] = []
    if (state.thinkingBlockActive) {
      results.push(...this.closeThinkingBlock(state))
    }
    results.push(...this.emitTextDelta(state, contentDelta))
    return results
  }

  private consumeSuppressedLeadingTaggedContentDelta(
    state: StreamState,
    contentDelta: string
  ): string[] {
    const results: string[] = []

    if (state.leadingTaggedContentState === "detecting") {
      state.leadingTaggedContentBuffer += contentDelta
      const buffered = state.leadingTaggedContentBuffer

      if (THINKING_OPEN_TAG.startsWith(buffered)) {
        return results
      }

      if (!buffered.startsWith(THINKING_OPEN_TAG)) {
        state.leadingTaggedContentState = "plain"
        state.leadingTaggedContentBuffer = ""
        if (state.thinkingBlockActive) {
          results.push(...this.closeThinkingBlock(state))
        }
        results.push(...this.emitTextDelta(state, buffered))
        return results
      }

      state.leadingTaggedContentState = "suppressing"
      return this.consumeSuppressedLeadingTaggedContentEvents(state, buffered)
    }

    if (state.leadingTaggedContentState !== "suppressing") {
      if (state.thinkingBlockActive) {
        results.push(...this.closeThinkingBlock(state))
      }
      results.push(...this.emitTextDelta(state, contentDelta))
      return results
    }

    state.leadingTaggedContentBuffer += contentDelta
    return this.consumeSuppressedLeadingTaggedContentEvents(state, contentDelta)
  }

  private consumeSuppressedLeadingTaggedContentEvents(
    state: StreamState,
    contentDelta: string
  ): string[] {
    const results: string[] = []

    for (const event of consumeThinkingTagTextDelta(
      state.thinkingTagState,
      contentDelta
    )) {
      if (event.type === "thinking") {
        continue
      }

      if (event.type === "thinking_end") {
        state.leadingTaggedContentState = "plain"
        state.leadingTaggedContentBuffer = ""
        continue
      }

      if (state.thinkingBlockActive) {
        results.push(...this.closeThinkingBlock(state))
      }
      results.push(...this.emitTextDelta(state, event.text))
    }

    return results
  }

  private flushPendingTaggedContent(state: StreamState): string[] {
    if (
      state.leadingTaggedContentState !== "detecting" &&
      state.leadingTaggedContentState !== "suppressing"
    ) {
      return []
    }

    const buffered = state.leadingTaggedContentBuffer
    state.leadingTaggedContentState = "plain"
    state.leadingTaggedContentBuffer = ""
    state.thinkingTagState = createThinkingTagStreamState()

    if (!buffered) {
      return []
    }

    const results: string[] = []
    if (state.thinkingBlockActive) {
      results.push(...this.closeThinkingBlock(state))
    }
    results.push(...this.emitTextDelta(state, buffered))
    return results
  }

  private translateStreamChunk(line: string, state: StreamState): string[] {
    if (!line.startsWith("data:")) return []

    const jsonStr = line.slice(5).trim()
    if (!jsonStr || jsonStr === "[DONE]") return []

    let chunk: Record<string, unknown>
    try {
      chunk = JSON.parse(jsonStr) as Record<string, unknown>
    } catch {
      return []
    }

    const results: string[] = []

    // Capture response metadata
    if (!state.responseId && chunk.id) {
      state.responseId = chunk.id as string
    }
    if (!state.model && chunk.model) {
      state.model = chunk.model as string
    }

    // Emit message_start on first chunk
    if (!state.messageStartEmitted) {
      state.messageStartEmitted = true
      results.push(
        formatSseEvent("message_start", {
          type: "message_start",
          message: {
            id: state.responseId || `chatcmpl-${crypto.randomUUID()}`,
            type: "message",
            role: "assistant",
            model: state.model || "",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            content: [],
            stop_reason: null,
          },
        })
      )
    }

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined
    if (!choices || choices.length === 0) return results

    const choice = choices[0]
    if (!choice) return results
    const delta = choice.delta as Record<string, unknown>
    if (!delta) return results

    const finishReason = choice.finish_reason as string | null

    const closeThinkingBeforeContent = () => {
      if (state.thinkingBlockActive) {
        results.push(...this.closeThinkingBlock(state))
      }
    }

    // Handle provider-specific reasoning/thinking deltas
    const deltaReasoning = delta.reasoning as string | undefined
    const deltaReasoningContent = delta.reasoning_content as string | undefined
    const deltaReasoningText =
      deltaReasoning || deltaReasoningContent || delta.reasoning_text
    const providerMessage = chunk.message
    const providerReasoning =
      providerMessage && typeof providerMessage === "object"
        ? (providerMessage as Record<string, unknown>).reasoning
        : undefined
    const providerReasoningText = extractReasoningText(providerReasoning)
    const explicitReasoningText =
      typeof deltaReasoningText === "string" && deltaReasoningText
        ? deltaReasoningText
        : providerReasoningText
    const explicitReasoningSource =
      typeof deltaReasoningText === "string" && deltaReasoningText
        ? deltaReasoning
          ? "delta.reasoning"
          : deltaReasoningContent
            ? "delta.reasoning_content"
            : "delta.reasoning_text"
        : providerReasoningText
          ? "message.reasoning"
          : null

    if (explicitReasoningText && explicitReasoningSource) {
      state.explicitReasoningSeen = true
      if (
        !state.contentStarted &&
        state.leadingTaggedContentState === "plain"
      ) {
        state.leadingTaggedContentState = "detecting"
      }
      if (state.textBlockActive) {
        results.push(...this.closeTextBlock(state))
      }
      this.logReasoningHit(explicitReasoningSource, explicitReasoningText)
      results.push(...this.emitThinkingDelta(state, explicitReasoningText))
    }

    // Handle text content delta
    const contentDelta = delta.content as string | null
    if (contentDelta != null && contentDelta !== "") {
      results.push(...this.consumeTaggedContentDelta(state, contentDelta))
    }

    // Handle tool call deltas
    const toolCallDeltas = delta.tool_calls as Array<
      Record<string, unknown>
    > | null
    if (Array.isArray(toolCallDeltas)) {
      for (const tc of toolCallDeltas) {
        const tcIndex = (tc.index as number) ?? 0
        const func = tc.function as Record<string, unknown> | undefined

        if (!state.activeToolCalls.has(tcIndex)) {
          results.push(...this.flushPendingTaggedContent(state))
          closeThinkingBeforeContent()
          results.push(...this.closeTextBlock(state))

          // New tool call
          state.hasToolCall = true
          const toolId = (tc.id as string) || `call_${crypto.randomUUID()}`
          const toolName = (func?.name as string) || ""

          state.activeToolCalls.set(tcIndex, {
            id: toolId,
            name: toolName,
            arguments: "",
          })

          results.push(
            formatSseEvent("content_block_start", {
              type: "content_block_start",
              index: state.blockIndex,
              content_block: {
                type: "tool_use",
                id: toolId,
                name: toolName,
                input: {},
              },
            })
          )

          // Emit initial empty delta
          results.push(
            formatSseEvent("content_block_delta", {
              type: "content_block_delta",
              index: state.blockIndex,
              delta: { type: "input_json_delta", partial_json: "" },
            })
          )
        }

        // Argument delta
        const argDelta = func?.arguments as string | undefined
        if (argDelta) {
          const tc_state = state.activeToolCalls.get(tcIndex)
          if (tc_state) {
            tc_state.arguments += argDelta
          }

          results.push(
            formatSseEvent("content_block_delta", {
              type: "content_block_delta",
              index: state.blockIndex,
              delta: { type: "input_json_delta", partial_json: argDelta },
            })
          )
        }
      }
    }

    // Handle finish
    if (finishReason) {
      results.push(...this.flushPendingTaggedContent(state))
      closeThinkingBeforeContent()
      results.push(...this.closeTextBlock(state))

      if (state.activeToolCalls.size > 0) {
        results.push(
          formatSseEvent("content_block_stop", {
            type: "content_block_stop",
            index: state.blockIndex,
          })
        )
        state.blockIndex++
      }

      // Determine stop reason
      let stopReason: string
      if (finishReason === "tool_calls" || state.hasToolCall) {
        stopReason = "tool_use"
      } else if (finishReason === "length") {
        stopReason = "max_tokens"
      } else {
        stopReason = "end_turn"
      }

      // Extract usage from the chunk if available
      const chunkUsage = chunk.usage as Record<string, unknown> | undefined
      const totalInputTokens = (chunkUsage?.prompt_tokens as number) || 0
      const outputTokens = (chunkUsage?.completion_tokens as number) || 0
      const cachedInputTokens = this.toWholeNumber(
        chunkUsage?.prompt_tokens_details &&
          typeof chunkUsage.prompt_tokens_details === "object"
          ? (chunkUsage.prompt_tokens_details as Record<string, unknown>)
              .cached_tokens
          : 0
      )
      const inputTokens = Math.max(0, totalInputTokens - cachedInputTokens)
      state.lastInputTokens = this.toWholeNumber(inputTokens)
      state.lastCachedInputTokens = cachedInputTokens
      state.lastOutputTokens = this.toWholeNumber(outputTokens)

      results.push(
        formatSseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: {
            input_tokens: inputTokens,
            cache_read_input_tokens: cachedInputTokens,
            output_tokens: outputTokens,
          },
        })
      )
      results.push(formatSseEvent("message_stop", { type: "message_stop" }))
    }

    return results
  }

  /**
   * Emit final stream end events (fallback if finish_reason was missed).
   */
  private *emitStreamEnd(state: StreamState): Generator<string, void, unknown> {
    const pendingTaggedContent = this.flushPendingTaggedContent(state)
    for (const event of pendingTaggedContent) {
      yield event
    }

    const pendingThinking = this.closeThinkingBlock(state)
    for (const event of pendingThinking) {
      yield event
    }

    const pendingText = this.closeTextBlock(state)
    for (const event of pendingText) {
      yield event
    }

    const stopReason = state.hasToolCall ? "tool_use" : "end_turn"

    yield formatSseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    yield formatSseEvent("message_stop", { type: "message_stop" })
  }

  // ── Responses API methods ─────────────────────────────────────────────
  // These methods use the Codex Responses API format (/responses endpoint)
  // instead of Chat Completions (/chat/completions), reusing the existing
  // codex translator infrastructure.

  /**
   * Stream via Responses API endpoint.
   * Translates Claude DTO → Codex Responses API request,
   * sends to /responses, and translates Codex SSE → Claude SSE.
   */
  private async *sendClaudeMessageStreamViaResponses(
    dto: CreateMessageDto,
    account: OpenaiCompatAccount = this.nextAccount(dto.model),
    suppressCooldownForChatFallback: boolean = false,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const requestStartedAt = Date.now()
    const modelName = dto.model
    const reverseToolMap = buildReverseMapFromClaudeTools(dto.tools)

    // Translate to Codex Responses API format
    const codexRequest = translateClaudeToCodex(dto, modelName) as Record<
      string,
      unknown
    >
    const url = this.buildResponsesUrlForAccount(account)
    const headers = this.buildHeadersForAccount(account, true)
    const requestBody = JSON.stringify(codexRequest)

    this.logger.log(
      `[OpenAI-Compat/Responses] Stream request: model=${modelName}, url=${url}, reasoning=${JSON.stringify(codexRequest.reasoning || null)}`
    )

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: requestBody,
    }

    const agent = this.buildProxyAgentForAccount(account)
    if (agent) {
      fetchOptions.dispatcher = agent
    }

    const responseHeadersTimeoutMs = this.getStreamResponseHeadersTimeoutMs()
    let response: Response

    try {
      response = await this.fetchWithResponseHeadersTimeout(
        url,
        fetchOptions,
        responseHeadersTimeoutMs,
        `OpenAI-compatible Responses stream timed out waiting for upstream response headers after ${responseHeadersTimeoutMs}ms`,
        abortSignal
      )
    } catch (error) {
      const abortedError = toUpstreamRequestAbortedError(
        error,
        abortSignal,
        "OpenAI-compatible Responses stream aborted"
      )
      if (abortedError) {
        throw abortedError
      }
      throw this.buildTransientFailureError(
        account,
        504,
        error instanceof Error ? error.message : String(error),
        modelName
      )
    }

    if (!response.ok) {
      const errorBody = await response.text()
      this.logger.error(
        `[OpenAI-Compat/Responses] Stream request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
      )
      throw this.buildHttpFailureError(
        account,
        response.status,
        errorBody,
        modelName,
        response.headers.get("retry-after") || undefined,
        suppressCooldownForChatFallback
      )
    }

    if (!response.body) {
      throw this.buildTransientFailureError(
        account,
        502,
        "OpenAI-compatible Responses API response has no body",
        modelName
      )
    }

    // Check content-type
    const contentType = response.headers.get("content-type") || ""
    if (contentType.includes("text/html")) {
      const errorBodyText = await response.text()
      this.logger.error(
        `[OpenAI-Compat/Responses] Expected stream but got HTML. HTML start: ${errorBodyText.slice(0, 200)}`
      )
      throw this.buildTransientFailureError(
        account,
        503,
        "OpenAI-compatible API returned HTML page. API may be blocked by anti-bot protection.",
        modelName
      )
    }

    // Stream SSE events using Codex response translator
    const state = createCodexStreamState()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    const FIRST_CHUNK_TIMEOUT_MS = this.getStreamFirstChunkTimeoutMs()
    const IDLE_TIMEOUT_MS = this.getStreamIdleTimeoutMs()
    let receivedChunk = false
    let completedUsage: {
      inputTokens: number
      cachedInputTokens: number
      outputTokens: number
    } | null = null

    try {
      while (true) {
        const timeoutMs = receivedChunk
          ? IDLE_TIMEOUT_MS
          : FIRST_CHUNK_TIMEOUT_MS
        const timeoutMessage = receivedChunk
          ? "OpenAI-compatible Responses stream timed out while waiting for the next SSE chunk"
          : `OpenAI-compatible Responses stream timed out waiting for the first SSE chunk after ${FIRST_CHUNK_TIMEOUT_MS}ms`

        const readResult = await this.readStreamChunkWithTimeout(
          reader,
          timeoutMs,
          timeoutMessage,
          abortSignal
        )
        const { done, value } = readResult
        if (done) break
        receivedChunk = true

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          if (trimmed.startsWith("data:")) {
            const jsonStr = trimmed.slice(5).trim()
            if (jsonStr && jsonStr !== "[DONE]") {
              try {
                const parsed = JSON.parse(jsonStr) as Record<string, unknown>
                if (parsed.type === "response.completed") {
                  completedUsage = this.extractResponsesUsage(parsed)
                }
              } catch {
                // Ignore malformed chunks for analytics bookkeeping
              }
            }
          }

          // Use Codex SSE translator to convert to Claude SSE events
          const events = translateCodexSseEvent(trimmed, state, reverseToolMap)
          for (const event of events) {
            yield event
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        if (buffer.trim().startsWith("data:")) {
          const jsonStr = buffer.trim().slice(5).trim()
          if (jsonStr && jsonStr !== "[DONE]") {
            try {
              const parsed = JSON.parse(jsonStr) as Record<string, unknown>
              if (parsed.type === "response.completed") {
                completedUsage = this.extractResponsesUsage(parsed)
              }
            } catch {
              // Ignore malformed chunks for analytics bookkeeping
            }
          }
        }
        const events = translateCodexSseEvent(
          buffer.trim(),
          state,
          reverseToolMap
        )
        for (const event of events) {
          yield event
        }
      }
      this.markAccountHealthy(account, modelName)
      this.recordOpenAiCompatUsage(account, modelName, "responses", {
        inputTokens: completedUsage?.inputTokens || 0,
        cachedInputTokens: completedUsage?.cachedInputTokens || 0,
        outputTokens: completedUsage?.outputTokens || 0,
        durationMs: Math.max(0, Date.now() - requestStartedAt),
      })
    } catch (error) {
      const abortedError = toUpstreamRequestAbortedError(
        error,
        abortSignal,
        "OpenAI-compatible Responses stream aborted"
      )
      if (abortedError) {
        throw abortedError
      }
      if (
        error instanceof BackendApiError ||
        error instanceof BackendAccountPoolUnavailableError
      ) {
        throw error
      }
      throw this.buildTransientFailureError(
        account,
        504,
        error instanceof Error ? error.message : String(error),
        modelName
      )
    } finally {
      reader.releaseLock()
    }

    this.logger.log(
      `[OpenAI-Compat/Responses] Stream completed: model=${state.model || modelName}, blocks=${state.blockIndex}, hasToolCall=${state.hasToolCall}`
    )
  }

  /**
   * Non-streaming via Responses API endpoint.
   * Translates Claude DTO → Codex Responses API request,
   * sends to /responses, reads all SSE events to find response.completed,
   * and translates the completed event back to Claude format.
   */
  private async sendClaudeMessageViaResponses(
    dto: CreateMessageDto,
    account: OpenaiCompatAccount = this.nextAccount(dto.model),
    suppressCooldownForChatFallback: boolean = false
  ): Promise<AnthropicResponse> {
    const requestStartedAt = Date.now()
    const modelName = dto.model
    const reverseToolMap = buildReverseMapFromClaudeTools(dto.tools)

    // Translate to Codex Responses API format
    const codexRequest = translateClaudeToCodex(dto, modelName) as Record<
      string,
      unknown
    >
    const url = this.buildResponsesUrlForAccount(account)
    const headers = this.buildHeadersForAccount(account, true) // Responses API always streams
    const requestBody = JSON.stringify(codexRequest)

    this.logger.log(
      `[OpenAI-Compat/Responses] Non-stream request: model=${modelName}, url=${url}, reasoning=${JSON.stringify(codexRequest.reasoning || null)}`
    )

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(300_000),
    }

    const agent = this.buildProxyAgentForAccount(account)
    if (agent) {
      fetchOptions.dispatcher = agent
    }

    let response: Response
    try {
      response = await fetch(url, fetchOptions)
    } catch (error) {
      throw this.buildTransientFailureError(
        account,
        504,
        error instanceof Error ? error.message : String(error),
        modelName
      )
    }

    if (!response.ok) {
      const errorBody = await response.text()
      this.logger.error(
        `[OpenAI-Compat/Responses] Request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
      )
      throw this.buildHttpFailureError(
        account,
        response.status,
        errorBody,
        modelName,
        response.headers.get("retry-after") || undefined,
        suppressCooldownForChatFallback
      )
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
            this.markAccountHealthy(account, modelName)
            this.recordOpenAiCompatUsage(account, modelName, "responses", {
              ...this.extractResponsesUsage(event),
              durationMs: Math.max(0, Date.now() - requestStartedAt),
            })
            this.logger.log(
              `[OpenAI-Compat/Responses] Non-stream response: model=${result.model}, stop=${result.stop_reason}`
            )
            return result
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }

    throw this.buildTransientFailureError(
      account,
      504,
      "OpenAI-compatible Responses API stream ended without response.completed event",
      modelName
    )
  }
}
