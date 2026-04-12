import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import { Controller, Logger, Post, Req, Res } from "@nestjs/common"
import type { CreateMessageDto } from "../../anthropic/dto/create-message.dto"
import { MessagesService } from "../../anthropic/messages.service"
import { FastifyReply, FastifyRequest } from "fastify"
import { AnthropicApiService } from "../../../llm/anthropic/anthropic-api.service"
import { CodexService } from "../../../llm/openai/codex.service"
import { GoogleModelCacheService } from "../../../llm/google/google-model-cache.service"
import { ModelRouterService } from "../../../llm/shared/model-router.service"
import { OpenaiCompatService } from "../../../llm/openai/openai-compat.service"
import {
  canPublicClaudeModelUseGoogle,
  getCursorDisplayModels,
  resolveCloudCodeModel,
} from "../../../llm/shared/model-registry"
import type { AnthropicResponse } from "../../../shared/anthropic"
import { connectRPCHandler } from "../connect-rpc-handler"
import { CursorConnectStreamService } from "../cursor-connect-stream.service"
import {
  GetAllowedModelIntentsResponseSchema,
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
  NameAgentResponseSchema,
  UploadConversationBlobsRequestSchema,
  UploadConversationBlobsResponseSchema,
} from "../../../gen/agent/v1_pb"
import {
  BugBotStatusSchema,
  BugBotStatus_Status,
  BugLocationSchema,
  BugReportSchema,
  BugReportsSchema,
  GetDiffReviewRequestSchema,
  ReportCommitAiAnalyticsRequestSchema,
  ReportCommitAiAnalyticsResponseSchema,
  StreamBugBotAgenticClientMessageSchema,
  StreamBugBotAgenticServerMessageSchema,
  StreamBugBotResponseSchema,
  StreamDiffReviewResponseSchema,
  type CodeBlock,
  type FileDiff,
  type GetDiffReviewRequest_SimpleFileDiff,
  type StreamBugBotRequest,
} from "../../../gen/aiserver/v1_pb"
import { KvStorageService } from "../kv-storage.service"
import {
  appendRequestedCursorModels,
  buildCursorUsableModel,
} from "../cursor-model-protocol"

/**
 * Cursor ConnectRPC Adapter Controller
 * Exposes agent.v1 and aiserver.v1 endpoints.
 */
@Controller()
export class CursorAdapterController {
  private readonly logger = new Logger(CursorAdapterController.name)

  /** BugBot fallback model chain (after the primary model fails) */
  private static readonly BUGBOT_FALLBACK_MODELS = [
    "claude-4.6-opus-thinking",
    "gemini-3.1-pro-high",
  ]

  constructor(
    private readonly connectStreamService: CursorConnectStreamService,
    private readonly googleModelCache: GoogleModelCacheService,
    private readonly anthropicApiService: AnthropicApiService,
    private readonly codexService: CodexService,
    private readonly modelRouter: ModelRouterService,
    private readonly openaiCompatService: OpenaiCompatService,
    private readonly messagesService: MessagesService,
    private readonly kvStorageService: KvStorageService
  ) {}

  private isGptBackendAvailable(): boolean {
    return (
      this.openaiCompatService.isAvailable() || this.codexService.isAvailable()
    )
  }

  private getCursorGptModelTier(): string | null {
    // Cursor account display can be independent, but model discovery should
    // still follow the real Codex backend entitlement when we know it.
    if (this.openaiCompatService.isAvailable()) {
      return null
    }

    return this.codexService.getModelTier()
  }

  private isCursorModelCurrentlyRoutable(modelId: string): boolean {
    const resolved = resolveCloudCodeModel(modelId)
    if (!resolved) {
      return this.anthropicApiService.supportsModel(modelId)
    }

    if (resolved.family === "gpt") {
      if (this.openaiCompatService.isAvailable()) {
        return true
      }

      return this.codexService.supportsModel(modelId)
    }

    if (resolved.family === "gemini") {
      return (
        this.modelRouter.isGoogleAvailable &&
        this.googleModelCache.isValidModel(resolved.cloudCodeId)
      )
    }

    return (
      this.anthropicApiService.supportsModel(modelId) ||
      (this.modelRouter.isGoogleAvailable &&
        canPublicClaudeModelUseGoogle(modelId) &&
        this.googleModelCache.isValidModel(resolved.cloudCodeId))
    )
  }

  private buildCursorModels(customModelIds?: string[]) {
    return appendRequestedCursorModels(
      getCursorDisplayModels({
        includeCodex: this.isGptBackendAvailable(),
        codexModelTier: this.getCursorGptModelTier(),
        extraModels: this.anthropicApiService.getCursorDisplayModels(),
      }),
      customModelIds
    ).filter((model) => this.isCursorModelCurrentlyRoutable(model.name))
  }

  private parseGetUsableModelsRequest(req: FastifyRequest): string[] {
    const body = req.body
    if (!(body instanceof Uint8Array || Buffer.isBuffer(body))) {
      return []
    }

    try {
      const request = fromBinary(
        GetUsableModelsRequestSchema,
        new Uint8Array(body)
      )
      return request.customModelIds
    } catch (error) {
      this.logger.debug(
        `GetUsableModels request parse failed, using defaults: ${error instanceof Error ? error.message : String(error)}`
      )
      return []
    }
  }

  private logModelNames(label: string, modelNames: string[]): void {
    this.logger.debug(
      `${label}: ${modelNames.length} model(s) -> ${modelNames.join(", ")}`
    )
  }

  private isDiffReviewBackendAvailable(): boolean {
    return (
      this.openaiCompatService.isAvailable() || this.codexService.isAvailable()
    )
  }

  private buildDiffReviewRequest(
    model: string,
    diffText: string
  ): CreateMessageDto {
    return {
      model,
      system:
        "You are an expert code reviewer. Review the following diff and provide concise, " +
        "actionable feedback. Focus on: bugs, security issues, performance problems, " +
        "code style, and naming. Use markdown formatting. Keep the review brief and to the point.",
      messages: [
        {
          role: "user",
          content: `Please review the following code changes:\n\n\`\`\`diff\n${diffText}\n\`\`\``,
        },
      ],
      max_tokens: 4096,
      temperature: 0.3,
      stream: true,
    }
  }

  private extractDiffReviewTextDeltas(chunk: string): string[] {
    const deltas: string[] = []

    for (const block of chunk.split("\n\n")) {
      const trimmedBlock = block.trim()
      if (!trimmedBlock) continue

      let eventType = ""
      const dataLines: string[] = []

      for (const line of trimmedBlock.split("\n")) {
        if (line.startsWith("event:")) {
          eventType = line.slice("event:".length).trim()
          continue
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart())
        }
      }

      if (eventType !== "content_block_delta" || dataLines.length === 0) {
        continue
      }

      try {
        const payload = JSON.parse(dataLines.join("\n")) as {
          delta?: { type?: string; text?: string }
        }
        if (
          payload.delta?.type === "text_delta" &&
          typeof payload.delta.text === "string" &&
          payload.delta.text
        ) {
          deltas.push(payload.delta.text)
        }
      } catch {
        // Ignore malformed SSE payloads and continue streaming.
      }
    }

    return deltas
  }

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
          let heartbeatResponseCount = 0
          let lastResponseDebugLogAt = 0
          for await (const responseBuffer of outputGenerator) {
            responseCount++
            if (responseBuffer.length <= 9) {
              heartbeatResponseCount++
            } else {
              const now = Date.now()
              if (now - lastResponseDebugLogAt > 60_000) {
                this.logger.debug(
                  `>>> Agent response #${responseCount}: ${responseBuffer.length} bytes` +
                    (heartbeatResponseCount > 0
                      ? ` (suppressed ${heartbeatResponseCount} heartbeat responses)`
                      : "")
                )
                heartbeatResponseCount = 0
                lastResponseDebugLogAt = now
              }
            }
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
  handleAgentGetUsableModels(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply
  ): void {
    this.logger.log(">>> AgentService/GetUsableModels request received")
    res.header("Content-Type", "application/proto")
    res.header("Connect-Protocol-Version", "1")
    const customModelIds = this.parseGetUsableModelsRequest(req)
    const cursorModels = this.buildCursorModels(customModelIds)
    const models = cursorModels.map((model) => buildCursorUsableModel(model))
    this.logModelNames(
      "AgentService.GetUsableModels response",
      cursorModels.map((model) => model.name)
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

    if (!this.isDiffReviewBackendAvailable()) {
      this.logger.error("No GPT review backend configured")
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
      const reviewDto = this.buildDiffReviewRequest(model, diffText)

      // 3. Setup streaming response
      connectRPCHandler.setupStreamingResponse(res)

      // 4. Stream review response through the shared backend router so
      // openai-compat failures can transparently fall back to Codex.
      for await (const chunk of this.messagesService.createMessageStream(
        reviewDto
      )) {
        for (const textDelta of this.extractDiffReviewTextDeltas(chunk)) {
          const responseMsg = create(StreamDiffReviewResponseSchema, {
            response: { case: "text", value: textDelta },
          })
          const binary = toBinary(StreamDiffReviewResponseSchema, responseMsg)
          const frame = connectRPCHandler.encodeMessage(Buffer.from(binary))
          connectRPCHandler.writeMessage(res, frame)
        }
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

  /**
   * aiserver.v1.AiService/StreamBugBotAgentic — Commit/diff review via BugBot.
   *
   * Current Cursor versions use this endpoint for the post-commit Review flow.
   * We currently implement a minimal compatible stream that converts the git diff
   * into a standard review prompt and returns BugBot-style findings.
   */
  @Post("aiserver.v1.AiService/StreamBugBotAgentic")
  async handleStreamBugBotAgentic(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply
  ): Promise<void> {
    this.logger.log(">>> AiService/StreamBugBotAgentic request received")

    try {
      await connectRPCHandler.handleBidiStream(
        req,
        res,
        async (inputMessages, output) => {
          let startMessageParsed = false

          for await (const payload of inputMessages) {
            if (startMessageParsed) {
              continue
            }

            const startMessage = fromBinary(
              StreamBugBotAgenticClientMessageSchema,
              payload
            )

            if (startMessage.message.case !== "start") {
              this.logger.warn(
                `Unsupported StreamBugBotAgentic message case: ${startMessage.message.case || "(none)"}`
              )
              continue
            }

            startMessageParsed = true
            const request = startMessage.message.value
            const diffCount = request.gitDiff?.diffs.length ?? 0
            // Default to the highest tier model (gpt-5.4) if Cursor doesn't specify one
            const model = request.modelDetails?.modelName || "gpt-5.4"
            this.logger.log(
              `BugBot review request: ${diffCount} file(s), model=${model}, deepReview=${request.deepReview ?? false}`
            )

            const writeFrame = (
              payload: Parameters<
                typeof create<typeof StreamBugBotResponseSchema>
              >[1]
            ) => {
              const responseMsg = create(
                StreamBugBotAgenticServerMessageSchema,
                {
                  message: {
                    case: "bugbotResponse",
                    value: create(StreamBugBotResponseSchema, payload),
                  },
                }
              )
              const binary = toBinary(
                StreamBugBotAgenticServerMessageSchema,
                responseMsg
              )
              const frame = connectRPCHandler.encodeMessage(Buffer.from(binary))
              output(frame)
            }

            writeFrame({
              status: create(BugBotStatusSchema, {
                status: BugBotStatus_Status.IN_PROGRESS,
                message: "Analyzing code changes...",
                totalIterations: request.iterations ?? 1,
                iterationsCompleted: 0,
              }),
            })

            const keepAliveInterval = setInterval(() => {
              try {
                writeFrame({
                  status: create(BugBotStatusSchema, {
                    status: BugBotStatus_Status.IN_PROGRESS,
                    message: "Analyzing code changes...",
                    totalIterations: request.iterations ?? 1,
                    iterationsCompleted: 0,
                  }),
                })
              } catch {
                clearInterval(keepAliveInterval)
              }
            }, 5000)

            try {
              const review = await this.generateBugBotReview(request)
              clearInterval(keepAliveInterval)

              writeFrame({
                status: create(BugBotStatusSchema, {
                  status: BugBotStatus_Status.DONE,
                  message: `Found ${review.bugReports?.bugReports.length ?? 0} issue(s)`,
                  totalIterations: request.iterations ?? 1,
                  iterationsCompleted: request.iterations ?? 1,
                }),
                summary: review.summary,
                bugReports: review.bugReports,
              })

              return
            } catch (error) {
              clearInterval(keepAliveInterval)
              throw error
            }
          }
        }
      )
      this.logger.log(">>> StreamBugBotAgentic completed successfully")
    } catch (error) {
      this.logger.error("Error in StreamBugBotAgentic", error)
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
   * aiserver.v1.AiService/ReportCommitAiAnalytics — accept commit analytics so
   * Cursor does not fail after commit.
   */
  @Post("aiserver.v1.AiService/ReportCommitAiAnalytics")
  handleReportCommitAiAnalytics(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply
  ): void {
    const payload = connectRPCHandler.stripEnvelope(req.body as Buffer)
    const report = fromBinary(ReportCommitAiAnalyticsRequestSchema, payload)

    this.logger.log(
      `>>> AiService/ReportCommitAiAnalytics commit=${report.commitHash} source=${report.commitSource || "(none)"} added=${report.totalLinesAdded} deleted=${report.totalLinesDeleted}`
    )

    res.header("Content-Type", "application/proto")
    res.header("Connect-Protocol-Version", "1")
    const response = create(ReportCommitAiAnalyticsResponseSchema, {})
    res
      .status(200)
      .send(
        Buffer.from(toBinary(ReportCommitAiAnalyticsResponseSchema, response))
      )
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

  private async generateBugBotReview(request: StreamBugBotRequest): Promise<{
    summary: string
    bugReports: ReturnType<typeof create<typeof BugReportsSchema>>
  }> {
    const primaryModel = request.modelDetails?.modelName || "gpt-5.4"
    const diffText = this.buildUnifiedDiffFromGitDiff(
      request.gitDiff?.diffs || []
    )
    const contextText = this.buildBugBotContextText(request.contextFiles)
    const systemPrompt = this.buildBugBotSystemPrompt(request)
    const userPrompt = this.buildBugBotUserPrompt(
      request,
      diffText,
      contextText
    )

    // Fallback chain: Primary -> Claude -> Gemini
    const fallbackModels = [
      primaryModel,
      ...CursorAdapterController.BUGBOT_FALLBACK_MODELS,
    ]

    let lastError: unknown

    for (const model of fallbackModels) {
      try {
        this.logger.log(`Attempting BugBot review with model: ${model}`)
        const dto: CreateMessageDto = {
          model,
          messages: [{ role: "user", content: userPrompt }],
          system: systemPrompt,
          max_tokens: request.deepReview ? 8192 : 4096,
          temperature: 0.2,
          stream: false,
          thinking: {
            type: "enabled",
            budget_tokens: request.deepReview ? 4096 : 2048,
          },
        }

        const response = await this.messagesService.createMessage(dto)
        const parsed = this.parseBugBotResponse(response)

        const bugReports = create(BugReportsSchema, {
          bugReports: parsed.bugs.map((bug, index) =>
            create(BugReportSchema, {
              id: `bugbot-${index + 1}`,
              title: bug.title,
              description: bug.description,
              rationale: bug.rationale,
              severity: bug.severity,
              confidence: bug.confidence,
              category: bug.category,
              locations: bug.locations.map((location) =>
                create(BugLocationSchema, {
                  file: location.file,
                  startLine: location.startLine,
                  endLine: location.endLine,
                  codeLines: location.codeLines,
                })
              ),
            })
          ),
        })

        const summary =
          parsed.summary ||
          (bugReports.bugReports.length > 0
            ? `Found ${bugReports.bugReports.length} potential issue(s) in the reviewed changes.`
            : "No obvious issues found in the reviewed changes.")

        return { summary, bugReports }
      } catch (error) {
        this.logger.warn(
          `BugBot review failed with model ${model}: ${error instanceof Error ? error.message : String(error)}`
        )
        lastError = error
        // Continue to the next model in the fallback chain
      }
    }

    // If all models fail, throw the last error
    throw lastError
  }

  private buildUnifiedDiffFromGitDiff(diffs: FileDiff[]): string {
    const parts: string[] = []

    for (const file of diffs) {
      parts.push(`--- a/${file.from || file.to}`)
      parts.push(`+++ b/${file.to || file.from}`)

      for (const chunk of file.chunks) {
        const oldStart = chunk.oldStart ?? 1
        const oldCount = chunk.oldLines ?? chunk.lines?.length ?? 1
        const newStart = chunk.newStart ?? 1
        const newCount = chunk.newLines ?? chunk.lines?.length ?? 1
        parts.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)

        if (chunk.lines.length > 0) {
          parts.push(...chunk.lines)
        } else if (chunk.content) {
          parts.push(chunk.content)
        }
      }
    }

    return parts.join("\n")
  }

  private buildBugBotContextText(contextFiles?: CodeBlock[]): string {
    if (!contextFiles || contextFiles.length === 0) return ""

    return contextFiles
      .map((file) => {
        const body =
          file.overrideContents || file.contents || file.fileContents || ""
        return [`File: ${file.relativeWorkspacePath}`, "```", body, "```"].join(
          "\n"
        )
      })
      .join("\n\n")
  }

  private buildBugBotSystemPrompt(request: StreamBugBotRequest): string {
    const extraGuidance = [
      request.userInstructions,
      request.bugDetectionGuidelines,
      request.deepReview
        ? "Perform a deeper review and call out subtle correctness, state, concurrency, and integration risks."
        : undefined,
    ]
      .filter(Boolean)
      .join("\n\n")

    return [
      "You are Cursor BugBot, an expert code reviewer focused on identifying real bugs in a git diff.",
      "Return ONLY valid JSON.",
      "Use this exact schema:",
      '{"summary":"string","bugs":[{"title":"string","description":"string","rationale":"string","severity":"critical|high|medium|low","confidence":0.0,"category":"string","locations":[{"file":"string","startLine":1,"endLine":1,"codeLines":["string"]}]}]}',
      "Rules:",
      "- Report only issues that are plausibly real defects or regressions.",
      '- If there are no meaningful issues, return {"summary":"...","bugs":[] }.',
      "- Keep each bug concise and actionable.",
      "- Use file paths and line ranges from the provided diff/context when possible.",
      extraGuidance,
    ]
      .filter(Boolean)
      .join("\n\n")
  }

  private buildBugBotUserPrompt(
    request: StreamBugBotRequest,
    diffText: string,
    contextText: string
  ): string {
    const constraints: string[] = []
    if (request.constrainToFile) {
      constraints.push(`Focus file: ${request.constrainToFile}`)
    }
    if (request.constrainToRange) {
      constraints.push(
        `Focus range: ${request.constrainToRange.startLine}-${request.constrainToRange.endLineInclusive}`
      )
    }

    return [
      "Review the following git diff and report likely bugs.",
      constraints.length > 0 ? constraints.join("\n") : undefined,
      "Git diff:",
      "```diff",
      diffText || "(empty diff)",
      "```",
      contextText ? `Additional context:\n${contextText}` : undefined,
    ]
      .filter(Boolean)
      .join("\n\n")
  }

  private parseBugBotResponse(response: AnthropicResponse): {
    summary: string
    bugs: Array<{
      title: string
      description: string
      rationale: string
      severity: string
      confidence?: number
      category?: string
      locations: Array<{
        file: string
        startLine: number
        endLine: number
        codeLines: string[]
      }>
    }>
  } {
    const text = response.content
      .filter(
        (
          block
        ): block is Extract<
          AnthropicResponse["content"][number],
          { type: "text" }
        > => block.type === "text"
      )
      .map((block) => block.text)
      .join("\n")
      .trim()

    const candidate = this.extractJsonObject(text)
    if (!candidate) {
      throw new Error("Failed to extract JSON object from model response")
    }

    try {
      const parsed = JSON.parse(candidate) as {
        summary?: unknown
        bugs?: Array<{
          title?: unknown
          description?: unknown
          rationale?: unknown
          severity?: unknown
          confidence?: unknown
          category?: unknown
          locations?: Array<{
            file?: unknown
            startLine?: unknown
            endLine?: unknown
            codeLines?: unknown
          }>
        }>
      }

      return {
        summary:
          typeof parsed.summary === "string"
            ? parsed.summary
            : "BugBot review completed.",
        bugs: Array.isArray(parsed.bugs)
          ? parsed.bugs
              .map((bug) => ({
                title:
                  typeof bug.title === "string" && bug.title.trim()
                    ? bug.title.trim()
                    : "Potential issue",
                description:
                  typeof bug.description === "string" ? bug.description : "",
                rationale:
                  typeof bug.rationale === "string" ? bug.rationale : "",
                severity:
                  typeof bug.severity === "string" ? bug.severity : "medium",
                confidence:
                  typeof bug.confidence === "number"
                    ? bug.confidence
                    : undefined,
                category:
                  typeof bug.category === "string" ? bug.category : undefined,
                locations: Array.isArray(bug.locations)
                  ? bug.locations
                      .map((location) => ({
                        file:
                          typeof location.file === "string"
                            ? location.file
                            : "",
                        startLine:
                          typeof location.startLine === "number"
                            ? location.startLine
                            : 1,
                        endLine:
                          typeof location.endLine === "number"
                            ? location.endLine
                            : typeof location.startLine === "number"
                              ? location.startLine
                              : 1,
                        codeLines: Array.isArray(location.codeLines)
                          ? location.codeLines.filter(
                              (line): line is string => typeof line === "string"
                            )
                          : [],
                      }))
                      .filter((location) => location.file)
                  : [],
              }))
              .filter((bug) => bug.description || bug.locations.length > 0)
          : [],
      }
    } catch (error) {
      throw new Error(
        `Failed to parse BugBot JSON response: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private extractJsonObject(text: string): string | null {
    const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fencedMatch?.[1]) {
      return fencedMatch[1].trim()
    }

    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start >= 0 && end > start) {
      return text.slice(start, end + 1)
    }

    return null
  }
}
