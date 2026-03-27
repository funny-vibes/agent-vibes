import { enforceToolProtocol } from "./message-integrity-guard"

export interface ToolProtocolMessage {
  role: "user" | "assistant"
  content: unknown
}

export interface ToolProtocolNormalizationResult<
  T extends ToolProtocolMessage = ToolProtocolMessage,
> {
  messages: T[]
  removedToolResults: number
  injectedToolResults: number
  changed: boolean
}

/**
 * Normalize tool protocol messages for strict backends (e.g. Cloud Code).
 *
 * This is a thin wrapper around MessageIntegrityGuard.enforceToolProtocol().
 * All actual repair logic lives in the Guard module.
 *
 * - Removes orphan tool_result blocks (no matching tool_use)
 * - Injects synthetic tool_result for orphan tool_use blocks (no matching tool_result)
 * - Cleans up empty messages after removal
 *
 * Modes:
 * - 'strict-adjacent' (default): tool_result must match tool_use in the immediately previous assistant message
 * - 'global': tool_result must match any tool_use across ALL assistant messages. Use after truncation.
 */
export function normalizeToolProtocolMessages<T extends ToolProtocolMessage>(
  messages: T[],
  options?: { mode?: "strict-adjacent" | "global" }
): ToolProtocolNormalizationResult<T> {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      messages,
      removedToolResults: 0,
      injectedToolResults: 0,
      changed: false,
    }
  }

  const result = enforceToolProtocol(
    messages as Array<T & { role: "user" | "assistant"; content: unknown }>,
    { mode: options?.mode }
  )

  return {
    messages: result.messages as T[],
    removedToolResults: result.removedToolResults,
    injectedToolResults: result.injectedToolResults,
    changed: result.changed,
  }
}
