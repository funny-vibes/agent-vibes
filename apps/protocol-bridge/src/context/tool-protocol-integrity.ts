/**
 * Tool Protocol Integrity
 *
 * Pure-function module that enforces tool protocol invariants on message arrays.
 * This is the Single Source of Truth for all tool_use/tool_result repair logic.
 *
 * Design:
 * - Used at write-time (ChatSessionManager.addMessage/replaceMessages)
 * - Used at read-time (normalizeToolProtocolMessages / sanitizeMessages) as thin wrappers
 * - Pure functions, no NestJS DI dependency — importable anywhere
 *
 * Invariants enforced:
 * 1. Every tool_use must have a matching tool_result in a following user message
 * 2. Every tool_result must reference a tool_use that exists in a preceding assistant message
 * 3. No empty messages after cleanup
 */

// ── Type definitions ───────────────────────────────────────────────────

export interface IntegrityMessage {
  role: "user" | "assistant" | "system"
  content: unknown
  tool_calls?: Array<{ id: string }>
  tool_call_id?: string
}

export interface RepairResult<T extends IntegrityMessage = IntegrityMessage> {
  messages: T[]
  /** Number of synthetic tool_result blocks injected for orphan tool_use */
  injectedToolResults: number
  /** Number of orphan tool_result blocks removed (no matching tool_use) */
  removedToolResults: number
  /** Number of empty messages removed after cleanup */
  removedEmptyMessages: number
  /** Whether any repairs were made */
  changed: boolean
}

export interface IntegrityViolation {
  type: "orphan_tool_use" | "orphan_tool_result" | "order_violation"
  toolId: string
  messageIndex: number
  detail: string
}

export interface EnforceToolProtocolOptions {
  mode?: "strict-adjacent" | "global"
  /**
   * Tool-use IDs that are still legitimately pending. These must remain
   * unmatched without being rewritten into synthetic failure results.
   */
  pendingToolUseIds?: Iterable<string>
}

// ── Helpers ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

function extractToolUseIds(content: unknown): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(content)) return ids
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type !== "tool_use") continue
    const id = typeof block.id === "string" ? block.id : ""
    if (id) ids.add(id)
  }
  return ids
}

function extractToolResultIds(content: unknown): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(content)) return ids
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type !== "tool_result") continue
    const id = typeof block.tool_use_id === "string" ? block.tool_use_id : ""
    if (id) ids.add(id)
  }
  return ids
}

function collectAllToolUseIds<T extends IntegrityMessage>(
  messages: T[]
): Set<string> {
  const ids = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    for (const id of extractToolUseIds(msg.content)) {
      ids.add(id)
    }
    // Also handle function-call style
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) ids.add(tc.id)
      }
    }
  }
  return ids
}

function collectAllToolResultIds<T extends IntegrityMessage>(
  messages: T[]
): Set<string> {
  const ids = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== "user") continue
    for (const id of extractToolResultIds(msg.content)) {
      ids.add(id)
    }
    // Also handle function-call style (tool_call_id field)
    if (msg.tool_call_id) {
      ids.add(msg.tool_call_id)
    }
  }
  return ids
}

function hasNonEmptyContent(msg: IntegrityMessage): boolean {
  // Check tool_calls first — they always count as content regardless of content field
  if (msg.tool_calls && msg.tool_calls.length > 0) return true

  if (typeof msg.content === "string") {
    return msg.content.trim().length > 0
  }
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    return msg.content.some((block) => {
      if (!isRecord(block)) return true
      if (block.type === "text") {
        return typeof block.text === "string" && block.text.trim().length > 0
      }
      // Non-text blocks (tool_use, tool_result, image, thinking) are always "content"
      return true
    })
  }
  return false
}

// ── Core repair function ───────────────────────────────────────────────

/**
 * Enforce tool protocol integrity on a message array.
 *
 * Performs two passes:
 * 1. Remove orphan tool_result blocks (tool_result with no matching tool_use)
 * 2. Inject synthetic tool_result for orphan tool_use blocks (tool_use with no matching tool_result)
 *
 * Then cleans up empty messages.
 *
 * Options:
 * - mode: 'strict-adjacent' (default) — tool_result must match tool_use in the immediately previous assistant message
 * - mode: 'global' — tool_result can match any tool_use in the entire conversation (use after truncation)
 * - pendingToolUseIds: preserve these live tool_use IDs without injecting synthetic tool_result
 */
export function enforceToolProtocol<T extends IntegrityMessage>(
  messages: T[],
  options?: EnforceToolProtocolOptions
): RepairResult<T> {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      messages,
      injectedToolResults: 0,
      removedToolResults: 0,
      removedEmptyMessages: 0,
      changed: false,
    }
  }

  const mode = options?.mode ?? "strict-adjacent"
  const pendingToolUseIds = new Set(options?.pendingToolUseIds ?? [])
  let changed = false
  let removedToolResults = 0

  // ── Pass 1: Remove orphan tool_result ────────────────────────────
  // In strict-adjacent mode, tool_result must match tool_use in the immediately previous assistant message.
  // In global mode, tool_result can match any tool_use in the entire conversation.

  const globalToolUseIds =
    mode === "global" ? collectAllToolUseIds(messages) : null

  const pass1: T[] = []

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!

    // Determine allowed tool_use IDs for this position
    const previous = pass1[pass1.length - 1]
    const allowedToolUseIds =
      mode === "global"
        ? globalToolUseIds!
        : previous?.role === "assistant"
          ? (() => {
              const ids = extractToolUseIds(previous.content)
              // Also include function-call style
              if (previous.tool_calls) {
                for (const tc of previous.tool_calls) {
                  if (tc.id) ids.add(tc.id)
                }
              }
              return ids
            })()
          : new Set<string>()

    // Filter tool_result content blocks in user messages
    if (message.role === "user" && Array.isArray(message.content)) {
      const filteredContent = (message.content as unknown[]).filter((block) => {
        if (!isRecord(block)) return true
        if (block.type !== "tool_result") return true
        const toolUseId =
          typeof block.tool_use_id === "string" ? block.tool_use_id : ""
        if (toolUseId.length > 0 && allowedToolUseIds.has(toolUseId)) {
          return true
        }
        removedToolResults++
        changed = true
        return false
      })

      if (filteredContent.length !== (message.content as unknown[]).length) {
        if (filteredContent.length === 0) {
          pass1.push({ ...message, content: "." } as T)
        } else {
          pass1.push({ ...message, content: filteredContent } as T)
        }
        continue
      }
    }

    // Remove function-call style orphan tool_result messages
    if (message.tool_call_id) {
      const allToolUseIds =
        mode === "global"
          ? globalToolUseIds!
          : (() => {
              // Look for tool_call_id in any preceding assistant message's tool_calls
              const ids = new Set<string>()
              for (const prev of pass1) {
                if (prev.role !== "assistant" || !prev.tool_calls) continue
                for (const tc of prev.tool_calls) {
                  if (tc.id) ids.add(tc.id)
                }
              }
              return ids
            })()
      if (!allToolUseIds.has(message.tool_call_id)) {
        removedToolResults++
        changed = true
        continue // skip this message entirely
      }
    }

    pass1.push(message)
  }

  // ── Pass 2: Inject synthetic tool_result for orphan tool_use ─────
  const allResultIds = collectAllToolResultIds(pass1)
  let injectedToolResults = 0
  const pass2: T[] = []

  for (let i = 0; i < pass1.length; i++) {
    const message = pass1[i]!
    pass2.push(message)

    if (message.role !== "assistant") continue

    // Collect tool_use IDs from this assistant message
    const toolUseIds = extractToolUseIds(message.content)
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        if (tc.id) toolUseIds.add(tc.id)
      }
    }
    if (toolUseIds.size === 0) continue

    // Find orphan IDs (tool_use without tool_result)
    const orphanIds: string[] = []
    for (const id of toolUseIds) {
      if (!allResultIds.has(id) && !pendingToolUseIds.has(id)) {
        orphanIds.push(id)
      }
    }
    if (orphanIds.length === 0) continue

    // Build synthetic tool_result blocks
    const syntheticResults = orphanIds.map((id) => ({
      type: "tool_result" as const,
      tool_use_id: id,
      content:
        "Tool execution was interrupted or result was lost due to context truncation.",
    }))

    // Try to inject into the next user message if it exists
    const next = pass1[i + 1]
    if (next?.role === "user" && Array.isArray(next.content)) {
      const existingResultIds = extractToolResultIds(next.content)
      const missing = syntheticResults.filter(
        (r) => !existingResultIds.has(r.tool_use_id)
      )
      if (missing.length > 0) {
        pass2.push({
          ...next,
          content: [...missing, ...(next.content as unknown[])],
        } as T)
        i++ // skip the original next message
        injectedToolResults += missing.length
        changed = true
      }
    } else {
      // No user message follows — insert a synthetic user message
      pass2.push({
        role: "user",
        content: syntheticResults,
      } as T)
      injectedToolResults += syntheticResults.length
      changed = true
    }
  }

  // ── Pass 3: Remove empty messages ────────────────────────────────
  let removedEmptyMessages = 0
  const pass3 = pass2.filter((msg) => {
    if (hasNonEmptyContent(msg)) return true
    removedEmptyMessages++
    changed = true
    return false
  })

  return {
    messages: pass3,
    injectedToolResults,
    removedToolResults,
    removedEmptyMessages,
    changed,
  }
}

// ── Assert function (read-path safety net) ─────────────────────────────

/**
 * Assert that messages have proper tool protocol integrity.
 * Returns a list of violations found. Does NOT repair.
 *
 * Used as a safety net on the read path (before sending to backend).
 * If violations are found, it indicates a bug in the write path.
 */
export function assertIntegrity(
  messages: IntegrityMessage[]
): IntegrityViolation[] {
  const violations: IntegrityViolation[] = []
  if (!Array.isArray(messages) || messages.length === 0) return violations

  const allToolUseIds = collectAllToolUseIds(messages)
  const allToolResultIds = collectAllToolResultIds(messages)

  // Check for orphan tool_results
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.role !== "user") continue

    for (const id of extractToolResultIds(msg.content)) {
      if (!allToolUseIds.has(id)) {
        violations.push({
          type: "orphan_tool_result",
          toolId: id,
          messageIndex: i,
          detail: `tool_result references non-existent tool_use: ${id}`,
        })
      }
    }
    if (msg.tool_call_id && !allToolUseIds.has(msg.tool_call_id)) {
      violations.push({
        type: "orphan_tool_result",
        toolId: msg.tool_call_id,
        messageIndex: i,
        detail: `function-call style tool_result references non-existent tool_call: ${msg.tool_call_id}`,
      })
    }
  }

  // Check for orphan tool_uses
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.role !== "assistant") continue

    for (const id of extractToolUseIds(msg.content)) {
      if (!allToolResultIds.has(id)) {
        violations.push({
          type: "orphan_tool_use",
          toolId: id,
          messageIndex: i,
          detail: `tool_use has no matching tool_result: ${id}`,
        })
      }
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id && !allToolResultIds.has(tc.id)) {
          violations.push({
            type: "orphan_tool_use",
            toolId: tc.id,
            messageIndex: i,
            detail: `function-call style tool_call has no matching result: ${tc.id}`,
          })
        }
      }
    }
  }

  return violations
}
