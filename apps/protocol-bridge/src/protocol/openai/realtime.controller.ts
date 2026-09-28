import {
  Body,
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
import { isCodexVoiceSession } from "../../llm/openai/codex-voice-call"
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
        type: status === 400 ? "invalid_request_error" : "api_error",
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
    private readonly conversations: ChatGptWebConversationService
  ) {}

  @Post("calls")
  @HttpCode(201)
  @ApiConsumes("multipart/form-data", "application/sdp", "application/json")
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
      const normalized = parseChatGptWebRealtimeCallRequest(body, contentType)
      // A gpt-live session carries its own instructions and delegation, which
      // only Codex voice takes; everything else keeps ChatGPT Web voice.
      const result = isCodexVoiceSession(normalized.session)
        ? await this.codexVoice.createCall(normalized)
        : await this.realtime.createCall(normalized)

      response.code(201)
      response.header("Content-Type", "application/sdp")
      response.header("Cache-Control", "no-store")
      response.header("Location", `/v1/realtime/calls/${result.callId}`)
      response.send(result.sdp)
    } catch (error) {
      if (error instanceof ChatGptWebRealtimeRequestError) {
        throw openAiError(400, error.message, null, error.param)
      }
      if (error instanceof ChatGptWebRealtimeServiceError) {
        throw openAiError(error.statusCode, error.message, error.code)
      }
      throw error
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
