import { Injectable } from "@nestjs/common"
import { createHash, randomUUID } from "crypto"
import {
  ContextCompactionCommit,
  ContextConversationState,
  ContextTranscriptRecord,
  ProjectedContextMessage,
  UnifiedMessage,
} from "./types"
import {
  ContextAttachmentBuilderService,
  ContextAttachmentSnapshot,
} from "./context-attachment-builder.service"
import { ContextProjectionService } from "./context-projection.service"
import { ContextSummaryService } from "./context-summary.service"
import {
  ToolResultCompactionResult,
  ToolResultCompactionService,
} from "./tool-result-compaction.service"
import { ContextUsageLedgerService } from "./context-usage-ledger.service"
import { TokenCounterService } from "./token-counter.service"
import { ToolIntegrityService } from "./tool-integrity.service"

export interface ContextCompactionPlan {
  commit: ContextCompactionCommit
  projectedMessages: ProjectedContextMessage[]
  estimatedTokens: number
  attachmentFingerprint: string
  recordCount: number
}

export interface ContextSnipCompactionResult {
  changed: boolean
  removedRecords: number
  retainedRecords: number
  summaryTokenCount: number
  estimatedTokens: number
}

export interface ContextCompactionResult {
  messages: UnifiedMessage[]
  projectedMessages: ProjectedContextMessage[]
  estimatedTokens: number
  wasCompacted: boolean
  appliedCompaction?: ContextCompactionPlan
  snipCompaction?: ContextSnipCompactionResult
  microcompactCompaction?: ToolResultCompactionResult
  toolResultCompaction?: ToolResultCompactionResult
}

interface RuntimeSnipState {
  removedRecords: number
  summaryText: string
  summaryTokenCount: number
}

@Injectable()
export class ContextCompactionService {
  private readonly MIN_REQUEST_BUDGET = 256
  private readonly MIN_SUMMARY_TOKENS = 64
  private readonly MIN_ATTACHMENT_TOKENS = 128
  private readonly SUMMARY_TOKEN_BUDGET = 2400
  private readonly ATTACHMENT_TOKEN_BUDGET = 2200
  private readonly INVESTIGATION_MEMORY_ATTACHMENT_BONUS = 320
  private readonly MAX_COMPACTION_ITERATIONS = 3
  private readonly SNIP_SUMMARY_TOKEN_BUDGET = 320
  private readonly SNIP_MIN_REMOVED_RECORDS = 2

  constructor(
    private readonly tokenCounter: TokenCounterService,
    private readonly toolIntegrity: ToolIntegrityService,
    private readonly projection: ContextProjectionService,
    private readonly summary: ContextSummaryService,
    private readonly toolResultCompaction: ToolResultCompactionService,
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
    const hasInvestigationMemory =
      (snapshot.investigationSummaries?.length ?? 0) > 0
    const attachmentTokenBudget = this.resolveAttachmentBudget(
      effectiveMaxTokens,
      hasInvestigationMemory
    )
    let recordsOverride: ContextTranscriptRecord[] | undefined
    let snipState: RuntimeSnipState | undefined
    let projected = this.buildProjectedMessages(
      state,
      snapshot,
      attachmentTokenBudget,
      recordsOverride,
      snipState
    )
    let estimated = this.usageLedger.estimateProjectedTokens(state, projected)
    let appliedCompaction: ContextCompactionPlan | undefined
    let snipCompaction: ContextSnipCompactionResult | undefined
    let microcompactCompaction: ToolResultCompactionResult | undefined

    const snipCompactionAttempt =
      estimated > effectiveMaxTokens
        ? this.applySnipCompaction(
            state,
            snapshot,
            attachmentTokenBudget,
            effectiveMaxTokens,
            options.integrityMode,
            recordsOverride
          )
        : undefined
    if (snipCompactionAttempt?.changed) {
      snipState = snipCompactionAttempt.snipState
      recordsOverride = snipCompactionAttempt.recordsOverride
      projected = snipCompactionAttempt.projectedMessages
      estimated = snipCompactionAttempt.estimatedTokens
      snipCompaction = snipCompactionAttempt.result
    }

    const preflightMicrocompact =
      estimated > effectiveMaxTokens
        ? this.applyToolResultMicrocompact(
            state,
            snapshot,
            attachmentTokenBudget,
            effectiveMaxTokens,
            "preflight",
            recordsOverride,
            snipState
          )
        : undefined
    if (preflightMicrocompact?.changed) {
      recordsOverride = preflightMicrocompact.recordsOverride
      projected = preflightMicrocompact.projectedMessages
      estimated = preflightMicrocompact.estimatedTokens
      microcompactCompaction = preflightMicrocompact.result
    }

    for (
      let iteration = 0;
      iteration < this.MAX_COMPACTION_ITERATIONS &&
      estimated > effectiveMaxTokens;
      iteration++
    ) {
      const nextPlan = this.planCompaction(
        state,
        projected,
        snapshot,
        effectiveMaxTokens,
        attachmentTokenBudget,
        options.strategy || "auto",
        options.integrityMode,
        recordsOverride
      )
      if (!nextPlan) break

      if (!this.canApplyCompactionPlan(state, nextPlan)) {
        break
      }

      this.applyCompactionPlan(state, nextPlan)
      appliedCompaction = nextPlan

      projected = this.buildProjectedMessages(
        state,
        snapshot,
        attachmentTokenBudget,
        recordsOverride,
        snipState
      )
      estimated = this.usageLedger.estimateProjectedTokens(state, projected)
    }

    const reactiveCompaction =
      estimated > effectiveMaxTokens
        ? this.applyToolResultMicrocompact(
            state,
            snapshot,
            attachmentTokenBudget,
            effectiveMaxTokens,
            "reactive",
            recordsOverride,
            snipState
          )
        : undefined

    if (reactiveCompaction?.changed) {
      recordsOverride = reactiveCompaction.recordsOverride
      projected = reactiveCompaction.projectedMessages
      estimated = reactiveCompaction.estimatedTokens
      microcompactCompaction = reactiveCompaction.result
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
        this.usageLedger.estimateProjectedTokens(state, projected)
      ),
      wasCompacted: !!appliedCompaction,
      appliedCompaction,
      snipCompaction,
      microcompactCompaction,
      toolResultCompaction: microcompactCompaction,
    }
  }

  private planCompaction(
    state: ContextConversationState,
    projected: ProjectedContextMessage[],
    snapshot: ContextAttachmentSnapshot,
    effectiveMaxTokens: number,
    attachmentTokenBudget: number,
    strategy: ContextCompactionCommit["strategy"],
    integrityMode?: "strict-adjacent" | "global",
    recordsOverride?: readonly ContextTranscriptRecord[]
  ): ContextCompactionPlan | null {
    const commitId = randomUUID()
    const summaryBudgetCap = this.resolveSummaryBudgetCap(effectiveMaxTokens)
    const currentActive = this.projection.getActiveCommit(state)
    const sourceRecords = recordsOverride || state.records
    const currentArchivedIndex = currentActive
      ? sourceRecords.findIndex(
          (record) => record.id === currentActive.archivedThroughRecordId
        )
      : -1
    const candidateRecords = sourceRecords.slice(currentArchivedIndex + 1)
    if (candidateRecords.length === 0) {
      return null
    }
    const protectedProjection =
      projected.findIndex((message) => message.source === "record") >= 0
        ? projected.slice(
            0,
            projected.findIndex((message) => message.source === "record")
          )
        : projected
    const protectedProjectionTokens = this.tokenCounter.countMessages(
      this.toUnifiedMessages(protectedProjection)
    )
    const liveAttachments = this.attachments.buildAttachments(snapshot, {
      maxTokens: attachmentTokenBudget,
    })
    const boundaryTokens = this.estimateBoundaryTokens(commitId)
    const summaryEnvelopeTokens = this.estimateSummaryEnvelopeTokens(commitId)
    const targetRecentTokens = Math.max(
      0,
      effectiveMaxTokens -
        protectedProjectionTokens -
        boundaryTokens -
        summaryEnvelopeTokens -
        summaryBudgetCap
    )

    const retainedMessages = candidateRecords.map((record) => ({
      role: record.role,
      content: record.content,
    })) as UnifiedMessage[]
    const truncationIndex =
      this.toolIntegrity.findBudgetSafeTruncationPointWithIntegrity(
        retainedMessages,
        targetRecentTokens,
        { mode: integrityMode }
      )
    if (truncationIndex <= 0) {
      return null
    }

    const archivedRecords = candidateRecords.slice(0, truncationIndex)
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
          protectedProjectionTokens -
          boundaryTokens -
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
    const attachmentFingerprint = createHash("sha256")
      .update(
        liveAttachments
          .map((attachment) => `${attachment.kind}:${attachment.content}`)
          .join("\n---\n")
      )
      .digest("hex")
    const nextEpoch = (state.compactionEpoch || 0) + 1
    const commitBase: ContextCompactionCommit = {
      id: commitId,
      strategy,
      createdAt: Date.now(),
      epoch: nextEpoch,
      parentCompactionId: currentActive?.id,
      archivedThroughRecordId,
      projectionAnchorRecordId,
      archivedMessageCount: archivedRecords.length,
      sourceRecordCount: archivedRecords.length,
      attachmentFingerprint,
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
      compactionEpoch: nextEpoch,
      lastAppliedCompaction: {
        recordCount: sourceRecords.length,
        attachmentFingerprint,
        appliedAt: commitBase.createdAt,
        compactionId: commitBase.id,
        epoch: nextEpoch,
      },
    }
    const projectedMessages = this.projection.project(simulatedState, {
      ...this.buildProjectionOptions(snapshot, attachmentTokenBudget),
      recordsOverride,
    })
    commitBase.projectedTokenCount = this.tokenCounter.countMessages(
      projectedMessages.map((message) => ({
        role: message.role,
        content: message.content,
      })) as UnifiedMessage[]
    )

    return {
      commit: commitBase,
      projectedMessages,
      estimatedTokens: this.usageLedger.estimateProjectedTokens(
        simulatedState,
        projectedMessages
      ),
      attachmentFingerprint,
      recordCount: sourceRecords.length,
    }
  }

  private canApplyCompactionPlan(
    state: ContextConversationState,
    plan: ContextCompactionPlan
  ): boolean {
    return (
      this.projection.getActiveCommit(state)?.archivedThroughRecordId !==
      plan.commit.archivedThroughRecordId
    )
  }

  private applyCompactionPlan(
    state: ContextConversationState,
    plan: ContextCompactionPlan
  ): void {
    state.compactionHistory.push(plan.commit)
    state.activeCompactionId = plan.commit.id
    const nextEpoch = (state.compactionEpoch || 0) + 1
    state.compactionEpoch = nextEpoch
    state.lastAppliedCompaction = {
      recordCount: plan.recordCount,
      attachmentFingerprint: plan.attachmentFingerprint,
      appliedAt: Date.now(),
      compactionId: plan.commit.id,
      epoch: plan.commit.epoch ?? nextEpoch,
    }
    // Prune investigation memory entries whose evidence was fully archived
    // by this compaction commit so stale references don't accumulate.
    this.pruneArchivedInvestigationMemory(
      state,
      plan.commit.archivedThroughRecordId
    )
  }

  private pruneArchivedInvestigationMemory(
    state: ContextConversationState,
    archivedThroughRecordId: string
  ): void {
    if (state.investigationMemory.length === 0) return
    const archivedRecord = state.records.find(
      (record) => record.id === archivedThroughRecordId
    )
    if (!archivedRecord) return
    const cutoff = archivedRecord.createdAt
    state.investigationMemory = state.investigationMemory.filter(
      // Use strict > because entries created at the same millisecond as
      // the archived record boundary are fully covered by this compaction
      // commit's summary and should be pruned to avoid accumulation.
      (entry) => entry.createdAt > cutoff
    )
  }

  private resolveAttachmentBudget(
    effectiveMaxTokens: number,
    hasInvestigationMemory: boolean
  ): number {
    const baseBudget = Math.min(
      this.ATTACHMENT_TOKEN_BUDGET,
      Math.max(
        this.MIN_ATTACHMENT_TOKENS,
        Math.floor(effectiveMaxTokens * 0.18)
      )
    )

    if (!hasInvestigationMemory) {
      return baseBudget
    }

    // Cap the bonus proportionally so it doesn't overwhelm small context
    // windows (e.g. 8k).  At 0.03 * effectiveMaxTokens the bonus scales
    // with the available budget, maxing out at the configured cap.
    const proportionalBonus = Math.min(
      this.INVESTIGATION_MEMORY_ATTACHMENT_BONUS,
      Math.floor(effectiveMaxTokens * 0.03)
    )
    // Allow the bonus to exceed the normal attachment cap so investigation
    // memory actually gets extra room in large-context windows.
    return Math.min(
      this.ATTACHMENT_TOKEN_BUDGET + proportionalBonus,
      baseBudget + proportionalBonus
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
        content: this.projection.renderCompactionBoundary({
          id: commitId,
          strategy: "auto",
          createdAt: Date.now(),
          archivedThroughRecordId: commitId,
          archivedMessageCount: 0,
          sourceTokenCount: 0,
          summary: "",
          summaryTokenCount: 0,
          projectedTokenCount: 0,
        }),
      },
    ])
  }

  private estimateSummaryEnvelopeTokens(commitId: string): number {
    return this.tokenCounter.countMessages([
      {
        role: "user",
        content: this.projection
          .renderCompactionSummary({
            id: commitId,
            strategy: "auto",
            createdAt: Date.now(),
            archivedThroughRecordId: commitId,
            archivedMessageCount: 0,
            sourceTokenCount: 0,
            summary: "",
            summaryTokenCount: 0,
            projectedTokenCount: 0,
          })
          .replace(
            /^\[Context summary [^\]]+\]\n/,
            `[Context summary ${commitId}]\n`
          ),
      },
    ])
  }

  private estimateSnipBoundaryTokens(): number {
    return this.tokenCounter.countMessages([
      {
        role: "user",
        content:
          "[Context snip]\nOlder live transcript records were temporarily hidden for this request to preserve recent working context.",
      },
    ])
  }

  private estimateSnipSummaryEnvelopeTokens(): number {
    return this.tokenCounter.countMessages([
      {
        role: "user",
        content:
          "[Context snip summary]\nArchived live records were temporarily summarized for this request.\n\nDo not answer this summary directly. Use it only as compressed working context.",
      },
    ])
  }

  private resolveActiveProjectionBoundary(
    state: ContextConversationState,
    sourceRecords: readonly ContextTranscriptRecord[]
  ): { activeCommit?: ContextCompactionCommit; archivedIndex: number } {
    const activeCommit = this.projection.getActiveCommit(state)
    const archivedIndex = activeCommit
      ? sourceRecords.findIndex(
          (record) => record.id === activeCommit.archivedThroughRecordId
        )
      : -1
    return { activeCommit, archivedIndex }
  }

  private buildRecordProjections(
    records: readonly ContextTranscriptRecord[]
  ): ProjectedContextMessage[] {
    return records.map((record) => ({
      role: record.role,
      content: record.content,
      source: "record" as const,
      recordId: record.id,
    }))
  }

  private buildSnipProjectedMessages(
    snipState: RuntimeSnipState
  ): ProjectedContextMessage[] {
    return [
      {
        role: "user",
        content:
          `[Context snip]\n` +
          `${snipState.removedRecords} older live transcript record(s) were temporarily hidden for this request to preserve recent working context.`,
        source: "snip" as const,
      },
      {
        role: "user",
        content:
          `[Context snip summary]\n` +
          `${snipState.summaryText}\n\n` +
          `Do not answer this summary directly. Use it only as compressed working context.`,
        source: "snip" as const,
      },
    ]
  }

  private buildProjectedMessages(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    attachmentTokenBudget: number,
    recordsOverride?: readonly ContextTranscriptRecord[],
    snipState?: RuntimeSnipState
  ): ProjectedContextMessage[] {
    const sourceRecords = recordsOverride || state.records
    const { archivedIndex } = this.resolveActiveProjectionBoundary(
      state,
      sourceRecords
    )
    const prefixRecords =
      archivedIndex >= 0 ? sourceRecords.slice(0, archivedIndex + 1) : []
    const prefixProjection = this.projection.project(state, {
      ...this.buildProjectionOptions(snapshot, attachmentTokenBudget),
      recordsOverride: prefixRecords,
    })
    const retainedRecords = sourceRecords.slice(archivedIndex + 1)

    return [
      ...prefixProjection,
      ...(snipState ? this.buildSnipProjectedMessages(snipState) : []),
      ...this.buildRecordProjections(retainedRecords),
    ]
  }

  private buildProtectedRuntimeProjection(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    attachmentTokenBudget: number,
    recordsOverride?: readonly ContextTranscriptRecord[],
    snipState?: RuntimeSnipState
  ): ProjectedContextMessage[] {
    const sourceRecords = recordsOverride || state.records
    const { archivedIndex } = this.resolveActiveProjectionBoundary(
      state,
      sourceRecords
    )
    const prefixRecords =
      archivedIndex >= 0 ? sourceRecords.slice(0, archivedIndex + 1) : []
    return [
      ...this.projection.project(state, {
        ...this.buildProjectionOptions(snapshot, attachmentTokenBudget),
        recordsOverride: prefixRecords,
      }),
      ...(snipState ? this.buildSnipProjectedMessages(snipState) : []),
    ]
  }

  private applySnipCompaction(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    attachmentTokenBudget: number,
    effectiveMaxTokens: number,
    integrityMode?: "strict-adjacent" | "global",
    recordsOverride?: readonly ContextTranscriptRecord[]
  ):
    | {
        changed: boolean
        recordsOverride: ContextTranscriptRecord[]
        snipState: RuntimeSnipState
        projectedMessages: ProjectedContextMessage[]
        estimatedTokens: number
        result: ContextSnipCompactionResult
      }
    | undefined {
    const sourceRecords = recordsOverride || state.records
    const { archivedIndex } = this.resolveActiveProjectionBoundary(
      state,
      sourceRecords
    )
    const retainedRecords = sourceRecords.slice(archivedIndex + 1)
    if (retainedRecords.length <= this.SNIP_MIN_REMOVED_RECORDS) {
      return undefined
    }

    const prefixProjection = this.buildProtectedRuntimeProjection(
      state,
      snapshot,
      attachmentTokenBudget
    )
    const prefixTokens = this.tokenCounter.countMessages(
      this.toUnifiedMessages(prefixProjection)
    )
    const summaryBudget = Math.min(
      this.SNIP_SUMMARY_TOKEN_BUDGET,
      Math.max(this.MIN_SUMMARY_TOKENS, Math.floor(effectiveMaxTokens * 0.08))
    )
    const targetRecentTokens = Math.max(
      0,
      effectiveMaxTokens -
        prefixTokens -
        this.estimateSnipBoundaryTokens() -
        this.estimateSnipSummaryEnvelopeTokens() -
        summaryBudget
    )
    const retainedMessages = retainedRecords.map((record) => ({
      role: record.role,
      content: record.content,
    })) as UnifiedMessage[]
    const truncationIndex =
      this.toolIntegrity.findBudgetSafeTruncationPointWithIntegrity(
        retainedMessages,
        targetRecentTokens,
        { mode: integrityMode }
      )
    if (truncationIndex < this.SNIP_MIN_REMOVED_RECORDS) {
      return undefined
    }

    const removedRecords = retainedRecords.slice(0, truncationIndex)
    const keptRecords = retainedRecords.slice(truncationIndex)
    if (removedRecords.length < this.SNIP_MIN_REMOVED_RECORDS) {
      return undefined
    }

    const summary = this.summary.buildSummary(removedRecords, {
      maxTokens: summaryBudget,
    })
    const snipState: RuntimeSnipState = {
      removedRecords: removedRecords.length,
      summaryText: summary.text,
      summaryTokenCount: summary.tokenCount,
    }
    const nextRecordsOverride = this.mergeRetainedRecords(
      sourceRecords,
      archivedIndex,
      keptRecords
    )
    const projectedMessages = this.buildProjectedMessages(
      state,
      snapshot,
      attachmentTokenBudget,
      nextRecordsOverride,
      snipState
    )
    const estimatedTokens = this.tokenCounter.countMessages(
      this.toUnifiedMessages(projectedMessages)
    )

    return {
      changed: true,
      recordsOverride: nextRecordsOverride,
      snipState,
      projectedMessages,
      estimatedTokens,
      result: {
        changed: true,
        removedRecords: removedRecords.length,
        retainedRecords: keptRecords.length,
        summaryTokenCount: summary.tokenCount,
        estimatedTokens,
      },
    }
  }

  private applyToolResultMicrocompact(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    attachmentTokenBudget: number,
    effectiveMaxTokens: number,
    trigger: "preflight" | "reactive",
    recordsOverride?: readonly ContextTranscriptRecord[],
    snipState?: RuntimeSnipState
  ):
    | {
        changed: boolean
        recordsOverride: ContextTranscriptRecord[]
        projectedMessages: ProjectedContextMessage[]
        estimatedTokens: number
        result: ToolResultCompactionResult
      }
    | undefined {
    const sourceRecords = recordsOverride || state.records
    const { archivedIndex } = this.resolveActiveProjectionBoundary(
      state,
      sourceRecords
    )
    const retainedRecords = sourceRecords.slice(archivedIndex + 1)
    if (retainedRecords.length === 0) {
      return undefined
    }

    const prefixProjection = this.buildProtectedRuntimeProjection(
      state,
      snapshot,
      attachmentTokenBudget,
      sourceRecords,
      snipState
    )
    const prefixTokens = this.tokenCounter.countMessages(
      this.toUnifiedMessages(prefixProjection)
    )
    const recordBudget = Math.max(0, effectiveMaxTokens - prefixTokens)

    const result = this.toolResultCompaction.compactRecords(
      retainedRecords,
      {
        trigger,
        targetTokens: recordBudget,
      },
      state.toolResultReplacementState
    )
    if (!result.changed) {
      return {
        changed: false,
        recordsOverride: [...sourceRecords],
        projectedMessages: this.buildProjectedMessages(
          state,
          snapshot,
          attachmentTokenBudget,
          sourceRecords,
          snipState
        ),
        estimatedTokens: this.usageLedger.estimateProjectedTokens(
          state,
          this.buildProjectedMessages(
            state,
            snapshot,
            attachmentTokenBudget,
            sourceRecords,
            snipState
          )
        ),
        result,
      }
    }

    const nextRecordsOverride = this.mergeRetainedRecords(
      sourceRecords,
      archivedIndex,
      result.records
    )
    const projectedMessages = this.buildProjectedMessages(
      state,
      snapshot,
      attachmentTokenBudget,
      nextRecordsOverride,
      snipState
    )

    return {
      changed: true,
      recordsOverride: nextRecordsOverride,
      projectedMessages,
      estimatedTokens: this.tokenCounter.countMessages(
        this.toUnifiedMessages(projectedMessages)
      ),
      result,
    }
  }

  private mergeRetainedRecords(
    sourceRecords: readonly ContextTranscriptRecord[],
    archivedIndex: number,
    retainedRecords: readonly ContextTranscriptRecord[]
  ): ContextTranscriptRecord[] {
    if (archivedIndex < 0) {
      return [...retainedRecords]
    }
    return [...sourceRecords.slice(0, archivedIndex + 1), ...retainedRecords]
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
      const fittedRecords = this.toolIntegrity.extractWithIntegrity(
        retainedUnified,
        recordBudget,
        { mode: options?.integrityMode }
      )
      fitted = [...fittedPrefix, ...fittedRecords]

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
    const truncationIndex =
      this.toolIntegrity.findBudgetSafeTruncationPointWithIntegrity(
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
