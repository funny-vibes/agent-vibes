import { ExplicitWebProviderGuard } from "../../shared/explicit-web-provider.guard"
import {
  GptRequestError,
  readGptProvider,
  resolveGptHistoryPolicy,
} from "../../llm/shared/gpt-api-contract"
import { once } from "node:events"
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Post,
  Res,
  Req,
  UseGuards,
} from "@nestjs/common"
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger"
import type { FastifyReply, FastifyRequest } from "fastify"
import { ApiKeyGuard } from "../../shared/api-key.guard"
import { ChatCompletionsService } from "./chat-completions.service"
import { ChatGptWebProtocolService } from "./chatgpt-web.service"
import { RequiredApiKeyGuard } from "../../shared/required-api-key.guard"
import { renderOpenAiError } from "./openai-error"
import type {
  OpenAiChatCompletionRequest,
  OpenAiCompletionRequest,
  OpenAiResponsesRequest,
} from "./openai-types"

/**
 * OpenAI-compatible inbound endpoints.
 *
 * Exposes the standard OpenAI surface so any OpenAI SDK pointed at this
 * bridge (baseURL = http://host:port/v1) works unchanged:
 *   - POST /v1/chat/completions
 *   - POST /v1/responses
 *   - POST /v1/completions      (legacy text completion)
 *
 * Model listing (GET /v1/models) is served by the Anthropic MessagesController
 * which already registers that route; its payload carries OpenAI-compatible
 * `object`/`created`/`owned_by` fields, so a single endpoint satisfies both
 * protocol surfaces and avoids a Fastify duplicate-route error.
 *
 * Auth reuses ApiKeyGuard: `Authorization: Bearer <PROXY_API_KEY>` (the OpenAI
 * SDK default) or `x-api-key`. When PROXY_API_KEY is unset, all requests pass
 * (local development).
 */
@ApiTags("OpenAI API")
@Controller("v1")
@UseGuards(ApiKeyGuard, ExplicitWebProviderGuard)
@ApiSecurity("api-key")
export class ChatCompletionsController {
  constructor(
    private readonly chatCompletionsService: ChatCompletionsService,
    private readonly chatGptWeb: ChatGptWebProtocolService
  ) {}

  private validateProvider(
    body: Record<string, unknown>,
    fixedWeb = false
  ): "codex" | "chatgpt-web" | undefined {
    try {
      const provider = readGptProvider(body.provider)
      if (fixedWeb && provider && provider !== "chatgpt-web") {
        throw new GptRequestError(
          "This route requires provider: chatgpt-web",
          "provider"
        )
      }
      resolveGptHistoryPolicy(body, false)
      return provider
    } catch (error) {
      const rendered = renderOpenAiError(error)
      throw new HttpException(rendered.body, rendered.status)
    }
  }

  private buildMissingModelError(): HttpException {
    return new HttpException(
      {
        error: {
          message: "you must provide a model parameter",
          type: "invalid_request_error",
          param: "model",
          code: null,
        },
      },
      400
    )
  }

  @Post("chat/completions")
  @HttpCode(200)
  @ApiOperation({ summary: "Create a chat completion (OpenAI API)" })
  async createChatCompletion(
    // Accept the raw plain body: the SEA esbuild bundle does not preserve the
    // reflect-metadata that ValidationPipe needs, so DTO transforms would
    // strip every field. Required fields are validated downstream. This
    // matches the Anthropic MessagesController approach.
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res?: FastifyReply
  ) {
    const provider = this.validateProvider(body)
    if (provider === "chatgpt-web")
      return this.createWebGptChatCompletion(body, res)
    if (provider) res?.header("X-Agent-Vibes-Provider", provider)
    const req = body as unknown as OpenAiChatCompletionRequest
    if (typeof req?.model !== "string" || req.model.trim() === "") {
      throw this.buildMissingModelError()
    }

    if (req.stream && res) {
      await this.streamResponse(
        res,
        this.chatCompletionsService.createChatCompletionStream(req)
      )
      return
    }

    try {
      return await this.chatCompletionsService.createChatCompletion(req)
    } catch (error) {
      const rendered = renderOpenAiError(error)
      if (res && rendered.retryAfterSeconds != null) {
        res.header("Retry-After", String(rendered.retryAfterSeconds))
      }
      throw new HttpException(rendered.body, rendered.status)
    }
  }

  @Post("responses")
  @HttpCode(200)
  @ApiOperation({ summary: "Create a response (OpenAI Responses API)" })
  async createResponse(
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res?: FastifyReply,
    @Req() httpRequest?: FastifyRequest
  ) {
    const provider = this.validateProvider(body)
    if (provider === "chatgpt-web") return this.createWebGptResponse(body, res)
    if (provider) res?.header("X-Agent-Vibes-Provider", provider)
    const req = body as unknown as OpenAiResponsesRequest
    if (typeof req?.model !== "string" || req.model.trim() === "") {
      throw this.buildMissingModelError()
    }
    if (req.input == null) {
      throw new HttpException(
        {
          error: {
            message: "you must provide an input parameter",
            type: "invalid_request_error",
            param: "input",
            code: null,
          },
        },
        400
      )
    }

    const controller = new AbortController()
    const onClose = () => {
      if (!res?.raw.writableEnded) controller.abort()
    }
    res?.raw.once("close", onClose)
    const headers = httpRequest?.headers
    const credential =
      headers?.["x-api-key"] ??
      headers?.authorization?.replace(/^Bearer\s+/i, "") ??
      headers?.["x-goog-api-key"] ??
      "local"
    const context = {
      owner: Array.isArray(credential) ? credential[0]! : credential,
      signal: controller.signal,
    }
    if (req.stream && res) {
      await this.streamResponse(
        res,
        this.chatCompletionsService.createResponseStream(req, context),
        controller,
        "responses"
      )
      res.raw.off("close", onClose)
      return
    }

    try {
      return await this.chatCompletionsService.createResponse(req, context)
    } catch (error) {
      const rendered = renderOpenAiError(error)
      if (res && rendered.retryAfterSeconds != null) {
        res.header("Retry-After", String(rendered.retryAfterSeconds))
      }
      throw new HttpException(rendered.body, rendered.status)
    } finally {
      res?.raw.off("close", onClose)
    }
  }

  /**
   * ChatGPT Web routes.
   *
   * These deliberately bypass the model router: they always target
   * chatgpt.com's web chat backend, which draws on a different quota than the
   * Codex-backed `/v1/*` routes and reaches models Codex does not expose.
   *
   * Each one carries RequiredApiKeyGuard on top of the controller's
   * ApiKeyGuard. The class-level guard lets requests through when
   * PROXY_API_KEY is unset so local development stays frictionless, but these
   * routes spend a real ChatGPT account's quota, so they follow the Realtime
   * endpoint's rule instead: no API key configured means 503, never anonymous
   * access. Adding the guard per method leaves `/v1/chat/completions` and the
   * other shared routes on the relaxed behavior.
   */
  @Post("web-gpt/responses")
  @UseGuards(RequiredApiKeyGuard)
  @HttpCode(200)
  @ApiOperation({ summary: "Create a response via the ChatGPT Web backend" })
  async createWebGptResponse(
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res?: FastifyReply
  ) {
    this.validateProvider(body, true)
    res?.header("X-Agent-Vibes-Provider", "chatgpt-web")
    const req = body as unknown as OpenAiResponsesRequest
    if (typeof req?.model !== "string" || req.model.trim() === "") {
      throw this.buildMissingModelError()
    }
    if (req.input == null) {
      throw new HttpException(
        {
          error: {
            message: "you must provide an input parameter",
            type: "invalid_request_error",
            param: "input",
            code: null,
          },
        },
        400
      )
    }

    const controller = new AbortController()
    const onClose = () => {
      if (!res?.raw.writableEnded) controller.abort()
    }
    res?.raw.once("close", onClose)

    if (req.stream && res) {
      await this.streamResponse(
        res,
        this.chatGptWeb.createResponseStream(req, controller.signal),
        controller,
        "responses"
      )
      res.raw.off("close", onClose)
      return
    }

    try {
      return await this.chatGptWeb.createResponse(req)
    } catch (error) {
      const rendered = renderOpenAiError(error)
      throw new HttpException(rendered.body, rendered.status)
    } finally {
      res?.raw.off("close", onClose)
    }
  }

  @Post("web-gpt/chat/completions")
  @UseGuards(RequiredApiKeyGuard)
  @HttpCode(200)
  @ApiOperation({
    summary: "Create a chat completion via the ChatGPT Web backend",
  })
  async createWebGptChatCompletion(
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res?: FastifyReply
  ) {
    this.validateProvider(body, true)
    res?.header("X-Agent-Vibes-Provider", "chatgpt-web")
    const req = body as unknown as OpenAiChatCompletionRequest
    if (typeof req?.model !== "string" || req.model.trim() === "") {
      throw this.buildMissingModelError()
    }

    if (req.stream && res) {
      await this.streamResponse(
        res,
        this.chatGptWeb.createChatCompletionStream(req)
      )
      return
    }

    try {
      return await this.chatGptWeb.createChatCompletion(req)
    } catch (error) {
      const rendered = renderOpenAiError(error)
      throw new HttpException(rendered.body, rendered.status)
    }
  }

  @Get("web-gpt/models")
  @UseGuards(RequiredApiKeyGuard)
  @ApiOperation({ summary: "List models offered by the ChatGPT Web backend" })
  async listWebGptModels() {
    try {
      const slugs = await this.chatGptWeb.listModelSlugs()
      return {
        object: "list",
        data: slugs.map((slug) => ({
          id: slug,
          object: "model",
          created: Math.floor(Date.now() / 1_000),
          owned_by: "openai",
        })),
      }
    } catch (error) {
      const rendered = renderOpenAiError(error)
      throw new HttpException(rendered.body, rendered.status)
    }
  }

  @Post("completions")
  @HttpCode(200)
  @ApiOperation({ summary: "Create a completion (OpenAI legacy API)" })
  async createCompletion(
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res?: FastifyReply
  ) {
    const req = body as unknown as OpenAiCompletionRequest
    if (typeof req?.model !== "string" || req.model.trim() === "") {
      throw this.buildMissingModelError()
    }
    if (req.prompt == null) {
      throw new HttpException(
        {
          error: {
            message: "you must provide a prompt parameter",
            type: "invalid_request_error",
            param: "prompt",
            code: null,
          },
        },
        400
      )
    }

    if (req.stream && res) {
      await this.streamResponse(
        res,
        this.chatCompletionsService.createCompletionStream(req)
      )
      return
    }

    try {
      return await this.chatCompletionsService.createCompletion(req)
    } catch (error) {
      const rendered = renderOpenAiError(error)
      if (res && rendered.retryAfterSeconds != null) {
        res.header("Retry-After", String(rendered.retryAfterSeconds))
      }
      throw new HttpException(rendered.body, rendered.status)
    }
  }

  /**
   * Pump an OpenAI SSE generator to the client. Mirrors the streaming error
   * contract of the Anthropic controller: pre-stream failures set the HTTP
   * status, mid-stream failures emit a terminal SSE error frame.
   */
  private async streamResponse(
    res: FastifyReply,
    stream: AsyncGenerator<string, void, unknown>,
    abortController?: AbortController,
    protocol?: "responses"
  ): Promise<void> {
    let headersWritten = false
    const ensureHeaders = () => {
      if (headersWritten) return
      res.header("Content-Type", "text/event-stream")
      res.header("Cache-Control", "no-cache")
      res.header("Connection", "keep-alive")
      for (const [name, value] of Object.entries(res.getHeaders())) {
        if (value !== undefined) res.raw.setHeader(name, value)
      }
      res.raw.writeHead(res.statusCode)
      res.hijack()
      headersWritten = true
    }

    try {
      for await (const chunk of stream) {
        ensureHeaders()
        if (res.raw.destroyed) break
        if (!res.raw.write(chunk))
          await once(res.raw, "drain", { signal: abortController?.signal })
      }
    } catch (error) {
      if (abortController?.signal.aborted || res.raw.destroyed) return
      const rendered = renderOpenAiError(error)
      if (!headersWritten) {
        res.status(rendered.status)
        if (rendered.retryAfterSeconds != null)
          res.header("Retry-After", String(rendered.retryAfterSeconds))
        res.send(rendered.body)
        return
      }
      res.raw.write(
        protocol === "responses"
          ? `event: error\ndata: ${JSON.stringify({ ...rendered.body.error, type: "error" })}\n\n`
          : `data: ${JSON.stringify(rendered.body)}\n\n`
      )
    } finally {
      if (!res.raw.destroyed && (headersWritten || !res.sent)) {
        ensureHeaders()
        res.raw.end()
      }
    }
  }
}
