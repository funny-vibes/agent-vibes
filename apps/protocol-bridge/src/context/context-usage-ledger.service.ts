import { Injectable } from "@nestjs/common"
import { createHash } from "crypto"
import {
  ContextConversationState,
  ContextUsageSnapshot,
  ProjectedContextMessage,
  ContextUsageLedgerState,
  UnifiedMessage,
} from "./types"
import { TokenCounterService } from "./token-counter.service"
import { ContextProjectionService } from "./context-projection.service"
import { ContextAttachmentSnapshot } from "./context-attachment-builder.service"

@Injectable()
export class ContextUsageLedgerService {
  constructor(
    private readonly tokenCounter: TokenCounterService,
    private readonly projection: ContextProjectionService
  ) {}

  recordResponseUsage(
    state: ContextConversationState,
    recordId: string,
    usage: Omit<ContextUsageSnapshot, "totalTokens" | "recordedAt">,
    options?: {
      projectedTokenCount?: number
      recordedCompactionId?: string
      attachmentFingerprint?: string
    }
  ): void {
    state.usageLedger = {
      anchorRecordId: recordId,
      lastUsage: {
        ...usage,
        totalTokens:
          usage.inputTokens +
          usage.cachedInputTokens +
          usage.cacheCreationInputTokens +
          usage.outputTokens,
        recordedAt: Date.now(),
      },
      projectedTokenCount: options?.projectedTokenCount,
      recordedCompactionId: options?.recordedCompactionId,
      attachmentFingerprint: options?.attachmentFingerprint,
    }
  }

  buildProjectionLedger(
    state: ContextConversationState,
    projectedMessages: ProjectedContextMessage[]
  ): Pick<
    ContextUsageLedgerState,
    "projectedTokenCount" | "recordedCompactionId" | "attachmentFingerprint"
  > {
    const asUnified = projectedMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })) as UnifiedMessage[]

    return {
      projectedTokenCount: this.tokenCounter.countMessages(asUnified),
      recordedCompactionId: this.projection.getActiveCommit(state)?.id,
      attachmentFingerprint:
        this.buildProjectedAttachmentFingerprint(projectedMessages),
    }
  }

  estimateProjectedTokens(
    state: ContextConversationState,
    projectedMessages?: ProjectedContextMessage[],
    options?: {
      attachmentSnapshot?: ContextAttachmentSnapshot
      attachmentTokenBudget?: number
    }
  ): number {
    const projected =
      projectedMessages ??
      this.projection.project(state, {
        attachmentSnapshot: options?.attachmentSnapshot,
        attachmentTokenBudget: options?.attachmentTokenBudget,
      })
    const asUnified = projected.map((message) => ({
      role: message.role,
      content: message.content,
    })) as UnifiedMessage[]
    const rawEstimate = this.tokenCounter.countMessages(asUnified)
    const anchorId = state.usageLedger.anchorRecordId
    const usage = state.usageLedger.lastUsage
    const projectedTokenCount = state.usageLedger.projectedTokenCount

    if (!anchorId || !usage || projectedTokenCount == null) {
      return rawEstimate
    }

    const currentCompactionId = this.projection.getActiveCommit(state)?.id
    if (state.usageLedger.recordedCompactionId !== currentCompactionId) {
      return rawEstimate
    }

    const currentAttachmentFingerprint =
      this.buildProjectedAttachmentFingerprint(projected)
    if (
      (state.usageLedger.attachmentFingerprint || "") !==
      currentAttachmentFingerprint
    ) {
      return rawEstimate
    }

    const anchorIndex = projected.findIndex(
      (message) => message.recordId === anchorId
    )
    if (anchorIndex < 0) {
      return rawEstimate
    }

    const suffixMessages = projected.slice(anchorIndex + 1).map((message) => ({
      role: message.role,
      content: message.content,
    })) as UnifiedMessage[]

    if (suffixMessages.length === 0) {
      return projectedTokenCount
    }

    return projectedTokenCount + this.tokenCounter.countMessages(suffixMessages)
  }

  private buildProjectedAttachmentFingerprint(
    projectedMessages: ProjectedContextMessage[]
  ): string {
    const attachmentPayload = projectedMessages
      .filter((message) => message.source === "attachment")
      .map(
        (message) =>
          `${message.attachmentKind || "attachment"}:${this.serializeContent(message.content)}`
      )
      .join("\n---\n")

    if (!attachmentPayload) {
      return ""
    }

    return createHash("sha256").update(attachmentPayload).digest("hex")
  }

  private serializeContent(
    content: ProjectedContextMessage["content"]
  ): string {
    if (typeof content === "string") {
      return content
    }

    try {
      return JSON.stringify(content)
    } catch {
      return "[unserializable-content]"
    }
  }
}
