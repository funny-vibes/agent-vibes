import type {
  CreateMessageDto,
  ThinkingIntent,
  ThinkingIntentEffort,
} from "../../protocol/anthropic/dto/create-message.dto"
import { parseModelRequest } from "./model-request"

export type RequestedThinkingEffort = "none" | "auto" | ThinkingIntentEffort

function isThinkingIntentEffort(value: unknown): value is ThinkingIntentEffort {
  return (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  )
}

export function normalizeRequestedThinkingEffort(
  rawValue?: string
): RequestedThinkingEffort | undefined {
  if (!rawValue) {
    return undefined
  }

  const normalized = rawValue
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")

  switch (normalized) {
    case "none":
    case "off":
    case "disabled":
      return "none"
    case "minimal":
    case "min":
      return "minimal"
    case "medium":
    case "med":
    case "normal":
    case "standard":
    case "auto":
      return normalized === "auto" ? "auto" : "medium"
    case "low":
      return "low"
    case "high":
      return "high"
    case "max":
    case "very_high":
    case "ultra":
      return normalized === "max" ? "max" : "xhigh"
    case "xhigh":
    case "extra_high":
      return "xhigh"
    default:
      return undefined
  }
}

export function modelPrefersAdaptiveThinking(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  const isClaudeFamily =
    normalized.includes("claude") ||
    normalized.includes("opus") ||
    normalized.includes("sonnet")

  const is46Family =
    normalized.includes("4-6") ||
    normalized.includes("4.6") ||
    normalized.includes("opus-4-6") ||
    normalized.includes("sonnet-4-6")

  return isClaudeFamily && is46Family
}

export function buildThinkingIntentFromCursorRequest(params: {
  model: string
  thinkingLevel: number
  requestedEffort?: string
}): ThinkingIntent | null {
  const normalizedEffort = normalizeRequestedThinkingEffort(
    params.requestedEffort
  )

  if (normalizedEffort === "none") {
    return { mode: "disabled" }
  }

  if (params.thinkingLevel <= 0 && normalizedEffort === undefined) {
    return null
  }

  if (modelPrefersAdaptiveThinking(params.model)) {
    if (normalizedEffort && normalizedEffort !== "auto") {
      return { mode: "adaptive", effort: normalizedEffort }
    }
    // Only MAX Mode (thinkingLevel >= 2) elevates thinking depth.
    // Normal thinking (level 1) uses the same default budget as level 0.
    if (params.thinkingLevel >= 2) {
      return { mode: "adaptive", effort: "max" }
    }
    return { mode: "adaptive" }
  }

  if (normalizedEffort && normalizedEffort !== "auto") {
    return modelPrefersAdaptiveThinking(params.model)
      ? { mode: "adaptive", effort: normalizedEffort }
      : {
          mode: "explicit_effort",
          effort: normalizedEffort,
        }
  }

  return {
    mode: "explicit_budget",
    budgetTokens: params.thinkingLevel >= 2 ? 32768 : 16384,
  }
}

export function applyThinkingIntentToDto(
  dto: CreateMessageDto,
  intent: ThinkingIntent | null
): void {
  dto._thinkingIntent = intent ?? undefined

  if (!intent) {
    dto.thinking = undefined
    dto.output_config = undefined
    return
  }

  switch (intent.mode) {
    case "disabled":
      dto.thinking = { type: "disabled" }
      dto.output_config = undefined
      return
    case "adaptive":
      dto.thinking = { type: "adaptive" }
      dto.output_config = intent.effort ? { effort: intent.effort } : undefined
      return
    case "explicit_effort":
      dto.thinking = { type: "adaptive" }
      dto.output_config = { effort: intent.effort }
      return
    case "explicit_budget":
      dto.thinking = {
        type: "enabled",
        budget_tokens: intent.budgetTokens,
      }
      dto.output_config = undefined
      return
  }
}

function normalizeInternalThinkingIntent(
  value: unknown
): ThinkingIntent | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const record = value as Record<string, unknown>
  const mode = typeof record.mode === "string" ? record.mode.trim() : ""

  switch (mode) {
    case "disabled":
      return { mode: "disabled" }
    case "adaptive": {
      const effort = isThinkingIntentEffort(record.effort)
        ? record.effort
        : undefined
      return effort ? { mode: "adaptive", effort } : { mode: "adaptive" }
    }
    case "explicit_effort": {
      const effort = isThinkingIntentEffort(record.effort)
        ? record.effort
        : undefined
      return effort ? { mode: "explicit_effort", effort } : null
    }
    case "explicit_budget": {
      const budgetTokens =
        typeof record.budgetTokens === "number" &&
        Number.isFinite(record.budgetTokens) &&
        record.budgetTokens > 0
          ? Math.floor(record.budgetTokens)
          : undefined
      return budgetTokens ? { mode: "explicit_budget", budgetTokens } : null
    }
    default:
      return null
  }
}

export function resolveThinkingIntentFromDto(
  dto: Pick<
    CreateMessageDto,
    | "model"
    | "thinking"
    | "output_config"
    | "_thinkingIntent"
    | "_requestedModel"
  >
): ThinkingIntent | null {
  const requestedModel = dto._requestedModel || dto.model
  const requestModel = parseModelRequest(requestedModel || "")
  if (requestModel.suffix) {
    switch (requestModel.suffix.kind) {
      case "none":
        return { mode: "disabled" }
      case "auto":
        return { mode: "adaptive" }
      case "level":
        return { mode: "adaptive", effort: requestModel.suffix.level }
      case "budget":
        return requestModel.suffix.budgetTokens <= 0
          ? { mode: "disabled" }
          : {
              mode: "explicit_budget",
              budgetTokens: requestModel.suffix.budgetTokens,
            }
      default:
        break
    }
  }

  const internal = normalizeInternalThinkingIntent(dto._thinkingIntent)
  if (internal) {
    return internal
  }

  if (!dto.thinking) {
    return null
  }

  switch (dto.thinking.type) {
    case "disabled":
      return { mode: "disabled" }
    case "enabled": {
      const budgetTokens =
        typeof dto.thinking.budget_tokens === "number" &&
        Number.isFinite(dto.thinking.budget_tokens) &&
        dto.thinking.budget_tokens > 0
          ? Math.floor(dto.thinking.budget_tokens)
          : undefined
      return budgetTokens ? { mode: "explicit_budget", budgetTokens } : null
    }
    case "adaptive":
    case "auto": {
      const effort = normalizeRequestedThinkingEffort(dto.output_config?.effort)
      if (effort && effort !== "none" && effort !== "auto") {
        return { mode: "explicit_effort", effort }
      }
      return { mode: "adaptive" }
    }
    default:
      return null
  }
}
