export interface OpenAiStyleToolCall {
  id: string
}

export interface OpenAiStyleChatMessage {
  role: string
  content?: unknown
  tool_calls?: OpenAiStyleToolCall[]
  tool_call_id?: string
}

export interface ResponsesStyleInputItem {
  type: string
  call_id?: string
}

export interface OpenAiToolCallIntegrityResult<T> {
  items: T[]
  removedToolCalls: number
  removedToolResponses: number
  removedEmptyMessages: number
  changed: boolean
}

function normalizePendingIds(
  pendingToolUseIds?: Iterable<string>
): Set<string> {
  return new Set(
    Array.from(pendingToolUseIds ?? [])
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter(Boolean)
  )
}

function hasChatMessageContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0
  if (Array.isArray(content)) return content.length > 0
  return false
}

function collectContiguousToolResponseIds<T extends OpenAiStyleChatMessage>(
  messages: T[],
  startIndex: number
): Set<string> {
  const ids = new Set<string>()

  for (let i = startIndex; i < messages.length; i++) {
    const message = messages[i]
    if (!message || message.role !== "tool") break
    if (typeof message.tool_call_id === "string" && message.tool_call_id) {
      ids.add(message.tool_call_id)
    }
  }

  return ids
}

function collectContiguousFunctionCallOutputIds<
  T extends ResponsesStyleInputItem,
>(items: T[], startIndex: number): Set<string> {
  const ids = new Set<string>()

  for (let i = startIndex; i < items.length; i++) {
    const item = items[i]
    if (!item || item.type !== "function_call_output") break
    if (typeof item.call_id === "string" && item.call_id) {
      ids.add(item.call_id)
    }
  }

  return ids
}

export function sanitizeOpenAiChatToolCallIntegrity<
  T extends OpenAiStyleChatMessage,
>(
  messages: T[],
  pendingToolUseIds?: Iterable<string>
): OpenAiToolCallIntegrityResult<T> {
  const pendingIds = normalizePendingIds(pendingToolUseIds)
  const result: T[] = []
  let removedToolCalls = 0
  let removedToolResponses = 0
  let removedEmptyMessages = 0
  let changed = false
  let activeToolCallIds = new Set<string>()

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!

    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const contiguousToolResponseIds = collectContiguousToolResponseIds(
        messages,
        i + 1
      )
      const filteredToolCalls = message.tool_calls.filter(
        (toolCall) =>
          !!toolCall?.id &&
          (contiguousToolResponseIds.has(toolCall.id) ||
            pendingIds.has(toolCall.id))
      )

      removedToolCalls += message.tool_calls.length - filteredToolCalls.length
      changed ||= filteredToolCalls.length !== message.tool_calls.length
      activeToolCallIds = new Set(
        filteredToolCalls
          .map((toolCall) => toolCall.id)
          .filter((id) => contiguousToolResponseIds.has(id))
      )

      if (filteredToolCalls.length === 0) {
        if (hasChatMessageContent(message.content)) {
          const { tool_calls: _toolCalls, ...rest } = message
          result.push(rest as T)
        } else {
          removedEmptyMessages++
          changed = true
        }
        continue
      }

      if (filteredToolCalls.length !== message.tool_calls.length) {
        result.push({ ...message, tool_calls: filteredToolCalls } as T)
        continue
      }

      result.push(message)
      continue
    }

    if (message.role === "tool") {
      const toolCallId =
        typeof message.tool_call_id === "string" ? message.tool_call_id : ""
      if (!toolCallId || !activeToolCallIds.has(toolCallId)) {
        removedToolResponses++
        changed = true
        continue
      }

      activeToolCallIds.delete(toolCallId)
      result.push(message)
      continue
    }

    activeToolCallIds.clear()
    result.push(message)
  }

  return {
    items: result,
    removedToolCalls,
    removedToolResponses,
    removedEmptyMessages,
    changed,
  }
}

export function sanitizeResponsesToolCallIntegrity<
  T extends ResponsesStyleInputItem,
>(
  items: T[],
  pendingToolUseIds?: Iterable<string>
): OpenAiToolCallIntegrityResult<T> {
  const pendingIds = normalizePendingIds(pendingToolUseIds)
  const result: T[] = []
  let removedToolCalls = 0
  let removedToolResponses = 0
  let changed = false
  let activeToolCallIds = new Set<string>()

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!

    if (item.type === "function_call") {
      let groupEnd = i
      while (
        groupEnd < items.length &&
        items[groupEnd] &&
        items[groupEnd]!.type === "function_call"
      ) {
        groupEnd++
      }

      const callGroup = items.slice(i, groupEnd)
      const contiguousOutputIds = collectContiguousFunctionCallOutputIds(
        items,
        groupEnd
      )
      const filteredCalls = callGroup.filter(
        (call) =>
          typeof call.call_id === "string" &&
          call.call_id.length > 0 &&
          (contiguousOutputIds.has(call.call_id) ||
            pendingIds.has(call.call_id))
      )

      removedToolCalls += callGroup.length - filteredCalls.length
      changed ||= filteredCalls.length !== callGroup.length
      activeToolCallIds = new Set(
        filteredCalls
          .map((call) => call.call_id)
          .filter(
            (callId): callId is string =>
              typeof callId === "string" && contiguousOutputIds.has(callId)
          )
      )
      result.push(...filteredCalls)
      i = groupEnd - 1
      continue
    }

    if (item.type === "function_call_output") {
      const callId = typeof item.call_id === "string" ? item.call_id : ""
      if (!callId || !activeToolCallIds.has(callId)) {
        removedToolResponses++
        changed = true
        continue
      }

      activeToolCallIds.delete(callId)
      result.push(item)
      continue
    }

    activeToolCallIds.clear()
    result.push(item)
  }

  return {
    items: result,
    removedToolCalls,
    removedToolResponses,
    removedEmptyMessages: 0,
    changed,
  }
}
