import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as crypto from "crypto"
import { TokenCounterService } from "../../context/token-counter.service"
import { normalizeToolProtocolMessages } from "../../context/tool-protocol-normalizer"
import { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"
import type { AnthropicResponse, ContentBlock } from "../../shared/anthropic"
import type { CloudCodeToolDeclaration } from "../../shared/cloud-code"
import {
  adaptOfficialAntigravityToolInput as adaptOfficialAntigravityToolInputFromContract,
  buildOfficialAntigravityToolDeclarations as buildOfficialAntigravityToolDeclarationsFromContract,
  fromOfficialAntigravityToolName as fromOfficialAntigravityToolNameFromContract,
  toOfficialAntigravityToolName as toOfficialAntigravityToolNameFromContract,
} from "../../shared/official-antigravity-tools"
import { UsageStatsService } from "../../usage"
import { UpstreamRequestAbortedError } from "../shared/abort-signal"
import { BackendApiError } from "../shared/backend-errors"
import {
  DEFAULT_CLAUDE_MODEL,
  doesModelSupportThinking,
  resolveCloudCodeModel,
} from "../shared/model-registry"
import { resolveThinkingIntentFromDto } from "../shared/thinking-intent"
import { findPendingToolUseIdsInMessages } from "../shared/tool-continuation-policy"
import { ANTIGRAVITY_SYSTEM_PROMPT } from "./antigravity-system-prompt"
import { CURSOR_SYSTEM_PROMPT } from "./cursor-system-prompt"
import { GoogleModelCacheService } from "./google-model-cache.service"
import {
  ProcessPoolService,
  WorkerPoolCooldownError,
} from "./process-pool.service"
import { ToolThoughtSignatureService } from "./tool-thought-signature.service"

/**
 * Adapt the official Antigravity system prompt for the Cursor IDE environment.
 *
 * The raw prompt (captured from Cloud Code traffic) contains sections that
 * assume the Antigravity desktop app's file-system artifact model
 * (<appDataDir>/brain/<conversation-id>/).  In Cursor those paths do not
 * exist, and the Cursor client exposes its own plan/todo UI tools instead.
 *
 * This function:
 *   1. Strips  <artifacts>, <planning_mode>, <planning_mode_artifacts>,
 *      and <persistent_context>  XML sections (including content).
 *   2. Injects a compact Cursor-native adaptation block that redirects
 *      plan/task/walkthrough behaviour into the conversation response.
 */
function adaptAntigravityPromptForCursor(raw: string): string {
  // Remove Antigravity-only XML sections (greedy within each tag pair).
  const sectionsToStrip = [
    "artifacts",
    "planning_mode_artifacts",
    "planning_mode",
    "persistent_context",
  ]
  let adapted = raw
  for (const tag of sectionsToStrip) {
    // Match <tag> ... </tag> including newlines around the block.
    const pattern = new RegExp(`\\n?<${tag}>[\\s\\S]*?</${tag}>\\n?`, "g")
    adapted = adapted.replace(pattern, "\n")
  }

  // Inject Cursor-native adaptation guidance.
  const cursorAdaptation = `<cursor_adaptation>
# Cursor IDE Adaptation

You are running inside the Cursor IDE, not the Antigravity desktop app.
The artifact file-system (<appDataDir>/brain/…) does NOT exist here.

Follow these rules instead:

## Planning
- Do NOT create implementation_plan.md, task.md, or walkthrough.md files.
- Present implementation plans directly in the conversation response.
- Use markdown headings and checklists for task tracking inline.

## Artifacts
- Do NOT write artifacts to <appDataDir>/brain/… paths.
- When you need to present structured reports, tables, or analysis,
  include them directly in your response as markdown.

## Task Tracking
- To create or display a task plan / TODO list, use the \`create_plan\` tool.
  It renders an interactive TODO panel in the Cursor IDE UI.
- Do NOT use \`update_todos\` to create an initial plan; always use \`create_plan\`.
- Use \`update_todos\` only to change the status of existing TODO items
  (e.g. mark a step as completed or in-progress).
- If neither \`create_plan\` nor \`update_todos\` appears in your tool list,
  fall back to markdown checklists in your response.

## Knowledge Items / Conversation Logs
- The KI system and conversation log filesystem are not available.
- Skip any instructions about checking KI summaries or reading
  conversation logs from disk.
</cursor_adaptation>`

  // Insert the adaptation block right before </identity> so it has
  // high priority but stays after the core identity definition.
  const identityCloseIdx = adapted.indexOf("</identity>")
  if (identityCloseIdx !== -1) {
    adapted =
      adapted.slice(0, identityCloseIdx) +
      "\n" +
      cursorAdaptation +
      "\n" +
      adapted.slice(identityCloseIdx)
  } else {
    // Fallback: prepend
    adapted = cursorAdaptation + "\n" + adapted
  }

  return adapted
}

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
  private readonly ANTIGRAVITY_IDE_VERSION = "1.22.2"

  // System prompt injected into Cloud Code requests.
  // ANTIGRAVITY_SYSTEM_PROMPT=false → Cursor prompt (no Antigravity sections);
  // otherwise → Antigravity prompt adapted for Cursor IDE (artifact/planning
  // sections stripped, Cursor-native behaviour injected).
  private readonly officialSystemPrompt =
    process.env.ANTIGRAVITY_SYSTEM_PROMPT === "false"
      ? CURSOR_SYSTEM_PROMPT
      : adaptAntigravityPromptForCursor(ANTIGRAVITY_SYSTEM_PROMPT)
  private readonly systemPromptMode =
    process.env.ANTIGRAVITY_SYSTEM_PROMPT === "false" ? "cursor" : "google"

  // Whether to use official Antigravity tool declarations for Claude models.
  // When false, Claude via Cloud Code uses direct Cursor tool passthrough
  // (same path as Gemini models). Controlled via ANTIGRAVITY_OFFICIAL_TOOLS=false env var.
  private readonly useOfficialAntigravityTools =
    process.env.ANTIGRAVITY_OFFICIAL_TOOLS !== "false"

  // Per-conversation source request ID tracking.
  // ProcessPoolService rewrites these into per-worker lineages before send so
  // each Google account maintains its own Cloud Code session identity.
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
  private readonly MIN_QUOTA_EXHAUSTED_COOLDOWN_MS = 1000
  // Pool recovery. Official Antigravity gives imminent quota resets one
  // fixed grace retry before surfacing/rotating the 429.
  private readonly QUOTA_RESET_GRACE_WINDOW_MS = 1500
  private readonly QUOTA_RESET_RETRY_DELAY_MS = 5000
  private readonly INSTANT_RETRY_THRESHOLD_MS = 3000 // retryAfter < 3s: wait in-place, same worker
  private readonly MAX_INSTANT_RETRIES = 3 // max consecutive instant retries before falling through
  private readonly RECOVERY_PASS_MAX_WAIT_MS = 5000 // max single recovery wait
  private readonly RECOVERY_BUDGET_MS = 30_000 // total time budget for recovery waits per request
  private readonly MODEL_CAPACITY_EXHAUSTED_COOLDOWN_MS = 2 * 1000
  private readonly TRANSIENT_WORKER_FAILURE_COOLDOWN_MS = 5 * 60 * 1000
  private readonly TRANSIENT_TRANSPORT_FAILURE_COOLDOWN_MS = 60 * 1000
  private readonly STREAM_FIRST_PROGRESS_WATCHDOG_MS = 60 * 1000
  private readonly STREAM_STALL_COOLDOWN_MS = 10 * 1000
  private readonly STREAM_PROGRESS_WATCHDOG_ABORT_PREFIX =
    "Cloud Code stream watchdog"
  private readonly MAX_PROMPT_SHRINK_RETRIES: number = 3
  // Official Antigravity Claude agent traffic uses a 64k output budget.
  private readonly CLOUD_CODE_DEFAULT_OUTPUT_TOKENS: number = 64000
  private readonly CLOUD_CODE_MAX_OUTPUT_TOKENS: number = 64000
  private readonly CLOUD_CODE_MIN_OUTPUT_TOKENS: number = 256
  // Hard token limit for Cloud Code API (from Anthropic error messages)
  private readonly CLOUD_CODE_HARD_TOKEN_LIMIT = 200_000

  // Session management configuration
  private readonly CONVERSATION_SESSION_TTL_MS: number
  private readonly CONVERSATION_SESSION_MAX_SIZE: number

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

  private recordGoogleAccountError(
    accountLabel: string | null | undefined,
    modelName: string,
    statusCode: 429 | 503
  ): void {
    const label = String(accountLabel || "").trim() || "Antigravity account"
    this.usageStats.recordGoogleUsage({
      transport: "native",
      modelName,
      accountKey: label,
      accountLabel: label,
      inputTokens: 0,
      outputTokens: 0,
      error429Count: statusCode === 429 ? 1 : 0,
      error503Count: statusCode === 503 ? 1 : 0,
      durationMs: 0,
    })
  }

  private parseRetryAfterMs(errorText: string): number | null {
    const match = errorText.match(/retry-after(?:=|:)\s*([^\]\s]+)/i)
    if (!match?.[1]) return null

    const rawValue = match[1].replace(/^"|"$/g, "").trim()
    if (!rawValue) return null

    const seconds = Number.parseFloat(rawValue)
    if (Number.isFinite(seconds)) {
      return Math.max(0, Math.round(seconds * 1000))
    }

    const retryAt = Date.parse(rawValue)
    if (Number.isNaN(retryAt)) return null
    return Math.max(0, retryAt - Date.now())
  }

  private formatCooldownRemainingMs(
    targetTimestamp: number,
    now: number
  ): number {
    return Math.max(0, targetTimestamp - now)
  }

  private describeCloudCodeAccountStatuses(
    model: string,
    limit: number = 10
  ): string {
    const now = Date.now()
    const pool = this.processPool.getPoolStatus()
    const quotaSnapshots = this.processPool.getCachedGoogleQuotaSnapshots()
    const quotaByEmail = new Map(
      quotaSnapshots.map((entry) => [entry.email, entry])
    )

    const entries = pool.entries
      .map((entry) => {
        const label = entry.email || entry.label || entry.id
        const modelCooldown = entry.modelCooldowns.find(
          (cooldown) => cooldown.model === model
        )
        const globalRemainingMs = this.formatCooldownRemainingMs(
          entry.cooldownUntil,
          now
        )
        const modelRemainingMs = modelCooldown
          ? this.formatCooldownRemainingMs(modelCooldown.cooldownUntil, now)
          : 0
        const effectiveRemainingMs = Math.max(
          globalRemainingMs,
          modelRemainingMs
        )
        const quotaSnapshot = entry.email
          ? quotaByEmail.get(entry.email)
          : undefined
        const modelQuota = quotaSnapshot?.models.find(
          (quotaEntry) => quotaEntry.name === model
        )
        const percentage = modelQuota?.percentage
        const resetTime = modelQuota?.resetTime

        let detail = "ready"
        if (entry.state === "unavailable" || entry.ready === false) {
          detail = "unavailable"
        } else if (modelCooldown?.reason === "capacity_exhausted") {
          detail = `model busy, retry in ${Math.ceil(effectiveRemainingMs / 1000)}s`
        } else if (modelCooldown?.quotaExhausted) {
          detail = `quota exhausted, retry in ${Math.ceil(effectiveRemainingMs / 1000)}s`
        } else if (modelCooldown?.reason === "rate_limited") {
          detail = `rate-limited, retry in ${Math.ceil(effectiveRemainingMs / 1000)}s`
        } else if (effectiveRemainingMs > 0) {
          const reasons: string[] = []
          if (globalRemainingMs > 0) {
            reasons.push(`global ${Math.ceil(globalRemainingMs / 1000)}s`)
          }
          if (modelRemainingMs > 0) {
            reasons.push(`${model} ${Math.ceil(modelRemainingMs / 1000)}s`)
          }
          detail = `rate-limited, retry in ${Math.ceil(effectiveRemainingMs / 1000)}s${reasons.length > 0 ? ` (${reasons.join(", ")})` : ""}`
        } else if (
          entry.state === "model_cooldown" ||
          entry.state === "degraded"
        ) {
          detail = `cooling for other models, available for ${model}`
        }

        const extras: string[] = []
        if (typeof percentage === "number") {
          extras.push(`quota=${percentage}%`)
        }
        if (resetTime) {
          try {
            const d = new Date(resetTime)
            if (!isNaN(d.getTime())) {
              const pad = (n: number) => n.toString().padStart(2, "0")
              const formatted = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
              extras.push(`reset=${formatted}`)
            } else {
              extras.push(`reset=${resetTime}`)
            }
          } catch {
            extras.push(`reset=${resetTime}`)
          }
        }

        return {
          label,
          state: entry.state,
          detail,
          effectiveRemainingMs,
          requestCount: entry.requestCount ?? 0,
          percentage: typeof percentage === "number" ? percentage : -1,
          extraText: extras.length > 0 ? `; ${extras.join("; ")}` : "",
        }
      })
      .sort((left, right) => {
        if (left.state !== right.state) {
          return (
            this.getBackendPoolStateRank(left.state) -
            this.getBackendPoolStateRank(right.state)
          )
        }
        if (right.percentage !== left.percentage) {
          return right.percentage - left.percentage
        }
        if (left.effectiveRemainingMs !== right.effectiveRemainingMs) {
          return left.effectiveRemainingMs - right.effectiveRemainingMs
        }
        return left.label.localeCompare(right.label)
      })

    const visibleEntries = entries.slice(0, limit)
    const lines = visibleEntries.map(
      (entry, index) =>
        `${index + 1}. ${entry.label} — ${entry.detail}${entry.extraText}; requests=${entry.requestCount}`
    )

    const hiddenCount = Math.max(0, entries.length - visibleEntries.length)
    if (hiddenCount > 0) {
      lines.push(`... and ${hiddenCount} more accounts not shown`)
    }

    return [
      `Pool snapshot for ${model}: total=${pool.total}, ready=${pool.ready}, degraded=${pool.degraded}, modelCooldown=${pool.modelCooldown}, cooling=${pool.cooling}, unavailable=${pool.unavailable}`,
      ...lines,
    ].join("\n")
  }

  private buildCloudCodeRateLimitMessage(
    model: string,
    waitMs: number
  ): string {
    return [
      `All Cloud Code Claude accounts are rate-limited for ${model}. Retry after ${Math.ceil(waitMs / 1000)}s.`,
      "Note: Codex rate-limit probes are a separate quota surface and do not imply Cloud Code Claude availability.",
      this.describeCloudCodeAccountStatuses(model),
    ].join("\n")
  }

  private buildCloudCodeTemporaryUnavailableMessage(
    model: string,
    waitMs: number
  ): string {
    return `All Cloud Code workers are temporarily unavailable for ${model}. Retry after ${Math.ceil(waitMs / 1000)}s.`
  }

  private markCurrentWorkerAttempted(
    excludedWorkerEmails: Set<string>
  ): string | null {
    const lastWorkerEmail = this.processPool.getLastWorkerEmail()?.trim()
    if (lastWorkerEmail) {
      excludedWorkerEmails.add(lastWorkerEmail)
      return lastWorkerEmail
    }
    return null
  }

  private hasAnotherWorkerAvailable(
    model: string,
    excludedWorkerEmails: Set<string>
  ): boolean {
    return this.processPool.hasAvailableWorkerForModel(model, {
      excludedWorkerEmails,
      requireGenerationCapacity: true,
    })
  }

  private buildWorkerPoolCooldownException(
    model: string,
    waitMs: number,
    reason?: WorkerPoolCooldownError["reason"]
  ): HttpException {
    if (reason === "capacity_exhausted" || reason === "transient") {
      return new HttpException(
        this.buildCloudCodeTemporaryUnavailableMessage(model, waitMs),
        HttpStatus.SERVICE_UNAVAILABLE
      )
    }

    return new HttpException(
      this.buildCloudCodeRateLimitMessage(model, waitMs),
      HttpStatus.TOO_MANY_REQUESTS
    )
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

  private getBackendPoolStateRank(state: string): number {
    switch (state) {
      case "ready":
        return 0
      case "degraded":
        return 1
      case "model_cooldown":
        return 2
      case "cooldown":
        return 3
      case "disabled":
        return 4
      case "unavailable":
        return 5
      default:
        return 6
    }
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
    const sourceConversationKey =
      typeof payload.__workerConversationKey === "string"
        ? payload.__workerConversationKey.trim()
        : ""
    if (sourceConversationKey) {
      return sourceConversationKey
    }

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
   * Order: Retry-After header -> RetryInfo.retryDelay -> ErrorInfo.metadata.quotaResetDelay -> error.message regex
   */
  private parseRetryDelayMs(errText: string): number | null {
    const retryAfterMs = this.parseRetryAfterMs(errText)
    if (retryAfterMs != null) {
      return retryAfterMs
    }

    const parseDelayFromMessage = (message: string): number | null => {
      const durationMatch = message.match(
        /(?:quota will reset|retry(?:ing)?(?: after)?)\s+after\s+((?:[\d.]+\s*(?:ms|s|m|h))+)\.?/i
      )
      if (durationMatch?.[1]) {
        const durationMs = this.parseDurationMs(durationMatch[1])
        if (durationMs != null) {
          return durationMs
        }
      }

      const secondsMatch = message.match(/after\s+(\d+)s\.?/i)
      if (secondsMatch?.[1]) {
        const seconds = parseInt(secondsMatch[1], 10)
        if (Number.isFinite(seconds)) {
          return seconds * 1000
        }
      }

      return null
    }

    const errObj = this.parseCloudCodeErrorEnvelope(errText)
    if (!errObj?.error) {
      return parseDelayFromMessage(errText)
    }

    const candidates = [errObj.error]
    if (typeof errObj.error.message === "string") {
      const nested = this.parseCloudCodeErrorEnvelope(errObj.error.message)
      if (nested?.error) {
        candidates.push(nested.error)
      }
    }

    for (const candidate of candidates) {
      const details = Array.isArray(candidate.details) ? candidate.details : []

      const retryInfo = details.find((d) => d["@type"]?.includes("RetryInfo"))
      if (retryInfo?.retryDelay) {
        const ms = this.parseDurationMs(retryInfo.retryDelay)
        if (ms != null) {
          return ms
        }
      }

      const metaDelay =
        details.find((d) => d["@type"]?.includes("ErrorInfo"))?.metadata
          ?.quotaResetDelay ??
        details.find((d) => d.metadata?.quotaResetDelay)?.metadata
          ?.quotaResetDelay
      if (metaDelay) {
        const ms = this.parseDurationMs(metaDelay)
        if (ms != null) {
          return ms
        }
      }

      const message =
        typeof candidate.message === "string" ? candidate.message : ""
      const messageDelayMs = parseDelayFromMessage(message)
      if (messageDelayMs != null) {
        return messageDelayMs
      }
    }

    return parseDelayFromMessage(errText)
  }

  private parseQuotaResetDelayFromMessage(message: string): number | null {
    const patterns = [
      /quota will reset after\s+((?:[\d.]+\s*(?:ms|s|m|h))+)\.?/i,
      /quota reset after\s+((?:[\d.]+\s*(?:ms|s|m|h))+)\.?/i,
      /quotaResetDelay["'=:\s]+([^\s,"}\]]+)/i,
    ]

    for (const pattern of patterns) {
      const match = message.match(pattern)
      if (!match?.[1]) continue
      const durationMs = this.parseDurationMs(match[1])
      if (durationMs != null) {
        return durationMs
      }
    }

    return null
  }

  private parseQuotaResetTimestampMs(
    timestamp: string | null | undefined
  ): number | null {
    if (!timestamp) return null
    const resetAt = Date.parse(String(timestamp).trim())
    if (Number.isNaN(resetAt)) return null
    return Math.max(0, resetAt - Date.now())
  }

  /**
   * Parse durable quota reset timing only.
   * This intentionally ignores Retry-After / RetryInfo because those can be
   * request-local backoff hints rather than the true quota reset boundary.
   */
  private parseQuotaResetDelayMs(errText: string): number | null {
    const errObj = this.parseCloudCodeErrorEnvelope(errText)
    if (!errObj?.error) {
      return this.parseQuotaResetDelayFromMessage(errText)
    }

    const candidates = [errObj.error]
    if (typeof errObj.error.message === "string") {
      const nested = this.parseCloudCodeErrorEnvelope(errObj.error.message)
      if (nested?.error) {
        candidates.push(nested.error)
      }
    }

    for (const candidate of candidates) {
      const details = Array.isArray(candidate.details) ? candidate.details : []
      const metaTimestamp =
        details.find((d) => d["@type"]?.includes("ErrorInfo"))?.metadata
          ?.quotaResetTimeStamp ??
        details.find((d) => d["@type"]?.includes("ErrorInfo"))?.metadata
          ?.quotaResetUTCTimestamp ??
        details.find((d) => d.metadata?.quotaResetTimeStamp)?.metadata
          ?.quotaResetTimeStamp ??
        details.find((d) => d.metadata?.quotaResetUTCTimestamp)?.metadata
          ?.quotaResetUTCTimestamp
      if (metaTimestamp) {
        const ms = this.parseQuotaResetTimestampMs(metaTimestamp)
        if (ms != null) {
          return ms
        }
      }

      const metaDelay =
        details.find((d) => d["@type"]?.includes("ErrorInfo"))?.metadata
          ?.quotaResetDelay ??
        details.find((d) => d.metadata?.quotaResetDelay)?.metadata
          ?.quotaResetDelay
      if (metaDelay) {
        const ms = this.parseDurationMs(metaDelay)
        if (ms != null) {
          return ms
        }
      }

      const message =
        typeof candidate.message === "string" ? candidate.message : ""
      const messageDelayMs = this.parseQuotaResetDelayFromMessage(message)
      if (messageDelayMs != null) {
        return messageDelayMs
      }
    }

    return this.parseQuotaResetDelayFromMessage(errText)
  }

  private getCachedQuotaResetDelayMs(
    model: string,
    workerEmail?: string | null
  ): number | null {
    const normalizedEmail = workerEmail?.trim()
    if (!normalizedEmail) return null

    const snapshot = this.processPool
      .getCachedGoogleQuotaSnapshots()
      .find((entry) => entry.email === normalizedEmail)
    const resetTime = snapshot?.models.find(
      (entry) => entry.name === model
    )?.resetTime
    if (!resetTime) return null

    const resetAt = Date.parse(resetTime)
    if (Number.isNaN(resetAt)) return null
    return Math.max(0, resetAt - Date.now())
  }

  private resolveQuotaExhaustedCooldownMs(
    model: string,
    errText: string,
    workerEmail?: string | null
  ): number {
    const stableResetDelayMs =
      this.parseQuotaResetDelayMs(errText) ??
      this.getCachedQuotaResetDelayMs(model, workerEmail)
    if (stableResetDelayMs != null) {
      return Math.max(stableResetDelayMs, this.MIN_QUOTA_EXHAUSTED_COOLDOWN_MS)
    }
    return this.QUOTA_EXHAUSTED_DEFAULT_COOLDOWN_MS
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

  private isModelCapacityExhausted(errMsg: string): boolean {
    const normalized = this.extractCloudCodeErrorText(errMsg).toLowerCase()
    return (
      normalized.includes("model_capacity_exhausted") ||
      normalized.includes("no capacity available for model") ||
      (normalized.includes("unavailable") &&
        normalized.includes("backenderror") &&
        normalized.includes("claude-opus"))
    )
  }

  private summarizeCloudCodeErrorForLog(errMsg: string): string {
    const traceMatch = errMsg.match(/trace-id=([^\]\s]+)/i)
    const statusMatch = errMsg.match(/\b(\d{3})\b/)
    const normalized = this.extractCloudCodeErrorText(errMsg)
      .replace(/\s+/g, " ")
      .trim()

    let summary = normalized
    if (this.isModelCapacityExhausted(errMsg)) {
      summary = "model capacity exhausted"
    } else if (this.isQuotaExhausted(errMsg)) {
      summary = "quota exhausted"
    } else if (normalized.length > 240) {
      summary = normalized.slice(0, 240) + "…"
    }

    const tags: string[] = []
    if (statusMatch?.[1]) tags.push(`status=${statusMatch[1]}`)
    if (traceMatch?.[1]) tags.push(`trace=${traceMatch[1]}`)
    return tags.length > 0 ? `${summary} [${tags.join(" ")}]` : summary
  }

  private buildStreamProgressWatchdogReason(
    model: string,
    elapsedMs: number
  ): string {
    return `${this.STREAM_PROGRESS_WATCHDOG_ABORT_PREFIX}: no effective progress for ${model} after ${elapsedMs}ms`
  }

  private isStreamProgressWatchdogAbort(errMsg: string): boolean {
    return errMsg.includes(this.STREAM_PROGRESS_WATCHDOG_ABORT_PREFIX)
  }

  private isCloudCodeInactivityTimeoutFailure(errMsg: string): boolean {
    const normalized = errMsg.toLowerCase()
    return (
      normalized.includes("cloud code streamgeneratecontent") &&
      normalized.includes("timeout after")
    )
  }

  private isRetryableWorkerFailure(errMsg: string): boolean {
    const normalized = errMsg.toLowerCase()
    return (
      normalized.includes("worker request timeout") ||
      normalized.includes("worker stream timeout") ||
      normalized.includes("econnreset") ||
      normalized.includes("etimedout") ||
      normalized.includes("socket hang up") ||
      normalized.includes("network socket disconnected") ||
      normalized.includes("connection reset by peer") ||
      this.isCloudCodeInactivityTimeoutFailure(errMsg) ||
      this.isModelCapacityExhausted(errMsg)
    )
  }

  private getRetryableWorkerFailureCooldownMs(errMsg: string): number {
    const normalized = errMsg.toLowerCase()
    if (
      normalized.includes("loadcodeassist") ||
      normalized.includes("fetchuserinfo") ||
      normalized.includes("getuserstatus")
    ) {
      return this.TRANSIENT_WORKER_FAILURE_COOLDOWN_MS
    }
    return this.TRANSIENT_TRANSPORT_FAILURE_COOLDOWN_MS
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

    const parsed = this.parseCloudCodeErrorEnvelope(errorBody)
    if (!parsed?.error) {
      return parts.join("\n")
    }

    const outerMessage = parsed.error.message
    if (typeof outerMessage === "string" && outerMessage.length > 0) {
      parts.push(outerMessage)
      const nested = this.parseCloudCodeErrorEnvelope(outerMessage) as {
        type?: unknown
        error?: { type?: unknown; message?: unknown }
        request_id?: unknown
      } | null
      if (typeof nested?.type === "string") parts.push(nested.type)
      if (typeof nested?.error?.type === "string") {
        parts.push(nested.error.type)
      }
      if (typeof nested?.error?.message === "string") {
        parts.push(nested.error.message)
      }
      if (typeof nested?.request_id === "string") {
        parts.push(nested.request_id)
      }
    }
    if (typeof parsed.error.status === "string") {
      parts.push(parsed.error.status)
    }

    return parts.join("\n")
  }

  private parseCloudCodeErrorEnvelope(errorText: string): {
    error?: {
      message?: string
      status?: string
      details?: Array<{
        "@type"?: string
        retryDelay?: string
        metadata?: {
          quotaResetDelay?: string
          quotaResetTimeStamp?: string
          quotaResetUTCTimestamp?: string
        }
      }>
    }
  } | null {
    const jsonCandidates: string[] = [errorText]
    const firstBrace = errorText.indexOf("{")
    if (firstBrace > 0) {
      jsonCandidates.push(errorText.slice(firstBrace))
    }

    for (const candidate of jsonCandidates) {
      try {
        return JSON.parse(candidate) as {
          error?: {
            message?: string
            status?: string
            details?: Array<{
              "@type"?: string
              retryDelay?: string
              metadata?: {
                quotaResetDelay?: string
                quotaResetTimeStamp?: string
                quotaResetUTCTimestamp?: string
              }
            }>
          }
        }
      } catch {
        // Try next candidate
      }
    }

    return null
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

  private isCloudCodeToolProtocolError(errorBody: string): boolean {
    const normalized = this.extractCloudCodeErrorText(errorBody)
    return (
      normalized.includes("unexpected") &&
      normalized.includes("tool_result") &&
      normalized.includes("tool_use_id")
    )
  }

  /**
   * Adaptive fallback when Cloud Code reports prompt-too-long.
   * Shrinks oldest request contents while preserving latest turns.
   */
  private tryShrinkPayloadContentsForPromptLimit(
    payload: Record<string, unknown>,
    promptLimit: { actual: number; max: number },
    shrinkAttempt: number,
    protectedPrefixCount: number = 0
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

    // Extend the protected prefix to also cover compaction boundary/summary
    // messages that sit immediately after the Google context prefix.
    // These messages contain the compressed context from earlier conversation
    // turns and must survive the shrink pass to avoid losing archived context.
    const effectiveProtectedCount =
      protectedPrefixCount +
      this.countCompactionPrefixMessages(originalContents, protectedPrefixCount)

    const protectedPrefix = originalContents.slice(0, effectiveProtectedCount)
    const shrinkableContents = originalContents.slice(effectiveProtectedCount)
    if (
      shrinkableContents.length === 0 ||
      (protectedPrefix.length === 0 && shrinkableContents.length <= 1)
    ) {
      return null
    }

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

    let dropCount = Math.ceil(shrinkableContents.length * requiredRatio)
    const maxDroppable =
      protectedPrefix.length > 0
        ? shrinkableContents.length
        : shrinkableContents.length - 1
    if (maxDroppable <= 0) return null
    dropCount = Math.max(1, Math.min(dropCount, maxDroppable))

    const trimmed = [...protectedPrefix, ...shrinkableContents.slice(dropCount)]
    if (trimmed.length <= 0) return null

    const normalized = this.stripPromptShrinkMetadata(
      this.normalizeContentsForPromptShrink(trimmed)
    )
    if (normalized.contents.length <= 0) return null

    requestObj.contents = normalized.contents

    return {
      dropped: Math.max(
        0,
        originalContents.length - normalized.contents.length
      ),
      remaining: (requestObj.contents as unknown[]).length,
      removedFunctionResponses: normalized.removedFunctionResponses,
    }
  }

  /**
   * Count the number of compaction boundary/summary messages that
   * immediately follow the protected prefix in the contents array.
   *
   * These messages are generated by ContextProjectionService.project()
   * and contain `[Context boundary ...]` / `[Context summary ...]`
   * markers. They must be preserved during prompt shrink to avoid
   * losing archived conversation context.
   */
  private countCompactionPrefixMessages(
    contents: Array<Record<string, unknown>>,
    startIndex: number
  ): number {
    let count = 0
    for (let i = startIndex; i < contents.length; i++) {
      const entry = contents[i]
      if (entry && this.isCompactionPrefixMessage(entry)) {
        count++
      } else {
        break
      }
    }
    return count
  }

  /**
   * Check whether a Google-format content entry is a compaction
   * boundary or summary message produced by the projection service.
   */
  private isCompactionPrefixMessage(content: Record<string, unknown>): boolean {
    const parts = content.parts
    if (!Array.isArray(parts) || parts.length === 0) return false

    const firstPart = parts[0] as Record<string, unknown> | undefined
    if (!firstPart) return false

    const text = firstPart.text
    if (typeof text !== "string") return false

    return (
      text.startsWith("[Context boundary ") ||
      text.startsWith("[Context summary ")
    )
  }

  private normalizeProtectedContextPrefixCount(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return 0
    }

    return Math.max(0, Math.floor(value))
  }

  private sanitizeClaudeContentsForSend(
    contents: Array<Record<string, unknown>>
  ): {
    contents: Array<Record<string, unknown>>
    removedFunctionResponses: number
    removedInvalidThoughtParts: number
    droppedMessages: number
  } {
    const normalized = this.stripPromptShrinkMetadata(
      this.normalizeContentsForPromptShrink(contents)
    )

    return {
      contents: normalized.contents,
      removedFunctionResponses: normalized.removedFunctionResponses,
      removedInvalidThoughtParts: normalized.removedInvalidThoughtParts,
      droppedMessages: Math.max(
        0,
        contents.length - normalized.contents.length
      ),
    }
  }

  private stripPromptShrinkMetadata(contents: Array<Record<string, unknown>>): {
    contents: Array<Record<string, unknown>>
    removedFunctionResponses: number
    removedInvalidThoughtParts: number
  } {
    let removedFunctionResponses = 0
    let removedInvalidThoughtParts = 0

    for (const msg of contents) {
      if (!msg || typeof msg !== "object") continue
      const removed = (msg as { __removedFunctionResponses?: number })
        .__removedFunctionResponses
      if (typeof removed === "number" && removed > 0) {
        removedFunctionResponses += removed
      }
      delete (msg as { __removedFunctionResponses?: number })
        .__removedFunctionResponses

      const removedThoughts = (msg as { __removedInvalidThoughtParts?: number })
        .__removedInvalidThoughtParts
      if (typeof removedThoughts === "number" && removedThoughts > 0) {
        removedInvalidThoughtParts += removedThoughts
      }
      delete (msg as { __removedInvalidThoughtParts?: number })
        .__removedInvalidThoughtParts
    }

    return {
      contents,
      removedFunctionResponses,
      removedInvalidThoughtParts,
    }
  }

  private sanitizeCloudCodeThoughtParts(
    parts: Array<Record<string, unknown>>
  ): {
    parts: Array<Record<string, unknown>>
    removedInvalidThoughtParts: number
  } {
    if (!Array.isArray(parts) || parts.length === 0) {
      return {
        parts: [],
        removedInvalidThoughtParts: 0,
      }
    }

    const sanitized: Array<Record<string, unknown>> = []
    const pendingThoughtIndexes: number[] = []
    let removedInvalidThoughtParts = 0

    const dropPendingThoughts = () => {
      while (pendingThoughtIndexes.length > 0) {
        const index = pendingThoughtIndexes.pop()!
        sanitized.splice(index, 1)
        removedInvalidThoughtParts++
      }
    }

    for (const rawPart of parts) {
      if (!rawPart || typeof rawPart !== "object") continue
      const part = { ...rawPart }
      const isThoughtPart =
        part.thought === true &&
        typeof part.text === "string" &&
        part.text.length > 0

      if (isThoughtPart) {
        pendingThoughtIndexes.push(sanitized.length)
        sanitized.push(part)
        continue
      }

      const hasThoughtSignature =
        typeof part.thoughtSignature === "string" &&
        part.thoughtSignature.trim().length > 0

      if (pendingThoughtIndexes.length > 0) {
        if (hasThoughtSignature) {
          pendingThoughtIndexes.length = 0
        } else {
          dropPendingThoughts()
        }
      }

      sanitized.push(part)
    }

    if (pendingThoughtIndexes.length > 0) {
      dropPendingThoughts()
    }

    return {
      parts: sanitized,
      removedInvalidThoughtParts,
    }
  }

  private normalizeContentsForPromptShrink(
    contents: Array<Record<string, unknown>>
  ): Array<Record<string, unknown>> {
    if (!Array.isArray(contents) || contents.length === 0) return []

    const prepared: Array<Record<string, unknown>> = []

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

      prepared.push({
        ...message,
        role,
        parts,
      })
    }

    while (
      prepared.length > 1 &&
      (prepared[0] as { role?: unknown })?.role === "model"
    ) {
      prepared.shift()
    }

    const normalized: Array<Record<string, unknown>> = []

    for (const message of prepared) {
      const role = message.role as string
      const parts = message.parts as Array<Record<string, unknown>>

      let filteredParts = parts
      let removedFunctionResponses = 0
      let removedInvalidThoughtParts = 0

      if (role === "model") {
        const sanitizedThoughts = this.sanitizeCloudCodeThoughtParts(parts)
        filteredParts = sanitizedThoughts.parts
        removedInvalidThoughtParts =
          sanitizedThoughts.removedInvalidThoughtParts
      }

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
      if (removedInvalidThoughtParts > 0) {
        clonedMessage.__removedInvalidThoughtParts = removedInvalidThoughtParts
      }

      normalized.push(clonedMessage)
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

  private async sleepAbortable(
    ms: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (!abortSignal) {
      await this.sleep(ms)
      return
    }
    if (abortSignal.aborted) {
      throw new UpstreamRequestAbortedError(
        "Request aborted during recovery wait"
      )
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        abortSignal.removeEventListener("abort", onAbort)
        resolve()
      }, ms)
      if (timer && typeof timer.unref === "function") {
        timer.unref()
      }
      const onAbort = () => {
        clearTimeout(timer)
        reject(
          new UpstreamRequestAbortedError(
            "Request aborted during recovery wait"
          )
        )
      }
      abortSignal.addEventListener("abort", onAbort, { once: true })
    })
  }

  /**
   * When all workers are exhausted (429 or 503), wait for the shortest
   * cooldown to expire, then clear the exclusion set so the next iteration
   * performs a fresh sweep of the entire pool.
   *
   * Returns true if recovery was initiated (caller should reset the loop
   * counter via `attempt = -1` and continue).
   */
  private async maybeRecoveryPass(
    model: string,
    waitMs: number,
    excludedWorkerEmails: Set<string>,
    recoveryState: { totalWaitedMs: number },
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    if (
      waitMs <= 0 ||
      waitMs > this.RECOVERY_PASS_MAX_WAIT_MS ||
      recoveryState.totalWaitedMs + waitMs > this.RECOVERY_BUDGET_MS
    ) {
      return false
    }
    recoveryState.totalWaitedMs += waitMs
    this.logger.warn(
      `[pool-recover] All workers exhausted for ${model}; waiting ${waitMs}ms before recovery sweep (budget ${recoveryState.totalWaitedMs}/${this.RECOVERY_BUDGET_MS}ms)`
    )
    await this.sleepAbortable(waitMs, abortSignal)
    excludedWorkerEmails.clear()
    return true
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

  private extractStructuredToolResultResponse(
    value: unknown
  ): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null
    }

    try {
      // structuredClone correctly handles BigInt, Date, undefined, and
      // circular references — unlike JSON roundtrip which throws on BigInt
      // and silently drops undefined/Date/RegExp values.
      return structuredClone(value) as Record<string, unknown>
    } catch {
      return { ...(value as Record<string, unknown>) }
    }
  }

  private buildFunctionResponsePayload(
    block: Record<string, unknown>
  ): Record<string, unknown> {
    const structured = this.extractStructuredToolResultResponse(
      block.structuredContent
    )
    if (structured) {
      return structured
    }

    const resultText = this.extractToolResultOutput(block.content)
    return {
      output: resultText || ".",
    }
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
    private readonly modelCache: GoogleModelCacheService,
    private readonly signatureStore: ToolThoughtSignatureService,
    private readonly tokenCounter: TokenCounterService,
    private readonly usageStats: UsageStatsService
  ) {
    this.logger.log(
      `System prompt mode: ${this.systemPromptMode} (${this.officialSystemPrompt.length} chars)`
    )
    if (!this.useOfficialAntigravityTools) {
      this.logger.warn(
        "Official Antigravity tool declarations are DISABLED — Claude will use Cursor tool passthrough"
      )
    }
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
    hardLimit: number = this.CLOUD_CODE_HARD_TOKEN_LIMIT,
    protectedPrefixCount: number = 0
  ): {
    enforced: boolean
    originalTokens: number
    finalTokens: number
    withinLimit: boolean
  } {
    const originalTokens = this.tokenCounter.countGooglePayloadTokens(
      payload as Parameters<TokenCounterService["countGooglePayloadTokens"]>[0]
    )
    let finalTokens = originalTokens
    const normalizedProtectedPrefixCount =
      this.normalizeProtectedContextPrefixCount(protectedPrefixCount)

    if (finalTokens > hardLimit) {
      for (
        let shrinkAttempt = 0;
        shrinkAttempt < this.MAX_PROMPT_SHRINK_RETRIES &&
        finalTokens > hardLimit;
        shrinkAttempt++
      ) {
        const shrinkResult = this.tryShrinkPayloadContentsForPromptLimit(
          payload,
          { actual: finalTokens, max: hardLimit },
          shrinkAttempt,
          normalizedProtectedPrefixCount
        )
        if (!shrinkResult) {
          break
        }

        finalTokens = this.tokenCounter.countGooglePayloadTokens(
          payload as Parameters<
            TokenCounterService["countGooglePayloadTokens"]
          >[0]
        )
      }
    }

    return {
      enforced: originalTokens > hardLimit,
      originalTokens,
      finalTokens,
      withinLimit: finalTokens <= hardLimit,
    }
  }

  private assertTokenBudgetWithinLimit(
    operation: "sendClaudeMessage" | "sendClaudeMessageStream",
    budgetResult: {
      enforced: boolean
      originalTokens: number
      finalTokens: number
      withinLimit: boolean
    },
    hardLimit: number
  ): void {
    if (budgetResult.withinLimit) {
      return
    }

    throw new BackendApiError(
      `Cloud Code ${operation} payload exceeds prompt limit after payload compaction (${budgetResult.finalTokens} > ${hardLimit})`,
      {
        backend: "google",
        statusCode: 400,
        permanent: false,
      }
    )
  }

  /**
   * Execute grounded web search via Cloud Code API (requestType=web_search).
   * Routed through native Worker IPC for proper OAuth authentication.
   */
  async executeWebSearch(query: string): Promise<{
    text: string
    references: Array<{ title: string; url: string; chunk: string }>
  }> {
    const normalizedQuery = query.trim()
    if (!normalizedQuery) return { text: "", references: [] }

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
      return {
        text: this.withWebSearchSources(text, references),
        references,
      }
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
  async generateTabName(userRequest: string): Promise<string> {
    if (!this.processPool.isConfigured()) return ""
    try {
      const trimmedRequest = userRequest.trim()
      if (!trimmedRequest) return ""

      const tabNamingContents = [
        {
          role: "user" as const,
          parts: [
            {
              text:
                "Generate a short conversation title from the user's request.\n\n" +
                "Rules:\n" +
                "- Summarize only the user's request.\n" +
                "- Keep it concise, 3-8 words.\n" +
                "- No quotes.\n" +
                "- No markdown.\n" +
                "- No trailing punctuation.\n" +
                "- Return ONLY the title.\n\n" +
                "User request:\n" +
                trimmedRequest,
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
      const data = (await this.processPool.generate(
        payload,
        "tab_flash_lite_preview"
      )) as Record<string, unknown>
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

        const originalToolName = part.functionCall.name
        const mappedToolName =
          this.fromOfficialAntigravityToolName(originalToolName)
        const toolUseBlock = {
          type: "tool_use",
          id: toolId,
          name: mappedToolName,
          input: this.adaptOfficialAntigravityToolInput(
            originalToolName,
            part.functionCall.args || {}
          ),
        }

        this.rememberToolName(toolId, mappedToolName)

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
    const stopReason = this.mapGeminiFinishReason(finishReason, hasToolCall)

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
  private mapGeminiFinishReason(
    finishReason: string | undefined,
    sawToolUse: boolean
  ): string {
    switch (finishReason) {
      case "MAX_TOKENS":
        return "max_tokens"
      case "STOP":
      case "FINISH_REASON_UNSPECIFIED":
      case "SAFETY":
      case "RECITATION":
      case "BLOCKLIST":
      case "PROHIBITED_CONTENT":
      case "SPII":
      case "MALFORMED_FUNCTION_CALL":
      default:
        return sawToolUse ? "tool_use" : "end_turn"
    }
  }

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

  private toOfficialAntigravityToolName(name: string): string {
    return toOfficialAntigravityToolNameFromContract(name)
  }

  private fromOfficialAntigravityToolName(name: string): string {
    return fromOfficialAntigravityToolNameFromContract(name)
  }

  private adaptOfficialAntigravityToolInput(
    officialName: string,
    input: Record<string, unknown>
  ): Record<string, unknown> {
    return adaptOfficialAntigravityToolInputFromContract(officialName, input)
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
        return { mode: "VALIDATED" }
      case "tool": {
        const config: Record<string, unknown> = { mode: "VALIDATED" }
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

  private getOfficialThinkingProfile(model: string): {
    supportsThinking?: boolean
    thinkingBudget?: number
    minThinkingBudget?: number
  } {
    const cached = this.modelCache.getModelInfo(model)
    if (
      cached &&
      (cached.supportsThinking === true ||
        typeof cached.thinkingBudget === "number" ||
        typeof cached.minThinkingBudget === "number")
    ) {
      return {
        supportsThinking: cached.supportsThinking,
        thinkingBudget: cached.thinkingBudget,
        minThinkingBudget: cached.minThinkingBudget,
      }
    }

    const fallback: Record<
      string,
      {
        supportsThinking: boolean
        thinkingBudget?: number
        minThinkingBudget?: number
      }
    > = {
      "claude-opus-4-6-thinking": {
        supportsThinking: true,
        thinkingBudget: 1024,
      },
      "claude-sonnet-4-6": {
        supportsThinking: true,
        thinkingBudget: 1024,
      },
      "gemini-2.5-pro": {
        supportsThinking: true,
        thinkingBudget: 1024,
        minThinkingBudget: 128,
      },
      "gemini-3.1-pro-low": {
        supportsThinking: true,
        thinkingBudget: 1001,
        minThinkingBudget: 128,
      },
      "gemini-3.1-pro-high": {
        supportsThinking: true,
        thinkingBudget: 10001,
        minThinkingBudget: 128,
      },
      "gemini-3-pro-low": {
        supportsThinking: true,
        thinkingBudget: 128,
        minThinkingBudget: 128,
      },
      "gpt-oss-120b-medium": {
        supportsThinking: true,
        thinkingBudget: 8192,
      },
      "gemini-3-flash": {
        supportsThinking: true,
        minThinkingBudget: 32,
      },
      "gemini-3-flash-agent": {
        supportsThinking: true,
        minThinkingBudget: 32,
      },
      "gemini-3-pro-high": {
        supportsThinking: true,
        minThinkingBudget: 128,
      },
    }
    return fallback[model] || {}
  }

  private resolveCloudCodeThinkingBudget(
    model: string,
    explicitBudget: number | undefined,
    requestedEffort: string | undefined
  ): number {
    const profile = this.getOfficialThinkingProfile(model)
    const normalizedEffort = requestedEffort?.trim().toLowerCase()
    const minBudget =
      typeof profile.minThinkingBudget === "number" &&
      profile.minThinkingBudget > 0
        ? profile.minThinkingBudget
        : undefined
    const defaultBudget =
      typeof profile.thinkingBudget === "number" && profile.thinkingBudget > 0
        ? profile.thinkingBudget
        : undefined

    if (typeof explicitBudget === "number" && explicitBudget > 0) {
      return Math.max(explicitBudget, minBudget || 0)
    }

    if (normalizedEffort === "low" || normalizedEffort === "minimal") {
      return minBudget || defaultBudget || 1024
    }

    // Effort-based budget tiers for Claude on Cloud Code.
    // References:
    //   Vertex AI migration guide: LOW ≤1,024; MEDIUM 1,024–8,192; HIGH >8,192
    //   Anthropic legacy guidance: simple 1–2k; moderate 4–8k; complex 20–50k+
    //   Cloud Code official: gpt-oss-120b-medium=8,192; gemini-3.1-pro-high=10,001
    // Budget tiers: low=1,024  medium=4,096  high=8,192  xhigh=10,240  max=32,768
    if (normalizedEffort === "max") {
      return 32768
    }

    if (normalizedEffort === "xhigh") {
      return 10240
    }

    if (normalizedEffort === "high") {
      return 8192
    }

    if (normalizedEffort === "medium") {
      return 4096
    }

    if (normalizedEffort === "auto") {
      return defaultBudget || minBudget || 1024
    }

    return defaultBudget || minBudget || 1024
  }

  /**
   * Estimate task complexity from request signals to auto-derive
   * Cloud Code thinkingBudget when no explicit effort is set.
   * Returns an effort string ("high") or undefined (use default).
   * Capped at "high" — only MAX Mode can trigger "max".
   */
  private estimateClaudeTaskComplexity(
    dto: CreateMessageDto
  ): string | undefined {
    // Only run auto-estimation when explicitly enabled via dashboard setting
    if (process.env.THINKING_BUDGET_AUTO !== "true") {
      return undefined
    }

    let score = 0

    // Signal 1: Conversation depth (max +3)
    const messageCount = dto.messages?.length || 0
    if (messageCount >= 30) {
      score += 3
    } else if (messageCount >= 20) {
      score += 2
    } else if (messageCount >= 10) {
      score += 1
    }

    // Signal 2: Tool availability (max +2)
    const toolCount = dto.tools?.length || 0
    if (toolCount >= 20) {
      score += 2
    } else if (toolCount >= 10) {
      score += 1
    }

    // Signal 3: Last user message length (max +3)
    const lastUserMsg = [...(dto.messages || [])]
      .reverse()
      .find((m) => m.role === "user")
    const lastMsgText =
      typeof lastUserMsg?.content === "string"
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg?.content)
          ? lastUserMsg.content
              .map((c) => (typeof c === "object" && c.text ? c.text : ""))
              .join("")
          : ""
    if (lastMsgText.length > 8000) {
      score += 3
    } else if (lastMsgText.length > 4000) {
      score += 2
    } else if (lastMsgText.length > 1500) {
      score += 1
    }

    // Signal 4: Complexity keywords in last user message (max +2)
    const complexityKeywords =
      /\b(refactor|architect|review|debug|fix|migration|redesign|optimize|complex|multi.?file|重构|架构|审查|调试|优化|迁移)\b/i
    if (complexityKeywords.test(lastMsgText)) {
      score += 2
    }

    // Score → effort mapping (capped at "xhigh"; max is MAX-Mode-only)
    // Max possible score = 3+2+3+2 = 10
    // Budget tiers: low=1,024  medium=4,096  high=8,192  xhigh=10,240  max=32,768
    const effortLabel =
      score >= 8
        ? "xhigh"
        : score >= 6
          ? "high"
          : score >= 4
            ? "medium"
            : score >= 2
              ? "low"
              : undefined
    if (effortLabel) {
      this.logger.debug(
        `Claude task complexity auto-estimate: score=${score} → ${effortLabel} (messages=${messageCount}, tools=${toolCount}, msgLen=${lastMsgText.length})`
      )
      return effortLabel
    }

    return undefined
  }

  private buildClaudeThinkingConfig(
    dto: CreateMessageDto,
    resolvedModel: string
  ): Record<string, unknown> | null {
    if (this.shouldDisableThinkingForToolChoice(dto.tool_choice)) {
      return null
    }

    const thinkingIntent = resolveThinkingIntentFromDto(dto)
    if (thinkingIntent?.mode === "disabled") {
      return null
    }

    // Official Antigravity sends Cloud Code thinkingConfig for Claude thinking
    // model IDs even when the Cursor-side request does not carry explicit
    // thinkingDetails. Keep that default at the Cloud Code serialization layer
    // so non-Claude/non-thinking routes remain controlled by the parsed request.
    if (!thinkingIntent && resolvedModel.includes("thinking")) {
      const autoEffort = this.estimateClaudeTaskComplexity(dto)
      const thinkingBudget = this.resolveCloudCodeThinkingBudget(
        resolvedModel,
        undefined,
        autoEffort
      )
      return {
        includeThoughts: true,
        thinkingBudget,
      }
    }

    if (!thinkingIntent) {
      return null
    }

    if (thinkingIntent.mode === "explicit_budget") {
      const thinkingBudget = this.resolveCloudCodeThinkingBudget(
        resolvedModel,
        thinkingIntent.budgetTokens,
        undefined
      )
      return {
        includeThoughts: true,
        thinkingBudget,
      }
    }

    if (
      thinkingIntent.mode === "adaptive" ||
      thinkingIntent.mode === "explicit_effort"
    ) {
      const effort =
        thinkingIntent.mode === "explicit_effort"
          ? thinkingIntent.effort
          : thinkingIntent.effort || this.estimateClaudeTaskComplexity(dto)
      const thinkingBudget = this.resolveCloudCodeThinkingBudget(
        resolvedModel,
        undefined,
        effort
      )
      if (effort) {
        const effortSource =
          thinkingIntent.mode === "explicit_effort" || thinkingIntent.effort
            ? "explicit"
            : "auto-estimated"
        this.logger.debug(
          `Cloud Code adaptive thinking: effort=${effort} (${effortSource}) → budget=${thinkingBudget} for ${resolvedModel}`
        )
      }
      return {
        includeThoughts: true,
        thinkingBudget,
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
      hasTools && !!thinkingConfig && doesModelSupportThinking(resolvedModel)
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
    // Bridge-level system prompt (language rules, tool usage, etc.) comes first
    // so it takes highest priority. The official Antigravity prompt follows as the
    // base systemInstruction for Cloud Code routing.
    const systemParts: Array<{ text: string }> = []
    const bridgeSystemPrompt = this.extractSystemPromptText(dto.system)
    if (bridgeSystemPrompt) {
      systemParts.push({ text: bridgeSystemPrompt })
    }
    if (this.officialSystemPrompt) {
      systemParts.push({ text: this.officialSystemPrompt })
    }
    const resolvedMaxOutputTokens = this.resolveCloudCodeMaxOutputTokens(
      dto.max_tokens
    )
    const thinkingConfig = this.buildClaudeThinkingConfig(dto, resolvedModel)
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

    // Add tools if present. Claude Cloud Code uses the official
    // Antigravity-native tool surface when useOfficialAntigravityTools is enabled;
    // otherwise all models (including Claude) use direct tool passthrough.
    if (dto.tools && dto.tools.length > 0) {
      const toolDeclarations = this.buildCloudCodeToolDeclarations(
        dto.tools as Array<{
          name?: unknown
          description?: unknown
          input_schema?: unknown
        }>,
        this.useOfficialAntigravityTools && this.isClaudeModel(resolvedModel)
      )
      if (toolDeclarations.length > 0) {
        request.tools = toolDeclarations
        const functionCallingConfig = this.buildCloudCodeFunctionCallingConfig(
          dto.tool_choice
        )
        request.toolConfig = {
          functionCallingConfig: functionCallingConfig || {
            mode: "VALIDATED",
          },
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
        text: "Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.\n\nLanguage usage rules:\n- Always respond in the same language the user is writing in.\n- Your internal thinking and reasoning (think/thought blocks) must also use the user's language.\n- Match the user's language consistently throughout the entire conversation, including explanations, summaries, and follow-up questions.\n- Do not switch languages unless the user explicitly asks you to.\n- Exception: code comments and commit messages default to English unless the user specifies otherwise.",
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

    return request
  }

  private buildCloudCodeToolDeclarations(
    tools: Array<{
      name?: unknown
      description?: unknown
      input_schema?: unknown
    }>,
    useOfficialAntigravityTools = false
  ): CloudCodeToolDeclaration[] {
    if (useOfficialAntigravityTools) {
      return this.buildOfficialAntigravityToolDeclarations(tools)
    }
    const declarations: CloudCodeToolDeclaration[] = []
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

  private buildOfficialAntigravityToolDeclarations(
    tools: Array<{
      name?: unknown
      description?: unknown
      input_schema?: unknown
    }>
  ): CloudCodeToolDeclaration[] {
    return buildOfficialAntigravityToolDeclarationsFromContract(tools)
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
        const functionResponse: Record<string, unknown> = {
          name: functionName,
          response: this.buildFunctionResponsePayload(b),
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
        const functionResponse: Record<string, unknown> = {
          name: functionName,
          response: this.buildFunctionResponsePayload(b),
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
    const requestContents = Array.isArray(googleRequest.contents)
      ? (googleRequest.contents as Array<Record<string, unknown>>)
      : []

    if (requestContents.length > 0) {
      const sanitized = this.sanitizeClaudeContentsForSend(requestContents)
      googleRequest.contents = sanitized.contents
      if (
        sanitized.removedInvalidThoughtParts > 0 ||
        sanitized.removedFunctionResponses > 0 ||
        sanitized.droppedMessages > 0
      ) {
        this.logger.warn(
          `Cloud Code final payload sanitize: dropped ${sanitized.removedFunctionResponses} orphan functionResponse part(s), ` +
            `removed ${sanitized.removedInvalidThoughtParts} invalid thought part(s), ` +
            `removed ${sanitized.droppedMessages} invalid message(s)`
        )
      }
    }

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
      __workerConversationKey: session.uuid,
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
    const protectedContextMessageCount =
      this.normalizeProtectedContextPrefixCount(
        dto._protectedContextMessageCount
      )

    // Enforce token budget before sending
    // Use protocol-layer budget if available, otherwise fall back to hard limit
    const budgetLimit =
      dto._contextTokenBudget || this.CLOUD_CODE_HARD_TOKEN_LIMIT
    const budgetResult = this.enforceTokenBudget(
      payload,
      budgetLimit,
      protectedContextMessageCount
    )
    if (budgetResult.enforced) {
      this.logger.warn(
        `[sendClaudeMessage] Token budget enforced: ${budgetResult.originalTokens} -> ${budgetResult.finalTokens}`
      )
    }
    this.assertTokenBudgetWithinLimit(
      "sendClaudeMessage",
      budgetResult,
      budgetLimit
    )

    let lastError: Error | null = null
    let promptShrinkRetries = 0

    let consecutiveAuthErrors = 0
    const maxAuthRetries = Math.max(this.processPool.workerCount, 2)
    const maxWorkerAttempts = Math.max(
      this.processPool.workerCount,
      this.MAX_RETRIES
    )
    const excludedWorkerEmails = new Set<string>()
    const recoveryState = { totalWaitedMs: 0 }
    let instantRetry429 = 0
    let instantRetry503 = 0

    for (let attempt = 0; attempt < maxWorkerAttempts; attempt++) {
      try {
        this.logger.debug(`Attempt ${attempt + 1}, model: ${resolvedModel}`)

        const data = (await this.processPool.generate(payload, resolvedModel, {
          excludedWorkerEmails,
        })) as Record<string, unknown>
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
        if (error instanceof WorkerPoolCooldownError) {
          if (this.processPool.hasOnlyDisabledWorkers()) {
            throw new HttpException(
              "All accounts authentication failed",
              HttpStatus.UNAUTHORIZED
            )
          }
          this.logger.warn(
            `[pool-gate] Pre-dispatch worker gate for ${resolvedModel}, failing fast: ${error.message}`
          )
          throw this.buildWorkerPoolCooldownException(
            resolvedModel,
            error.waitMs,
            error.reason
          )
        }

        const errMsg = (error as Error).message || ""

        // 401 / token refresh failed — permanently remove the current account
        // from scheduling until the worker is reloaded.
        if (errMsg.includes("401") || errMsg.includes("Token refresh failed")) {
          consecutiveAuthErrors++
          const authReason = errMsg.includes("Token refresh failed")
            ? "token refresh failed"
            : "authentication failed"
          if (consecutiveAuthErrors > maxAuthRetries) {
            throw new HttpException(
              "All accounts authentication failed",
              HttpStatus.UNAUTHORIZED
            )
          }
          this.markCurrentWorkerAttempted(excludedWorkerEmails)
          this.processPool.disableLastWorker(authReason)
          if (!this.processPool.hasEligibleWorker({ excludedWorkerEmails })) {
            throw new HttpException(
              "All accounts authentication failed",
              HttpStatus.UNAUTHORIZED
            )
          }
          this.logger.warn(
            `Auth error (${consecutiveAuthErrors}/${maxAuthRetries}), disabled current account and rotating...`
          )
          lastError = error as Error
          continue
        }
        consecutiveAuthErrors = 0

        // 429 — rate limited: precisely cooldown the worker that reported the error
        if (errMsg.includes("429")) {
          this.recordGoogleAccountError(
            this.processPool.getLastWorkerEmail(),
            resolvedModel,
            429
          )
          const retryDelayMs = this.parseRetryDelayMs(errMsg)

          // Official Antigravity grace retry: if quota reset is imminent,
          // wait a fixed 5s once on the same worker instead of rotating.
          const exhausted = this.isQuotaExhausted(errMsg)
          if (
            exhausted &&
            retryDelayMs != null &&
            retryDelayMs <= this.QUOTA_RESET_GRACE_WINDOW_MS &&
            instantRetry429 < 1
          ) {
            instantRetry429++
            this.logger.warn(
              `[pool-retry] Quota reset is imminent for ${resolvedModel} [${this.processPool.getLastWorkerEmail()}], waiting ${this.QUOTA_RESET_RETRY_DELAY_MS}ms`
            )
            await this.sleep(this.QUOTA_RESET_RETRY_DELAY_MS)
            lastError = error as Error
            attempt-- // don't consume worker rotation budget
            continue
          }

          // Non-quota short 429s can still be retried in place briefly.
          if (
            !exhausted &&
            retryDelayMs != null &&
            retryDelayMs < this.INSTANT_RETRY_THRESHOLD_MS &&
            instantRetry429 < this.MAX_INSTANT_RETRIES
          ) {
            instantRetry429++
            this.logger.warn(
              `[pool-retry] Instant retry for ${resolvedModel} [${this.processPool.getLastWorkerEmail()}], waiting ${Math.max(retryDelayMs, 500)}ms (429 instant ${instantRetry429}/${this.MAX_INSTANT_RETRIES})`
            )
            await this.sleep(Math.max(retryDelayMs, 500))
            lastError = error as Error
            attempt-- // don't consume worker rotation budget
            continue
          }
          instantRetry429 = 0 // reset on fallthrough to rotation

          const failedWorkerEmail =
            this.markCurrentWorkerAttempted(excludedWorkerEmails)
          // Quota exhausted: use full reset duration (hours/days), uncapped
          // Transient rate limit: keep capped behavior
          const cooldownMs = exhausted
            ? this.resolveQuotaExhaustedCooldownMs(
                resolvedModel,
                errMsg,
                failedWorkerEmail
              )
            : Math.min(retryDelayMs ?? 60_000, this.MAX_429_WAIT_MS)

          // Precisely target the worker that actually failed (not a random one)
          this.processPool.setModelCooldownForLastWorker(
            resolvedModel,
            cooldownMs,
            exhausted ? "quota_exhausted" : "rate_limited"
          )
          await this.processPool.recycleLastOfficialClient(
            exhausted
              ? `quota exhausted for ${resolvedModel}`
              : `rate limited for ${resolvedModel}`
          )

          // Check if another worker is available for this specific model
          const hasAvailableWorker = this.hasAnotherWorkerAvailable(
            resolvedModel,
            excludedWorkerEmails
          )
          if (hasAvailableWorker) {
            this.logger.warn(
              `[pool-rotate] Rate limited${exhausted ? " (QUOTA_EXHAUSTED)" : ""} [${this.processPool.getLastWorkerEmail()}], rotating to next available worker for ${resolvedModel}`
            )
            lastError = error as Error
            continue
          }

          // All workers exhausted — attempt recovery pass before giving up
          const waitMs = Math.max(
            this.processPool.getMinCooldownMsForModel(resolvedModel),
            cooldownMs
          )
          if (
            await this.maybeRecoveryPass(
              resolvedModel,
              waitMs,
              excludedWorkerEmails,
              recoveryState
            )
          ) {
            lastError = error as Error
            attempt = -1 // recovery cleared excludedWorkerEmails; restart full sweep
            continue
          }
          this.logger.warn(
            `[pool-rotate] All workers rate-limited for ${resolvedModel}, failing after recovery: ${this.summarizeCloudCodeErrorForLog(errMsg)}`
          )
          throw new HttpException(
            this.buildCloudCodeRateLimitMessage(resolvedModel, waitMs),
            HttpStatus.TOO_MANY_REQUESTS
          )
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
              promptShrinkRetries,
              protectedContextMessageCount
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

        if (this.isRetryableWorkerFailure(errMsg)) {
          const isModelCapacityExhausted = this.isModelCapacityExhausted(errMsg)
          const cooldownMs = isModelCapacityExhausted
            ? this.MODEL_CAPACITY_EXHAUSTED_COOLDOWN_MS
            : this.getRetryableWorkerFailureCooldownMs(errMsg)

          // Capacity exhausted is a backend-wide issue — instant retry same worker
          if (isModelCapacityExhausted) {
            this.recordGoogleAccountError(
              this.processPool.getLastWorkerEmail(),
              resolvedModel,
              503
            )
          }

          if (
            isModelCapacityExhausted &&
            instantRetry503 < this.MAX_INSTANT_RETRIES
          ) {
            instantRetry503++
            this.logger.warn(
              `[pool-retry] Model capacity exhausted for ${resolvedModel} [${this.processPool.getLastWorkerEmail()}], waiting ${cooldownMs}ms (503 instant ${instantRetry503}/${this.MAX_INSTANT_RETRIES})`
            )
            await this.sleep(cooldownMs)
            lastError = error as Error
            attempt-- // don't consume worker rotation budget
            continue
          }
          instantRetry503 = 0

          if (!isModelCapacityExhausted) {
            this.processPool.setCooldownForLastWorker(cooldownMs, "transient")
          }

          await this.processPool.recycleLastOfficialClient(
            isModelCapacityExhausted
              ? `model capacity exhausted for ${resolvedModel}`
              : `transient failure for ${resolvedModel}`
          )

          this.markCurrentWorkerAttempted(excludedWorkerEmails)

          const hasAvailableWorker = this.hasAnotherWorkerAvailable(
            resolvedModel,
            excludedWorkerEmails
          )
          if (hasAvailableWorker) {
            this.logger.warn(
              `[pool-rotate] ${isModelCapacityExhausted ? "Model capacity exhausted" : "Transient worker failure"} [${this.processPool.getLastWorkerEmail()}], rotating to next available worker for ${resolvedModel}: ${this.summarizeCloudCodeErrorForLog(errMsg)}`
            )
            lastError = error as Error
            continue
          }

          const waitMs = isModelCapacityExhausted
            ? cooldownMs
            : Math.max(
                this.processPool.getMinCooldownMsForModel(resolvedModel),
                cooldownMs
              )
          // All workers exhausted — attempt recovery pass before giving up
          if (
            await this.maybeRecoveryPass(
              resolvedModel,
              waitMs,
              excludedWorkerEmails,
              recoveryState
            )
          ) {
            lastError = error as Error
            attempt = -1 // recovery cleared excludedWorkerEmails; restart full sweep
            continue
          }
          this.logger.warn(
            `[pool-rotate] All workers temporarily unavailable for ${resolvedModel}, failing after recovery: ${this.summarizeCloudCodeErrorForLog(errMsg)}`
          )
          throw new HttpException(
            this.buildCloudCodeTemporaryUnavailableMessage(
              resolvedModel,
              waitMs
            ),
            HttpStatus.SERVICE_UNAVAILABLE
          )
        }

        lastError = error as Error
        this.logger.error(`Request failed: ${errMsg}`)

        if (attempt < maxWorkerAttempts - 1) {
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
    dto: CreateMessageDto,
    abortSignal?: AbortSignal
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
    const protectedContextMessageCount =
      this.normalizeProtectedContextPrefixCount(
        dto._protectedContextMessageCount
      )

    // Enforce token budget before sending
    // Use protocol-layer budget if available, otherwise fall back to hard limit
    const budgetLimit =
      dto._contextTokenBudget || this.CLOUD_CODE_HARD_TOKEN_LIMIT
    const budgetResult = this.enforceTokenBudget(
      payload,
      budgetLimit,
      protectedContextMessageCount
    )
    if (budgetResult.enforced) {
      this.logger.warn(
        `[sendClaudeMessageStream] Token budget enforced: ${budgetResult.originalTokens} -> ${budgetResult.finalTokens}`
      )
    }
    this.assertTokenBudgetWithinLimit(
      "sendClaudeMessageStream",
      budgetResult,
      budgetLimit
    )

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
    let finishReason: string | undefined
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

    let fatalRequestError: Error | null = null

    // Async producer-consumer queue for real-time streaming
    const eventQueue: string[] = []
    let resolveWaiting: (() => void) | null = null
    let streamDone = false
    let currentAttemptStartedAt = 0
    let currentAttemptWorkerEmail: string | null = null
    let currentAttemptSawProgress = false
    let sawAnyStreamProgress = false
    let currentAttemptWatchdog: ReturnType<typeof setTimeout> | null = null

    const clearCurrentAttemptWatchdog = () => {
      if (currentAttemptWatchdog) {
        clearTimeout(currentAttemptWatchdog)
        currentAttemptWatchdog = null
      }
    }

    const markEffectiveStreamProgress = () => {
      if (currentAttemptSawProgress) return
      currentAttemptSawProgress = true
      clearCurrentAttemptWatchdog()
      if (currentAttemptStartedAt > 0) {
        this.logger.debug(
          `[pool-watchdog] First effective stream progress [${currentAttemptWorkerEmail ?? "unknown"}] for ${resolvedModel} after ${Date.now() - currentAttemptStartedAt}ms`
        )
      }
    }

    const armCurrentAttemptWatchdog = (controller: AbortController) => {
      clearCurrentAttemptWatchdog()
      if (currentAttemptSawProgress) return
      currentAttemptWatchdog = setTimeout(() => {
        if (currentAttemptSawProgress || controller.signal.aborted) {
          return
        }
        const elapsedMs =
          currentAttemptStartedAt > 0
            ? Date.now() - currentAttemptStartedAt
            : this.STREAM_FIRST_PROGRESS_WATCHDOG_MS
        const workerLabel = currentAttemptWorkerEmail ?? "unknown"
        this.logger.warn(
          `[pool-watchdog] No effective stream progress [${workerLabel}] for ${resolvedModel} after ${elapsedMs}ms; aborting current stream attempt`
        )
        controller.abort(
          new Error(
            this.buildStreamProgressWatchdogReason(resolvedModel, elapsedMs)
          )
        )
      }, this.STREAM_FIRST_PROGRESS_WATCHDOG_MS)
    }

    const push = (...events: string[]) => {
      if (events.length > 0) {
        markEffectiveStreamProgress()
        sawAnyStreamProgress = true
      }
      eventQueue.push(...events)
      if (resolveWaiting) {
        resolveWaiting()
        resolveWaiting = null
      }
    }

    const payloadRequest = payload.request as Record<string, unknown>
    const payloadToolNames = Array.isArray(payloadRequest?.tools)
      ? payloadRequest.tools
          .flatMap(
            (tool) =>
              (tool as { functionDeclarations?: Array<{ name?: unknown }> })
                .functionDeclarations || []
          )
          .map((declaration) =>
            typeof declaration.name === "string" ? declaration.name : ""
          )
          .filter(Boolean)
      : []
    const payloadSessionId =
      typeof payloadRequest?.sessionId === "string" ||
      typeof payloadRequest?.sessionId === "number"
        ? payloadRequest.sessionId
        : ""
    this.logger.debug(
      `[Payload] model=${String(payload.model)}, ` +
        `project=${String(payload.project)}, ` +
        `requestType=${String(payload.requestType)}, ` +
        `sessionId=${String(payloadSessionId)}, ` +
        `tools=${payloadToolNames.length ? payloadToolNames.join(",") : "no"}, ` +
        `generationConfig=${JSON.stringify(payloadRequest?.generationConfig)?.slice(0, 400)}`
    )

    // ---------------------------------------------------------------------------
    // Worker rotation retry: try each available worker before giving up
    // ---------------------------------------------------------------------------
    const maxWorkerRetries = Math.max(this.processPool.workerCount, 2)
    let promptShrinkRetries = 0
    const excludedWorkerEmails = new Set<string>()
    const recoveryState = { totalWaitedMs: 0 }
    let instantRetry429 = 0
    let instantRetry503 = 0

    const attemptStream = async (): Promise<void> => {
      let lastAttemptError: Error | null = null
      for (
        let workerAttempt = 0;
        workerAttempt < maxWorkerRetries;
        workerAttempt++
      ) {
        let attemptAbortController: AbortController | null = null
        try {
          currentAttemptStartedAt = Date.now()
          currentAttemptWorkerEmail = null
          currentAttemptSawProgress = false
          attemptAbortController = new AbortController()
          const streamAbortSignal = abortSignal
            ? AbortSignal.any([abortSignal, attemptAbortController.signal])
            : attemptAbortController.signal

          const streamPromise = this.processPool.generateStream(
            payload,
            onChunkHandler,
            resolvedModel,
            streamAbortSignal,
            { excludedWorkerEmails }
          )
          currentAttemptWorkerEmail = self.processPool.getLastWorkerEmail()
          armCurrentAttemptWatchdog(attemptAbortController)
          await streamPromise
          clearCurrentAttemptWatchdog()
          // Mark this worker as preferred for future requests with this model
          self.processPool.markSuccessForModel(resolvedModel)
          return // success
        } catch (err) {
          clearCurrentAttemptWatchdog()
          const errMsg = (err as Error).message || ""
          lastAttemptError =
            err instanceof Error ? err : new Error(errMsg || "stream failed")

          if (
            currentAttemptSawProgress &&
            self.isCloudCodeInactivityTimeoutFailure(errMsg)
          ) {
            throw new UpstreamRequestAbortedError(errMsg)
          }

          if (
            err instanceof UpstreamRequestAbortedError &&
            self.isStreamProgressWatchdogAbort(errMsg)
          ) {
            self.markCurrentWorkerAttempted(excludedWorkerEmails)
            self.processPool.setModelCooldownForLastWorker(
              resolvedModel,
              self.STREAM_STALL_COOLDOWN_MS,
              "transient"
            )
            await self.processPool.recycleLastOfficialClient(
              `stream watchdog stalled before progress for ${resolvedModel}`
            )

            const hasAvailableWorker = self.hasAnotherWorkerAvailable(
              resolvedModel,
              excludedWorkerEmails
            )
            if (hasAvailableWorker) {
              self.logger.warn(
                `[pool-watchdog] Streaming no-progress watchdog [${self.processPool.getLastWorkerEmail()}] (attempt ${workerAttempt + 1}/${maxWorkerRetries}), rotating to next available worker for ${resolvedModel}`
              )
              continue
            }

            const waitMs = Math.max(
              self.processPool.getMinCooldownMsForModel(resolvedModel),
              self.STREAM_STALL_COOLDOWN_MS
            )
            self.logger.warn(
              `[pool-watchdog] All workers stalled before progress for ${resolvedModel}, failing fast instead of recovery wait`
            )
            throw new HttpException(
              self.buildCloudCodeTemporaryUnavailableMessage(
                resolvedModel,
                waitMs
              ),
              HttpStatus.SERVICE_UNAVAILABLE
            )
          }

          if (err instanceof UpstreamRequestAbortedError) {
            throw err
          }

          if (err instanceof WorkerPoolCooldownError) {
            if (self.processPool.hasOnlyDisabledWorkers()) {
              throw new HttpException(
                "All accounts authentication failed",
                HttpStatus.UNAUTHORIZED
              )
            }
            self.logger.warn(
              `[pool-gate] Streaming pre-dispatch worker gate for ${resolvedModel}, failing fast: ${err.message}`
            )
            throw self.buildWorkerPoolCooldownException(
              resolvedModel,
              err.waitMs,
              err.reason
            )
          }

          if (errMsg.includes("429")) {
            self.recordGoogleAccountError(
              self.processPool.getLastWorkerEmail(),
              resolvedModel,
              429
            )
            const retryDelayMs = self.parseRetryDelayMs(errMsg)

            // Official Antigravity grace retry: if quota reset is imminent,
            // wait a fixed 5s once on the same worker instead of rotating.
            const exhausted = self.isQuotaExhausted(errMsg)
            if (
              exhausted &&
              retryDelayMs != null &&
              retryDelayMs <= self.QUOTA_RESET_GRACE_WINDOW_MS &&
              instantRetry429 < 1
            ) {
              instantRetry429++
              self.logger.warn(
                `[pool-retry] Streaming quota reset is imminent for ${resolvedModel} [${self.processPool.getLastWorkerEmail()}], waiting ${self.QUOTA_RESET_RETRY_DELAY_MS}ms`
              )
              await self.sleepAbortable(
                self.QUOTA_RESET_RETRY_DELAY_MS,
                abortSignal
              )
              lastAttemptError =
                err instanceof Error
                  ? err
                  : new Error(errMsg || "stream failed")
              workerAttempt-- // don't consume worker rotation budget
              continue
            }

            // Non-quota short 429s can still be retried in place briefly.
            if (
              !exhausted &&
              retryDelayMs != null &&
              retryDelayMs < self.INSTANT_RETRY_THRESHOLD_MS &&
              instantRetry429 < self.MAX_INSTANT_RETRIES
            ) {
              instantRetry429++
              self.logger.warn(
                `[pool-retry] Streaming instant retry for ${resolvedModel} [${self.processPool.getLastWorkerEmail()}], waiting ${Math.max(retryDelayMs, 500)}ms (429 instant ${instantRetry429}/${self.MAX_INSTANT_RETRIES})`
              )
              await self.sleepAbortable(
                Math.max(retryDelayMs, 500),
                abortSignal
              )
              lastAttemptError =
                err instanceof Error
                  ? err
                  : new Error(errMsg || "stream failed")
              workerAttempt-- // don't consume worker rotation budget
              continue
            }
            instantRetry429 = 0 // reset on fallthrough to rotation

            const failedWorkerEmail =
              self.markCurrentWorkerAttempted(excludedWorkerEmails)
            // Quota exhausted: use full reset duration, uncapped
            const cooldownMs = exhausted
              ? self.resolveQuotaExhaustedCooldownMs(
                  resolvedModel,
                  errMsg,
                  failedWorkerEmail
                )
              : Math.min(retryDelayMs ?? 60_000, self.MAX_429_WAIT_MS)

            // Precisely target the worker that actually failed
            self.processPool.setModelCooldownForLastWorker(
              resolvedModel,
              cooldownMs,
              exhausted ? "quota_exhausted" : "rate_limited"
            )
            await self.processPool.recycleLastOfficialClient(
              exhausted
                ? `quota exhausted for ${resolvedModel}`
                : `rate limited for ${resolvedModel}`
            )

            // Check if another worker is available for this model
            const hasAvailableWorker = self.hasAnotherWorkerAvailable(
              resolvedModel,
              excludedWorkerEmails
            )
            if (hasAvailableWorker) {
              self.logger.warn(
                `[pool-rotate] Streaming 429${exhausted ? " (QUOTA_EXHAUSTED)" : ""} [${self.processPool.getLastWorkerEmail()}] (attempt ${workerAttempt + 1}/${maxWorkerRetries}), rotating to next available worker for ${resolvedModel}`
              )
              continue
            }

            // All workers exhausted — attempt recovery pass before giving up
            const waitMs = Math.max(
              self.processPool.getMinCooldownMsForModel(resolvedModel),
              cooldownMs
            )
            if (
              await self.maybeRecoveryPass(
                resolvedModel,
                waitMs,
                excludedWorkerEmails,
                recoveryState,
                abortSignal
              )
            ) {
              lastAttemptError =
                err instanceof Error
                  ? err
                  : new Error(errMsg || "stream failed")
              workerAttempt = -1 // recovery cleared excludedWorkerEmails; restart full sweep
              continue
            }
            self.logger.warn(
              `[pool-rotate] All streaming workers rate-limited for ${resolvedModel}, failing after recovery: ${self.summarizeCloudCodeErrorForLog(errMsg)}`
            )
            throw new HttpException(
              self.buildCloudCodeRateLimitMessage(resolvedModel, waitMs),
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
                promptShrinkRetries,
                protectedContextMessageCount
              )
              if (shrinkResult) {
                promptShrinkRetries++
                self.logger.warn(
                  `[sendClaudeMessageStream] Prompt too long (${promptTooLong.actual} > ${promptTooLong.max}), ` +
                    `shrinking (attempt ${promptShrinkRetries}/${self.MAX_PROMPT_SHRINK_RETRIES})`
                )
                lastAttemptError = null
                continue
              }
            }
            if (self.isCloudCodeToolProtocolError(errMsg)) {
              throw new FatalCloudCodeRequestError(errMsg)
            }
          }

          if (
            errMsg.includes("Token refresh failed") ||
            errMsg.includes("401")
          ) {
            const authReason = errMsg.includes("Token refresh failed")
              ? "token refresh failed"
              : "authentication failed"
            self.markCurrentWorkerAttempted(excludedWorkerEmails)
            self.processPool.disableLastWorker(authReason)
            if (!self.processPool.hasEligibleWorker({ excludedWorkerEmails })) {
              throw new HttpException(
                "All accounts authentication failed",
                HttpStatus.UNAUTHORIZED
              )
            }
            self.logger.warn(
              `Streaming auth error (attempt ${workerAttempt + 1}/${maxWorkerRetries}), disabled current account and rotating`
            )
            continue
          }

          if (self.isRetryableWorkerFailure(errMsg)) {
            const isModelCapacityExhausted =
              self.isModelCapacityExhausted(errMsg)
            const cooldownMs = isModelCapacityExhausted
              ? self.MODEL_CAPACITY_EXHAUSTED_COOLDOWN_MS
              : self.getRetryableWorkerFailureCooldownMs(errMsg)

            // Capacity exhausted is a backend-wide issue — instant retry same worker
            if (isModelCapacityExhausted) {
              self.recordGoogleAccountError(
                self.processPool.getLastWorkerEmail(),
                resolvedModel,
                503
              )
            }

            if (
              isModelCapacityExhausted &&
              instantRetry503 < self.MAX_INSTANT_RETRIES
            ) {
              instantRetry503++
              self.logger.warn(
                `[pool-retry] Streaming model capacity exhausted for ${resolvedModel} [${self.processPool.getLastWorkerEmail()}], waiting ${cooldownMs}ms (503 instant ${instantRetry503}/${self.MAX_INSTANT_RETRIES})`
              )
              await self.sleepAbortable(cooldownMs, abortSignal)
              lastAttemptError =
                err instanceof Error
                  ? err
                  : new Error(errMsg || "stream failed")
              workerAttempt-- // don't consume worker rotation budget
              continue
            }
            instantRetry503 = 0

            if (!isModelCapacityExhausted) {
              self.processPool.setCooldownForLastWorker(cooldownMs, "transient")
            }

            await self.processPool.recycleLastOfficialClient(
              isModelCapacityExhausted
                ? `model capacity exhausted for ${resolvedModel}`
                : `transient failure for ${resolvedModel}`
            )

            self.markCurrentWorkerAttempted(excludedWorkerEmails)

            const hasAvailableWorker = self.hasAnotherWorkerAvailable(
              resolvedModel,
              excludedWorkerEmails
            )
            if (hasAvailableWorker) {
              self.logger.warn(
                `[pool-rotate] ${isModelCapacityExhausted ? "Streaming model capacity exhausted" : "Streaming transient worker failure"} [${self.processPool.getLastWorkerEmail()}] (attempt ${workerAttempt + 1}/${maxWorkerRetries}), rotating to next available worker for ${resolvedModel}: ${self.summarizeCloudCodeErrorForLog(errMsg)}`
              )
              continue
            }

            const waitMs = isModelCapacityExhausted
              ? cooldownMs
              : Math.max(
                  self.processPool.getMinCooldownMsForModel(resolvedModel),
                  cooldownMs
                )
            // All workers exhausted — attempt recovery pass before giving up
            if (
              await self.maybeRecoveryPass(
                resolvedModel,
                waitMs,
                excludedWorkerEmails,
                recoveryState,
                abortSignal
              )
            ) {
              lastAttemptError =
                err instanceof Error
                  ? err
                  : new Error(errMsg || "stream failed")
              workerAttempt = -1 // recovery cleared excludedWorkerEmails; restart full sweep
              continue
            }
            self.logger.warn(
              `[pool-rotate] All streaming workers temporarily unavailable for ${resolvedModel}, failing after recovery: ${self.summarizeCloudCodeErrorForLog(errMsg)}`
            )
            throw new HttpException(
              self.buildCloudCodeTemporaryUnavailableMessage(
                resolvedModel,
                waitMs
              ),
              HttpStatus.SERVICE_UNAVAILABLE
            )
          }

          // Non-retryable or last attempt
          throw err
        }
      }

      throw (
        lastAttemptError ??
        new Error(`Cloud Code API streaming failed for ${resolvedModel}`)
      )
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
        finishReason?: string
      }>

      if (!candidates || candidates.length === 0) return
      const candidate = candidates[0]
      if (typeof candidate?.finishReason === "string") {
        finishReason = candidate.finishReason
      }
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
          const originalToolName = part.functionCall.name
          const mappedToolName =
            this.fromOfficialAntigravityToolName(originalToolName)
          const mappedToolInput = this.adaptOfficialAntigravityToolInput(
            originalToolName,
            part.functionCall.args || {}
          )
          this.rememberToolName(toolId, mappedToolName)
          push(
            ...startBlock(BLOCK_TOOL_USE, {
              type: "tool_use",
              id: toolId,
              name: mappedToolName,
              input: {},
            })
          )
          const inputJson = JSON.stringify(mappedToolInput)
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
        clearCurrentAttemptWatchdog()
        streamDone = true
        if (resolveWaiting) {
          resolveWaiting()
          resolveWaiting = null
        }
      })
      .catch((err) => {
        clearCurrentAttemptWatchdog()
        if (err instanceof UpstreamRequestAbortedError) {
          fatalRequestError = err
          streamDone = true
          if (resolveWaiting) {
            resolveWaiting()
            resolveWaiting = null
          }
          return
        }

        const errMsg = (err as Error).message || ""
        self.logger.error(`Streaming failed (all workers exhausted): ${errMsg}`)
        fatalRequestError =
          err instanceof Error
            ? err
            : new Error(errMsg || "Cloud Code API streaming failed")
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

    const finalizedFatalRequestError: unknown = fatalRequestError
    if (finalizedFatalRequestError) {
      if (finalizedFatalRequestError instanceof UpstreamRequestAbortedError) {
        throw finalizedFatalRequestError
      }
      if (
        typeof finalizedFatalRequestError === "object" &&
        finalizedFatalRequestError !== null &&
        "name" in finalizedFatalRequestError &&
        finalizedFatalRequestError.name === "FatalCloudCodeRequestError"
      ) {
        throw finalizedFatalRequestError as Error
      }
      const errorMsg =
        typeof finalizedFatalRequestError === "object" &&
        finalizedFatalRequestError !== null &&
        "message" in finalizedFatalRequestError &&
        typeof finalizedFatalRequestError.message === "string"
          ? finalizedFatalRequestError.message
          : "Cloud Code API streaming failed"
      if (
        sawAnyStreamProgress &&
        this.isCloudCodeInactivityTimeoutFailure(errorMsg)
      ) {
        throw new UpstreamRequestAbortedError(errorMsg)
      }
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

    const stopReason = this.mapGeminiFinishReason(finishReason, hasToolCall)
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
