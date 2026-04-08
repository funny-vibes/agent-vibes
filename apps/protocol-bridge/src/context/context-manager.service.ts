import { randomUUID } from "crypto"
import { Injectable } from "@nestjs/common"
import {
  ContextConversationState,
  ContextUsageSnapshot,
  ProjectedContextMessage,
  UnifiedMessage,
} from "./types"
import { ContextAttachmentSnapshot } from "./context-attachment-builder.service"
import {
  ContextCompactionResult,
  ContextCompactionService,
} from "./context-compaction.service"
import { ContextUsageLedgerService } from "./context-usage-ledger.service"
import { TokenCounterService } from "./token-counter.service"

@Injectable()
export class ContextManagerService {
  constructor(
    private readonly compaction: ContextCompactionService,
    private readonly usageLedger: ContextUsageLedgerService,
    private readonly tokenCounter: TokenCounterService
  ) {}

  buildBackendMessages(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      integrityMode?: "strict-adjacent" | "global"
      pendingToolUseIds?: Iterable<string>
      strategy?: "auto" | "manual" | "reactive"
    }
  ): ContextCompactionResult {
    return this.compaction.ensureWithinBudget(state, snapshot, options)
  }

  buildBackendMessagesFromMessages(
    messages: UnifiedMessage[],
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      integrityMode?: "strict-adjacent" | "global"
      pendingToolUseIds?: Iterable<string>
      strategy?: "auto" | "manual" | "reactive"
    }
  ): ContextCompactionResult {
    return this.buildBackendMessages(
      this.createEphemeralState(messages),
      snapshot,
      options
    )
  }

  recordAssistantUsage(
    state: ContextConversationState,
    recordId: string | undefined,
    usage: ContextUsageSnapshot | undefined,
    options?: {
      promptTokenCount?: number
      recordedCompactionId?: string
      attachmentFingerprint?: string
      assistantMessage?: UnifiedMessage
    }
  ): void {
    if (!recordId || !usage) return
    const assistantMessageTokens = options?.assistantMessage
      ? this.tokenCounter.countMessages([options.assistantMessage])
      : 0
    this.usageLedger.recordResponseUsage(
      state,
      recordId,
      {
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        outputTokens: usage.outputTokens,
      },
      {
        projectedTokenCount:
          options?.promptTokenCount != null
            ? options.promptTokenCount + assistantMessageTokens
            : undefined,
        recordedCompactionId: options?.recordedCompactionId,
        attachmentFingerprint: options?.attachmentFingerprint,
      }
    )
  }

  buildProjectionLedger(
    state: ContextConversationState,
    projectedMessages: ProjectedContextMessage[]
  ): {
    projectedTokenCount?: number
    recordedCompactionId?: string
    attachmentFingerprint?: string
  } {
    return this.usageLedger.buildProjectionLedger(state, projectedMessages)
  }

  countMessages(messages: UnifiedMessage[]): number {
    return this.tokenCounter.countMessages(messages)
  }

  private createEphemeralState(
    messages: UnifiedMessage[]
  ): ContextConversationState {
    const baseTimestamp = Date.now()

    return {
      records: messages.map((message, index) => ({
        id: randomUUID(),
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
        createdAt: baseTimestamp + index,
      })),
      compactionHistory: [],
      usageLedger: {},
    }
  }
}
