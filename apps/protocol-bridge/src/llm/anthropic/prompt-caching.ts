/**
 * Prompt Caching optimization for Anthropic Claude API.
 *
 * Implements automatic cache_control injection following Anthropic's prompt caching docs:
 * https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 *
 * Cache prefixes are created in evaluation order: tools → system → messages.
 * Up to 4 cache breakpoints are allowed per request.
 * Cached tokens cost 0.1x the base price (90% savings).
 *
 * Inspired by CLIProxyAPI's caching implementation.
 */

// ───────────────────────── types ──────────────────────────

interface CacheControl {
  type: string
  ttl?: string
}

interface ContentBlock {
  type?: string
  text?: string
  cache_control?: CacheControl
  [key: string]: unknown
}

interface MessageBlock {
  role?: string
  content?: string | ContentBlock[]
  [key: string]: unknown
}

interface PayloadBody {
  tools?: ContentBlock[]
  system?: string | ContentBlock[]
  messages?: MessageBlock[]
  [key: string]: unknown
}

// ───────────────────── cache_control injection ─────────────────────

/**
 * Count existing cache_control blocks across tools, system, and messages.
 */
function countCacheControls(payload: PayloadBody): number {
  let count = 0

  if (Array.isArray(payload.system)) {
    for (const item of payload.system) {
      if (item.cache_control) count++
    }
  }

  if (Array.isArray(payload.tools)) {
    for (const item of payload.tools) {
      if (item.cache_control) count++
    }
  }

  if (Array.isArray(payload.messages)) {
    for (const msg of payload.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.cache_control) count++
        }
      }
    }
  }

  return count
}

/**
 * Inject cache_control into the last tool definition.
 * Caches ALL tool definitions when hit.
 */
function injectToolsCacheControl(payload: PayloadBody): void {
  const tools = payload.tools
  if (!Array.isArray(tools) || tools.length === 0) return

  // Skip if any tool already has cache_control
  if (tools.some((tool) => tool.cache_control)) return

  const lastTool = tools[tools.length - 1]
  if (lastTool) lastTool.cache_control = { type: "ephemeral" }
}

/**
 * Inject cache_control into the last system prompt element.
 * Caches ALL system content when hit.
 * Converts string system prompts to array format if needed.
 */
function injectSystemCacheControl(payload: PayloadBody): void {
  if (payload.system === undefined || payload.system === null) return

  if (typeof payload.system === "string") {
    // Convert string → array with cache_control
    payload.system = [
      {
        type: "text",
        text: payload.system,
        cache_control: { type: "ephemeral" },
      },
    ]
    return
  }

  if (!Array.isArray(payload.system) || payload.system.length === 0) return

  // Skip if any system element already has cache_control
  if (payload.system.some((item) => item.cache_control)) return

  const lastSystem = payload.system[payload.system.length - 1]
  if (lastSystem) lastSystem.cache_control = { type: "ephemeral" }
}

/**
 * Inject cache_control into the second-to-last user turn for multi-turn caching.
 * Only adds if there are ≥2 user turns and no message already has cache_control.
 */
function injectMessagesCacheControl(payload: PayloadBody): void {
  const messages = payload.messages
  if (!Array.isArray(messages)) return

  // Skip if any message content already has cache_control
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      if (msg.content.some((block) => block.cache_control)) return
    }
  }

  // Find all user message indices
  const userIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") {
      userIndices.push(i)
    }
  }

  // Need at least 2 user turns
  if (userIndices.length < 2) return

  const targetIdx = userIndices[userIndices.length - 2]!
  const targetMsg = messages[targetIdx]
  if (!targetMsg) return

  if (Array.isArray(targetMsg.content) && targetMsg.content.length > 0) {
    // Add to last content block of this message
    const lastBlock = targetMsg.content[targetMsg.content.length - 1]
    if (lastBlock) lastBlock.cache_control = { type: "ephemeral" }
  } else if (typeof targetMsg.content === "string") {
    // Convert string content to array with cache_control
    targetMsg.content = [
      {
        type: "text",
        text: targetMsg.content,
        cache_control: { type: "ephemeral" },
      },
    ]
  }
}

/**
 * Auto-inject cache_control breakpoints if none exist.
 * Three-level injection: tools → system → messages.
 */
export function ensureCacheControl(payload: PayloadBody): void {
  if (countCacheControls(payload) > 0) return

  injectToolsCacheControl(payload)
  injectSystemCacheControl(payload)
  injectMessagesCacheControl(payload)
}

// ───────────────── cache_control limit enforcement ─────────────────

/**
 * Enforce Anthropic's cache_control block limit (max 4 breakpoints per request).
 *
 * Removal priority (strip lowest-value first):
 *   Phase 1: system blocks earliest-first, preserving last one.
 *   Phase 2: tool blocks earliest-first, preserving last one.
 *   Phase 3: message content blocks earliest-first.
 *   Phase 4: remaining system blocks (last system).
 *   Phase 5: remaining tool blocks (last tool).
 */
export function enforceCacheControlLimit(
  payload: PayloadBody,
  maxBlocks: number = 4
): void {
  const total = countCacheControls(payload)
  if (total <= maxBlocks) return

  let excess = total - maxBlocks

  const stripFromArrayExceptLast = (
    items: ContentBlock[] | undefined
  ): void => {
    if (!Array.isArray(items) || items.length === 0 || excess <= 0) return

    // Find last index with cache_control
    let lastCcIdx = -1
    for (let i = 0; i < items.length; i++) {
      if (items[i]?.cache_control) lastCcIdx = i
    }

    // Strip all except last
    for (let i = 0; i < items.length && excess > 0; i++) {
      const item = items[i]
      if (item?.cache_control && i !== lastCcIdx) {
        delete item.cache_control
        excess--
      }
    }
  }

  const stripAll = (items: ContentBlock[] | undefined): void => {
    if (!Array.isArray(items) || excess <= 0) return
    for (const item of items) {
      if (excess <= 0) return
      if (item.cache_control) {
        delete item.cache_control
        excess--
      }
    }
  }

  const stripMessages = (): void => {
    if (!Array.isArray(payload.messages) || excess <= 0) return
    for (const msg of payload.messages) {
      if (excess <= 0) return
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (excess <= 0) return
          if (block.cache_control) {
            delete block.cache_control
            excess--
          }
        }
      }
    }
  }

  // Phase 1: system (except last)
  if (Array.isArray(payload.system)) stripFromArrayExceptLast(payload.system)
  if (excess <= 0) return

  // Phase 2: tools (except last)
  stripFromArrayExceptLast(payload.tools)
  if (excess <= 0) return

  // Phase 3: messages
  stripMessages()
  if (excess <= 0) return

  // Phase 4: remaining system
  if (Array.isArray(payload.system)) stripAll(payload.system)
  if (excess <= 0) return

  // Phase 5: remaining tools
  stripAll(payload.tools)
}

// ───────────────── TTL normalization ─────────────────

/**
 * Normalize cache_control TTL values to prevent ordering violations.
 *
 * Under prompt-caching-scope-2026-01-05 beta:
 * Evaluation order is tools → system → messages.
 * A 1h-TTL block must NOT appear after a 5m-TTL (default) block.
 *
 * Strategy: once a 5m block is seen, strip ttl from all subsequent 1h blocks.
 */
export function normalizeCacheControlTTL(payload: PayloadBody): void {
  let seen5m = false

  const normalizeBlock = (block: ContentBlock): void => {
    if (!block.cache_control) return

    const ttl = block.cache_control.ttl
    if (!ttl || ttl !== "1h") {
      // No TTL or non-1h → it's effectively 5m default
      seen5m = true
      return
    }

    // It's a 1h block
    if (seen5m) {
      // A 5m block was seen earlier → downgrade this 1h to default
      delete block.cache_control.ttl
    }
  }

  // Walk in evaluation order: tools → system → messages
  if (Array.isArray(payload.tools)) {
    for (const tool of payload.tools) {
      normalizeBlock(tool)
    }
  }

  if (Array.isArray(payload.system)) {
    for (const item of payload.system) {
      normalizeBlock(item)
    }
  }

  if (Array.isArray(payload.messages)) {
    for (const msg of payload.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          normalizeBlock(block)
        }
      }
    }
  }
}

// ───────────────── thinking safety ─────────────────

/**
 * Disable thinking if tool_choice forces tool use.
 * Anthropic API does not allow thinking when tool_choice.type is "any" or "tool".
 * See: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking#important-considerations
 */
export function disableThinkingIfToolChoiceForced(payload: PayloadBody): void {
  const toolChoice = payload.tool_choice as { type?: string } | undefined | null
  if (!toolChoice || typeof toolChoice !== "object") return

  const choiceType = toolChoice.type
  if (choiceType === "any" || choiceType === "tool") {
    delete payload.thinking
    // Also clean up adaptive thinking effort
    const outputConfig = payload.output_config as
      | Record<string, unknown>
      | undefined
    if (outputConfig) {
      delete outputConfig.effort
      if (Object.keys(outputConfig).length === 0) {
        delete payload.output_config
      }
    }
  }
}

// ───────────────── combined optimization entry point ─────────────────

/**
 * Apply all prompt caching optimizations to a Claude API request body.
 * Call this before sending the request to the upstream API.
 *
 * Operations performed:
 * 1. Disable thinking if tool_choice forces tool use
 * 2. Auto-inject cache_control breakpoints if none exist
 * 3. Enforce cache_control block limit (max 4)
 * 4. Normalize TTL values to prevent ordering violations
 */
export function applyPromptCachingOptimizations(
  body: Record<string, unknown>
): void {
  const payload = body as unknown as PayloadBody

  // 1. Thinking safety
  disableThinkingIfToolChoiceForced(payload)

  // 2. Auto-inject cache_control if missing
  ensureCacheControl(payload)

  // 3. Enforce cache_control block limit
  enforceCacheControlLimit(payload)

  // 4. Normalize TTL ordering
  normalizeCacheControlTTL(payload)
}
