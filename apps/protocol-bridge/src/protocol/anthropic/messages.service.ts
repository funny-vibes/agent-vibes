import { GptRequestError } from "../../llm/shared/gpt-api-contract"
import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import * as crypto from "crypto"
import { type ContextAttachmentSnapshot } from "../../context"
import { AnthropicApiService } from "../../llm/anthropic/anthropic-api.service"
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
import { getBackendCapability } from "../../llm/shared/backend-capability"
import { BackendApiError } from "../../llm/shared/backend-errors"
import {
  runProviderPhysicalDispatch,
  runProviderPhysicalDispatchStream,
} from "../../llm/shared/provider-physical-dispatch"
import {
  canPublicClaudeModelUseGoogle,
  canPublicClaudeModelUseKiro,
  getCodexPublicModelIds,
  getPublicModelMetadata,
  resolveCloudCodeModel,
  WEB_GPT_CURSOR_DISPLAY_MODELS,
} from "../../llm/shared/model-registry"
import {
  type BackendType,
  ModelRouteResult,
  ModelRouterService,
} from "../../llm/shared/model-router.service"
import type { AnthropicResponse } from "../../shared/anthropic"
import { adaptAnthropicMessageToCodexExecutionRequest } from "./codex-request-adapter"
import { CountTokensDto } from "./dto/count-tokens.dto"
import { CreateMessageDto } from "./dto/create-message.dto"
import { TokenizerService } from "./tokenizer.service"

/**
 * MessagesService - Routes requests to Google or Codex backend.
 */
@Injectable()
export class MessagesService implements OnModuleInit {
  private readonly logger = new Logger(MessagesService.name)
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
      openaiCompatSupportsModel: () => this.openaiCompatService.isAvailable(),
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

  /**
   * CC CLI's compaction summary preamble. Both code paths
   * (runForkedAgent fork — claude-code/src/services/compact/compact.ts:1222
   * and streamCompactSummary streaming fallback — same file:1326) build
   * the user-facing `summaryRequest` via getCompactPrompt /
   * getPartialCompactPrompt (claude-code/src/services/compact/prompt.ts:282,294),
   * which unconditionally prefix this exact string. The slash-command
   * `/compact` and the autoCompact trigger share the same prompt
   * builder, so this fingerprint covers both manual and automatic
   * compaction.
   *
   * Stability rationale: the literal lives in a single CLI source file,
   * is shared by every compaction code path, and has the strongest
   * semantic anchor in the prompt body ("Tool calls will be REJECTED")
   * — it would not be edited casually. If a future CLI release renames
   * the preamble, the worst-case regression is the original death-loop
   * (compact requests rejected by preflight); detection misses fail
   * safe — a non-compact request that happens to start with this text
   * being waved through to upstream still gets the upstream's own
   * context-length error, no worse than today.
   */
  private static readonly CC_CLI_COMPACTION_USER_PREAMBLE =
    "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools."

  /**
   * Detect a CC CLI context-compaction request.
   *
   * The CLI sends the compaction "summarize this conversation" request
   * through the same POST /v1/messages endpoint as a normal turn.
   * Distinguishing it matters because preflight (below) would otherwise
   * reject it for being too large — but compaction is precisely what
   * the CLI runs to *escape* a too-large context, and a synchronous
   * rejection here strands the CLI in an unrecoverable state where
   * neither autoCompact nor `/compact` can succeed (their wire body is
   * by definition the entire current history).
   *
   * Detection: the last user message starts with the fixed
   * NO_TOOLS_PREAMBLE that prefixes every compaction summary request.
   * We check the last user message specifically because the CLI
   * appends `summaryRequest` to the existing transcript — earlier
   * messages may include unrelated content.
   */
  private isCcCliCompactionRequest(dto: CreateMessageDto): boolean {
    const messages = dto.messages
    if (!Array.isArray(messages) || messages.length === 0) return false
    let lastUser: (typeof messages)[number] | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        lastUser = messages[i]
        break
      }
    }
    if (!lastUser) return false
    const text = this.extractTextContent(lastUser.content).trimStart()
    return text.startsWith(MessagesService.CC_CLI_COMPACTION_USER_PREAMBLE)
  }

  /**
   * Preflight capacity check.
   *
   * The bridge knows two things the CLI doesn't:
   *   1. Which backend a request is actually being routed to.
   *   2. That backend's effective input cap (from BackendCapability).
   *
   * When the routed request exceeds the backend's cap, calling the
   * upstream is wasted work — every account on that backend will
   * reject identically. Throw a class-tagged BackendApiError here so
   * the catch path in executeRoutedMessage / executeRoutedMessageStream
   * routes the request to a fallback backend (with a larger cap) or,
   * if no fallback is available, surfaces a spec-compliant Anthropic
   * `prompt is too long: N tokens > M maximum` envelope to the CLI.
   * That envelope matches the prose CC CLI's autoCompact / `/compact`
   * recovery checks (claude-code/src/services/api/errors.ts:564), so
   * the CLI's own context-management pipeline kicks in.
   *
   * Two gates run in series, and either one tripping is enough to
   * reject:
   *   - Token gate: cheap, runs first. Uses `countTokensLocal` (the
   *     same estimator as the `/count_tokens` endpoint) and compares
   *     against `contextWindow.maxInputTokens`. Slightly conservative
   *     (overestimates), which is the safe direction here.
   *   - Wire-byte gate: runs second when a backend declares
   *     `contextWindow.maxWireBytes`. Some backends (Kiro / CodeWhisperer)
   *     reject on raw JSON body size rather than token count — the
   *     probe in `scripts/probe/probe-kiro-cap.mjs` confirmed Kiro
   *     rejects identically at ~2.15 MB regardless of whether the
   *     payload is mostly text padding (PURE) or a mix of tool
   *     definitions and history (TOOLED). The byte gate uses the same
   *     `JSON.stringify` shape the kiro service writes on the wire,
   *     so it matches the upstream judgement byte-for-byte.
   *
   * Compaction-request exemption: a CC CLI compaction summary request
   * (manual `/compact` or autoCompact) carries the entire current
   * transcript by construction, so once the conversation is large
   * enough to *need* compaction, the compaction request itself is
   * guaranteed to exceed any cap below the backend's true wire limit.
   * Rejecting it here creates a hard deadlock: autoCompact never fires
   * because preflight bounces it, manual `/compact` cannot succeed for
   * the same reason, and the user has no in-CLI way out. Wave the
   * compaction call through to upstream — if Kiro's wire layer really
   * rejects it (the cap isn't a fiction), the CLI's own PTL recovery
   * (claude-code/src/services/compact/compact.ts:474-515,
   * MAX_PTL_RETRIES=3 with truncateHeadForPTLRetry) takes over and
   * shrinks the input until the summary lands. That recovery path is
   * the *only* way out of the deadlock and it requires the wire-level
   * error to surface, not a synthetic preflight rejection.
   */
  private assertWithinBackendCapacity(
    dto: CreateMessageDto,
    route: ModelRouteResult
  ): void {
    const cap = getBackendCapability(route.backend)
    const maxTokens = cap.contextWindow.maxInputTokens
    const maxBytes = cap.contextWindow.maxWireBytes
    const isCompaction = this.isCcCliCompactionRequest(dto)

    // ── Token gate ──
    if (Number.isFinite(maxTokens) && maxTokens > 0) {
      const estimate = this.countTokensLocal(dto)
      if (estimate > maxTokens) {
        if (isCompaction) {
          this.logger.warn(
            `[Preflight] ${route.backend}/${route.model}: estimated ${estimate} tokens > ${maxTokens} cap, but request is a CC CLI compaction summary; bypassing preflight so the CLI's own PTL-retry recovery can run`
          )
          return
        }
        this.logger.warn(
          `[Preflight] ${route.backend}/${route.model}: estimated ${estimate} tokens > ${maxTokens} cap; throwing context_length_exceeded so router can fall back`
        )
        throw new BackendApiError(
          `prompt is too long: ${estimate} tokens > ${maxTokens} maximum`,
          {
            backend: route.backend,
            statusCode: 400,
            errorClass: "context_length_exceeded",
            actualTokens: estimate,
            maxTokens: maxTokens,
          }
        )
      }
    }

    // ── Wire-byte gate ──
    // Only stringify when the backend declares a byte cap. Stringify is
    // O(payload size); the token gate already filtered the obvious
    // over-cap cases, so the work amortizes to "near-the-limit" requests.
    if (Number.isFinite(maxBytes) && (maxBytes ?? 0) > 0) {
      // Measure the TRANSLATED Kiro payload size, not the raw Anthropic
      // DTO. The DTO carries the full tool-definition array, structured
      // content blocks, and a system array that claudeToKiro collapses
      // or drops — gating on the raw DTO false-rejects requests the
      // gateway would accept (observed: 4.14 MB DTO → 1.54 MB Kiro
      // payload, well under the 2.125 MB cap).
      const wireBytes =
        route.backend === "kiro"
          ? this.kiroService.estimateWireBytes(dto)
          : this.estimateRawDtoBytes(dto)
      if (wireBytes > (maxBytes as number)) {
        if (isCompaction) {
          this.logger.warn(
            `[Preflight] ${route.backend}/${route.model}: estimated ${wireBytes} wire bytes > ${maxBytes} cap, but request is a CC CLI compaction summary; bypassing preflight so the CLI's own PTL-retry recovery can run`
          )
          return
        }
        this.logger.warn(
          `[Preflight] ${route.backend}/${route.model}: estimated ${wireBytes} wire bytes > ${maxBytes} cap; throwing context_length_exceeded so router can fall back`
        )
        // Render as a token-shaped Anthropic envelope so CC CLI's
        // autoCompact regex (claude-code/src/services/api/errors.ts:90,
        // /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i)
        // still parses both sides. The numbers here are bytes presented
        // as tokens — slightly misleading in the literal sense, but the
        // CLI uses the gap between actual and max only to decide how
        // aggressively to truncate, so a byte-vs-byte comparison is
        // semantically correct for the recovery path.
        throw new BackendApiError(
          `prompt is too long: ${wireBytes} tokens > ${maxBytes} maximum`,
          {
            backend: route.backend,
            statusCode: 400,
            errorClass: "context_length_exceeded",
            actualTokens: wireBytes,
            maxTokens: maxBytes as number,
          }
        )
      }
    }
  }

  /**
   * Raw Anthropic-DTO JSON byte size. Used as the wire-byte estimate
   * for backends that don't translate the payload into a smaller shape.
   * For Kiro, use `kiroService.estimateWireBytes` instead — the Kiro
   * translation collapses tools / content blocks and produces a much
   * smaller payload, so the raw DTO size would over-count by ~2-3x.
   */
  private estimateRawDtoBytes(dto: CreateMessageDto): number {
    try {
      return Buffer.byteLength(JSON.stringify(dto), "utf-8")
    } catch {
      // Circular structures / unstringifiable values fall back to a
      // length-based approximation that still gives the gate a non-zero
      // signal rather than silently waving the request through.
      return JSON.stringify({
        model: dto.model,
        messageCount: dto.messages?.length ?? 0,
      }).length
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

    return this.isGoogleBackend(route)
      ? this.prepareForGoogle(routedDto)
      : routedDto
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
      return runProviderPhysicalDispatch({
        plan: {
          scope: `cc:messages:${crypto.randomUUID()}`,
          backend: "claude-api",
          model: route.model,
          request: dto,
        },
        execute: (dispatch) =>
          this.anthropicApiService.sendClaudeMessage(dispatch, {
            clientMode: "claude-code-cli",
            forwardHeaders,
          }),
      })
    }

    if (route.backend === "kiro") {
      this.logger.log(`[ROUTE] Kiro backend | model: ${route.model}`)
      const request = this.prepareKiroDtoForClaudeCli(dto)
      return runProviderPhysicalDispatch({
        plan: {
          scope: `cc:messages:${crypto.randomUUID()}`,
          backend: "kiro",
          model: route.model,
          request,
        },
        execute: (dispatch) => this.kiroService.sendClaudeMessage(dispatch),
      })
    }

    if (route.backend === "openai-compat") {
      this.logger.log(`[ROUTE] OpenAI-compat backend | model: ${route.model}`)
      return runProviderPhysicalDispatch({
        plan: {
          scope: `cc:messages:${crypto.randomUUID()}`,
          backend: "openai-compat",
          model: route.model,
          request: dto,
        },
        execute: (dispatch) =>
          this.openaiCompatService.sendClaudeMessage(dispatch),
      })
    }

    if (route.backend === "codex") {
      this.logger.log(`[ROUTE] Codex backend | model: ${route.model}`)
      const request = this.codexService.prepareBridgeNativeExecutionRequest(
        adaptAnthropicMessageToCodexExecutionRequest(dto)
      )
      return runProviderPhysicalDispatch({
        plan: {
          scope: `cc:messages:${crypto.randomUUID()}`,
          backend: "codex",
          model: route.model,
          request,
        },
        execute: (dispatch) =>
          this.codexService.sendMessage(dispatch, {
            forwardHeaders: codexForwardHeaders,
          }),
      })
    }

    this.logger.log(`[ROUTE] Google backend | model: ${route.model}`)
    return runProviderPhysicalDispatch({
      plan: {
        scope: `cc:messages:${crypto.randomUUID()}`,
        backend: route.backend,
        model: route.model,
        request: dto,
      },
      execute: (dispatch) => this.googleService.sendClaudeMessage(dispatch),
    })
  }

  private async executeRoutedMessage(
    dto: CreateMessageDto,
    route: ModelRouteResult,
    forwardHeaders?: Record<string, string>,
    codexForwardHeaders?: CodexForwardHeaders,
    attemptedBackends: Set<string> = new Set(),
    allowFallback = true
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
      this.assertWithinBackendCapacity(routedDto, route)
      // Backend errors (including class=context_length_exceeded that
      // the preflight or the upstream may surface) flow through the
      // catch below into either a cross-backend fallback or a
      // spec-compliant Anthropic envelope rendering. CLI clients ship
      // their own /compact pipelines and react to the envelope's
      // `prompt is too long: N tokens > M maximum` message — see
      // backend-error-class.ts for the rendering contract.
      const response = await this.dispatchToRoutedBackend(
        routedDto,
        route,
        forwardHeaders,
        codexForwardHeaders
      )
      return response
    } catch (error) {
      if (!allowFallback) throw error
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

  private prepareKiroDtoForClaudeCli(dto: CreateMessageDto): CreateMessageDto {
    if (!dto.system) return dto

    // POST /v1/messages is the Claude Code CLI/Anthropic-compatible entry.
    // Claude Code already sends its own harness prompt in `system`. Kiro has
    // no native system field, so the Kiro translator would otherwise wrap that
    // prompt into userInputMessage.content as `--- SYSTEM PROMPT --- ...`,
    // which the model correctly treats as external prompt-injection-like text.
    // Cursor's Kiro path does not go through this service and keeps its own
    // protocol/system projection unchanged.
    return {
      ...dto,
      system: undefined,
    }
  }

  /**
   * Reactive prompt-too-long recovery used to live here. The bridge now
   * forwards `prompt_too_long` / `context_too_large` errors straight to
   * the CLI client (matching CLIProxyAPI's transparent-proxy contract),
   * so this method has been removed. If a future change needs to act on
   * upstream context errors, do it as an explicit, opt-in protocol
   * extension rather than a silent payload mutation.
   */

  private async *streamFromRoutedBackend(
    dto: CreateMessageDto,
    route: ModelRouteResult,
    forwardHeaders?: Record<string, string>,
    codexForwardHeaders?: CodexForwardHeaders,
    onResponseBoundary?: () => void
  ): AsyncGenerator<string, void, unknown> {
    const acceptanceForValue = (_dispatch: unknown, event: string) => {
      const acceptance = this.acceptanceForRoutedStreamEvent(event)
      if (acceptance !== undefined) {
        onResponseBoundary?.()
      }
      return acceptance
    }
    if (route.backend === "claude-api") {
      this.logger.log(
        `[ROUTE] Claude API backend | model: ${route.model} | stream: true`
      )
      yield* runProviderPhysicalDispatchStream({
        plan: {
          scope: `cc:messages:${crypto.randomUUID()}`,
          backend: "claude-api",
          model: route.model,
          request: dto,
        },
        execute: (dispatch) =>
          this.anthropicApiService.sendClaudeMessageStream(dispatch, {
            clientMode: "claude-code-cli",
            forwardHeaders,
          }),
        acceptanceForValue,
      })
      return
    }
    if (route.backend === "kiro") {
      this.logger.log(
        `[ROUTE] Kiro backend | model: ${route.model} | stream: true`
      )
      const request = this.prepareKiroDtoForClaudeCli(dto)
      yield* runProviderPhysicalDispatchStream({
        plan: {
          scope: `cc:messages:${crypto.randomUUID()}`,
          backend: "kiro",
          model: route.model,
          request,
        },
        execute: (dispatch) =>
          this.kiroService.sendClaudeMessageStream(dispatch),
        acceptanceForValue,
      })
      return
    }
    if (route.backend === "openai-compat") {
      this.logger.log(
        `[ROUTE] OpenAI-compat backend | model: ${route.model} | stream: true`
      )
      yield* runProviderPhysicalDispatchStream({
        plan: {
          scope: `cc:messages:${crypto.randomUUID()}`,
          backend: "openai-compat",
          model: route.model,
          request: dto,
        },
        execute: (dispatch) =>
          this.openaiCompatService.sendClaudeMessageStream(dispatch),
        acceptanceForValue,
      })
      return
    }
    if (route.backend === "codex") {
      this.logger.log(
        `[ROUTE] Codex backend | model: ${route.model} | stream: true`
      )
      const request = this.codexService.prepareBridgeNativeExecutionRequest(
        adaptAnthropicMessageToCodexExecutionRequest(dto)
      )
      yield* runProviderPhysicalDispatchStream({
        plan: {
          scope: `cc:messages:${crypto.randomUUID()}`,
          backend: "codex",
          model: route.model,
          request,
        },
        execute: (dispatch) =>
          this.codexService.sendMessageStream(dispatch, {
            forwardHeaders: codexForwardHeaders,
          }),
        acceptanceForValue,
      })
      return
    }
    this.logger.log(
      `[ROUTE] Google backend | model: ${route.model} | stream: true`
    )
    yield* runProviderPhysicalDispatchStream({
      plan: {
        scope: `cc:messages:${crypto.randomUUID()}`,
        backend: route.backend,
        model: route.model,
        request: dto,
      },
      execute: (dispatch) =>
        this.googleService.sendClaudeMessageStream(dispatch),
      acceptanceForValue,
    })
  }

  private acceptanceForRoutedStreamEvent(
    event: string
  ): Record<string, never> | undefined {
    const type = this.readAnthropicSseFrameType(event)
    return type === "message_start" ||
      type === "ping" ||
      type === "content_block_start" ||
      type === "content_block_stop"
      ? undefined
      : {}
  }

  private readAnthropicSseFrameType(event: string): string | undefined {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
    if (!data || data === "[DONE]") {
      return undefined
    }

    try {
      const payload = JSON.parse(data) as { type?: unknown }
      return typeof payload.type === "string" ? payload.type : undefined
    } catch {
      return undefined
    }
  }

  private async *executeRoutedMessageStream(
    dto: CreateMessageDto,
    route: ModelRouteResult,
    forwardHeaders?: Record<string, string>,
    codexForwardHeaders?: CodexForwardHeaders,
    attemptedBackends: Set<string> = new Set(),
    allowFallback = true
  ): AsyncGenerator<string, void, unknown> {
    attemptedBackends.add(route.backend)
    let responseBoundaryCrossed = false

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
      this.assertWithinBackendCapacity(routedDto, route)
      // Backend errors flow through the catch below into either a
      // cross-backend fallback or a spec-compliant Anthropic envelope
      // (services/api/errors.ts:564 in claude-code: CC CLI's
      // autoCompact / `/compact` recovery key off the canonical
      // "prompt is too long: N tokens > M maximum" message that
      // backend-error-class.ts produces).
      for await (const event of this.streamFromRoutedBackend(
        routedDto,
        route,
        forwardHeaders,
        codexForwardHeaders,
        () => {
          responseBoundaryCrossed = true
        }
      )) {
        yield event
      }
      return
    } catch (error) {
      if (!allowFallback) throw error
      const fallback = this.modelRouter.getFallbackRoute(
        dto.model,
        route.backend
      )
      const canFallback =
        !responseBoundaryCrossed &&
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
    codexForwardHeaders?: CodexForwardHeaders,
    requiredBackend?: "codex"
  ): Promise<AnthropicResponse> {
    this.logger.log(
      `Request for model: ${dto.model}, stream: ${dto.stream || false}`
    )

    if (this.shouldEnforceDocProhibition()) {
      dto = this.injectDocProhibition(dto)
    }

    // Use ModelRouterService for model-based routing
    const route = this.modelRouter.resolveModel(dto.model)
    if (requiredBackend && route.backend !== requiredBackend) {
      throw new GptRequestError(
        "The model is not available through provider: codex",
        "model"
      )
    }
    return this.executeRoutedMessage(
      dto,
      route,
      forwardHeaders,
      codexForwardHeaders,
      new Set(),
      !requiredBackend
    )
  }

  /**
   * Create streaming message response
   */
  async *createMessageStream(
    dto: CreateMessageDto,
    forwardHeaders?: Record<string, string>,
    codexForwardHeaders?: CodexForwardHeaders,
    requiredBackend?: "codex"
  ): AsyncGenerator<string, void, unknown> {
    this.logger.log(`Streaming request for model: ${dto.model}`)

    if (this.shouldEnforceDocProhibition()) {
      dto = this.injectDocProhibition(dto)
    }

    // Use ModelRouterService for model-based routing
    const route = this.modelRouter.resolveModel(dto.model)
    if (requiredBackend && route.backend !== requiredBackend) {
      throw new GptRequestError(
        "The model is not available through provider: codex",
        "model"
      )
    }
    yield* this.executeRoutedMessageStream(
      dto,
      route,
      forwardHeaders,
      codexForwardHeaders,
      new Set(),
      !requiredBackend
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
        dto as unknown as Record<string, unknown>,
        { clientMode: "claude-code-cli" }
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
              // Tool result blocks. The content surface varies:
              //   - shorthand: `{type:'tool_result', text:'...'}` (legacy)
              //   - structured: `{type:'tool_result', content: '...'}`
              //                 or `{type:'tool_result', content: [{type:'text', text:'...'}, ...]}`
              //                 (the CC CLI / Anthropic-spec common case)
              //
              // The previous version only counted `block.text` so a result
              // shipped as `content` (string or array) was estimated as
              // ~5 tokens. With many tool_result blocks this drove the
              // capacity preflight several orders of magnitude under the
              // real token cost — see preflight bypass at 8:09:25 in
              // bridge logs (2 MB body, no [Preflight] warning, Kiro
              // accepted then a downstream call hit the wire cap).
              const tr = block as {
                text?: string
                content?: unknown
              }
              if (typeof tr.text === "string" && tr.text.length > 0) {
                totalTokens += this.tokenizer.countTokens(tr.text)
              }
              if (typeof tr.content === "string") {
                totalTokens += this.tokenizer.countTokens(tr.content)
              } else if (Array.isArray(tr.content)) {
                for (const part of tr.content) {
                  if (!part || typeof part !== "object") continue
                  const p = part as { type?: string; text?: string }
                  if (p.type === "text" && typeof p.text === "string") {
                    totalTokens += this.tokenizer.countTokens(p.text)
                  } else if (p.type === "image") {
                    // Same image baseline as the top-level image block
                    // case below — base64 length is wire-byte size, not
                    // model-side token cost.
                    totalTokens += 1500
                  } else {
                    // Other non-text parts (rare): conservative serialization
                    // estimate so they're never counted as zero.
                    totalTokens += Math.ceil(JSON.stringify(part).length / 4)
                  }
                }
              }
              totalTokens += 5 // overhead for tool_result structure
            } else if (block.type === "image") {
              // Image blocks: use Anthropic's baseline token cost per
              // inlined image. Earlier this estimated by base64 length
              // (Math.ceil(data.length / 4)) — that conflates wire-byte
              // size with model-side token cost. A high-DPI screenshot
              // is ~200 KB base64, which the wrong estimate priced at
              // ~50K tokens; 14 such images on a single turn (a normal
              // CC CLI screenshot batch) inflated the estimate by
              // ~700K tokens and tripped preflight even when the real
              // token budget was nowhere near full.
              //
              // Anthropic's documented per-image cost is roughly
              // `(width * height) / 750` for vision, with a typical
              // claim of ~1500-2500 tokens per screenshot. Without
              // dimensions in the wire payload we can't compute that
              // precisely, so use the documented baseline. The wire-
              // byte gate still catches cases where the JSON body
              // genuinely exceeds Kiro's ~2.15 MB cap.
              totalTokens += 1500
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
          return true
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
        max_input_tokens?: number
      }
    >()

    /**
     * Pick the most generous context window across the backends that
     * could route this model. Surfaced to clients so their local
     * auto-compact thresholds (e.g. claude-code's
     * `getContextWindowForModel` reading `cap.max_input_tokens`) match
     * what the bridge can actually deliver. When the model is served
     * only by a small-window backend (Kiro), this returns the smaller
     * number so the client compacts before wire overflow rather than
     * after — see backend-capability.ts:contextWindow.advertisedToCC.
     */
    const resolveAdvertisedWindow = (modelId: string): number | undefined => {
      const candidates: BackendType[] = []
      const resolved = resolveCloudCodeModel(modelId)
      if (
        resolved &&
        resolved.family === "claude" &&
        this.anthropicApiService.supportsModel(modelId)
      ) {
        candidates.push("claude-api")
      }
      if (canRouteViaGoogle(modelId)) {
        candidates.push(
          resolved?.family === "claude" ? "google-claude" : "google"
        )
      }
      if (canRouteViaKiro(modelId)) candidates.push("kiro")
      // GPT family handled separately — it doesn't use the BackendCapability
      // window since codex / openai-compat have their own per-model caps.
      if (candidates.length === 0) return undefined
      let best = 0
      for (const backend of candidates) {
        const cap = getBackendCapability(backend)
        if (cap.contextWindow.advertisedToCC > best) {
          best = cap.contextWindow.advertisedToCC
        }
      }
      return best > 0 ? best : undefined
    }

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
        max_input_tokens: resolveAdvertisedWindow(id),
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

    // ChatGPT Web models are advertised unconditionally, and deliberately not
    // through isModelAdvertisable: that gate asks whether Codex serves the id,
    // and the interesting ones here (the *-pro tier) have no Codex equivalent
    // at all. The route is opt-in by name, and an unconfigured deployment
    // already answers with a specific error rather than a silent failure.
    for (const model of WEB_GPT_CURSOR_DISPLAY_MODELS) {
      modelMap.set(model.name, {
        id: model.name,
        object: "model",
        created_at: now,
        owned_by: "openai",
        type: "model",
        display_name: model.displayName,
      })
    }

    const data = Array.from(modelMap.values()).sort((left, right) => {
      if (left.created_at !== right.created_at) {
        return right.created_at - left.created_at
      }
      return left.id.localeCompare(right.id)
    })

    return {
      object: "list",
      data: data.map((model) => ({
        ...model,
        // OpenAI SDK `Model` reads `created` (unix seconds); keep `created_at`
        // for existing Anthropic-style clients. A single /v1/models endpoint
        // thus satisfies both protocol surfaces.
        created: model.created_at,
      })),
      has_more: false,
      first_id: data[0]?.id || "",
      last_id: data[data.length - 1]?.id || "",
    }
  }
}
