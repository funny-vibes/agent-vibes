import { HttpException, Injectable, Logger } from "@nestjs/common"
import {
  canPublicClaudeModelUseGoogle,
  detectModelFamily,
  doesModelSupportThinking,
  isOpusModel,
  resolveCloudCodeModel,
} from "./model-registry"
import {
  BackendAccountPoolUnavailableError,
  BackendApiError,
} from "./shared/backend-errors"

function isGptThinkingModel(model: string): boolean {
  const normalized = model.toLowerCase().trim()
  return (
    normalized.startsWith("o3") ||
    normalized.startsWith("o4") ||
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("codex")
  )
}

/**
 * Backend types for routing.
 * - google: Gemini-family models via Google Cloud Code
 * - google-claude: Claude family models served by Google Cloud Code
 * - codex: OpenAI GPT/O-series models via Codex reverse proxy
 * - openai-compat: Third-party OpenAI-compatible API (Chat Completions)
 * - claude-api: Anthropic-compatible Claude API with third-party key/account pool
 */
export type BackendType =
  | "google"
  | "google-claude"
  | "codex"
  | "openai-compat"
  | "claude-api"

/**
 * Model routing result
 */
export interface ModelRouteResult {
  backend: BackendType
  model: string
  isThinking: boolean
}

export interface GptBackendCandidates {
  primary: ModelRouteResult
  fallbacks: ModelRouteResult[]
}

@Injectable()
export class ModelRouterService {
  private readonly logger = new Logger(ModelRouterService.name)

  private googleAvailable = false
  private codexAvailable = false
  private openaiCompatAvailable = false
  private claudeApiAvailable = false
  private codexAvailabilityProvider?: () => boolean
  private openaiCompatAvailabilityProvider?: () => boolean
  private claudeApiAvailabilityProvider?: (model: string) => boolean

  /**
   * Keep availability check so startup behavior remains explicit.
   */
  async initializeRouting(
    googleCheck: () => Promise<boolean>,
    codexCheck?: () => Promise<boolean>,
    openaiCompatCheck?: () => Promise<boolean>,
    claudeApiCheck?: () => Promise<boolean>
  ): Promise<void> {
    this.logger.log("=== Testing Backend APIs ===")

    this.googleAvailable = await googleCheck().catch((e) => {
      this.logger.error(
        `Google Cloud Code check error: ${(e as Error).message}`
      )
      return false
    })

    if (codexCheck) {
      this.codexAvailable = await codexCheck().catch((e) => {
        this.logger.error(`Codex check error: ${(e as Error).message}`)
        return false
      })
    }

    if (openaiCompatCheck) {
      this.openaiCompatAvailable = await openaiCompatCheck().catch((e) => {
        this.logger.error(
          `OpenAI-compatible check error: ${(e as Error).message}`
        )
        return false
      })
    }

    if (claudeApiCheck) {
      this.claudeApiAvailable = await claudeApiCheck().catch((e) => {
        this.logger.error(`Claude API check error: ${(e as Error).message}`)
        return false
      })
    }

    this.logger.log("=== Backend Availability ===")
    this.logger.log(`  Google Cloud Code: ${this.googleAvailable ? "✓" : "✗"}`)
    this.logger.log(`  Codex (OpenAI):    ${this.codexAvailable ? "✓" : "✗"}`)
    this.logger.log(
      `  OpenAI-Compat:     ${this.openaiCompatAvailable ? "✓" : "✗"}`
    )
    this.logger.log(
      `  Claude API:        ${this.claudeApiAvailable ? "✓" : "✗"}`
    )
    this.logger.log("=== Routing Decision ===")
    this.logger.log("  Gemini models       -> Google backend")
    if (this.claudeApiAvailable && this.googleAvailable) {
      this.logger.log(
        "  Claude models       -> Capability-based routing (Claude API or Google)"
      )
    } else if (this.claudeApiAvailable) {
      this.logger.log("  Claude models       -> Claude API backend")
    } else {
      this.logger.log("  Claude models       -> Google backend")
    }
    if (this.codexAvailable && this.openaiCompatAvailable) {
      this.logger.log(
        "  GPT/O-series models  -> Codex backend (priority, OpenAI-compatible fallback)"
      )
    } else if (this.codexAvailable) {
      this.logger.log("  GPT/O-series models  -> Codex backend")
    } else if (this.openaiCompatAvailable) {
      this.logger.log(
        "  GPT/O-series models  -> OpenAI-compatible backend (fallback only)"
      )
    } else {
      this.logger.log(
        "  GPT/O-series models  -> ERROR (no GPT backend configured)"
      )
    }
    this.logger.log("========================")
  }

  /** Backend availability getters for startup banner */
  get isGoogleAvailable(): boolean {
    return this.googleAvailable
  }

  /** Update Google backend availability at runtime (e.g. after account sync) */
  updateGoogleAvailability(available: boolean): void {
    if (this.googleAvailable !== available) {
      this.logger.log(
        `Google backend availability updated: ${this.googleAvailable ? "✓" : "✗"} -> ${available ? "✓" : "✗"}`
      )
      this.googleAvailable = available
    }
  }
  get isCodexAvailable(): boolean {
    return this.codexAvailable
  }
  get isOpenaiCompatAvailable(): boolean {
    return this.openaiCompatAvailable
  }
  get isClaudeApiAvailable(): boolean {
    return this.claudeApiAvailable
  }

  setGptAvailabilityProviders(providers: {
    codex?: () => boolean
    openaiCompat?: () => boolean
  }): void {
    this.codexAvailabilityProvider = providers.codex
    this.openaiCompatAvailabilityProvider = providers.openaiCompat
  }

  setClaudeAvailabilityProvider(provider?: (model: string) => boolean): void {
    this.claudeApiAvailabilityProvider = provider
  }

  private getCodexAvailability(): boolean {
    return this.codexAvailabilityProvider
      ? this.codexAvailabilityProvider()
      : this.codexAvailable
  }

  private getOpenaiCompatAvailability(): boolean {
    return this.openaiCompatAvailabilityProvider
      ? this.openaiCompatAvailabilityProvider()
      : this.openaiCompatAvailable
  }

  private getClaudeApiAvailability(model: string): boolean {
    return this.claudeApiAvailabilityProvider
      ? this.claudeApiAvailabilityProvider(model)
      : this.claudeApiAvailable
  }

  private buildGptBackendCandidatesFromTarget(target: {
    model: string
    isThinking: boolean
  }): GptBackendCandidates | null {
    const candidates: ModelRouteResult[] = []
    const openaiCompatAvailable = this.getOpenaiCompatAvailability()
    const codexAvailable = this.getCodexAvailability()

    // Codex first, openai-compat as fallback
    if (codexAvailable) {
      candidates.push({
        backend: "codex",
        model: target.model,
        isThinking: target.isThinking,
      })
    }

    if (openaiCompatAvailable) {
      candidates.push({
        backend: "openai-compat",
        model: target.model,
        isThinking: target.isThinking,
      })
    }

    if (candidates.length === 0) {
      return null
    }

    return {
      primary: candidates[0]!,
      fallbacks: candidates.slice(1),
    }
  }

  private resolveGptTarget(cursorModel: string): {
    model: string
    isThinking: boolean
  } | null {
    const normalized = cursorModel.toLowerCase().trim()
    const entry = resolveCloudCodeModel(normalized)

    if (entry?.family === "gpt") {
      return {
        model: entry.cloudCodeId,
        isThinking: entry.isThinking,
      }
    }

    if (detectModelFamily(normalized) !== "gpt") {
      return null
    }

    return {
      model: normalized,
      isThinking: isGptThinkingModel(normalized),
    }
  }

  getGptBackendCandidates(cursorModel: string): GptBackendCandidates | null {
    const target = this.resolveGptTarget(cursorModel)
    if (!target) {
      return null
    }
    return this.buildGptBackendCandidatesFromTarget(target)
  }

  private buildClaudeBackendCandidates(
    cursorModel: string
  ): GptBackendCandidates | null {
    const normalized = cursorModel.toLowerCase().trim()
    const family = detectModelFamily(normalized)
    const claudeApiAvailable = this.getClaudeApiAvailability(cursorModel)
    const hasExplicitClaudeMapping =
      this.claudeApiAvailabilityProvider != null && claudeApiAvailable

    if (!hasExplicitClaudeMapping && family !== "claude") {
      return null
    }

    const candidates: ModelRouteResult[] = []
    const entry = resolveCloudCodeModel(normalized)
    const isOpus = isOpusModel(normalized)

    // Claude API can expose aliases such as "latest" that do not match
    // the registry/family heuristics, so honor explicit support first.
    if (claudeApiAvailable) {
      candidates.push({
        backend: "claude-api",
        model: normalized,
        isThinking: entry?.isThinking ?? doesModelSupportThinking(normalized),
      })
    }

    if (this.googleAvailable) {
      if (isOpus) {
        // Opus models always route through google-claude
        if (canPublicClaudeModelUseGoogle(normalized)) {
          const opusCloudCodeId =
            entry?.family === "claude"
              ? entry.cloudCodeId
              : "claude-opus-4-6-thinking"
          candidates.push({
            backend: "google-claude",
            model: opusCloudCodeId,
            isThinking: true,
          })
        }
      } else if (entry && canPublicClaudeModelUseGoogle(normalized)) {
        // Non-Opus Claude models (Sonnet, Haiku, etc.) → use Gemini instead
        // to save Claude quota for important tasks.
        // Guard: only redirect known, valid Claude model IDs — unknown or
        // misspelled IDs fall through so they surface an unsupported-model error.
        // We still use google-claude backend to keep shouldFallbackFromBackend()
        // claude-api ↔ google-claude pair working correctly.
        this.logger.log(
          `[ROUTE] Non-Opus Claude model "${cursorModel}" redirected to Gemini 3.1 Pro High`
        )
        candidates.push({
          backend: "google-claude",
          model: "gemini-3.1-pro-high",
          isThinking: false,
        })
      }
    }

    if (candidates.length === 0) {
      return null
    }

    return {
      primary: candidates[0]!,
      fallbacks: candidates.slice(1),
    }
  }

  getFallbackRoute(
    cursorModel: string,
    currentBackend: BackendType
  ): ModelRouteResult | null {
    const candidates =
      this.getGptBackendCandidates(cursorModel) ||
      this.buildClaudeBackendCandidates(cursorModel)
    if (!candidates) {
      return null
    }

    const ordered = [candidates.primary, ...candidates.fallbacks]
    return (
      ordered.find((candidate) => candidate.backend !== currentBackend) || null
    )
  }

  private parseBackendErrorStatus(error: unknown): number | null {
    if (error instanceof HttpException) {
      return error.getStatus()
    }

    if (error instanceof BackendApiError) {
      return typeof error.statusCode === "number" ? error.statusCode : null
    }

    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : ""
    const match = message.match(/(?:api error|status=|status\s)(\d{3})/i)
    if (!match?.[1]) {
      return null
    }

    const status = Number.parseInt(match[1], 10)
    return Number.isFinite(status) ? status : null
  }

  shouldFallbackFromBackend(
    error: unknown,
    currentBackend: BackendType,
    fallbackBackend?: BackendType
  ): boolean {
    if (!fallbackBackend) {
      return false
    }

    if (
      (currentBackend !== "openai-compat" && currentBackend !== "codex") ||
      (fallbackBackend !== "openai-compat" && fallbackBackend !== "codex")
    ) {
      const claudePair =
        (currentBackend === "claude-api" &&
          fallbackBackend === "google-claude") ||
        (currentBackend === "google-claude" && fallbackBackend === "claude-api")
      if (!claudePair) {
        return false
      }
    }

    const message =
      error instanceof Error
        ? error.message.toLowerCase()
        : typeof error === "string"
          ? error.toLowerCase()
          : ""
    const status = this.parseBackendErrorStatus(error)

    if (error instanceof BackendAccountPoolUnavailableError) {
      return true
    }

    if (status != null) {
      if ([401, 403, 404, 408, 409, 429, 500, 502, 503, 504].includes(status)) {
        return true
      }

      if (status === 400) {
        return /model|provider|upstream|quota|rate limit|unavailable|unsupported|overloaded|temporar/.test(
          message
        )
      }

      if (status === 422) {
        return false
      }
    }

    return /timeout|timed out|fetch failed|socket hang up|econn|enotfound|eai_again|network|html page|anti-bot|captcha|blocked|not configured|missing api key|missing base url|no available providers|temporarily unavailable|service unavailable|quota|rate(?:-| )limit(?:ed)?|retry after|all openai-compat accounts|all claude api accounts|anthropic/.test(
      message
    )
  }

  /**
   * Strip vendor prefixes like "anthropic/", "openai/", "google/" from model IDs.
   * Claude Code CLI sends model IDs such as "anthropic/claude-sonnet-4.6".
   */
  private stripVendorPrefix(model: string): string {
    const trimmed = model.trim()
    const slashIndex = trimmed.indexOf("/")
    if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
      return trimmed
    }
    const prefix = trimmed.slice(0, slashIndex).toLowerCase()
    if (["anthropic", "openai", "google", "meta"].includes(prefix)) {
      return trimmed.slice(slashIndex + 1)
    }
    return trimmed
  }

  /**
   * Resolve model to appropriate backend.
   * Uses unified model-registry for all name resolution.
   */
  resolveModel(cursorModel: string): ModelRouteResult {
    const stripped = this.stripVendorPrefix(cursorModel)
    const normalized = stripped.toLowerCase().trim()
    const family = detectModelFamily(normalized)
    const entry = resolveCloudCodeModel(normalized)
    const gptCandidates = this.getGptBackendCandidates(stripped)
    const claudeCandidates = this.buildClaudeBackendCandidates(stripped)

    // 1. Known model with registry entry
    if (entry) {
      // GPT family → codex (priority) > openai-compat
      if (entry.family === "gpt") {
        if (gptCandidates) {
          const route = gptCandidates.primary
          const fallbackSuffix = gptCandidates.fallbacks.length
            ? ` | fallback=${gptCandidates.fallbacks.map((candidate) => candidate.backend).join(",")}`
            : ""
          this.logger.log(
            `[ROUTE] ${cursorModel} -> ${route.backend} | ${entry.cloudCodeId}${fallbackSuffix}`
          )
          return route
        }

        throw new Error(
          `No GPT backend available for model ${cursorModel}. ` +
            `Configure OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_API_KEY or CODEX_API_KEY.`
        )
      }

      // Claude → Claude API (priority) or Google
      if (entry.family === "claude") {
        if (claudeCandidates) {
          const route = claudeCandidates.primary
          const fallbackSuffix = claudeCandidates.fallbacks.length
            ? ` | fallback=${claudeCandidates.fallbacks.map((candidate) => candidate.backend).join(",")}`
            : ""
          this.logger.log(
            `[ROUTE] ${cursorModel} -> ${route.backend} | ${route.model}${fallbackSuffix}`
          )
          return route
        }

        throw new Error(
          `No Claude backend available for model ${cursorModel}. ` +
            `Configure CLAUDE_API_KEY or keep Google Cloud Code available.`
        )
      }

      // Gemini → Google backend
      const backend: BackendType = entry.isClaudeThroughGoogle
        ? "google-claude"
        : "google"
      this.logger.log(
        `[ROUTE] ${cursorModel} -> Google Cloud Code${entry.isClaudeThroughGoogle ? " Claude" : ""} | ${entry.cloudCodeId}`
      )
      return {
        backend,
        model: entry.cloudCodeId,
        isThinking: entry.isThinking,
      }
    }

    // 2. Claude model supported by third-party backend even if not in registry
    if (claudeCandidates) {
      const route = claudeCandidates.primary
      const fallbackSuffix = claudeCandidates.fallbacks.length
        ? ` | fallback=${claudeCandidates.fallbacks.map((candidate) => candidate.backend).join(",")}`
        : ""
      this.logger.log(
        `[ROUTE] ${cursorModel} -> ${route.backend} | ${route.model}${fallbackSuffix}`
      )
      return route
    }

    // 3. GPT family -> codex > openai-compat
    if (family === "gpt") {
      if (gptCandidates) {
        const route = gptCandidates.primary
        const fallbackSuffix = gptCandidates.fallbacks.length
          ? ` | fallback=${gptCandidates.fallbacks.map((candidate) => candidate.backend).join(",")}`
          : ""
        this.logger.log(
          `[ROUTE] ${cursorModel} -> ${route.backend} | ${route.model}${fallbackSuffix}`
        )
        return route
      }

      throw new Error(
        `No GPT backend available for model ${cursorModel}. ` +
          `Configure OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_API_KEY or CODEX_API_KEY.`
      )
    }

    // 4. Unknown Claude variant not in registry
    if (family === "claude") {
      throw new Error(
        `Unknown Claude model ${cursorModel}. ` +
          `Add a Claude API account model alias mapping or use a registry-supported Claude model.`
      )
    }

    // 5. Unknown model family
    throw new Error(
      `Unknown model ${cursorModel}. Supported families: gemini, claude, gpt/o-series.`
    )
  }
}
