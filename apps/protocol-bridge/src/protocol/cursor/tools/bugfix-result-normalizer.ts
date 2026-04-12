export interface NormalizedBugfixResultItem {
  bugId: string
  bugTitle: string
  verdict: number
  explanation: string
}

export interface NormalizedBugfixResultSet {
  items: NormalizedBugfixResultItem[]
  invalidIndexes: number[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function pickFirstString(
  source: Record<string, unknown>,
  keys: string[]
): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim()
    }
  }
  return ""
}

export function parseBugfixVerdict(value: unknown): number {
  const numeric = Number(value)
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 3) {
    return numeric
  }

  const normalized =
    typeof value === "string"
      ? value
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
      : ""

  if (normalized === "fixed" || normalized === "bugfix_verdict_fixed") {
    return 1
  }
  if (
    normalized === "false_positive" ||
    normalized === "falsepositive" ||
    normalized === "bugfix_verdict_false_positive"
  ) {
    return 2
  }
  if (
    normalized === "could_not_fix" ||
    normalized === "couldnotfix" ||
    normalized === "not_fixed" ||
    normalized === "failed" ||
    normalized === "bugfix_verdict_could_not_fix"
  ) {
    return 3
  }
  return 0
}

export function normalizeBugfixResultItems(
  value: unknown
): NormalizedBugfixResultSet {
  if (!Array.isArray(value)) {
    return { items: [], invalidIndexes: [] }
  }

  const items: NormalizedBugfixResultItem[] = []
  const invalidIndexes: number[] = []

  for (const [index, entry] of value.entries()) {
    const item = asRecord(entry)
    if (!item) {
      invalidIndexes.push(index)
      continue
    }

    const normalized = {
      bugId: pickFirstString(item, ["bugId", "bug_id", "id"]),
      bugTitle: pickFirstString(item, ["bugTitle", "bug_title", "title"]),
      verdict: parseBugfixVerdict(item.verdict),
      explanation: pickFirstString(item, ["explanation", "reason", "details"]),
    }

    if (
      normalized.bugId.length === 0 ||
      normalized.bugTitle.length === 0 ||
      normalized.explanation.length === 0 ||
      normalized.verdict === 0
    ) {
      invalidIndexes.push(index)
      continue
    }

    items.push(normalized)
  }

  return {
    items,
    invalidIndexes,
  }
}
