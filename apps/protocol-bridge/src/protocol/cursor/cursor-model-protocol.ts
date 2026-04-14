import { create } from "@bufbuild/protobuf"
import {
  ModelDetailsSchema,
  RequestedModel_ModelParameterValueSchema,
  ThinkingDetailsSchema,
  type ModelDetails,
  type RequestedModel_ModelParameterValue,
} from "../../gen/agent/v1_pb"
import {
  AvailableModelsResponse_AvailableModelSchema,
  AvailableModelsResponse_ModelVariantConfigSchema,
  CloudAgentEffortMode,
  GetModelLabelsResponse_ModelLabelSchema,
  ModelParameterDefinition_BooleanParameterDefinitionSchema,
  ModelParameterDefinition_EnumParameterDefinition_EnumParameterValueSchema,
  ModelParameterDefinition_EnumParameterDefinitionSchema,
  ModelParameterDefinition_ModelParameterTypeSchema,
  ModelParameterDefinitionSchema,
  type AvailableModelsResponse_AvailableModel,
  type AvailableModelsResponse_ModelVariantConfig,
  type GetModelLabelsResponse_ModelLabel,
} from "../../gen/aiserver/v1_pb"
import {
  getCursorDisplayModel,
  resolveCloudCodeModel,
  resolveModelThinkingCapability,
  type CursorDisplayModel,
} from "../../llm/shared/model-registry"
import { parseModelRequest } from "../../llm/shared/model-request"
export { BASE_CODEX_CURSOR_DISPLAY_MODELS } from "../../llm/shared/model-registry"

export const CURSOR_REASONING_PARAMETER_ID = "thinking"
export const CURSOR_LEGACY_REASONING_PARAMETER_ID = "reasoning_effort"
export const CURSOR_FAST_PARAMETER_ID = "fast"
export const STANDARD_SERVICE_TIER = "standard"
export const PRIORITY_SERVICE_TIER = "priority"
export const CURSOR_FAST_MODE_ENABLED = "true"
export const CURSOR_FAST_MODE_DISABLED = "false"
const CURSOR_LEGACY_VARIANT_SUFFIXES = [
  "-high-thinking",
  "-xhigh-fast",
  "-high-fast",
  "-low-fast",
  "-thinking",
  "-text",
  "-fast",
  "-xhigh",
  "-high",
  "-low",
  "-medium",
] as const
const STANDARD_EFFORT_ORDER = [
  "low",
  "medium",
  "minimal",
  "none",
  "high",
  "xhigh",
  "max",
]

function isExplicitMaxNamedModel(modelName: string): boolean {
  const normalized = parseModelRequest(modelName).normalizedBaseModel
  return normalized.includes("-max") || normalized.endsWith("max")
}

export function isCursorModelMaxMode(modelName: string): boolean {
  return isExplicitMaxNamedModel(modelName)
}

function formatFallbackModelName(modelName: string): string {
  const baseModel = parseModelRequest(modelName).baseModel
  return baseModel
    .split("-")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment === "gpt") return "GPT"
      if (segment === "codex") return "Codex"
      if (segment === "claude") return "Claude"
      if (segment === "gemini") return "Gemini"
      if (segment === "mini") return "Mini"
      if (segment === "max") return "Max"
      if (segment === "spark") return "Spark"
      return segment.charAt(0).toUpperCase() + segment.slice(1)
    })
    .join(" ")
}

function resolveEffortValues(modelName: string): string[] {
  const capability = resolveModelThinkingCapability(modelName)
  if (!capability) {
    return []
  }

  const values: string[] = []
  if (capability.dynamicAllowed) {
    values.push("auto")
  }
  for (const level of capability.levels || []) {
    if (!level || values.includes(level)) {
      continue
    }
    values.push(level)
  }
  return values
}

function selectEffortValue(
  values: readonly string[],
  order: readonly string[]
): string | null {
  for (const candidate of order) {
    if (values.includes(candidate)) {
      return candidate
    }
  }
  return values[0] || null
}

function getEffortDisplayName(value: string): string {
  switch (value) {
    case "auto":
      return "Auto"
    case "none":
      return "Off"
    case "minimal":
      return "Minimal"
    case "low":
      return "Low"
    case "medium":
      return "Medium"
    case "high":
      return "High"
    case "xhigh":
    case "extra_high":
    case "extra-high":
      return "Extra high"
    case "max":
      return "Max"
    default:
      return value
  }
}

function toCursorReasoningValue(value: string): string {
  switch (value) {
    case "xhigh":
      return "extra-high"
    default:
      return value
  }
}

function normalizeVariantToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
}

function normalizeVariantReasoningEffort(value: string): string | undefined {
  switch (normalizeVariantToken(value)) {
    case "auto":
      return "auto"
    case "none":
    case "off":
    case "disabled":
      return "none"
    case "minimal":
    case "min":
      return "minimal"
    case "low":
      return "low"
    case "medium":
    case "med":
    case "normal":
    case "standard":
      return "medium"
    case "high":
      return "high"
    case "xhigh":
    case "extra_high":
    case "extra":
      return "xhigh"
    case "max":
      return "max"
    default:
      return undefined
  }
}

function normalizeVariantServiceTier(value: string): string | undefined {
  switch (normalizeVariantToken(value)) {
    case "priority":
    case "fast":
    case "enabled":
    case "on":
    case "true":
    case "1":
      return PRIORITY_SERVICE_TIER
    case "standard":
    case "default":
    case "disabled":
    case "off":
    case "false":
    case "0":
      return STANDARD_SERVICE_TIER
    default:
      return undefined
  }
}

function normalizeVariantFastMode(value: string): string | undefined {
  const booleanValue = normalizeVariantBoolean(value)
  if (booleanValue !== undefined) {
    return booleanValue ? CURSOR_FAST_MODE_ENABLED : CURSOR_FAST_MODE_DISABLED
  }

  const serviceTier = normalizeVariantServiceTier(value)
  if (serviceTier === PRIORITY_SERVICE_TIER) {
    return CURSOR_FAST_MODE_ENABLED
  }
  if (serviceTier === STANDARD_SERVICE_TIER) {
    return CURSOR_FAST_MODE_DISABLED
  }

  return undefined
}

function normalizeVariantBoolean(value: string): boolean | undefined {
  switch (normalizeVariantToken(value)) {
    case "1":
    case "true":
    case "enabled":
    case "on":
    case "yes":
      return true
    case "0":
    case "false":
    case "disabled":
    case "off":
    case "no":
      return false
    default:
      return undefined
  }
}

export function parseCursorVariantString(modelId: string): {
  baseModel: string
  parameterValues?: Record<string, string>
  maxMode?: boolean
} | null {
  const trimmed = (modelId || "").trim()
  if (!trimmed) {
    return null
  }

  const bracketSelection = parseBracketCursorVariantString(trimmed)
  if (bracketSelection) {
    return bracketSelection
  }

  return parseLegacyCursorVariantModelName(trimmed)
}

function parseBracketCursorVariantString(modelId: string): {
  baseModel: string
  parameterValues?: Record<string, string>
  maxMode?: boolean
} | null {
  const parsedModel = parseModelRequest(modelId)
  let baseModel = ""
  let rawSuffix = ""

  if (parsedModel.hasSuffix) {
    const trimmed = parsedModel.rawModel.trim()
    const lastOpen = trimmed.lastIndexOf("(")
    if (lastOpen <= 0 || !trimmed.endsWith(")")) {
      return null
    }
    baseModel = parsedModel.baseModel
    rawSuffix = trimmed.slice(lastOpen + 1, -1).trim()
  } else {
    const lastOpen = modelId.lastIndexOf("[")
    if (lastOpen <= 0 || !modelId.endsWith("]")) {
      return null
    }
    baseModel = modelId.slice(0, lastOpen).trim()
    rawSuffix = modelId.slice(lastOpen + 1, -1).trim()
  }

  if (!baseModel || !rawSuffix) {
    return null
  }

  const parts = rawSuffix
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

  if (parts.length === 0) {
    return null
  }

  const parameterValues: Record<string, string> = {}
  let maxMode: boolean | undefined

  for (const part of parts) {
    const separatorIndex = part.indexOf("=")
    if (separatorIndex <= 0) {
      const effort = normalizeVariantReasoningEffort(part)
      if (effort) {
        parameterValues[CURSOR_REASONING_PARAMETER_ID] =
          toCursorReasoningValue(effort)
      }
      continue
    }

    const key = normalizeVariantToken(part.slice(0, separatorIndex))
    const rawValue = part.slice(separatorIndex + 1).trim()
    if (!key || !rawValue) {
      continue
    }

    if (
      key === CURSOR_REASONING_PARAMETER_ID ||
      key === CURSOR_LEGACY_REASONING_PARAMETER_ID ||
      key === "reasoning" ||
      key === "reasoning_level" ||
      key === "effort" ||
      key === "thinking_effort"
    ) {
      const effort = normalizeVariantReasoningEffort(rawValue)
      if (effort) {
        parameterValues[CURSOR_REASONING_PARAMETER_ID] =
          toCursorReasoningValue(effort)
      }
      continue
    }

    if (
      key === CURSOR_FAST_PARAMETER_ID ||
      key === "service_tier" ||
      key === "tier" ||
      key === "fast" ||
      key === "fast_mode"
    ) {
      const fastMode = normalizeVariantFastMode(rawValue)
      if (fastMode) {
        parameterValues[CURSOR_FAST_PARAMETER_ID] = fastMode
      }
      continue
    }

    if (key === "max" || key === "max_mode") {
      const normalized = normalizeVariantBoolean(rawValue)
      if (normalized !== undefined) {
        maxMode = normalized
      }
    }
  }

  return {
    baseModel,
    parameterValues:
      Object.keys(parameterValues).length > 0 ? parameterValues : undefined,
    maxMode,
  }
}

function supportsCursorFastMode(model: CursorDisplayModel): boolean {
  return model.family === "gpt"
}

function parseLegacyCursorVariantModelName(modelId: string): {
  baseModel: string
  parameterValues?: Record<string, string>
  maxMode?: boolean
} | null {
  if (getCursorDisplayModel(modelId)) {
    return null
  }

  const normalizedModelId = modelId.trim().toLowerCase()

  for (const suffix of CURSOR_LEGACY_VARIANT_SUFFIXES) {
    if (!normalizedModelId.endsWith(suffix)) {
      continue
    }

    const baseModel = modelId.slice(0, modelId.length - suffix.length).trim()
    if (!baseModel) {
      return null
    }

    const parameterValues: Record<string, string> = {}

    switch (suffix) {
      case "-medium":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "medium"
        break
      case "-low":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "low"
        break
      case "-high":
      case "-high-thinking":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "high"
        break
      case "-xhigh":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "extra-high"
        break
      case "-thinking":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "medium"
        break
      case "-xhigh-fast":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "extra-high"
        parameterValues[CURSOR_FAST_PARAMETER_ID] = CURSOR_FAST_MODE_ENABLED
        break
      case "-high-fast":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "high"
        parameterValues[CURSOR_FAST_PARAMETER_ID] = CURSOR_FAST_MODE_ENABLED
        break
      case "-low-fast":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "low"
        parameterValues[CURSOR_FAST_PARAMETER_ID] = CURSOR_FAST_MODE_ENABLED
        break
      case "-fast":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "medium"
        parameterValues[CURSOR_FAST_PARAMETER_ID] = CURSOR_FAST_MODE_ENABLED
        break
      case "-text":
        parameterValues[CURSOR_REASONING_PARAMETER_ID] = "none"
        break
      default:
        break
    }

    if (
      !Object.prototype.hasOwnProperty.call(
        parameterValues,
        CURSOR_FAST_PARAMETER_ID
      )
    ) {
      parameterValues[CURSOR_FAST_PARAMETER_ID] = CURSOR_FAST_MODE_DISABLED
    }

    return {
      baseModel,
      parameterValues,
      maxMode: false,
    }
  }

  return null
}

function buildReasoningParameterDefinition(modelName: string) {
  const values = resolveEffortValues(modelName)
  if (values.length <= 1) {
    return []
  }

  return [
    create(ModelParameterDefinitionSchema, {
      id: CURSOR_REASONING_PARAMETER_ID,
      name: "Reasoning Effort",
      markdownTooltip: "Controls Codex reasoning depth for this model.",
      isCycleableByHotkey: true,
      parameterType: create(ModelParameterDefinition_ModelParameterTypeSchema, {
        enumParameter: create(
          ModelParameterDefinition_EnumParameterDefinitionSchema,
          {
            values: values.map((value) =>
              create(
                ModelParameterDefinition_EnumParameterDefinition_EnumParameterValueSchema,
                {
                  value: toCursorReasoningValue(value),
                  displayName: getEffortDisplayName(value),
                }
              )
            ),
          }
        ),
      }),
    }),
  ]
}

function buildFastModeParameterDefinition(model: CursorDisplayModel) {
  if (!supportsCursorFastMode(model)) {
    return []
  }

  return [
    create(ModelParameterDefinitionSchema, {
      id: CURSOR_FAST_PARAMETER_ID,
      name: "Fast Mode",
      markdownTooltip:
        "Uses Codex priority service tier for faster inference when available.",
      parameterType: create(ModelParameterDefinition_ModelParameterTypeSchema, {
        booleanParameter: create(
          ModelParameterDefinition_BooleanParameterDefinitionSchema,
          {}
        ),
      }),
    }),
  ]
}

/**
 * 构建 Cursor 官方格式的变体 displayName。
 *
 * Cursor 前端通过 variant displayName / displayNameOutsidePicker 中的
 * HTML `<span>` + `:icon-brain:` 标记来渲染设置页和聊天界面里的变体效果
 * 图标和副文案。格式参考官方日志中的实际响应：
 *
 *   Composer 2 <span style="color: var(--cursor-text-tertiary); font-size: 0.85em;">:icon-brain: Fast</span>
 *   Grok 4.20 <span style="color: var(--cursor-text-tertiary); font-size: 0.85em;">:icon-brain:</span>
 */
function buildVariantRichDisplayName(
  baseDisplayName: string,
  effort: string | null,
  fastMode: boolean
): string {
  const labelParts: string[] = []

  if (effort) {
    labelParts.push(getEffortDisplayName(effort))
  }
  if (fastMode) {
    labelParts.push("Fast")
  }

  const suffix = labelParts.length > 0 ? ` ${labelParts.join(" ")}` : ""

  return `${baseDisplayName} <span style="color: var(--cursor-text-tertiary); font-size: 0.85em;">:icon-brain:${suffix}</span>`
}

function buildVariant(
  modelName: string,
  effort: string | null,
  options: {
    displayName: string
    displayNameOutsidePicker?: string
    fastMode?: boolean
    isMaxMode: boolean
    isDefaultMaxConfig?: boolean
    isDefaultNonMaxConfig?: boolean
  }
) {
  const fastMode = options.fastMode === true
  const cursorEffort = effort ? toCursorReasoningValue(effort) : null
  const richDisplayName = buildVariantRichDisplayName(
    options.displayName,
    effort,
    fastMode
  )
  const richOutsidePicker = buildVariantRichDisplayName(
    options.displayNameOutsidePicker || options.displayName,
    effort,
    fastMode
  )
  const parameterValues = [
    effort
      ? create(RequestedModel_ModelParameterValueSchema, {
          id: CURSOR_REASONING_PARAMETER_ID,
          value: cursorEffort!,
        })
      : null,
    create(RequestedModel_ModelParameterValueSchema, {
      id: CURSOR_FAST_PARAMETER_ID,
      value: fastMode ? CURSOR_FAST_MODE_ENABLED : CURSOR_FAST_MODE_DISABLED,
    }),
  ].filter(
    (value): value is RequestedModel_ModelParameterValue => value !== null
  )

  const baseTagline = effort ? `${getEffortDisplayName(effort)} reasoning` : ""
  const tagline = fastMode
    ? baseTagline
      ? `${baseTagline}, Fast mode`
      : "Fast mode"
    : baseTagline || undefined
  const baseModelName = parseModelRequest(modelName).baseModel
  const variantSegments = [
    cursorEffort,
    `fast=${fastMode ? "true" : "false"}`,
    `max=${options.isMaxMode ? "true" : "false"}`,
  ].filter((segment): segment is string => Boolean(segment))

  return create(AvailableModelsResponse_ModelVariantConfigSchema, {
    parameterValues,
    displayName: richDisplayName,
    isMaxMode: options.isMaxMode,
    isDefaultMaxConfig: options.isDefaultMaxConfig,
    isDefaultNonMaxConfig: options.isDefaultNonMaxConfig,
    tagline,
    displayNameOutsidePicker: richOutsidePicker,
    variantStringRepresentation: `${baseModelName}(${variantSegments.join(",")})`,
  })
}

function buildSimpleThinkingVariant(
  model: CursorDisplayModel,
  options: {
    isMaxMode: boolean
    isDefaultMaxConfig?: boolean
    isDefaultNonMaxConfig?: boolean
  }
): AvailableModelsResponse_ModelVariantConfig {
  return create(AvailableModelsResponse_ModelVariantConfigSchema, {
    parameterValues: [
      create(RequestedModel_ModelParameterValueSchema, {
        id: CURSOR_FAST_PARAMETER_ID,
        value: CURSOR_FAST_MODE_DISABLED,
      }),
    ],
    displayName: model.displayName,
    displayNameOutsidePicker: model.shortName,
    isMaxMode: options.isMaxMode,
    isDefaultMaxConfig: options.isDefaultMaxConfig,
    isDefaultNonMaxConfig: options.isDefaultNonMaxConfig,
    // Claude / Gemini 这类布尔 thinking 模型不使用 GPT 风格 reasoning tagline
    //（Low / Medium / High）。保持空即可，避免设置页和聊天 picker
    // 错误显示 “Thinking Low / Medium”。
    tagline: undefined,
    variantStringRepresentation: `${parseModelRequest(model.name).baseModel}(max=${options.isMaxMode ? "true" : "false"})`,
  })
}

function buildSimpleThinkingVariants(
  model: CursorDisplayModel,
  options: {
    supportsCursorMaxMode: boolean
  }
): AvailableModelsResponse_ModelVariantConfig[] {
  if (!options.supportsCursorMaxMode) {
    return [
      buildSimpleThinkingVariant(model, {
        isMaxMode: false,
        isDefaultNonMaxConfig: true,
      }),
    ]
  }

  return [
    buildSimpleThinkingVariant(model, {
      isMaxMode: false,
      isDefaultNonMaxConfig: true,
    }),
    buildSimpleThinkingVariant(model, {
      isMaxMode: true,
      isDefaultMaxConfig: true,
    }),
  ]
}

function buildReasoningVariants(
  model: CursorDisplayModel,
  effortValues: readonly string[],
  options: {
    maxNamedModel: boolean
    supportsCursorMaxMode: boolean
    supportsCursorFastMode: boolean
    standardEffort: string | null
    defaultMaxEffort: string | null
  }
): ReturnType<typeof buildVariant>[] {
  const variantEfforts = effortValues.length > 0 ? [...effortValues] : [null]
  const fastModes = options.supportsCursorFastMode ? [false, true] : [false]

  if (options.maxNamedModel) {
    return variantEfforts.flatMap((effort) =>
      fastModes.map((fastMode) =>
        buildVariant(model.name, effort, {
          displayName: model.displayName,
          displayNameOutsidePicker: model.shortName,
          fastMode,
          isMaxMode: true,
          isDefaultMaxConfig:
            effort === options.defaultMaxEffort && fastMode === false,
        })
      )
    )
  }

  if (!options.supportsCursorMaxMode) {
    return variantEfforts.flatMap((effort) =>
      fastModes.map((fastMode) =>
        buildVariant(model.name, effort, {
          displayName: model.displayName,
          displayNameOutsidePicker: model.shortName,
          fastMode,
          isMaxMode: false,
          isDefaultNonMaxConfig:
            effort === options.standardEffort && fastMode === false,
        })
      )
    )
  }

  return variantEfforts.flatMap((effort) =>
    fastModes.flatMap((fastMode) => [
      buildVariant(model.name, effort, {
        displayName: model.displayName,
        displayNameOutsidePicker: model.shortName,
        fastMode,
        isMaxMode: false,
        isDefaultNonMaxConfig:
          effort === options.standardEffort && fastMode === false,
      }),
      buildVariant(model.name, effort, {
        displayName: model.displayName,
        displayNameOutsidePicker: model.shortName,
        fastMode,
        isMaxMode: true,
        isDefaultMaxConfig:
          effort === options.defaultMaxEffort && fastMode === false,
      }),
    ])
  )
}

function resolveAvailableModelMode(model: CursorDisplayModel): {
  supportsThinking: boolean
  supportsMaxMode: boolean
  supportsNonMaxMode: boolean
  cloudAgentEffortMode?: CloudAgentEffortMode
  parameterDefinitions: ReturnType<typeof buildReasoningParameterDefinition>
  variants: ReturnType<typeof buildVariant>[]
} {
  const modelName = model.name
  const maxNamedModel = isExplicitMaxNamedModel(modelName)
  const effortValues = resolveEffortValues(modelName)
  const standardEffort = selectEffortValue(effortValues, STANDARD_EFFORT_ORDER)
  const supportsThinking = effortValues.length > 0
  // For models without explicit ThinkingCapability levels (e.g. Claude, Gemini
  // thinking variants), fall back to the model's isThinking flag so that max
  // mode can still be enabled.
  const supportsThinkingOrIsThinking = supportsThinking || model.isThinking
  const supportsCursorMaxMode = supportsThinkingOrIsThinking
  const supportsFastMode = supportsCursorFastMode(model)
  const parameterDefinitions = [
    ...buildReasoningParameterDefinition(modelName),
    ...buildFastModeParameterDefinition(model),
  ]
  const defaultMaxEffort =
    selectEffortValue(effortValues, STANDARD_EFFORT_ORDER) || standardEffort

  if (!supportsThinkingOrIsThinking && !supportsFastMode) {
    return {
      supportsThinking: false,
      supportsMaxMode: false,
      supportsNonMaxMode: true,
      parameterDefinitions,
      variants: [],
    }
  }

  if (maxNamedModel) {
    return {
      supportsThinking: supportsThinkingOrIsThinking,
      supportsMaxMode: true,
      supportsNonMaxMode: false,
      cloudAgentEffortMode: supportsThinkingOrIsThinking
        ? CloudAgentEffortMode.GRIND
        : undefined,
      parameterDefinitions,
      variants: buildReasoningVariants(model, effortValues, {
        maxNamedModel: true,
        supportsCursorMaxMode: true,
        supportsCursorFastMode: supportsFastMode,
        standardEffort,
        defaultMaxEffort,
      }),
    }
  }

  // For boolean thinking models without explicit effort levels (e.g. Claude
  // Opus Thinking, Gemini 3.1 Pro High), Cursor 官方只表现为 thinking on/off
  // 或 non-max/max，不应错误投影为 GPT 风格的 Low/Medium/High effort。
  if (!supportsThinking && model.isThinking) {
    const simpleVariants = buildSimpleThinkingVariants(model, {
      supportsCursorMaxMode: true,
    })

    return {
      supportsThinking: true,
      supportsMaxMode: true,
      supportsNonMaxMode: true,
      parameterDefinitions,
      variants: simpleVariants,
    }
  }

  const variants = buildReasoningVariants(model, effortValues, {
    maxNamedModel: false,
    supportsCursorMaxMode,
    supportsCursorFastMode: supportsFastMode,
    standardEffort,
    defaultMaxEffort,
  })

  return {
    supportsThinking: true,
    supportsMaxMode: supportsCursorMaxMode,
    supportsNonMaxMode: true,
    cloudAgentEffortMode: CloudAgentEffortMode.STANDARD,
    parameterDefinitions,
    variants,
  }
}

function selectDefaultDisplayVariant(
  variants: readonly ReturnType<typeof buildVariant>[]
): ReturnType<typeof buildVariant> | null {
  return (
    variants.find((variant) => variant.isDefaultNonMaxConfig) ||
    variants.find((variant) => variant.isDefaultMaxConfig) ||
    variants[0] ||
    null
  )
}

function extractVariantSuffix(
  fullDisplayName: string | undefined,
  baseDisplayName: string
): string | undefined {
  if (!fullDisplayName) {
    return undefined
  }

  const trimmed = fullDisplayName.trim()
  if (!trimmed) {
    return undefined
  }

  if (trimmed === baseDisplayName) {
    return undefined
  }

  if (trimmed.startsWith(`${baseDisplayName} `)) {
    return trimmed.slice(baseDisplayName.length + 1).trim() || undefined
  }

  return trimmed
}

function getLegacyTopLevelEffortValues(modelName: string): string[] {
  const supportedValues = new Set(resolveEffortValues(modelName))
  return ["low", "high", "xhigh"].filter((value) => supportedValues.has(value))
}

function buildLegacyTopLevelModelName(
  baseModelName: string,
  options: {
    effort?: string | null
    fastMode?: boolean
  }
): string {
  const effort = options.effort || "medium"
  const fastMode = options.fastMode === true

  if (fastMode) {
    switch (effort) {
      case "low":
        return `${baseModelName}-low-fast`
      case "high":
        return `${baseModelName}-high-fast`
      case "xhigh":
        return `${baseModelName}-xhigh-fast`
      default:
        return `${baseModelName}-fast`
    }
  }

  switch (effort) {
    case "low":
      return `${baseModelName}-low`
    case "high":
      return `${baseModelName}-high`
    case "xhigh":
      return `${baseModelName}-xhigh`
    default:
      return baseModelName
  }
}

function buildLegacyTopLevelClientDisplayName(
  model: CursorDisplayModel,
  options: {
    effort?: string | null
    fastMode?: boolean
  }
): string {
  const effort = options.effort || "medium"
  const parts = [model.displayName]

  if (effort !== "medium") {
    parts.push(getEffortDisplayName(effort))
  }
  if (options.fastMode === true) {
    parts.push("Fast")
  }

  return parts.join(" ")
}

function buildLegacyVariantDisplayName(
  model: CursorDisplayModel,
  options: {
    effort?: string | null
    fastMode?: boolean
  }
): string {
  const effort = options.effort || "medium"
  return buildVariantRichDisplayName(
    model.displayName,
    effort,
    options.fastMode === true
  )
}

function buildLegacySingleVariantModel(
  model: CursorDisplayModel,
  namedModelSectionIndex: number,
  options: {
    effort?: string | null
    fastMode?: boolean
    defaultOn?: boolean
    preferredDefaultModelName?: string
  }
): AvailableModelsResponse_AvailableModel {
  const capability = resolveAvailableModelMode(model)
  const effort = options.effort || "medium"
  const fastMode = options.fastMode === true
  const topLevelName = buildLegacyTopLevelModelName(model.name, {
    effort,
    fastMode,
  })
  const clientDisplayName = buildLegacyTopLevelClientDisplayName(model, {
    effort,
    fastMode,
  })
  const variantParameters = [
    create(RequestedModel_ModelParameterValueSchema, {
      id: CURSOR_REASONING_PARAMETER_ID,
      value: toCursorReasoningValue(effort),
    }),
    create(RequestedModel_ModelParameterValueSchema, {
      id: CURSOR_FAST_PARAMETER_ID,
      value: fastMode ? CURSOR_FAST_MODE_ENABLED : CURSOR_FAST_MODE_DISABLED,
    }),
  ]
  const variantSegments = [
    `reasoning=${toCursorReasoningValue(effort)}`,
    `fast=${fastMode ? "true" : "false"}`,
  ]
  const contextTokenLimit =
    model.contextTokenLimit || (model.family === "gemini" ? 1_000_000 : 200_000)
  const legacyAliases = Array.from(
    new Set([...(model.legacySlugs || []), model.name])
  )

  return create(AvailableModelsResponse_AvailableModelSchema, {
    name: topLevelName,
    defaultOn:
      options.defaultOn ??
      (model.name === options.preferredDefaultModelName &&
        effort === "xhigh" &&
        fastMode === true),
    isLongContextOnly: model.isLongContextOnly || undefined,
    isChatOnly: model.isChatOnly || undefined,
    supportsAgent: model.supportsAgent ?? true,
    supportsThinking: capability.supportsThinking,
    supportsImages: model.supportsImages ?? true,
    supportsMaxMode: capability.supportsMaxMode,
    supportsNonMaxMode: capability.supportsNonMaxMode,
    contextTokenLimit,
    contextTokenLimitForMaxMode:
      model.contextTokenLimitForMaxMode || contextTokenLimit,
    clientDisplayName,
    serverModelName: topLevelName,
    supportsPlanMode: model.supportsPlanMode ?? true,
    supportsSandboxing: model.supportsSandboxing ?? true,
    supportsCmdK: model.supportsCmdK ?? true,
    onlySupportsCmdK: model.onlySupportsCmdK || undefined,
    inputboxShortModelName: clientDisplayName,
    degradationStatus: 0,
    isRecommendedForBackgroundComposer:
      model.isRecommendedForBackgroundComposer ?? false,
    isUserAdded: model.isUserAdded || undefined,
    parameterDefinitions: [],
    variants: [
      create(AvailableModelsResponse_ModelVariantConfigSchema, {
        parameterValues: variantParameters,
        displayName: buildLegacyVariantDisplayName(model, { effort, fastMode }),
        displayNameOutsidePicker: buildLegacyVariantDisplayName(model, {
          effort,
          fastMode,
        }),
        isDefaultMaxConfig: true,
        isDefaultNonMaxConfig: true,
        variantStringRepresentation: `${model.name}[${variantSegments.join(",")}]`,
      }),
    ],
    cloudAgentEffortMode: capability.cloudAgentEffortMode,
    cloudMigrateToModel: model.cloudMigrateToModel,
    upgradeModelId: model.upgradeModelId,
    isHidden: model.isHidden || undefined,
    legacySlugs:
      topLevelName === model.name ? model.legacySlugs || [] : legacyAliases,
    idAliases: model.idAliases || [],
    namedModelSectionIndex,
    tagline: clientDisplayName,
    visibleInRoutedModelView: model.visibleInRoutedModelView ?? false,
  })
}

export function buildLegacyCursorAvailableModels(
  model: CursorDisplayModel,
  namedModelSectionIndex: number,
  options?: {
    defaultOn?: boolean
    preferredDefaultModelName?: string
    /** When set, fast-mode variants whose effort is in this set get defaultOn=true. */
    defaultOnFastEfforts?: ReadonlySet<string>
  }
): AvailableModelsResponse_AvailableModel[] {
  if (model.family !== "gpt") {
    return [
      buildCursorAvailableModel(model, namedModelSectionIndex, {
        includeParameterDefinitions: false,
        includeVariants: true,
        defaultOn: options?.defaultOn,
      }),
    ]
  }

  const legacyModels: AvailableModelsResponse_AvailableModel[] = [
    buildLegacySingleVariantModel(model, namedModelSectionIndex, {
      effort: "medium",
      fastMode: false,
      defaultOn: false,
      preferredDefaultModelName: options?.preferredDefaultModelName,
    }),
  ]
  const legacyEfforts = getLegacyTopLevelEffortValues(model.name)

  for (const effort of legacyEfforts) {
    legacyModels.push(
      buildLegacySingleVariantModel(model, namedModelSectionIndex, {
        effort,
        fastMode: false,
        defaultOn: false,
        preferredDefaultModelName: options?.preferredDefaultModelName,
      })
    )
  }

  if (supportsCursorFastMode(model)) {
    legacyModels.push(
      buildLegacySingleVariantModel(model, namedModelSectionIndex, {
        effort: "medium",
        fastMode: true,
        defaultOn: false,
        preferredDefaultModelName: options?.preferredDefaultModelName,
      })
    )

    for (const effort of legacyEfforts) {
      const fastDefaultOn = options?.defaultOnFastEfforts
        ? options.defaultOnFastEfforts.has(effort)
        : model.name === options?.preferredDefaultModelName &&
          effort === "xhigh"
      legacyModels.push(
        buildLegacySingleVariantModel(model, namedModelSectionIndex, {
          effort,
          fastMode: true,
          defaultOn: fastDefaultOn,
          preferredDefaultModelName: options?.preferredDefaultModelName,
        })
      )
    }
  }

  return legacyModels
}

export function appendRequestedCursorModels(
  models: readonly CursorDisplayModel[],
  requestedModelIds?: readonly string[]
): CursorDisplayModel[] {
  if (!requestedModelIds?.length) {
    return [...models]
  }

  const merged = [...models]
  const seen = new Set(
    merged.map((model) => parseModelRequest(model.name).normalizedBaseModel)
  )

  for (const requestedModelId of requestedModelIds) {
    const trimmed = parseModelRequest(requestedModelId || "").baseModel.trim()
    if (!trimmed) {
      continue
    }

    const normalized = parseModelRequest(trimmed).normalizedBaseModel
    if (!normalized || seen.has(normalized)) {
      continue
    }

    const predefinedModel = getCursorDisplayModel(trimmed)
    if (predefinedModel) {
      seen.add(normalized)
      merged.push({ ...predefinedModel, isUserAdded: true })
      continue
    }

    const resolved = resolveCloudCodeModel(trimmed)
    if (!resolved) {
      continue
    }

    const fallbackDisplayName =
      !resolved.displayName ||
      resolved.displayName === normalized ||
      resolved.displayName === trimmed
        ? formatFallbackModelName(trimmed)
        : resolved.displayName

    seen.add(normalized)
    merged.push({
      name: trimmed,
      displayName: fallbackDisplayName,
      shortName: fallbackDisplayName,
      family: resolved.family,
      isThinking: resolved.isThinking || !!resolved.thinking,
      isUserAdded: true,
    })
  }

  return merged
}

export function buildCursorAvailableModel(
  model: CursorDisplayModel,
  namedModelSectionIndex: number,
  options?: {
    includeParameterDefinitions?: boolean
    includeVariants?: boolean
    defaultOn?: boolean
  }
): AvailableModelsResponse_AvailableModel {
  const capability = resolveAvailableModelMode(model)
  const contextTokenLimit =
    model.contextTokenLimit || (model.family === "gemini" ? 1_000_000 : 200_000)
  const includeParameterDefinitions =
    options?.includeParameterDefinitions ?? true
  const includeVariants = options?.includeVariants ?? true
  const projectedVariants = includeVariants ? capability.variants : []
  const defaultDisplayVariant = selectDefaultDisplayVariant(projectedVariants)
  const shouldSuppressProjectedTagline =
    model.isThinking && model.family !== "gpt"
  const projectedTagline = shouldSuppressProjectedTagline
    ? model.displayName
    : defaultDisplayVariant?.tagline ||
      extractVariantSuffix(
        defaultDisplayVariant?.displayName,
        model.displayName
      ) ||
      model.displayName

  return create(AvailableModelsResponse_AvailableModelSchema, {
    name: model.name,
    defaultOn: options?.defaultOn ?? false,
    isLongContextOnly: model.isLongContextOnly || undefined,
    isChatOnly: model.isChatOnly || undefined,
    supportsAgent: model.supportsAgent ?? true,
    supportsThinking: capability.supportsThinking,
    supportsImages: model.supportsImages ?? true,
    supportsMaxMode: capability.supportsMaxMode,
    supportsNonMaxMode: capability.supportsNonMaxMode,
    contextTokenLimit,
    contextTokenLimitForMaxMode:
      model.contextTokenLimitForMaxMode || contextTokenLimit,
    clientDisplayName: model.displayName,
    serverModelName: model.name,
    supportsPlanMode: model.supportsPlanMode ?? true,
    supportsSandboxing: model.supportsSandboxing ?? true,
    supportsCmdK: model.supportsCmdK ?? true,
    onlySupportsCmdK: model.onlySupportsCmdK || undefined,
    inputboxShortModelName: model.shortName,
    degradationStatus: 0,
    isRecommendedForBackgroundComposer:
      model.isRecommendedForBackgroundComposer ?? false,
    isUserAdded: model.isUserAdded || undefined,
    parameterDefinitions: includeParameterDefinitions
      ? capability.parameterDefinitions
      : [],
    variants: projectedVariants,
    cloudAgentEffortMode:
      includeParameterDefinitions || includeVariants
        ? capability.cloudAgentEffortMode
        : undefined,
    cloudMigrateToModel: model.cloudMigrateToModel,
    upgradeModelId: model.upgradeModelId,
    isHidden: model.isHidden || undefined,
    legacySlugs: model.legacySlugs || [],
    idAliases: model.idAliases || [],
    namedModelSectionIndex,
    tagline: projectedTagline,
    visibleInRoutedModelView: model.visibleInRoutedModelView ?? false,
  })
}

export function buildCursorUsableModel(
  model: CursorDisplayModel
): ModelDetails {
  const aliases = Array.from(
    new Set([
      ...(model.aliases || []),
      ...(model.idAliases || []),
      ...(model.legacySlugs || []),
    ])
  )

  return create(ModelDetailsSchema, {
    modelId: model.name,
    thinkingDetails: model.isThinking
      ? create(ThinkingDetailsSchema, {})
      : undefined,
    displayModelId: model.name,
    displayName: model.displayName,
    displayNameShort: model.shortName,
    aliases,
    maxMode: isExplicitMaxNamedModel(model.name),
  })
}

export function doesCursorModelUseParameters(
  model: CursorDisplayModel
): boolean {
  const capability = resolveAvailableModelMode(model)
  return (
    capability.parameterDefinitions.length > 0 || capability.variants.length > 0
  )
}

export function selectPreferredCursorModelName(
  models: Array<{ name: string; family: string; isThinking: boolean }>,
  preferredOrder: readonly string[]
): string {
  const normalizedNames = new Set(models.map((model) => model.name))
  for (const candidate of preferredOrder) {
    if (normalizedNames.has(candidate)) {
      return candidate
    }
  }

  return (
    models.find((model) => model.family === "gpt")?.name ||
    models.find((model) => model.family === "claude")?.name ||
    models.find((model) => model.family === "gemini")?.name ||
    models.find((model) => model.isThinking)?.name ||
    models[0]?.name ||
    preferredOrder[0] ||
    ""
  )
}

export function resolveCursorDefaultSelection(
  models: Array<{ name: string; family: string; isThinking: boolean }>,
  preferredOrder: readonly string[]
): {
  model: string
  thinkingModel: string
  maxMode: boolean
} {
  const model = selectPreferredCursorModelName(models, preferredOrder)
  const thinkingModel =
    models.find((candidate) => candidate.isThinking)?.name || model

  return {
    model,
    thinkingModel,
    maxMode: isExplicitMaxNamedModel(model),
  }
}

export function buildCursorModelLabel(
  model: CursorDisplayModel
): GetModelLabelsResponse_ModelLabel {
  const capability = resolveAvailableModelMode(model)
  const defaultDisplayVariant = selectDefaultDisplayVariant(capability.variants)
  const projectedShortLabel =
    defaultDisplayVariant?.tagline ||
    extractVariantSuffix(
      defaultDisplayVariant?.displayNameOutsidePicker ||
        defaultDisplayVariant?.displayName,
      model.displayName
    ) ||
    model.shortName

  return create(GetModelLabelsResponse_ModelLabelSchema, {
    name: model.name,
    label: model.displayName,
    shortLabel: projectedShortLabel,
    supportsAgent: true,
  })
}
