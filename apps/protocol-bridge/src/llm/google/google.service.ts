import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as crypto from "crypto"
import { TokenCounterService } from "../../context/token-counter.service"
import { normalizeToolProtocolMessages } from "../../context/tool-protocol-normalizer"
import { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"
import type { AnthropicResponse, ContentBlock } from "../../shared/anthropic"
import { DEFAULT_CLAUDE_MODEL, resolveCloudCodeModel } from "../model-registry"
import { ProcessPoolService } from "../native/process-pool.service"
import { findPendingToolUseIdsInMessages } from "../tool-continuation-policy"
import { ANTIGRAVITY_SYSTEM_PROMPT } from "./antigravity-system-prompt"
import { ToolThoughtSignatureService } from "./tool-thought-signature.service"

class FatalCloudCodeRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FatalCloudCodeRequestError"
  }
}

/**
 * GoogleService - Cloud Code API integration with Google Search grounding
 *
 * Features:
 * - Cloud Code API for Gemini models
 * - Google Search grounding for web_search tool
 * - Response format conversion
 */
@Injectable()
export class GoogleService {
  private readonly logger = new Logger(GoogleService.name)
  private readonly ANTIGRAVITY_IDE_VERSION = "1.19.6"

  // Official Antigravity system prompt baked into source.
  private readonly officialSystemPrompt = ANTIGRAVITY_SYSTEM_PROMPT

  // Stable sessionId for Cloud Code API requests.
  // Official Antigravity generates one per IDE session (a signed 64-bit integer).
  // We generate one per process lifetime to match that behavior.
  private readonly sessionId: string

  // Per-conversation request ID tracking
  // Matches Antigravity format: agent/{currentTs}/{conversationUUID}/{seq}
  // Each conversation gets its own UUID and monotonic sequence counter
  private readonly conversationSessions = new Map<
    string,
    { uuid: string; seq: number }
  >()
  // Fallback for requests without a conversationId (e.g., direct Anthropic API calls)
  private readonly fallbackSession = { uuid: crypto.randomUUID(), seq: 0 }

  // Retry configuration
  private readonly MAX_RETRIES: number = 3
  private readonly PRIME_RETRY_DELAYS = [2000, 3000, 5000] // ms between attempt retries
  private readonly BASE_RETRY_DELAY = 1200 // Base for 429 without retryDelay (ms)
  private readonly MAX_RETRY_DELAY = 60000 // Cap for exponential backoff (60s for rate limit recovery)
  private readonly MAX_429_WAIT_MS = 3 * 60 * 1000 // Cap API retryMs (3 min), allow longer recovery
  private readonly QUOTA_EXHAUSTED_DEFAULT_COOLDOWN_MS = 3 * 60 * 1000 // Fallback cooldown when quota exhausted but no reset time parsed (aligned with MAX_429_WAIT_MS)
  private readonly MAX_PROMPT_SHRINK_RETRIES: number = 3
  private readonly CLOUD_CODE_DEFAULT_OUTPUT_TOKENS: number = 65536
  private readonly CLOUD_CODE_MAX_OUTPUT_TOKENS: number = 65536
  private readonly CLOUD_CODE_MIN_OUTPUT_TOKENS: number = 256
  // Hard token limit for Cloud Code API (from Anthropic error messages)
  private readonly CLOUD_CODE_HARD_TOKEN_LIMIT = 200_000

  // Session management configuration
  private readonly CONVERSATION_SESSION_TTL_MS: number
  private readonly CONVERSATION_SESSION_MAX_SIZE: number

  // CHECKPOINT counter for Antigravity-style context truncation.
  // Incremented each time enforceTokenBudget or tryShrinkPayload injects a CHECKPOINT summary.
  private checkpointCounter = 0

  private readonly toolNameById = new Map<
    string,
    { name: string; updatedAt: number }
  >()
  private readonly conversationMetricContextById = new Map<
    string,
    { projectId?: string; traceId?: string; updatedAt: number }
  >()
  private lastToolNameCacheCleanupAt = 0
  private lastConversationMetricContextCleanupAt = 0
  private readonly TOOL_NAME_CACHE_TTL_MS = 24 * 60 * 60 * 1000
  private readonly TOOL_NAME_CACHE_MAX_SIZE = 4096
  private readonly CONVERSATION_METRIC_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000
  private readonly CONVERSATION_METRIC_CONTEXT_MAX_SIZE = 4096

  /**
   * Parse duration string like "1.203608125s" or "1h16m0.667923083s" to milliseconds
   */
  private parseDurationMs(
    durationStr: string | null | undefined
  ): number | null {
    if (!durationStr) return null
    const str = String(durationStr).trim()
    if (!str) return null

    let totalMs = 0
    let matched = false
    const re = /([\d.]+)\s*(ms|s|m|h)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(str)) !== null) {
      matched = true
      const value = parseFloat(m[1] || "0")
      if (!Number.isFinite(value)) continue
      const unit = m[2]
      if (unit === "ms") totalMs += value
      else if (unit === "s") totalMs += value * 1000
      else if (unit === "m") totalMs += value * 60 * 1000
      else if (unit === "h") totalMs += value * 60 * 60 * 1000
    }
    if (!matched) return null
    return Math.round(totalMs)
  }

  private getTelemetryPlatform(): string {
    const platformMap: Record<string, string> = {
      darwin: "DARWIN",
      linux: "LINUX",
      win32: "WINDOWS",
    }
    const archMap: Record<string, string> = {
      arm64: "ARM64",
      x64: "AMD64",
      ia32: "386",
    }
    const platform =
      platformMap[process.platform] || process.platform.toUpperCase()
    const arch = archMap[process.arch] || process.arch.toUpperCase()
    return `${platform}_${arch}`
  }

  private formatTelemetryDurationNs(durationNs: bigint): string {
    const seconds = Number(durationNs) / 1_000_000_000
    return `${seconds.toFixed(9)}s`
  }

  private getCloudCodeTraceId(source: unknown): string | null {
    if (!source || typeof source !== "object") return null
    const meta = (source as { __cloudCodeMeta?: unknown }).__cloudCodeMeta
    if (!meta || typeof meta !== "object") return null
    const traceId = (meta as { traceId?: unknown }).traceId
    if (typeof traceId !== "string" || traceId.trim() === "") return null
    return traceId.trim()
  }

  private getTrajectoryIdFromPayload(payload: Record<string, unknown>): string {
    const requestId =
      typeof payload.requestId === "string" ? payload.requestId.trim() : ""
    const match = /^agent\/\d+\/([^/]+)\/\d+$/.exec(requestId)
    if (match?.[1]) return match[1]
    return this.fallbackSession.uuid
  }

  private cleanupConversationMetricContext(force: boolean = false): void {
    const now = Date.now()
    if (
      !force &&
      now - this.lastConversationMetricContextCleanupAt < 5 * 60 * 1000 &&
      this.conversationMetricContextById.size <
        this.CONVERSATION_METRIC_CONTEXT_MAX_SIZE
    ) {
      return
    }

    this.lastConversationMetricContextCleanupAt = now
    for (const [conversationId, entry] of this.conversationMetricContextById) {
      if (
        (!entry.projectId && !entry.traceId) ||
        now - entry.updatedAt > this.CONVERSATION_METRIC_CONTEXT_TTL_MS
      ) {
        this.conversationMetricContextById.delete(conversationId)
      }
    }

    if (
      this.conversationMetricContextById.size <=
      this.CONVERSATION_METRIC_CONTEXT_MAX_SIZE
    ) {
      return
    }

    const entries = Array.from(
      this.conversationMetricContextById.entries()
    ).sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    const overflow =
      this.conversationMetricContextById.size -
      this.CONVERSATION_METRIC_CONTEXT_MAX_SIZE
    for (let index = 0; index < overflow; index++) {
      const conversationId = entries[index]?.[0]
      if (conversationId) {
        this.conversationMetricContextById.delete(conversationId)
      }
    }
  }

  private rememberConversationMetricContext(
    dto: CreateMessageDto,
    payload: Record<string, unknown>,
    traceId?: string | null
  ): void {
    const conversationId =
      typeof dto._conversationId === "string" ? dto._conversationId.trim() : ""
    if (!conversationId) return

    const projectId =
      typeof payload.project === "string" ? payload.project.trim() : ""
    const normalizedTraceId = typeof traceId === "string" ? traceId.trim() : ""
    const existing = this.conversationMetricContextById.get(conversationId)

    this.conversationMetricContextById.set(conversationId, {
      projectId: projectId || existing?.projectId,
      traceId: normalizedTraceId || existing?.traceId,
      updatedAt: Date.now(),
    })
    this.cleanupConversationMetricContext()
  }

  private getConversationMetricContext(
    conversationId?: string | null
  ): { projectId?: string; traceId?: string } | null {
    const normalizedConversationId =
      typeof conversationId === "string" ? conversationId.trim() : ""
    if (!normalizedConversationId) return null

    const entry = this.conversationMetricContextById.get(
      normalizedConversationId
    )
    if (!entry) return null
    if (
      Date.now() - entry.updatedAt >
      this.CONVERSATION_METRIC_CONTEXT_TTL_MS
    ) {
      this.conversationMetricContextById.delete(normalizedConversationId)
      return null
    }

    entry.updatedAt = Date.now()
    return {
      projectId: entry.projectId,
      traceId: entry.traceId,
    }
  }

  private async recordConversationOfferedMetric(args: {
    payload: Record<string, unknown>
    traceId?: string | null
    firstMessageDurationNs?: bigint | null
    totalDurationNs: bigint
  }): Promise<void> {
    const metricsPayload: Record<string, unknown> = {
      requestId: crypto.randomUUID(),
      metadata: {
        ideType: "ANTIGRAVITY",
        ideVersion: this.ANTIGRAVITY_IDE_VERSION,
        platform: this.getTelemetryPlatform(),
      },
      metrics: [
        {
          timestamp: new Date().toISOString(),
          conversationOffered: {
            status: "ACTION_STATUS_NO_ERROR",
            streamingLatency: {
              firstMessageLatency: this.formatTelemetryDurationNs(
                args.firstMessageDurationNs ?? args.totalDurationNs
              ),
              totalLatency: this.formatTelemetryDurationNs(
                args.totalDurationNs
              ),
            },
            isAgentic: true,
            initiationMethod: "AGENT",
            trajectoryId: this.getTrajectoryIdFromPayload(args.payload),
          },
        },
      ],
    }

    if (
      typeof args.payload.project === "string" &&
      args.payload.project.trim().length > 0
    ) {
      metricsPayload.project = args.payload.project.trim()
    }

    const conversationOffered = (
      (metricsPayload.metrics as Array<Record<string, unknown>>)[0] as Record<
        string,
        unknown
      >
    ).conversationOffered as Record<string, unknown>
    if (args.traceId) {
      conversationOffered.traceId = args.traceId
    }

    try {
      await this.processPool.recordCodeAssistMetrics(metricsPayload)
    } catch (error) {
      this.logger.debug(
        `recordCodeAssistMetrics failed: ${(error as Error).message}`
      )
    }
  }

  /**
   * Parse retry delay from 429 error response
   * Order: RetryInfo.retryDelay -> ErrorInfo.metadata.quotaResetDelay -> error.message regex
   */
  private parseRetryDelayMs(errText: string): number | null {
    try {
      const errObj = JSON.parse(errText) as {
        error?: {
          message?: string
          details?: Array<{
            "@type"?: string
            retryDelay?: string
            metadata?: { quotaResetDelay?: string }
          }>
        }
      }
      const details = errObj.error?.details || []

      // RetryInfo.retryDelay like "1.203608125s"
      const retryInfo = details.find((d) => d["@type"]?.includes("RetryInfo"))
      if (retryInfo?.retryDelay) {
        const ms = this.parseDurationMs(retryInfo.retryDelay)
        if (ms != null) return ms
      }

      // ErrorInfo.metadata.quotaResetDelay or details[].metadata.quotaResetDelay
      const metaDelay =
        details.find((d) => d["@type"]?.includes("ErrorInfo"))?.metadata
          ?.quotaResetDelay ??
        details.find((d) => d.metadata?.quotaResetDelay)?.metadata
          ?.quotaResetDelay
      if (metaDelay) {
        const ms = this.parseDurationMs(metaDelay)
        if (ms != null) return ms
      }

      // Fallback: error.message "Your quota will reset after Xs."
      const message = errObj.error?.message ?? ""
      const match = message.match(/after\s+(\d+)s\.?/i)
      if (match?.[1]) {
        const seconds = parseInt(match[1], 10)
        if (Number.isFinite(seconds)) return seconds * 1000
      }
    } catch {
      // Ignore JSON parse errors
    }
    return null
  }

  /**
   * Get 429 retry delay: use parsed retryMs if available (capped), else exponential backoff
   */
  private get429RetryDelay(retryMs: number | null, attempt: number): number {
    if (retryMs !== null && retryMs >= 0) {
      const capped = Math.min(retryMs + 200, this.MAX_429_WAIT_MS)
      return Math.max(0, capped)
    }
    const backoff = this.BASE_RETRY_DELAY * Math.pow(2, Math.min(attempt, 4))
    return Math.min(backoff, this.MAX_RETRY_DELAY)
  }

  /**
   * Detect quota-exhausted 429 (deterministic, hours/days reset) vs transient rate limit.
   * Quota-exhausted errors should use the full reset duration as cooldown, uncapped.
   */
  private isQuotaExhausted(errMsg: string): boolean {
    return (
      errMsg.includes("QUOTA_EXHAUSTED") ||
      errMsg.includes("exhausted your capacity")
    )
  }

  private parsePromptTooLongTokens(
    errorBody: string
  ): { actual: number; max: number } | null {
    // Google API encodes > as \u003e in JSON responses, so we need to
    // match both the literal > and the unicode escape \u003e
    const match = errorBody.match(
      /prompt is too long:\s*(\d+)\s*tokens\s*(?:>|\\u003e)\s*(\d+)\s*maximum/i
    )
    if (!match?.[1] || !match?.[2]) return null

    const actual = Number.parseInt(match[1], 10)
    const max = Number.parseInt(match[2], 10)
    if (!Number.isFinite(actual) || !Number.isFinite(max)) return null

    return { actual, max }
  }

  private extractCloudCodeErrorText(errorBody: string): string {
    const parts: string[] = [errorBody]

    // Try to find and parse JSON from the error body.
    // Worker errors have a text prefix like "Cloud Code streamGenerateContent stream failed: 400 {...}"
    // so we need to find the first '{' and try to parse from there.
    const jsonCandidates: string[] = [errorBody]
    const firstBrace = errorBody.indexOf("{")
    if (firstBrace > 0) {
      jsonCandidates.push(errorBody.slice(firstBrace))
    }

    for (const candidate of jsonCandidates) {
      try {
        const parsed = JSON.parse(candidate) as {
          error?: { message?: unknown; status?: unknown }
        }
        const outerMessage = parsed.error?.message
        if (typeof outerMessage === "string" && outerMessage.length > 0) {
          parts.push(outerMessage)
          try {
            const nested = JSON.parse(outerMessage) as {
              type?: unknown
              error?: { type?: unknown; message?: unknown }
              request_id?: unknown
            }
            if (typeof nested.type === "string") parts.push(nested.type)
            if (typeof nested.error?.type === "string") {
              parts.push(nested.error.type)
            }
            if (typeof nested.error?.message === "string") {
              parts.push(nested.error.message)
            }
            if (typeof nested.request_id === "string") {
              parts.push(nested.request_id)
            }
          } catch {
            // Ignore nested parse failures.
          }
        }
        if (typeof parsed.error?.status === "string") {
          parts.push(parsed.error.status)
        }
        break // Successfully parsed, no need to try other candidates
      } catch {
        // Try next candidate
      }
    }

    return parts.join("\n")
  }

  private isDeterministicInvalidRequest(errorBody: string): boolean {
    const normalized = this.extractCloudCodeErrorText(errorBody)
    if (normalized.includes("invalid_request_error")) return true
    return this.parsePromptTooLongTokens(normalized) !== null
  }

  private buildInvalidRequestErrorMessage(errorBody: string): string {
    const normalized = this.extractCloudCodeErrorText(errorBody)
    const promptTooLong = this.parsePromptTooLongTokens(normalized)
    if (promptTooLong) {
      return `Cloud Code request exceeds prompt limit: ${promptTooLong.actual} > ${promptTooLong.max} tokens`
    }
    return `Cloud Code API invalid_request_error: ${normalized.slice(0, 500)}`
  }

  /**
   * Adaptive fallback when Cloud Code reports prompt-too-long.
   * Shrinks oldest request contents while preserving latest turns.
   */
  private tryShrinkPayloadContentsForPromptLimit(
    payload: Record<string, unknown>,
    promptLimit: { actual: number; max: number },
    shrinkAttempt: number
  ): {
    dropped: number
    remaining: number
    removedFunctionResponses: number
  } | null {
    const request = payload.request
    if (!request || typeof request !== "object") return null
    const requestObj = request as Record<string, unknown>
    const contentsValue = requestObj.contents
    if (!Array.isArray(contentsValue)) return null

    const originalContents = contentsValue as Array<Record<string, unknown>>
    if (originalContents.length <= 1) return null

    // Reserve extra headroom because backend-side tokenization/wrapping is stricter.
    const safetyHeadroom = 8192 + shrinkAttempt * 2048
    const targetTokens = Math.max(1, promptLimit.max - safetyHeadroom)
    const requiredRatio = Math.max(
      0.08,
      Math.min(
        0.75,
        (promptLimit.actual - targetTokens) / Math.max(promptLimit.actual, 1)
      )
    )

    let dropCount = Math.ceil(originalContents.length * requiredRatio)
    dropCount = Math.max(1, Math.min(dropCount, originalContents.length - 1))

    const droppedContents = originalContents.slice(0, dropCount)
    const trimmed = originalContents.slice(dropCount)
    if (trimmed.length <= 0) return null

    const normalized = this.normalizeContentsForPromptShrink(trimmed)
    if (normalized.length <= 0) return null

    let removedFunctionResponses = 0
    for (const msg of normalized) {
      if (!msg || typeof msg !== "object") continue
      const removed = (msg as { __removedFunctionResponses?: number })
        .__removedFunctionResponses
      if (typeof removed === "number" && removed > 0) {
        removedFunctionResponses += removed
      }
      delete (msg as { __removedFunctionResponses?: number })
        .__removedFunctionResponses
    }

    // CHECKPOINT: inject structured summary instead of silently dropping
    const checkpointMessage = this.buildCheckpointMessage(droppedContents)
    requestObj.contents = [checkpointMessage, ...normalized]

    return {
      dropped: originalContents.length - normalized.length,
      remaining: (requestObj.contents as unknown[]).length,
      removedFunctionResponses,
    }
  }

  private normalizeContentsForPromptShrink(
    contents: Array<Record<string, unknown>>
  ): Array<Record<string, unknown>> {
    if (!Array.isArray(contents) || contents.length === 0) return []

    const normalized: Array<Record<string, unknown>> = []

    for (const message of contents) {
      if (!message || typeof message !== "object") continue

      const role = message.role
      if (role !== "user" && role !== "model") continue

      const rawParts = Array.isArray(message.parts)
        ? (message.parts as unknown[])
        : []
      const parts = rawParts.filter(
        (part): part is Record<string, unknown> =>
          !!part && typeof part === "object"
      )
      if (parts.length === 0) continue

      let filteredParts = parts
      let removedFunctionResponses = 0

      if (role === "user") {
        const previous = normalized[normalized.length - 1]
        const allowedFunctionResponseIds =
          previous?.role === "model"
            ? this.extractFunctionCallIdsFromParts(previous.parts)
            : new Set<string>()

        filteredParts = parts.filter((part) => {
          if (!("functionResponse" in part)) return true
          const functionResponse = part.functionResponse
          if (!functionResponse || typeof functionResponse !== "object") {
            removedFunctionResponses++
            return false
          }

          const toolUseId =
            typeof (functionResponse as { id?: unknown }).id === "string"
              ? ((functionResponse as { id?: string }).id ?? "")
              : ""
          const isValid =
            toolUseId.length > 0 && allowedFunctionResponseIds.has(toolUseId)
          if (!isValid) {
            removedFunctionResponses++
          }
          return isValid
        })
      }

      if (filteredParts.length === 0) continue

      const clonedMessage: Record<string, unknown> = {
        ...message,
        role,
        parts: filteredParts,
      }
      if (removedFunctionResponses > 0) {
        clonedMessage.__removedFunctionResponses = removedFunctionResponses
      }

      normalized.push(clonedMessage)
    }

    while (
      normalized.length > 1 &&
      (normalized[0] as { role?: unknown })?.role === "model"
    ) {
      normalized.shift()
    }

    // Backward pass: strip orphan functionCall parts from model messages
    // that have no matching functionResponse in the next user message.
    // Without this, Claude returns 400: "tool_use ids were found without
    // tool_result blocks immediately after".
    for (let i = normalized.length - 1; i >= 0; i--) {
      const msg = normalized[i]!
      if (msg.role !== "model") continue
      const parts = msg.parts as Array<Record<string, unknown>> | undefined
      if (!Array.isArray(parts)) continue

      const hasFunctionCall = parts.some((p) => "functionCall" in p)
      if (!hasFunctionCall) continue

      // Collect functionResponse IDs from the next message (must be user)
      const nextMsg = i + 1 < normalized.length ? normalized[i + 1] : undefined
      const allowedResponseIds =
        nextMsg?.role === "user"
          ? this.extractFunctionResponseIdsFromParts(nextMsg.parts)
          : new Set<string>()

      const filtered = parts.filter((part) => {
        if (!("functionCall" in part)) return true
        const fc = part.functionCall as { id?: string } | undefined
        const callId = typeof fc?.id === "string" ? fc.id : ""
        return callId.length > 0 && allowedResponseIds.has(callId)
      })

      if (filtered.length === 0) {
        normalized.splice(i, 1)
      } else if (filtered.length < parts.length) {
        msg.parts = filtered
      }
    }

    return normalized
  }

  private extractFunctionCallIdsFromParts(parts: unknown): Set<string> {
    const ids = new Set<string>()
    if (!Array.isArray(parts)) return ids

    for (const part of parts) {
      if (!part || typeof part !== "object") continue
      const functionCall = (part as { functionCall?: unknown }).functionCall
      if (!functionCall || typeof functionCall !== "object") continue

      const callId =
        typeof (functionCall as { id?: unknown }).id === "string"
          ? ((functionCall as { id?: string }).id ?? "")
          : ""
      if (callId) ids.add(callId)
    }

    return ids
  }

  private extractFunctionResponseIdsFromParts(parts: unknown): Set<string> {
    const ids = new Set<string>()
    if (!Array.isArray(parts)) return ids

    for (const part of parts) {
      if (!part || typeof part !== "object") continue
      const functionResponse = (part as { functionResponse?: unknown })
        .functionResponse
      if (!functionResponse || typeof functionResponse !== "object") continue

      const responseId =
        typeof (functionResponse as { id?: unknown }).id === "string"
          ? ((functionResponse as { id?: string }).id ?? "")
          : ""
      if (responseId) ids.add(responseId)
    }

    return ids
  }

  /**
   * Sleep utility with optional timer unref for non-blocking
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      if (timer && typeof timer.unref === "function") {
        timer.unref()
      }
    })
  }

  private cleanupToolNameCache(force: boolean = false): void {
    const now = Date.now()
    if (
      !force &&
      now - this.lastToolNameCacheCleanupAt < 5 * 60 * 1000 &&
      this.toolNameById.size < this.TOOL_NAME_CACHE_MAX_SIZE
    ) {
      return
    }

    this.lastToolNameCacheCleanupAt = now
    for (const [toolUseId, entry] of this.toolNameById.entries()) {
      if (!entry?.name || now - entry.updatedAt > this.TOOL_NAME_CACHE_TTL_MS) {
        this.toolNameById.delete(toolUseId)
      }
    }

    if (this.toolNameById.size <= this.TOOL_NAME_CACHE_MAX_SIZE) return

    const entries = Array.from(this.toolNameById.entries()).sort(
      (left, right) => left[1].updatedAt - right[1].updatedAt
    )
    const overflow = this.toolNameById.size - this.TOOL_NAME_CACHE_MAX_SIZE
    for (let index = 0; index < overflow; index++) {
      const toolUseId = entries[index]?.[0]
      if (toolUseId) this.toolNameById.delete(toolUseId)
    }
  }

  private rememberToolName(toolUseId: string, toolName: string): void {
    const normalizedId = toolUseId.trim()
    const normalizedName = toolName.trim()
    if (!normalizedId || !normalizedName) return
    this.toolNameById.set(normalizedId, {
      name: normalizedName,
      updatedAt: Date.now(),
    })
    this.cleanupToolNameCache()
  }

  private getToolName(toolUseId: string): string | null {
    const normalizedId = toolUseId.trim()
    if (!normalizedId) return null
    const entry = this.toolNameById.get(normalizedId)
    if (!entry) return null
    if (Date.now() - entry.updatedAt > this.TOOL_NAME_CACHE_TTL_MS) {
      this.toolNameById.delete(normalizedId)
      return null
    }
    entry.updatedAt = Date.now()
    return entry.name
  }

  private extractToolResultOutput(content: unknown): string {
    if (typeof content === "string") {
      return content
    }
    if (Array.isArray(content)) {
      return (content as unknown[])
        .filter(
          (item): item is { type: string; text?: unknown } =>
            !!item &&
            typeof item === "object" &&
            (item as Record<string, unknown>).type === "text"
        )
        .map((item) => (typeof item.text === "string" ? item.text : ""))
        .join("\n")
    }
    if (content == null) return ""
    if (typeof content === "object") {
      try {
        return JSON.stringify(content)
      } catch {
        return "[object]"
      }
    }
    return typeof content === "symbol"
      ? content.toString()
      : `${content as string}`
  }

  private resolveFunctionResponseName(block: Record<string, unknown>): string {
    const explicitName = typeof block.name === "string" ? block.name.trim() : ""
    if (explicitName) return explicitName

    const toolUseId =
      typeof block.tool_use_id === "string" ? block.tool_use_id.trim() : ""
    if (!toolUseId) return "unknown"

    return this.getToolName(toolUseId) || "unknown"
  }

  // Note: CLAUDE_MODEL_MAPPING has been moved to model-registry.ts
  // Note: DEFAULT_CLAUDE_MODEL is imported from model-registry.ts

  constructor(
    private readonly configService: ConfigService,
    private readonly processPool: ProcessPoolService,
    private readonly signatureStore: ToolThoughtSignatureService,
    private readonly tokenCounter: TokenCounterService
  ) {
    this.logger.log(
      `Loaded built-in Antigravity system prompt (${this.officialSystemPrompt.length} chars)`
    )

    // Generate a stable sessionId for this process lifetime.
    // Official Antigravity uses a signed 64-bit integer (e.g. -3750763034362895579).
    // We generate one from 8 random bytes interpreted as a signed BigInt.
    const buf = crypto.randomBytes(8)
    const unsigned = buf.readBigUInt64BE()
    // Convert to signed 64-bit range
    const signed =
      unsigned > BigInt("9223372036854775807")
        ? unsigned - BigInt("18446744073709551616")
        : unsigned
    this.sessionId = signed.toString()
    this.logger.log(`Session ID for Cloud Code requests: ${this.sessionId}`)
  }

  /**
   * Check if Google Cloud Code API is actually available
   * Delegates to native process pool for availability check
   */
  async checkAvailability(): Promise<boolean> {
    if (!this.processPool.isConfigured()) {
      this.logger.warn(
        "Google Cloud Code API not configured (no native workers)"
      )
      return false
    }

    try {
      this.logger.log("Testing Google Cloud Code API availability...")
      const available = await this.processPool.checkAvailability()

      if (available) {
        this.logger.log("Google Cloud Code API check: ✓ Available")
        return true
      }

      this.logger.warn("Google Cloud Code API check: ✗ Request failed")
      return false
    } catch (error) {
      this.logger.error(
        `Google Cloud Code API check failed: ${(error as Error).message}`
      )
      return false
    }
  }

  /**
   * Check if model is a thinking model
   */
  private isThinkingModel(model: string): boolean {
    const normalized = model.toLowerCase()
    return normalized.includes("thinking")
  }

  /**
   * Approximate token usage of the official system prompt.
   * Uses tiktoken + Claude correction factor for consistency.
   */
  getSystemPromptTokenEstimate(): number {
    return this.tokenCounter.countText(this.officialSystemPrompt)
  }

  /**
   * Enforce token budget on a complete Cloud Code payload before sending.
   *
   * This is the **single source of truth** for ensuring payloads stay within
   * the Cloud Code API hard limit. It operates on the final Google-format
   * payload (after all conversions, system prompt injection, etc.) so
   * nothing can slip through.
   *
   * If the estimated token count exceeds the limit, contents (conversation
   * history) are trimmed from the oldest entries until the budget is met.
   */
  private enforceTokenBudget(
    payload: Record<string, unknown>,
    hardLimit: number = this.CLOUD_CODE_HARD_TOKEN_LIMIT
  ): { enforced: boolean; originalTokens: number; finalTokens: number } {
    const estimatedTokens = this.tokenCounter.countGooglePayloadTokens(
      payload as Parameters<TokenCounterService["countGooglePayloadTokens"]>[0]
    )

    if (estimatedTokens <= hardLimit) {
      return {
        enforced: false,
        originalTokens: estimatedTokens,
        finalTokens: estimatedTokens,
      }
    }

    this.logger.warn(
      `[enforceTokenBudget] Payload exceeds hard limit: ${estimatedTokens} > ${hardLimit}, generating CHECKPOINT`
    )

    const request = payload.request as Record<string, unknown> | undefined
    if (!request) {
      this.logger.error(
        "[enforceTokenBudget] No request in payload, cannot trim"
      )
      return {
        enforced: false,
        originalTokens: estimatedTokens,
        finalTokens: estimatedTokens,
      }
    }

    const contents = request.contents as
      | Array<Record<string, unknown>>
      | undefined
    if (!Array.isArray(contents) || contents.length <= 1) {
      this.logger.warn(
        "[enforceTokenBudget] Contents too short to trim, sending as-is"
      )
      return {
        enforced: false,
        originalTokens: estimatedTokens,
        finalTokens: estimatedTokens,
      }
    }

    // Iteratively drop oldest entries and inject CHECKPOINT summary
    // (matching Antigravity IDE's CHECKPOINT mechanism)
    const maxIterations = 10
    let currentContents = contents
    let currentTokens = estimatedTokens
    let allDroppedContents: Array<Record<string, unknown>> = []

    for (let i = 0; i < maxIterations && currentTokens > hardLimit; i++) {
      if (currentContents.length <= 1) break

      // Calculate how many to drop based on overshoot ratio
      const overRatio = (currentTokens - hardLimit) / currentTokens
      const dropCount = Math.max(
        1,
        Math.ceil(currentContents.length * Math.min(overRatio * 1.2, 0.5))
      )
      const safeDrop = Math.min(dropCount, currentContents.length - 1)

      // Collect dropped messages for CHECKPOINT summary
      const dropped = currentContents.slice(0, safeDrop)
      allDroppedContents = [...allDroppedContents, ...dropped]
      currentContents = currentContents.slice(safeDrop)

      // Normalize: ensure first message is from user role
      currentContents = this.normalizeContentsForPromptShrink(currentContents)
      if (currentContents.length <= 0) {
        this.logger.error(
          "[enforceTokenBudget] Normalization left empty contents"
        )
        break
      }

      // Inject CHECKPOINT summary as first message
      const checkpointMessage = this.buildCheckpointMessage(allDroppedContents)
      currentContents = [checkpointMessage, ...currentContents]

      request.contents = currentContents
      currentTokens = this.tokenCounter.countGooglePayloadTokens(
        payload as Parameters<
          TokenCounterService["countGooglePayloadTokens"]
        >[0]
      )

      this.logger.log(
        `[enforceTokenBudget] CHECKPOINT ${this.checkpointCounter}: dropped ${safeDrop} entries, ` +
          `${currentContents.length} remaining, ${currentTokens} tokens`
      )
    }

    return {
      enforced: true,
      originalTokens: estimatedTokens,
      finalTokens: currentTokens,
    }
  }

  /**
   * Build a CHECKPOINT message from dropped contents.
   * Matches Antigravity IDE's {{ CHECKPOINT N }} format:
   * - Extracts user objectives from first user message
   * - Extracts code interactions (functionCall/functionResponse) with file paths
   * - Generates a conversation summary from text content
   */
  private buildCheckpointMessage(
    droppedContents: Array<Record<string, unknown>>
  ): Record<string, unknown> {
    this.checkpointCounter++
    const checkpointNumber = this.checkpointCounter

    // Extract user objective from first user message
    let userObjective = ""
    for (const msg of droppedContents) {
      if (msg.role !== "user") continue
      const parts = msg.parts as Array<Record<string, unknown>> | undefined
      if (!parts) continue
      for (const part of parts) {
        if (typeof part.text === "string" && part.text.length > 0) {
          // Take first meaningful user text as objective (limit to 500 chars)
          userObjective = part.text.slice(0, 500)
          break
        }
      }
      if (userObjective) break
    }

    // Extract code interactions (file paths from functionCall/functionResponse)
    const editedFiles = new Set<string>()
    const viewedFiles = new Set<string>()
    const toolsUsed = new Set<string>()

    for (const msg of droppedContents) {
      const parts = msg.parts as Array<Record<string, unknown>> | undefined
      if (!parts) continue
      for (const part of parts) {
        // functionCall
        const fc = part.functionCall as Record<string, unknown> | undefined
        if (fc && typeof fc.name === "string") {
          toolsUsed.add(fc.name)
          const args = fc.args as Record<string, unknown> | undefined
          if (args) {
            // Extract file paths from common tool argument patterns
            const filePath =
              (typeof args.TargetFile === "string" && args.TargetFile) ||
              (typeof args.AbsolutePath === "string" && args.AbsolutePath) ||
              (typeof args.File === "string" && args.File) ||
              (typeof args.path === "string" && args.path) ||
              (typeof args.SearchPath === "string" && args.SearchPath)
            if (filePath) {
              const editTools = new Set([
                "replace_file_content",
                "multi_replace_file_content",
                "write_to_file",
              ])
              if (editTools.has(fc.name)) {
                editedFiles.add(filePath)
              } else {
                viewedFiles.add(filePath)
              }
            }
          }
        }
      }
    }

    // Build conversation summary from text content
    const summaryParts: string[] = []
    let charBudget = 2000
    for (const msg of droppedContents) {
      if (charBudget <= 0) break
      const role = msg.role === "model" ? "Assistant" : "User"
      const parts = msg.parts as Array<Record<string, unknown>> | undefined
      if (!parts) continue
      for (const part of parts) {
        if (charBudget <= 0) break
        if (typeof part.text === "string" && part.text.length > 0) {
          const snippet = part.text.slice(0, Math.min(200, charBudget))
          summaryParts.push(
            `${role}: ${snippet}${part.text.length > 200 ? "..." : ""}`
          )
          charBudget -= snippet.length
        }
      }
    }

    // Assemble CHECKPOINT text (matching official Antigravity format)
    const lines: string[] = [
      `{{ CHECKPOINT ${checkpointNumber} }}`,
      ` **The earlier parts of this conversation have been truncated due to its long length. The following content summarizes the truncated context so that you may continue your work. **`,
      "",
    ]

    if (userObjective) {
      lines.push("# USER Objective:")
      lines.push(userObjective)
      lines.push("")
    }

    if (summaryParts.length > 0) {
      lines.push("# Previous Session Summary:")
      lines.push(summaryParts.join("\n"))
      lines.push("")
    }

    if (editedFiles.size > 0 || viewedFiles.size > 0) {
      lines.push("# Code Interaction Summary:")
      for (const f of editedFiles) {
        lines.push(`<edited_file>`)
        lines.push(`\t<target_file>${f}</target_file>`)
        lines.push(`</edited_file>`)
      }
      for (const f of viewedFiles) {
        lines.push(`<viewed_file>`)
        lines.push(`\t<absolute_path>${f}</absolute_path>`)
        lines.push(`</viewed_file>`)
      }
      lines.push("")
    }

    if (toolsUsed.size > 0) {
      lines.push(
        `Tools used in truncated context: ${Array.from(toolsUsed).join(", ")}`
      )
      lines.push("")
    }

    lines.push(
      "**IMPORTANT: this summary is just for your reference. You may respond to my previous and future messages, but DO NOT ACKNOWLEDGE THIS CHECKPOINT MESSAGE. JUST READ IT BUT DO NOT MENTION IT, RESPOND TO IT, OR TAKE ACTION BECAUSE OF IT.**"
    )

    this.logger.log(
      `[CHECKPOINT ${checkpointNumber}] Generated summary: ` +
        `${editedFiles.size} edited, ${viewedFiles.size} viewed, ` +
        `${toolsUsed.size} tools, ${summaryParts.length} conversation snippets`
    )

    return {
      role: "user",
      parts: [{ text: lines.join("\n") }],
    }
  }

  /**
   * Execute grounded web search via Cloud Code API (requestType=web_search).
   * Routed through native Worker IPC for proper OAuth authentication.
   */
  async executeWebSearch(query: string): Promise<string> {
    const normalizedQuery = query.trim()
    if (!normalizedQuery) return ""

    if (!this.processPool.isConfigured()) {
      throw new Error("Google Cloud Code API not configured for web_search")
    }

    try {
      const data = (await this.processPool.webSearch(
        normalizedQuery
      )) as Record<string, unknown>
      const responseData = this.unwrapCloudCodeResponse(data)
      const text = this.extractGenerateContentText(responseData)
      const references = this.extractGenerateContentReferences(responseData)
      return this.withWebSearchSources(text, references)
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      throw new Error(`web_search failed: ${errMsg}`)
    }
  }

  /**
   * Generate a tab name via Cloud Code, matching the official Antigravity IDE
   * backend pattern exactly:
   *   model = "tab_flash_lite_preview"
   *   requestType = "tab"
   *   temperature = 0.2, thinkingBudget = 0
   *
   * @param contents Cloud Code-format conversation contents
   * @returns Generated text, or empty string on failure
   */
  async generateTabName(
    contents: Array<{ role: string; parts: Array<{ text: string }> }>
  ): Promise<string> {
    if (!this.processPool.isConfigured()) return ""
    try {
      // Prepend a system instruction to make the model generate a short tab name
      // instead of responding to the user's question
      const tabNamingContents = [
        {
          role: "user" as const,
          parts: [
            {
              text:
                "Based on the following conversation, generate a very short title (3-8 words, no quotes, no markdown, no punctuation at the end) that summarizes the topic. Reply with ONLY the title, nothing else.\n\n" +
                contents
                  .map((c) => c.parts.map((p) => p.text).join(" "))
                  .join("\n"),
            },
          ],
        },
      ]

      const payload = {
        project: "",
        model: "tab_flash_lite_preview",
        request: {
          contents: tabNamingContents,
          generationConfig: {
            temperature: 0.2,
            topP: 1,
            topK: 40,
            candidateCount: 1,
            maxOutputTokens: 32,
            thinkingConfig: {
              includeThoughts: false,
              thinkingBudget: 0,
            },
          },
        },
        userAgent: "antigravity",
        requestType: "tab",
        requestId: `tab/${crypto.randomUUID()}`,
      }
      const data = (await this.processPool.generate(payload)) as Record<
        string,
        unknown
      >
      const responseData = this.unwrapCloudCodeResponse(data)
      const rawName = this.extractGenerateContentText(responseData).trim()
      // Sanitize: take only the first line, strip quotes, limit length
      const firstLine = rawName.split("\n")[0]?.trim() || ""
      const cleaned = firstLine.replace(/^["']+|["']+$/g, "").trim()
      return cleaned.length > 0 && cleaned.length <= 80
        ? cleaned
        : cleaned.slice(0, 80) || ""
    } catch (error) {
      this.logger.warn(
        `generateTabName failed: ${error instanceof Error ? error.message : String(error)}`
      )
      return ""
    }
  }

  private extractGenerateContentText(
    response: Record<string, unknown>
  ): string {
    const candidatesValue = response.candidates
    if (!Array.isArray(candidatesValue)) return ""

    for (const candidate of candidatesValue) {
      if (!candidate || typeof candidate !== "object") continue
      const content = (candidate as { content?: unknown }).content
      if (!content || typeof content !== "object") continue

      const parts = (content as { parts?: unknown }).parts
      if (!Array.isArray(parts)) continue

      const textParts: string[] = []
      for (const part of parts) {
        if (!part || typeof part !== "object") continue
        const text = (part as { text?: unknown }).text
        if (typeof text === "string" && text.trim() !== "") {
          textParts.push(text)
        }
      }
      if (textParts.length > 0) {
        return textParts.join("\n")
      }
    }

    return ""
  }

  private unwrapCloudCodeResponse(
    response: Record<string, unknown>
  ): Record<string, unknown> {
    const wrapped = response.response
    if (wrapped && typeof wrapped === "object") {
      return wrapped as Record<string, unknown>
    }
    return response
  }

  private extractGenerateContentReferences(
    response: Record<string, unknown>
  ): Array<{ title: string; url: string; chunk: string }> {
    const references: Array<{ title: string; url: string; chunk: string }> = []
    const seenUrls = new Set<string>()
    const candidatesValue = response.candidates
    if (!Array.isArray(candidatesValue)) return references

    for (const candidate of candidatesValue) {
      if (!candidate || typeof candidate !== "object") continue
      const groundingMetadata = (candidate as { groundingMetadata?: unknown })
        .groundingMetadata
      if (!groundingMetadata || typeof groundingMetadata !== "object") continue

      const chunksValue = (groundingMetadata as { groundingChunks?: unknown })
        .groundingChunks
      if (!Array.isArray(chunksValue)) continue

      for (const chunkEntry of chunksValue) {
        if (!chunkEntry || typeof chunkEntry !== "object") continue

        const webValue = (chunkEntry as { web?: unknown }).web
        const web =
          webValue && typeof webValue === "object"
            ? (webValue as Record<string, unknown>)
            : (chunkEntry as Record<string, unknown>)

        const url = this.pickFirstString(web, ["uri", "url"])
        if (!url || seenUrls.has(url)) continue

        const title = this.pickFirstString(web, ["title", "displayName"]) || url
        const chunkText = this.pickFirstString(web, ["snippet", "chunk"]) || ""

        seenUrls.add(url)
        references.push({
          title,
          url,
          chunk: chunkText,
        })
        if (references.length >= 20) return references
      }
    }

    return references
  }

  private withWebSearchSources(
    text: string,
    references: Array<{ title: string; url: string; chunk: string }>
  ): string {
    const normalized = text.trim()
    if (references.length === 0) return normalized

    // If the model already provided markdown citations, keep original text.
    if (/\[[^\]]+\]\(https?:\/\/[^\s)]+\)/.test(normalized)) {
      return normalized
    }

    const sourceLines = references
      .slice(0, 10)
      .map((ref, index) => `[${index + 1}] [${ref.title}](${ref.url})`)
      .join("\n")
    const sourceBlock = `Sources:\n${sourceLines}`

    if (!normalized) return sourceBlock
    return `${normalized}\n\n${sourceBlock}`
  }

  private pickFirstString(
    source: Record<string, unknown>,
    keys: string[]
  ): string | undefined {
    for (const key of keys) {
      const value = source[key]
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim()
      }
    }
    return undefined
  }

  private resolveCloudCodeMaxOutputTokens(requested?: number): number {
    if (!Number.isFinite(requested) || !requested || requested <= 0) {
      return this.CLOUD_CODE_DEFAULT_OUTPUT_TOKENS
    }

    const normalized = Math.floor(requested)
    return Math.max(
      this.CLOUD_CODE_MIN_OUTPUT_TOKENS,
      Math.min(normalized, this.CLOUD_CODE_MAX_OUTPUT_TOKENS)
    )
  }

  /**
   * Extract text content from various formats
   */
  /**
   * Convert Google response to Anthropic format
   */
  /**
   * Convert Cloud Code response to Anthropic format
   * Convert Cloud Code response to Anthropic format.
   *
   * Handles:
   * - thinking blocks with signature
   * - trailingSignature from empty text parts
   * - functionCall -> tool_use conversion
   * - signature caching for next turn
   */
  private convertToAnthropicFormat(
    googleResponse: Record<string, unknown>,
    model: string
  ): AnthropicResponse {
    // Cloud Code wraps response in 'response' key
    const responseData =
      (googleResponse.response as Record<string, unknown>) || googleResponse

    this.logger.debug(
      `Response structure: ${JSON.stringify(Object.keys(googleResponse))}`
    )

    // Extract parts from candidates
    const candidates = responseData.candidates as Array<{
      content?: {
        parts?: Array<{
          text?: string
          thought?: boolean
          thoughtSignature?: string
          functionCall?: {
            name: string
            args: Record<string, unknown>
            id?: string
          }
        }>
      }
      finishReason?: string
    }>

    const contentBlocks: Array<Record<string, unknown>> = []
    let textBuilder = ""
    let thinkingBuilder = ""
    let hasToolCall = false
    let thinkingSignature: string | null = null
    let trailingSignature: string | null = null
    let pendingToolThoughtSignature: string | null = null

    // Pre-scan to check if any thinking parts exist
    const parts = candidates?.[0]?.content?.parts || []
    const hasThinking = parts.some((p) => p?.thought)

    // Helper: flush thinking
    const flushThinking = () => {
      if (thinkingBuilder.length === 0 && !thinkingSignature) return

      const block: Record<string, unknown> = {
        type: "thinking",
        thinking: thinkingBuilder || "",
      }

      if (thinkingSignature) {
        block.signature = thinkingSignature
        thinkingSignature = null
      }

      contentBlocks.push(block)
      thinkingBuilder = ""
    }

    // Helper: flush text
    const flushText = () => {
      if (textBuilder.length === 0) return
      contentBlocks.push({ type: "text", text: textBuilder })
      textBuilder = ""
    }

    // Helper: generate tool_use id
    const makeToolUseId = (): string => {
      return `toolu_vrtx_${crypto.randomBytes(16).toString("base64url")}`
    }

    // Process each part
    for (const part of parts) {
      const signature = part.thoughtSignature

      // Clear pendingToolThoughtSignature if not empty thought and not functionCall
      const isEmptyThoughtPart =
        part.thought &&
        part.text !== undefined &&
        String(part.text).length === 0
      if (
        pendingToolThoughtSignature &&
        !part.functionCall &&
        !isEmptyThoughtPart
      ) {
        pendingToolThoughtSignature = null
      }

      // Handle functionCall
      if (part.functionCall) {
        // Emit signature before tool_use if present
        if (signature && hasThinking) {
          thinkingSignature = signature
        }
        flushThinking()
        flushText()

        // Handle trailingSignature before functionCall
        if (trailingSignature && hasThinking) {
          contentBlocks.push({
            type: "thinking",
            thinking: "",
            signature: trailingSignature,
          })
          trailingSignature = null
        }

        // Tool signature carrier when no thinking
        if (signature && !hasThinking) {
          contentBlocks.push({
            type: "thinking",
            thinking: "",
            signature,
          })
        }

        hasToolCall = true

        const toolId =
          typeof part.functionCall.id === "string" && part.functionCall.id
            ? part.functionCall.id
            : makeToolUseId()

        const toolUseBlock = {
          type: "tool_use",
          id: toolId,
          name: part.functionCall.name,
          input: part.functionCall.args || {},
        }

        this.rememberToolName(toolId, part.functionCall.name)

        // Cache signature for next turn
        const sigForToolCache = signature || pendingToolThoughtSignature
        pendingToolThoughtSignature = null
        if (sigForToolCache) {
          this.signatureStore.remember(toolId, sigForToolCache)
        }

        contentBlocks.push(toolUseBlock)
        continue
      }

      // Handle text/thinking
      if (part.text !== undefined) {
        if (part.thought) {
          flushText()

          // Handle trailingSignature before thinking
          if (trailingSignature && hasThinking) {
            flushThinking()
            contentBlocks.push({
              type: "thinking",
              thinking: "",
              signature: trailingSignature,
            })
            trailingSignature = null
          }

          thinkingBuilder += part.text
          if (signature) {
            thinkingSignature = signature
            if (part.text.length === 0) {
              pendingToolThoughtSignature = signature
            }
          }
        } else {
          // Empty text with signature -> trailingSignature
          if (part.text.length === 0) {
            if (signature) {
              trailingSignature = signature
            }
            continue
          }

          flushThinking()

          // Handle trailingSignature before text
          if (trailingSignature && hasThinking) {
            flushText()
            contentBlocks.push({
              type: "thinking",
              thinking: "",
              signature: trailingSignature,
            })
            trailingSignature = null
          }

          textBuilder += part.text

          // Non-empty text with signature: emit via empty thinking block
          if (signature && hasThinking) {
            flushText()
            contentBlocks.push({
              type: "thinking",
              thinking: "",
              signature,
            })
          }
        }
      }
    }

    // Flush remaining content
    flushThinking()
    flushText()

    // Handle trailing signature at end
    if (trailingSignature && hasThinking) {
      contentBlocks.push({
        type: "thinking",
        thinking: "",
        signature: trailingSignature,
      })
    }

    // Determine stop_reason
    const finishReason = candidates?.[0]?.finishReason
    let stopReason = "end_turn"
    if (hasToolCall) {
      stopReason = "tool_use"
    } else if (finishReason === "MAX_TOKENS") {
      stopReason = "max_tokens"
    }

    // Extract usage metadata
    const usageMetadata = responseData.usageMetadata as
      | Record<string, number>
      | undefined
    const usage = {
      input_tokens: usageMetadata?.promptTokenCount || 0,
      output_tokens: usageMetadata?.candidatesTokenCount || 0,
    }

    return {
      id:
        (responseData.responseId as string) ||
        `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "message",
      role: "assistant",
      content: (contentBlocks.length > 0
        ? contentBlocks
        : [{ type: "text", text: "" }]) as unknown as ContentBlock[],
      model: model,
      stop_reason: stopReason,
      usage,
    }
  }

  /**
   * Format SSE event in Anthropic format
   */
  private formatSseEvent(
    eventType: string,
    data: Record<string, unknown>
  ): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
  }

  // ============================================================
  // Claude Model Support via Cloud Code API
  // ============================================================

  /**
   * Resolve Anthropic model name to Cloud Code model name.
   * Uses unified model-registry for all name resolution.
   */
  resolveClaudeModel(model: string): string {
    const entry = resolveCloudCodeModel(model)
    if (entry) {
      this.logger.log(`Model mapping: ${model} -> ${entry.cloudCodeId}`)
      return entry.cloudCodeId
    }

    // Fuzzy match for standalone family names (Cursor IDE sends "opus", "sonnet", etc.)
    const normalized = model.toLowerCase().trim()
    if (normalized.includes("opus")) {
      this.logger.log(`Fuzzy opus match: ${model} -> claude-opus-4-6-thinking`)
      return "claude-opus-4-6-thinking"
    }
    if (normalized.includes("sonnet") || normalized.includes("haiku")) {
      this.logger.log(`Fuzzy match: ${model} -> ${DEFAULT_CLAUDE_MODEL}`)
      return DEFAULT_CLAUDE_MODEL
    }
    if (normalized.includes("claude")) {
      this.logger.log(
        `Unknown Claude: ${model}, default: ${DEFAULT_CLAUDE_MODEL}`
      )
      return DEFAULT_CLAUDE_MODEL
    }

    // Not a Claude model — return as-is (likely Gemini)
    return model
  }

  /**
   * Check if a model is a Claude model (should use Cloud Code API)
   */
  isClaudeModel(model: string): boolean {
    return model.toLowerCase().includes("claude")
  }

  private sanitizeCloudCodeToolName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
  }

  private resolveCloudCodeToolChoice(
    toolChoice: unknown
  ): { type: string; name?: string } | null {
    if (typeof toolChoice === "string") {
      const type = toolChoice.trim().toLowerCase()
      return type ? { type } : null
    }

    if (!toolChoice || typeof toolChoice !== "object") return null

    const type =
      typeof (toolChoice as { type?: unknown }).type === "string"
        ? ((toolChoice as { type?: string }).type ?? "").trim().toLowerCase()
        : ""
    const rawName =
      typeof (toolChoice as { name?: unknown }).name === "string"
        ? ((toolChoice as { name?: string }).name ?? "").trim()
        : ""

    if (!type) return null
    return rawName ? { type, name: rawName } : { type }
  }

  private shouldDisableThinkingForToolChoice(toolChoice: unknown): boolean {
    const resolved = this.resolveCloudCodeToolChoice(toolChoice)
    return resolved?.type === "any" || resolved?.type === "tool"
  }

  private buildCloudCodeFunctionCallingConfig(
    toolChoice: unknown
  ): Record<string, unknown> | null {
    const resolved = this.resolveCloudCodeToolChoice(toolChoice)
    if (!resolved) return null

    switch (resolved.type) {
      case "auto":
        return { mode: "AUTO" }
      case "none":
        return { mode: "NONE" }
      case "any":
        return { mode: "ANY" }
      case "tool": {
        const config: Record<string, unknown> = { mode: "ANY" }
        if (resolved.name) {
          config.allowedFunctionNames = [
            this.sanitizeCloudCodeToolName(resolved.name),
          ]
        }
        return config
      }
      default:
        return null
    }
  }

  private resolveClaudeStopSequences(dto: CreateMessageDto): string[] {
    const defaults = [
      "<|user|>",
      "<|bot|>",
      "<|context_request|>",
      "<|endoftext|>",
      "<|end_of_turn|>",
    ]
    const merged = new Set(defaults)
    if (Array.isArray(dto.stop_sequences)) {
      for (const value of dto.stop_sequences) {
        const normalized = typeof value === "string" ? value.trim() : ""
        if (normalized) merged.add(normalized)
      }
    }
    return Array.from(merged)
  }

  private buildClaudeThinkingConfig(
    dto: CreateMessageDto
  ): Record<string, unknown> | null {
    if (this.shouldDisableThinkingForToolChoice(dto.tool_choice)) {
      return null
    }

    const thinkingType =
      typeof dto.thinking?.type === "string"
        ? dto.thinking.type.trim().toLowerCase()
        : ""

    if (!thinkingType || thinkingType === "disabled") {
      return null
    }

    if (thinkingType === "enabled") {
      const thinkingBudget = Math.max(dto.thinking?.budget_tokens || 1024, 1024)
      return {
        includeThoughts: true,
        thinkingBudget,
      }
    }

    if (thinkingType === "adaptive" || thinkingType === "auto") {
      const effort =
        typeof dto.output_config?.effort === "string"
          ? dto.output_config.effort.trim().toLowerCase()
          : ""
      return {
        includeThoughts: true,
        thinkingLevel: effort || "high",
      }
    }

    return null
  }

  private shouldInjectInterleavedThinkingHint(
    resolvedModel: string,
    hasTools: boolean,
    thinkingConfig: Record<string, unknown> | null
  ): boolean {
    return (
      hasTools &&
      !!thinkingConfig &&
      resolvedModel.toLowerCase().includes("thinking")
    )
  }

  private extractSystemPromptText(
    system: CreateMessageDto["system"]
  ): string | null {
    if (!system) return null

    if (typeof system === "string") {
      const normalized = system.trim()
      return normalized || null
    }

    if (!Array.isArray(system)) return null

    const text = system
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === "object" &&
          block !== null &&
          block.type === "text" &&
          typeof block.text === "string"
      )
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join("\n")

    return text || null
  }

  /**
   * Convert Anthropic messages to Google/Gemini format for Claude models
   * Handles all content types: text, tool_use, tool_result, image, thinking
   */
  private convertClaudeToGoogleFormat(
    dto: CreateMessageDto
  ): Record<string, unknown> {
    const resolvedModel = this.resolveClaudeModel(dto.model)
    const contents: Array<{
      role: string
      parts: Array<Record<string, unknown>>
    }> = []

    // Track last user task text for deduplication
    // Claude Code often echoes the task text after tool_result
    let lastUserTaskTextNormalized: string | null = null

    const sourceMessages = dto.messages as Array<{
      role: "user" | "assistant"
      content: unknown
    }>
    const blockingPendingToolUseIds = findPendingToolUseIdsInMessages(
      sourceMessages,
      dto._pendingToolUseIds
    )
    if (blockingPendingToolUseIds.length > 0) {
      throw new FatalCloudCodeRequestError(
        `Cloud Code Claude cannot continue while ${blockingPendingToolUseIds.length} tool result(s) are still pending: ${blockingPendingToolUseIds.slice(0, 3).join(", ")}`
      )
    }

    // Cloud Code Claude requires strict assistant(tool_use) -> next
    // user(tool_result) adjacency. Do not relax send-path normalization.
    const protocolNormalized = normalizeToolProtocolMessages(sourceMessages, {
      mode: "strict-adjacent",
      pendingToolUseIds: dto._pendingToolUseIds,
    })
    if (
      protocolNormalized.removedToolResults > 0 ||
      protocolNormalized.injectedToolResults > 0
    ) {
      this.logger.warn(
        `Cloud Code protocol normalization: dropped ${protocolNormalized.removedToolResults} orphan tool_result, ` +
          `injected ${protocolNormalized.injectedToolResults} synthetic tool_result for orphan tool_use`
      )
    }
    const normalizedMessages = protocolNormalized.messages

    for (let msgIndex = 0; msgIndex < normalizedMessages.length; msgIndex++) {
      const msg = normalizedMessages[msgIndex]
      if (!msg) continue

      const role = msg.role === "assistant" ? "model" : "user"

      // Convert content with context for deduplication
      const { parts, lastTaskText } = this.convertContentToPartsWithContext(
        msg.content,
        role,
        lastUserTaskTextNormalized
      )

      // Update last user task text if this is a user message
      if (role === "user" && lastTaskText) {
        lastUserTaskTextNormalized = lastTaskText
      }

      // Ensure at least one part (API requires non-empty parts)
      if (parts.length === 0) {
        parts.push({ text: "." })
      }

      // Reorder parts for user messages: functionResponse first
      // Claude tool-use protocol is strict about matching tool_result to tool_use
      if (role === "user") {
        const hasFunctionResponse = parts.some(
          (p) => p && typeof p === "object" && "functionResponse" in p
        )
        if (hasFunctionResponse) {
          const reordered: Array<Record<string, unknown>> = []
          const deferred: Array<Record<string, unknown>> = []

          for (let i = 0; i < parts.length; i++) {
            const part = parts[i]
            if (part && "functionResponse" in part) {
              reordered.push(part)
              // Also include any following inlineData parts (attachments)
              while (i + 1 < parts.length) {
                const nextPart = parts[i + 1]
                if (nextPart && "inlineData" in nextPart) {
                  reordered.push(nextPart)
                  i++
                } else {
                  break
                }
              }
            } else if (part) {
              deferred.push(part)
            }
          }

          // Replace parts with reordered + deferred
          parts.length = 0
          parts.push(...reordered, ...deferred)
        }
      }

      contents.push({ role, parts })
    }

    // Cloud Code Claude models do not support assistant message prefill
    // The conversation must end with a user message
    // Only remove the LAST trailing model message (Cursor assistant prefill)
    // Keep all historical model messages intact for multi-turn context
    if (contents.length > 0) {
      const lastContent = contents[contents.length - 1]
      if (lastContent && lastContent.role === "model") {
        const hasFunctionCall = lastContent.parts.some(
          (p) => p && typeof p === "object" && "functionCall" in p
        )
        if (!hasFunctionCall) {
          this.logger.warn(
            `Removing trailing model message (assistant prefill) - Cloud Code Claude requires conversation to end with user message`
          )
          contents.pop()
        }
      }
    }

    // Debug: log contents structure for troubleshooting
    this.logger.debug(
      `[Contents] ${contents.length} messages: ${contents
        .map((c, i) => {
          const partTypes = c.parts
            .map((p) => {
              if ("text" in p) return "text"
              if ("functionCall" in p) return "functionCall"
              if ("functionResponse" in p) return "functionResponse"
              return "other"
            })
            .join("+")
          return `[${i}]${c.role}(${partTypes})`
        })
        .join(" → ")}`
    )

    // Build system instruction.
    // Cloud Code requires the official Antigravity prompt as the base
    // systemInstruction. Protocol-level system additions from the bridge are
    // appended as extra parts so Cursor request metadata survives routing.
    const systemParts: Array<{ text: string }> = [
      { text: this.officialSystemPrompt },
    ]
    const bridgeSystemPrompt = this.extractSystemPromptText(dto.system)
    if (bridgeSystemPrompt) {
      systemParts.push({ text: bridgeSystemPrompt })
    }
    const resolvedMaxOutputTokens = this.resolveCloudCodeMaxOutputTokens(
      dto.max_tokens
    )
    const thinkingConfig = this.buildClaudeThinkingConfig(dto)
    const genConfig: Record<string, unknown> = {
      temperature:
        typeof dto.temperature === "number" && Number.isFinite(dto.temperature)
          ? dto.temperature
          : 0.4,
      topP:
        typeof dto.top_p === "number" && Number.isFinite(dto.top_p)
          ? dto.top_p
          : 1,
      topK:
        typeof dto.top_k === "number" && Number.isFinite(dto.top_k)
          ? dto.top_k
          : 50,
      candidateCount: 1,
      maxOutputTokens: resolvedMaxOutputTokens,
      stopSequences: this.resolveClaudeStopSequences(dto),
    }

    this.logger.debug(
      `Cloud Code output budget: requested=${dto.max_tokens || "(none)"} resolved=${resolvedMaxOutputTokens}`
    )

    // Add thinkingConfig for Claude thinking requests
    if (thinkingConfig) {
      genConfig.thinkingConfig = thinkingConfig
      const thinkingBudget =
        typeof thinkingConfig.thinkingBudget === "number"
          ? thinkingConfig.thinkingBudget
          : null
      if (
        thinkingBudget !== null &&
        (genConfig.maxOutputTokens as number) <= thinkingBudget
      ) {
        genConfig.maxOutputTokens = thinkingBudget + 8192
      }
      this.logger.debug(
        `Claude thinking enabled: ${JSON.stringify(thinkingConfig)}`
      )
    }

    const request: Record<string, unknown> = {
      contents,
      generationConfig: genConfig,
    }

    // Add tools if present
    // Wrap each tool in its own {functionDeclarations: [tool]} group
    if (dto.tools && dto.tools.length > 0) {
      const toolDeclarations = this.buildCloudCodeToolDeclarations(
        dto.tools as Array<{
          name?: unknown
          description?: unknown
          input_schema?: unknown
        }>
      )
      if (toolDeclarations.length > 0) {
        request.tools = toolDeclarations
        const functionCallingConfig = this.buildCloudCodeFunctionCallingConfig(
          dto.tool_choice
        )
        request.toolConfig = {
          functionCallingConfig: functionCallingConfig || { mode: "AUTO" },
        }
      }
    }

    if (
      this.shouldInjectInterleavedThinkingHint(
        resolvedModel,
        Array.isArray(request.tools) && request.tools.length > 0,
        thinkingConfig
      )
    ) {
      systemParts.push({
        text: "Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.",
      })
    }

    // Only add systemInstruction if we have content
    // Official Antigravity includes role: "user" in systemInstruction
    if (systemParts.length > 0) {
      request.systemInstruction = {
        role: "user",
        parts: systemParts,
      }
    }

    // Add sessionId: matches official Antigravity behavior.
    // A single stable signed 64-bit integer shared across all requests
    // within the same IDE/process session, used for server-side caching.
    request.sessionId = this.sessionId

    return request
  }

  private buildCloudCodeToolDeclarations(
    tools: Array<{
      name?: unknown
      description?: unknown
      input_schema?: unknown
    }>
  ): Array<{ functionDeclarations: Array<Record<string, unknown>> }> {
    const declarations: Array<{
      functionDeclarations: Array<Record<string, unknown>>
    }> = []
    const seenNames = new Set<string>()

    const addDeclaration = (
      name: string,
      description: string,
      parameters: Record<string, unknown>
    ) => {
      if (!name || seenNames.has(name)) return
      seenNames.add(name)
      declarations.push({
        functionDeclarations: [{ name, description, parameters }],
      })
    }

    const normalize = (value: unknown): string => {
      if (typeof value !== "string") return ""
      return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
    }

    const hasWebSearch = tools.some((tool) => {
      const n = normalize(tool.name)
      return n === "web_search" || n === "search_web"
    })
    const hasWebFetch = tools.some((tool) => {
      const n = normalize(tool.name)
      return (
        n === "web_fetch" ||
        n === "read_url_content" ||
        n === "view_content_chunk"
      )
    })

    for (let idx = 0; idx < tools.length; idx++) {
      const tool = tools[idx]
      if (!tool) continue
      const normalizedName = normalize(tool.name)
      if (
        normalizedName === "web_search" ||
        normalizedName === "search_web" ||
        normalizedName === "web_fetch" ||
        normalizedName === "read_url_content" ||
        normalizedName === "view_content_chunk"
      ) {
        // Web tools are expanded below to match official Antigravity traffic shape.
        continue
      }

      const rawName =
        typeof tool.name === "string" && tool.name.trim() !== ""
          ? tool.name
          : `tool-${idx}`
      const name = this.sanitizeCloudCodeToolName(rawName)
      const description =
        typeof tool.description === "string" ? tool.description : ""
      const parameters = this.sanitizeSchema(
        tool.input_schema || { type: "object" }
      )
      addDeclaration(name, description, parameters)
    }

    if (hasWebFetch) {
      addDeclaration(
        "read_url_content",
        "Fetch content from a URL via HTTP request (invisible to USER). Use when: (1) extracting text from public pages, (2) reading static content/documentation, (3) batch processing multiple URLs, (4) speed is important, or (5) no visual interaction needed. Supports HTML (converted to markdown) and PDF content types. No JavaScript execution, no authentication. For pages requiring login, JavaScript, or USER visibility, use read_browser_page instead.",
        {
          type: "OBJECT",
          properties: {
            Url: {
              type: "STRING",
              description: "URL to read content from",
            },
            waitForPreviousTools: {
              type: "BOOLEAN",
              description:
                "If true, wait for all previous tool calls from this turn to complete before executing (sequential). If false or omitted, execute this tool immediately (parallel with other tools).",
            },
          },
          required: ["Url"],
        }
      )
    }

    if (hasWebSearch) {
      addDeclaration(
        "search_web",
        "Performs a web search for a given query. Returns a summary of relevant information along with URL citations.",
        {
          type: "OBJECT",
          properties: {
            domain: {
              type: "STRING",
              description: "Optional domain to recommend the search prioritize",
            },
            query: {
              type: "STRING",
            },
            waitForPreviousTools: {
              type: "BOOLEAN",
              description:
                "If true, wait for all previous tool calls from this turn to complete before executing (sequential). If false or omitted, execute this tool immediately (parallel with other tools).",
            },
          },
          required: ["query"],
        }
      )
    }

    if (hasWebFetch) {
      addDeclaration(
        "view_content_chunk",
        "View a specific chunk of document content using its DocumentId and chunk position. The DocumentId must have already been read by the read_url_content tool before this can be used on that particular DocumentId.",
        {
          type: "OBJECT",
          properties: {
            document_id: {
              type: "STRING",
              description: "The ID of the document that the chunk belongs to",
            },
            position: {
              type: "INTEGER",
              description: "The position of the chunk to view",
            },
            waitForPreviousTools: {
              type: "BOOLEAN",
              description:
                "If true, wait for all previous tool calls from this turn to complete before executing (sequential). If false or omitted, execute this tool immediately (parallel with other tools).",
            },
          },
          required: ["document_id", "position"],
        }
      )
    }

    return declarations
  }

  /**
   * Convert Anthropic content to Google parts array
   * Handles text, tool_use, tool_result, image, thinking blocks
   *
   * Convert Anthropic messages to Cloud Code content format.
   *
   * Signature handling:
   * - thinking.signature -> attach to next functionCall/text part
   * - tool_use.signature -> use directly, or fallback to signatureStore cache
   * - Empty thinking block with signature -> pending signature carrier
   */
  private convertContentToParts(
    content: unknown
  ): Array<Record<string, unknown>> {
    if (typeof content === "string") {
      return [{ text: content }]
    }

    if (!Array.isArray(content)) {
      let contentStr: string
      if (typeof content === "string") {
        contentStr = content
      } else if (typeof content === "object" && content !== null) {
        contentStr = JSON.stringify(content)
      } else if (content == null) {
        contentStr = ""
      } else {
        contentStr = String(content as string | number | boolean | bigint)
      }
      return [{ text: contentStr }]
    }

    const parts: Array<Record<string, unknown>> = []
    let pendingThoughtSignature: string | null = null
    let sawNonThinkingContent = false

    for (const block of content) {
      if (!block || typeof block !== "object") continue
      const b = block as Record<string, unknown>

      if (b.type === "text") {
        const text = b.text as string
        if (!text || text.trim() === "" || text === "(no content)") continue

        const part: Record<string, unknown> = { text }

        // Attach pending signature to text if no functionCall in message
        if (pendingThoughtSignature && !part.thoughtSignature) {
          part.thoughtSignature = pendingThoughtSignature
          pendingThoughtSignature = null
        }

        parts.push(part)
        sawNonThinkingContent = true
      } else if (b.type === "tool_use") {
        // Convert tool_use to functionCall (Google format)
        const fcPart: Record<string, unknown> = {
          functionCall: {
            name: b.name,
            args: b.input || {},
            id: b.id,
          },
        }

        // Signature priority:
        // 1. tool_use.signature (if client returns it)
        // 2. pendingThoughtSignature (from previous thinking block)
        // 3. signatureStore cache (from previous response)
        let sig: string | null = null
        const toolUseId = b.id as string

        if (typeof b.signature === "string" && b.signature) {
          sig = b.signature
          // Client returned signature, clean cache
          if (toolUseId) {
            this.signatureStore.delete(toolUseId)
          }
        } else if (pendingThoughtSignature) {
          sig = pendingThoughtSignature
          pendingThoughtSignature = null
          // This signature came from thinking block, clean cache
          if (toolUseId) {
            this.signatureStore.delete(toolUseId)
          }
        } else if (toolUseId) {
          // Fallback to cache
          sig = this.signatureStore.get(toolUseId)
        }

        if (sig) {
          fcPart.thoughtSignature = sig
        }

        if (typeof toolUseId === "string" && typeof b.name === "string") {
          this.rememberToolName(toolUseId, b.name)
        }

        parts.push(fcPart)
        sawNonThinkingContent = true
      } else if (b.type === "tool_result") {
        const toolUseId =
          typeof b.tool_use_id === "string" ? b.tool_use_id : undefined
        const functionName = this.resolveFunctionResponseName(b)
        const resultText = this.extractToolResultOutput(b.content)
        const functionResponse: Record<string, unknown> = {
          name: functionName,
          response: {
            output: resultText || ".",
          },
        }
        if (toolUseId) {
          functionResponse.id = toolUseId
        }
        parts.push({ functionResponse })
        sawNonThinkingContent = true
      } else if (b.type === "image") {
        // Handle image content
        const source = b.source as Record<string, unknown>
        if (source?.type === "base64") {
          parts.push({
            inlineData: {
              mimeType: source.media_type,
              data: source.data,
            },
          })
        }
        sawNonThinkingContent = true
      } else if (b.type === "thinking") {
        // Handle thinking blocks
        const thinkingText = typeof b.thinking === "string" ? b.thinking : ""
        const signature = typeof b.signature === "string" ? b.signature : ""

        // Empty thinking block with signature -> signature carrier
        // Store as pending, will attach to next functionCall/text
        if (thinkingText.length === 0) {
          if (signature) {
            pendingThoughtSignature = signature
          }
          continue
        }

        // Thinking blocks must be leading within assistant message
        if (sawNonThinkingContent) continue

        // Store signature as pending for next non-thought part
        if (signature) {
          pendingThoughtSignature = signature
        }

        // Note: signature NOT attached to thought part per official spec
        parts.push({
          text: thinkingText,
          thought: true,
        })
      } else if (b.type === "redacted_thinking") {
        // Handle redacted thinking (treat as plain text)
        const text = typeof b.data === "string" ? b.data : ""
        if (!text) continue
        if (sawNonThinkingContent) continue

        parts.push({ text })
        sawNonThinkingContent = true
      }
    }

    // If pending signature not consumed, attach to last compatible part
    if (pendingThoughtSignature) {
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]
        if (!p || typeof p !== "object" || p.thoughtSignature) continue

        if (p.functionCall) {
          p.thoughtSignature = pendingThoughtSignature
          pendingThoughtSignature = null
          break
        }

        if (
          typeof p.text === "string" &&
          p.thought !== true &&
          p.text.length > 0
        ) {
          p.thoughtSignature = pendingThoughtSignature
          pendingThoughtSignature = null
          break
        }
      }
    }

    return parts
  }

  /**
   * Convert Anthropic content to Google parts array with context for deduplication
   * Flatten nested content arrays into a single parts array.
   *
   * This method adds deduplication logic for tool_result followed by repeated task text
   */
  private convertContentToPartsWithContext(
    content: unknown,
    role: string,
    lastUserTaskTextNormalized: string | null
  ): {
    parts: Array<Record<string, unknown>>
    previousWasToolResult: boolean
    lastTaskText: string | null
  } {
    if (typeof content === "string") {
      const normalized = content.replace(/\s+/g, "")
      return {
        parts: [{ text: content }],
        previousWasToolResult: false,
        lastTaskText: role === "user" ? normalized : null,
      }
    }

    if (!Array.isArray(content)) {
      let contentStr: string
      if (typeof content === "string") {
        contentStr = content
      } else if (typeof content === "object" && content !== null) {
        contentStr = JSON.stringify(content)
      } else if (content == null) {
        contentStr = ""
      } else {
        contentStr = String(content as string | number | boolean | bigint)
      }
      return {
        parts: [{ text: contentStr }],
        previousWasToolResult: false,
        lastTaskText: null,
      }
    }

    const parts: Array<Record<string, unknown>> = []
    let pendingThoughtSignature: string | null = null
    let sawNonThinkingContent = false
    let previousWasToolResult = false
    let lastTaskText: string | null = null

    for (const block of content) {
      if (!block || typeof block !== "object") continue
      const b = block as Record<string, unknown>

      if (b.type === "text") {
        const text = b.text as string
        if (!text || text.trim() === "" || text === "(no content)") continue

        // Deduplication: Skip text that matches last user task text after tool_result
        // Extract last user message text for context
        if (
          role === "user" &&
          previousWasToolResult &&
          lastUserTaskTextNormalized
        ) {
          const currentNormalized = text.replace(/\s+/g, "")
          if (currentNormalized === lastUserTaskTextNormalized) {
            // Skip duplicated task text echoed after tool_result
            previousWasToolResult = false
            continue
          }
        }

        const part: Record<string, unknown> = { text }

        // Attach pending signature to text if no functionCall in message
        if (pendingThoughtSignature && !part.thoughtSignature) {
          part.thoughtSignature = pendingThoughtSignature
          pendingThoughtSignature = null
        }

        parts.push(part)
        sawNonThinkingContent = true
        previousWasToolResult = false

        // Track last user task text for deduplication
        if (role === "user") {
          lastTaskText = text.replace(/\s+/g, "")
        }
      } else if (b.type === "tool_use") {
        // Convert tool_use to functionCall (Google format)
        const fcPart: Record<string, unknown> = {
          functionCall: {
            name: b.name,
            args: b.input || {},
            id: b.id,
          },
        }

        // Signature priority
        let sig: string | null = null
        const toolUseId = b.id as string

        if (typeof b.signature === "string" && b.signature) {
          sig = b.signature
          if (toolUseId) this.signatureStore.delete(toolUseId)
        } else if (pendingThoughtSignature) {
          sig = pendingThoughtSignature
          pendingThoughtSignature = null
          if (toolUseId) this.signatureStore.delete(toolUseId)
        } else if (toolUseId) {
          sig = this.signatureStore.get(toolUseId)
        }

        if (sig) {
          fcPart.thoughtSignature = sig
        }

        if (typeof toolUseId === "string" && typeof b.name === "string") {
          this.rememberToolName(toolUseId, b.name)
        }

        parts.push(fcPart)
        sawNonThinkingContent = true
        previousWasToolResult = false
      } else if (b.type === "tool_result") {
        const toolUseId =
          typeof b.tool_use_id === "string" ? b.tool_use_id : undefined
        const functionName = this.resolveFunctionResponseName(b)
        const resultText = this.extractToolResultOutput(b.content)
        const functionResponse: Record<string, unknown> = {
          name: functionName,
          response: {
            output: resultText || ".",
          },
        }
        if (toolUseId) {
          functionResponse.id = toolUseId
        }
        parts.push({ functionResponse })
        sawNonThinkingContent = true
        previousWasToolResult = true
      } else if (b.type === "image") {
        const source = b.source as Record<string, unknown>
        if (source?.type === "base64") {
          parts.push({
            inlineData: {
              mimeType: source.media_type,
              data: source.data,
            },
          })
        }
        sawNonThinkingContent = true
        previousWasToolResult = false
      } else if (b.type === "thinking") {
        const thinkingText = typeof b.thinking === "string" ? b.thinking : ""
        const signature = typeof b.signature === "string" ? b.signature : ""

        if (thinkingText.length === 0) {
          if (signature) pendingThoughtSignature = signature
          continue
        }

        if (sawNonThinkingContent) continue

        if (signature) pendingThoughtSignature = signature

        parts.push({ text: thinkingText, thought: true })
        previousWasToolResult = false
      } else if (b.type === "redacted_thinking") {
        const text = typeof b.data === "string" ? b.data : ""
        if (!text) continue
        if (sawNonThinkingContent) continue

        parts.push({ text })
        sawNonThinkingContent = true
        previousWasToolResult = false
      }
    }

    // If pending signature not consumed, attach to last compatible part
    if (pendingThoughtSignature) {
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]
        if (!p || typeof p !== "object" || p.thoughtSignature) continue

        if (p.functionCall) {
          p.thoughtSignature = pendingThoughtSignature
          break
        }

        if (
          typeof p.text === "string" &&
          p.thought !== true &&
          p.text.length > 0
        ) {
          p.thoughtSignature = pendingThoughtSignature
          break
        }
      }
    }

    return { parts, previousWasToolResult, lastTaskText }
  }

  /**
   * Sanitize JSON Schema for Cloud Code API compatibility
   * Uses allowlist approach - only permit known-safe JSON Schema features
   */
  private sanitizeSchema(schema: unknown): Record<string, unknown> {
    if (!schema || typeof schema !== "object") {
      return {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Reason for calling this tool",
          },
        },
        required: ["reason"],
      }
    }

    const s = schema as Record<string, unknown>
    const ALLOWED_FIELDS = new Set([
      "type",
      "description",
      "properties",
      "required",
      "items",
      "enum",
      "title",
    ])

    const sanitized: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(s)) {
      // Convert "const" to "enum"
      if (key === "const") {
        sanitized.enum = [value]
        continue
      }

      // Skip fields not in allowlist
      if (!ALLOWED_FIELDS.has(key)) {
        continue
      }

      if (key === "properties" && value && typeof value === "object") {
        const props: Record<string, unknown> = {}
        for (const [propKey, propValue] of Object.entries(
          value as Record<string, unknown>
        )) {
          props[propKey] = this.sanitizeSchema(propValue)
        }
        sanitized.properties = props
      } else if (key === "items" && value && typeof value === "object") {
        if (Array.isArray(value)) {
          sanitized.items = value.map((item) => this.sanitizeSchema(item))
        } else {
          sanitized.items = this.sanitizeSchema(value)
        }
      } else if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        sanitized[key] = this.sanitizeSchema(value)
      } else {
        sanitized[key] = value
      }
    }

    // Ensure we have at least a type
    if (!sanitized.type) {
      sanitized.type = "OBJECT"
    }

    // If object type with no properties, add placeholder
    if (
      (sanitized.type === "object" || sanitized.type === "OBJECT") &&
      (!sanitized.properties ||
        Object.keys(sanitized.properties as Record<string, unknown>).length ===
          0)
    ) {
      sanitized.properties = {
        reason: { type: "STRING", description: "Reason for calling this tool" },
      }
      sanitized.required = ["reason"]
    }

    // Clean for Google API compatibility
    return this.cleanSchemaForGoogle(sanitized)
  }

  /**
   * Clean schema for Google API compatibility
   * Removes unsupported keywords and converts types to uppercase
   */
  private cleanSchemaForGoogle(
    schema: Record<string, unknown>
  ): Record<string, unknown> {
    if (!schema || typeof schema !== "object") return schema
    if (Array.isArray(schema))
      return schema.map((s) =>
        this.cleanSchemaForGoogle(s as Record<string, unknown>)
      ) as unknown as Record<string, unknown>

    const result = { ...schema }

    // Handle allOf - merge schemas
    if (Array.isArray(result.allOf)) {
      const mergedProps: Record<string, unknown> = {}
      const mergedRequired = new Set<string>()

      for (const subSchema of result.allOf as Array<Record<string, unknown>>) {
        if (!subSchema || typeof subSchema !== "object") continue
        if (subSchema.properties) {
          Object.assign(mergedProps, subSchema.properties)
        }
        if (Array.isArray(subSchema.required)) {
          for (const req of subSchema.required) {
            mergedRequired.add(req as string)
          }
        }
      }

      delete result.allOf
      if (Object.keys(mergedProps).length > 0) {
        result.properties = {
          ...((result.properties as Record<string, unknown>) || {}),
          ...mergedProps,
        }
      }
      if (mergedRequired.size > 0) {
        result.required = [
          ...new Set([
            ...((result.required as string[]) || []),
            ...mergedRequired,
          ]),
        ]
      }
    }

    // Handle anyOf/oneOf - select first non-null option
    for (const unionKey of ["anyOf", "oneOf"]) {
      if (Array.isArray(result[unionKey])) {
        const options = result[unionKey] as Array<Record<string, unknown>>
        const bestOption =
          options.find((o) => o && o.type !== "null" && o.type !== "NULL") ||
          options[0]
        delete result[unionKey]
        if (bestOption) {
          for (const [key, value] of Object.entries(bestOption)) {
            if (!(key in result) || key === "type" || key === "properties") {
              result[key] = value
            }
          }
        }
      }
    }

    // Handle type arrays - select first non-null type
    if (Array.isArray(result.type)) {
      const types = result.type as string[]
      const nonNullTypes = types.filter((t) => t !== "null" && t !== "NULL")
      result.type = (nonNullTypes[0] || "string").toUpperCase()
    } else if (typeof result.type === "string") {
      result.type = result.type.toUpperCase()
    }

    // Remove unsupported keywords
    const unsupported = [
      "additionalProperties",
      "default",
      "$schema",
      "$defs",
      "definitions",
      "$ref",
      "$id",
      "$comment",
      "title",
      "minLength",
      "maxLength",
      "pattern",
      "format",
      "minItems",
      "maxItems",
      "examples",
      "allOf",
      "anyOf",
      "oneOf",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "minimum",
      "maximum",
      "propertyNames",
      "patternProperties",
      "unevaluatedProperties",
    ]
    for (const key of unsupported) {
      delete result[key]
    }

    // Recursively clean nested schemas
    if (result.properties && typeof result.properties === "object") {
      const newProps: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(
        result.properties as Record<string, unknown>
      )) {
        newProps[key] = this.cleanSchemaForGoogle(
          value as Record<string, unknown>
        )
      }
      result.properties = newProps
    }

    if (result.items) {
      if (Array.isArray(result.items)) {
        result.items = (result.items as Array<Record<string, unknown>>).map(
          (item) => this.cleanSchemaForGoogle(item)
        )
      } else if (typeof result.items === "object") {
        result.items = this.cleanSchemaForGoogle(
          result.items as Record<string, unknown>
        )
      }
    }

    // Validate required array contains only existing properties
    if (
      result.required &&
      Array.isArray(result.required) &&
      result.properties
    ) {
      const definedProps = new Set(
        Object.keys(result.properties as Record<string, unknown>)
      )
      result.required = (result.required as string[]).filter((prop) =>
        definedProps.has(prop)
      )
      if ((result.required as string[]).length === 0) {
        delete result.required
      }
    }

    return result
  }

  /**
   * Build Cloud Code request payload for Claude models
   */
  private buildClaudePayload(dto: CreateMessageDto): Record<string, unknown> {
    const googleRequest = this.convertClaudeToGoogleFormat(dto)

    // Resolve model name to Cloud Code format
    const model = this.resolveClaudeModel(dto.model)

    // Get or create per-conversation session for requestId
    const convId = dto._conversationId
    let session: { uuid: string; seq: number }
    if (convId) {
      if (!this.conversationSessions.has(convId)) {
        this.conversationSessions.set(convId, {
          uuid: crypto.randomUUID(),
          seq: 0,
        })
        this.logger.debug(
          `New conversation session: ${convId} -> uuid=${this.conversationSessions.get(convId)!.uuid}`
        )
      }
      session = this.conversationSessions.get(convId)!
    } else {
      session = this.fallbackSession
    }

    return {
      project: "",
      model: model,
      request: googleRequest,
      userAgent: "antigravity",
      requestType: "agent",
      requestId: `agent/${Date.now()}/${session.uuid}/${++session.seq}`,
    }
  }

  /**
   * Send Claude message via Cloud Code API (routed through native worker)
   */
  async sendClaudeMessage(dto: CreateMessageDto): Promise<AnthropicResponse> {
    if (!this.processPool.isConfigured()) {
      throw new HttpException(
        "Antigravity backend not configured. Run: npm run antigravity:sync -- --ide",
        HttpStatus.SERVICE_UNAVAILABLE
      )
    }

    const resolvedModel = this.resolveClaudeModel(dto.model)
    this.logger.log(
      `Sending Claude request via Cloud Code API: ${resolvedModel}`
    )

    const payload = this.buildClaudePayload(dto)
    const requestStartedAt = process.hrtime.bigint()

    // Enforce token budget before sending
    // Use protocol-layer budget if available, otherwise fall back to hard limit
    const budgetLimit =
      dto._contextTokenBudget || this.CLOUD_CODE_HARD_TOKEN_LIMIT
    const budgetResult = this.enforceTokenBudget(payload, budgetLimit)
    if (budgetResult.enforced) {
      this.logger.warn(
        `[sendClaudeMessage] Token budget enforced: ${budgetResult.originalTokens} -> ${budgetResult.finalTokens}`
      )
    }

    let lastError: Error | null = null
    let promptShrinkRetries = 0

    let consecutiveAuthErrors = 0
    const maxAuthRetries = Math.max(this.processPool.workerCount, 2)

    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      try {
        this.logger.debug(`Attempt ${attempt + 1}, model: ${resolvedModel}`)

        const data = (await this.processPool.generate(
          payload,
          resolvedModel
        )) as Record<string, unknown>
        const traceId = this.getCloudCodeTraceId(data)
        this.rememberConversationMetricContext(dto, payload, traceId)

        const totalDurationNs = process.hrtime.bigint() - requestStartedAt
        void this.recordConversationOfferedMetric({
          payload,
          traceId,
          firstMessageDurationNs: totalDurationNs,
          totalDurationNs,
        })

        this.logger.log(`Claude response received from Cloud Code API`)
        // Mark this worker as preferred for future requests with this model
        this.processPool.markSuccessForModel(resolvedModel)
        return this.convertToAnthropicFormat(data, dto.model)
      } catch (error) {
        const errMsg = (error as Error).message || ""

        // 401 — switch account and retry (cap to avoid infinite loop)
        if (errMsg.includes("401")) {
          consecutiveAuthErrors++
          if (consecutiveAuthErrors > maxAuthRetries) {
            throw new HttpException(
              "All accounts authentication failed",
              HttpStatus.UNAUTHORIZED
            )
          }
          this.logger.warn(
            `Auth error (${consecutiveAuthErrors}/${maxAuthRetries}), switching account...`
          )
          this.processPool.switchToNextWorker()
          lastError = error as Error
          continue
        }
        consecutiveAuthErrors = 0

        // 429 — rate limited: precisely cooldown the worker that reported the error
        if (errMsg.includes("429")) {
          const retryMs = this.parseRetryDelayMs(errMsg)
          const exhausted = this.isQuotaExhausted(errMsg)
          // Quota exhausted: use full reset duration (hours/days), uncapped
          // Transient rate limit: keep capped behavior
          const cooldownMs = exhausted
            ? (retryMs ?? this.QUOTA_EXHAUSTED_DEFAULT_COOLDOWN_MS)
            : Math.min(retryMs ?? 60_000, this.MAX_429_WAIT_MS)

          // Precisely target the worker that actually failed (not a random one)
          this.processPool.setModelCooldownForLastWorker(
            resolvedModel,
            cooldownMs,
            exhausted
          )

          // Check if another worker is available for this specific model
          if (this.processPool.hasAvailableWorkerForModel(resolvedModel)) {
            this.logger.warn(
              `Rate limited${exhausted ? " (QUOTA_EXHAUSTED)" : ""} [${this.processPool.getLastWorkerEmail()}], rotating to next available worker for ${resolvedModel}`
            )
            lastError = error as Error
            continue
          }

          // All workers exhausted for this model — graceful degradation instead of crash
          // Wait for the shortest model-specific cooldown, then retry
          const waitMs =
            this.processPool.getMinCooldownMsForModel(resolvedModel)
          if (waitMs > this.MAX_429_WAIT_MS) {
            // Cooldown too long (quota exhausted on all accounts) — return 429 with Retry-After
            this.logger.error(
              `All workers quota exhausted for ${resolvedModel}, shortest cooldown: ${waitMs}ms (exceeds max wait)`
            )
            throw new HttpException(
              `All Cloud Code accounts are rate-limited for ${resolvedModel}. Retry after ${Math.ceil(waitMs / 1000)}s.`,
              HttpStatus.TOO_MANY_REQUESTS
            )
          }

          this.logger.warn(
            `All workers rate-limited for ${resolvedModel}, waiting ${waitMs}ms before retry`
          )
          await this.sleep(waitMs)
          lastError = error as Error
          continue
        }

        // 400 — check for prompt-too-long
        if (errMsg.includes("400")) {
          const normalizedError = this.extractCloudCodeErrorText(errMsg)
          const promptTooLong = this.parsePromptTooLongTokens(normalizedError)
          if (
            promptTooLong &&
            promptShrinkRetries < this.MAX_PROMPT_SHRINK_RETRIES
          ) {
            const shrinkResult = this.tryShrinkPayloadContentsForPromptLimit(
              payload,
              promptTooLong,
              promptShrinkRetries
            )
            if (shrinkResult) {
              promptShrinkRetries++
              this.logger.warn(
                `Prompt too long (${promptTooLong.actual} > ${promptTooLong.max}), ` +
                  `shrinking (attempt ${promptShrinkRetries}/${this.MAX_PROMPT_SHRINK_RETRIES})`
              )
              continue
            }
          }
          if (this.isDeterministicInvalidRequest(errMsg)) {
            throw new FatalCloudCodeRequestError(
              this.buildInvalidRequestErrorMessage(errMsg)
            )
          }
        }

        if (errMsg.includes("Token refresh failed")) {
          this.logger.warn("Token refresh failed, switching account...")
          this.processPool.switchToNextWorker()
        }

        lastError = error as Error
        this.logger.error(`Request failed: ${errMsg}`)

        if (attempt < this.MAX_RETRIES - 1) {
          const delay =
            this.PRIME_RETRY_DELAYS[attempt] ??
            this.PRIME_RETRY_DELAYS[this.PRIME_RETRY_DELAYS.length - 1] ??
            this.BASE_RETRY_DELAY
          await this.sleep(delay)
        }
      }
    }

    throw new HttpException(
      `Cloud Code API request failed: ${lastError?.message}`,
      HttpStatus.BAD_GATEWAY
    )
  }
  async *sendClaudeMessageStream(
    dto: CreateMessageDto
  ): AsyncGenerator<string, void, unknown> {
    if (!this.processPool.isConfigured()) {
      throw new HttpException(
        "Antigravity backend not configured. Configure accounts.",
        HttpStatus.SERVICE_UNAVAILABLE
      )
    }

    // Quota management handled by native process pool

    const resolvedModel = this.resolveClaudeModel(dto.model)
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    this.logger.log(
      `Streaming Claude request via Cloud Code API: ${resolvedModel}`
    )

    const payload = this.buildClaudePayload(dto)
    const requestStartedAt = process.hrtime.bigint()

    // Enforce token budget before sending
    // Use protocol-layer budget if available, otherwise fall back to hard limit
    const budgetLimit =
      dto._contextTokenBudget || this.CLOUD_CODE_HARD_TOKEN_LIMIT
    const budgetResult = this.enforceTokenBudget(payload, budgetLimit)
    if (budgetResult.enforced) {
      this.logger.warn(
        `[sendClaudeMessageStream] Token budget enforced: ${budgetResult.originalTokens} -> ${budgetResult.finalTokens}`
      )
    }

    const messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`

    // Send message_start
    yield this.formatSseEvent("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: dto.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })

    // Block types
    const BLOCK_NONE = 0
    const BLOCK_TEXT = 1
    const BLOCK_THINKING = 2
    const BLOCK_TOOL_USE = 3

    // Block tracking state
    let currentBlockIndex = 0
    let blockType = BLOCK_NONE
    let hasThinking = false
    let hasToolCall = false
    let pendingSignature: string | null = null
    let trailingSignature: string | null = null
    let pendingToolThoughtSignature: string | null = null
    let fullThinkingContent = ""
    let fullContent = ""
    let firstMessageDurationNs: bigint | null = null
    let cloudCodeTraceId: string | null = null

    // Helper: generate tool_use id
    const makeToolUseId = (): string => {
      const bytes = crypto.randomBytes(16).toString("base64url")
      return `toolu_vrtx_${bytes}`
    }

    // Helper to end current block
    const endBlock = function* (): Generator<string> {
      if (blockType === BLOCK_NONE) return

      // If thinking block ending, emit pending signature
      if (blockType === BLOCK_THINKING && pendingSignature) {
        yield self.formatSseEvent("content_block_delta", {
          type: "content_block_delta",
          index: currentBlockIndex,
          delta: { type: "signature_delta", signature: pendingSignature },
        })
        pendingSignature = null
      }

      yield self.formatSseEvent("content_block_stop", {
        type: "content_block_stop",
        index: currentBlockIndex,
      })
      currentBlockIndex++
      blockType = BLOCK_NONE
    }

    // Helper to start a new block
    const startBlock = function* (
      type: number,
      contentBlock: Record<string, unknown>
    ): Generator<string> {
      if (blockType !== BLOCK_NONE) {
        yield* endBlock()
      }

      // Claude SSE: thinking block start always has signature field
      if (contentBlock.type === "thinking" && !("signature" in contentBlock)) {
        contentBlock = { ...contentBlock, signature: "" }
      }

      yield self.formatSseEvent("content_block_start", {
        type: "content_block_start",
        index: currentBlockIndex,
        content_block: contentBlock,
      })
      blockType = type
    }

    // Helper: emit signature via empty thinking block
    const emitSignatureBlock = function* (
      signature: string
    ): Generator<string> {
      yield* startBlock(BLOCK_THINKING, {
        type: "thinking",
        thinking: "",
      })
      yield self.formatSseEvent("content_block_delta", {
        type: "content_block_delta",
        index: currentBlockIndex,
        delta: { type: "thinking_delta", thinking: "" },
      })
      yield self.formatSseEvent("content_block_delta", {
        type: "content_block_delta",
        index: currentBlockIndex,
        delta: { type: "signature_delta", signature },
      })
      yield* endBlock()
    }

    let fatalRequestError: string | null = null

    // Async producer-consumer queue for real-time streaming
    const eventQueue: string[] = []
    let resolveWaiting: (() => void) | null = null
    let streamDone = false

    const push = (...events: string[]) => {
      eventQueue.push(...events)
      if (resolveWaiting) {
        resolveWaiting()
        resolveWaiting = null
      }
    }

    this.logger.debug(
      `[Payload] model=${String(payload.model)}, ` +
        `project=${String(payload.project)}, ` +
        `requestType=${String(payload.requestType)}, ` +
        `tools=${(payload.request as Record<string, unknown>)?.tools ? "yes" : "no"}, ` +
        `thinkingConfig=${JSON.stringify((payload.request as Record<string, unknown>)?.generationConfig)?.slice(0, 200)}`
    )

    // ---------------------------------------------------------------------------
    // Worker rotation retry: try each available worker before giving up
    // ---------------------------------------------------------------------------
    const maxWorkerRetries = Math.max(this.processPool.workerCount, 2)
    let promptShrinkRetries = 0

    const attemptStream = async (): Promise<void> => {
      // Recovery orchestration: allow ONE cooldown wait when all workers are
      // exhausted but the shortest cooldown is within MAX_429_WAIT_MS.
      // After recovery, the loop continues with a fresh attempt (workerAttempt
      // is not consumed) so the recovered worker gets a fair chance.
      let hasWaitedForRecovery = false

      for (
        let workerAttempt = 0;
        workerAttempt < maxWorkerRetries;
        workerAttempt++
      ) {
        try {
          await this.processPool.generateStream(
            payload,
            onChunkHandler,
            resolvedModel
          )
          // Mark this worker as preferred for future requests with this model
          self.processPool.markSuccessForModel(resolvedModel)
          return // success
        } catch (err) {
          const errMsg = (err as Error).message || ""
          const isLast = workerAttempt >= maxWorkerRetries - 1

          if (errMsg.includes("429")) {
            const retryMs = self.parseRetryDelayMs(errMsg)
            const exhausted = self.isQuotaExhausted(errMsg)
            // Quota exhausted: use full reset duration, uncapped
            const cooldownMs = exhausted
              ? (retryMs ?? self.QUOTA_EXHAUSTED_DEFAULT_COOLDOWN_MS)
              : Math.min(retryMs ?? 60_000, self.MAX_429_WAIT_MS)

            // Precisely target the worker that actually failed
            self.processPool.setModelCooldownForLastWorker(
              resolvedModel,
              cooldownMs,
              exhausted
            )

            // Check if another worker is available for this model
            if (self.processPool.hasAvailableWorkerForModel(resolvedModel)) {
              self.logger.warn(
                `Streaming 429${exhausted ? " (QUOTA_EXHAUSTED)" : ""} [${self.processPool.getLastWorkerEmail()}] (attempt ${workerAttempt + 1}/${maxWorkerRetries}), rotating to next available worker for ${resolvedModel}`
              )
              continue
            }

            // All workers exhausted for this model — check if we can wait for recovery
            const waitMs =
              self.processPool.getMinCooldownMsForModel(resolvedModel)

            if (waitMs > self.MAX_429_WAIT_MS) {
              // Cooldown too long — return 429 with context
              self.logger.error(
                `All workers quota exhausted for ${resolvedModel}, shortest cooldown: ${waitMs}ms (exceeds max wait ${self.MAX_429_WAIT_MS}ms)`
              )
              throw new HttpException(
                `All Cloud Code accounts are rate-limited for ${resolvedModel}. Retry after ${Math.ceil(waitMs / 1000)}s.`,
                HttpStatus.TOO_MANY_REQUESTS
              )
            }

            // Cooldown within threshold — wait for the first worker to recover
            if (!hasWaitedForRecovery) {
              hasWaitedForRecovery = true
              self.logger.warn(
                `All workers exhausted for ${resolvedModel}, waiting ${Math.ceil(waitMs / 1000)}s for recovery (1 recovery wait allowed)`
              )
              await self.sleep(waitMs)
              workerAttempt-- // don't consume an attempt — give recovered worker a fair chance
              continue
            }

            // Already waited once — give up to avoid infinite loop
            self.logger.error(
              `All workers still exhausted for ${resolvedModel} after recovery wait, giving up`
            )
            throw new HttpException(
              `All Cloud Code accounts are rate-limited for ${resolvedModel}. Retry after ${Math.ceil(waitMs / 1000)}s.`,
              HttpStatus.TOO_MANY_REQUESTS
            )
          }

          // 400 — prompt-too-long: shrink payload and retry
          if (errMsg.includes("400")) {
            const normalizedError = self.extractCloudCodeErrorText(errMsg)
            const promptTooLong = self.parsePromptTooLongTokens(normalizedError)
            if (
              promptTooLong &&
              promptShrinkRetries < self.MAX_PROMPT_SHRINK_RETRIES
            ) {
              const shrinkResult = self.tryShrinkPayloadContentsForPromptLimit(
                payload,
                promptTooLong,
                promptShrinkRetries
              )
              if (shrinkResult) {
                promptShrinkRetries++
                self.logger.warn(
                  `[sendClaudeMessageStream] Prompt too long (${promptTooLong.actual} > ${promptTooLong.max}), ` +
                    `shrinking (attempt ${promptShrinkRetries}/${self.MAX_PROMPT_SHRINK_RETRIES})`
                )
                workerAttempt-- // don't consume a worker retry for prompt shrink
                continue
              }
            }
          }

          if (
            errMsg.includes("Token refresh failed") ||
            errMsg.includes("401")
          ) {
            self.processPool.switchToNextWorker()
            if (!isLast) {
              self.logger.warn(
                `Streaming auth error (attempt ${workerAttempt + 1}/${maxWorkerRetries}), switched to next worker`
              )
              continue
            }
          }

          // Non-retryable or last attempt
          throw err
        }
      }
    }

    // Chunk handler extracted so it can be reused across retry attempts
    const onChunkHandler = (chunk: unknown) => {
      const data = chunk as Record<string, unknown>
      const traceId = this.getCloudCodeTraceId(data)
      if (traceId) {
        cloudCodeTraceId = traceId
      }
      const responseData = (data.response as Record<string, unknown>) || data

      const candidates = (responseData.candidates ?? []) as Array<{
        content?: {
          parts?: Array<{
            text?: string
            thought?: boolean
            thoughtSignature?: string
            functionCall?: {
              name: string
              args: Record<string, unknown>
              id?: string
            }
          }>
        }
      }>

      if (!candidates || candidates.length === 0) return
      const candidate = candidates[0]
      const parts = candidate?.content?.parts || []
      if (parts.length > 0 && firstMessageDurationNs === null) {
        firstMessageDurationNs = process.hrtime.bigint() - requestStartedAt
      }

      for (const part of parts) {
        const signature = part.thoughtSignature

        const isEmptyThoughtPart =
          part.thought &&
          part.text !== undefined &&
          String(part.text).length === 0
        if (
          pendingToolThoughtSignature &&
          !part.functionCall &&
          !isEmptyThoughtPart
        ) {
          pendingToolThoughtSignature = null
        }

        if (part.functionCall) {
          hasToolCall = true
          if (signature && hasThinking) {
            if (blockType === BLOCK_THINKING) {
              pendingSignature = signature
            } else {
              push(...endBlock(), ...emitSignatureBlock(signature))
            }
          }
          push(...endBlock())
          if (trailingSignature && hasThinking) {
            push(...emitSignatureBlock(trailingSignature))
            trailingSignature = null
          }
          if (signature && !hasThinking) {
            push(...emitSignatureBlock(signature))
          }
          const toolId = part.functionCall.id || makeToolUseId()
          this.rememberToolName(toolId, part.functionCall.name)
          push(
            ...startBlock(BLOCK_TOOL_USE, {
              type: "tool_use",
              id: toolId,
              name: part.functionCall.name,
              input: {},
            })
          )
          const inputJson = JSON.stringify(part.functionCall.args || {})
          const CHUNK_SIZE = 80
          for (let i = 0; i < inputJson.length; i += CHUNK_SIZE) {
            push(
              this.formatSseEvent("content_block_delta", {
                type: "content_block_delta",
                index: currentBlockIndex,
                delta: {
                  type: "input_json_delta",
                  partial_json: inputJson.slice(i, i + CHUNK_SIZE),
                },
              })
            )
          }
          push(...endBlock())
          const sigForToolCache = signature || pendingToolThoughtSignature
          pendingToolThoughtSignature = null
          if (sigForToolCache) {
            this.signatureStore.remember(toolId, sigForToolCache)
          }
          continue
        }

        if (part.text === undefined) continue

        if (part.thought) {
          hasThinking = true
          if (trailingSignature) {
            push(...endBlock())
            if (hasThinking) {
              push(...emitSignatureBlock(trailingSignature))
            }
            trailingSignature = null
          }
          if (blockType === BLOCK_THINKING) {
            fullThinkingContent += part.text
            if (part.text) {
              push(
                this.formatSseEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: currentBlockIndex,
                  delta: { type: "thinking_delta", thinking: part.text },
                })
              )
            }
          } else {
            push(
              ...startBlock(BLOCK_THINKING, {
                type: "thinking",
                thinking: "",
              })
            )
            fullThinkingContent += part.text
            if (part.text) {
              push(
                this.formatSseEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: currentBlockIndex,
                  delta: { type: "thinking_delta", thinking: part.text },
                })
              )
            }
          }
          if (signature) {
            pendingSignature = signature
            if (part.text.length === 0) {
              pendingToolThoughtSignature = signature
            }
          }
        } else {
          if (part.text.length === 0) {
            if (signature) trailingSignature = signature
            continue
          }
          if (trailingSignature && hasThinking) {
            push(...endBlock(), ...emitSignatureBlock(trailingSignature))
            trailingSignature = null
          }
          if (blockType === BLOCK_TEXT) {
            fullContent += part.text
            push(
              this.formatSseEvent("content_block_delta", {
                type: "content_block_delta",
                index: currentBlockIndex,
                delta: { type: "text_delta", text: part.text },
              })
            )
          } else {
            push(...startBlock(BLOCK_TEXT, { type: "text", text: "" }))
            fullContent += part.text
            push(
              this.formatSseEvent("content_block_delta", {
                type: "content_block_delta",
                index: currentBlockIndex,
                delta: { type: "text_delta", text: part.text },
              })
            )
          }
          if (signature && hasThinking) {
            push(...endBlock(), ...emitSignatureBlock(signature))
          }
        }
      }
    }

    // Producer: start streaming in background with worker rotation
    const streamPromise = attemptStream()
      .then(() => {
        streamDone = true
        if (resolveWaiting) {
          resolveWaiting()
          resolveWaiting = null
        }
      })
      .catch((err) => {
        const errMsg = (err as Error).message || ""
        self.logger.error(`Streaming failed (all workers exhausted): ${errMsg}`)
        fatalRequestError = errMsg || "Cloud Code API streaming failed"
        streamDone = true
        if (resolveWaiting) {
          resolveWaiting()
          resolveWaiting = null
        }
      })

    // Consumer: yield events in real-time as they arrive from IPC
    while (true) {
      while (eventQueue.length > 0) {
        yield eventQueue.shift()!
      }
      if (streamDone) break
      await new Promise<void>((r) => {
        resolveWaiting = r
      })
    }
    while (eventQueue.length > 0) {
      yield eventQueue.shift()!
    }

    // Keep reference to avoid unhandled rejection
    void streamPromise

    if (fatalRequestError) {
      const errorMsg = fatalRequestError as string
      this.logger.error(`Cloud Code API failed for Claude model: ${errorMsg}`)
      const userFacingError = errorMsg.includes("request exceeds prompt limit")
        ? "Request context is too large. Please shorten the conversation or start a new chat."
        : errorMsg

      yield this.formatSseEvent("content_block_start", {
        type: "content_block_start",
        index: currentBlockIndex,
        content_block: { type: "text", text: "" },
      })
      yield this.formatSseEvent("content_block_delta", {
        type: "content_block_delta",
        index: currentBlockIndex,
        delta: { type: "text_delta", text: userFacingError },
      })
      yield this.formatSseEvent("content_block_stop", {
        type: "content_block_stop",
        index: currentBlockIndex,
      })
      yield this.formatSseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      })
      yield this.formatSseEvent("message_stop", { type: "message_stop" })
      return
    }

    // Finalize: close blocks and send message_stop
    yield* endBlock()

    if (trailingSignature && hasThinking) {
      yield* emitSignatureBlock(trailingSignature)
    }

    const stopReason = hasToolCall ? "tool_use" : "end_turn"
    yield this.formatSseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        output_tokens: Math.ceil(
          (fullThinkingContent.length + fullContent.length) / 4
        ),
      },
    })
    yield this.formatSseEvent("message_stop", { type: "message_stop" })

    this.logger.log(
      `Claude streaming completed: thinking=${fullThinkingContent.length} chars, text=${fullContent.length} chars, hasToolCall=${hasToolCall}`
    )
    const totalDurationNs = process.hrtime.bigint() - requestStartedAt
    this.rememberConversationMetricContext(dto, payload, cloudCodeTraceId)
    void this.recordConversationOfferedMetric({
      payload,
      traceId: cloudCodeTraceId,
      firstMessageDurationNs,
      totalDurationNs,
    })
  }
}
