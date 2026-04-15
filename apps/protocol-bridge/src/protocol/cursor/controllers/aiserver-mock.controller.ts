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
  GetDefaultModelForCliResponseSchema,
  GetNewChatNudgeLegacyModelPickerResponseSchema,
  GetNewChatNudgeParameterizedModelPickerResponseSchema,
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
} from "../../../gen/agent/v1_pb"
import {
  AvailableCppModelsResponseSchema,
  AvailableModelsRequestSchema,
  AvailableModelsResponseSchema,
  AvailableModelsResponse_FeatureModelConfigSchema,
  AvailableModelsResponse_ModelPickerDisplayConfigurationSchema,
  AvailableModelsResponse_ModelPickerDisplayConfiguration_NamedModelsViewConfigSchema,
  AvailableModelsResponse_ModelPickerDisplayConfiguration_NamedModelsViewConfig_NamedViewToRoutedModelViewToggleSchema,
  AvailableModelsResponse_ModelPickerDisplayConfiguration_RoutedModelViewConfigSchema,
  AvailableModelsResponse_ModelPickerDisplayConfiguration_RoutedModelViewConfig_RoutedModelViewToNamedViewToggleSchema,
  AvailableModelsScope,
  BootstrapStatsigRequestSchema,
  BootstrapStatsigResponseSchema,
  CheckFeatureStatusRequestSchema,
  CheckFeatureStatusResponseSchema,
  CheckFeaturesStatusRequestSchema,
  CheckFeaturesStatusResponseSchema,
  CheckFeaturesStatusResponse_FeatureStatusSchema,
  CheckQueuePositionResponseSchema,
  GetCurrentPeriodUsageResponseSchema,
  GetDefaultModelNudgeDataResponseSchema,
  GetDefaultModelResponseSchema,
  GetEmailResponseSchema,
  GetEmailResponse_SignUpType,
  GetLastDefaultModelNudgeResponseSchema,
  GetModelLabelsResponseSchema,
  GetServerConfigResponseSchema,
  GetUsageLimitPolicyStatusResponseSchema,
  HasSeenAdResponseSchema,
  IsAllowedFreeTrialUsageResponseSchema,
  IsOnNewPricingResponseSchema,
  KnowledgeBaseAddRequestSchema,
  KnowledgeBaseAddResponseSchema,
  KnowledgeBaseGetRequestSchema,
  KnowledgeBaseGetResponseSchema,
  KnowledgeBaseGetResponse_ItemSchema,
  KnowledgeBaseListResponseSchema,
  KnowledgeBaseListResponse_ItemSchema,
  KnowledgeBaseRemoveRequestSchema,
  KnowledgeBaseRemoveResponseSchema,
  KnowledgeBaseUpdateRequestSchema,
  KnowledgeBaseUpdateResponseSchema,
  NameTabRequestSchema,
  NameTabResponseSchema,
  SubmitSpansResponseSchema,
} from "../../../gen/aiserver/v1_pb"
import { AnthropicApiService } from "../../../llm/anthropic/anthropic-api.service"
import { GoogleModelCacheService } from "../../../llm/google/google-model-cache.service"
import { GoogleService } from "../../../llm/google/google.service"
import { CodexService } from "../../../llm/openai/codex.service"
import { OpenaiCompatService } from "../../../llm/openai/openai-compat.service"
import {
  DEFAULT_GEMINI_MODEL,
  canPublicClaudeModelUseGoogle,
  getCursorDisplayModels,
  resolveCloudCodeModel,
} from "../../../llm/shared/model-registry"
import { ModelRouterService } from "../../../llm/shared/model-router.service"
import {
  appendRequestedCursorModels,
  buildCursorAvailableModel,
  buildCursorModelLabel,
  buildCursorUsableModel,
  buildLegacyCursorAvailableModels,
  resolveCursorDefaultSelection,
  selectPreferredCursorModelName,
} from "../cursor-model-protocol"
import { KnowledgeBaseService } from "../knowledge-base.service"

const ENABLED_CURSOR_FEATURES = new Set<string>([
  "react_shell_tool",
  "compact_terminal",
  "long_running_jobs",
  // 注意：不启用 "use_model_parameters"！
  // Cursor 源码：P=use_model_parameters, N=use_react_model_picker, F=P||N
  // 设置页：F() ? (P() ? clientDisplayName : variants[0].displayName) : ...
  // P()=false + N()=true → 走 variants[0].displayName → 渲染 :icon-brain: 变体效果
  "use_react_model_picker",
])

/**
 * Models that are enabled by default in the model picker.
 * GPT-5.4 variants (High Fast, Extra high Fast, etc.) must be enabled
 * manually in Cursor UI because defaultOn only works at the model level.
 */
const DEFAULT_ON_MODELS = new Set<string>(["gemini-3.1-pro-high"])

function buildStatsigBootstrapConfig(
  featureGates: Iterable<string>,
  userID: string
): string {
  const now = Date.now()

  // Statsig SDK 内部使用 DJB2 hash 作为 feature gate 的查找 key。
  // _getDetailedStoreResult 先用原名查找，再用 hash 查找。
  // 为了确保运行时 checkFeatureGate 能正确命中，
  // 同时提供原名和 DJB2 hash 两种 key。
  const statsigFeatureGates: Record<
    string,
    {
      value: boolean
      rule_id: string
      id_type: string
      name?: string
    }
  > = {}

  const registerFeatureGate = (name: string, value: boolean) => {
    const entry = {
      value,
      rule_id: "protocol-bridge",
      id_type: "userID",
      name,
    }
    // 原名 key
    statsigFeatureGates[name] = entry
    // DJB2 hash key（statsig SDK 的 fallback 查找路径）
    statsigFeatureGates[djb2Hash(name)] = entry
  }

  for (const name of featureGates) {
    registerFeatureGate(name, true)
  }

  const payloadBody = {
    feature_gates: statsigFeatureGates,
    dynamic_configs: {},
    layer_configs: {},
    exposures: {},
    sdkInfo: {
      sdkType: "js-client",
      sdkVersion: "protocol-bridge",
    },
    user: {
      userID,
    },
  }
  const payload = {
    // Cursor 内置 statsig store 在 setValues() 中会对 n.data 再做一次
    // fDt(n.data, "has_updates", "EvaluationResponse") 检查，
    // 所以内层 data 也必须带 has_updates。
    ...payloadBody,
    has_updates: true,
    time: now,
  }

  return JSON.stringify({
    // 同时保留顶层字段，尽量兼容旧缓存/旧消费路径。
    ...payloadBody,
    time: now,
    has_updates: true,
    // Cursor 当前内置的 statsig adapter 走 setData() 时，
    // 先读取顶层 data，再把 n.data 交给 statsig store。
    // statsig store 又要求 n.data 自身也有 has_updates。
    // 所以正确形状是 { has_updates: true, data: { has_updates: true, ... } }。
    data: payload,
  })
}

/**
 * DJB2 hash — statsig SDK 内部用来查找 feature gate 的 hash 函数。
 * 和 Cursor 前端中的 Clt 函数完全一致。
 */
function djb2Hash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32bit integer
  }
  return String(hash >>> 0)
}

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
  /** Preferred default model shown in pickers when available */
  defaultModel: "gpt-5.4",
} as const

interface ParsedAvailableModelsRequest {
  isNightly: boolean
  includeLongContextModels: boolean
  excludeMaxNamedModels: boolean
  useModelParameters: boolean
  useReactModelPicker: boolean
  variantsWillBeShownInExplodedList: boolean
  additionalModelNames: string[]
  includeHiddenModels: boolean
  doNotUseMarkdown: boolean
  forAutomations: boolean
  scope?: AvailableModelsScope
}
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
    private readonly anthropicApiService: AnthropicApiService,
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

  private parseAvailableModelsRequest(
    req?: FastifyRequest
  ): ParsedAvailableModelsRequest {
    const parsed: ParsedAvailableModelsRequest = {
      isNightly: false,
      includeLongContextModels: false,
      excludeMaxNamedModels: false,
      useModelParameters: false,
      useReactModelPicker: false,
      variantsWillBeShownInExplodedList: false,
      additionalModelNames: [],
      includeHiddenModels: false,
      doNotUseMarkdown: false,
      forAutomations: false,
      scope: undefined,
    }
    const body = req?.body
    if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
      try {
        const request = fromBinary(
          AvailableModelsRequestSchema,
          new Uint8Array(body)
        )
        parsed.isNightly = request.isNightly
        parsed.includeLongContextModels = request.includeLongContextModels
        parsed.excludeMaxNamedModels = !!request.excludeMaxNamedModels
        parsed.useModelParameters = !!request.useModelParameters
        parsed.useReactModelPicker = !!request.useReactModelPicker
        parsed.variantsWillBeShownInExplodedList =
          !!request.variantsWillBeShownInExplodedList
        parsed.additionalModelNames = request.additionalModelNames
        parsed.includeHiddenModels = !!request.includeHiddenModels
        parsed.doNotUseMarkdown = !!request.doNotUseMarkdown
        parsed.forAutomations = !!request.forAutomations
        parsed.scope = request.scope
      } catch (error) {
        this.logger.debug(
          `AvailableModels request parse failed, using defaults: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    return parsed
  }

  private buildCursorModels(options?: {
    excludeMaxNamedModels?: boolean
    additionalModelNames?: string[]
    filterRoutable?: boolean
    includeHiddenModels?: boolean
    includeLongContextModels?: boolean
    forAutomations?: boolean
  }) {
    let models = appendRequestedCursorModels(
      getCursorDisplayModels({
        includeCodex: this.isGptBackendAvailable(),
        codexModelTier: this.getCursorGptModelTier(),
        excludeMaxNamedModels: options?.excludeMaxNamedModels ?? false,
        extraModels: this.anthropicApiService.getCursorDisplayModels(),
      }),
      options?.additionalModelNames
    )

    if (!options?.includeHiddenModels) {
      models = models.filter((model) => !model.isHidden || model.isUserAdded)
    }

    if (!options?.includeLongContextModels) {
      models = models.filter((model) => !model.isLongContextOnly)
    }

    if (options?.forAutomations) {
      models = models.filter((model) => model.supportsAgent !== false)
    }

    if (options?.filterRoutable === false) {
      return models
    }

    return models.filter((model) =>
      this.isCursorModelCurrentlyRoutable(model.name)
    )
  }

  private shouldFilterRoutableModels(
    request?: Pick<ParsedAvailableModelsRequest, "scope">
  ): boolean {
    void request
    return true
  }

  private parseGetUsableModelsRequest(req?: FastifyRequest): string[] {
    const body = req?.body
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

  private getPreferredDefaultModelName(
    models: Array<{ name: string; family: string; isThinking: boolean }>
  ): string {
    return selectPreferredCursorModelName(models, [
      MOCK_DEFAULTS.defaultModel,
      "gpt-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "gemini-2.5-pro",
    ])
  }

  private getNamedModelSectionIndex(family: string): number {
    switch (family) {
      case "gpt":
        return 0
      case "claude":
        return 1
      case "gemini":
        return 2
      default:
        return 3
    }
  }

  private buildFeatureModelConfig(
    defaultModel: string,
    models: Array<{ name: string; isThinking: boolean }>
  ) {
    return create(AvailableModelsResponse_FeatureModelConfigSchema, {
      defaultModel,
      fallbackModels: models.map((model) => model.name),
      bestOfNDefaultModels: models
        .filter((model) => model.isThinking)
        .map((model) => model.name)
        .slice(0, 3),
    })
  }

  private buildModelPickerDisplayConfiguration() {
    return create(
      AvailableModelsResponse_ModelPickerDisplayConfigurationSchema,
      {
        namedModelsViewConfig: create(
          AvailableModelsResponse_ModelPickerDisplayConfiguration_NamedModelsViewConfigSchema,
          {
            namedViewToRoutedModelViewToggle: create(
              AvailableModelsResponse_ModelPickerDisplayConfiguration_NamedModelsViewConfig_NamedViewToRoutedModelViewToggleSchema,
              {
                markdown: "Auto",
              }
            ),
          }
        ),
        routedModelViewConfig: create(
          AvailableModelsResponse_ModelPickerDisplayConfiguration_RoutedModelViewConfigSchema,
          {
            hideSearchBar: false,
            routedModelViewToNamedViewToggle: create(
              AvailableModelsResponse_ModelPickerDisplayConfiguration_RoutedModelViewConfig_RoutedModelViewToNamedViewToggleSchema,
              {
                titleMarkdown: "Auto",
                subtitle:
                  "Balanced quality and speed, recommended for most tasks",
                setToLastNamedModel: true,
              }
            ),
          }
        ),
      }
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
      const request = this.parseAvailableModelsRequest(req)
      const allModels = this.buildCursorModels({
        excludeMaxNamedModels: request.excludeMaxNamedModels,
        additionalModelNames: request.additionalModelNames,
        filterRoutable: this.shouldFilterRoutableModels(request),
        includeHiddenModels: request.includeHiddenModels,
        includeLongContextModels: request.includeLongContextModels,
        forAutomations: request.forAutomations,
      })
      const defaultSelection = resolveCursorDefaultSelection(allModels, [
        MOCK_DEFAULTS.defaultModel,
        "gpt-5",
        "claude-sonnet-4-6",
        "claude-sonnet-4-5",
        "gemini-2.5-pro",
      ])
      const parameterizedMode = request.useModelParameters

      this.logger.debug(
        `AvailableModels request flags: nightly=${request.isNightly}, reactPicker=${request.useReactModelPicker}, useModelParameters=${request.useModelParameters}, variantsExploded=${request.variantsWillBeShownInExplodedList}, includeLongContext=${request.includeLongContextModels}, excludeMaxNamedModels=${request.excludeMaxNamedModels}, includeHidden=${request.includeHiddenModels}, doNotUseMarkdown=${request.doNotUseMarkdown}, forAutomations=${request.forAutomations}, scope=${request.scope ?? "unspecified"}, additionalModelNames=${request.additionalModelNames.join(",") || "(none)"}`
      )

      const protoModels = allModels.flatMap((model) => {
        // GPT 变体需要展开成多个顶层模型项，
        // 设置页通过 variant displayName 的 HTML :icon-brain: 标记渲染变体效果
        if (model.family === "gpt") {
          return buildLegacyCursorAvailableModels(
            model,
            this.getNamedModelSectionIndex(model.family),
            {
              defaultOn: false,
              preferredDefaultModelName: defaultSelection.model,
              defaultOnFastEfforts:
                model.name === "gpt-5.4"
                  ? new Set(["high", "xhigh"])
                  : undefined,
            }
          )
        }

        // 非 GPT 模型使用 grouped 结构
        return [
          buildCursorAvailableModel(
            model,
            this.getNamedModelSectionIndex(model.family),
            {
              includeParameterDefinitions: parameterizedMode,
              includeVariants: true,
              defaultOn: DEFAULT_ON_MODELS.has(model.name),
            }
          ),
        ]
      })
      const featureModelConfig = this.buildFeatureModelConfig(
        defaultSelection.model,
        allModels
      )
      // 官方 AvailableModels 响应不包含 useModelParameters 字段。
      // Cursor 客户端从 statsig feature gate 获取这些值并持久化。
      // 我们不设置此字段，避免覆盖客户端的正确缓存。
      const response = create(AvailableModelsResponseSchema, {
        modelNames: protoModels.map((m) => m.name),
        models: protoModels,
        composerModelConfig: featureModelConfig,
        cmdKModelConfig: featureModelConfig,
        backgroundComposerModelConfig: featureModelConfig,
        planExecutionModelConfig: featureModelConfig,
        specModelConfig: featureModelConfig,
        deepSearchModelConfig: featureModelConfig,
        quickAgentModelConfig: featureModelConfig,
        displayConfiguration: this.buildModelPickerDisplayConfiguration(),
      })
      const buf = Buffer.from(toBinary(AvailableModelsResponseSchema, response))
      this.logger.log(
        `AvailableModels: ${allModels.length} models (${buf.length} bytes, default=${defaultSelection.model}, thinking=${defaultSelection.thinkingModel})`
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

  @Post("aiserver.v1.AiService/CheckFeatureStatus")
  handleCheckFeatureStatus(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply
  ): void {
    let featureName = ""
    const body = req.body
    if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
      try {
        const request = fromBinary(
          CheckFeatureStatusRequestSchema,
          new Uint8Array(body)
        )
        featureName = request.featureName
      } catch (error) {
        this.logger.debug(
          `CheckFeatureStatus request parse failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    const response = create(CheckFeatureStatusResponseSchema, {
      enabled: ENABLED_CURSOR_FEATURES.has(featureName),
    })
    this.sendProto(res, CheckFeatureStatusResponseSchema, response)
  }

  @Post("aiserver.v1.AiService/GetFeatureStatuses")
  handleGetFeatureStatuses(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply
  ): void {
    let featureNames: string[] = []
    const body = req.body
    if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
      try {
        const request = fromBinary(
          CheckFeaturesStatusRequestSchema,
          new Uint8Array(body)
        )
        featureNames = request.featureNames
      } catch (error) {
        this.logger.debug(
          `GetFeatureStatuses request parse failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    const response = create(CheckFeaturesStatusResponseSchema, {
      featureStatuses: featureNames.map((featureName) =>
        create(CheckFeaturesStatusResponse_FeatureStatusSchema, {
          featureName,
          enabled: ENABLED_CURSOR_FEATURES.has(featureName),
        })
      ),
    })
    this.sendProto(res, CheckFeaturesStatusResponseSchema, response)
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
    const response = create(GetServerConfigResponseSchema, {
      configVersion: "protocol-bridge",
      isDevDoNotUseForSecretThingsBecauseCanBeSpoofedByUsers: true,
      useNlbForNal: false,
      runTerminalServerConfig: {
        compositeShellCommands: ["&&", "||", ";", "|"],
        safeShellCommands: [],
      },
    })
    this.sendProto(res, GetServerConfigResponseSchema, response)
  }

  @Post("aiserver.v1.AiService/GetDefaultModel")
  handleGetDefaultModel(@Res() res: FastifyReply): void {
    const models = this.buildCursorModels()
    const selection = resolveCursorDefaultSelection(models, [
      MOCK_DEFAULTS.defaultModel,
      "gpt-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "gemini-2.5-pro",
    ])
    const response = create(GetDefaultModelResponseSchema, {
      model: selection.model,
      thinkingModel: selection.thinkingModel,
      maxMode: selection.maxMode,
      nextDefaultSetDate: "",
    })
    this.sendProto(res, GetDefaultModelResponseSchema, response)
  }

  @Post("aiserver.v1.AiService/GetLastDefaultModelNudge")
  handleGetLastDefaultModelNudge(@Res() res: FastifyReply): void {
    const response = create(GetLastDefaultModelNudgeResponseSchema, {
      nudgeDate: "",
    })
    this.sendProto(res, GetLastDefaultModelNudgeResponseSchema, response)
  }

  @Post("aiserver.v1.AiService/GetUsableModels")
  handleAiGetUsableModels(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply
  ): void {
    const customModelIds = this.parseGetUsableModelsRequest(req)
    const models = this.buildCursorModels({
      additionalModelNames: customModelIds,
    }).map((model) => buildCursorUsableModel(model))
    const response = create(GetUsableModelsResponseSchema, { models })
    this.sendProto(res, GetUsableModelsResponseSchema, response)
  }

  @Post("aiserver.v1.AiService/GetDefaultModelForCli")
  handleGetDefaultModelForCli(@Res() res: FastifyReply): void {
    const models = this.buildCursorModels()
    const selection = resolveCursorDefaultSelection(models, [
      MOCK_DEFAULTS.defaultModel,
      "gpt-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "gemini-2.5-pro",
    ])
    const selectedModel =
      models.find((model) => model.name === selection.model) || models[0]
    const response = create(GetDefaultModelForCliResponseSchema, {
      model: selectedModel ? buildCursorUsableModel(selectedModel) : undefined,
    })
    this.sendProto(res, GetDefaultModelForCliResponseSchema, response)
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

  @Post("aiserver.v1.AiService/GetModelLabels")
  handleGetModelLabels(@Res() res: FastifyReply): void {
    const response = create(GetModelLabelsResponseSchema, {
      modelLabels: this.buildCursorModels({ filterRoutable: false }).map(
        (model) => buildCursorModelLabel(model)
      ),
    })
    this.sendProto(res, GetModelLabelsResponseSchema, response)
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
    const response = create(GetServerConfigResponseSchema, {
      configVersion: "protocol-bridge",
      isDevDoNotUseForSecretThingsBecauseCanBeSpoofedByUsers: true,
      useNlbForNal: false,
      runTerminalServerConfig: {
        compositeShellCommands: ["&&", "||", ";", "|"],
        safeShellCommands: [],
      },
    })
    this.sendProto(res, GetServerConfigResponseSchema, response)
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
  handleBootstrapStatsig(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply
  ): void {
    let ignoreDevStatus = false
    let operatingSystem = "unknown"
    let statsigUserID: string = MOCK_DEFAULTS.email
    const authHeader = req.headers.authorization
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.slice("Bearer ".length)
        const payload = JSON.parse(
          Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")
        ) as { sub?: string }
        if (typeof payload.sub === "string" && payload.sub.length > 0) {
          statsigUserID = payload.sub
        }
      } catch (error) {
        this.logger.debug(
          `BootstrapStatsig auth parse failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    const body = req.body
    if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
      try {
        const request = fromBinary(
          BootstrapStatsigRequestSchema,
          new Uint8Array(body)
        )
        ignoreDevStatus = request.ignoreDevStatus === true
        operatingSystem =
          request.operatingSystem === undefined
            ? "unknown"
            : String(request.operatingSystem)
      } catch (error) {
        this.logger.debug(
          `BootstrapStatsig request parse failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    const config = buildStatsigBootstrapConfig(
      ENABLED_CURSOR_FEATURES,
      statsigUserID
    )
    const response = create(BootstrapStatsigResponseSchema, {
      config,
      generatedAtMs: BigInt(Date.now()),
    })

    this.logger.debug(
      `BootstrapStatsig: ignoreDevStatus=${ignoreDevStatus}, operatingSystem=${operatingSystem}, enabledGates=${Array.from(ENABLED_CURSOR_FEATURES).join(",")}`
    )
    this.sendProto(res, BootstrapStatsigResponseSchema, response)
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
    const response = create(GetNewChatNudgeLegacyModelPickerResponseSchema, {})
    this.sendProto(
      res,
      GetNewChatNudgeLegacyModelPickerResponseSchema,
      response
    )
  }

  @Post("agent.v1.AgentService/GetNewChatNudgeParameterizedModelPicker")
  handleGetNewChatNudgeParameterizedModelPicker(
    @Res() res: FastifyReply
  ): void {
    const response = create(
      GetNewChatNudgeParameterizedModelPickerResponseSchema,
      {}
    )
    this.sendProto(
      res,
      GetNewChatNudgeParameterizedModelPickerResponseSchema,
      response
    )
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
      const claudeChanges = await this.anthropicApiService.reloadAccounts()

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
