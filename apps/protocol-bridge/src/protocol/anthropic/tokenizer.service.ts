import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { Tiktoken, encoding_for_model } from "tiktoken"

/**
 * Local token count estimator for Anthropic's /count_tokens fallback path.
 *
 * Uses cl100k_base as an approximation when upstream count_tokens
 * is unavailable or fails.
 */
@Injectable()
export class TokenizerService implements OnModuleInit {
  private readonly logger = new Logger(TokenizerService.name)
  private encoder: Tiktoken | null = null

  // Claude typically uses ~15% more tokens than GPT-4 for the same text
  private readonly CLAUDE_CORRECTION_FACTOR = 1.15

  onModuleInit() {
    try {
      // Use cl100k_base encoding (GPT-4 compatible, close to Claude)
      this.encoder = encoding_for_model("gpt-4")
      this.logger.log("Tokenizer initialized with cl100k_base encoding")
    } catch (error) {
      this.logger.warn(
        `Failed to initialize tokenizer: ${String(error)}. Token counts will be estimated.`
      )
    }
  }

  countTokens(text: string, applyCorrection = true): number {
    if (!text) return 0

    if (this.encoder) {
      try {
        const tokens = this.encoder.encode(text)
        const count = tokens.length
        return applyCorrection
          ? Math.ceil(count * this.CLAUDE_CORRECTION_FACTOR)
          : count
      } catch (error) {
        this.logger.warn(`Token counting failed: ${String(error)}`)
      }
    }

    const estimated = Math.ceil(text.length / 4)
    return applyCorrection
      ? Math.ceil(estimated * this.CLAUDE_CORRECTION_FACTOR)
      : estimated
  }

  countMessageTokens(
    messages: Array<{
      role: string
      content?: string | Array<Record<string, unknown>> | null
      name?: string
    }>,
    applyCorrection = true
  ): number {
    let totalTokens = 0

    for (const message of messages) {
      totalTokens += 4
      totalTokens += this.countTokens(message.role, false)

      if (message.content) {
        if (typeof message.content === "string") {
          totalTokens += this.countTokens(message.content, false)
        } else if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part.type === "text" && typeof part.text === "string") {
              totalTokens += this.countTokens(part.text, false)
            } else if (part.type === "image_url" || part.type === "image") {
              totalTokens += 128
            }
          }
        }
      }

      if (message.name) {
        totalTokens += this.countTokens(message.name, false)
        totalTokens += 1
      }
    }

    totalTokens += 3

    return applyCorrection
      ? Math.ceil(totalTokens * this.CLAUDE_CORRECTION_FACTOR)
      : totalTokens
  }

  countToolTokens(
    tools: Array<{
      type?: string
      function?: {
        name: string
        description?: string
        parameters?: Record<string, unknown>
      }
    }>,
    applyCorrection = true
  ): number {
    if (!tools || tools.length === 0) return 0

    let totalTokens = 0

    for (const tool of tools) {
      if (tool.type === "function" && tool.function) {
        totalTokens += this.countTokens(tool.function.name, false)

        if (tool.function.description) {
          totalTokens += this.countTokens(tool.function.description, false)
        }

        if (tool.function.parameters) {
          const paramsJson = JSON.stringify(tool.function.parameters)
          totalTokens += this.countTokens(paramsJson, false)
        }

        totalTokens += 10
      }
    }

    return applyCorrection
      ? Math.ceil(totalTokens * this.CLAUDE_CORRECTION_FACTOR)
      : totalTokens
  }

  estimateRequestTokens(
    messages: Array<{
      role: string
      content?: string | Array<Record<string, unknown>> | null
    }>,
    tools?: Array<{
      type?: string
      function?: {
        name: string
        description?: string
        parameters?: Record<string, unknown>
      }
    }>,
    systemPrompt?: string
  ): number {
    let total = this.countMessageTokens(messages)

    if (tools) {
      total += this.countToolTokens(tools)
    }

    if (systemPrompt) {
      total += this.countTokens(systemPrompt)
    }

    return total
  }
}
