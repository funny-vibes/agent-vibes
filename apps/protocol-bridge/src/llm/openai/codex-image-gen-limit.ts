import type {
  CodexImageGenLimitSnapshot,
  CodexRateLimitWindow,
} from "../shared/backend-pool-status"
import { parseCodexRateLimitHeaders } from "./codex-rate-limit-headers"

/**
 * Names the limit the `x-codex-*` rate-limit headers describe. Conversation
 * turns report `premium`; on a Pro account the standalone `images/*` calls
 * report their own `imagegen_premium`, with a one-day window. The account
 * usage endpoint does not list the image limit, so these headers are the only
 * reading of it.
 */
const ACTIVE_LIMIT_HEADER = "x-codex-active-limit"

export function readCodexActiveLimit(
  headers: Pick<Headers, "get">
): string | null {
  const value = headers.get(ACTIVE_LIMIT_HEADER)?.trim().toLowerCase()
  return value || null
}

/** Whether a limit id meters image generation apart from conversation turns. */
export function isCodexImageLimitId(limitId: string | null): boolean {
  return !!limitId && limitId.includes("image")
}

/**
 * Read an image response's rate-limit headers when they describe an image
 * limit. Headers naming a shared limit (or none) are left to the ordinary
 * per-model capture.
 */
export function parseCodexImageGenLimitHeaders(
  headers: Pick<Headers, "get">,
  now: number = Date.now()
): CodexImageGenLimitSnapshot | null {
  const limitName = readCodexActiveLimit(headers)
  if (!isCodexImageLimitId(limitName)) {
    return null
  }
  const { primary, secondary } = parseCodexRateLimitHeaders(headers)
  const windows = {
    ...(primary && hasWindowData(primary) ? { primary } : {}),
    ...(secondary && hasWindowData(secondary) ? { secondary } : {}),
  }
  if (!windows.primary && !windows.secondary) {
    return null
  }
  return {
    source: "response",
    ...(limitName ? { limitName } : {}),
    ...windows,
    updatedAt: now,
  }
}

/**
 * Recognise an image request refused because its image limit is spent: a
 * 429 `usage_limit_reached` whose active-limit header names an image limit.
 */
export function parseCodexImageGenLimitError(
  statusCode: number,
  headers: Pick<Headers, "get">,
  errorBody: string,
  now: number = Date.now()
): CodexImageGenLimitSnapshot | null {
  const limitName = readCodexActiveLimit(headers)
  if (statusCode !== 429 || !isCodexImageLimitId(limitName)) {
    return null
  }
  const details = readObject(readObject(parseJson(errorBody))?.error)
  if (details?.type !== "usage_limit_reached") {
    return null
  }

  const resetsAt = details.resets_at
  return {
    ...parseCodexImageGenLimitHeaders(headers, now),
    source: "limit-error",
    ...(limitName ? { limitName } : {}),
    limitReached: true,
    ...(typeof resetsAt === "number" &&
    Number.isFinite(resetsAt) &&
    resetsAt > 0
      ? { resetsAt }
      : {}),
    updatedAt: now,
  }
}

/** The backend sends an unused secondary window as zeros with no reset. */
function hasWindowData(window: CodexRateLimitWindow): boolean {
  return (
    window.usedPercent !== 0 ||
    !!window.windowMinutes ||
    window.resetsAt != null
  )
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
