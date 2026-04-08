import { Injectable } from "@nestjs/common"
import { randomUUID } from "crypto"
import {
  ContextCompactionCommit,
  ContextConversationState,
  ProjectedContextMessage,
  UnifiedMessage,
} from "./types"
import {
  ContextAttachmentBuilderService,
  ContextAttachmentSnapshot,
} from "./context-attachment-builder.service"
import { ContextProjectionService } from "./context-projection.service"
import { ContextSummaryService } from "./context-summary.service"
import { ContextUsageLedgerService } from "./context-usage-ledger.service"
import { TokenCounterService } from "./token-counter.service"
import { ToolIntegrityService } from "./tool-integrity.service"

export interface ContextCompactionResult {
  messages: UnifiedMessage[]
  projectedMessages: ProjectedContextMessage[]
  estimatedTokens: number
  wasCompacted: boolean
}

@Injectable()
export class ContextCompactionService {
  private readonly MIN_REQUEST_BUDGET = 256
  private readonly MIN_SUMMARY_TOKENS = 64
  private readonly MIN_ATTACHMENT_TOKENS = 128
  private readonly SUMMARY_TOKEN_BUDGET = 2400
  private readonly ATTACHMENT_TOKEN_BUDGET = 2200
  private readonly MAX_COMPACTION_ITERATIONS = 3

  constructor(
    private readonly tokenCounter: TokenCounterService,
    private readonly toolIntegrity: ToolIntegrityService,
    private readonly projection: ContextProjectionService,
    private readonly summary: ContextSummaryService,
    private readonly attachments: ContextAttachmentBuilderService,
    private readonly usageLedger: ContextUsageLedgerService
  ) {}

  ensureWithinBudget(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      integrityMode?: "strict-adjacent" | "global"
      pendingToolUseIds?: Iterable<string>
      strategy?: ContextCompactionCommit["strategy"]
    }
  ): ContextCompactionResult {
    const effectiveMaxTokens = Math.max(
      options.maxTokens - options.systemPromptTokens,
      this.MIN_REQUEST_BUDGET
    )
    const attachmentTokenBudget =
      this.resolveAttachmentBudget(effectiveMaxTokens)

    let projected = this.projection.project(
      state,
      this.buildProjectionOptions(snapshot, attachmentTokenBudget)
    )
    let estimated = this.usageLedger.estimateProjectedTokens(
      state,
      projected,
      this.buildProjectionOptions(snapshot, attachmentTokenBudget)
    )
    let wasCompacted = false

    for (
      let iteration = 0;
      iteration < this.MAX_COMPACTION_ITERATIONS &&
      estimated > effectiveMaxTokens;
      iteration++
    ) {
      const nextCommit = this.buildCompactionCommit(
        state,
        projected,
        snapshot,
        effectiveMaxTokens,
        attachmentTokenBudget,
        options.strategy || "auto",
        options.integrityMode
      )
      if (!nextCommit) break

      state.compactionHistory.push(nextCommit)
      state.activeCompactionId = nextCommit.id
      wasCompacted = true

      projected = this.projection.project(
        state,
        this.buildProjectionOptions(snapshot, attachmentTokenBudget)
      )
      estimated = this.usageLedger.estimateProjectedTokens(
        state,
        projected,
        this.buildProjectionOptions(snapshot, attachmentTokenBudget)
      )
    }

    const fitted = this.hardFitProjection(projected, effectiveMaxTokens, {
      integrityMode: options.integrityMode,
      pendingToolUseIds: options.pendingToolUseIds,
    })

    return {
      messages: fitted,
      projectedMessages: projected,
      estimatedTokens: Math.min(
        this.tokenCounter.countMessages(fitted),
        this.usageLedger.estimateProjectedTokens(
          state,
          projected,
          this.buildProjectionOptions(snapshot, attachmentTokenBudget)
        )
      ),
      wasCompacted,
    }
  }

  private buildCompactionCommit(
    state: ContextConversationState,
    projected: ProjectedContextMessage[],
    snapshot: ContextAttachmentSnapshot,
    effectiveMaxTokens: number,
    attachmentTokenBudget: number,
    strategy: ContextCompactionCommit["strategy"],
    integrityMode?: "strict-adjacent" | "global"
  ): ContextCompactionCommit | null {
    const commitId = randomUUID()
    const summaryBudgetCap = this.resolveSummaryBudgetCap(effectiveMaxTokens)
    const currentActive = this.projection.getActiveCommit(state)
    const currentArchivedIndex = currentActive
      ? state.records.findIndex(
          (record) => record.id === currentActive.archivedThroughRecordId
        )
      : -1
    const candidateRecords = state.records.slice(currentArchivedIndex + 1)
    if (candidateRecords.length === 0) {
      return null
    }

    const liveAttachments = this.attachments.buildAttachments(snapshot, {
      maxTokens: attachmentTokenBudget,
    })
    const attachmentTokens = liveAttachments.reduce(
      (sum, attachment) => sum + attachment.tokenCount,
      0
    )
    const boundaryTokens = this.estimateBoundaryTokens(commitId)
    const summaryEnvelopeTokens = this.estimateSummaryEnvelopeTokens(commitId)
    const targetRecentTokens = Math.max(
      0,
      effectiveMaxTokens -
        boundaryTokens -
        attachmentTokens -
        summaryEnvelopeTokens -
        summaryBudgetCap
    )

    const retainedMessages = candidateRecords.map((record) => ({
      role: record.role,
      content: record.content,
    })) as UnifiedMessage[]
    const truncationIndex = this.toolIntegrity.findTruncationPointWithIntegrity(
      retainedMessages,
      targetRecentTokens,
      { mode: integrityMode }
    )
    if (truncationIndex <= 0) {
      return null
    }

    const archivedRecords = state.records.slice(
      0,
      currentArchivedIndex + 1 + truncationIndex
    )
    const archivedThroughRecordId =
      archivedRecords[archivedRecords.length - 1]?.id ||
      currentActive?.archivedThroughRecordId
    if (!archivedThroughRecordId) {
      return null
    }
    if (currentActive?.archivedThroughRecordId === archivedThroughRecordId) {
      return null
    }

    const suffix = candidateRecords.slice(truncationIndex).map((record) => ({
      role: record.role,
      content: record.content,
    })) as UnifiedMessage[]
    const suffixTokens = this.tokenCounter.countMessages(suffix)
    const summaryBudget = Math.min(
      summaryBudgetCap,
      Math.max(
        this.MIN_SUMMARY_TOKENS,
        effectiveMaxTokens -
          boundaryTokens -
          attachmentTokens -
          summaryEnvelopeTokens -
          suffixTokens
      )
    )
    const summary = this.summary.buildSummary(archivedRecords, {
      maxTokens: summaryBudget,
    })

    const projectionAnchorRecordId = [...projected]
      .reverse()
      .find((message) => !!message.recordId)?.recordId
    const commitBase: ContextCompactionCommit = {
      id: commitId,
      strategy,
      createdAt: Date.now(),
      archivedThroughRecordId,
      projectionAnchorRecordId,
      archivedMessageCount: archivedRecords.length,
      sourceTokenCount: this.tokenCounter.countMessages(
        archivedRecords.map((record) => ({
          role: record.role,
          content: record.content,
        })) as UnifiedMessage[]
      ),
      summary: summary.text,
      summaryTokenCount: summary.tokenCount,
      projectedTokenCount: 0,
    }

    const simulatedState: ContextConversationState = {
      ...state,
      compactionHistory: [...state.compactionHistory, commitBase],
      activeCompactionId: commitBase.id,
      usageLedger: state.usageLedger,
      records: state.records,
    }
    commitBase.projectedTokenCount = this.tokenCounter.countMessages(
      this.projection
        .project(
          simulatedState,
          this.buildProjectionOptions(snapshot, attachmentTokenBudget)
        )
        .map((message) => ({
          role: message.role,
          content: message.content,
        })) as UnifiedMessage[]
    )

    return commitBase
  }

  private resolveAttachmentBudget(effectiveMaxTokens: number): number {
    return Math.min(
      this.ATTACHMENT_TOKEN_BUDGET,
      Math.max(
        this.MIN_ATTACHMENT_TOKENS,
        Math.floor(effectiveMaxTokens * 0.18)
      )
    )
  }

  private resolveSummaryBudgetCap(effectiveMaxTokens: number): number {
    return Math.min(
      this.SUMMARY_TOKEN_BUDGET,
      Math.max(this.MIN_SUMMARY_TOKENS, Math.floor(effectiveMaxTokens * 0.22))
    )
  }

  private buildProjectionOptions(
    snapshot: ContextAttachmentSnapshot,
    attachmentTokenBudget: number
  ): {
    attachmentSnapshot: ContextAttachmentSnapshot
    attachmentTokenBudget: number
  } {
    return {
      attachmentSnapshot: snapshot,
      attachmentTokenBudget,
    }
  }

  private estimateBoundaryTokens(commitId: string): number {
    return this.tokenCounter.countMessages([
      {
        role: "user",
        content:
          `[Context boundary ${commitId}]\n` +
          `Earlier conversation history was compacted into a structured summary. ` +
          `Continue from the retained messages below without explicitly acknowledging this boundary.`,
      },
    ])
  }

  private estimateSummaryEnvelopeTokens(commitId: string): number {
    return this.tokenCounter.countMessages([
      {
        role: "user",
        content:
          `[Context summary ${commitId}]\n\n` +
          `Do not answer this summary directly. Use it only as compressed working context.`,
      },
    ])
  }

  private hardFitProjection(
    projected: ProjectedContextMessage[],
    maxTokens: number,
    options?: {
      pendingToolUseIds?: Iterable<string>
      integrityMode?: "strict-adjacent" | "global"
    }
  ): UnifiedMessage[] {
    const unified = this.toUnifiedMessages(projected)

    let fitted = unified
    const initialTokens = this.tokenCounter.countMessages(fitted)
    if (initialTokens <= maxTokens) {
      return fitted
    }

    const firstRecordIndex = projected.findIndex(
      (message) => message.source === "record"
    )
    const protectedPrefix =
      firstRecordIndex < 0 ? projected : projected.slice(0, firstRecordIndex)
    const retainedRecords =
      firstRecordIndex < 0 ? [] : projected.slice(firstRecordIndex)

    if (protectedPrefix.length > 0) {
      const fittedPrefix = this.fitProtectedPrefix(
        protectedPrefix,
        maxTokens,
        options
      )
      const prefixTokens = this.tokenCounter.countMessages(fittedPrefix)

      if (retainedRecords.length === 0 || prefixTokens >= maxTokens) {
        return this.toolIntegrity.sanitizeMessages(fittedPrefix, {
          mode: options?.integrityMode ?? "global",
          pendingToolUseIds: options?.pendingToolUseIds,
        }).messages
      }

      const recordBudget = Math.max(0, maxTokens - prefixTokens + 3)
      const retainedUnified = this.toUnifiedMessages(retainedRecords)
      const truncationIndex =
        this.toolIntegrity.findTruncationPointWithIntegrity(
          retainedUnified,
          recordBudget,
          { mode: options?.integrityMode }
        )

      let fittedRecords = retainedUnified.slice(truncationIndex)
      fitted = [...fittedPrefix, ...fittedRecords]

      while (
        fittedRecords.length > 0 &&
        this.tokenCounter.countMessages(fitted) > maxTokens
      ) {
        fittedRecords = fittedRecords.slice(1)
        fitted = [...fittedPrefix, ...fittedRecords]
      }

      if (this.tokenCounter.countMessages(fitted) <= maxTokens) {
        return this.toolIntegrity.sanitizeMessages(fitted, {
          mode: options?.integrityMode ?? "global",
          pendingToolUseIds: options?.pendingToolUseIds,
        }).messages
      }

      return this.toolIntegrity.sanitizeMessages(fittedPrefix, {
        mode: options?.integrityMode ?? "global",
        pendingToolUseIds: options?.pendingToolUseIds,
      }).messages
    }

    fitted = this.truncateUnifiedMessagesToBudget(unified, maxTokens, {
      integrityMode: options?.integrityMode,
    })

    while (
      fitted.length > 1 &&
      this.tokenCounter.countMessages(fitted) > maxTokens
    ) {
      fitted = fitted.slice(1)
    }

    return this.toolIntegrity.sanitizeMessages(fitted, {
      mode: options?.integrityMode ?? "global",
      pendingToolUseIds: options?.pendingToolUseIds,
    }).messages
  }

  private fitProtectedPrefix(
    projected: ProjectedContextMessage[],
    maxTokens: number,
    options?: {
      pendingToolUseIds?: Iterable<string>
      integrityMode?: "strict-adjacent" | "global"
    }
  ): UnifiedMessage[] {
    const protectedMessages = projected.filter(
      (message) => message.source !== "attachment"
    )
    const attachments = projected.filter(
      (message) => message.source === "attachment"
    )
    let keptAttachments = [...attachments]

    while (keptAttachments.length >= 0) {
      const candidate = this.toUnifiedMessages([
        ...protectedMessages,
        ...keptAttachments,
      ])
      if (this.tokenCounter.countMessages(candidate) <= maxTokens) {
        return candidate
      }
      if (keptAttachments.length === 0) {
        break
      }
      keptAttachments = keptAttachments.slice(0, -1)
    }

    const protectedUnified = this.toUnifiedMessages(protectedMessages)
    if (this.tokenCounter.countMessages(protectedUnified) <= maxTokens) {
      return protectedUnified
    }

    return this.toolIntegrity.sanitizeMessages(
      this.truncateUnifiedMessagesToBudget(protectedUnified, maxTokens, {
        integrityMode: options?.integrityMode,
      }),
      {
        mode: options?.integrityMode ?? "global",
        pendingToolUseIds: options?.pendingToolUseIds,
      }
    ).messages
  }

  private truncateUnifiedMessagesToBudget(
    messages: UnifiedMessage[],
    maxTokens: number,
    options?: {
      integrityMode?: "strict-adjacent" | "global"
    }
  ): UnifiedMessage[] {
    const truncationIndex = this.toolIntegrity.findTruncationPointWithIntegrity(
      messages,
      maxTokens,
      { mode: options?.integrityMode }
    )
    return messages.slice(truncationIndex)
  }

  private toUnifiedMessages(
    projected: ProjectedContextMessage[]
  ): UnifiedMessage[] {
    return projected.map((message) => ({
      role: message.role,
      content: message.content,
    })) as UnifiedMessage[]
  }
}
