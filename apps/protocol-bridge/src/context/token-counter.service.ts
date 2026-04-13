import { getTokenizer } from "@anthropic-ai/tokenizer"
import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import type { Tiktoken } from "tiktoken/lite"
import {
  ContentBlock,
  UnifiedMessage,
  isImageBlock,
  isTextBlock,
  isThinkingBlock,
  isToolResultBlock,
  isToolUseBlock,
  normalizeContent,
} from "./types"

/**
 * Token Counter Service
 *
 * Provides accurate token counting for unified messages.
 * Uses tiktoken cl100k_base encoding with Claude correction factor.
 *
 * Key features:
 * - Accurate token counting using tiktoken
 * - Handles both string and array content formats
 * - Handles JSON string content (Cursor client sends content as JSON strings)
 * - Counts tool_use, tool_result, and tool_calls properly
 * - Image token estimation
 */
@Injectable()
export class TokenCounterService implements OnModuleInit {
  private readonly logger = new Logger(TokenCounterService.name)
  private encoder: Tiktoken | null = null

  // Claude tokenizer: exact match — no correction needed
  private readonly CLAUDE_CORRECTION_FACTOR = 1.0

  // Base tokens per message (role, separators, message structure)
  private readonly TOKENS_PER_MESSAGE = 4

  // Image token estimates
  private readonly TOKENS_PER_IMAGE = 128

  // Tool overhead tokens
  private readonly TOKENS_PER_TOOL_CALL = 20
  private readonly TOKENS_PER_TOOL_RESULT = 10

  private safeJsonStringify(value: unknown): string {
    const seen = new WeakSet<object>()

    try {
      return (
        JSON.stringify(value, (_key, currentValue) => {
          if (typeof currentValue === "bigint") {
            return currentValue.toString()
          }
          if (typeof currentValue === "symbol") {
            return currentValue.toString()
          }
          if (typeof currentValue === "function") {
            return `[Function ${(currentValue as { name?: string }).name || "anonymous"}]`
          }
          if (currentValue && typeof currentValue === "object") {
            if (seen.has(currentValue as object)) {
              return "[Circular]"
            }
            seen.add(currentValue as object)
          }
          return currentValue as unknown
        }) || ""
      )
    } catch {
      return ""
    }
  }

  onModuleInit() {
    try {
      this.encoder = getTokenizer()
      this.logger.log(
        "TokenCounter initialized with Claude BPE tokenizer (@anthropic-ai/tokenizer)"
      )
    } catch (error) {
      this.logger.warn(
        `Failed to initialize Claude tokenizer: ${String(error)}. Token counts will be estimated.`
      )
    }
  }

  /**
   * Count tokens in a text string
   */
  countText(text: string, applyCorrection = true): number {
    if (!text) return 0

    let count: number

    if (this.encoder) {
      try {
        const tokens = this.encoder.encode(text)
        count = tokens.length
      } catch (error) {
        this.logger.warn(`Token counting failed: ${String(error)}`)
        // Fallback: estimate ~4 characters per token
        count = Math.ceil(text.length / 4)
      }
    } else {
      // Fallback: estimate ~4 characters per token
      count = Math.ceil(text.length / 4)
    }

    return applyCorrection
      ? Math.ceil(count * this.CLAUDE_CORRECTION_FACTOR)
      : count
  }

  /**
   * Count tokens in a content block
   */
  countContentBlock(block: ContentBlock, applyCorrection = true): number {
    let tokens = 0

    if (isTextBlock(block)) {
      tokens = this.countText(block.text, false)
    } else if (isToolUseBlock(block)) {
      // Tool name + input JSON
      tokens = this.countText(block.name, false)
      tokens += this.countText(JSON.stringify(block.input), false)
      tokens += this.TOKENS_PER_TOOL_CALL
    } else if (isToolResultBlock(block)) {
      // Tool use ID + content
      tokens = this.countText(block.tool_use_id, false)
      let resultTokens = 0
      if (typeof block.content === "string") {
        resultTokens += this.countText(block.content, false)
      } else if (Array.isArray(block.content)) {
        for (const innerBlock of block.content) {
          resultTokens += this.countContentBlock(innerBlock, false)
        }
      }
      const structuredTokens = block.structuredContent
        ? this.countJsonValue(block.structuredContent, false)
        : 0
      tokens += Math.max(resultTokens, structuredTokens)
      tokens += this.TOKENS_PER_TOOL_RESULT
    } else if (isImageBlock(block)) {
      tokens = this.TOKENS_PER_IMAGE
    } else if (isThinkingBlock(block)) {
      tokens = this.countText(block.thinking, false)
    }

    return applyCorrection
      ? Math.ceil(tokens * this.CLAUDE_CORRECTION_FACTOR)
      : tokens
  }

  /**
   * Count tokens in message content (string or array)
   */
  countContent(
    content: string | ContentBlock[],
    applyCorrection = true
  ): number {
    // Normalize to array format (handles JSON string content)
    const blocks = normalizeContent(content)

    let tokens = 0
    for (const block of blocks) {
      tokens += this.countContentBlock(block, false)
    }

    return applyCorrection
      ? Math.ceil(tokens * this.CLAUDE_CORRECTION_FACTOR)
      : tokens
  }

  /**
   * Count tokens in a single unified message
   */
  countMessage(message: UnifiedMessage, applyCorrection = true): number {
    let tokens = this.TOKENS_PER_MESSAGE

    // Role token
    tokens += this.countText(message.role, false)

    // Content tokens
    tokens += this.countContent(message.content, false)

    // Function-call style tool_calls (assistant messages)
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        tokens += this.countText(toolCall.id, false)
        tokens += this.countText(toolCall.function.name, false)
        tokens += this.countText(toolCall.function.arguments, false)
        tokens += this.TOKENS_PER_TOOL_CALL
      }
    }

    // Function-call style tool_call_id (tool role messages)
    if (message.tool_call_id) {
      tokens += this.countText(message.tool_call_id, false)
    }

    return applyCorrection
      ? Math.ceil(tokens * this.CLAUDE_CORRECTION_FACTOR)
      : tokens
  }

  /**
   * Count tokens in multiple messages
   */
  countMessages(messages: UnifiedMessage[], applyCorrection = true): number {
    let tokens = 0

    for (const message of messages) {
      tokens += this.countMessage(message, false)
    }

    // Add tokens for message list overhead
    tokens += 3

    return applyCorrection
      ? Math.ceil(tokens * this.CLAUDE_CORRECTION_FACTOR)
      : tokens
  }

  /**
   * Count tokens in tool definitions
   */
  countToolDefinitions(
    tools: Array<{
      type?: string
      name?: string
      description?: string
      input_schema?: Record<string, unknown>
      function?: {
        name: string
        description?: string
        parameters?: Record<string, unknown>
      }
    }>,
    applyCorrection = true
  ): number {
    if (!tools || tools.length === 0) return 0

    let tokens = 0

    for (const tool of tools) {
      // Anthropic format
      if (tool.name) {
        tokens += this.countText(tool.name, false)
        if (tool.description) {
          tokens += this.countText(tool.description, false)
        }
        if (tool.input_schema) {
          tokens += this.countText(JSON.stringify(tool.input_schema), false)
        }
        tokens += 10 // overhead per tool
      }
      // Function-call style format
      else if (tool.function) {
        tokens += this.countText(tool.function.name, false)
        if (tool.function.description) {
          tokens += this.countText(tool.function.description, false)
        }
        if (tool.function.parameters) {
          tokens += this.countText(
            JSON.stringify(tool.function.parameters),
            false
          )
        }
        tokens += 10 // overhead per tool
      }
    }

    return applyCorrection
      ? Math.ceil(tokens * this.CLAUDE_CORRECTION_FACTOR)
      : tokens
  }

  /**
   * Estimate total request tokens
   */
  estimateRequestTokens(
    messages: UnifiedMessage[],
    tools?: Array<{
      type?: string
      name?: string
      description?: string
      input_schema?: Record<string, unknown>
      function?: {
        name: string
        description?: string
        parameters?: Record<string, unknown>
      }
    }>,
    systemPrompt?: string
  ): number {
    let total = this.countMessages(messages)

    if (tools) {
      total += this.countToolDefinitions(tools)
    }

    if (systemPrompt) {
      total += this.countText(systemPrompt)
    }

    return total
  }

  /**
   * Count tokens for a serialized JSON value.
   * Useful for tool definitions, function call args, etc.
   */
  countJsonValue(value: unknown, applyCorrection = true): number {
    const json = this.safeJsonStringify(value)
    return json ? this.countText(json, applyCorrection) : 0
  }

  /**
   * Estimate token count for a complete Google Cloud Code payload.
   *
   * Traverses the final Google-format request structure:
   * - systemInstruction.parts[].text
   * - contents[].parts[] (text, functionCall, functionResponse)
   * - tools (serialized)
   *
   * This is the single source of truth for "how many tokens will this
   * request cost?" and should be called right before sending.
   */
  countGooglePayloadTokens(payload: {
    request?: {
      systemInstruction?: { parts?: Array<{ text?: string }> }
      contents?: Array<{
        role?: string
        parts?: Array<Record<string, unknown>>
      }>
      tools?: unknown
      [key: string]: unknown
    }
    [key: string]: unknown
  }): number {
    const request = payload?.request
    if (!request) return 0

    let rawTokens = 0

    // 1. systemInstruction
    const sysParts = request.systemInstruction?.parts
    if (Array.isArray(sysParts)) {
      for (const part of sysParts) {
        if (part?.text) {
          rawTokens += this.countText(part.text, false)
        }
      }
    }

    // 2. contents (conversation history)
    const contents = request.contents
    if (Array.isArray(contents)) {
      for (const msg of contents) {
        if (!msg?.parts || !Array.isArray(msg.parts)) continue
        // role overhead
        rawTokens += this.TOKENS_PER_MESSAGE

        for (const part of msg.parts) {
          if (!part || typeof part !== "object") continue

          if ("text" in part && typeof part.text === "string") {
            rawTokens += this.countText(part.text, false)
          }
          if ("functionCall" in part && part.functionCall) {
            const fc = part.functionCall as {
              name?: string
              args?: unknown
            }
            if (fc.name) rawTokens += this.countText(fc.name, false)
            if (fc.args) {
              rawTokens += this.countJsonValue(fc.args, false)
            }
            rawTokens += this.TOKENS_PER_TOOL_CALL
          }
          if ("functionResponse" in part && part.functionResponse) {
            const fr = part.functionResponse as {
              name?: string
              response?: unknown
            }
            if (fr.name) rawTokens += this.countText(fr.name, false)
            if (fr.response) {
              rawTokens += this.countJsonValue(fr.response, false)
            }
            rawTokens += this.TOKENS_PER_TOOL_RESULT
          }
          if ("inlineData" in part) {
            // Images: flat estimate
            rawTokens += this.TOKENS_PER_IMAGE
          }
        }
      }
    }

    // 3. tools (tool declarations)
    if (request.tools) {
      rawTokens += this.countJsonValue(request.tools, false)
    }

    // Claude tokenizer: exact count, no correction needed
    return rawTokens
  }

  /**
   * Check if messages exceed token limit
   */
  exceedsLimit(messages: UnifiedMessage[], maxTokens: number): boolean {
    return this.countMessages(messages) > maxTokens
  }

  /**
   * Find the index where accumulated tokens from the end exceeds target
   * Returns the index of the first message to include to stay under target tokens
   */
  findTruncationIndex(
    messages: UnifiedMessage[],
    targetTokens: number
  ): number {
    let accumulatedTokens = 0

    // Iterate from the end
    for (let i = messages.length - 1; i >= 0; i--) {
      const messageTokens = this.countMessage(messages[i]!)
      accumulatedTokens += messageTokens

      if (accumulatedTokens > targetTokens) {
        // This message pushes us over the limit
        // Return the next index (exclude this message)
        return i + 1
      }
    }

    // All messages fit within target
    return 0
  }
}
