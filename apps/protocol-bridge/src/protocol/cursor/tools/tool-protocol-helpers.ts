export interface ToolProtocolMessageLike {
  role: "user" | "assistant"
  content: unknown
}

export interface ToolResultAppendPlan {
  mode: "append_new_user_message" | "merge_into_existing_user_message"
  assistantMessageIndex: number
  userMessageIndex?: number
}

export interface EditFailureSelection {
  startLine?: number
  endLine?: number
  allowMultiple?: boolean
  searchText?: string
  replaceTextLength?: number
  chunkIndex?: number
}

export interface NumberedLineEntry {
  LineNumber: number
  Text: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function extractToolUseIds(content: unknown): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(content)) return ids
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_use") continue
    const id = typeof block.id === "string" ? block.id.trim() : ""
    if (id) ids.add(id)
  }
  return ids
}

function extractToolResultIds(content: unknown): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(content)) return ids
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_result") continue
    const id =
      typeof block.tool_use_id === "string" ? block.tool_use_id.trim() : ""
    if (id) ids.add(id)
  }
  return ids
}

function isToolResultOnlyUserMessage(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false
  return content.every(
    (block) => isRecord(block) && block.type === "tool_result"
  )
}

function pickFirstNumber(
  input: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const candidate = input[key]
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.floor(candidate)
    }
  }
  return undefined
}

function pickFirstBoolean(
  input: Record<string, unknown>,
  keys: string[]
): boolean | undefined {
  for (const key of keys) {
    if (typeof input[key] === "boolean") return input[key]
  }
  return undefined
}

function pickFirstRawString(
  input: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    if (typeof input[key] === "string") return input[key]
  }
  return undefined
}

function splitContentLines(content: string): string[] {
  if (content.length === 0) return []

  const lines = content.split(/\r?\n/)
  if (
    lines.length > 0 &&
    lines[lines.length - 1] === "" &&
    /\r?\n$/.test(content)
  ) {
    lines.pop()
  }
  return lines
}

export function messageContainsToolResult(
  content: unknown,
  toolCallId: string
): boolean {
  return extractToolResultIds(content).has(toolCallId)
}

/**
 * Find where to insert a tool result for the given toolCallId in the message
 * history.  Scans backward up to 32 messages — if the matching assistant
 * tool_use falls outside that window, the result will be appended as a new
 * standalone user message rather than merged into an existing one.
 */
export function findToolResultAppendPlan(
  messages: ToolProtocolMessageLike[],
  toolCallId: string
): ToolResultAppendPlan | null {
  if (!toolCallId) return null

  let trailingUserResultMessageIndex: number | undefined
  // Limit backward scan depth to avoid unbounded traversal into old history.
  const scanLimit = Math.max(0, messages.length - 32)
  for (let index = messages.length - 1; index >= scanLimit; index--) {
    const message = messages[index]
    if (!message) continue

    if (
      message.role === "user" &&
      isToolResultOnlyUserMessage(message.content)
    ) {
      trailingUserResultMessageIndex = index
      continue
    }

    if (
      message.role === "assistant" &&
      extractToolUseIds(message.content).has(toolCallId)
    ) {
      return trailingUserResultMessageIndex == null
        ? {
            mode: "append_new_user_message",
            assistantMessageIndex: index,
          }
        : {
            mode: "merge_into_existing_user_message",
            assistantMessageIndex: index,
            userMessageIndex: trailingUserResultMessageIndex,
          }
    }

    // A non-tool-result user message breaks the contiguous run of
    // tool-result-only user messages.  Reset the trailing index so we
    // don't attempt to merge across a separating user message.
    if (message.role === "user") {
      trailingUserResultMessageIndex = undefined
    }
    // Continue scanning instead of breaking — the matching assistant
    // message may be further back when non-tool user messages or
    // non-matching assistant messages intervene.
  }

  return null
}

export function extractEditFailureSelection(
  toolInput: Record<string, unknown>,
  warning?: string
): EditFailureSelection | undefined {
  const replacementChunks = Array.isArray(toolInput.replacementChunks)
    ? toolInput.replacementChunks
    : []
  const chunkIndexMatch = warning?.match(/replacement chunk (\d+)/i)
  const chunkIndex = chunkIndexMatch
    ? Math.max(0, Number.parseInt(chunkIndexMatch[1] || "1", 10) - 1)
    : undefined
  const selected =
    chunkIndex != null &&
    Number.isInteger(chunkIndex) &&
    chunkIndex >= 0 &&
    chunkIndex < replacementChunks.length &&
    isRecord(replacementChunks[chunkIndex])
      ? replacementChunks[chunkIndex]
      : toolInput

  return {
    startLine: pickFirstNumber(selected, [
      "startLine",
      "start_line",
      "StartLine",
    ]),
    endLine: pickFirstNumber(selected, ["endLine", "end_line", "EndLine"]),
    allowMultiple: pickFirstBoolean(selected, [
      "allowMultiple",
      "allow_multiple",
      "AllowMultiple",
    ]),
    searchText: pickFirstRawString(selected, [
      "targetContent",
      "target_content",
      "TargetContent",
      "search",
      "old_text",
    ]),
    replaceTextLength:
      pickFirstRawString(selected, [
        "replacementContent",
        "replacement_content",
        "ReplacementContent",
        "replace",
        "new_text",
      ])?.length ?? undefined,
    chunkIndex,
  }
}

export function buildNumberedLineEntries(
  content: string,
  startLine = 1
): {
  lines: NumberedLineEntry[]
  endLine: number
  text: string
} {
  const safeStartLine =
    typeof startLine === "number" && Number.isFinite(startLine)
      ? Math.max(1, Math.floor(startLine))
      : 1
  const lines = splitContentLines(content).map((line, index) => ({
    LineNumber: safeStartLine + index,
    Text: line,
  }))
  const lastLineNumber =
    (lines.length > 0 ? lines[lines.length - 1]!.LineNumber : undefined) ??
    safeStartLine

  return {
    lines,
    endLine: lastLineNumber,
    text: lines.map((line) => `${line.LineNumber} | ${line.Text}`).join("\n"),
  }
}

export function formatLineNumberedSnippet(
  content: string,
  options?: {
    startLine?: number
    endLine?: number
    maxLines?: number
  }
): { snippet: string; startLine: number; endLine: number; truncated: boolean } {
  if (!content) {
    return { snippet: "", startLine: 1, endLine: 0, truncated: false }
  }
  const lines = splitContentLines(content)
  const maxLines = Math.max(1, options?.maxLines ?? 160)
  const rawStart =
    typeof options?.startLine === "number" && Number.isFinite(options.startLine)
      ? Math.max(1, Math.floor(options.startLine))
      : 1
  const rawEnd =
    typeof options?.endLine === "number" && Number.isFinite(options.endLine)
      ? Math.max(rawStart, Math.floor(options.endLine))
      : Math.max(rawStart, Math.min(lines.length, rawStart + maxLines - 1))
  const endLine = Math.min(lines.length || rawEnd, rawEnd)
  const lineCount = Math.max(0, endLine - rawStart + 1)
  const visibleCount = Math.min(lineCount, maxLines)
  const visibleEnd = rawStart + visibleCount - 1
  const numbered = lines
    .slice(rawStart - 1, visibleEnd)
    .map((line, index) => `${rawStart + index} | ${line}`)
    .join("\n")

  return {
    snippet: numbered,
    startLine: rawStart,
    endLine: visibleEnd,
    truncated: lineCount > visibleCount,
  }
}
