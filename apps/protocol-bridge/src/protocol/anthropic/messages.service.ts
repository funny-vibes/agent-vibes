import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import {
  type ContextAttachmentSnapshot,
  ContextManagerService,
  ContextNativeManagementService,
  ContextRequestPlannerService,
  type ContextRequestBudget,
  detectPromptTooLong,
  TokenCounterService,
  UnifiedMessage,
} from "../../context"
import {
  AnthropicApiService,
  DEFAULT_CLAUDE_API_CONTEXT_LIMIT_TOKENS,
} from "../../llm/anthropic/anthropic-api.service"
import { KiroService } from "../../llm/aws/kiro.service"
import { GoogleModelCacheService } from "../../llm/google/google-model-cache.service"
import { GoogleService } from "../../llm/google/google.service"
import {
  GOOGLE_STARTUP_UPSTREAM_CHECK_ENV,
  isGoogleStartupUpstreamCheckEnabled,
} from "../../llm/google/startup-probe-policy"
import type { CodexForwardHeaders } from "../../llm/openai/codex-header-utils"
import { CodexService } from "../../llm/openai/codex.service"
import { OpenaiCompatService } from "../../llm/openai/openai-compat.service"
import { BackendApiError } from "../../llm/shared/backend-errors"
import {
  canPublicClaudeModelUseGoogle,
  canPublicClaudeModelUseKiro,
  getCodexPublicModelIds,
  getPublicModelMetadata,
  resolveCloudCodeModel,
} from "../../llm/shared/model-registry"
import {
  ModelRouteResult,
  ModelRouterService,
} from "../../llm/shared/model-router.service"
import type { AnthropicResponse } from "../../shared/anthropic"
import { CountTokensDto } from "./dto/count-tokens.dto"
import { CreateMessageDto } from "./dto/create-message.dto"
import { TokenizerService } from "./tokenizer.service"

/**
 * MessagesService - Routes requests to Google or Codex backend.
 */
@Injectable()
export class MessagesService implements OnModuleInit {
  private readonly logger = new Logger(MessagesService.name)
  private readonly DEFAULT_HISTORY_MAX_TOKENS = 166_000
  private readonly CLOUD_CODE_CONTEXT_LIMIT_TOKENS = 200_000
  private readonly CLOUD_CODE_EXTRA_OVERHEAD_TOKENS = 1_536
  private readonly GENERIC_EXTRA_OVERHEAD_TOKENS = 768
  private readonly GOOGLE_CONTEXT_TAGS = [
    "user_information",
    "mcp_servers",
    "artifacts",
    "user_rules",
    "workflows",
    "ADDITIONAL_METADATA",
    "EPHEMERAL_MESSAGE",
  ] as const
  private readonly EMPTY_ATTACHMENT_SNAPSHOT: ContextAttachmentSnapshot = {
    readPaths: [],
    fileStates: [],
    todos: [],
  }

  constructor(
    private readonly googleService: GoogleService,
    private readonly googleModelCache: GoogleModelCacheService,
    private readonly modelRouter: ModelRouterService,
    private readonly tokenizer: TokenizerService,
    private readonly tokenCounter: TokenCounterService,
    private readonly contextManager: ContextManagerService,
    private readonly contextRequestPlanner: ContextRequestPlannerService,
    private readonly contextNativeManagement: ContextNativeManagementService,
    private readonly codexService: CodexService,
    private readonly openaiCompatService: OpenaiCompatService,
    private readonly anthropicApiService: AnthropicApiService,
    private readonly kiroService: KiroService
  ) {}

  private isGptBackendAvailable(): boolean {
    return (
      this.openaiCompatService.isAvailable() || this.codexService.isAvailable()
    )
  }

  private getAdvertisedGptModelTier(): string | null {
    if (this.openaiCompatService.isAvailable()) {
      return null
    }

    return this.codexService.getModelTier()
  }

  private async resolveStartupGoogleAvailability(): Promise<boolean> {
    if (isGoogleStartupUpstreamCheckEnabled()) {
      this.logger.log(
        `Startup Google upstream probe enabled (${GOOGLE_STARTUP_UPSTREAM_CHECK_ENV}=true)`
      )
      return this.googleService.checkAvailability()
    }

    const configured = this.googleService.isLocallyConfigured()
    this.logger.log(
      configured
        ? `Skipping Google upstream probe on startup (${GOOGLE_STARTUP_UPSTREAM_CHECK_ENV}=false); using local worker configuration only`
        : `Skipping Google upstream probe on startup (${GOOGLE_STARTUP_UPSTREAM_CHECK_ENV}=false); no local Google workers configured`
    )
    return configured
  }

  /**
   * Initialize backend availability checks.
   */
  async onModuleInit(): Promise<void> {
    await this.modelRouter.initializeRouting(
      () => this.resolveStartupGoogleAvailability(),
      () => this.codexService.checkAvailability(),
      () => this.openaiCompatService.checkAvailability(),
      () => this.anthropicApiService.checkAvailability(),
      () => this.kiroService.checkAvailability()
    )
    this.modelRouter.setGptAvailabilityProviders({
      codex: () => this.codexService.isAvailable(),
      openaiCompat: () => this.openaiCompatService.isAvailable(),
      codexSupportsModel: (model) => this.codexService.supportsModel(model),
      openaiCompatSupportsModel: (model) =>
        this.openaiCompatService.supportsModel(model),
    })
    this.modelRouter.setClaudeAvailabilityProvider((model) =>
      this.anthropicApiService.supportsModel(model)
    )
    this.modelRouter.setKiroAvailabilityProvider((model) =>
      this.kiroService.supportsModel(model)
    )
    this.logger.log("Backend availability tests completed")
  }

  /**
   * Extract text content from message content
   */
  private extractTextContent(content: unknown): string {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .filter(
          (block): block is { type: string; text: string } =>
            typeof block === "object" &&
            block !== null &&
            (block as Record<string, unknown>).type === "text"
        )
        .map((block) => block.text)
        .join("\n")
    }
    return ""
  }

  private extractGoogleContextBlocks(systemText: string): string[] {
    const tagAlternation = this.GOOGLE_CONTEXT_TAGS.join("|")
    const blockPattern = new RegExp(
      `<(?:${tagAlternation})>[\\s\\S]*?<\\/(?:${tagAlternation})>`,
      "g"
    )
    const matches = Array.from(systemText.matchAll(blockPattern))

    if (matches.length > 0) {
      const blocks: string[] = []
      let cursor = 0

      for (const match of matches) {
        const block = match[0]?.trim()
        const index = match.index ?? cursor
        const prefix = systemText.slice(cursor, index).trim()

        if (prefix) {
          blocks.push(prefix)
        }
        if (block) {
          blocks.push(block)
        }

        cursor = index + (match[0]?.length || 0)
      }

      const suffix = systemText.slice(cursor).trim()
      if (suffix) {
        blocks.push(suffix)
      }

      return this.dedupePreserveOrder(blocks)
    }

    const trimmed = systemText.trim()
    if (!trimmed) return []
    return [`<user_rules>\n${trimmed}\n</user_rules>`]
  }

  private dedupePreserveOrder(values: string[]): string[] {
    const seen = new Set<string>()
    const result: string[] = []

    for (const value of values) {
      const normalized = value.trim()
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      result.push(normalized)
    }

    return result
  }

  /**
   * Prepare DTO for Google Cloud Code backend routing.
   * GoogleService replaces dto.system entirely with the official Antigravity prompt.
   * To preserve user customizations (CLAUDE.md rules, project settings, etc.),
   * extract them from dto.system and inject as user messages in dto.messages.
   *
   * This matches Antigravity's behavior: user context goes in contents (user messages),
   * not in systemInstruction.
   */
  private prepareForGoogle(dto: CreateMessageDto): CreateMessageDto {
    if (!dto.system) return dto

    // Extract raw system text
    let systemText: string
    if (typeof dto.system === "string") {
      systemText = dto.system
    } else if (Array.isArray(dto.system)) {
      systemText = dto.system
        .filter(
          (block): block is { type: string; text: string } =>
            typeof block === "object" && block !== null && block.type === "text"
        )
        .map((block) => block.text)
        .join("\n")
    } else {
      systemText = this.extractTextContent(dto.system)
    }

    if (!systemText) return dto

    const contextMessages = this.extractGoogleContextBlocks(systemText).map(
      (content) => ({
        role: "user",
        content,
      })
    )

    if (contextMessages.length === 0) return dto

    this.logger.log(
      `[prepareForGoogle] Moved ${contextMessages.length} user context block(s) from system to messages`
    )

    return {
      ...dto,
      messages: [...(contextMessages as typeof dto.messages), ...dto.messages],
      system: undefined,
    }
  }

  private isGoogleBackend(route: ModelRouteResult): boolean {
    return route.backend === "google" || route.backend === "google-claude"
  }

  private getToolIntegrityModeForRoute(
    route: ModelRouteResult
  ): "strict-adjacent" | "global" {
    return this.isGoogleBackend(route) ||
      route.backend === "kiro" ||
      route.backend === "claude-api"
      ? "strict-adjacent"
      : "global"
  }

  private normalizePositiveInteger(value: unknown): number | undefined {
    if (typeof value !== "number") return undefined
    if (!Number.isFinite(value) || value <= 0) return undefined
    return Math.floor(value)
  }

  private countSystemPromptTokens(dto: CreateMessageDto): number {
    if (!dto.system) return 0

    return this.tokenCounter.countMessages([
      { role: "user", content: dto.system } as UnifiedMessage,
    ])
  }

  private getBackendContextLimit(route: ModelRouteResult): number | undefined {
    if (this.isGoogleBackend(route)) {
      return this.CLOUD_CODE_CONTEXT_LIMIT_TOKENS
    }
    if (route.backend === "claude-api") {
      return (
        this.anthropicApiService.getConfiguredMaxContextTokens(route.model) ??
        DEFAULT_CLAUDE_API_CONTEXT_LIMIT_TOKENS
      )
    }
    if (route.backend === "kiro") {
      return (
        this.kiroService.getConfiguredMaxContextTokens(route.model) ??
        // Kiro defaults to a 1M window for Sonnet/Opus 4.6 family.
        1_000_000
      )
    }
    if (route.backend === "openai-compat") {
      return this.openaiCompatService.getConfiguredMaxContextTokens(route.model)
    }
    return undefined
  }

  private resolveContextBudget(
    dto: CreateMessageDto,
    route: ModelRouteResult
  ): ContextRequestBudget {
    const backendLimit = this.getBackendContextLimit(route)
    const budget = this.contextRequestPlanner.resolveBudget({
      backend: route.backend,
      protocolMaxTokens: dto._contextTokenBudget,
      backendMaxTokens: backendLimit,
      defaultMaxTokens: this.DEFAULT_HISTORY_MAX_TOKENS,
      systemPromptTokens: this.countSystemPromptTokens(dto),
      toolDefinitions: dto.tools,
      backendSystemPromptTokens: this.isGoogleBackend(route)
        ? this.googleService.getSystemPromptTokenEstimate()
        : 0,
      fixedOverheadTokens: this.isGoogleBackend(route)
        ? this.CLOUD_CODE_EXTRA_OVERHEAD_TOKENS
        : this.GENERIC_EXTRA_OVERHEAD_TOKENS,
      maxOutputTokens: dto.max_tokens,
      requestedServiceTier:
        route.backend === "codex" && typeof dto.service_tier === "string"
          ? dto.service_tier
          : undefined,
    })

    if (budget.backendClampedFrom && budget.backendClampedTo) {
      this.logger.warn(
        `Request context budget ${budget.backendClampedFrom} exceeds backend cap ${budget.backendClampedTo}, clamping`
      )
    }

    return budget
  }

  private applyContextCompaction(
    dto: CreateMessageDto,
    route: ModelRouteResult
  ): CreateMessageDto {
    const originalTokens = this.contextManager.countMessages(
      dto.messages as UnifiedMessage[]
    )
    const budget = this.resolveContextBudget(dto, route)
    const result = this.contextRequestPlanner.projectMessages(
      dto.messages as UnifiedMessage[],
      this.EMPTY_ATTACHMENT_SNAPSHOT,
      budget,
      {
        integrityMode: this.getToolIntegrityModeForRoute(route),
        pendingToolUseIds: dto._pendingToolUseIds,
        strategy: "auto",
      }
    )

    if (result.wasCompacted) {
      this.logger.log(
        `Applied context compaction for ${route.backend}: ${originalTokens} -> ` +
          `${result.estimatedTokens} tokens (${dto.messages.length} -> ${result.messages.length} messages)`
      )
    }
    if (result.snipCompaction?.changed) {
      this.logger.log(
        `Applied snip compaction for ${route.backend}: ` +
          `${result.snipCompaction.removedRecords} live records summarized, ` +
          `${result.snipCompaction.retainedRecords} retained`
      )
    }
    if (result.microcompactCompaction?.changed) {
      this.logger.log(
        `Applied ${result.microcompactCompaction.trigger} microcompact for ${route.backend}: ` +
          `${result.microcompactCompaction.clearedToolResults} results across ` +
          `${result.microcompactCompaction.compactedRounds} API rounds`
      )
    }

    const contextManagement =
      this.contextNativeManagement.buildAnthropicContextManagement({
        backend: route.backend,
        messages: result.messages,
        maxTokens: budget.maxTokens,
        systemPromptTokens: budget.systemPromptTokens,
        autoCompactTokenLimit: budget.autoCompactTokenLimit,
      })

    return {
      ...dto,
      messages: result.messages as typeof dto.messages,
      context_management: contextManagement,
    }
  }

  private prepareDtoForRoute(
    dto: CreateMessageDto,
    route: ModelRouteResult
  ): CreateMessageDto {
    const routedDto = {
      ...dto,
      model: route.model,
      _requestedModel: dto._requestedModel || dto.model,
    }
    const compactedDto = this.applyContextCompaction(routedDto, route)

    return this.isGoogleBackend(route)
      ? this.prepareForGoogle(compactedDto)
      : compactedDto
  }

  /**
   * Whether doc creation prohibition policy should be injected.
   * Disabled by default for open-source friendliness.
   */
  private shouldEnforceDocProhibition(): boolean {
    const raw = process.env.ENFORCE_DOC_PROHIBITION?.toLowerCase()
    return raw === "true" || raw === "1"
  }

  /**
   * Inject documentation prohibition into system prompt
   * This applies to all request entry points.
   */
  private injectDocProhibition(dto: CreateMessageDto): CreateMessageDto {
    const docProhibition =
      "\n\n[CRITICAL SYSTEM RULE] You are ABSOLUTELY FORBIDDEN from " +
      "creating any documentation files (*.md, *.txt, README, CHANGELOG, etc.) unless the user " +
      "EXPLICITLY requests it. Do NOT create documentation proactively. Ask for permission first."

    // Handle system prompt - can be string or array of content blocks
    let systemText: string
    if (typeof dto.system === "string") {
      systemText = dto.system
    } else if (Array.isArray(dto.system)) {
      systemText = dto.system
        .filter(
          (block): block is { type: string; text: string } =>
            typeof block === "object" && block !== null && block.type === "text"
        )
        .map((block) => block.text)
        .join("\n")
    } else {
      systemText = ""
    }

    const newSystem = systemText + docProhibition

    return {
      ...dto,
      system: newSystem,
    }
  }

  private summarizeBackendError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return message.length > 200 ? `${message.slice(0, 200)}…` : message
  }

  private async dispatchToRoutedBackend(
    dto: CreateMessageDto,
    route: ModelRouteResult,
    forwardHeaders?: Record<string, string>,
    codexForwardHeaders?: CodexForwardHeaders
  ): Promise<AnthropicResponse> {
    if (route.backend === "claude-api") {
      this.logger.log(`[ROUTE] Claude API backend | model: ${route.model}`)
      return await this.anthropicApiService.sendClaudeMessage(
        dto,
        forwardHeaders
      )
    }

    if (route.backend === "kiro") {
      this.logger.log(`[ROUTE] Kiro backend | model: ${route.model}`)
      return await this.kiroService.sendClaudeMessage(dto)
    }

    if (route.backend === "openai-compat") {
      this.logger.log(`[ROUTE] OpenAI-compat backend | model: ${route.model}`)
      return await this.openaiCompatService.sendClaudeMessage(dto)
    }

    if (route.backend === "codex") {
      this.logger.log(`[ROUTE] Codex backend | model: ${route.model}`)
      return await this.codexService.sendClaudeMessage(dto, codexForwardHeaders)
    }

    this.logger.log(`[ROUTE] Google backend | model: ${route.model}`)
    return await this.googleService.sendClaudeMessage(dto)
  }

  /**
   * Build a stable key for the reactive-compaction circuit breaker.
   *
   * `_conversationId` is preferred when the client provides one (it gives
   * us a per-session counter), otherwise we fall back to a coarse hash of
   * the message-array length plus the model so unrelated stateless
   * requests do not share the same breaker.  The key never carries user
   * content — only structural metadata — so it is safe to log.
   */
  private buildReactiveRecoveryKey(
    dto: CreateMessageDto,
    route: ModelRouteResult
  ): string {
    if (typeof dto._conversationId === "string" && dto._conversationId) {
      return `anthropic:${dto._conversationId}`
    }
    return `anthropic:stateless:${route.backend}:${route.model}:${dto.messages.length}`
  }

  private async executeRoutedMessage(
    dto: CreateMessageDto,
    route: ModelRouteResult,
    forwardHeaders?: Record<string, string>,
    codexForwardHeaders?: CodexForwardHeaders,
    attemptedBackends: Set<string> = new Set()
  ): Promise<AnthropicResponse> {
    attemptedBackends.add(route.backend)

    try {
      if (
        route.backend === "codex" &&
        !this.codexService.supportsModel(route.model)
      ) {
        throw new BackendApiError(
          `Model ${route.model} is not supported by the configured Codex account(s).`,
          {
            backend: "codex",
            statusCode: 400,
            permanent: true,
          }
        )
      }

      const routedDto = this.prepareDtoForRoute(dto, route)
      const recoveryKey = this.buildReactiveRecoveryKey(dto, route)
      try {
        const response = await this.dispatchToRoutedBackend(
          routedDto,
          route,
          forwardHeaders,
          codexForwardHeaders
        )
        // Successful turn — drop any stale failure counter so the next
        // attempt starts from a clean slate.
        this.contextManager.resetReactiveFailures(recoveryKey)
        return response
      } catch (innerError) {
        const recovered = await this.tryReactivePromptTooLongRecovery(
          dto,
          route,
          innerError,
          recoveryKey,
          forwardHeaders,
          codexForwardHeaders
        )
        if (recovered) {
          this.contextManager.resetReactiveFailures(recoveryKey)
          return recovered
        }
        throw innerError
      }
    } catch (error) {
      const fallback = this.modelRouter.getFallbackRoute(
        dto.model,
        route.backend
      )
      const canFallback =
        !!fallback &&
        !attemptedBackends.has(fallback.backend) &&
        this.modelRouter.shouldFallbackFromBackend(
          error,
          route.backend,
          fallback.backend
        )

      if (canFallback && fallback) {
        this.logger.warn(
          `[ROUTE] ${route.backend} failed for ${dto.model}: ${this.summarizeBackendError(
            error
          )}; falling back to ${fallback.backend}`
        )
        return this.executeRoutedMessage(
          dto,
          fallback,
          forwardHeaders,
          codexForwardHeaders,
          attemptedBackends
        )
      }

      throw error
    }
  }

  /**
   * Identify upstream prompt-too-long errors and, when found, reactively
   * compact the conversation and retry the same backend once.  Returns
   * the successful response when recovery worked, otherwise `undefined`
   * so the caller can re-throw the original error.
   *
   * Recovery is gated by a circuit breaker living on
   * `ContextManagerService` so we cannot loop forever on conversations
   * whose minimum payload still exceeds the upstream cap.
   */
  private async tryReactivePromptTooLongRecovery(
    dto: CreateMessageDto,
    route: ModelRouteResult,
    error: unknown,
    recoveryKey: string,
    forwardHeaders?: Record<string, string>,
    codexForwardHeaders?: CodexForwardHeaders
  ): Promise<AnthropicResponse | undefined> {
    const detection = detectPromptTooLong(error)
    if (!detection.matched) return undefined

    const previousBudget = this.resolveContextBudget(dto, route)
    const outcome =
      this.contextManager.applyReactivePromptTooLongRecoveryFromMessages(
        dto.messages as UnifiedMessage[],
        this.EMPTY_ATTACHMENT_SNAPSHOT,
        {
          maxTokens: previousBudget.maxTokens,
          systemPromptTokens: previousBudget.systemPromptTokens,
          autoCompactTokenLimit: previousBudget.autoCompactTokenLimit,
          pendingToolUseIds: dto._pendingToolUseIds,
        },
        {
          actualTokens: detection.actualTokens,
          maxTokens: detection.maxTokens,
        },
        recoveryKey
      )
    if (!outcome.shouldRetry || !outcome.result) {
      this.logger.warn(
        `[REACTIVE-COMPACT] giving up for ${recoveryKey}: ${
          outcome.reason ?? "unknown"
        } (failures=${outcome.consecutiveFailures})`
      )
      return undefined
    }

    this.logger.warn(
      `[REACTIVE-COMPACT] retrying ${route.backend}/${route.model} after prompt-too-long: ` +
        `${dto.messages.length} → ${outcome.result.messages.length} messages`
    )

    const recoveredDto: CreateMessageDto = {
      ...dto,
      messages: outcome.result.messages as typeof dto.messages,
    }
    const routedDto = this.prepareDtoForRoute(recoveredDto, route)
    return await this.dispatchToRoutedBackend(
      routedDto,
      route,
      forwardHeaders,
      codexForwardHeaders
    )
  }

  private async *streamFromRoutedBackend(
    dto: CreateMessageDto,
    route: ModelRouteResult,
    forwardHeaders?: Record<string, string>,
    codexForwardHeaders?: CodexForwardHeaders
  ): AsyncGenerator<string, void, unknown> {
    if (route.backend === "claude-api") {
      this.logger.log(
        `[ROUTE] Claude API backend | model: ${route.model} | stream: true`
      )
      yield* this.anthropicApiService.sendClaudeMessageStream(
        dto,
        forwardHeaders
      )
      return
    }
    if (route.backend === "kiro") {
      this.logger.log(
        `[ROUTE] Kiro backend | model: ${route.model} | stream: true`
      )
      yield* this.kiroService.sendClaudeMessageStream(dto)
      return
    }
    if (route.backend === "openai-compat") {
      this.logger.log(
        `[ROUTE] OpenAI-compat backend | model: ${route.model} | stream: true`
      )
      yield* this.openaiCompatService.sendClaudeMessageStream(dto)
      return
    }
    if (route.backend === "codex") {
      this.logger.log(
        `[ROUTE] Codex backend | model: ${route.model} | stream: true`
      )
      yield* this.codexService.sendClaudeMessageStream(dto, codexForwardHeaders)
      return
    }
    this.logger.log(
      `[ROUTE] Google backend | model: ${route.model} | stream: true`
    )
    yield* this.googleService.sendClaudeMessageStream(dto)
  }

  private async *executeRoutedMessageStream(
    dto: CreateMessageDto,
    route: ModelRouteResult,
    forwardHeaders?: Record<string, string>,
    codexForwardHeaders?: CodexForwardHeaders,
    attemptedBackends: Set<string> = new Set()
  ): AsyncGenerator<string, void, unknown> {
    attemptedBackends.add(route.backend)
    let emittedAny = false
    let buffer: string[] = []

    const handleEvent = function* (event: string) {
      if (!emittedAny) {
        if (
          event.includes('"type":"message_start"') ||
          event.includes('"type":"ping"') ||
          event.includes('"type":"content_block_start"') ||
          event.includes('"type":"content_block_stop"')
        ) {
          buffer.push(event)
        } else {
          emittedAny = true
          for (const b of buffer) yield b
          buffer = []
          yield event
        }
      } else {
        yield event
      }
    }

    const recoveryKey = this.buildReactiveRecoveryKey(dto, route)

    try {
      if (
        route.backend === "codex" &&
        !this.codexService.supportsModel(route.model)
      ) {
        throw new BackendApiError(
          `Model ${route.model} is not supported by the configured Codex account(s).`,
          {
            backend: "codex",
            statusCode: 400,
            permanent: true,
          }
        )
      }

      const routedDto = this.prepareDtoForRoute(dto, route)
      try {
        for await (const event of this.streamFromRoutedBackend(
          routedDto,
          route,
          forwardHeaders,
          codexForwardHeaders
        )) {
          yield* handleEvent(event)
        }
        if (!emittedAny) {
          for (const b of buffer) yield b
        }
        this.contextManager.resetReactiveFailures(recoveryKey)
        return
      } catch (innerError) {
        // Reactive recovery is only safe before any byte has reached the
        // client.  Once we have emitted real data, the SSE stream is
        // committed and another retry would deliver duplicate events.
        if (emittedAny) {
          throw innerError
        }
        const detection = detectPromptTooLong(innerError)
        if (!detection.matched) {
          throw innerError
        }
        const previousBudget = this.resolveContextBudget(dto, route)
        const outcome =
          this.contextManager.applyReactivePromptTooLongRecoveryFromMessages(
            dto.messages as UnifiedMessage[],
            this.EMPTY_ATTACHMENT_SNAPSHOT,
            {
              maxTokens: previousBudget.maxTokens,
              systemPromptTokens: previousBudget.systemPromptTokens,
              autoCompactTokenLimit: previousBudget.autoCompactTokenLimit,
              pendingToolUseIds: dto._pendingToolUseIds,
            },
            {
              actualTokens: detection.actualTokens,
              maxTokens: detection.maxTokens,
            },
            recoveryKey
          )
        if (!outcome.shouldRetry || !outcome.result) {
          this.logger.warn(
            `[REACTIVE-COMPACT] stream giving up for ${recoveryKey}: ${
              outcome.reason ?? "unknown"
            } (failures=${outcome.consecutiveFailures})`
          )
          throw innerError
        }
        this.logger.warn(
          `[REACTIVE-COMPACT] stream retrying ${route.backend}/${route.model} after prompt-too-long: ` +
            `${dto.messages.length} → ${outcome.result.messages.length} messages`
        )
        const recoveredDto: CreateMessageDto = {
          ...dto,
          messages: outcome.result.messages as typeof dto.messages,
        }
        const retryRoutedDto = this.prepareDtoForRoute(recoveredDto, route)
        // Reset the leading-event buffer so we can replay it cleanly on
        // the retry.  emittedAny is still false here by construction.
        buffer = []
        for await (const event of this.streamFromRoutedBackend(
          retryRoutedDto,
          route,
          forwardHeaders,
          codexForwardHeaders
        )) {
          yield* handleEvent(event)
        }
        if (!emittedAny) {
          for (const b of buffer) yield b
        }
        this.contextManager.resetReactiveFailures(recoveryKey)
        return
      }
    } catch (error) {
      const fallback = this.modelRouter.getFallbackRoute(
        dto.model,
        route.backend
      )
      const canFallback =
        !emittedAny &&
        !!fallback &&
        !attemptedBackends.has(fallback.backend) &&
        this.modelRouter.shouldFallbackFromBackend(
          error,
          route.backend,
          fallback.backend
        )

      if (canFallback && fallback) {
        this.logger.warn(
          `[ROUTE] ${route.backend} stream failed for ${dto.model}: ${this.summarizeBackendError(
            error
          )}; falling back to ${fallback.backend}`
        )
        yield* this.executeRoutedMessageStream(
          dto,
          fallback,
          forwardHeaders,
          codexForwardHeaders,
          attemptedBackends
        )
        return
      }

      throw error
    }
  }

  async createMessage(
    dto: CreateMessageDto,
    forwardHeaders?: Record<string, string>,
    codexForwardHeaders?: CodexForwardHeaders
  ): Promise<AnthropicResponse> {
    this.logger.log(
      `Request for model: ${dto.model}, stream: ${dto.stream || false}`
    )

    if (this.shouldEnforceDocProhibition()) {
      dto = this.injectDocProhibition(dto)
    }

    // Use ModelRouterService for model-based routing
    const route = this.modelRouter.resolveModel(dto.model)
    return this.executeRoutedMessage(
      dto,
      route,
      forwardHeaders,
      codexForwardHeaders
    )
  }

  /**
   * Create streaming message response
   */
  async *createMessageStream(
    dto: CreateMessageDto,
    forwardHeaders?: Record<string, string>,
    codexForwardHeaders?: CodexForwardHeaders
  ): AsyncGenerator<string, void, unknown> {
    this.logger.log(`Streaming request for model: ${dto.model}`)

    if (this.shouldEnforceDocProhibition()) {
      dto = this.injectDocProhibition(dto)
    }

    // Use ModelRouterService for model-based routing
    const route = this.modelRouter.resolveModel(dto.model)
    yield* this.executeRoutedMessageStream(
      dto,
      route,
      forwardHeaders,
      codexForwardHeaders
    )
  }

  /**
   * Count tokens in a request.
   *
   * Strategy:
   * 1. Try upstream /v1/messages/count_tokens for exact results.
   * 2. Fall back to local estimation if upstream is unavailable or fails.
   *
   * Reference: https://docs.anthropic.com/en/api/messages-count-tokens
   */
  async countTokens(dto: CountTokensDto): Promise<{ input_tokens: number }> {
    this.logger.log(`Count tokens request for model: ${dto.model}`)

    // ── Upstream first ──
    try {
      const upstreamResult = await this.anthropicApiService.countTokensUpstream(
        dto as unknown as Record<string, unknown>
      )
      if (upstreamResult) {
        this.logger.debug(
          `Count tokens (upstream): ${upstreamResult.input_tokens}`
        )
        return upstreamResult
      }
    } catch (error) {
      this.logger.debug(
        `Count tokens upstream failed, falling back to local estimation: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }

    // ── Local fallback ──
    const localTokens = this.countTokensLocal(dto)
    this.logger.debug(`Count tokens (local estimate): ${localTokens}`)
    return { input_tokens: localTokens }
  }

  /**
   * Local token count estimation.
   * Less accurate than the upstream API but zero-latency and always available.
   */
  private countTokensLocal(dto: CountTokensDto): number {
    let totalTokens = 0

    // Count system prompt tokens
    if (dto.system) {
      if (typeof dto.system === "string") {
        totalTokens += this.tokenizer.countTokens(dto.system)
      } else if (Array.isArray(dto.system)) {
        for (const block of dto.system) {
          if (block.type === "text" && block.text) {
            totalTokens += this.tokenizer.countTokens(block.text)
          }
        }
      }
    }

    // Count message tokens
    for (const message of dto.messages) {
      // Base tokens per message (role, separators)
      totalTokens += 4

      // Role token
      totalTokens += this.tokenizer.countTokens(message.role, false)

      // Content tokens
      if (message.content) {
        if (typeof message.content === "string") {
          totalTokens += this.tokenizer.countTokens(message.content)
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === "text" && block.text) {
              totalTokens += this.tokenizer.countTokens(block.text)
            } else if (block.type === "tool_use" && block.input) {
              // Tool use blocks: count the JSON input
              totalTokens += this.tokenizer.countTokens(
                JSON.stringify(block.input)
              )
              totalTokens += 10 // overhead for tool_use structure
            } else if (block.type === "tool_result") {
              // Tool result blocks
              if (block.text) {
                totalTokens += this.tokenizer.countTokens(block.text)
              }
              totalTokens += 5 // overhead for tool_result structure
            }
          }
        }
      }
    }

    // Count tool definition tokens
    if (dto.tools && dto.tools.length > 0) {
      for (const tool of dto.tools) {
        if (tool.name) {
          totalTokens += this.tokenizer.countTokens(tool.name, false)
        }
        if (tool.description) {
          totalTokens += this.tokenizer.countTokens(tool.description, false)
        }
        if (tool.input_schema) {
          totalTokens += this.tokenizer.countTokens(
            JSON.stringify(tool.input_schema),
            false
          )
        }
        // Overhead per tool
        totalTokens += 10
      }
    }

    // Add message separator tokens
    totalTokens += 3

    return totalTokens
  }

  listModels() {
    const now = Math.floor(Date.now() / 1000)
    const canRouteViaGoogle = (modelId: string): boolean => {
      if (!this.modelRouter.isGoogleAvailable) {
        return false
      }

      const resolved = resolveCloudCodeModel(modelId)
      if (!resolved) {
        return false
      }

      return (
        (resolved.family !== "claude" ||
          canPublicClaudeModelUseGoogle(modelId)) &&
        this.googleModelCache.isValidModel(resolved.cloudCodeId)
      )
    }
    const canRouteViaKiro = (modelId: string): boolean => {
      if (!this.modelRouter.isKiroAvailable) {
        return false
      }
      return canPublicClaudeModelUseKiro(modelId)
    }
    const isModelAdvertisable = (modelId: string): boolean => {
      const resolved = resolveCloudCodeModel(modelId)
      if (!resolved) {
        return false
      }

      if (resolved.family === "gpt") {
        if (this.openaiCompatService.isAvailable()) {
          return this.openaiCompatService.supportsModel(resolved.cloudCodeId)
        }

        return this.codexService.supportsModel(modelId)
      }

      if (resolved.family === "gemini") {
        return canRouteViaGoogle(modelId)
      }

      return (
        this.anthropicApiService.supportsModel(modelId) ||
        canRouteViaGoogle(modelId) ||
        canRouteViaKiro(modelId)
      )
    }
    const modelMap = new Map<
      string,
      {
        id: string
        object: string
        created_at: number
        owned_by: string
        type: string
        display_name?: string
      }
    >()

    const addModel = (id: string, owner?: string) => {
      if (modelMap.has(id)) return
      const metadata = getPublicModelMetadata(id)
      const resolved = resolveCloudCodeModel(id)
      const derivedOwner =
        owner ||
        metadata?.ownedBy ||
        (resolved?.family === "gpt"
          ? "openai"
          : resolved?.family === "claude"
            ? "anthropic"
            : "google")
      modelMap.set(id, {
        id,
        object: "model",
        created_at: metadata?.createdAt || now,
        owned_by: derivedOwner,
        type: "model",
        display_name: metadata?.displayName || resolved?.displayName,
      })
    }

    // 1) Dynamic models discovered from Google backend
    for (const modelId of this.googleModelCache.getAllModelIds()) {
      addModel(modelId)
    }

    // 2) Compatibility aliases we intentionally keep for existing clients
    for (const model of this.anthropicApiService.getPublicModels()) {
      if (modelMap.has(model.id)) {
        continue
      }

      modelMap.set(model.id, {
        id: model.id,
        object: "model",
        created_at: model.createdAt || now,
        owned_by: "anthropic",
        type: "model",
        display_name: model.displayName,
      })
    }

    const compatibilityModels = [
      "gemini-2.5-flash",
      "gemini-3-flash",
      "gemini-3.1-pro-high",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
      "claude-3-7-sonnet-20250219",
      "claude-opus-4-6-thinking",
      "claude-4.6-opus",
      "claude-4.6-opus-thinking",
      "claude-sonnet-4-5",
      "claude-sonnet-4-5-thinking",
      "claude-4.5-opus-high-thinking",
    ]
    for (const modelId of compatibilityModels) {
      if (isModelAdvertisable(modelId)) {
        addModel(modelId)
      }
    }

    // Kiro-only Claude models (e.g. Haiku 4.5 / Opus 4.7) when Kiro is enabled.
    if (this.modelRouter.isKiroAvailable) {
      for (const modelId of this.kiroService.getPublicModelIds()) {
        if (canPublicClaudeModelUseKiro(modelId)) {
          addModel(modelId, "anthropic")
        }
      }
    }

    // 3) Codex models (if backend is available)
    if (this.isGptBackendAvailable()) {
      const codexModels = getCodexPublicModelIds({
        codexModelTier: this.getAdvertisedGptModelTier(),
      })
      for (const modelId of codexModels) {
        if (isModelAdvertisable(modelId)) {
          addModel(modelId, "openai")
        }
      }
    }

    const data = Array.from(modelMap.values()).sort((left, right) => {
      if (left.created_at !== right.created_at) {
        return right.created_at - left.created_at
      }
      return left.id.localeCompare(right.id)
    })

    return {
      data,
      has_more: false,
      first_id: data[0]?.id || "",
      last_id: data[data.length - 1]?.id || "",
    }
  }
}
