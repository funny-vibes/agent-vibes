import { RealtimeCallStore } from "./realtime-call-store"
import { renderOpenAiError, openAiErrorTypeFromStatus } from "./openai-error"
import { GptRequestError } from "../../llm/shared/gpt-api-contract"
import {
  Body,
  Delete,
  Patch,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common"
import {
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiProduces,
  ApiSecurity,
  ApiTags,
} from "@nestjs/swagger"
import type { FastifyReply, FastifyRequest } from "fastify"
import {
  ChatGptWebRealtimeService,
  ChatGptWebRealtimeServiceError,
} from "../../llm/openai/chatgpt-web-realtime.service"
import {
  ChatGptWebRealtimeRequestError,
  parseChatGptWebRealtimeCallRequest,
} from "../../llm/openai/chatgpt-web-realtime"
import {
  ChatGptWebConversationService,
  ChatGptWebError,
} from "../../llm/openai/chatgpt-web-conversation.service"
import { CodexVoiceCallService } from "../../llm/openai/codex-voice-call.service"
import { RequiredApiKeyGuard } from "../../shared/required-api-key.guard"

function openAiError(
  status: number,
  message: string,
  code: string | null,
  param: string | null = null
): HttpException {
  return new HttpException(
    {
      error: {
        message,
        type: openAiErrorTypeFromStatus(status),
        param,
        code,
      },
    },
    status
  )
}

@ApiTags("OpenAI API")
@Controller("v1/realtime")
@UseGuards(RequiredApiKeyGuard)
@ApiSecurity("api-key")
export class RealtimeController {
  constructor(
    private readonly realtime: ChatGptWebRealtimeService,
    private readonly codexVoice: CodexVoiceCallService,
    private readonly conversations: ChatGptWebConversationService,
    private readonly calls: RealtimeCallStore
  ) {}

  @Post("calls")
  @HttpCode(201)
  @ApiConsumes(
    "multipart/form-data",
    "application/sdp",
    "text/plain",
    "application/json"
  )
  @ApiHeader({
    name: "X-Agent-Vibes-Provider",
    required: false,
    description: "Provider for SDP-only requests; defaults to chatgpt-web",
    enum: ["codex", "chatgpt-web"],
  })
  @ApiHeader({
    name: "X-Agent-Vibes-History-Policy",
    required: false,
    description:
      "SDP-only requests: explicitly use delete_after_completion for ChatGPT Web; Codex defaults to disabled",
    enum: ["disabled", "delete_after_completion"],
  })
  @ApiProduces("application/sdp")
  @ApiOperation({
    summary:
      "Create a Realtime WebRTC call: Codex voice for gpt-live sessions, ChatGPT Web voice otherwise",
  })
  async createCall(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() response: FastifyReply
  ): Promise<void> {
    try {
      const contentType = String(request.headers["content-type"] || "")
      const normalized = parseChatGptWebRealtimeCallRequest(body, contentType, {
        provider: request.headers["x-agent-vibes-provider"],
        historyPolicy: request.headers["x-agent-vibes-history-policy"],
      })
      const result =
        normalized.provider === "codex"
          ? await this.codexVoice.createCall(normalized)
          : await this.realtime.createCall(normalized)

      this.calls.register(result, normalized.provider, normalized.historyPolicy)
      response.header("X-Agent-Vibes-Provider", normalized.provider)
      response.header(
        "X-Agent-Vibes-Realtime-Protocol",
        normalized.provider === "codex"
          ? "codex-realtime-v3"
          : "chatgpt-web-data-message"
      )
      response.header("X-Agent-Vibes-History-Policy", normalized.historyPolicy)
      response.code(201)
      response.header("Content-Type", "application/sdp")
      response.header("Cache-Control", "no-store")
      response.header("Location", `/v1/realtime/calls/${result.callId}`)
      response.send(result.sdp)
    } catch (error) {
      if (error instanceof GptRequestError) {
        const rendered = renderOpenAiError(error)
        throw new HttpException(rendered.body, rendered.status)
      }
      if (error instanceof ChatGptWebRealtimeRequestError) {
        throw openAiError(400, error.message, null, error.param)
      }
      if (error instanceof ChatGptWebRealtimeServiceError) {
        throw openAiError(error.statusCode, error.message, error.code)
      }
      throw error
    }
  }

  @Get("calls/:callId")
  getCall(@Param("callId") id: string) {
    return this.callOperation(() => this.calls.get(id))
  }

  @Patch("calls/:callId")
  bindCall(
    @Param("callId") id: string,
    @Body() body: { conversation_id?: unknown }
  ) {
    return this.callOperation(() => this.calls.bind(id, body?.conversation_id))
  }

  @Delete("calls/:callId")
  closeCall(@Param("callId") id: string) {
    return this.callOperation(() => this.calls.close(id))
  }

  private async callOperation<T>(run: () => T | Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      const rendered = renderOpenAiError(error)
      throw new HttpException(rendered.body, rendered.status)
    }
  }

  /**
   * A file the voice conversation produced, such as a picture the model drew
   * while teaching. The call itself is peer to peer, so the page that holds it
   * sees the file id on the data channel but has no way to read the bytes.
   */
  @Get("files/:fileId")
  @ApiProduces(
    "image/png",
    "image/webp",
    "image/jpeg",
    "application/octet-stream"
  )
  @ApiOperation({
    summary: "Read a file a ChatGPT Web voice conversation produced",
  })
  async downloadFile(
    @Param("fileId") fileId: string,
    @Query("conversation_id") conversationId: string | undefined,
    @Res() response: FastifyReply
  ): Promise<void> {
    try {
      const file = await this.conversations.downloadFile(fileId, conversationId)
      response.code(200)
      response.header("Content-Type", file.mimeType)
      response.header("Cache-Control", "no-store")
      response.header(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`
      )
      response.send(Buffer.from(file.bytes))
    } catch (error) {
      if (error instanceof ChatGptWebError) {
        throw openAiError(error.statusCode, error.message, error.code)
      }
      throw error
    }
  }
}
