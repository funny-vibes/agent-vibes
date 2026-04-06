import {
  type DescMessage,
  type MessageShape,
  create,
  fromBinary,
  toBinary,
} from "@bufbuild/protobuf"
import { Controller, Get, Logger, Post, Req, Res } from "@nestjs/common"
import { FastifyReply, FastifyRequest } from "fastify"
import {
  AvailableCppModelsResponseSchema,
  AvailableModelsRequestSchema,
  AvailableModelsResponseSchema,
  AvailableModelsResponse_AvailableModelSchema,
  CheckQueuePositionResponseSchema,
  GetCurrentPeriodUsageResponseSchema,
  GetDefaultModelNudgeDataResponseSchema,
  GetEmailResponseSchema,
  GetEmailResponse_SignUpType,
  GetUsageLimitPolicyStatusResponseSchema,
  HasSeenAdResponseSchema,
  IsAllowedFreeTrialUsageResponseSchema,
  IsOnNewPricingResponseSchema,
  NameTabRequestSchema,
  NameTabResponseSchema,
  SubmitSpansResponseSchema,
  KnowledgeBaseAddRequestSchema,
  KnowledgeBaseAddResponseSchema,
  KnowledgeBaseGetRequestSchema,
  KnowledgeBaseGetResponseSchema,
  KnowledgeBaseGetResponse_ItemSchema,
  KnowledgeBaseListResponseSchema,
  KnowledgeBaseListResponse_ItemSchema,
  KnowledgeBaseUpdateRequestSchema,
  KnowledgeBaseUpdateResponseSchema,
  KnowledgeBaseRemoveRequestSchema,
  KnowledgeBaseRemoveResponseSchema,
} from "../../gen/aiserver/v1_pb"
import { CodexService } from "../../llm/codex/codex.service"
import { ClaudeApiService } from "../../llm/claude-api/claude-api.service"
import { GoogleModelCacheService } from "../../llm/google/google-model-cache.service"
import { GoogleService } from "../../llm/google/google.service"
import { ModelRouterService } from "../../llm/model-router.service"
import { OpenaiCompatService } from "../../llm/openai-compat/openai-compat.service"
import { KnowledgeBaseService } from "./knowledge-base.service"
import {
  canPublicClaudeModelUseGoogle,
  DEFAULT_GEMINI_MODEL,
  getCursorDisplayModels,
  resolveCloudCodeModel,
} from "../../llm/model-registry"

/**
 * Centralised mock response defaults.
 *
 * Protocol Bridge does not connect to Cursor's official servers, so these
 * endpoints must return plausible values to let the IDE initialise correctly.
 * Gather all fabricated values here for easy audit and future config override.
 */
const MOCK_DEFAULTS = {
  /** Email shown in Cursor account UI */
  email: "protocol-bridge@local",
  /** Sign-up provider reported to the IDE */
  signUpType: GetEmailResponse_SignUpType.GOOGLE,
  /** Stripe membership level — affects feature gates in the IDE */
  membershipType: "ultra" as const,
  /** Subscription status — must be "active" for agent features */
  subscriptionStatus: "active" as const,
  /** Default tab name for new composer tabs */
  tabName: "New Tab",
  /** Queue position (-1 = no queue, bypasses waiting UI) */
  queuePosition: -1,
  /** Whether the user has seen the in-app ad (true = skip) */
  hasSeen: true,
  /** Whether free trial usage is allowed */
  isAllowed: true,
} as const
/**
 * Aiserver v1 Mock Controller
 *
 * Handles all aiserver.v1.* ConnectRPC endpoints that Cursor IDE calls
 * during initialization and runtime (plan info, usage, models, etc.).
 *
 * This is a separate file so it can be easily added/removed.
 */
@Controller()
export class AiserverMockController {
  private readonly logger = new Logger(AiserverMockController.name)

  constructor(
    private readonly googleService: GoogleService,
    private readonly googleModelCache: GoogleModelCacheService,
    private readonly codexService: CodexService,
    private readonly claudeApiService: ClaudeApiService,
    private readonly modelRouter: ModelRouterService,
    private readonly openaiCompatService: OpenaiCompatService,
    private readonly knowledgeBaseService: KnowledgeBaseService
  ) {}

  private isGptBackendAvailable(): boolean {
    return (
      this.openaiCompatService.isAvailable() || this.codexService.isAvailable()
    )
  }

  private getCursorGptModelTier(): string | null {
    if (this.openaiCompatService.isAvailable()) {
      return null
    }

    return this.codexService.getModelTier()
  }

  private isCursorModelCurrentlyRoutable(modelId: string): boolean {
    const resolved = resolveCloudCodeModel(modelId)
    if (!resolved) {
      return this.claudeApiService.supportsModel(modelId)
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
      this.claudeApiService.supportsModel(modelId) ||
      (this.modelRouter.isGoogleAvailable &&
        canPublicClaudeModelUseGoogle(modelId) &&
        this.googleModelCache.isValidModel(resolved.cloudCodeId))
    )
  }

  private deriveLocalTabName(userRequest: string): string {
    const normalized = userRequest.replace(/\s+/g, " ").trim()
    if (!normalized) {
      return ""
    }

    const firstLine = normalized.split("\n")[0]?.trim() || ""
    if (!firstLine) {
      return ""
    }

    const cleaned = firstLine
      .replace(/[`*_#>[\](){}]/g, " ")
      .replace(/[“”"'`]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.。,，!！?？;；:：]+$/g, "")

    if (!cleaned) {
      return ""
    }

    if (/[\u3400-\u9fff]/.test(cleaned)) {
      return cleaned.replace(/\s+/g, "").slice(0, 16)
    }

    return cleaned.split(/\s+/).slice(0, 6).join(" ").slice(0, 80).trim()
  }

  private buildCursorModels(req?: FastifyRequest) {
    let excludeMaxNamedModels = false

    const body = req?.body
    if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
      try {
        const request = fromBinary(
          AvailableModelsRequestSchema,
          new Uint8Array(body)
        )
        excludeMaxNamedModels = !!request.excludeMaxNamedModels
      } catch (error) {
        this.logger.debug(
          `AvailableModels request parse failed, using defaults: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    return getCursorDisplayModels({
      includeCodex: this.isGptBackendAvailable(),
      codexModelTier: this.getCursorGptModelTier(),
      excludeMaxNamedModels,
      extraModels: this.claudeApiService.getCursorDisplayModels(),
    }).filter((model) => this.isCursorModelCurrentlyRoutable(model.name))
  }

  private logModelNames(label: string, modelNames: string[]): void {
    this.logger.debug(
      `${label}: ${modelNames.length} model(s) -> ${modelNames.join(", ")}`
    )
  }

  // ── NetworkService ──

  @Post("aiserver.v1.NetworkService/IsConnected")
  handleIsConnected(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  // ── DashboardService ──

  @Post("aiserver.v1.DashboardService/GetUsageBasedPremiumRequests")
  handleGetUsage(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.DashboardService/GetManagedSkills")
  handleDashboardGetManagedSkills(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.DashboardService/GetTeams")
  handleDashboardGetTeams(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.DashboardService/GetTeamCommands")
  handleDashboardGetTeamCommands(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.DashboardService/GetPlanInfo")
  handleGetPlanInfo(@Res() res: FastifyReply): void {
    this.logger.log("DashboardService/GetPlanInfo")
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.DashboardService/IsOnNewPricing")
  handleIsOnNewPricing(@Res() res: FastifyReply): void {
    const response = create(IsOnNewPricingResponseSchema, {
      isOnNewPricing: false,
      isOptedOut: false,
      hasAutoSpillover: false,
    })
    this.sendProto(res, IsOnNewPricingResponseSchema, response)
  }

  @Post("aiserver.v1.DashboardService/GetUsageLimitPolicyStatus")
  handleGetUsageLimitPolicyStatus(@Res() res: FastifyReply): void {
    const response = create(GetUsageLimitPolicyStatusResponseSchema, {
      isInSlowPool: false,
      canConfigureSpendLimit: true,
    })
    this.sendProto(res, GetUsageLimitPolicyStatusResponseSchema, response)
  }

  @Post("aiserver.v1.DashboardService/IsAllowedFreeTrialUsage")
  handleIsAllowedFreeTrialUsage(@Res() res: FastifyReply): void {
    const response = create(IsAllowedFreeTrialUsageResponseSchema, {
      isAllowed: MOCK_DEFAULTS.isAllowed,
    })
    this.sendProto(res, IsAllowedFreeTrialUsageResponseSchema, response)
  }

  @Post("aiserver.v1.DashboardService/GetHardLimit")
  handleDashboardGetHardLimit(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.DashboardService/GetTokenUsage")
  handleGetTokenUsage(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.DashboardService/GetClientUsageData")
  handleGetClientUsageData(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.DashboardService/GetCurrentPeriodUsage")
  handleDashboardGetCurrentPeriodUsage(@Res() res: FastifyReply): void {
    const response = create(GetCurrentPeriodUsageResponseSchema, {})
    this.sendProto(res, GetCurrentPeriodUsageResponseSchema, response)
  }

  @Post("aiserver.v1.DashboardService/GetUserPrivacyMode")
  handleDashboardGetUserPrivacyMode(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam")
  handleGetTeamAdminSettings(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.DashboardService/GetTeamReposOrEmptyIfNotInTeam")
  handleGetTeamRepos(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.DashboardService/GetSlackInstallUrl")
  handleGetSlackInstallUrl(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.DashboardService/GetGlobalCommands")
  handleGetGlobalCommands(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants")
  handleGetUsageLimitStatusAndActiveGrants(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.DashboardService/GetEffectiveUserPlugins")
  handleGetEffectiveUserPlugins(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  // ── AiService ──

  @Post("aiserver.v1.AiService/GetUserPrivacyMode")
  handleGetPrivacyMode(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/ReportAiCodeChangeMetrics")
  handleReportAiCodeChangeMetrics(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/GetTeams")
  handleGetTeams(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/AvailableModels")
  async handleAvailableModels(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply
  ): Promise<void> {
    // Await refresh with timeout so a single click returns up-to-date models.
    // If refresh takes longer than 5s, fall through with cached data.
    await this.refreshModelsWithTimeout(5000)

    try {
      const allModels = this.buildCursorModels(req)
      const protoModels = allModels.map((m) =>
        create(AvailableModelsResponse_AvailableModelSchema, {
          name: m.name,
          defaultOn: true,
          supportsAgent: true,
          supportsThinking: m.isThinking,
          supportsImages: true,
          supportsMaxMode: true,
          supportsNonMaxMode: true,
          contextTokenLimit: m.family === "gemini" ? 1000000 : 200000,
          clientDisplayName: m.displayName,
          serverModelName: m.name,
          supportsPlanMode: true,
          supportsSandboxing: true,
          supportsCmdK: true,
          inputboxShortModelName: m.shortName,
          degradationStatus: 0,
          isRecommendedForBackgroundComposer: false,
        })
      )
      const response = create(AvailableModelsResponseSchema, {
        modelNames: allModels.map((m) => m.name),
        models: protoModels,
      })
      const buf = Buffer.from(toBinary(AvailableModelsResponseSchema, response))
      this.logger.log(
        `AvailableModels: ${allModels.length} models (${buf.length} bytes)`
      )
      this.logModelNames(
        "AiService.AvailableModels response",
        response.modelNames
      )
      res.header("Content-Type", "application/proto")
      res.header("Connect-Protocol-Version", "1")
      res.status(200).send(buf)
    } catch (error) {
      this.logger.error("Error building AvailableModels:", error)
      this.sendEmpty(res)
    }
  }

  @Post("aiserver.v1.AiService/AvailableDocs")
  handleAvailableDocs(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/GetDefaultModelNudgeData")
  handleGetDefaultModelNudgeData(@Res() res: FastifyReply): void {
    const response = create(GetDefaultModelNudgeDataResponseSchema, {
      nudgeDate: "",
      shouldDefaultSwitchOnNewChat: false,
      modelsWithNoDefaultSwitch: [],
      conversionModelOverride: "",
    })
    this.sendProto(res, GetDefaultModelNudgeDataResponseSchema, response)
  }

  @Post("aiserver.v1.AiService/GetUserSettings")
  handleGetUserSettings(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/GetTrialUsageStatus")
  handleGetTrialUsageStatus(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/GetCurrentPeriodUsage")
  handleGetCurrentPeriodUsage(@Res() res: FastifyReply): void {
    const response = create(GetCurrentPeriodUsageResponseSchema, {})
    this.sendProto(res, GetCurrentPeriodUsageResponseSchema, response)
  }

  @Post("aiserver.v1.AiService/GetFeatureConfigs")
  handleGetFeatureConfigs(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/GetFeatureStatuses")
  handleGetFeatureStatuses(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/GetTeamCommands")
  handleGetTeamCommands(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/GetKnowledge")
  handleGetKnowledge(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/GetServerConfig")
  handleAiGetServerConfig(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/GetDefaultModel")
  handleGetDefaultModel(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/ServerTime")
  handleServerTime(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/TimeLeftHealthCheck")
  handleTimeLeftHealthCheck(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/UpdateVscodeProfile")
  handleUpdateVscodeProfile(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/GetHardLimit")
  handleGetHardLimit(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/RenameComposer")
  handleRenameComposer(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/GetGithubTokenAccess")
  handleGetGithubTokenAccess(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/GetConversationSummary")
  handleGetConversationSummary(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/MigrateKnowledge")
  handleMigrateKnowledge(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/NameTab")
  handleNameTab(@Req() req: FastifyRequest, @Res() res: FastifyReply): void {
    try {
      const body = req.body as Buffer | undefined
      if (body && body.length > 0) {
        const tabReq = fromBinary(NameTabRequestSchema, body)

        const firstUserMessage = tabReq.messages.find(
          (m) => m.text.trim().length > 0
        )

        if (firstUserMessage) {
          const tabName = this.deriveLocalTabName(firstUserMessage.text)
          if (tabName) {
            const response = create(NameTabResponseSchema, {
              name: tabName,
              reason: "",
              icon: "",
            })
            this.sendProto(res, NameTabResponseSchema, response)
            return
          }
        }
      }
    } catch (error) {
      this.logger.warn(
        `NameTab LLM generation failed, using fallback: ${String(error)}`
      )
    }
    // Fallback to static default
    const response = create(NameTabResponseSchema, {
      name: MOCK_DEFAULTS.tabName,
    })
    this.sendProto(res, NameTabResponseSchema, response)
  }

  @Post("aiserver.v1.AiService/CheckQueuePosition")
  handleCheckQueuePosition(@Res() res: FastifyReply): void {
    const response = create(CheckQueuePositionResponseSchema, {
      position: MOCK_DEFAULTS.queuePosition,
    })
    this.sendProto(res, CheckQueuePositionResponseSchema, response)
  }

  @Post("aiserver.v1.AiService/TaskGetInterfaceAgentStatus")
  handleTaskGetInterfaceAgentStatus(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/KnowledgeBaseAdd")
  handleKnowledgeBaseAdd(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply
  ): void {
    try {
      const body = req.body as Buffer | undefined
      if (body && body.length > 0) {
        const request = fromBinary(KnowledgeBaseAddRequestSchema, body)
        this.knowledgeBaseService.add(request.knowledge, request.title, false)
      }
      const response = create(KnowledgeBaseAddResponseSchema, {})
      this.sendProto(res, KnowledgeBaseAddResponseSchema, response)
    } catch (error) {
      this.logger.error(`KnowledgeBaseAdd failed: ${String(error)}`)
      this.sendEmpty(res)
    }
  }

  @Post("aiserver.v1.AiService/KnowledgeBaseGet")
  handleKnowledgeBaseGet(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply
  ): void {
    try {
      const body = req.body as Buffer | undefined
      if (body && body.length > 0) {
        const request = fromBinary(KnowledgeBaseGetRequestSchema, body)
        const item = this.knowledgeBaseService.get(request.id)
        if (item) {
          const response = create(KnowledgeBaseGetResponseSchema, {
            result: create(KnowledgeBaseGetResponse_ItemSchema, {
              id: item.id,
              knowledge: item.knowledge,
              title: item.title,
              createdAt: item.createdAt,
            }),
          })
          this.sendProto(res, KnowledgeBaseGetResponseSchema, response)
          return
        }
      }
      this.sendEmpty(res)
    } catch (error) {
      this.logger.error(`KnowledgeBaseGet failed: ${String(error)}`)
      this.sendEmpty(res)
    }
  }

  @Post("aiserver.v1.AiService/KnowledgeBaseList")
  handleKnowledgeBaseList(@Res() res: FastifyReply): void {
    try {
      const items = this.knowledgeBaseService.list()
      const protoItems = items.map((item) =>
        create(KnowledgeBaseListResponse_ItemSchema, {
          id: item.id,
          knowledge: item.knowledge,
          title: item.title,
          createdAt: item.createdAt,
          isGenerated: item.isGenerated,
        })
      )
      const response = create(KnowledgeBaseListResponseSchema, {
        allResults: protoItems,
      })
      this.sendProto(res, KnowledgeBaseListResponseSchema, response)
    } catch (error) {
      this.logger.error(`KnowledgeBaseList failed: ${String(error)}`)
      this.sendEmpty(res)
    }
  }

  @Post("aiserver.v1.AiService/KnowledgeBaseUpdate")
  handleKnowledgeBaseUpdate(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply
  ): void {
    try {
      const body = req.body as Buffer | undefined
      if (body && body.length > 0) {
        const request = fromBinary(KnowledgeBaseUpdateRequestSchema, body)
        this.knowledgeBaseService.update(
          request.id,
          request.knowledge,
          request.title
        )
      }
      const response = create(KnowledgeBaseUpdateResponseSchema, {})
      this.sendProto(res, KnowledgeBaseUpdateResponseSchema, response)
    } catch (error) {
      this.logger.error(`KnowledgeBaseUpdate failed: ${String(error)}`)
      this.sendEmpty(res)
    }
  }

  @Post("aiserver.v1.AiService/KnowledgeBaseRemove")
  handleKnowledgeBaseRemove(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply
  ): void {
    try {
      const body = req.body as Buffer | undefined
      if (body && body.length > 0) {
        const request = fromBinary(KnowledgeBaseRemoveRequestSchema, body)
        this.knowledgeBaseService.remove(request.id)
      }
      const response = create(KnowledgeBaseRemoveResponseSchema, {})
      this.sendProto(res, KnowledgeBaseRemoveResponseSchema, response)
    } catch (error) {
      this.logger.error(`KnowledgeBaseRemove failed: ${String(error)}`)
      this.sendEmpty(res)
    }
  }

  @Post("aiserver.v1.AiService/CppEditHistoryStatus")
  handleCppEditHistoryStatus(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/CppAppend")
  handleCppAppend(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/ReportBug")
  handleReportBug(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AiService/ReportClientNumericMetrics")
  handleReportClientNumericMetrics(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  // ── AuthService ──

  @Post("aiserver.v1.AuthService/MarkPrivacy")
  handleMarkPrivacy(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AuthService/GetAuth")
  handleGetAuth(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AuthService/RefreshToken")
  handleRefreshToken(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AuthService/GetEmail")
  handleGetEmail(@Res() res: FastifyReply): void {
    const response = create(GetEmailResponseSchema, {
      email: MOCK_DEFAULTS.email,
      signUpType: MOCK_DEFAULTS.signUpType,
    })
    this.sendProto(res, GetEmailResponseSchema, response)
  }

  // ── Other Services ──

  @Post("aiserver.v1.ServerConfigService/GetServerConfig")
  handleServerConfigGetServerConfig(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AnalyticsService/FlushEvents")
  handleFlushEvents(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AnalyticsService/Batch")
  handleBatch(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AnalyticsService/SubmitLogs")
  handleSubmitLogs(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.AnalyticsService/BootstrapStatsig")
  handleBootstrapStatsig(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.ToolCallEventService/SubmitToolCallEvents")
  handleSubmitToolCallEvents(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.TraceService/SubmitSpans")
  handleSubmitSpans(@Res() res: FastifyReply): void {
    const response = create(SubmitSpansResponseSchema, { success: true })
    this.sendProto(res, SubmitSpansResponseSchema, response)
  }

  @Post("aiserver.v1.ClientLoggerService/GetDebuggingDataUploadUrl")
  handleGetDebuggingDataUploadUrl(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.CppService/AvailableModels")
  handleCppAvailableModels(@Res() res: FastifyReply): void {
    const models = this.buildCursorModels().map((model) => model.name)
    const response = create(AvailableCppModelsResponseSchema, {
      models,
      defaultModel: DEFAULT_GEMINI_MODEL,
    })
    this.logModelNames("CppService.AvailableModels response", models)
    this.sendProto(res, AvailableCppModelsResponseSchema, response)
  }

  @Post(
    "aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings"
  )
  handleGetBackgroundComposerUserSettings(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.BackgroundComposerService/GetGithubAccessTokenForRepos")
  handleGetGithubAccessTokenForRepos(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.MCPRegistryService/GetKnownServers")
  handleGetKnownServers(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Post("aiserver.v1.InAppAdService/HasSeenAd")
  handleHasSeenAd(@Res() res: FastifyReply): void {
    const response = create(HasSeenAdResponseSchema, {
      hasSeen: MOCK_DEFAULTS.hasSeen,
    })
    this.sendProto(res, HasSeenAdResponseSchema, response)
  }

  // ── REST endpoints ──

  @Post("v1/traces")
  handleTraces(@Req() req: FastifyRequest, @Res() res: FastifyReply): void {
    // Accept both JSON and protobuf content types for OTLP traces
    res.status(200).send({})
  }

  @Get("updates/api/update/:platform/:product/:version/:machineId/:track")
  handleUpdateCheck(@Res() res: FastifyReply): void {
    // Cursor treats HTTP 204 as "already on latest version".
    res.status(204).send()
  }

  @Get("extensions-control")
  handleExtensionsControl(@Res() res: FastifyReply): void {
    res.header("Content-Type", "application/json")
    res.status(200).send({
      malicious: [],
      deprecated: {},
      search: [],
      migrateToPreRelease: {},
      extensionsEnabledWithPreRelease: [],
    })
  }

  // ── agent.v1 supplementary endpoints ──

  @Post("agent.v1.AgentService/GetNewChatNudgeLegacyModelPicker")
  handleGetNewChatNudgeLegacyModelPicker(@Res() res: FastifyReply): void {
    this.sendEmpty(res)
  }

  @Get("auth/full_stripe_profile")
  handleStripeProfile(@Res() res: FastifyReply): void {
    res.header("Content-Type", "application/json")
    res.send({
      membershipType: MOCK_DEFAULTS.membershipType,
      paymentId: "proxy-payment-id",
      daysRemainingOnTrial: 0,
      subscriptionStatus: MOCK_DEFAULTS.subscriptionStatus,
    })
  }

  // ── Helpers ──

  /**
   * Refresh model caches and backend availability with a timeout.
   * If the refresh completes within the timeout, the caller gets up-to-date data.
   * If it exceeds the timeout, the caller proceeds with cached data (no error thrown).
   *
   * Steps:
   * 1. Reload accounts from all backend config files (hot-reload new accounts)
   * 2. Recompute Google backend health from Cloud Code API
   * 3. Refresh Google model cache only when the backend is healthy
   */
  private async refreshModelsWithTimeout(timeoutMs: number): Promise<void> {
    const refresh = async () => {
      // 1. Hot-reload accounts from config files
      const openaiAdded = this.openaiCompatService.reloadAccounts()
      const codexAdded = this.codexService.reloadAccounts()
      const claudeChanges = await this.claudeApiService.reloadAccounts()

      if (openaiAdded + codexAdded + claudeChanges > 0) {
        this.logger.log(
          `[Model Refresh] Hot-reloaded accounts: openai-compat(add)=${openaiAdded}, codex(add)=${codexAdded}, claude-api(changes)=${claudeChanges}`
        )
      }

      // 2. Recompute Google backend availability from a real health check.
      const googleAvailable = await this.googleService.checkAvailability()
      this.modelRouter.updateGoogleAvailability(googleAvailable)

      // 3. Only refresh the cache when the backend is actually reachable.
      if (googleAvailable) {
        await this.googleModelCache.forceRefresh()
      }
    }

    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      if (timer && typeof timer.unref === "function") timer.unref()
    })

    try {
      await Promise.race([refresh(), timeout])
    } catch (error) {
      this.logger.debug(
        `Model refresh failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private sendEmpty(res: FastifyReply): void {
    res.header("Content-Type", "application/proto")
    res.header("Connect-Protocol-Version", "1")
    res.status(200).send(Buffer.alloc(0))
  }

  private sendProto<Desc extends DescMessage>(
    res: FastifyReply,
    schema: Desc,
    message: MessageShape<Desc>
  ): void {
    res.header("Content-Type", "application/proto")
    res.header("Connect-Protocol-Version", "1")
    res.status(200).send(Buffer.from(toBinary(schema, message)))
  }
}
