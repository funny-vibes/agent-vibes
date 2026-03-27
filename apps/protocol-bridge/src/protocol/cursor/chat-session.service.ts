import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common"
import Database from "better-sqlite3"
import * as fs from "fs"
import * as path from "path"
import { ParsedCursorRequest } from "./cursor-request-parser"
import { enforceToolProtocol } from "../../context/message-integrity-guard"

/**
 * Content block types for messages
 */
type MessageContent = string | Array<{ type: string; [key: string]: unknown }>

export type SessionTodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"

export interface SessionTodoItem {
  id: string
  content: string
  status: SessionTodoStatus
  createdAt: number
  updatedAt: number
  dependencies: string[]
}

export interface InterruptedToolCallInfo {
  toolCallId: string
  toolName: string
  sentAt: Date
}

export interface SessionRestartRecovery {
  restoredAt: Date
  notice: string
  interruptedToolCalls: InterruptedToolCallInfo[]
  interruptedInteractionQueryCount: number
  interruptedSubAgent?: {
    subagentId: string
    parentToolCallId: string
    turnCount: number
    toolCallCount: number
  }
}

/**
 * Chat session state for bidirectional streaming
 */
export interface ChatSession {
  conversationId: string
  messages: Array<{ role: "user" | "assistant"; content: MessageContent }>
  model: string
  thinkingLevel: number
  isAgentic: boolean
  supportedTools: string[]
  mcpToolDefs?: ParsedCursorRequest["mcpToolDefs"]
  useWeb: boolean
  createdAt: Date
  lastActivityAt: Date

  // Pending tool calls waiting for results
  pendingToolCalls: Map<string, PendingToolCall>
  // ExecServerMessage.id -> toolCallId mapping for control messages/tool results
  pendingToolCallByExecId: Map<number, string>

  // Context from initial request
  projectContext?: ParsedCursorRequest["projectContext"]
  codeChunks?: ParsedCursorRequest["codeChunks"]
  cursorRules?: ParsedCursorRequest["cursorRules"]
  cursorCommands?: ParsedCursorRequest["cursorCommands"]
  customSystemPrompt?: ParsedCursorRequest["customSystemPrompt"]
  explicitContext?: string
  contextTokenLimit?: number
  usedContextTokens?: number
  requestedMaxOutputTokens?: number
  requestedModelParameters?: Record<string, string>

  // Checkpoint tracking for multi-turn conversations
  usedTokens: number
  readPaths: Set<string>
  fileStates: Map<string, { beforeContent: string; afterContent: string }>

  // Message history with blobIds for checkpoint
  messageBlobIds: string[] // SHA-256 hashes from KV storage
  turns: string[] // Turn identifiers (cumulative)
  currentAssistantMessage?: Record<string, unknown> // Current assistant message being built

  // Protocol counters (session-level, monotonically increasing)
  stepId: number // StepStarted/StepCompleted counter
  execId: number // ExecServerMessage.id counter

  // InteractionQuery pending resolvers
  pendingInteractionQueries: Map<
    number,
    {
      resolve: (response: any) => void
      reject: (error: Error) => void
      queryType: string
      payload?: Record<string, unknown>
    }
  >
  interactionQueryId: number // auto-incrementing counter
  todos: SessionTodoItem[]

  // Sub-agent context (active when a task tool call is running a sub-agent)
  subAgentContext?: SubAgentContext

  // Recovery notice for unrecoverable in-flight state after proxy restart
  restartRecovery?: SessionRestartRecovery
}

export interface PendingToolCall {
  toolCallId: string
  toolName: string
  toolInput: Record<string, unknown>
  toolFamilyHint?: "mcp" | "edit"
  modelCallId: string
  startedEmitted: boolean
  sentAt: Date
  execIds: Set<number>
  editApplyWarning?: string
  beforeContent?: string // File content before edit (for edit tools)
  // Shell stream accumulation (for streaming shell output)
  shellStreamOutput?: {
    stdout: string[]
    stderr: string[]
    exitCode?: number
    signal?: string
    started: boolean
  }
}

/**
 * Sub-agent execution context for the task tool.
 * Stored in the parent ChatSession while a sub-agent is running.
 *
 * Event-driven state machine: the sub-agent loop is NOT a blocking loop.
 * Instead, each phase dispatches exec messages and returns. When the bidi
 * handler receives the tool results, it calls back into the sub-agent to
 * start the next LLM turn.
 */
export interface SubAgentContext {
  /** The task tool call ID in the parent */
  parentToolCallId: string
  /** For Cursor UI correlation */
  parentModelCallId: string
  /** Unique sub-agent identifier */
  subagentId: string
  /** Sub-agent conversation history (Anthropic format) */
  messages: Array<{ role: "user" | "assistant"; content: MessageContent }>
  /** LLM model for the sub-agent */
  model: string
  /** Tool definitions available to the sub-agent */
  tools: unknown[]
  /** Accumulated text from the current sub-agent turn */
  accumulatedText: string
  /** Tool call IDs that belong to this sub-agent (for routing results) */
  pendingToolCallIds: Set<string>
  /** Start time for duration tracking */
  startTime: number
  /** Number of LLM turns completed */
  turnCount: number
  /** Total tool calls made by the sub-agent */
  toolCallCount: number
  /** Modified file paths (for SubagentStopRequestQuery) */
  modifiedFiles: string[]

  // ── Event-driven state machine fields ──

  /** Tool calls from the current LLM turn, pending dispatch & results */
  currentTurnToolCalls: Array<{
    id: string
    name: string
    input: Record<string, unknown>
  }>
  /** Tool results collected so far for the current turn */
  pendingToolResults: Map<string, SubAgentToolResult>
  /** IDs of tools we are still waiting for (subset of currentTurnToolCalls) */
  expectedToolCallIds: Set<string>
}

export interface SubAgentToolResult {
  toolCallId: string
  content: string
  resultData: Buffer
  resultCase: string
}

interface PersistedPendingToolCall {
  toolCallId: string
  toolName: string
  toolInput: Record<string, unknown>
  toolFamilyHint?: "mcp" | "edit"
  modelCallId: string
  startedEmitted: boolean
  sentAt: number
  execIds: number[]
  editApplyWarning?: string
  beforeContent?: string
  shellStreamOutput?: {
    stdout: string[]
    stderr: string[]
    exitCode?: number
    signal?: string
    started: boolean
  }
}

interface PersistedSubAgentContext {
  parentToolCallId: string
  parentModelCallId: string
  subagentId: string
  messages: Array<{ role: "user" | "assistant"; content: MessageContent }>
  model: string
  tools: unknown[]
  accumulatedText: string
  pendingToolCallIds: string[]
  startTime: number
  turnCount: number
  toolCallCount: number
  modifiedFiles: string[]
  currentTurnToolCalls: Array<{
    id: string
    name: string
    input: Record<string, unknown>
  }>
  expectedToolCallIds: string[]
}

interface PersistedSessionRestartRecovery {
  restoredAt: number
  notice: string
  interruptedToolCalls: Array<{
    toolCallId: string
    toolName: string
    sentAt: number
  }>
  interruptedInteractionQueryCount: number
  interruptedSubAgent?: {
    subagentId: string
    parentToolCallId: string
    turnCount: number
    toolCallCount: number
  }
}

interface PersistedChatSessionV1 {
  version: 1
  conversationId: string
  messages: Array<{ role: "user" | "assistant"; content: MessageContent }>
  model: string
  thinkingLevel: number
  isAgentic: boolean
  supportedTools: string[]
  mcpToolDefs?: ParsedCursorRequest["mcpToolDefs"]
  useWeb: boolean
  createdAt: number
  lastActivityAt: number
  pendingToolCalls: PersistedPendingToolCall[]
  pendingInteractionQueryCount: number
  projectContext?: ParsedCursorRequest["projectContext"]
  codeChunks?: ParsedCursorRequest["codeChunks"]
  cursorRules?: ParsedCursorRequest["cursorRules"] | string[]
  cursorCommands?: ParsedCursorRequest["cursorCommands"]
  customSystemPrompt?: ParsedCursorRequest["customSystemPrompt"]
  explicitContext?: string
  contextTokenLimit?: number
  usedContextTokens?: number
  requestedMaxOutputTokens?: number
  requestedModelParameters?: Record<string, string>
  usedTokens: number
  readPaths: string[]
  fileStates: Array<{
    path: string
    beforeContent: string
    afterContent: string
  }>
  messageBlobIds: string[]
  turns: string[]
  currentAssistantMessage?: Record<string, unknown>
  stepId: number
  execId: number
  interactionQueryId: number
  todos: SessionTodoItem[]
  subAgentContext?: PersistedSubAgentContext
  restartRecovery?: PersistedSessionRestartRecovery
}

@Injectable()
export class ChatSessionManager implements OnModuleDestroy {
  private readonly logger = new Logger(ChatSessionManager.name)
  private readonly sessions = new Map<string, ChatSession>()
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000 // 30 minutes
  private readonly PERSISTED_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
  private readonly PERSIST_FLUSH_INTERVAL_MS = 15 * 1000
  private readonly PERSIST_DEBOUNCE_MS = 250
  private readonly dbPath: string
  private db: Database.Database | null = null
  private readonly scheduledPersistTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()
  private readonly cleanupInterval: ReturnType<typeof setInterval>
  private readonly persistFlushInterval: ReturnType<typeof setInterval>

  constructor() {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp"
    const dataDir = path.join(homeDir, ".protocol-bridge")
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
    this.dbPath = path.join(dataDir, "session-state.db")
    this.initDatabase()
    this.cleanupOldPersistedSessions()

    this.cleanupInterval = setInterval(
      () => this.cleanupExpiredSessions(),
      5 * 60 * 1000
    )
    this.persistFlushInterval = setInterval(
      () => this.persistAllSessions(),
      this.PERSIST_FLUSH_INTERVAL_MS
    )
    this.cleanupInterval.unref?.()
    this.persistFlushInterval.unref?.()
  }

  onModuleDestroy(): void {
    this.persistAllSessions()

    for (const timer of this.scheduledPersistTimers.values()) {
      clearTimeout(timer)
    }
    this.scheduledPersistTimers.clear()

    clearInterval(this.cleanupInterval)
    clearInterval(this.persistFlushInterval)

    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  private initDatabase(): void {
    try {
      this.db = new Database(this.dbPath)
      this.db.pragma("journal_mode = WAL")
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS cursor_sessions (
          conversation_id TEXT PRIMARY KEY,
          state_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_activity_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_cursor_sessions_last_activity
          ON cursor_sessions(last_activity_at);
      `)
      this.logger.log(`Session persistence initialized at ${this.dbPath}`)
    } catch (error) {
      this.logger.error(
        `Failed to initialize session persistence: ${String(error)}`
      )
      this.db = null
    }
  }

  private cleanupOldPersistedSessions(): void {
    if (!this.db) return

    const cutoff = Date.now() - this.PERSISTED_SESSION_TTL_MS
    try {
      const result = this.db
        .prepare(
          `DELETE FROM cursor_sessions
           WHERE last_activity_at < ?`
        )
        .run(cutoff)
      if (result.changes > 0) {
        this.logger.log(
          `Cleaned up ${result.changes} expired persisted session(s)`
        )
      }
    } catch (error) {
      this.logger.error(
        `Failed to cleanup persisted sessions: ${String(error)}`
      )
    }
  }

  private schedulePersist(conversationId: string): void {
    const existingTimer = this.scheduledPersistTimers.get(conversationId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const timer = setTimeout(() => {
      this.scheduledPersistTimers.delete(conversationId)
      this.persistSession(conversationId)
    }, this.PERSIST_DEBOUNCE_MS)
    timer.unref?.()
    this.scheduledPersistTimers.set(conversationId, timer)
  }

  private clearScheduledPersist(conversationId: string): void {
    const timer = this.scheduledPersistTimers.get(conversationId)
    if (!timer) return
    clearTimeout(timer)
    this.scheduledPersistTimers.delete(conversationId)
  }

  private persistAllSessions(): void {
    for (const conversationId of this.sessions.keys()) {
      this.persistSession(conversationId)
    }
    this.cleanupOldPersistedSessions()
  }

  persistSession(conversationId: string): void {
    if (!this.db) return

    const session = this.sessions.get(conversationId)
    if (!session) return

    const now = Date.now()
    const state = this.serializeSession(session)

    try {
      this.db
        .prepare(
          `INSERT INTO cursor_sessions (
             conversation_id,
             state_json,
             created_at,
             updated_at,
             last_activity_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET
             state_json = excluded.state_json,
             updated_at = excluded.updated_at,
             last_activity_at = excluded.last_activity_at`
        )
        .run(
          conversationId,
          JSON.stringify(state),
          session.createdAt.getTime(),
          now,
          session.lastActivityAt.getTime()
        )
    } catch (error) {
      this.logger.error(
        `Failed to persist session ${conversationId}: ${String(error)}`
      )
    }
  }

  private loadPersistedSession(
    conversationId: string
  ): ChatSession | undefined {
    if (!this.db) return undefined

    try {
      const row = this.db
        .prepare(
          `SELECT state_json, last_activity_at
           FROM cursor_sessions
           WHERE conversation_id = ?`
        )
        .get(conversationId) as
        | { state_json: string; last_activity_at: number }
        | undefined

      if (!row) return undefined

      if (Date.now() - row.last_activity_at > this.PERSISTED_SESSION_TTL_MS) {
        this.deletePersistedSession(conversationId)
        return undefined
      }

      const persisted = JSON.parse(row.state_json) as PersistedChatSessionV1
      const session = this.deserializeSession(persisted)
      this.sessions.set(conversationId, session)
      this.logger.log(
        `>>> Restored persisted session: ${conversationId} (messages: ${session.messages.length}, turns: ${session.turns.length})`
      )
      this.schedulePersist(conversationId)
      return session
    } catch (error) {
      this.logger.error(
        `Failed to load persisted session ${conversationId}: ${String(error)}`
      )
      return undefined
    }
  }

  private deletePersistedSession(conversationId: string): void {
    if (!this.db) return
    try {
      this.db
        .prepare(`DELETE FROM cursor_sessions WHERE conversation_id = ?`)
        .run(conversationId)
    } catch (error) {
      this.logger.error(
        `Failed to delete persisted session ${conversationId}: ${String(error)}`
      )
    }
  }

  private toTimestamp(
    value: Date | number | undefined,
    fallback: number = Date.now()
  ): number {
    if (value instanceof Date) {
      const ms = value.getTime()
      return Number.isFinite(ms) ? ms : fallback
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value)
    }
    return fallback
  }

  private serializeSession(session: ChatSession): PersistedChatSessionV1 {
    return {
      version: 1,
      conversationId: session.conversationId,
      messages: session.messages,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      isAgentic: session.isAgentic,
      supportedTools: session.supportedTools,
      mcpToolDefs: session.mcpToolDefs,
      useWeb: session.useWeb,
      createdAt: this.toTimestamp(session.createdAt),
      lastActivityAt: this.toTimestamp(session.lastActivityAt),
      pendingToolCalls: Array.from(session.pendingToolCalls.values()).map(
        (toolCall) => ({
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          toolInput: toolCall.toolInput,
          toolFamilyHint: toolCall.toolFamilyHint,
          modelCallId: toolCall.modelCallId,
          startedEmitted: toolCall.startedEmitted,
          sentAt: this.toTimestamp(toolCall.sentAt),
          execIds: Array.from(toolCall.execIds),
          editApplyWarning: toolCall.editApplyWarning,
          beforeContent: toolCall.beforeContent,
          shellStreamOutput: toolCall.shellStreamOutput
            ? {
                stdout: [...toolCall.shellStreamOutput.stdout],
                stderr: [...toolCall.shellStreamOutput.stderr],
                exitCode: toolCall.shellStreamOutput.exitCode,
                signal: toolCall.shellStreamOutput.signal,
                started: toolCall.shellStreamOutput.started,
              }
            : undefined,
        })
      ),
      pendingInteractionQueryCount: session.pendingInteractionQueries.size,
      projectContext: session.projectContext,
      codeChunks: session.codeChunks,
      cursorRules: session.cursorRules,
      cursorCommands: session.cursorCommands,
      customSystemPrompt: session.customSystemPrompt,
      explicitContext: session.explicitContext,
      contextTokenLimit: session.contextTokenLimit,
      usedContextTokens: session.usedContextTokens,
      requestedMaxOutputTokens: session.requestedMaxOutputTokens,
      requestedModelParameters: session.requestedModelParameters,
      usedTokens: session.usedTokens,
      readPaths: Array.from(session.readPaths),
      fileStates: Array.from(session.fileStates.entries()).map(
        ([filePath, state]) => ({
          path: filePath,
          beforeContent: state.beforeContent,
          afterContent: state.afterContent,
        })
      ),
      messageBlobIds: [...session.messageBlobIds],
      turns: [...session.turns],
      currentAssistantMessage: session.currentAssistantMessage,
      stepId: session.stepId,
      execId: session.execId,
      interactionQueryId: session.interactionQueryId,
      todos: [...session.todos],
      subAgentContext: session.subAgentContext
        ? {
            parentToolCallId: session.subAgentContext.parentToolCallId,
            parentModelCallId: session.subAgentContext.parentModelCallId,
            subagentId: session.subAgentContext.subagentId,
            messages: session.subAgentContext.messages,
            model: session.subAgentContext.model,
            tools: session.subAgentContext.tools,
            accumulatedText: session.subAgentContext.accumulatedText,
            pendingToolCallIds: Array.from(
              session.subAgentContext.pendingToolCallIds
            ),
            startTime: session.subAgentContext.startTime,
            turnCount: session.subAgentContext.turnCount,
            toolCallCount: session.subAgentContext.toolCallCount,
            modifiedFiles: [...session.subAgentContext.modifiedFiles],
            currentTurnToolCalls:
              session.subAgentContext.currentTurnToolCalls.map((toolCall) => ({
                id: toolCall.id,
                name: toolCall.name,
                input: toolCall.input,
              })),
            expectedToolCallIds: Array.from(
              session.subAgentContext.expectedToolCallIds
            ),
          }
        : undefined,
      restartRecovery: session.restartRecovery
        ? {
            restoredAt: this.toTimestamp(session.restartRecovery.restoredAt),
            notice: session.restartRecovery.notice,
            interruptedToolCalls:
              session.restartRecovery.interruptedToolCalls.map((toolCall) => ({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                sentAt: this.toTimestamp(toolCall.sentAt),
              })),
            interruptedInteractionQueryCount:
              session.restartRecovery.interruptedInteractionQueryCount,
            interruptedSubAgent: session.restartRecovery.interruptedSubAgent,
          }
        : undefined,
    }
  }

  private buildRestartRecovery(
    persisted: PersistedChatSessionV1
  ): SessionRestartRecovery | undefined {
    if (persisted.restartRecovery) {
      return {
        restoredAt: new Date(
          this.toTimestamp(persisted.restartRecovery.restoredAt)
        ),
        notice: persisted.restartRecovery.notice,
        interruptedToolCalls:
          persisted.restartRecovery.interruptedToolCalls.map((toolCall) => ({
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            sentAt: new Date(this.toTimestamp(toolCall.sentAt)),
          })),
        interruptedInteractionQueryCount:
          persisted.restartRecovery.interruptedInteractionQueryCount,
        interruptedSubAgent: persisted.restartRecovery.interruptedSubAgent,
      }
    }

    const interruptedToolCalls = Array.isArray(persisted.pendingToolCalls)
      ? persisted.pendingToolCalls.map((toolCall) => ({
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          sentAt: new Date(this.toTimestamp(toolCall.sentAt)),
        }))
      : []
    const interruptedInteractionQueryCount =
      typeof persisted.pendingInteractionQueryCount === "number" &&
      persisted.pendingInteractionQueryCount > 0
        ? persisted.pendingInteractionQueryCount
        : 0
    const interruptedSubAgent = persisted.subAgentContext
      ? {
          subagentId: persisted.subAgentContext.subagentId,
          parentToolCallId: persisted.subAgentContext.parentToolCallId,
          turnCount: persisted.subAgentContext.turnCount,
          toolCallCount: persisted.subAgentContext.toolCallCount,
        }
      : undefined

    if (
      interruptedToolCalls.length === 0 &&
      interruptedInteractionQueryCount === 0 &&
      !interruptedSubAgent
    ) {
      return undefined
    }

    const details: string[] = []
    if (interruptedToolCalls.length > 0) {
      const sampleNames = interruptedToolCalls
        .slice(0, 3)
        .map((toolCall) => toolCall.toolName || toolCall.toolCallId)
      let toolSummary = `${interruptedToolCalls.length} pending tool call(s) were aborted`
      if (sampleNames.length > 0) {
        toolSummary += ` (${sampleNames.join(", ")}`
        if (interruptedToolCalls.length > sampleNames.length) {
          toolSummary += `, +${interruptedToolCalls.length - sampleNames.length} more`
        }
        toolSummary += `)`
      }
      details.push(toolSummary)
    }
    if (interruptedInteractionQueryCount > 0) {
      details.push(
        `${interruptedInteractionQueryCount} pending interaction quer${
          interruptedInteractionQueryCount === 1 ? "y was" : "ies were"
        } dropped`
      )
    }
    if (interruptedSubAgent) {
      details.push(
        `sub-agent ${interruptedSubAgent.subagentId} was interrupted`
      )
    }

    return {
      restoredAt: new Date(),
      notice:
        `Proxy restarted before the previous turn finished. ${details.join("; ")}.` +
        ` Please retry the interrupted action if needed.`,
      interruptedToolCalls,
      interruptedInteractionQueryCount,
      interruptedSubAgent,
    }
  }

  private deserializeSession(persisted: PersistedChatSessionV1): ChatSession {
    const now = Date.now()
    const createdAt = new Date(this.toTimestamp(persisted.createdAt, now))
    const lastActivityAt = new Date(
      this.toTimestamp(persisted.lastActivityAt, createdAt.getTime())
    )

    return {
      conversationId: persisted.conversationId,
      messages: Array.isArray(persisted.messages) ? persisted.messages : [],
      // Note: We do NOT run enforceToolProtocol here.
      // Deserialized sessions may have legitimate interrupted tool calls that
      // should be handled by repairInterruptedToolProtocol() with proper
      // restart recovery context, not by generic synthetic tool_result injection.
      model: persisted.model || "claude-sonnet-4.5",
      thinkingLevel:
        typeof persisted.thinkingLevel === "number"
          ? persisted.thinkingLevel
          : 0,
      isAgentic: persisted.isAgentic === true,
      supportedTools: Array.isArray(persisted.supportedTools)
        ? persisted.supportedTools
        : [],
      mcpToolDefs: persisted.mcpToolDefs,
      useWeb: persisted.useWeb === true,
      createdAt,
      lastActivityAt,
      pendingToolCalls: new Map(),
      pendingToolCallByExecId: new Map(),
      projectContext: persisted.projectContext,
      codeChunks: persisted.codeChunks,
      cursorRules: Array.isArray(persisted.cursorRules)
        ? (persisted.cursorRules as ParsedCursorRequest["cursorRules"])
        : undefined,
      cursorCommands: persisted.cursorCommands,
      customSystemPrompt: persisted.customSystemPrompt,
      explicitContext: persisted.explicitContext,
      contextTokenLimit: persisted.contextTokenLimit,
      usedContextTokens: persisted.usedContextTokens,
      requestedMaxOutputTokens: persisted.requestedMaxOutputTokens,
      requestedModelParameters: persisted.requestedModelParameters,
      usedTokens:
        typeof persisted.usedTokens === "number" ? persisted.usedTokens : 0,
      readPaths: new Set(
        Array.isArray(persisted.readPaths) ? persisted.readPaths : []
      ),
      fileStates: new Map(
        Array.isArray(persisted.fileStates)
          ? persisted.fileStates.map((state) => [
              state.path,
              {
                beforeContent: state.beforeContent,
                afterContent: state.afterContent,
              },
            ])
          : []
      ),
      messageBlobIds: Array.isArray(persisted.messageBlobIds)
        ? persisted.messageBlobIds
        : [],
      turns: Array.isArray(persisted.turns) ? persisted.turns : [],
      currentAssistantMessage: persisted.currentAssistantMessage,
      stepId: typeof persisted.stepId === "number" ? persisted.stepId : 0,
      execId: typeof persisted.execId === "number" ? persisted.execId : 1,
      pendingInteractionQueries: new Map(),
      interactionQueryId:
        typeof persisted.interactionQueryId === "number"
          ? persisted.interactionQueryId
          : 0,
      todos: Array.isArray(persisted.todos) ? persisted.todos : [],
      subAgentContext: undefined,
      restartRecovery: this.buildRestartRecovery(persisted),
    }
  }

  private createFreshSession(
    conversationId: string,
    initialRequest?: ParsedCursorRequest
  ): ChatSession {
    return {
      conversationId,
      messages: initialRequest?.conversation || [],
      model: initialRequest?.model || "claude-sonnet-4.5",
      thinkingLevel: initialRequest?.thinkingLevel || 0,
      isAgentic: initialRequest?.isAgentic || false,
      supportedTools: initialRequest?.supportedTools || [],
      mcpToolDefs: initialRequest?.mcpToolDefs,
      useWeb: initialRequest?.useWeb || false,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      pendingToolCalls: new Map(),
      pendingToolCallByExecId: new Map(),
      projectContext: initialRequest?.projectContext,
      codeChunks: initialRequest?.codeChunks,
      cursorRules: initialRequest?.cursorRules,
      cursorCommands: initialRequest?.cursorCommands,
      customSystemPrompt: initialRequest?.customSystemPrompt,
      explicitContext: initialRequest?.explicitContext,
      contextTokenLimit: initialRequest?.contextTokenLimit,
      usedContextTokens: initialRequest?.usedContextTokens,
      requestedMaxOutputTokens: initialRequest?.requestedMaxOutputTokens,
      requestedModelParameters: initialRequest?.requestedModelParameters,
      usedTokens: initialRequest?.usedContextTokens || 0,
      readPaths: new Set(),
      fileStates: new Map(),
      messageBlobIds: [],
      turns: [],
      currentAssistantMessage: undefined,
      stepId: 0,
      execId: 1,
      pendingInteractionQueries: new Map(),
      interactionQueryId: 0,
      todos: [],
      restartRecovery: undefined,
    }
  }

  /**
   * Touch session activity timestamp to keep long-lived tool/interaction turns alive.
   */
  touchSession(conversationId: string): boolean {
    const session = this.getSession(conversationId)
    if (!session) return false
    session.lastActivityAt = new Date()
    return true
  }

  /**
   * Create or get existing session
   */
  getOrCreateSession(
    conversationId: string,
    initialRequest?: ParsedCursorRequest
  ): ChatSession {
    let session = this.getSession(conversationId)

    if (!session) {
      session = this.createFreshSession(conversationId, initialRequest)

      this.sessions.set(conversationId, session)
      this.logger.log(
        `>>> Created new session: ${conversationId} (model: ${session.model})`
      )
    } else {
      session.lastActivityAt = new Date()

      // Refresh protocol fields on every turn so continuation strictly follows Cursor request.
      if (initialRequest?.model) {
        session.model = initialRequest.model
      }
      if (initialRequest?.thinkingLevel !== undefined) {
        session.thinkingLevel = initialRequest.thinkingLevel
      }
      if (initialRequest?.supportedTools) {
        session.supportedTools = initialRequest.supportedTools
      }
      if (initialRequest) {
        session.mcpToolDefs = initialRequest.mcpToolDefs
      }
      if (initialRequest?.useWeb !== undefined) {
        session.useWeb = initialRequest.useWeb
      }
      if (initialRequest?.projectContext) {
        session.projectContext = initialRequest.projectContext
      }
      if (initialRequest?.cursorRules) {
        session.cursorRules = initialRequest.cursorRules
      }
      session.cursorCommands = initialRequest?.cursorCommands
      session.customSystemPrompt = initialRequest?.customSystemPrompt
      if (initialRequest?.explicitContext) {
        session.explicitContext = initialRequest.explicitContext
      }
      if (initialRequest?.contextTokenLimit !== undefined) {
        session.contextTokenLimit = initialRequest.contextTokenLimit
      }
      if (initialRequest?.usedContextTokens !== undefined) {
        session.usedContextTokens = initialRequest.usedContextTokens
        session.usedTokens = initialRequest.usedContextTokens
      }
      if (initialRequest?.requestedMaxOutputTokens !== undefined) {
        session.requestedMaxOutputTokens =
          initialRequest.requestedMaxOutputTokens
      }
      if (initialRequest?.requestedModelParameters) {
        session.requestedModelParameters =
          initialRequest.requestedModelParameters
      }

      this.logger.log(
        `>>> Using existing session: ${conversationId} (blobIds: ${session.messageBlobIds.length}, turns: ${session.turns.length})`
      )
    }

    this.schedulePersist(conversationId)
    return session
  }

  /**
   * Update session with new message
   */
  addMessage(
    conversationId: string,
    role: "user" | "assistant",
    content: MessageContent
  ): void {
    const session = this.getSession(conversationId)
    if (session) {
      session.messages.push({ role, content })
      session.lastActivityAt = new Date()

      // Note: We do NOT run enforceToolProtocol here.
      // addMessage is an incremental operation — assistant writes tool_use first,
      // then user writes tool_result later. The intermediate state (orphan tool_use
      // with no tool_result yet) is a legitimate pending-tool-call window.
      // Guard only runs on batch operations (replaceMessages) and at send time.

      // Estimate token usage (rough estimate: 1 token ≈ 4 characters)
      const contentStr =
        typeof content === "string" ? content : JSON.stringify(content)
      session.usedTokens += Math.ceil(contentStr.length / 4)
      this.schedulePersist(conversationId)
    }
  }

  /**
   * Add blobId to session's message history
   * This is used for building conversationCheckpointUpdate
   */
  addMessageBlobId(conversationId: string, blobId: string): void {
    const session = this.getSession(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      session.messageBlobIds.push(blobId)
      this.logger.log(
        `>>> Added blobId to session ${conversationId}: ${blobId.substring(0, 20)}... (total: ${session.messageBlobIds.length})`
      )
      this.schedulePersist(conversationId)
    } else {
      this.logger.error(
        `>>> FAILED to add blobId - session not found: ${conversationId}`
      )
    }
  }

  /**
   * Add a new turn to the session
   * Turns are cumulative identifiers for each conversation round
   */
  addTurn(conversationId: string, turnId: string): void {
    const session = this.getSession(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      session.turns.push(turnId)
      this.logger.log(
        `>>> Added turn ${session.turns.length} to session ${conversationId}: ${turnId.substring(0, 20)}...`
      )
      this.schedulePersist(conversationId)
    } else {
      this.logger.error(
        `>>> FAILED to add turn - session not found: ${conversationId}`
      )
    }
  }

  /**
   * Set current assistant message being built
   */
  setCurrentAssistantMessage(
    conversationId: string,
    message: Record<string, unknown>
  ): void {
    const session = this.getSession(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      session.currentAssistantMessage = message
      this.schedulePersist(conversationId)
    }
  }

  /**
   * Clear current assistant message
   */
  clearCurrentAssistantMessage(conversationId: string): void {
    const session = this.getSession(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      session.currentAssistantMessage = undefined
      this.schedulePersist(conversationId)
    }
  }

  /**
   * Track file read operation
   */
  addReadPath(conversationId: string, filePath: string): void {
    const session = this.getSession(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      session.readPaths.add(filePath)
      this.schedulePersist(conversationId)
    }
  }

  /**
   * Initialize shell stream output tracking for a tool call
   */
  initShellStream(conversationId: string, toolCallId: string): void {
    const session = this.getSession(conversationId)
    if (!session) return

    const pendingCall = session.pendingToolCalls.get(toolCallId)
    if (pendingCall) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput = {
        stdout: [],
        stderr: [],
        started: false,
      }
      this.logger.debug(`Initialized shell stream for ${toolCallId}`)
    }
  }

  /**
   * Append shell stream stdout
   */
  appendShellStdout(
    conversationId: string,
    toolCallId: string,
    data: string
  ): void {
    const session = this.getSession(conversationId)
    if (!session) return

    const pendingCall = session.pendingToolCalls.get(toolCallId)
    if (pendingCall?.shellStreamOutput) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput.stdout.push(data)
      this.logger.debug(`Appended ${data.length} chars stdout to ${toolCallId}`)
    }
  }

  /**
   * Append shell stream stderr
   */
  appendShellStderr(
    conversationId: string,
    toolCallId: string,
    data: string
  ): void {
    const session = this.getSession(conversationId)
    if (!session) return

    const pendingCall = session.pendingToolCalls.get(toolCallId)
    if (pendingCall?.shellStreamOutput) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput.stderr.push(data)
      this.logger.debug(`Appended ${data.length} chars stderr to ${toolCallId}`)
    }
  }

  /**
   * Mark shell stream as started
   */
  markShellStarted(conversationId: string, toolCallId: string): void {
    const session = this.getSession(conversationId)
    if (!session) return

    const pendingCall = session.pendingToolCalls.get(toolCallId)
    if (pendingCall?.shellStreamOutput) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput.started = true
      this.logger.debug(`Marked shell started for ${toolCallId}`)
    }
  }

  /**
   * Set shell stream exit info
   */
  setShellExit(
    conversationId: string,
    toolCallId: string,
    exitCode: number,
    signal?: string
  ): void {
    const session = this.getSession(conversationId)
    if (!session) return

    const pendingCall = session.pendingToolCalls.get(toolCallId)
    if (pendingCall?.shellStreamOutput) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput.exitCode = exitCode
      pendingCall.shellStreamOutput.signal = signal
      this.logger.debug(
        `Set shell exit for ${toolCallId}: code=${exitCode}, signal=${signal}`
      )
    }
  }

  /**
   * Get accumulated shell output
   */
  getShellOutput(
    conversationId: string,
    toolCallId: string
  ): { stdout: string; stderr: string; exitCode?: number } | null {
    const session = this.getSession(conversationId)
    if (!session) return null

    const pendingCall = session.pendingToolCalls.get(toolCallId)
    if (!pendingCall?.shellStreamOutput) return null

    return {
      stdout: pendingCall.shellStreamOutput.stdout.join(""),
      stderr: pendingCall.shellStreamOutput.stderr.join(""),
      exitCode: pendingCall.shellStreamOutput.exitCode,
    }
  }

  /**
   * Check if shell stream is complete (has exit event)
   */
  isShellStreamComplete(conversationId: string, toolCallId: string): boolean {
    const session = this.getSession(conversationId)
    if (!session) return false

    const pendingCall = session.pendingToolCalls.get(toolCallId)
    return pendingCall?.shellStreamOutput?.exitCode !== undefined
  }

  /**
   * Track file edit operation
   */
  addFileState(
    conversationId: string,
    filePath: string,
    beforeContent: string,
    afterContent: string
  ): void {
    const session = this.getSession(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      session.fileStates.set(filePath, { beforeContent, afterContent })
      this.schedulePersist(conversationId)
    }
  }

  /**
   * Add pending tool call
   */
  async addPendingToolCall(
    conversationId: string,
    toolCallId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolFamilyHint?: "mcp",
    modelCallId: string = ""
  ): Promise<void> {
    const session = this.getSession(conversationId)
    if (session) {
      // For edit tools, capture file content BEFORE the edit
      let beforeContent: string | undefined
      if (toolName === "edit_file_v2" || toolName === "edit") {
        const filePath = (toolInput as { path?: string })?.path
        if (filePath) {
          try {
            const fs = await import("fs/promises")
            beforeContent = await fs.readFile(filePath, "utf-8")
            this.logger.debug(
              `Captured before content for ${filePath}: ${beforeContent.length} bytes`
            )
          } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e)
            this.logger.warn(
              `Failed to read file before edit: ${filePath} - ${errorMessage}`
            )
          }
        }
      }

      session.pendingToolCalls.set(toolCallId, {
        toolCallId,
        toolName,
        toolInput,
        toolFamilyHint,
        modelCallId,
        startedEmitted: false,
        sentAt: new Date(),
        execIds: new Set(),
        beforeContent,
      })
      session.lastActivityAt = new Date()
      this.logger.debug(
        `Added pending tool call: ${toolCallId} (${toolName}) for session ${conversationId}`
      )
      this.schedulePersist(conversationId)
    }
  }

  /**
   * Get and remove pending tool call
   */
  consumePendingToolCall(
    conversationId: string,
    toolCallId: string
  ): PendingToolCall | undefined {
    const session = this.getSession(conversationId)
    if (session) {
      const toolCall = session.pendingToolCalls.get(toolCallId)
      if (toolCall) {
        for (const execId of toolCall.execIds) {
          session.pendingToolCallByExecId.delete(execId)
        }
        for (const [
          execId,
          mappedToolCallId,
        ] of session.pendingToolCallByExecId) {
          if (mappedToolCallId === toolCallId) {
            session.pendingToolCallByExecId.delete(execId)
          }
        }
        session.pendingToolCalls.delete(toolCallId)
        session.lastActivityAt = new Date()
        this.logger.debug(
          `Consumed tool call: ${toolCallId} for session ${conversationId}`
        )
        this.schedulePersist(conversationId)
        return toolCall
      }
    }
    return undefined
  }

  registerPendingToolExecId(
    conversationId: string,
    toolCallId: string,
    execIdNumber: number
  ): boolean {
    const session = this.getSession(conversationId)
    if (!session) return false
    if (!Number.isFinite(execIdNumber) || execIdNumber <= 0) return false

    const pending = session.pendingToolCalls.get(toolCallId)
    if (!pending) {
      this.logger.warn(
        `registerPendingToolExecId: pending tool call not found: ${toolCallId}`
      )
      return false
    }

    const normalizedExecId = Math.floor(execIdNumber)
    session.pendingToolCallByExecId.set(normalizedExecId, toolCallId)
    pending.execIds.add(normalizedExecId)
    session.lastActivityAt = new Date()
    this.logger.debug(
      `Mapped execId=${normalizedExecId} -> toolCallId=${toolCallId} for session ${conversationId}`
    )
    this.schedulePersist(conversationId)
    return true
  }

  markPendingToolCallStarted(conversationId: string, toolCallId: string): void {
    const session = this.getSession(conversationId)
    if (!session) return
    const pending = session.pendingToolCalls.get(toolCallId)
    if (!pending) return
    session.lastActivityAt = new Date()
    pending.startedEmitted = true
    this.schedulePersist(conversationId)
  }

  getPendingToolCallIdByExecId(
    conversationId: string,
    execIdNumber: number
  ): string | undefined {
    const session = this.getSession(conversationId)
    if (!session) return undefined
    if (!Number.isFinite(execIdNumber) || execIdNumber <= 0) return undefined
    return session.pendingToolCallByExecId.get(Math.floor(execIdNumber))
  }

  consumePendingToolCallByExecId(
    conversationId: string,
    execIdNumber: number
  ): PendingToolCall | undefined {
    const toolCallId = this.getPendingToolCallIdByExecId(
      conversationId,
      execIdNumber
    )
    if (!toolCallId) return undefined
    return this.consumePendingToolCall(conversationId, toolCallId)
  }

  /**
   * Register an InteractionQuery, returns {id, promise}
   * The promise resolves when the client replies with an InteractionResponse
   */
  registerInteractionQuery(
    conversationId: string,
    queryType: string,
    payload?: Record<string, unknown>
  ): { id: number; promise: Promise<any> } {
    const session = this.getSession(conversationId)
    if (!session) {
      throw new Error(`Session not found: ${conversationId}`)
    }

    session.interactionQueryId++
    const queryId = session.interactionQueryId

    let resolve!: (response: any) => void
    let reject!: (error: Error) => void
    const promise = new Promise<any>((res, rej) => {
      resolve = res
      reject = rej
    })

    session.pendingInteractionQueries.set(queryId, {
      resolve,
      reject,
      queryType,
      payload,
    })
    session.lastActivityAt = new Date()

    this.logger.log(
      `Registered InteractionQuery id=${queryId} type=${queryType} for ${conversationId}`
    )

    this.schedulePersist(conversationId)
    return { id: queryId, promise }
  }

  /**
   * Parse InteractionResponse and resolve the corresponding pending query
   */
  resolveInteractionQuery(
    conversationId: string,
    queryId: number,
    response: any
  ): { queryType: string; payload?: Record<string, unknown> } | null {
    const session = this.getSession(conversationId)
    if (!session) {
      this.logger.warn(
        `resolveInteractionQuery: session not found ${conversationId}`
      )
      return null
    }

    const pending = session.pendingInteractionQueries.get(queryId)
    if (!pending) {
      this.logger.warn(
        `resolveInteractionQuery: no pending query id=${queryId}`
      )
      return null
    }

    this.logger.log(
      `Resolve InteractionQuery id=${queryId} type=${pending.queryType}`
    )
    pending.resolve(response)
    session.pendingInteractionQueries.delete(queryId)
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
    return {
      queryType: pending.queryType,
      payload: pending.payload,
    }
  }

  /**
   * Get session
   */
  getSession(conversationId: string): ChatSession | undefined {
    return (
      this.sessions.get(conversationId) ||
      this.loadPersistedSession(conversationId)
    )
  }

  /**
   * Delete session
   */
  deleteSession(conversationId: string): void {
    const session = this.sessions.get(conversationId)
    if (session) {
      session.pendingInteractionQueries.clear()
    }
    this.clearScheduledPersist(conversationId)
    this.sessions.delete(conversationId)
    this.deletePersistedSession(conversationId)
    this.logger.log(`Deleted session: ${conversationId}`)
  }

  /**
   * Cleanup expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now()
    let cleanedCount = 0

    for (const [conversationId, session] of this.sessions.entries()) {
      if (now - session.lastActivityAt.getTime() <= this.SESSION_TIMEOUT) {
        continue
      }

      const hasPendingWork =
        session.pendingToolCalls.size > 0 ||
        session.pendingInteractionQueries.size > 0
      if (hasPendingWork) {
        this.logger.debug(
          `Skipping cleanup for session ${conversationId}: pendingToolCalls=${session.pendingToolCalls.size}, pendingInteractionQueries=${session.pendingInteractionQueries.size}`
        )
        continue
      }

      this.clearScheduledPersist(conversationId)
      this.sessions.delete(conversationId)
      cleanedCount++
    }

    if (cleanedCount > 0) {
      this.logger.log(`Cleaned up ${cleanedCount} expired session(s)`)
    }
  }

  /**
   * Get session statistics
   */
  getStats(): {
    totalSessions: number
    activeSessions: number
    oldestSession: Date | null
  } {
    const now = Date.now()
    let activeSessions = 0
    let oldestSession: Date | null = null

    for (const session of this.sessions.values()) {
      if (now - session.lastActivityAt.getTime() < 5 * 60 * 1000) {
        activeSessions++
      }
      if (!oldestSession || session.createdAt < oldestSession) {
        oldestSession = session.createdAt
      }
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions,
      oldestSession,
    }
  }

  // ── Sub-Agent Context helpers ──────────────────────────

  setSubAgentContext(conversationId: string, context: SubAgentContext): void {
    const session = this.getSession(conversationId)
    if (session) {
      session.subAgentContext = context
      session.lastActivityAt = new Date()
      this.logger.log(
        `Set SubAgentContext for ${conversationId}: subagentId=${context.subagentId}, parentToolCallId=${context.parentToolCallId}`
      )
      this.schedulePersist(conversationId)
    }
  }

  getSubAgentContext(conversationId: string): SubAgentContext | undefined {
    return this.getSession(conversationId)?.subAgentContext
  }

  clearSubAgentContext(conversationId: string): void {
    const session = this.getSession(conversationId)
    if (session) {
      session.subAgentContext = undefined
      session.lastActivityAt = new Date()
      this.logger.log(`Cleared SubAgentContext for ${conversationId}`)
      this.schedulePersist(conversationId)
    }
  }

  /**
   * Check if a tool call ID belongs to the active sub-agent.
   */
  isSubAgentToolCall(conversationId: string, toolCallId: string): boolean {
    const ctx = this.getSession(conversationId)?.subAgentContext
    return !!ctx && ctx.pendingToolCallIds.has(toolCallId)
  }

  replaceMessages(
    conversationId: string,
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>
  ): void {
    const session = this.getSession(conversationId)
    if (!session) return

    // Write-time validation: enforce tool protocol integrity before storing
    const guardResult = enforceToolProtocol(
      messages as Array<{ role: "user" | "assistant"; content: unknown }>,
      { mode: "global" }
    )
    if (guardResult.changed) {
      this.logger.warn(
        `Write-time integrity repair (replaceMessages): injected ${guardResult.injectedToolResults} synthetic tool_result, ` +
          `removed ${guardResult.removedToolResults} orphan tool_result, ` +
          `${guardResult.removedEmptyMessages} empty messages`
      )
    }
    session.messages = guardResult.messages as Array<{
      role: "user" | "assistant"
      content: MessageContent
    }>
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
  }

  replaceTodos(conversationId: string, todos: SessionTodoItem[]): void {
    const session = this.getSession(conversationId)
    if (!session) return
    session.todos = todos
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
  }

  nextExecId(conversationId: string): number {
    const session = this.getSession(conversationId)
    if (!session) {
      throw new Error(`Session not found: ${conversationId}`)
    }
    const next = session.execId++
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
    return next
  }

  incrementStepId(conversationId: string): number {
    const session = this.getSession(conversationId)
    if (!session) {
      throw new Error(`Session not found: ${conversationId}`)
    }
    session.stepId++
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
    return session.stepId
  }

  getRestartRecovery(
    conversationId: string
  ): SessionRestartRecovery | undefined {
    return this.getSession(conversationId)?.restartRecovery
  }

  clearRestartRecovery(conversationId: string): void {
    const session = this.getSession(conversationId)
    if (!session) return
    session.restartRecovery = undefined
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
  }
}
