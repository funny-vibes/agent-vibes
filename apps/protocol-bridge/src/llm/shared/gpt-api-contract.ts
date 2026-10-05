export type GptProvider = "codex" | "chatgpt-web"
export type GptHistoryPolicy = "disabled" | "delete_after_completion"

export class GptRequestError extends Error {
  readonly statusCode = 400
  readonly code = "invalid_request"
  constructor(
    message: string,
    readonly param: string
  ) {
    super(message)
    this.name = "GptRequestError"
  }
}

export function readGptProvider(value: unknown): GptProvider | undefined {
  if (value === undefined) return undefined
  if (value === "codex" || value === "chatgpt-web") return value
  throw new GptRequestError("provider must be codex or chatgpt-web", "provider")
}

/** This policy concerns upstream history, not the Responses API's local store. */
export function resolveGptHistoryPolicy(
  body: { history_policy?: unknown; allow_temporary_history?: unknown },
  needsSavedConversation: boolean
): GptHistoryPolicy {
  const value = body.history_policy
  if (
    value !== undefined &&
    value !== "disabled" &&
    value !== "delete_after_completion"
  ) {
    throw new GptRequestError(
      "history_policy must be disabled or delete_after_completion",
      "history_policy"
    )
  }
  const legacy = body.allow_temporary_history
  if (legacy !== undefined && typeof legacy !== "boolean") {
    throw new GptRequestError(
      "allow_temporary_history must be a boolean",
      "allow_temporary_history"
    )
  }
  if (
    value !== undefined &&
    legacy !== undefined &&
    (value === "delete_after_completion") !== legacy
  ) {
    throw new GptRequestError(
      "history_policy conflicts with allow_temporary_history",
      "history_policy"
    )
  }
  const policy =
    value ?? (legacy === true ? "delete_after_completion" : "disabled")
  const required = needsSavedConversation
    ? "delete_after_completion"
    : "disabled"
  if (policy !== required) {
    throw new GptRequestError(
      `This operation requires history_policy: ${required}`,
      "history_policy"
    )
  }
  return policy
}
