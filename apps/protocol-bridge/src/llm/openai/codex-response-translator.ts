/**
 * Codex Response Translator
 *
 * Translates Codex (OpenAI Responses API) SSE events into Claude/Anthropic
 * Messages API SSE events for streaming responses.
 *
 * Ported from CLIProxyAPI: internal/translator/codex/claude/codex_claude_response.go
 *
 * SSE Event Mapping:
 *   Codex SSE Event                          → Claude SSE Event
 *   ─────────────────────────────────────     ──────────────────────────────
 *   response.created                         → message_start
 *   response.reasoning_summary_part.added    → content_block_start (thinking)
 *   response.reasoning_summary_text.delta    → content_block_delta (thinking_delta)
 *   response.reasoning_summary_part.done     → content_block_stop
 *   response.content_part.added              → content_block_start (text)
 *   response.output_text.delta               → content_block_delta (text_delta)
 *   response.content_part.done               → content_block_stop
 *   response.output_item.added (func_call)   → content_block_start (tool_use)
 *   response.function_call_arguments.delta   → content_block_delta (input_json_delta)
 *   response.output_item.done (func_call)    → content_block_stop
 *   response.completed                       → message_delta + message_stop
 */

import type { AnthropicResponse, ContentBlock } from "../../shared/anthropic"

// ── Streaming state ────────────────────────────────────────────────────

export interface CodexStreamState {
  hasToolCall: boolean
  blockIndex: number
  hasReceivedArgumentsDelta: boolean
  responseId: string
  model: string
}

export function createStreamState(): CodexStreamState {
  return {
    hasToolCall: false,
    blockIndex: 0,
    hasReceivedArgumentsDelta: false,
    responseId: "",
    model: "",
  }
}

// ── Claude tool ID sanitizer ───────────────────────────────────────────
// Ported from CLIProxyAPI: internal/util/claude_tool_id.go

let toolIdCounter = 0
const CLAUDE_TOOL_ID_RE = /[^a-zA-Z0-9_-]/g

function sanitizeClaudeToolId(id: string): string {
  const s = id.replace(CLAUDE_TOOL_ID_RE, "_")
  if (!s) {
    return `toolu_${Date.now()}_${++toolIdCounter}`
  }
  return s
}

// ── Usage extraction ───────────────────────────────────────────────────

function extractResponsesUsage(usage: Record<string, unknown> | undefined): {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
} {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }
  }
  let inputTokens = (usage.input_tokens as number) || 0
  const outputTokens = (usage.output_tokens as number) || 0
  const cachedTokens =
    ((usage.input_tokens_details as Record<string, unknown>)
      ?.cached_tokens as number) || 0

  if (cachedTokens > 0) {
    inputTokens = inputTokens >= cachedTokens ? inputTokens - cachedTokens : 0
  }

  return { inputTokens, outputTokens, cachedTokens }
}

// ── SSE event formatting ───────────────────────────────────────────────

function formatSseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// ── Streaming translator ───────────────────────────────────────────────

/**
 * Translate a single Codex SSE line into Claude SSE event(s).
 *
 * @param line - Raw SSE line from Codex upstream (e.g. "data: {...}")
 * @param state - Mutable streaming state maintained across calls
 * @param reverseToolMap - Map from shortened tool names back to originals
 * @returns Array of Claude SSE event strings to emit
 */
export function translateCodexSseEvent(
  line: string,
  state: CodexStreamState,
  reverseToolMap: Map<string, string>
): string[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith("data:")) {
    return []
  }

  const jsonStr = trimmed.slice(5).trim()
  if (!jsonStr || jsonStr === "[DONE]") {
    return []
  }

  let event: Record<string, unknown>
  try {
    event = JSON.parse(jsonStr) as Record<string, unknown>
  } catch {
    return []
  }

  const eventType = event.type as string
  if (!eventType) {
    return []
  }

  const results: string[] = []

  switch (eventType) {
    // ── response.created → message_start ──────────────────────────
    case "response.created": {
      const response = event.response as Record<string, unknown>
      state.responseId = (response?.id as string) || ""
      state.model = (response?.model as string) || ""

      results.push(
        formatSseEvent("message_start", {
          type: "message_start",
          message: {
            id: state.responseId,
            type: "message",
            role: "assistant",
            model: state.model,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            content: [],
            stop_reason: null,
          },
        })
      )
      break
    }

    // ── Reasoning (thinking) blocks ──────────────────────────────
    case "response.reasoning_summary_part.added": {
      results.push(
        formatSseEvent("content_block_start", {
          type: "content_block_start",
          index: state.blockIndex,
          content_block: { type: "thinking", thinking: "" },
        })
      )
      break
    }

    case "response.reasoning_summary_text.delta": {
      const delta = event.delta as string
      if (delta != null) {
        results.push(
          formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "thinking_delta", thinking: delta },
          })
        )
      }
      break
    }

    case "response.reasoning_summary_part.done": {
      results.push(
        formatSseEvent("content_block_stop", {
          type: "content_block_stop",
          index: state.blockIndex,
        })
      )
      state.blockIndex++
      break
    }

    // ── Text content blocks ──────────────────────────────────────
    case "response.content_part.added": {
      results.push(
        formatSseEvent("content_block_start", {
          type: "content_block_start",
          index: state.blockIndex,
          content_block: { type: "text", text: "" },
        })
      )
      break
    }

    case "response.output_text.delta": {
      const delta = event.delta as string
      if (delta != null) {
        results.push(
          formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "text_delta", text: delta },
          })
        )
      }
      break
    }

    case "response.content_part.done": {
      results.push(
        formatSseEvent("content_block_stop", {
          type: "content_block_stop",
          index: state.blockIndex,
        })
      )
      state.blockIndex++
      break
    }

    // ── Function call (tool_use) blocks ──────────────────────────
    case "response.output_item.added": {
      const item = event.item as Record<string, unknown>
      if (!item || item.type !== "function_call") break

      state.hasToolCall = true
      state.hasReceivedArgumentsDelta = false

      // Restore original tool name if shortened
      let name = (item.name as string) || ""
      const original = reverseToolMap.get(name)
      if (original) name = original

      results.push(
        formatSseEvent("content_block_start", {
          type: "content_block_start",
          index: state.blockIndex,
          content_block: {
            type: "tool_use",
            id: sanitizeClaudeToolId((item.call_id as string) || ""),
            name,
            input: {},
          },
        })
      )

      // Emit initial empty input_json_delta
      results.push(
        formatSseEvent("content_block_delta", {
          type: "content_block_delta",
          index: state.blockIndex,
          delta: { type: "input_json_delta", partial_json: "" },
        })
      )
      break
    }

    case "response.function_call_arguments.delta": {
      state.hasReceivedArgumentsDelta = true
      const delta = event.delta as string
      if (delta != null) {
        results.push(
          formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "input_json_delta", partial_json: delta },
          })
        )
      }
      break
    }

    case "response.function_call_arguments.done": {
      // Some models send arguments in a single "done" event without preceding "delta" events.
      // Emit the full arguments as a single input_json_delta so the downstream client
      // receives the complete tool input.
      if (!state.hasReceivedArgumentsDelta) {
        const args = event.arguments as string
        if (args) {
          results.push(
            formatSseEvent("content_block_delta", {
              type: "content_block_delta",
              index: state.blockIndex,
              delta: { type: "input_json_delta", partial_json: args },
            })
          )
        }
      }
      break
    }

    case "response.output_item.done": {
      const item = event.item as Record<string, unknown>
      if (!item || item.type !== "function_call") break

      results.push(
        formatSseEvent("content_block_stop", {
          type: "content_block_stop",
          index: state.blockIndex,
        })
      )
      state.blockIndex++
      break
    }

    // ── response.completed → message_delta + message_stop ────────
    case "response.completed": {
      const response = event.response as Record<string, unknown>
      const usage = extractResponsesUsage(
        response?.usage as Record<string, unknown>
      )

      let stopReason: string
      const upstreamStopReason = response?.stop_reason as string
      if (state.hasToolCall) {
        stopReason = "tool_use"
      } else if (
        upstreamStopReason === "max_tokens" ||
        upstreamStopReason === "stop"
      ) {
        stopReason = upstreamStopReason
      } else {
        stopReason = "end_turn"
      }

      const messageDelta: Record<string, unknown> = {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
        },
      }
      if (usage.cachedTokens > 0) {
        ;(
          messageDelta.usage as Record<string, unknown>
        ).cache_read_input_tokens = usage.cachedTokens
      }

      results.push(formatSseEvent("message_delta", messageDelta))
      results.push(formatSseEvent("message_stop", { type: "message_stop" }))
      break
    }

    default:
      // Unknown event type, skip
      break
  }

  return results
}

// ── Non-streaming translator ───────────────────────────────────────────

/**
 * Translate a complete Codex response (from response.completed event)
 * into a Claude/Anthropic non-streaming response.
 */
export function translateCodexToClaudeNonStream(
  completedEvent: Record<string, unknown>,
  reverseToolMap: Map<string, string>
): AnthropicResponse | null {
  if (completedEvent.type !== "response.completed") {
    return null
  }

  const response = completedEvent.response as Record<string, unknown>
  if (!response) return null

  const usage = extractResponsesUsage(response.usage as Record<string, unknown>)
  const content: ContentBlock[] = []
  let hasToolCall = false

  const output = response.output as Array<Record<string, unknown>>
  if (Array.isArray(output)) {
    for (const item of output) {
      const itemType = item.type as string

      switch (itemType) {
        case "reasoning": {
          // Extract thinking content from summary
          let thinkingText = ""
          const summary = item.summary as
            | Array<Record<string, unknown>>
            | string
          if (Array.isArray(summary)) {
            for (const part of summary) {
              const text = (part.text as string) || ""
              if (text) thinkingText += text
            }
          } else if (typeof summary === "string") {
            thinkingText = summary
          }

          // Fallback to content if summary is empty
          if (!thinkingText) {
            const reasoningContent = item.content as
              | Array<Record<string, unknown>>
              | string
            if (Array.isArray(reasoningContent)) {
              for (const part of reasoningContent) {
                const text = (part.text as string) || ""
                if (text) thinkingText += text
              }
            } else if (typeof reasoningContent === "string") {
              thinkingText = reasoningContent
            }
          }

          if (thinkingText) {
            content.push({ type: "thinking", thinking: thinkingText })
          }
          break
        }

        case "message": {
          const msgContent = item.content as
            | Array<Record<string, unknown>>
            | string
          if (Array.isArray(msgContent)) {
            for (const part of msgContent) {
              if (part.type === "output_text") {
                const text = (part.text as string) || ""
                if (text) {
                  content.push({ type: "text", text })
                }
              }
            }
          } else if (typeof msgContent === "string" && msgContent) {
            content.push({ type: "text", text: msgContent })
          }
          break
        }

        case "function_call": {
          hasToolCall = true
          let name = (item.name as string) || ""
          const original = reverseToolMap.get(name)
          if (original) name = original

          let input: Record<string, unknown> = {}
          const argsStr = item.arguments as string
          if (argsStr) {
            try {
              const parsed = JSON.parse(argsStr) as Record<string, unknown>
              if (typeof parsed === "object" && parsed !== null) {
                input = parsed
              }
            } catch {
              // Leave input as empty object
            }
          }

          content.push({
            type: "tool_use",
            id: sanitizeClaudeToolId((item.call_id as string) || ""),
            name,
            input,
          })
          break
        }
      }
    }
  }

  // Determine stop reason
  let stopReason: string
  const upstreamStopReason = response.stop_reason as string
  if (
    upstreamStopReason &&
    (upstreamStopReason === "max_tokens" || upstreamStopReason === "stop")
  ) {
    stopReason = upstreamStopReason
  } else if (hasToolCall) {
    stopReason = "tool_use"
  } else {
    stopReason = "end_turn"
  }

  return {
    id: (response.id as string) || "",
    type: "message",
    role: "assistant",
    model: (response.model as string) || "",
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
    },
  }
}
