import { Injectable } from "@nestjs/common"
import {
  ContextCompactionCommit,
  ContextConversationState,
  ContextTranscriptRecord,
  ProjectedContextMessage,
} from "./types"
import {
  ContextAttachmentBuilderService,
  ContextAttachmentSnapshot,
} from "./context-attachment-builder.service"

@Injectable()
export class ContextProjectionService {
  constructor(private readonly attachments: ContextAttachmentBuilderService) {}

  project(
    state: ContextConversationState,
    options?: {
      attachmentSnapshot?: ContextAttachmentSnapshot
      attachmentTokenBudget?: number
      recordsOverride?: readonly ContextTranscriptRecord[]
    }
  ): ProjectedContextMessage[] {
    const liveAttachments = options?.attachmentSnapshot
      ? this.attachments.buildAttachments(options.attachmentSnapshot, {
          maxTokens: options.attachmentTokenBudget,
        })
      : []
    const sourceRecords = options?.recordsOverride || state.records
    const commitChain = this.getCommitChain(state)
    if (commitChain.length === 0) {
      return [
        ...this.buildAttachmentMessages(liveAttachments),
        ...this.buildRecordMessages(sourceRecords),
      ]
    }

    const resolvedChain = this.resolveCommitChain(commitChain, sourceRecords)
    if (!resolvedChain) {
      return [
        ...this.buildAttachmentMessages(liveAttachments),
        ...this.buildRecordMessages(sourceRecords),
      ]
    }

    const retainedRecords = sourceRecords.slice(
      resolvedChain[resolvedChain.length - 1]!.archivedIndex + 1
    )

    const projected: ProjectedContextMessage[] = [
      ...resolvedChain.flatMap(({ commit }) => [
        this.buildBoundaryProjection(commit),
        this.buildSummaryProjection(commit),
      ]),
      ...this.buildAttachmentMessages(
        liveAttachments,
        commitChain[commitChain.length - 1]?.id
      ),
    ]

    projected.push(...this.buildRecordMessages(retainedRecords))

    return projected
  }

  getActiveCommit(
    state: ContextConversationState
  ): ContextCompactionCommit | undefined {
    if (!state.activeCompactionId) return undefined
    return state.compactionHistory.find(
      (commit) => commit.id === state.activeCompactionId
    )
  }

  getCommitChain(state: ContextConversationState): ContextCompactionCommit[] {
    const activeCommit = this.getActiveCommit(state)
    if (!activeCommit) {
      return []
    }

    const commitById = new Map(
      state.compactionHistory.map((commit) => [commit.id, commit])
    )
    const chain: ContextCompactionCommit[] = []
    const seenCommitIds = new Set<string>()
    let current: ContextCompactionCommit | undefined = activeCommit

    while (current) {
      if (seenCommitIds.has(current.id)) {
        return []
      }
      seenCommitIds.add(current.id)
      chain.unshift(current)
      if (!current.parentCompactionId) {
        break
      }
      const parentCommit = commitById.get(current.parentCompactionId)
      if (!parentCommit) {
        return []
      }
      current = parentCommit
    }

    return chain
  }

  private buildBoundaryProjection(
    commit: ContextCompactionCommit
  ): ProjectedContextMessage {
    return {
      role: "user",
      content: this.renderCompactionBoundary(commit),
      source: "boundary",
      commitId: commit.id,
      compactionEvent: {
        type: "boundary",
        commitId: commit.id,
        epoch: commit.epoch,
        parentCompactionId: commit.parentCompactionId,
        archivedThroughRecordId: commit.archivedThroughRecordId,
        sourceTokenCount: commit.sourceTokenCount,
        projectedTokenCount: commit.projectedTokenCount,
      },
    }
  }

  private buildSummaryProjection(
    commit: ContextCompactionCommit
  ): ProjectedContextMessage {
    return {
      role: "user",
      content: this.renderCompactionSummary(commit),
      source: "summary",
      commitId: commit.id,
      compactionEvent: {
        type: "summary",
        commitId: commit.id,
        epoch: commit.epoch,
        parentCompactionId: commit.parentCompactionId,
        archivedThroughRecordId: commit.archivedThroughRecordId,
        summaryTokenCount: commit.summaryTokenCount,
        sourceTokenCount: commit.sourceTokenCount,
        projectedTokenCount: commit.projectedTokenCount,
      },
    }
  }

  renderCompactionBoundary(commit: ContextCompactionCommit): string {
    return (
      `[Context boundary ${commit.id}]\n` +
      `An earlier conversation span was compacted into a structured summary. ` +
      `Continue from the retained messages below without explicitly acknowledging this boundary.`
    )
  }

  renderCompactionSummary(commit: ContextCompactionCommit): string {
    return (
      `[Context summary ${commit.id}]\n` +
      `${commit.summary}\n\n` +
      `Do not answer this summary directly. Use it only as compressed working context.`
    )
  }

  renderProjectedMessage(message: ProjectedContextMessage): string | undefined {
    if (typeof message.content === "string") {
      return message.content
    }
    return undefined
  }

  private buildRecordMessages(
    records: readonly ContextTranscriptRecord[]
  ): ProjectedContextMessage[] {
    return records.map((record) => ({
      role: record.role,
      content: record.content,
      source: "record" as const,
      recordId: record.id,
    }))
  }

  private buildAttachmentMessages(
    attachments: ReturnType<
      ContextAttachmentBuilderService["buildAttachments"]
    >,
    commitId?: string
  ): ProjectedContextMessage[] {
    return attachments.map((attachment) => ({
      role: "user" as const,
      content: attachment.content,
      source: "attachment" as const,
      commitId,
      attachmentKind: attachment.kind,
    }))
  }

  private resolveCommitChain(
    commitChain: readonly ContextCompactionCommit[],
    sourceRecords: readonly ContextTranscriptRecord[]
  ): Array<{ commit: ContextCompactionCommit; archivedIndex: number }> | null {
    const resolved: Array<{
      commit: ContextCompactionCommit
      archivedIndex: number
    }> = []
    let lastArchivedIndex = -1

    for (const commit of commitChain) {
      const archivedIndex = sourceRecords.findIndex(
        (record) => record.id === commit.archivedThroughRecordId
      )
      if (archivedIndex < 0 || archivedIndex <= lastArchivedIndex) {
        return null
      }
      resolved.push({ commit, archivedIndex })
      lastArchivedIndex = archivedIndex
    }

    return resolved
  }
}
