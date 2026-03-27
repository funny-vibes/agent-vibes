import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import { Controller, Logger, Post, Req, Res } from "@nestjs/common"
import { FastifyReply, FastifyRequest } from "fastify"
import { CodexService } from "../../llm/codex/codex.service"
import { OpenaiCompatService } from "../../llm/openai-compat/openai-compat.service"
import { getCursorDisplayModels } from "../../llm/model-registry"
import { connectRPCHandler } from "./connect-rpc-handler"
import { CursorConnectStreamService } from "./cursor-connect-stream.service"
import {
  GetAllowedModelIntentsResponseSchema,
  GetUsableModelsResponseSchema,
  ModelDetailsSchema,
  NameAgentResponseSchema,
  UploadConversationBlobsRequestSchema,
  UploadConversationBlobsResponseSchema,
} from "../../gen/agent/v1_pb"
import {
  GetDiffReviewRequestSchema,
  StreamDiffReviewResponseSchema,
  type GetDiffReviewRequest_SimpleFileDiff,
} from "../../gen/aiserver/v1_pb"
import { KvStorageService } from "./kv-storage.service"

/**
 * Cursor ConnectRPC Adapter Controller
 * Exposes agent.v1 and aiserver.v1 endpoints.
 */
@Controller()
export class CursorAdapterController {
  private readonly logger = new Logger(CursorAdapterController.name)

  constructor(
    private readonly connectStreamService: CursorConnectStreamService,
    private readonly codexService: CodexService,
    private readonly openaiCompatService: OpenaiCompatService,
    private readonly kvStorageService: KvStorageService
  ) {}

  /**
   * Main chat streaming endpoint - HTTP/2 bidirectional streaming
   */
  @Post("agent.v1.AgentService/Run")
  async handleAgentRun(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply
  ): Promise<void> {
    this.logger.log(">>> AgentService/Run request received")

    try {
      await connectRPCHandler.handleBidiStream(
        req,
        res,
        async (inputMessages, output) => {
          this.logger.log(">>> AgentService/Run - handleBidiStream callback")

          const outputGenerator =
            this.connectStreamService.handleBidiStream(inputMessages)

          let responseCount = 0
          for await (const responseBuffer of outputGenerator) {
            responseCount++
            this.logger.debug(
              `>>> Agent response #${responseCount}: ${responseBuffer.length} bytes`
            )
            output(responseBuffer)
          }
          this.logger.log(
            `>>> AgentService/Run sent ${responseCount} responses`
          )
        }
      )
    } catch (error) {
      this.logger.error("Error in AgentService/Run", error)
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      throw new Error(`Agent run failed: ${errorMessage}`)
    }
  }

  /**
   * agent.v1.AgentService/NameAgent - Get agent name suggestion
   */
  @Post("agent.v1.AgentService/NameAgent")
  handleAgentName(@Res() res: FastifyReply): void {
    this.logger.log(">>> AgentService/NameAgent request received")
    res.header("Content-Type", "application/proto")
    res.header("Connect-Protocol-Version", "1")
    const response = create(NameAgentResponseSchema, { name: "New Agent" })
    res
      .status(200)
      .send(Buffer.from(toBinary(NameAgentResponseSchema, response)))
  }

  /**
   * agent.v1.AgentService/GetUsableModels - Return available models for Agent
   */
  @Post("agent.v1.AgentService/GetUsableModels")
  handleAgentGetUsableModels(@Res() res: FastifyReply): void {
    this.logger.log(">>> AgentService/GetUsableModels request received")
    res.header("Content-Type", "application/proto")
    res.header("Connect-Protocol-Version", "1")
    const models = getCursorDisplayModels({
      includeCodex: this.codexService.isAvailable(),
      codexModelTier: this.codexService.getModelTier(),
    }).map((model) =>
      create(ModelDetailsSchema, {
        modelId: model.name,
        displayModelId: model.name,
        displayName: model.displayName,
        displayNameShort: model.shortName,
        aliases: [],
        maxMode: model.name.includes("max"),
      })
    )
    const response = create(GetUsableModelsResponseSchema, { models })
    res
      .status(200)
      .send(Buffer.from(toBinary(GetUsableModelsResponseSchema, response)))
  }

  /**
   * agent.v1.AgentService/GetAllowedModelIntents
   */
  @Post("agent.v1.AgentService/GetAllowedModelIntents")
  handleAgentGetAllowedModelIntents(@Res() res: FastifyReply): void {
    this.logger.log(">>> AgentService/GetAllowedModelIntents request received")
    res.header("Content-Type", "application/proto")
    res.header("Connect-Protocol-Version", "1")
    const response = create(GetAllowedModelIntentsResponseSchema, {
      modelIntents: [],
    })
    res
      .status(200)
      .send(
        Buffer.from(toBinary(GetAllowedModelIntentsResponseSchema, response))
      )
  }

  /**
   * agent.v1.AgentService/UploadConversationBlobs
   */
  @Post("agent.v1.AgentService/UploadConversationBlobs")
  handleUploadConversationBlobs(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply
  ): void {
    this.logger.log(">>> AgentService/UploadConversationBlobs request received")

    const payload = connectRPCHandler.stripEnvelope(req.body as Buffer)
    const uploadRequest = fromBinary(
      UploadConversationBlobsRequestSchema,
      payload
    )
    const textDecoder = new TextDecoder()

    for (const blob of uploadRequest.blobs) {
      const blobId = textDecoder.decode(blob.id)
      this.kvStorageService.storeBinaryBlob(blobId, blob.value)
    }

    this.logger.log(
      `Stored ${uploadRequest.blobs.length} conversation blob(s) for conversation=${uploadRequest.conversationId || "(none)"} chunk=${uploadRequest.chunkIndex + 1}/${uploadRequest.totalChunks || 1}`
    )

    res.header("Content-Type", "application/proto")
    res.header("Connect-Protocol-Version", "1")
    const response = create(UploadConversationBlobsResponseSchema, {})
    res
      .status(200)
      .send(
        Buffer.from(toBinary(UploadConversationBlobsResponseSchema, response))
      )
  }

  // ── Diff Review ────────────────────────────────────────────────────────

  /**
   * aiserver.v1.AiService/StreamDiffReview — Code review via GPT
   *
   * Cursor sends a `GetDiffReviewRequest` containing file diffs.
   * We build a code review prompt, stream the GPT response, and wrap
   * each text delta as a ConnectRPC-framed `StreamDiffReviewResponse`.
   */
  @Post("aiserver.v1.AiService/StreamDiffReview")
  async handleStreamDiffReview(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply
  ): Promise<void> {
    this.logger.log(">>> AiService/StreamDiffReview request received")

    if (!this.openaiCompatService.isAvailable()) {
      this.logger.error("OpenAI-compat backend not configured for review")
      res.status(500).send({ error: "Review backend not configured" })
      return
    }

    try {
      // 1. Decode protobuf request
      const rawBody = req.body as Buffer
      const payload = connectRPCHandler.stripEnvelope(rawBody)
      const reviewRequest = fromBinary(GetDiffReviewRequestSchema, payload)

      const fileCount = reviewRequest.diffs.length
      const model = reviewRequest.model || "gpt-4.1-mini"
      this.logger.log(`Review request: ${fileCount} file(s), model=${model}`)

      // 2. Build unified diff text from protobuf
      const diffText = this.buildUnifiedDiff(reviewRequest.diffs)

      // 3. Build code review prompt
      const messages: Array<{
        role: "system" | "user"
        content: string
      }> = [
        {
          role: "system",
          content:
            "You are an expert code reviewer. Review the following diff and provide concise, " +
            "actionable feedback. Focus on: bugs, security issues, performance problems, " +
            "code style, and naming. Use markdown formatting. Keep the review brief and to the point.",
        },
        {
          role: "user",
          content: `Please review the following code changes:\n\n\`\`\`diff\n${diffText}\n\`\`\``,
        },
      ]

      // 4. Setup streaming response
      connectRPCHandler.setupStreamingResponse(res)

      // 5. Stream GPT response as StreamDiffReviewResponse frames
      for await (const textDelta of this.openaiCompatService.streamSimpleCompletion(
        model,
        messages,
        { temperature: 0.3 }
      )) {
        const responseMsg = create(StreamDiffReviewResponseSchema, {
          response: { case: "text", value: textDelta },
        })
        const binary = toBinary(StreamDiffReviewResponseSchema, responseMsg)
        const frame = connectRPCHandler.encodeMessage(Buffer.from(binary))
        connectRPCHandler.writeMessage(res, frame)
      }

      connectRPCHandler.endStream(res)
      this.logger.log(">>> StreamDiffReview completed successfully")
    } catch (error) {
      this.logger.error("Error in StreamDiffReview", error)
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      try {
        connectRPCHandler.endStream(res, new Error(errorMessage))
      } catch {
        res.status(500).send({ error: errorMessage })
      }
    }
  }

  /**
   * aiserver.v1.AiService/StreamDiffReviewByFile — Same as StreamDiffReview
   * but with per-file grouping. We reuse the same logic (Cursor may call either).
   */
  @Post("aiserver.v1.AiService/StreamDiffReviewByFile")
  async handleStreamDiffReviewByFile(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply
  ): Promise<void> {
    this.logger.log(
      ">>> AiService/StreamDiffReviewByFile → delegating to StreamDiffReview"
    )
    return this.handleStreamDiffReview(req, res)
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Convert protobuf SimpleFileDiff[] to unified diff text
   */
  private buildUnifiedDiff(
    diffs: GetDiffReviewRequest_SimpleFileDiff[]
  ): string {
    const parts: string[] = []

    for (const file of diffs) {
      parts.push(`--- a/${file.relativeWorkspacePath}`)
      parts.push(`+++ b/${file.relativeWorkspacePath}`)

      for (const chunk of file.chunks) {
        const oldStart = chunk.oldRange?.startLineNumber ?? 1
        const oldCount = chunk.oldLines.length
        const newStart = chunk.newRange?.startLineNumber ?? 1
        const newCount = chunk.newLines.length

        parts.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)

        for (const line of chunk.oldLines) {
          parts.push(`-${line}`)
        }
        for (const line of chunk.newLines) {
          parts.push(`+${line}`)
        }
      }
    }

    return parts.join("\n")
  }
}
