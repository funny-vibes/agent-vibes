import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpCode,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common"
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from "@nestjs/swagger"
import type { FastifyReply } from "fastify"
import { ApiKeyGuard } from "../../shared/api-key.guard"
import { CountTokensDto } from "./dto/count-tokens.dto"
import { CreateMessageDto } from "./dto/create-message.dto"
import { MessagesService } from "./messages.service"

@ApiTags("Anthropic API")
@Controller("v1")
@UseGuards(ApiKeyGuard)
@ApiSecurity("api-key")
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  private pickHeaders(
    allowedHeaders: string[],
    headers?: Record<string, string | string[] | undefined>
  ): Record<string, string> {
    if (!headers) return {}

    const out: Record<string, string> = {}
    for (const key of allowedHeaders) {
      const value = headers[key]
      if (typeof value === "string" && value.trim() !== "") {
        out[key] = value.trim()
      } else if (Array.isArray(value) && value.length > 0) {
        const merged = value
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
          .join(",")
        if (merged) {
          out[key] = merged
        }
      }
    }

    return out
  }

  private pickAnthropicForwardHeaders(
    headers?: Record<string, string | string[] | undefined>
  ): Record<string, string> {
    return this.pickHeaders(
      [
        "anthropic-version",
        "anthropic-beta",
        "anthropic-dangerous-direct-browser-access",
        "x-app",
        "x-stainless-retry-count",
        "x-stainless-runtime",
        "x-stainless-lang",
        "x-stainless-timeout",
        "x-cpa-claude-1m",
        "user-agent",
      ],
      headers
    )
  }

  private pickCodexForwardHeaders(
    headers?: Record<string, string | string[] | undefined>
  ): Record<string, string> {
    return this.pickHeaders(
      [
        "originator",
        "version",
        "user-agent",
        "openai-beta",
        "x-codex-beta-features",
        "x-codex-turn-state",
        "x-codex-turn-metadata",
        "x-client-request-id",
        "x-responsesapi-include-timing-metrics",
        "session_id",
        "session-id",
      ],
      headers
    )
  }

  private getRetryAfterSeconds(error: unknown): number | null {
    const retryAfterSeconds = (
      error as { retryAfterSeconds?: unknown } | null | undefined
    )?.retryAfterSeconds

    return typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
      ? retryAfterSeconds
      : null
  }

  private buildStreamErrorPayload(error: unknown): {
    type: string
    error: { type: string; message: string }
  } {
    if (error instanceof HttpException) {
      const response = error.getResponse()
      let message = error.message
      if (typeof response === "string") {
        message = response
      } else if (
        response &&
        typeof response === "object" &&
        typeof (response as { message?: unknown }).message === "string"
      ) {
        message = (response as { message: string }).message
      }
      return {
        type: "error",
        error: {
          type: "api_error",
          message,
        },
      }
    }

    return {
      type: "error",
      error: {
        type: "api_error",
        message:
          error instanceof Error
            ? error.message
            : "Streaming request failed unexpectedly",
      },
    }
  }

  @Post("messages")
  @HttpCode(200)
  @ApiOperation({ summary: "Create a message (Anthropic Messages API)" })
  @ApiHeader({ name: "x-api-key", description: "API Key", required: false })
  @ApiHeader({
    name: "anthropic-version",
    description: "API Version",
    required: false,
  })
  @ApiBody({ type: CreateMessageDto })
  async createMessage(
    @Body() createMessageDto: CreateMessageDto,
    @Headers("x-api-key") apiKey?: string,
    @Headers("anthropic-version") version?: string,
    @Headers()
    headers?: Record<string, string | string[] | undefined>,
    @Res({ passthrough: true }) res?: FastifyReply
  ) {
    void apiKey
    void version
    const forwardHeaders = this.pickAnthropicForwardHeaders(headers)
    const codexForwardHeaders = this.pickCodexForwardHeaders(headers)

    // Handle streaming mode
    if (createMessageDto.stream && res) {
      const stream = this.messagesService.createMessageStream(
        createMessageDto,
        forwardHeaders,
        codexForwardHeaders
      )
      let headersWritten = false
      const ensureHeaders = () => {
        if (headersWritten) return
        res.header("Content-Type", "text/event-stream")
        res.header("Cache-Control", "no-cache")
        res.header("Connection", "keep-alive")
        headersWritten = true
      }

      try {
        for await (const chunk of stream) {
          ensureHeaders()
          res.raw.write(chunk)
        }
      } catch (error) {
        if (!headersWritten && error instanceof HttpException) {
          res.status(error.getStatus())
        }
        const retryAfterSeconds = this.getRetryAfterSeconds(error)
        if (retryAfterSeconds != null) {
          res.header("Retry-After", String(retryAfterSeconds))
        }
        ensureHeaders()
        const payload = this.buildStreamErrorPayload(error)
        res.raw.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`)
      } finally {
        res.raw.end()
      }
      return
    }

    // Non-streaming mode
    try {
      return await this.messagesService.createMessage(
        createMessageDto,
        forwardHeaders,
        codexForwardHeaders
      )
    } catch (error) {
      const retryAfterSeconds = this.getRetryAfterSeconds(error)
      if (res && retryAfterSeconds != null) {
        res.header("Retry-After", String(retryAfterSeconds))
      }
      throw error
    }
  }

  @Post("messages/count_tokens")
  @HttpCode(200)
  @ApiOperation({ summary: "Count tokens in a message (Anthropic API)" })
  @ApiHeader({ name: "x-api-key", description: "API Key", required: false })
  @ApiHeader({
    name: "anthropic-version",
    description: "API Version",
    required: false,
  })
  @ApiBody({ type: CountTokensDto })
  countTokens(@Body() countTokensDto: CountTokensDto) {
    return this.messagesService.countTokens(countTokensDto)
  }

  @Get("anthropic/models")
  @ApiOperation({ summary: "List available models (Anthropic format)" })
  listModels() {
    return this.messagesService.listModels()
  }

  @Get("models")
  @ApiOperation({ summary: "List available models (Anthropic-compatible)" })
  listAnthropicModels() {
    return this.messagesService.listModels()
  }
}
