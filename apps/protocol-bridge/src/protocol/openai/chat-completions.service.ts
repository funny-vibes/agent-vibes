import { GptRequestError } from "../../llm/shared/gpt-api-contract"
import {
  CodexResponsesService,
  type CodexResponsesContext,
} from "./codex-responses.service"
import { Injectable, Logger } from "@nestjs/common"
import { MessagesService } from "../anthropic/messages.service"
import type { AnthropicResponse } from "../../shared/anthropic"
import {
  translateOpenAiChatToCreateMessage,
  translateOpenAiCompletionToCreateMessage,
  translateOpenAiResponseToCreateMessage,
} from "./openai-request-translator"
import {
  OpenAiChatStreamTranslator,
  OpenAiCompletionStreamTranslator,
  OpenAiResponsesStreamTranslator,
  translateAnthropicToOpenAiChat,
  translateAnthropicToOpenAiCompletion,
  translateAnthropicToOpenAiResponse,
} from "./openai-response-translator"
import type {
  OpenAiChatCompletionRequest,
  OpenAiChatCompletionResponse,
  OpenAiCompletionRequest,
  OpenAiCompletionResponse,
  OpenAiResponsesRequest,
  OpenAiResponsesResponse,
} from "./openai-types"

/**
 * ChatCompletionsService — orchestrates the OpenAI-compatible inbound
 * surface by reusing the canonical MessagesService router.
 *
 * Flow:
 *   OpenAI request → translate to CreateMessageDto (Anthropic IR)
 *   → MessagesService.createMessage / createMessageStream (backend routing)
 *   → translate Anthropic response / SSE back to OpenAI shape.
 *
 * No backend-specific logic lives here: model routing, account pooling,
 * error taxonomy, and usage accounting are all inherited from
 * MessagesService unchanged.
 */
@Injectable()
export class ChatCompletionsService {
  private readonly logger = new Logger(ChatCompletionsService.name)

  constructor(
    private readonly messagesService: MessagesService,
    private readonly codexResponses: CodexResponsesService
  ) {}

  // ── Chat Completions ──────────────────────────────────────────────────

  async createChatCompletion(
    req: OpenAiChatCompletionRequest
  ): Promise<OpenAiChatCompletionResponse> {
    const dto = translateOpenAiChatToCreateMessage(req)
    dto.stream = false
    const response: AnthropicResponse =
      await this.messagesService.createMessage(
        dto,
        undefined,
        undefined,
        req.provider === "codex" ? "codex" : undefined
      )
    const created = Math.floor(Date.now() / 1000)
    return translateAnthropicToOpenAiChat(response, req.model, created)
  }

  /**
   * Stream an OpenAI chat.completion.chunk SSE sequence.
   *
   * Consumes the canonical Anthropic SSE strings emitted by
   * MessagesService.createMessageStream and re-frames them into OpenAI
   * chunk frames via OpenAiChatStreamTranslator. Errors raised mid-stream
   * propagate to the controller, which renders an OpenAI error frame.
   */
  async *createChatCompletionStream(
    req: OpenAiChatCompletionRequest
  ): AsyncGenerator<string, void, unknown> {
    const dto = translateOpenAiChatToCreateMessage(req)
    dto.stream = true

    const translator = new OpenAiChatStreamTranslator({
      id: `chatcmpl-${this.randomId()}`,
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      includeUsage: req.stream_options?.include_usage === true,
    })

    const upstream = this.messagesService.createMessageStream(
      dto,
      undefined,
      undefined,
      req.provider === "codex" ? "codex" : undefined
    )
    for await (const chunk of upstream) {
      for (const frame of translator.push(chunk)) {
        yield frame
      }
    }
    for (const frame of translator.finish()) {
      yield frame
    }
  }

  // ── Responses API ─────────────────────────────────────────────────────

  async createResponse(
    req: OpenAiResponsesRequest,
    context: CodexResponsesContext = { owner: "local" }
  ): Promise<OpenAiResponsesResponse | Record<string, unknown>> {
    if (req.provider === "codex" && !this.codexResponses.usesCodex(req.model)) {
      throw new GptRequestError(
        "The model is not available through provider: codex",
        "model"
      )
    }
    if (this.codexResponses.usesCodex(req.model))
      return this.codexResponses.create(req, context)
    const dto = translateOpenAiResponseToCreateMessage(req)
    dto.stream = false
    const response: AnthropicResponse =
      await this.messagesService.createMessage(dto)
    return translateAnthropicToOpenAiResponse(
      response,
      req,
      Math.floor(Date.now() / 1000)
    )
  }

  async *createResponseStream(
    req: OpenAiResponsesRequest,
    context: CodexResponsesContext = { owner: "local" }
  ): AsyncGenerator<string, void, unknown> {
    if (req.provider === "codex" && !this.codexResponses.usesCodex(req.model)) {
      throw new GptRequestError(
        "The model is not available through provider: codex",
        "model"
      )
    }
    if (this.codexResponses.usesCodex(req.model)) {
      yield* this.codexResponses.stream(req, context)
      return
    }
    const dto = translateOpenAiResponseToCreateMessage(req)
    dto.stream = true
    const translator = new OpenAiResponsesStreamTranslator({
      id: `resp_${this.randomId()}`,
      createdAt: Math.floor(Date.now() / 1000),
      request: req,
    })

    for (const frame of translator.start()) {
      yield frame
    }
    const upstream = this.messagesService.createMessageStream(dto)
    for await (const chunk of upstream) {
      for (const frame of translator.push(chunk)) {
        yield frame
      }
    }
    for (const frame of translator.finish()) {
      yield frame
    }
  }

  // ── Legacy Completions ────────────────────────────────────────────────

  async createCompletion(
    req: OpenAiCompletionRequest
  ): Promise<OpenAiCompletionResponse> {
    const dto = translateOpenAiCompletionToCreateMessage(req)
    dto.stream = false
    const response = await this.messagesService.createMessage(dto)
    const created = Math.floor(Date.now() / 1000)
    return translateAnthropicToOpenAiCompletion(response, req.model, created)
  }

  /**
   * Stream a legacy text-completion SSE sequence (`text_completion` chunks).
   */
  async *createCompletionStream(
    req: OpenAiCompletionRequest
  ): AsyncGenerator<string, void, unknown> {
    const dto = translateOpenAiCompletionToCreateMessage(req)
    dto.stream = true

    const translator = new OpenAiCompletionStreamTranslator({
      id: `cmpl-${this.randomId()}`,
      created: Math.floor(Date.now() / 1000),
      model: req.model,
    })

    const upstream = this.messagesService.createMessageStream(dto)
    for await (const chunk of upstream) {
      for (const frame of translator.push(chunk)) {
        yield frame
      }
    }
    for (const frame of translator.finish()) {
      yield frame
    }
  }

  private randomId(): string {
    return Math.random().toString(36).slice(2, 12)
  }
}
