import { Injectable, Logger } from "@nestjs/common"
import type { EnforceToolProtocolOptions } from "./message-integrity-guard"
import { SummaryCacheService } from "./summary-cache.service"
import { SummaryGeneratorService } from "./summary-generator.service"
import { TokenCounterService } from "./token-counter.service"
import { ToolIntegrityService } from "./tool-integrity.service"
import {
  DEFAULT_TRUNCATION_CONFIG,
  TruncationConfig,
  TruncationResult,
  UnifiedMessage,
} from "./types"

/**
 * Conversation Truncator Service
 *
 * Truncates conversation history to fit within backend token limits
 * while preserving tool call integrity and generating summaries.
 *
 * Key features:
 * - Token-based truncation (not message count)
 * - Tool use/result pair integrity preservation
 * - Summary generation for truncated messages (cached)
 *
 * Summary Strategy:
 * - When truncation is needed, generate a summary of truncated messages
 * - Cache summaries based on content hash (same content = same summary)
 * - Inject summary as first message to preserve context
 */
@Injectable()
export class ConversationTruncatorService {
  private readonly logger = new Logger(ConversationTruncatorService.name)
  private readonly config: TruncationConfig

  constructor(
    private readonly tokenCounter: TokenCounterService,
    private readonly toolIntegrity: ToolIntegrityService,
    private readonly summaryCache: SummaryCacheService,
    private readonly summaryGenerator: SummaryGeneratorService
  ) {
    this.config = DEFAULT_TRUNCATION_CONFIG
  }

  /**
   * Main truncation method
   *
   * @param sessionId Session identifier for summary lookup
   * @param messages Messages to truncate (client sends full history)
   * @param options Additional options
   * @returns Truncated messages ready for API call
   */
  truncate(
    sessionId: string,
    messages: UnifiedMessage[],
    options?: {
      systemPromptTokens?: number
      maxTokens?: number
      pendingToolUseIds?: Iterable<string>
      integrityMode?: EnforceToolProtocolOptions["mode"]
    }
  ): TruncationResult {
    const systemPromptTokens = options?.systemPromptTokens || 0

    // Calculate effective max tokens (subtract system prompt)
    // - If caller provides maxTokens, treat it as already resolved upstream budget
    // - Otherwise fall back to global config limit with safety margin
    const resolvedMaxTokens =
      options?.maxTokens ||
      this.config.max_context_tokens - this.config.safety_margin_tokens
    const effectiveMaxTokens = Math.max(
      resolvedMaxTokens - systemPromptTokens,
      1000
    )

    // Use client-provided messages directly
    // Cursor client manages its own history and sends complete conversation in each request
    const allMessages: UnifiedMessage[] = messages
    this.logger.debug(
      `Truncating ${messages.length} messages, session=${sessionId}`
    )

    // Step 3: Calculate total tokens
    const totalTokens = this.tokenCounter.countMessages(allMessages)
    this.logger.debug(
      `Total tokens: ${totalTokens} (limit: ${effectiveMaxTokens})`
    )

    // Step 4: Check if truncation needed
    if (totalTokens <= effectiveMaxTokens) {
      // No truncation needed
      this.logger.debug("No truncation needed, returning all messages")

      return {
        messages: allMessages,
        was_truncated: false,
        original_token_count: totalTokens,
        truncated_token_count: totalTokens,
        summary_used: false,
      }
    }

    // Step 5: Truncation needed
    this.logger.log(
      `Truncation needed: ${totalTokens} tokens > ${effectiveMaxTokens} limit`
    )

    // Step 6: Find initial truncation point with tool integrity
    // Reserve some tokens for potential summary
    const reservedForSummary = 2000 // Max summary tokens
    const targetTokensForRecent = effectiveMaxTokens - reservedForSummary

    const truncationIndex = this.toolIntegrity.findTruncationPointWithIntegrity(
      allMessages,
      targetTokensForRecent,
      { mode: options?.integrityMode }
    )

    // Get recent messages and truncated (early) messages
    let recentMessages = allMessages.slice(truncationIndex)
    const truncatedEarlyMessages = allMessages.slice(0, truncationIndex)

    // Ensure we keep at least MIN_RECENT_MESSAGES
    if (
      recentMessages.length < this.config.min_recent_messages &&
      allMessages.length >= this.config.min_recent_messages
    ) {
      const minIndex = allMessages.length - this.config.min_recent_messages
      if (minIndex < truncationIndex) {
        const candidateRecent = allMessages.slice(minIndex)
        const candidateTokens = this.tokenCounter.countMessages(candidateRecent)
        if (candidateTokens <= effectiveMaxTokens) {
          recentMessages = candidateRecent
        } else {
          this.logger.warn(
            `Skipping min_recent_messages override because it exceeds limit: ` +
              `${candidateTokens} > ${effectiveMaxTokens}`
          )
        }
      }
    }

    // Step 7: Generate or retrieve cached summary for truncated messages
    let summaryMessage: UnifiedMessage | null = null
    let summaryUsed = false

    if (truncatedEarlyMessages.length > 0) {
      // Check cache first
      const cachedSummary = this.summaryCache.getCachedSummary(
        truncatedEarlyMessages
      )

      if (cachedSummary) {
        // Use cached summary
        summaryMessage = this.buildSummaryMessage(cachedSummary.summary_text)
        summaryUsed = true
        this.logger.debug(
          `Using cached summary: ${cachedSummary.token_count} tokens ` +
            `(covers ${cachedSummary.message_count} messages)`
        )
      } else {
        // Generate new summary
        const summaryResult = this.summaryGenerator.generateSummary(
          truncatedEarlyMessages
        )

        if (summaryResult.success && summaryResult.summary_text) {
          summaryMessage = this.buildSummaryMessage(summaryResult.summary_text)
          summaryUsed = true

          // Cache the summary
          this.summaryCache.storeSummary(
            truncatedEarlyMessages,
            summaryResult.summary_text
          )

          this.logger.log(
            `Generated new summary: ${summaryResult.token_count} tokens ` +
              `(covers ${truncatedEarlyMessages.length} messages)`
          )
        } else {
          this.logger.warn(`Failed to generate summary: ${summaryResult.error}`)
        }
      }
    }

    // Step 8: Build final message list
    let finalMessages: UnifiedMessage[] = []

    if (summaryMessage) {
      finalMessages.push(summaryMessage)
    }

    finalMessages.push(...recentMessages)

    // Calculate final token count
    let truncatedTokenCount = this.tokenCounter.countMessages(finalMessages)
    if (truncatedTokenCount > effectiveMaxTokens) {
      const fitted = this.trimOldestMessagesToFit(
        finalMessages,
        effectiveMaxTokens,
        {
          pendingToolUseIds: options?.pendingToolUseIds,
          integrityMode: options?.integrityMode,
        }
      )
      finalMessages = fitted.messages
      truncatedTokenCount = fitted.tokenCount
      if (summaryMessage && !finalMessages.includes(summaryMessage)) {
        summaryUsed = false
      }
      this.logger.warn(
        `Final summary+recent payload still exceeded limit, applied hard fit: ` +
          `${fitted.originalTokenCount} -> ${fitted.tokenCount} tokens`
      )
    }

    this.logger.log(
      `Truncated from ${allMessages.length} to ${finalMessages.length} messages ` +
        `(${totalTokens} -> ${truncatedTokenCount} tokens, summary_used=${summaryUsed})`
    )

    return {
      messages: finalMessages,
      was_truncated: true,
      original_token_count: totalTokens,
      truncated_token_count: truncatedTokenCount,
      summary_used: summaryUsed,
    }
  }

  /**
   * Simplified truncation for Cursor Agent endpoint
   * Uses in-memory messages instead of loading from database
   */
  truncateInMemory(
    messages: UnifiedMessage[],
    options?: {
      systemPromptTokens?: number
      maxTokens?: number
      pendingToolUseIds?: Iterable<string>
      integrityMode?: EnforceToolProtocolOptions["mode"]
    }
  ): TruncationResult {
    const systemPromptTokens = options?.systemPromptTokens || 0
    const maxTokens =
      options?.maxTokens ||
      this.config.max_context_tokens - this.config.safety_margin_tokens

    const effectiveMaxTokens = Math.max(maxTokens - systemPromptTokens, 1000)
    const totalTokens = this.tokenCounter.countMessages(messages)

    this.logger.debug(
      `In-memory truncation: ${totalTokens} tokens (limit: ${effectiveMaxTokens})`
    )

    if (totalTokens <= effectiveMaxTokens) {
      return {
        messages,
        was_truncated: false,
        original_token_count: totalTokens,
        truncated_token_count: totalTokens,
        summary_used: false,
      }
    }

    // Find truncation point with tool integrity
    const truncationIndex = this.toolIntegrity.findTruncationPointWithIntegrity(
      messages,
      effectiveMaxTokens,
      { mode: options?.integrityMode }
    )

    let recentMessages = messages.slice(truncationIndex)

    // Ensure minimum messages
    if (
      recentMessages.length < this.config.min_recent_messages &&
      messages.length >= this.config.min_recent_messages
    ) {
      const minIndex = messages.length - this.config.min_recent_messages
      if (minIndex < truncationIndex) {
        const candidateRecent = messages.slice(minIndex)
        const candidateTokens = this.tokenCounter.countMessages(candidateRecent)
        if (candidateTokens <= effectiveMaxTokens) {
          recentMessages = candidateRecent
        } else {
          this.logger.warn(
            `Skipping min_recent_messages override because it exceeds limit: ` +
              `${candidateTokens} > ${effectiveMaxTokens}`
          )
        }
      }
    }

    let truncatedTokenCount = this.tokenCounter.countMessages(recentMessages)
    if (truncatedTokenCount > effectiveMaxTokens) {
      const fitted = this.trimOldestMessagesToFit(
        recentMessages,
        effectiveMaxTokens,
        {
          pendingToolUseIds: options?.pendingToolUseIds,
          integrityMode: options?.integrityMode,
        }
      )
      recentMessages = fitted.messages
      truncatedTokenCount = fitted.tokenCount
      this.logger.warn(
        `In-memory payload still exceeded limit after integrity truncation, applied hard fit: ` +
          `${fitted.originalTokenCount} -> ${fitted.tokenCount} tokens`
      )
    }

    this.logger.log(
      `In-memory truncation: ${messages.length} -> ${recentMessages.length} messages ` +
        `(${totalTokens} -> ${truncatedTokenCount} tokens)`
    )

    return {
      messages: recentMessages,
      was_truncated: true,
      original_token_count: totalTokens,
      truncated_token_count: truncatedTokenCount,
      summary_used: false,
    }
  }

  /**
   * Build summary message from summary text
   * No fake assistant response - just the summary as a system-level context
   */
  private buildSummaryMessage(summaryText: string): UnifiedMessage {
    return {
      role: "user",
      content: `[Previous conversation summary]\n${summaryText}\n\n[Current conversation continues below]`,
    }
  }

  /**
   * Check if tokens exceed summary trigger threshold
   * Used for logging/monitoring purposes
   */
  shouldTriggerSummary(totalTokens: number): boolean {
    return totalTokens > this.config.summary_trigger_tokens
  }

  /**
   * Validate messages have proper tool integrity
   */
  validateIntegrity(messages: UnifiedMessage[]): string[] {
    return this.toolIntegrity.validateIntegrity(messages)
  }

  /**
   * Get current configuration
   */
  getConfig(): TruncationConfig {
    return { ...this.config }
  }

  /**
   * Estimate if messages would need truncation
   */
  wouldNeedTruncation(
    messages: UnifiedMessage[],
    systemPromptTokens: number = 0
  ): boolean {
    const effectiveMaxTokens =
      this.config.max_context_tokens -
      this.config.safety_margin_tokens -
      systemPromptTokens

    const totalTokens = this.tokenCounter.countMessages(messages)
    return totalTokens > effectiveMaxTokens
  }

  /**
   * Get token count for messages
   */
  countTokens(messages: UnifiedMessage[]): number {
    return this.tokenCounter.countMessages(messages)
  }

  private trimOldestMessagesToFit(
    messages: UnifiedMessage[],
    maxTokens: number,
    options?: {
      pendingToolUseIds?: Iterable<string>
      integrityMode?: EnforceToolProtocolOptions["mode"]
    }
  ): {
    messages: UnifiedMessage[]
    tokenCount: number
    originalTokenCount: number
  } {
    if (messages.length === 0) {
      return { messages, tokenCount: 0, originalTokenCount: 0 }
    }

    let fitted = [...messages]
    const originalTokenCount = this.tokenCounter.countMessages(fitted)
    let tokenCount = originalTokenCount

    while (true) {
      // Keep at least the latest message; if a single message is too large,
      // caller should handle it as oversized user/tool input.
      while (fitted.length > 1 && tokenCount > maxTokens) {
        fitted.shift()
        tokenCount = this.tokenCounter.countMessages(fitted)
      }

      // After trimming, use unified sanitize to clean up all orphaned
      // tool_use/tool_result blocks in both directions.
      const sanitized = this.toolIntegrity.sanitizeMessages(fitted, {
        mode: options?.integrityMode ?? "global",
        pendingToolUseIds: options?.pendingToolUseIds,
      })
      fitted = sanitized.messages
      tokenCount = this.tokenCounter.countMessages(fitted)

      if (tokenCount <= maxTokens || fitted.length <= 1) {
        break
      }

      // Synthetic repair can grow the history. Drop one more oldest message
      // and re-run cleanup until the hard budget is satisfied again.
      fitted.shift()
      tokenCount = this.tokenCounter.countMessages(fitted)
    }

    return { messages: fitted, tokenCount, originalTokenCount }
  }
}
