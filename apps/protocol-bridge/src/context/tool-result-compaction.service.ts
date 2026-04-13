import { Injectable, Logger } from "@nestjs/common"
import {
  ContextToolResultReplacementState,
  ContextTranscriptRecord,
  ContentBlock,
  ToolResultBlock,
  UnifiedMessage,
  isToolResultBlock,
  isToolUseBlock,
  normalizeContent,
} from "./types"
import { TokenCounterService } from "./token-counter.service"

type ToolMetadata = {
  name: string
  input: Record<string, unknown>
}

type ToolResultReference = {
  recordIndex: number
  blockIndex: number
  toolUseId: string
  toolName: string
  toolInput: Record<string, unknown>
  outputPreview: string
  size: number
  roundIndex: number
  eligibleForCompaction: boolean
  existingReplacement?: string
}

type ApiRound = {
  roundIndex: number
  assistantRecordIndex: number
  results: ToolResultReference[]
}

export interface ToolResultCompactionOptions {
  trigger: "reactive" | "preflight"
  targetTokens?: number
  keepRecentRounds?: number
}

export interface ToolResultCompactionResult {
  records: ContextTranscriptRecord[]
  changed: boolean
  trigger: ToolResultCompactionOptions["trigger"]
  clearedToolResults: number
  compactedRounds: number
  keptRecentRounds: number
  estimatedTokens: number
}

@Injectable()
export class ToolResultCompactionService {
  private readonly logger = new Logger(ToolResultCompactionService.name)
  private readonly CLEARED_MESSAGE = "[Old tool result content cleared]"
  private readonly COMPACTED_PREFIX = "[Compacted tool result summary]"
  private readonly KEEP_RECENT_ROUNDS = 6
  private readonly MAX_OUTPUT_SUMMARY_CHARS = 420
  private readonly MAX_INPUT_SUMMARY_CHARS = 220
  private readonly COMPACTABLE_TOOLS = new Set<string>([
    "read_file",
    "read_file_v2",
    "view_file",
    "run_terminal_command",
    "grep_search",
    "glob_search",
    "web_search",
    "web_fetch",
    "edit_file",
    "edit_file_v2",
    "replace_file_content",
    "multi_replace_file_content",
    "write_to_file",
  ])

  constructor(private readonly tokenCounter: TokenCounterService) {}

  compactRecords(
    records: readonly ContextTranscriptRecord[],
    options: ToolResultCompactionOptions,
    replacementState?: ContextToolResultReplacementState
  ): ToolResultCompactionResult {
    const estimatedTokens = this.countRecordTokens(records)
    if (
      records.length === 0 ||
      (options.trigger === "reactive" &&
        options.targetTokens != null &&
        estimatedTokens <= options.targetTokens)
    ) {
      return {
        records: records as ContextTranscriptRecord[],
        changed: false,
        trigger: options.trigger,
        clearedToolResults: 0,
        compactedRounds: 0,
        keptRecentRounds: Math.max(
          1,
          options.keepRecentRounds || this.KEEP_RECENT_ROUNDS
        ),
        estimatedTokens,
      }
    }

    const toolMetadata = this.buildToolMetadata(records)
    const rounds = this.collectApiRounds(records, toolMetadata)
    if (rounds.length === 0) {
      return {
        records: records as ContextTranscriptRecord[],
        changed: false,
        trigger: options.trigger,
        clearedToolResults: 0,
        compactedRounds: 0,
        keptRecentRounds: Math.max(
          1,
          options.keepRecentRounds || this.KEEP_RECENT_ROUNDS
        ),
        estimatedTokens,
      }
    }

    const keepRecentRounds = Math.max(
      1,
      options.keepRecentRounds || this.KEEP_RECENT_ROUNDS
    )
    const replacementTextByToolUseId = new Map<string, string>()
    const priorSeenToolUseIds = new Set(replacementState?.seenToolUseIds || [])
    const persistedReplacements = new Map(
      Object.entries(replacementState?.replacementByToolUseId || {})
    )

    this.primePersistedReplacements(
      rounds,
      replacementTextByToolUseId,
      persistedReplacements
    )

    let workingRecords =
      replacementTextByToolUseId.size > 0
        ? this.applyReplacements(records, replacementTextByToolUseId)
        : (records as ContextTranscriptRecord[])
    let workingTokens = this.countRecordTokens(workingRecords)
    let compactedRounds = 0

    const protectedRoundStart = Math.max(0, rounds.length - keepRecentRounds)
    const olderRounds = rounds.slice(0, protectedRoundStart)

    for (const round of olderRounds) {
      if (
        options.targetTokens != null &&
        workingTokens <= options.targetTokens
      ) {
        break
      }
      if (
        this.markRoundForCompaction(
          round,
          replacementTextByToolUseId,
          priorSeenToolUseIds
        )
      ) {
        compactedRounds++
        workingRecords = this.applyReplacements(
          records,
          replacementTextByToolUseId
        )
        workingTokens = this.countRecordTokens(workingRecords)
      }
    }

    // If older rounds were not enough, continue compacting more recent rounds
    // but keep the latest round intact so the model still has raw working memory.
    if (
      options.targetTokens != null &&
      workingTokens > options.targetTokens &&
      rounds.length > 1
    ) {
      const fallbackRounds = rounds.slice(protectedRoundStart, -1)
      for (const round of fallbackRounds) {
        if (workingTokens <= options.targetTokens) {
          break
        }
        if (
          this.markRoundForCompaction(
            round,
            replacementTextByToolUseId,
            priorSeenToolUseIds
          )
        ) {
          compactedRounds++
          workingRecords = this.applyReplacements(
            records,
            replacementTextByToolUseId
          )
          workingTokens = this.countRecordTokens(workingRecords)
        }
      }
    }

    this.persistReplacementState(
      replacementState,
      rounds,
      priorSeenToolUseIds,
      replacementTextByToolUseId
    )

    if (replacementTextByToolUseId.size === 0) {
      return {
        records: records as ContextTranscriptRecord[],
        changed: false,
        trigger: options.trigger,
        clearedToolResults: 0,
        compactedRounds: 0,
        keptRecentRounds: keepRecentRounds,
        estimatedTokens,
      }
    }

    this.logger.debug(
      `[${options.trigger}-microcompact] compacted ${replacementTextByToolUseId.size} tool results ` +
        `across ${compactedRounds} API rounds (kept last ${Math.min(
          keepRecentRounds,
          rounds.length
        )}, tokens ${estimatedTokens} -> ${workingTokens})`
    )

    return {
      records: workingRecords,
      changed: true,
      trigger: options.trigger,
      clearedToolResults: replacementTextByToolUseId.size,
      compactedRounds,
      keptRecentRounds: Math.min(keepRecentRounds, rounds.length),
      estimatedTokens: workingTokens,
    }
  }

  private buildToolMetadata(
    records: readonly ContextTranscriptRecord[]
  ): Map<string, ToolMetadata> {
    const metadata = new Map<string, ToolMetadata>()

    for (const record of records) {
      if (record.role !== "assistant") {
        continue
      }

      for (const block of normalizeContent(record.content)) {
        if (!isToolUseBlock(block)) {
          continue
        }
        metadata.set(block.id, {
          name: block.name,
          input: block.input || {},
        })
      }
    }

    return metadata
  }

  private collectApiRounds(
    records: readonly ContextTranscriptRecord[],
    toolMetadata: ReadonlyMap<string, ToolMetadata>
  ): ApiRound[] {
    const rounds: ApiRound[] = []
    let current: ApiRound | undefined

    records.forEach((record, recordIndex) => {
      if (record.role === "assistant") {
        if (current && current.results.length > 0) {
          rounds.push(current)
        }
        current = {
          roundIndex: rounds.length,
          assistantRecordIndex: recordIndex,
          results: [],
        }
        return
      }

      if (!current) {
        return
      }

      normalizeContent(record.content).forEach((block, blockIndex) => {
        if (!isToolResultBlock(block)) {
          return
        }
        const metadata = toolMetadata.get(block.tool_use_id)
        if (!metadata || !this.COMPACTABLE_TOOLS.has(metadata.name)) {
          return
        }

        current!.results.push({
          recordIndex,
          blockIndex,
          toolUseId: block.tool_use_id,
          toolName: metadata.name,
          toolInput: metadata.input,
          outputPreview: this.extractOutputPreview(block),
          size: this.getResultSize(block),
          roundIndex: current!.roundIndex,
          eligibleForCompaction: this.isEligibleResultBlock(block),
          existingReplacement: this.getExistingReplacement(block),
        })
      })
    })

    if (current && current.results.length > 0) {
      rounds.push(current)
    }

    return rounds
  }

  private markRoundForCompaction(
    round: ApiRound,
    replacementTextByToolUseId: Map<string, string>,
    priorSeenToolUseIds: ReadonlySet<string>
  ): boolean {
    let changed = false
    for (const result of round.results) {
      if (!result.eligibleForCompaction) {
        continue
      }
      if (replacementTextByToolUseId.has(result.toolUseId)) {
        continue
      }
      if (priorSeenToolUseIds.has(result.toolUseId)) {
        continue
      }
      replacementTextByToolUseId.set(
        result.toolUseId,
        result.existingReplacement || this.buildCompactedContent(result)
      )
      changed = true
    }
    return changed
  }

  private primePersistedReplacements(
    rounds: readonly ApiRound[],
    replacementTextByToolUseId: Map<string, string>,
    persistedReplacements: ReadonlyMap<string, string>
  ): void {
    for (const round of rounds) {
      for (const result of round.results) {
        if (!result.eligibleForCompaction) {
          continue
        }
        const replacement = persistedReplacements.get(result.toolUseId)
        if (!replacement) {
          continue
        }
        replacementTextByToolUseId.set(result.toolUseId, replacement)
      }
    }
  }

  private persistReplacementState(
    replacementState: ContextToolResultReplacementState | undefined,
    rounds: readonly ApiRound[],
    priorSeenToolUseIds: ReadonlySet<string>,
    replacementTextByToolUseId: ReadonlyMap<string, string>
  ): void {
    if (!replacementState) {
      return
    }

    // Only mark tool_use_ids as "seen" when they were actually compacted
    // (i.e. present in replacementTextByToolUseId).  Recording ids from
    // keepRecentRounds that were intentionally left un-compacted would
    // prevent them from ever being summarized once they age into
    // olderRounds on a later pass.
    const seenToolUseIds = new Set(priorSeenToolUseIds)
    for (const round of rounds) {
      for (const result of round.results) {
        if (replacementTextByToolUseId.has(result.toolUseId)) {
          seenToolUseIds.add(result.toolUseId)
        }
      }
    }
    replacementState.seenToolUseIds = Array.from(seenToolUseIds)

    const nextReplacementByToolUseId = {
      ...(replacementState.replacementByToolUseId || {}),
    }
    for (const [toolUseId, replacement] of replacementTextByToolUseId) {
      nextReplacementByToolUseId[toolUseId] = replacement
    }
    replacementState.replacementByToolUseId = nextReplacementByToolUseId
  }

  private applyReplacements(
    records: readonly ContextTranscriptRecord[],
    replacementTextByToolUseId: ReadonlyMap<string, string>
  ): ContextTranscriptRecord[] {
    return records.map((record) => {
      if (record.role !== "user") {
        return record
      }

      const content = normalizeContent(record.content)
      let touched = false
      const replacedContent = content.map((block) => {
        if (!isToolResultBlock(block) || !this.isEligibleResultBlock(block)) {
          return block
        }
        const replacement = replacementTextByToolUseId.get(block.tool_use_id)
        if (!replacement) {
          return block
        }
        touched = true
        const { structuredContent: _structuredContent, ...rest } = block
        return {
          ...rest,
          content: replacement,
        }
      })

      if (!touched) {
        return record
      }

      return {
        ...record,
        content: replacedContent,
      }
    })
  }

  private buildCompactedContent(result: ToolResultReference): string {
    const inputSummary = this.summarizeToolInput(result.toolInput)
    const outputSummary = this.summarizeToolOutput(
      result.toolName,
      result.toolInput,
      result.outputPreview
    )

    const lines = [this.COMPACTED_PREFIX, `Tool: ${result.toolName}`]

    if (inputSummary) {
      lines.push(`Input: ${inputSummary}`)
    }
    if (outputSummary) {
      lines.push(`Evidence: ${outputSummary}`)
    } else {
      lines.push(`Evidence: output omitted to reduce prompt size.`)
    }

    return lines.join("\n")
  }

  private summarizeToolInput(input: Record<string, unknown>): string {
    const parts: string[] = []

    const pushString = (
      key: string,
      label: string,
      maxChars: number = 100
    ): void => {
      const value = input[key]
      if (typeof value !== "string" || !value.trim()) {
        return
      }
      parts.push(`${label}=${this.truncateInline(value.trim(), maxChars)}`)
    }

    pushString("path", "path")
    pushString("AbsolutePath", "path")
    pushString("target_file", "file")
    pushString("TargetFile", "file")
    pushString("command", "command", 140)
    pushString("query", "query")
    pushString("pattern", "pattern")
    pushString("regex", "regex")
    pushString("url", "url", 140)

    const pathList = Array.isArray(input.paths)
      ? input.paths.filter(
          (value): value is string => typeof value === "string"
        )
      : []
    if (pathList.length > 0) {
      parts.push(
        `paths=${this.truncateInline(pathList.slice(0, 3).join(", "), 120)}`
      )
    }

    const startLine =
      this.readNumericField(input, "start_line") ??
      this.readNumericField(input, "startLine") ??
      this.readNumericField(input, "StartLine")
    const endLine =
      this.readNumericField(input, "end_line") ??
      this.readNumericField(input, "endLine") ??
      this.readNumericField(input, "EndLine")
    if (startLine != null || endLine != null) {
      parts.push(`lines=${startLine ?? "?"}-${endLine ?? "?"}`)
    }

    const before = this.readStringField(input, "old_string")
    const after = this.readStringField(input, "new_string")
    if (before) {
      parts.push(`old=${this.truncateInline(before, 80)}`)
    }
    if (after) {
      parts.push(`new=${this.truncateInline(after, 80)}`)
    }

    if (parts.length === 0) {
      try {
        const serialized = JSON.stringify(input)
        if (serialized && serialized !== "{}") {
          parts.push(
            this.truncateInline(serialized, this.MAX_INPUT_SUMMARY_CHARS)
          )
        }
      } catch {
        return ""
      }
    }

    return this.truncateInline(parts.join(", "), this.MAX_INPUT_SUMMARY_CHARS)
  }

  private summarizeToolOutput(
    toolName: string,
    toolInput: Record<string, unknown>,
    outputPreview: string
  ): string {
    const hints: string[] = []

    if (
      toolName === "read_file" ||
      toolName === "read_file_v2" ||
      toolName === "view_file" ||
      toolName === "edit_file" ||
      toolName === "edit_file_v2" ||
      toolName === "replace_file_content" ||
      toolName === "multi_replace_file_content" ||
      toolName === "write_to_file"
    ) {
      const path =
        this.readStringField(toolInput, "path") ||
        this.readStringField(toolInput, "AbsolutePath") ||
        this.readStringField(toolInput, "TargetFile")
      if (path) {
        hints.push(`worked on ${path}`)
      }
    }

    if (toolName === "grep_search") {
      const pattern = this.readStringField(toolInput, "pattern")
      if (pattern) {
        hints.push(`searched for ${this.truncateInline(pattern, 60)}`)
      }
    }

    if (toolName === "run_terminal_command") {
      const command = this.readStringField(toolInput, "command")
      if (command) {
        hints.push(`ran ${this.truncateInline(command, 80)}`)
      }
    }

    if (outputPreview) {
      hints.push(`output=${this.truncateInline(outputPreview, 220)}`)
    }

    return this.truncateInline(hints.join(", "), this.MAX_OUTPUT_SUMMARY_CHARS)
  }

  private extractOutputPreview(block: ToolResultBlock): string {
    const textContent = this.extractTextContent(block.content)
    const structuredPreview = this.extractStructuredPreview(
      block.structuredContent
    )
    const preferredPreview =
      (this.isAlreadyCompacted(block.content) && structuredPreview) ||
      textContent ||
      structuredPreview

    return this.truncateInline(
      preferredPreview.replace(/\s+/g, " ").trim(),
      this.MAX_OUTPUT_SUMMARY_CHARS
    )
  }

  private extractTextContent(content: ToolResultBlock["content"]): string {
    if (typeof content === "string") {
      return content
    }

    return content
      .filter(
        (block): block is Extract<ContentBlock, { type: "text" }> =>
          block.type === "text"
      )
      .map((block) => block.text)
      .join("\n")
  }

  private extractStructuredPreview(
    structuredContent: ToolResultBlock["structuredContent"]
  ): string {
    if (!structuredContent) {
      return ""
    }

    const output = structuredContent.output
    if (typeof output === "string") {
      return output
    }

    return this.safeStringify(structuredContent)
  }

  private safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value) || ""
    } catch {
      return ""
    }
  }

  private readNumericField(
    input: Record<string, unknown>,
    key: string
  ): number | undefined {
    const value = input[key]
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined
  }

  private readStringField(
    input: Record<string, unknown>,
    key: string
  ): string | undefined {
    const value = input[key]
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : undefined
  }

  private truncateInline(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
      return text
    }
    return `${text.slice(0, Math.max(0, maxChars - 3))}...`
  }

  private isEligibleResultBlock(block: ToolResultBlock): boolean {
    if (this.isFullyCompacted(block)) {
      return false
    }
    if (this.isResultEmpty(block)) {
      return false
    }
    if (Array.isArray(block.content)) {
      return !block.content.some(
        (contentBlock) =>
          typeof contentBlock === "object" &&
          contentBlock !== null &&
          "type" in contentBlock &&
          contentBlock.type === "image"
      )
    }
    return true
  }

  private isFullyCompacted(block: ToolResultBlock): boolean {
    return (
      this.isAlreadyCompacted(block.content) &&
      !this.hasStructuredContent(block.structuredContent)
    )
  }

  private isAlreadyCompacted(content: ToolResultBlock["content"]): boolean {
    return (
      typeof content === "string" &&
      (content === this.CLEARED_MESSAGE ||
        content.startsWith(this.COMPACTED_PREFIX))
    )
  }

  private isResultEmpty(block: ToolResultBlock): boolean {
    return (
      this.isContentEmpty(block.content) &&
      !this.hasStructuredContent(block.structuredContent)
    )
  }

  private isContentEmpty(content: ToolResultBlock["content"]): boolean {
    if (typeof content === "string") {
      return content.trim().length === 0
    }
    if (!Array.isArray(content)) {
      return true
    }
    if (content.length === 0) {
      return true
    }
    return content.every((block) => this.isEmptyTextBlock(block))
  }

  private isEmptyTextBlock(block: ContentBlock): boolean {
    return block.type === "text" && block.text.trim().length === 0
  }

  private hasStructuredContent(
    structuredContent: ToolResultBlock["structuredContent"]
  ): boolean {
    return Boolean(
      structuredContent && Object.keys(structuredContent).length > 0
    )
  }

  private getExistingReplacement(block: ToolResultBlock): string | undefined {
    return typeof block.content === "string" &&
      this.isAlreadyCompacted(block.content)
      ? block.content
      : undefined
  }

  private getResultSize(block: ToolResultBlock): number {
    const contentSize = this.getContentSize(block.content)
    const structuredSize = this.getStructuredContentSize(
      block.structuredContent
    )
    return Math.max(contentSize, structuredSize)
  }

  private getContentSize(content: ToolResultBlock["content"]): number {
    if (typeof content === "string") {
      return content.length
    }
    return content.reduce((sum, block) => {
      if (block.type === "text") {
        return sum + block.text.length
      }
      return sum
    }, 0)
  }

  private getStructuredContentSize(
    structuredContent: ToolResultBlock["structuredContent"]
  ): number {
    if (!structuredContent) {
      return 0
    }

    return this.safeStringify(structuredContent).length
  }

  private countRecordTokens(
    records: readonly ContextTranscriptRecord[]
  ): number {
    const messages = records.map((record) => ({
      role: record.role,
      content: record.content,
    })) as UnifiedMessage[]
    return this.tokenCounter.countMessages(messages)
  }
}
