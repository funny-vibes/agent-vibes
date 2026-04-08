import { Injectable } from "@nestjs/common"
import { ContextProjectionAttachment } from "./types"
import { TokenCounterService } from "./token-counter.service"

export interface SessionTodoAttachmentLike {
  content: string
  status: string
}

export interface ContextAttachmentSnapshot {
  readPaths: string[]
  fileStates: Array<{
    path: string
    beforeContent: string
    afterContent: string
  }>
  todos: SessionTodoAttachmentLike[]
  activeSubAgent?: {
    subagentId: string
    model: string
    turnCount: number
    toolCallCount: number
    modifiedFiles: string[]
    pendingToolCallIds: string[]
  }
}

@Injectable()
export class ContextAttachmentBuilderService {
  private readonly TOTAL_ATTACHMENT_BUDGET = 2200
  private readonly MAX_ATTACHMENT_TOKENS = 700

  constructor(private readonly tokenCounter: TokenCounterService) {}

  buildAttachments(
    snapshot: ContextAttachmentSnapshot,
    options?: { maxTokens?: number }
  ): ContextProjectionAttachment[] {
    const budget = Math.max(
      options?.maxTokens || this.TOTAL_ATTACHMENT_BUDGET,
      0
    )
    if (budget <= 0) return []

    const candidates: Array<ContextProjectionAttachment | null> = [
      this.buildSubAgentAttachment(snapshot),
      this.buildTodosAttachment(snapshot),
      this.buildFileStatesAttachment(snapshot),
      this.buildReadPathsAttachment(snapshot),
    ]

    const attachments: ContextProjectionAttachment[] = []
    let consumed = 0

    for (const candidate of candidates) {
      if (!candidate) continue
      if (candidate.tokenCount <= 0) continue
      if (consumed + candidate.tokenCount > budget) continue
      attachments.push(candidate)
      consumed += candidate.tokenCount
    }

    return attachments
  }

  private buildReadPathsAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    if (snapshot.readPaths.length === 0) return null

    const lines = snapshot.readPaths
      .slice(-20)
      .map((path) => `- ${path}`)
      .join("\n")

    return this.buildAttachment("read_paths", "Recently Read Files", lines)
  }

  private buildSubAgentAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    const subAgent = snapshot.activeSubAgent
    if (!subAgent) return null

    const lines = [
      `- Active sub-agent: ${subAgent.subagentId}`,
      `- Model: ${subAgent.model}`,
      `- Completed turns: ${subAgent.turnCount}`,
      `- Tool calls: ${subAgent.toolCallCount}`,
    ]

    if (subAgent.pendingToolCallIds.length > 0) {
      lines.push(
        `- Waiting on tools: ${subAgent.pendingToolCallIds.join(", ")}`
      )
    }
    if (subAgent.modifiedFiles.length > 0) {
      lines.push(
        ...subAgent.modifiedFiles
          .slice(-10)
          .map((filePath) => `- Modified file: ${filePath}`)
      )
    }

    return this.buildAttachment(
      "sub_agent",
      "Active Sub-Agent",
      lines.join("\n")
    )
  }

  private buildFileStatesAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    if (snapshot.fileStates.length === 0) return null

    const lines = snapshot.fileStates
      .slice(-10)
      .map((state) => {
        const beforeLines = state.beforeContent.split("\n").length
        const afterLines = state.afterContent.split("\n").length
        const delta = afterLines - beforeLines
        const changeLabel =
          delta === 0 ? "0 lines" : `${delta > 0 ? "+" : ""}${delta} lines`
        return `- ${state.path} (${changeLabel})`
      })
      .join("\n")

    return this.buildAttachment("file_states", "Tracked File Changes", lines)
  }

  private buildTodosAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    if (snapshot.todos.length === 0) return null

    const lines = snapshot.todos
      .slice(-20)
      .map((todo) => `- [${todo.status}] ${todo.content}`)
      .join("\n")

    return this.buildAttachment("todos", "Todo State", lines)
  }

  private buildAttachment(
    kind: ContextProjectionAttachment["kind"],
    label: string,
    body: string
  ): ContextProjectionAttachment {
    const header = `[Context attachment: ${label}]`
    const content = `${header}\n${this.trimToBudget(body, this.MAX_ATTACHMENT_TOKENS)}`
    return {
      kind,
      label,
      content,
      tokenCount: this.tokenCounter.countText(content),
    }
  }

  private trimToBudget(text: string, maxTokens: number): string {
    const value = text.trim()
    if (!value) return value

    if (this.tokenCounter.countText(value) <= maxTokens) {
      return value
    }

    let end = value.length
    while (end > 64) {
      end = Math.floor(end * 0.8)
      const candidate = `${value.slice(0, end).trim()}\n...[truncated]`
      if (this.tokenCounter.countText(candidate) <= maxTokens) {
        return candidate
      }
    }

    return "...[truncated]"
  }
}
