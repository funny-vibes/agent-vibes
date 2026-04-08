import { Injectable } from "@nestjs/common"
import {
  ContextCompactionCommit,
  ContextConversationState,
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
    }
  ): ProjectedContextMessage[] {
    const liveAttachments = options?.attachmentSnapshot
      ? this.attachments.buildAttachments(options.attachmentSnapshot, {
          maxTokens: options.attachmentTokenBudget,
        })
      : []
    const activeCommit = this.getActiveCommit(state)
    if (!activeCommit) {
      return [
        ...this.buildAttachmentMessages(liveAttachments),
        ...this.buildRecordMessages(state.records),
      ]
    }

    const archivedIndex = state.records.findIndex(
      (record) => record.id === activeCommit.archivedThroughRecordId
    )
    if (archivedIndex < 0) {
      return [
        ...this.buildAttachmentMessages(liveAttachments),
        ...this.buildRecordMessages(state.records),
      ]
    }

    const projected: ProjectedContextMessage[] = [
      {
        role: "user",
        content: this.buildBoundaryMessage(activeCommit),
        source: "boundary",
        commitId: activeCommit.id,
      },
      {
        role: "user",
        content: this.buildSummaryMessage(activeCommit),
        source: "summary",
        commitId: activeCommit.id,
      },
      ...this.buildAttachmentMessages(liveAttachments, activeCommit.id),
    ]

    projected.push(
      ...this.buildRecordMessages(state.records.slice(archivedIndex + 1))
    )

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

  private buildBoundaryMessage(commit: ContextCompactionCommit): string {
    return (
      `[Context boundary ${commit.id}]\n` +
      `Earlier conversation history was compacted into a structured summary. ` +
      `Continue from the retained messages below without explicitly acknowledging this boundary.`
    )
  }

  private buildSummaryMessage(commit: ContextCompactionCommit): string {
    return (
      `[Context summary ${commit.id}]\n` +
      `${commit.summary}\n\n` +
      `Do not answer this summary directly. Use it only as compressed working context.`
    )
  }

  private buildRecordMessages(
    records: ContextConversationState["records"]
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
}
