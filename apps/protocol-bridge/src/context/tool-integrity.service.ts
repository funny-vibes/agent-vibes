import { Injectable, Logger } from "@nestjs/common"
import {
  ToolPair,
  UnifiedMessage,
  isToolResultBlock,
  isToolUseBlock,
  normalizeContent,
} from "./types"
import { TokenCounterService } from "./token-counter.service"
import {
  enforceToolProtocol,
  type EnforceToolProtocolOptions,
} from "./tool-protocol-integrity"

/**
 * Result of sanitizeMessages operation
 */
export interface SanitizeResult {
  messages: UnifiedMessage[]
  removedOrphanToolUses: number
  removedOrphanToolResults: number
  removedEmptyMessages: number
  mergedConsecutiveMessages: number
}

/**
 * Tool Integrity Service
 *
 * Ensures tool_use and tool_result pairs remain intact during truncation.
 * Supports both Anthropic format (content array with tool_use/tool_result blocks)
 * and function-call style format (tool_calls field + separate tool role messages).
 *
 * Key features:
 * - Extracts tool_use IDs from both formats
 * - Extracts tool_result IDs from both formats
 * - Validates tool pair integrity
 * - Adjusts truncation point to avoid orphaned tools
 */
@Injectable()
export class ToolIntegrityService {
  private readonly logger = new Logger(ToolIntegrityService.name)

  constructor(private readonly tokenCounter: TokenCounterService) {}

  /**
   * Extract all tool_use IDs from a message
   * Handles both content-block and function-call style formats.
   */
  extractToolUseIds(message: UnifiedMessage): string[] {
    const ids: string[] = []

    // Check Anthropic format: tool_use blocks in content array
    const contentBlocks = normalizeContent(message.content)
    for (const block of contentBlocks) {
      if (isToolUseBlock(block)) {
        ids.push(block.id)
      }
    }

    // Check function-call style: tool_calls field
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.id) {
          ids.push(toolCall.id)
        }
      }
    }

    return ids
  }

  /**
   * Extract all tool_result IDs from a message
   * Handles both content-block and function-call style formats.
   */
  extractToolResultIds(message: UnifiedMessage): string[] {
    const ids: string[] = []

    // Check Anthropic format: tool_result blocks in content array
    const contentBlocks = normalizeContent(message.content)
    for (const block of contentBlocks) {
      if (isToolResultBlock(block)) {
        ids.push(block.tool_use_id)
      }
    }

    // Check function-call style: tool_call_id field
    if (message.tool_call_id) {
      ids.push(message.tool_call_id)
    }

    return ids
  }

  /**
   * Check if a message contains any tool_use
   */
  hasToolUse(message: UnifiedMessage): boolean {
    return this.extractToolUseIds(message).length > 0
  }

  /**
   * Check if a message contains any tool_result
   */
  hasToolResult(message: UnifiedMessage): boolean {
    return this.extractToolResultIds(message).length > 0
  }

  /**
   * Build a map of all tool pairs in the message list
   * Returns a map of tool_use_id -> ToolPair
   */
  buildToolPairMap(messages: UnifiedMessage[]): Map<string, ToolPair> {
    const pairs = new Map<string, ToolPair>()

    // First pass: find all tool_use
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!
      if (message.role !== "assistant") continue

      const toolUseIds = this.extractToolUseIds(message)
      for (const id of toolUseIds) {
        // Extract tool name from content
        let toolName = "unknown"
        const contentBlocks = normalizeContent(message.content)
        for (const block of contentBlocks) {
          if (isToolUseBlock(block) && block.id === id) {
            toolName = block.name
            break
          }
        }
        // Also check function-call style
        if (message.tool_calls) {
          for (const tc of message.tool_calls) {
            if (tc.id === id) {
              toolName = tc.function.name
              break
            }
          }
        }

        pairs.set(id, {
          tool_use_id: id,
          tool_use_message_index: i,
          tool_result_message_index: null,
          tool_name: toolName,
        })
      }
    }

    // Second pass: find all tool_result and link to tool_use
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!

      const toolResultIds = this.extractToolResultIds(message)
      for (const id of toolResultIds) {
        const pair = pairs.get(id)
        if (pair) {
          pair.tool_result_message_index = i
        } else {
          // Orphaned tool_result (no corresponding tool_use)
          this.logger.warn(`Orphaned tool_result found: ${id} at index ${i}`)
        }
      }
    }

    return pairs
  }

  /**
   * Find all orphaned tool_results in the given messages
   * (tool_results whose tool_use is NOT in the messages)
   */
  findOrphanedToolResults(
    messages: UnifiedMessage[],
    availableToolUseIds: Set<string>
  ): Array<{ tool_use_id: string; message_index: number }> {
    const orphans: Array<{ tool_use_id: string; message_index: number }> = []

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!
      const toolResultIds = this.extractToolResultIds(message)

      for (const id of toolResultIds) {
        if (!availableToolUseIds.has(id)) {
          orphans.push({ tool_use_id: id, message_index: i })
        }
      }
    }

    return orphans
  }

  /**
   * Find all orphaned tool_uses in the given messages
   * (tool_uses whose tool_result is NOT in the messages)
   */
  findOrphanedToolUses(
    messages: UnifiedMessage[],
    availableToolResultIds: Set<string>
  ): Array<{ tool_use_id: string; message_index: number }> {
    const orphans: Array<{ tool_use_id: string; message_index: number }> = []

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!
      if (message.role !== "assistant") continue

      const toolUseIds = this.extractToolUseIds(message)

      for (const id of toolUseIds) {
        if (!availableToolResultIds.has(id)) {
          orphans.push({ tool_use_id: id, message_index: i })
        }
      }
    }

    return orphans
  }

  /**
   * Find the optimal truncation point that maintains tool integrity
   *
   * Algorithm:
   * 1. Start from the initial truncation point (based on token count)
   * 2. Collect all tool_use IDs in the retained messages
   * 3. Check if any retained user messages have orphaned tool_results
   * 4. If yes, move the truncation point earlier to include the tool_use
   * 5. Repeat until no orphaned tool_results exist
   *
   * @param messages All messages
   * @param targetTokens Target token count for retained messages
   * @returns The index to start from (messages.slice(index) will be retained)
   */
  findTruncationPointWithIntegrity(
    messages: UnifiedMessage[],
    targetTokens: number,
    options?: {
      mode?: EnforceToolProtocolOptions["mode"]
    }
  ): number {
    if (messages.length === 0) return 0

    const mode = options?.mode ?? "global"

    // Step 1: Find initial truncation point based on tokens
    let truncationIndex = this.tokenCounter.findTruncationIndex(
      messages,
      targetTokens
    )

    // Step 2: Build the full tool pair map
    const toolPairs = this.buildToolPairMap(messages)

    // Step 3: Iteratively adjust truncation point
    const maxIterations = messages.length // Prevent infinite loop
    let iterations = 0

    while (iterations < maxIterations) {
      iterations++

      // Get retained messages
      const retainedMessages = messages.slice(truncationIndex)
      if (retainedMessages.length === 0) break

      // Collect all tool_use IDs in retained messages
      const retainedToolUseIds = new Set<string>()
      for (const msg of retainedMessages) {
        for (const id of this.extractToolUseIds(msg)) {
          retainedToolUseIds.add(id)
        }
      }

      // Find orphaned tool_results in retained messages. Strict-adjacent
      // backends (Cloud Code Claude) require tool_result blocks to match the
      // immediately preceding assistant message, not merely any assistant in
      // the retained window.
      const orphans =
        mode === "strict-adjacent"
          ? this.findStrictAdjacentOrphanedToolResults(
              retainedMessages,
              retainedToolUseIds
            )
          : this.findOrphanedToolResults(retainedMessages, retainedToolUseIds)

      if (orphans.length === 0) {
        // No orphans, we're done
        break
      }

      // Find the earliest tool_use that needs to be included
      let earliestToolUseIndex = truncationIndex

      for (const orphan of orphans) {
        const pair = toolPairs.get(orphan.tool_use_id)
        if (pair && pair.tool_use_message_index < earliestToolUseIndex) {
          earliestToolUseIndex = pair.tool_use_message_index
        }
      }

      if (earliestToolUseIndex >= truncationIndex) {
        // Can't move back further, or tool_use not found
        // This means we have truly orphaned tool_results (no tool_use in history)
        this.logger.warn(
          `Found ${orphans.length} truly orphaned tool_result(s), cannot include tool_use`
        )
        break
      }

      // Move truncation point back to include the tool_use
      this.logger.debug(
        `Moving truncation point from ${truncationIndex} to ${earliestToolUseIndex} to include tool_use`
      )
      truncationIndex = earliestToolUseIndex
    }

    // Step 4: Also check for orphaned tool_uses at the end
    // If the last assistant message has tool_use without result, we may need to remove it
    const retainedMessages = messages.slice(truncationIndex)
    const retainedToolResultIds = new Set<string>()
    for (const msg of retainedMessages) {
      for (const id of this.extractToolResultIds(msg)) {
        retainedToolResultIds.add(id)
      }
    }

    // Check for orphaned tool_uses at the end of retained messages
    // These are acceptable - they represent pending tool calls
    // But we should log them for debugging
    const orphanedToolUses = this.findOrphanedToolUses(
      retainedMessages,
      retainedToolResultIds
    )

    if (orphanedToolUses.length > 0) {
      this.logger.debug(
        `Found ${orphanedToolUses.length} tool_use(s) without result (may be pending)`
      )
    }

    return truncationIndex
  }

  /**
   * Find the earliest truncation point that both preserves tool integrity and
   * actually fits within the requested token budget.
   *
   * `findTruncationPointWithIntegrity()` may intentionally move the boundary
   * earlier to keep a tool_use/tool_result pair intact, which can leave the
   * retained suffix slightly over budget. This helper walks the boundary
   * forward again, but only to other tool-safe cut points.
   */
  findBudgetSafeTruncationPointWithIntegrity(
    messages: UnifiedMessage[],
    targetTokens: number,
    options?: {
      mode?: EnforceToolProtocolOptions["mode"]
    }
  ): number {
    if (messages.length === 0) return 0

    const mode = options?.mode ?? "global"
    let truncationIndex = this.findTruncationPointWithIntegrity(
      messages,
      targetTokens,
      { mode }
    )

    while (truncationIndex < messages.length) {
      const retainedMessages = messages.slice(truncationIndex)
      if (this.tokenCounter.countMessages(retainedMessages) <= targetTokens) {
        return truncationIndex
      }

      const nextIndex = this.findNextValidTruncationIndex(
        messages,
        truncationIndex + 1,
        mode
      )
      if (nextIndex <= truncationIndex) {
        break
      }

      this.logger.debug(
        `Advancing truncation point from ${truncationIndex} to ${nextIndex} to satisfy token budget without breaking tool pairs`
      )
      truncationIndex = nextIndex
    }

    return truncationIndex
  }

  /**
   * Validate that messages have proper tool integrity
   * Returns list of issues found
   */
  validateIntegrity(messages: UnifiedMessage[]): string[] {
    const issues: string[] = []
    const toolPairs = this.buildToolPairMap(messages)

    // Collect all tool IDs
    const allToolUseIds = new Set<string>()
    const allToolResultIds = new Set<string>()

    for (const msg of messages) {
      for (const id of this.extractToolUseIds(msg)) {
        allToolUseIds.add(id)
      }
      for (const id of this.extractToolResultIds(msg)) {
        allToolResultIds.add(id)
      }
    }

    // Check for orphaned tool_results
    for (const id of allToolResultIds) {
      if (!allToolUseIds.has(id)) {
        issues.push(`Orphaned tool_result: ${id} (no matching tool_use)`)
      }
    }

    // Check for tool_uses without results (warning, not error)
    for (const id of allToolUseIds) {
      if (!allToolResultIds.has(id)) {
        const pair = toolPairs.get(id)
        if (pair) {
          issues.push(
            `Tool_use without result: ${id} (${pair.tool_name}) - may be pending`
          )
        }
      }
    }

    // Check message order: tool_use should come before its tool_result
    for (const [id, pair] of toolPairs) {
      if (
        pair.tool_result_message_index !== null &&
        pair.tool_result_message_index <= pair.tool_use_message_index
      ) {
        issues.push(
          `Tool order violation: result for ${id} appears before or at same index as use`
        )
      }
    }

    return issues
  }

  /**
   * Extract messages with tool integrity preserved while staying within the
   * requested token budget.
   */
  extractWithIntegrity(
    messages: UnifiedMessage[],
    targetTokens: number,
    options?: {
      mode?: EnforceToolProtocolOptions["mode"]
    }
  ): UnifiedMessage[] {
    const truncationIndex = this.findBudgetSafeTruncationPointWithIntegrity(
      messages,
      targetTokens,
      options
    )
    return messages.slice(truncationIndex)
  }

  private retainedMessagesHaveValidToolResults(
    messages: UnifiedMessage[],
    mode: EnforceToolProtocolOptions["mode"]
  ): boolean {
    if (messages.length === 0) return true

    const retainedToolUseIds = new Set<string>()
    for (const message of messages) {
      for (const id of this.extractToolUseIds(message)) {
        retainedToolUseIds.add(id)
      }
    }

    const orphans =
      mode === "strict-adjacent"
        ? this.findStrictAdjacentOrphanedToolResults(
            messages,
            retainedToolUseIds
          )
        : this.findOrphanedToolResults(messages, retainedToolUseIds)

    return orphans.length === 0
  }

  private findNextValidTruncationIndex(
    messages: UnifiedMessage[],
    startIndex: number,
    mode: EnforceToolProtocolOptions["mode"]
  ): number {
    const clampedStart = Math.max(0, Math.min(startIndex, messages.length))

    for (
      let candidate = clampedStart;
      candidate <= messages.length;
      candidate++
    ) {
      if (
        this.retainedMessagesHaveValidToolResults(
          messages.slice(candidate),
          mode
        )
      ) {
        return candidate
      }
    }

    return messages.length
  }

  private findStrictAdjacentOrphanedToolResults(
    messages: UnifiedMessage[],
    availableToolUseIds: Set<string>
  ): Array<{ tool_use_id: string; message_index: number }> {
    const orphans: Array<{ tool_use_id: string; message_index: number }> = []

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!
      if (message.role !== "user") continue

      const previous = i > 0 ? messages[i - 1] : undefined
      const previousToolUseIds =
        previous?.role === "assistant"
          ? new Set(this.extractToolUseIds(previous))
          : new Set<string>()

      const toolResultIds = this.extractToolResultIds(message)
      for (const id of toolResultIds) {
        if (!availableToolUseIds.has(id) || !previousToolUseIds.has(id)) {
          orphans.push({ tool_use_id: id, message_index: i })
        }
      }
    }

    return orphans
  }

  /**
   * Sanitize messages to ensure tool protocol integrity.
   *
   * This is the single entry point for post-truncation repair:
   * 1. Preserve pending tool_use blocks that may still be waiting on results
   * 2. Reverse cleanup: remove tool_result blocks without matching tool_use
   * 3. Remove messages that become empty after cleanup
   * 4. Merge consecutive same-role messages (invalid for most backends)
   */
  sanitizeMessages(
    messages: UnifiedMessage[],
    options?: EnforceToolProtocolOptions
  ): SanitizeResult {
    if (messages.length === 0) {
      return {
        messages: [],
        removedOrphanToolUses: 0,
        removedOrphanToolResults: 0,
        removedEmptyMessages: 0,
        mergedConsecutiveMessages: 0,
      }
    }

    // Delegate all repair logic to the unified tool protocol integrity helper
    const guardResult = enforceToolProtocol(
      messages as Array<
        UnifiedMessage & { role: "user" | "assistant"; content: unknown }
      >,
      {
        mode: options?.mode ?? "global",
        pendingToolUseIds: options?.pendingToolUseIds,
      }
    )

    const result: SanitizeResult = {
      messages: guardResult.messages as UnifiedMessage[],
      // "removedOrphanToolUses" is repurposed: counts synthetic tool_result injected
      removedOrphanToolUses: guardResult.injectedToolResults,
      removedOrphanToolResults: guardResult.removedToolResults,
      removedEmptyMessages: guardResult.removedEmptyMessages,
      mergedConsecutiveMessages: 0,
    }

    if (guardResult.changed) {
      this.logger.warn(
        `Sanitized messages: injected ${result.removedOrphanToolUses} synthetic tool_result for orphan tool_use, ` +
          `removed ${result.removedOrphanToolResults} orphan tool_result, ` +
          `${result.removedEmptyMessages} empty message(s)`
      )
    }

    return result
  }
}
