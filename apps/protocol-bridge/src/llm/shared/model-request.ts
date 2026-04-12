export type ParsedThinkingSuffix =
  | { kind: "none"; raw: string }
  | { kind: "auto"; raw: string }
  | {
      kind: "level"
      raw: string
      level: "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    }
  | { kind: "budget"; raw: string; budgetTokens: number }
  | { kind: "unknown"; raw: string }

export interface ParsedModelRequest {
  rawModel: string
  baseModel: string
  normalizedBaseModel: string
  hasSuffix: boolean
  suffix?: ParsedThinkingSuffix
}

function parseThinkingSuffix(rawSuffix: string): ParsedThinkingSuffix {
  const normalized = rawSuffix.trim().toLowerCase()

  switch (normalized) {
    case "none":
      return { kind: "none", raw: rawSuffix }
    case "auto":
    case "-1":
      return { kind: "auto", raw: rawSuffix }
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return { kind: "level", raw: rawSuffix, level: normalized }
    default:
      break
  }

  if (/^\d+$/.test(normalized)) {
    return {
      kind: "budget",
      raw: rawSuffix,
      budgetTokens: Number.parseInt(normalized, 10),
    }
  }

  return { kind: "unknown", raw: rawSuffix }
}

export function parseModelRequest(rawModel: string): ParsedModelRequest {
  const trimmed = rawModel.trim()
  const lastOpen = trimmed.lastIndexOf("(")

  if (lastOpen <= 0 || !trimmed.endsWith(")")) {
    return {
      rawModel: trimmed,
      baseModel: trimmed,
      normalizedBaseModel: trimmed.toLowerCase(),
      hasSuffix: false,
    }
  }

  const baseModel = trimmed.slice(0, lastOpen).trim()
  const rawSuffix = trimmed.slice(lastOpen + 1, -1).trim()

  if (!baseModel || !rawSuffix) {
    return {
      rawModel: trimmed,
      baseModel: trimmed,
      normalizedBaseModel: trimmed.toLowerCase(),
      hasSuffix: false,
    }
  }

  return {
    rawModel: trimmed,
    baseModel,
    normalizedBaseModel: baseModel.toLowerCase(),
    hasSuffix: true,
    suffix: parseThinkingSuffix(rawSuffix),
  }
}

export function stripModelThinkingSuffix(rawModel: string): string {
  return parseModelRequest(rawModel).baseModel
}
