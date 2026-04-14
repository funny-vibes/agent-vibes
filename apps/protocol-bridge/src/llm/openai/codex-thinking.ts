import type { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"
import { resolveModelThinkingCapability } from "../shared/model-registry"
import { resolveThinkingIntentFromDto } from "../shared/thinking-intent"

const STANDARD_LEVEL_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

function normalizeSupportedLevels(modelName: string): {
  supported: string[]
  defaultLevel: string
} {
  const capability = resolveModelThinkingCapability(modelName)
  const supported =
    capability?.levels
      ?.map((level) => level.trim().toLowerCase())
      .filter((level) => level.length > 0) || []

  if (supported.length === 0) {
    return { supported: ["low", "medium", "high"], defaultLevel: "high" }
  }

  const defaultLevel =
    capability?.defaultLevel?.trim().toLowerCase() ||
    (supported.includes("high")
      ? "high"
      : supported[supported.length - 1] || "medium")

  return { supported, defaultLevel }
}

function levelIndex(level: string): number {
  return STANDARD_LEVEL_ORDER.indexOf(
    level as (typeof STANDARD_LEVEL_ORDER)[number]
  )
}

function clampLevelToSupported(
  level: string,
  supported: readonly string[],
  defaultLevel: string
): string {
  if (supported.length === 0) {
    return defaultLevel
  }

  const normalized = level.trim().toLowerCase()
  if (!normalized) {
    return defaultLevel
  }

  if (normalized === "auto") {
    return supported.includes("medium")
      ? "medium"
      : supported.includes(defaultLevel)
        ? defaultLevel
        : supported[0]!
  }

  if (supported.includes(normalized)) {
    return normalized
  }

  if (normalized === "none") {
    return supported[0]!
  }

  const requestedIndex = levelIndex(normalized)
  if (requestedIndex === -1) {
    return supported.includes(defaultLevel) ? defaultLevel : supported[0]!
  }

  let bestLevel = supported[0]!
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of supported) {
    const candidateIndex = levelIndex(candidate)
    if (candidateIndex === -1) {
      continue
    }
    const distance = Math.abs(requestedIndex - candidateIndex)
    if (
      distance < bestDistance ||
      (distance === bestDistance && candidateIndex < levelIndex(bestLevel))
    ) {
      bestDistance = distance
      bestLevel = candidate
    }
  }

  return bestLevel
}

function convertBudgetToThinkingLevel(budgetTokens: number): string {
  if (budgetTokens < 0) {
    return "auto"
  }
  if (budgetTokens === 0) {
    return "none"
  }
  if (budgetTokens <= 512) {
    return "minimal"
  }
  if (budgetTokens <= 1024) {
    return "low"
  }
  if (budgetTokens <= 8192) {
    return "medium"
  }
  if (budgetTokens <= 24576) {
    return "high"
  }
  return "xhigh"
}

export function resolveCodexReasoningEffort(
  dto: Pick<
    CreateMessageDto,
    | "model"
    | "thinking"
    | "output_config"
    | "_thinkingIntent"
    | "_requestedModel"
  >,
  modelName: string
): string {
  const { supported, defaultLevel } = normalizeSupportedLevels(modelName)
  const intent = resolveThinkingIntentFromDto(dto)
  if (!intent) {
    return defaultLevel
  }

  switch (intent.mode) {
    case "disabled":
      return clampLevelToSupported("none", supported, defaultLevel)
    case "explicit_effort":
      return clampLevelToSupported(intent.effort, supported, defaultLevel)
    case "explicit_budget":
      return clampLevelToSupported(
        convertBudgetToThinkingLevel(intent.budgetTokens),
        supported,
        defaultLevel
      )
    case "adaptive":
      return clampLevelToSupported(
        intent.effort || "auto",
        supported,
        defaultLevel
      )
    default:
      return defaultLevel
  }
}
