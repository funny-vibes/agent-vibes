import { fromBinary } from "@bufbuild/protobuf"
import { Injectable, Logger } from "@nestjs/common"
import * as crypto from "crypto"
import {
  ConversationTruncatorService,
  normalizeToolProtocolMessages,
  TokenCounterService,
  ToolIntegrityService,
  UnifiedMessage,
} from "../../context"
import {
  CursorRuleSource,
  ExecClientMessageSchema,
  ShellStream,
  type BackgroundShellSpawnResult,
  type CursorRule,
  type DeleteResult,
  type DiagnosticsResult,
  type GrepResult,
  type LsDirectoryTreeNode,
  type LsResult,
  type ReadResult,
  type ShellResult,
  type WriteResult,
} from "../../gen/agent/v1_pb"
import { CodexService } from "../../llm/codex/codex.service"
import { ClaudeApiService } from "../../llm/claude-api/claude-api.service"
import { OpenaiCompatService } from "../../llm/openai-compat/openai-compat.service"
import { GoogleService } from "../../llm/google/google.service"
import {
  BackendType,
  ModelRouteResult,
  ModelRouterService,
} from "../../llm/model-router.service"
import { backendRequiresCompleteToolBatchBeforeContinuation } from "../../llm/tool-continuation-policy"
import { CreateMessageDto } from "../anthropic/dto/create-message.dto"
import { generateTraceId } from "./agent-helpers"
import { normalizeBugfixResultItems as normalizeBugfixResultItemsFromContract } from "./bugfix-result-normalizer"
import {
  ChatSession,
  ChatSessionManager,
  InterruptedToolCallInfo,
  PendingToolCall,
  SessionRestartRecovery,
  SessionTodoItem,
  SessionTodoStatus,
  SubAgentContext,
} from "./chat-session.service"
import { ClientSideToolV2ExecutorService } from "./client-side-tool-v2-executor.service"
import { CursorGrpcService } from "./cursor-grpc.service"
import {
  type AttachedImage,
  cursorRequestParser,
  ParsedCursorRequest,
  ParsedToolResult,
} from "./cursor-request-parser"
import {
  buildToolsForApi,
  resolveCursorToolDefinitionKey,
} from "./cursor-tool-mapper"
import { KvStorageService } from "./kv-storage.service"
import {
  buildMcpDispatchInput,
  resolveMcpCallFields as resolveMcpCallFieldsFromContract,
  resolveMcpToolDefinition,
} from "./mcp-call-contract"
import { SemanticSearchProviderService } from "./semantic-search-provider.service"

/**
 * SSE Event content block structure (content_block_start)
 */
interface SseContentBlock {
  type: "text" | "tool_use" | "thinking"
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  thinking?: string
  signature?: string
}

/**
 * SSE Event delta structure (content_block_delta)
 */
interface SseDelta {
  type: "text_delta" | "input_json_delta" | "thinking_delta"
  text?: string
  partial_json?: string
  thinking?: string
}

/**
 * SSE Event data structure
 */
interface SseEventData {
  content_block?: SseContentBlock
  delta?: SseDelta
  index?: number
}

/**
 * Parsed SSE Event
 */
interface SseEvent {
  type: string
  data: SseEventData
}

type PromptContext = Pick<
  ParsedCursorRequest,
  | "projectContext"
  | "codeChunks"
  | "cursorRules"
  | "cursorCommands"
  | "customSystemPrompt"
  | "explicitContext"
  | "mcpToolDefs"
>

/**
 * Message content item types - compatible with chat-session.manager.ts MessageContent
 */
interface TextContentItem {
  type: "text"
  text: string
  [key: string]: unknown
}

interface ToolUseContentItem {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
  [key: string]: unknown
}

interface ToolResultContentItem {
  type: "tool_result"
  tool_use_id: string
  content: string
  [key: string]: unknown
}

type MessageContentItem =
  | TextContentItem
  | ToolUseContentItem
  | ToolResultContentItem

/**
 * Message content type - compatible with chat-session.manager.ts
 */
type MessageContent = string | Array<{ type: string; [key: string]: unknown }>

type ToolResultStatus =
  | "success"
  | "failure"
  | "error"
  | "rejected"
  | "timeout"
  | "file_busy"
  | "permission_denied"
  | "spawn_error"
  | "file_not_found"
  | "invalid_file"
  | "aborted"

type AskQuestionProjectionCase = "success" | "async" | "rejected" | "error"

interface AskQuestionProjectionAnswer {
  questionId?: string
  selectedOptionIds?: string[]
  freeformText?: string
}

interface AskQuestionInteractionOption {
  id: string
  label: string
}

interface AskQuestionInteractionQuestion {
  id: string
  prompt: string
  options: AskQuestionInteractionOption[]
  allowMultiple: boolean
}

type InlineWebToolFamily = "web_search" | "web_fetch"

type DeferredToolFamily =
  | InlineWebToolFamily
  | "fetch"
  | "record_screen"
  | "computer_use"
  | "reflect"
  | "start_grind_execution"
  | "start_grind_planning"
  | "ask_question"
  | "create_plan"
  | "switch_mode"
  | "exa_search"
  | "exa_fetch"
  | "setup_vm_environment"
  | "todo_read"
  | "todo_write"
  | "task"
  | "apply_agent_diff"
  | "generate_image"
  | "report_bugfix_results"
  | "file_search"
  | "glob_search"
  | "semantic_search"
  | "deep_search"
  | "read_semsearch_files"
  | "reapply"
  | "fetch_rules"
  | "search_symbols"
  | "background_composer_followup"
  | "knowledge_base"
  | "fetch_pull_request"
  | "create_diagram"
  | "fix_lints"
  | "go_to_definition"
  | "await_task"
  | "read_project"
  | "update_project"

const DEFERRED_INTERACTION_QUERY_FAMILIES: ReadonlySet<DeferredToolFamily> =
  new Set<DeferredToolFamily>([
    "web_search",
    "web_fetch",
    "ask_question",
    "create_plan",
    "switch_mode",
  ])

const UNSUPPORTED_DEFERRED_TOOL_MESSAGES: Partial<
  Record<DeferredToolFamily, string>
> = {
  setup_vm_environment:
    "setup_vm_environment backend is not configured in this proxy runtime",
}

/**
 * Tool input with path property (for edit/read tools)
 */
interface ToolInputWithPath {
  path?: string
  search?: string
  old_text?: string
  replace?: string
  new_text?: string
  file_text?: string
  [key: string]: unknown
}

interface ActiveToolCall {
  id: string
  name: string
  inputJson: string
  modelCallId: string
}

type ToolDispatchOutcome = "waiting_for_result" | "completed_inline"

interface ToolInvocationDispatchParams {
  conversationId: string
  session: ChatSession
  toolCall: ActiveToolCall
  accumulatedText: string
  checkpointModel: string
  workspaceRootPath?: string
}

interface ExecDispatchTarget {
  toolName: string
  input: Record<string, unknown>
  toolFamilyHint?: "mcp"
}

interface ExecDispatchResolution {
  target?: ExecDispatchTarget
  errorMessage?: string
}

interface ToolCompletedExtraData {
  beforeContent?: string
  afterContent?: string
  readSuccess?: {
    path?: string
    content?: string
    data?: Uint8Array
    totalLines?: number
    fileSize?: bigint | number
    truncated?: boolean
  }
  shellResult?: {
    stdout: string
    stderr: string
    exitCode: number
  }
  lsDirectoryTreeRoot?: Record<string, unknown>
  grepSuccess?: {
    pattern?: string
    path?: string
    outputMode?: string
    workspaceResults?: Record<string, unknown>
    activeEditorResult?: Record<string, unknown>
  }
  deleteSuccess?: {
    path?: string
    deletedFile?: string
    fileSize?: bigint | number
    prevContent?: string
  }
  diagnosticsSuccess?: {
    path?: string
    diagnostics?: Array<Record<string, unknown>>
    totalDiagnostics?: number
  }
  listMcpResourcesSuccess?: {
    resources?: Array<Record<string, unknown>>
  }
  readMcpResourceSuccess?: {
    uri?: string
    name?: string
    description?: string
    mimeType?: string
    annotations?: Record<string, string>
    downloadPath?: string
    text?: string
    blob?: Uint8Array
  }
  writeShellStdinSuccess?: {
    shellId?: number
    terminalFileLengthBeforeInputWritten?: number
  }
  toolResultState?: {
    status: ToolResultStatus
    message?: string
  }
  askQuestionResult?: {
    resultCase: AskQuestionProjectionCase
    answers?: AskQuestionProjectionAnswer[]
    reason?: string
    errorMessage?: string
  }
}

/**
 * JSON Schema property definition
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface JsonSchemaProperty {
  type: string
  description?: string
  items?: { type: string }
  [key: string]: unknown
}

// ToolDefinition type imported from cursor-tool-mapper.ts

/**
 * ConnectRPC Bidirectional Streaming Service
 * Handles the full lifecycle of Cursor's bidirectional streaming protocol
 */
@Injectable()
export class CursorConnectStreamService {
  private readonly logger = new Logger(CursorConnectStreamService.name)
  private lastHeartbeatLog = 0
  private readonly HEARTBEAT_LOG_INTERVAL = 60000 // Log heartbeat once per minute
  private readonly KEEPALIVE_INTERVAL = 10000 // 每10秒发送心跳
  // 历史消息截断默认值（当 Cursor 未传预算参数时兜底）
  private readonly DEFAULT_HISTORY_MAX_TOKENS = 166_000
  // Cloud Code 输入 hard cap（从报错与流量观测验证）
  private readonly CLOUD_CODE_CONTEXT_LIMIT_TOKENS = 200_000
  // Safety margin: 0% — using Claude's exact tokenizer (@anthropic-ai/tokenizer),
  // no estimation divergence. Soft limit equals hard limit.
  private readonly CLOUD_CODE_SAFETY_MARGIN_RATIO = 0
  private get CLOUD_CODE_SOFT_CONTEXT_LIMIT_TOKENS(): number {
    return Math.floor(
      this.CLOUD_CODE_CONTEXT_LIMIT_TOKENS *
        (1 - this.CLOUD_CODE_SAFETY_MARGIN_RATIO)
    )
  }
  // Cloud Code 输出 hard cap（从流量与轨迹分析验证）
  private readonly CLOUD_CODE_MAX_OUTPUT_TOKENS = 64_000
  private readonly DEFAULT_NON_CLOUD_OUTPUT_TOKENS = 100_000
  private readonly CLOUD_CODE_EXTRA_OVERHEAD_TOKENS = 1_536
  private readonly GENERIC_EXTRA_OVERHEAD_TOKENS = 768
  private readonly MIN_MAX_OUTPUT_TOKENS = 256
  // Read/grep/list 等工具结果过大时，改为“样本+分批策略提示”
  private readonly LARGE_TOOL_RESULT_TOKEN_THRESHOLD = 24_000
  private readonly LARGE_TOOL_RESULT_HEAD_LINES = 220
  private readonly LARGE_TOOL_RESULT_TAIL_LINES = 120
  private readonly LARGE_TOOL_RESULT_SAMPLE_MAX_CHARS = 24_000
  private modelCallIdCounter = 0

  /**
   * Generate a unique modelCallId for tool calls
   * Format follows official Cursor pattern: {uuid}-{index}-{suffix}
   */
  private generateModelCallId(baseId: string, index: number): string {
    const suffixes = ["nthj", "zgnj", "kxhf", "mqwr", "plzn"]
    const suffix = suffixes[index % suffixes.length]
    return `${baseId}-${index}-${suffix}`
  }

  constructor(
    private readonly sessionManager: ChatSessionManager,
    private readonly grpcService: CursorGrpcService,
    private readonly googleService: GoogleService,
    private readonly codexService: CodexService,
    private readonly claudeApiService: ClaudeApiService,
    private readonly openaiCompatService: OpenaiCompatService,
    private readonly modelRouter: ModelRouterService,
    private readonly kvStorageService: KvStorageService,
    private readonly truncator: ConversationTruncatorService,
    private readonly clientSideToolV2Executor: ClientSideToolV2ExecutorService,
    private readonly semanticSearchProvider: SemanticSearchProviderService,
    private readonly tokenCounter: TokenCounterService,
    private readonly toolIntegrity: ToolIntegrityService
  ) {}

  /**
   * 包装后端 SSE 流，在等待后端响应期间自动发送心跳
   * 防止 Cursor NAL stall detector 因长时间无活动而终止 BiDi stream
   *
   * 原理：使用 Promise.race 竞争后端数据和心跳定时器
   * - 如果后端在 intervalMs 内返回数据，正常传递
   * - 如果超过 intervalMs 未收到数据，先发心跳再继续等待
   */
  private async *streamWithHeartbeat(
    stream: AsyncGenerator<string, void, unknown>,
    intervalMs: number = this.KEEPALIVE_INTERVAL
  ): AsyncGenerator<{ type: "data"; value: string } | { type: "heartbeat" }> {
    const iterator = stream[Symbol.asyncIterator]()
    let done = false

    while (!done) {
      // 启动一次 next() 获取后端数据
      const dataPromise = iterator.next()

      // 循环等待，期间每隔 intervalMs 发送心跳
      let resolved = false
      while (!resolved) {
        const timer = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), intervalMs)
        )

        const race = await Promise.race([
          dataPromise.then((r) => ({ source: "data" as const, result: r })),
          timer.then((t) => ({ source: t })),
        ])

        if (race.source === "data") {
          // 后端返回了数据
          resolved = true
          if (race.result.done) {
            done = true
          } else {
            const value = String(race.result.value ?? "")
            yield { type: "data" as const, value }
          }
        } else {
          // 超时，发送心跳并继续等待同一个 dataPromise
          this.logger.debug(
            "Sending keepalive heartbeat while waiting for backend"
          )
          yield { type: "heartbeat" as const }
        }
      }
    }
  }

  /**
   * Handle exec-level control messages from Cursor client.
   * - `execStreamClose`: informational, does not finalize pending tool calls.
   * - `execThrow`: client-side abort; synthesize aborted tool_result and continue model turn.
   */
  private async *handleExecClientControlMessage(
    conversationId: string,
    parsed: ParsedCursorRequest
  ): AsyncGenerator<Buffer, boolean> {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) {
      this.logger.warn(
        `Exec control message received for unknown conversation: ${conversationId}`
      )
      return false
    }

    const execNumericId = this.normalizePositiveInteger(
      parsed.agentControlExecId
    )
    if (!execNumericId) {
      this.logger.warn(
        `Exec control message missing valid id: type=${parsed.agentControlType}`
      )
      return false
    }

    const mappedToolCallId = this.sessionManager.getPendingToolCallIdByExecId(
      conversationId,
      execNumericId
    )

    if (parsed.agentControlType === "execStreamClose") {
      this.logger.debug(
        `Exec stream close: id=${execNumericId}, mappedToolCallId=${mappedToolCallId || "(none)"}`
      )
      return false
    }

    if (parsed.agentControlType !== "execThrow") {
      return false
    }

    this.logger.warn(
      `Exec throw received: id=${execNumericId}, mappedToolCallId=${mappedToolCallId || "(none)"}, error=${parsed.agentControlError || "(empty)"}`
    )

    const resolvedToolCallId = mappedToolCallId
    if (!resolvedToolCallId) {
      const pendingIds = Array.from(session.pendingToolCalls.keys())
      const reason =
        `execThrow id=${execNumericId} has no mapped pending toolCallId ` +
        `(pending=${pendingIds.length ? pendingIds.join(", ") : "(none)"})`
      yield* this.failPendingToolCallsWithProtocolError(conversationId, reason)
      return session.pendingToolCalls.size === 0
    }

    const pendingToolCall = session.pendingToolCalls.get(resolvedToolCallId)
    if (!pendingToolCall) {
      this.logger.warn(
        `Exec throw mapped tool call not pending anymore: execId=${execNumericId}, toolCallId=${resolvedToolCallId}`
      )
      return false
    }

    const reason = (parsed.agentControlError || "").trim()
    const stack = (parsed.agentControlStackTrace || "").trim()
    const safeReason = reason
      ? reason.slice(0, 800)
      : "execution aborted by client"
    const toolResultContent = stack
      ? `Tool execution aborted by client.\nreason: ${safeReason}\nstack: ${stack.slice(0, 2000)}`
      : `Tool execution aborted by client.\nreason: ${safeReason}`

    // Route execThrow through the normal tool-result pipeline so behavior
    // (tool completion, history append, model continuation, turn lifecycle)
    // stays identical to regular ExecClientMessage results.
    const syntheticParsed: ParsedCursorRequest = {
      conversation: [],
      newMessage: "",
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      unifiedMode: "AGENT",
      isAgentic: true,
      supportedTools: session.supportedTools,
      useWeb: session.useWeb,
      toolResults: [
        {
          toolCallId: pendingToolCall.toolCallId,
          toolType: execNumericId,
          resultCase: "mcp_result",
          resultData: Buffer.alloc(0),
          inlineContent: toolResultContent,
          inlineState: {
            status: "aborted",
            message: safeReason,
          },
        },
      ],
    }
    yield* this.handleToolResult(conversationId, syntheticParsed)

    // Mirror post-tool-result stream ending logic used in the main message loop.
    const sessionAfterTool = this.sessionManager.getSession(conversationId)
    const hasMorePendingToolCalls =
      sessionAfterTool?.pendingToolCalls &&
      sessionAfterTool.pendingToolCalls.size > 0
    if (!hasMorePendingToolCalls) {
      this.logger.log(
        `Exec throw handled via tool-result pipeline, ending stream for conversation ${conversationId}`
      )
      return true
    }

    // CRITICAL FIX: When an execThrow arrives (typically from composer_abort),
    // the client may have aborted the entire turn. Any remaining pending tool
    // calls will never receive results from the client, leaving orphan tool_use
    // blocks in the conversation history. This causes Claude API 400 errors:
    //   "tool_use ids were found without tool_result blocks immediately after"
    // Drain all remaining pending tool calls with synthetic abort results.
    this.logger.warn(
      `Exec throw for ${pendingToolCall.toolCallId} left ${sessionAfterTool.pendingToolCalls.size} orphaned pending tool call(s); aborting them all`
    )
    const remainingIds = Array.from(sessionAfterTool.pendingToolCalls.keys())
    for (const remainingToolCallId of remainingIds) {
      const remainingPending =
        sessionAfterTool.pendingToolCalls.get(remainingToolCallId)
      if (!remainingPending) continue
      const abortSynthetic: ParsedCursorRequest = {
        conversation: [],
        newMessage: "",
        model: session.model,
        thinkingLevel: session.thinkingLevel,
        unifiedMode: "AGENT",
        isAgentic: true,
        supportedTools: session.supportedTools,
        useWeb: session.useWeb,
        toolResults: [
          {
            toolCallId: remainingPending.toolCallId,
            toolType: 0,
            resultCase: "mcp_result",
            resultData: Buffer.alloc(0),
            inlineContent:
              "Tool execution aborted by client.\nreason: sibling tool call was aborted, draining remaining pending calls",
            inlineState: {
              status: "aborted",
              message:
                "sibling tool call was aborted, draining remaining pending calls",
            },
          },
        ],
      }
      yield* this.handleToolResult(conversationId, abortSynthetic)
    }
    this.logger.log(
      `All orphaned pending tool calls drained after exec throw for ${pendingToolCall.toolCallId}`
    )
    return true
  }

  private summarizeBackendError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return message.length > 200 ? `${message.slice(0, 200)}…` : message
  }

  private async *executeBackendStreamWithFallback(
    dto: CreateMessageDto,
    route: ModelRouteResult,
    attemptedBackends: Set<string> = new Set()
  ): AsyncGenerator<string, void, unknown> {
    attemptedBackends.add(route.backend)
    const routedDto = { ...dto, model: route.model }
    // Buffer envelope events (message_start, ping) AND structural events
    // (content_block_start, content_block_stop) so we can discard them on
    // fallback.  Only once a content_block_delta arrives (i.e., actual
    // user-visible content has been streamed) do we flush & lock in.
    let emittedAny = false
    let buffer: string[] = []

    const handleEvent = function* (event: string) {
      if (!emittedAny) {
        if (
          event.includes('"type":"message_start"') ||
          event.includes('"type":"ping"') ||
          event.includes('"type":"content_block_start"') ||
          event.includes('"type":"content_block_stop"')
        ) {
          buffer.push(event)
        } else {
          emittedAny = true
          for (const b of buffer) yield b
          buffer = []
          yield event
        }
      } else {
        yield event
      }
    }

    try {
      if (route.backend === "claude-api") {
        this.logger.log(
          `Routing to Claude API backend for model: ${route.model}`
        )
        for await (const event of this.claudeApiService.sendClaudeMessageStream(
          routedDto
        )) {
          yield* handleEvent(event)
        }
        if (!emittedAny) {
          for (const b of buffer) yield b
        }
        return
      }

      if (route.backend === "openai-compat") {
        this.logger.log(
          `Routing to OpenAI-compat backend for model: ${route.model}`
        )
        for await (const event of this.openaiCompatService.sendClaudeMessageStream(
          routedDto
        )) {
          yield* handleEvent(event)
        }
        if (!emittedAny) {
          for (const b of buffer) yield b
        }
        return
      }

      if (route.backend === "codex") {
        this.logger.log(`Routing to Codex backend for model: ${route.model}`)
        for await (const event of this.codexService.sendClaudeMessageStream(
          routedDto
        )) {
          yield* handleEvent(event)
        }
        if (!emittedAny) {
          for (const b of buffer) yield b
        }
        return
      }

      this.logger.log(`Routing to Google backend for model: ${route.model}`)
      for await (const event of this.googleService.sendClaudeMessageStream(
        routedDto
      )) {
        yield* handleEvent(event)
      }
      if (!emittedAny) {
        for (const b of buffer) yield b
      }
    } catch (error) {
      const fallback = this.modelRouter.getFallbackRoute(
        dto.model,
        route.backend
      )
      const canFallback =
        !emittedAny &&
        !!fallback &&
        !attemptedBackends.has(fallback.backend) &&
        this.modelRouter.shouldFallbackFromBackend(
          error,
          route.backend,
          fallback.backend
        )

      if (canFallback && fallback) {
        this.logger.warn(
          `Backend ${route.backend} failed for ${dto.model}: ${this.summarizeBackendError(
            error
          )}; falling back to ${fallback.backend}`
        )
        yield* this.executeBackendStreamWithFallback(
          dto,
          fallback,
          attemptedBackends
        )
        return
      }

      throw error
    }
  }

  /**
   * Get the appropriate message stream based on model
   * Uses ModelRouterService for centralized routing logic
   */
  private getBackendStream(
    dto: CreateMessageDto
  ): AsyncGenerator<string, void, unknown> {
    const route = this.modelRouter.resolveModel(dto.model)
    return this.executeBackendStreamWithFallback(dto, route)
  }

  private normalizePositiveInteger(value: unknown): number | undefined {
    if (typeof value !== "number") return undefined
    if (!Number.isFinite(value) || value <= 0) return undefined
    return Math.floor(value)
  }

  private estimateJsonTokens(value: unknown): number {
    return this.tokenCounter.countJsonValue(value)
  }

  private getBackendContextLimit(backend: BackendType): number | undefined {
    if (backend === "google" || backend === "google-claude") {
      return this.CLOUD_CODE_CONTEXT_LIMIT_TOKENS
    }
    return undefined
  }

  private resolveCheckpointMaxTokens(session: ChatSession): number {
    let backendLimit: number | undefined
    try {
      const route = this.modelRouter.resolveModel(session.model)
      backendLimit = this.getBackendContextLimit(route.backend)
    } catch (error) {
      this.logger.warn(
        `Failed to resolve backend for checkpoint budget (model=${session.model}): ${String(error)}`
      )
    }
    const protocolLimit = this.normalizePositiveInteger(
      session.contextTokenLimit
    )

    let resolved =
      protocolLimit || backendLimit || this.CLOUD_CODE_CONTEXT_LIMIT_TOKENS
    if (backendLimit && resolved > backendLimit) {
      resolved = backendLimit
    }

    return resolved
  }

  private resolveMaxOutputTokens(
    backend: BackendType,
    parsed?: ParsedCursorRequest,
    session?: ChatSession
  ): number {
    const requested =
      this.normalizePositiveInteger(parsed?.requestedMaxOutputTokens) ||
      this.normalizePositiveInteger(session?.requestedMaxOutputTokens)

    if (backend === "google" || backend === "google-claude") {
      const resolved = Math.min(
        requested || this.CLOUD_CODE_MAX_OUTPUT_TOKENS,
        this.CLOUD_CODE_MAX_OUTPUT_TOKENS
      )
      return Math.max(resolved, this.MIN_MAX_OUTPUT_TOKENS)
    }

    if (requested) {
      return Math.max(requested, this.MIN_MAX_OUTPUT_TOKENS)
    }

    return this.DEFAULT_NON_CLOUD_OUTPUT_TOKENS
  }

  private resolveMessageBudget(
    backend: BackendType,
    options?: {
      parsed?: ParsedCursorRequest
      session?: ChatSession
      contextTokens?: number
      systemPrompt?: string
      toolDefinitions?: unknown
    }
  ): {
    maxTokens: number
    systemPromptTokens: number
    maxOutputTokens: number
  } {
    const protocolContextLimit =
      this.normalizePositiveInteger(options?.parsed?.contextTokenLimit) ||
      this.normalizePositiveInteger(options?.session?.contextTokenLimit)

    let maxTokens = protocolContextLimit || this.DEFAULT_HISTORY_MAX_TOKENS
    const backendContextLimit = this.getBackendContextLimit(backend)
    if (backendContextLimit && maxTokens > backendContextLimit) {
      this.logger.warn(
        `Cursor protocol context limit ${maxTokens} exceeds backend cap ${backendContextLimit}, clamping`
      )
      maxTokens = backendContextLimit
    }
    if (backend === "google" || backend === "google-claude") {
      if (maxTokens > this.CLOUD_CODE_SOFT_CONTEXT_LIMIT_TOKENS) {
        this.logger.warn(
          `Applying Cloud Code safety budget clamp: ${maxTokens} -> ${this.CLOUD_CODE_SOFT_CONTEXT_LIMIT_TOKENS}`
        )
        maxTokens = this.CLOUD_CODE_SOFT_CONTEXT_LIMIT_TOKENS
      }
    }

    const contextTokens = options?.contextTokens || 0
    const protocolSystemPromptTokens = options?.systemPrompt
      ? this.truncator.countTokens([
          {
            role: "user",
            content: options.systemPrompt,
          } as UnifiedMessage,
        ])
      : 0
    const toolDefinitionTokens = this.estimateJsonTokens(
      options?.toolDefinitions
    )
    const backendSystemPromptTokens =
      backend === "google" || backend === "google-claude"
        ? this.googleService.getSystemPromptTokenEstimate()
        : 0
    const fixedOverheadTokens =
      backend === "google" || backend === "google-claude"
        ? this.CLOUD_CODE_EXTRA_OVERHEAD_TOKENS
        : this.GENERIC_EXTRA_OVERHEAD_TOKENS

    const systemPromptTokens =
      contextTokens +
      protocolSystemPromptTokens +
      toolDefinitionTokens +
      backendSystemPromptTokens +
      fixedOverheadTokens

    const maxOutputTokens = this.resolveMaxOutputTokens(
      backend,
      options?.parsed,
      options?.session
    )

    this.logger.debug(
      `Token budget resolved: backend=${backend}, maxTokens=${maxTokens}, ` +
        `systemPromptTokens=${systemPromptTokens} (context=${contextTokens}, protocolSystem=${protocolSystemPromptTokens}, tools=${toolDefinitionTokens}, backendSystem=${backendSystemPromptTokens}), ` +
        `maxOutput=${maxOutputTokens}`
    )

    return { maxTokens, systemPromptTokens, maxOutputTokens }
  }

  private isCloudCodeBackend(backend: BackendType): boolean {
    return backend === "google" || backend === "google-claude"
  }

  private shouldDeferToolBatchContinuation(
    backend: BackendType,
    pendingToolUseIds: string[]
  ): boolean {
    return (
      pendingToolUseIds.length > 0 &&
      backendRequiresCompleteToolBatchBeforeContinuation(backend)
    )
  }

  private extractLatestUserPlainText(
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>
  ): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message || message.role !== "user") continue

      if (typeof message.content === "string") {
        return message.content
      }

      if (Array.isArray(message.content)) {
        const nonTextBlock = message.content.find((b) => b.type !== "text")
        if (nonTextBlock) return null
        return message.content
          .map((b) => (typeof b.text === "string" ? b.text : ""))
          .join("\n")
      }

      return null
    }

    return null
  }

  /**
   * Build user message content: plain text or multimodal (text + images).
   * Returns string if no images, or Anthropic-format content block array.
   */
  private buildUserContentWithImages(
    text: string,
    images?: AttachedImage[]
  ): MessageContent {
    if (!images || images.length === 0) {
      return text
    }

    const blocks: Array<{ type: string; [key: string]: unknown }> = []
    if (text) {
      blocks.push({ type: "text", text })
    }
    blocks.push(
      ...images.map((img) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: img.mimeType,
          data: img.data,
        },
      }))
    )
    return blocks
  }

  private messageContentsEqual(
    left: MessageContent | undefined,
    right: MessageContent
  ): boolean {
    if (typeof left === "string" || typeof right === "string") {
      return left === right
    }

    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false
    }

    return JSON.stringify(left) === JSON.stringify(right)
  }

  private hasStructuredToolContent(
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>
  ): boolean {
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue
      if (message.content.some((b) => b.type !== "text")) {
        return true
      }
    }
    return false
  }

  private isChatTurn(parsed: ParsedCursorRequest): boolean {
    return !!(
      parsed.newMessage ||
      parsed.isResumeAction ||
      parsed.attachedImages?.length
    )
  }

  private messageHasToolUse(
    content: MessageContent | undefined,
    toolCallId: string
  ): boolean {
    if (!content || !Array.isArray(content)) return false
    return content.some((block) => {
      if (!block || typeof block !== "object") return false
      return (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        block.id === toolCallId
      )
    })
  }

  private appendToolResultWithIntegrity(
    session: ChatSession,
    toolCallId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResultContent: string
  ): void {
    const lastMessage = session.messages[session.messages.length - 1]
    if (
      !lastMessage ||
      lastMessage.role !== "assistant" ||
      !this.messageHasToolUse(lastMessage.content, toolCallId)
    ) {
      this.logger.warn(
        `Tool protocol repair: injecting synthetic assistant tool_use before tool_result (${toolCallId})`
      )
      const syntheticToolUse: MessageContentItem[] = [
        {
          type: "tool_use",
          id: toolCallId,
          name: toolName || "unknown_tool",
          input: toolInput || {},
        },
      ]
      this.sessionManager.addMessage(
        session.conversationId,
        "assistant",
        syntheticToolUse
      )
    }

    this.sessionManager.addMessage(session.conversationId, "user", [
      {
        type: "tool_result" as const,
        tool_use_id: toolCallId,
        content: toolResultContent,
      },
    ])
  }

  private extractToolUseBlocks(
    content: MessageContent | undefined
  ): ToolUseContentItem[] {
    if (!Array.isArray(content)) return []

    const toolUses: ToolUseContentItem[] = []
    for (const block of content) {
      if (!block || typeof block !== "object") continue
      if (block.type !== "tool_use") continue
      if (typeof block.id !== "string" || !block.id) continue
      toolUses.push({
        type: "tool_use",
        id: block.id,
        name: typeof block.name === "string" ? block.name : "unknown_tool",
        input:
          block.input &&
          typeof block.input === "object" &&
          !Array.isArray(block.input)
            ? (block.input as Record<string, unknown>)
            : {},
      })
    }
    return toolUses
  }

  private extractToolResultIds(
    content: MessageContent | undefined
  ): Set<string> {
    const ids = new Set<string>()
    if (!Array.isArray(content)) return ids

    for (const block of content) {
      if (!block || typeof block !== "object") continue
      if (block.type !== "tool_result") continue
      if (typeof block.tool_use_id !== "string" || !block.tool_use_id) continue
      ids.add(block.tool_use_id)
    }

    return ids
  }

  private buildInterruptedToolResultContent(
    toolCall: InterruptedToolCallInfo
  ): string {
    return (
      `Tool execution aborted because the proxy restarted before the result was received.` +
      `\nreason: proxy restarted` +
      `\ntool: ${toolCall.toolName || toolCall.toolCallId}`
    )
  }

  private repairInterruptedToolProtocol(
    session: ChatSession,
    recovery: SessionRestartRecovery
  ): void {
    if (recovery.interruptedToolCalls.length === 0) {
      return
    }

    const interruptedById = new Map(
      recovery.interruptedToolCalls.map((toolCall) => [
        toolCall.toolCallId,
        toolCall,
      ])
    )
    const repairedMessages = [...session.messages]
    let changed = false

    for (let i = 0; i < repairedMessages.length; i++) {
      const message = repairedMessages[i]
      if (!message || message.role !== "assistant") continue

      const interruptedToolUses = this.extractToolUseBlocks(
        message.content
      ).filter((toolUse) => interruptedById.has(toolUse.id))
      if (interruptedToolUses.length === 0) continue

      const syntheticResults: ToolResultContentItem[] = interruptedToolUses.map(
        (toolUse) => ({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: this.buildInterruptedToolResultContent(
            interruptedById.get(toolUse.id)!
          ),
        })
      )

      const nextMessage = repairedMessages[i + 1]
      if (nextMessage?.role === "user" && Array.isArray(nextMessage.content)) {
        const existingToolResultIds = this.extractToolResultIds(
          nextMessage.content
        )
        const missingResults = syntheticResults.filter(
          (toolResult) => !existingToolResultIds.has(toolResult.tool_use_id)
        )
        if (missingResults.length === 0) continue
        repairedMessages[i + 1] = {
          ...nextMessage,
          content: [...nextMessage.content, ...missingResults],
        }
        changed = true
        continue
      }

      repairedMessages.splice(i + 1, 0, {
        role: "user",
        content: syntheticResults,
      })
      changed = true
      i++
    }

    if (!changed) return

    const normalizedMessages = this.normalizeHistoryForBackend(
      repairedMessages,
      `restart recovery: ${session.conversationId}`
    )
    this.sessionManager.replaceMessages(
      session.conversationId,
      normalizedMessages
    )
  }

  private normalizeHistoryForBackend(
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>,
    contextLabel: string,
    options?: { pendingToolUseIds?: string[] }
  ): Array<{ role: "user" | "assistant"; content: MessageContent }> {
    const normalized = normalizeToolProtocolMessages(
      messages as Array<{ role: "user" | "assistant"; content: unknown }>,
      { pendingToolUseIds: options?.pendingToolUseIds }
    )
    if (
      normalized.removedToolResults > 0 ||
      normalized.injectedToolResults > 0
    ) {
      this.logger.warn(
        `Protocol normalization (${contextLabel}) removed ${normalized.removedToolResults} invalid tool_result block(s), ` +
          `injected ${normalized.injectedToolResults} synthetic tool_result block(s)`
      )
    }
    return normalized.messages as Array<{
      role: "user" | "assistant"
      content: MessageContent
    }>
  }

  private truncateMessagesForBackend(
    conversationId: string,
    backend: BackendType,
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>,
    budget: { maxTokens: number; systemPromptTokens: number },
    options?: {
      preferSummary?: boolean
      contextLabel?: string
      pendingToolUseIds?: string[]
    }
  ): Array<{ role: "user" | "assistant"; content: MessageContent }> {
    // All backends now go through protocol-layer truncation.
    // GoogleService.enforceTokenBudget() remains as a safety net for edge cases.

    const preferSummary = options?.preferSummary ?? false
    const contextLabel = options?.contextLabel || conversationId

    const primary = preferSummary
      ? this.truncator.truncate(conversationId, messages as UnifiedMessage[], {
          systemPromptTokens: budget.systemPromptTokens,
          maxTokens: budget.maxTokens,
          pendingToolUseIds: options?.pendingToolUseIds,
        })
      : this.truncator.truncateInMemory(messages as UnifiedMessage[], {
          systemPromptTokens: budget.systemPromptTokens,
          maxTokens: budget.maxTokens,
          pendingToolUseIds: options?.pendingToolUseIds,
        })

    const truncatedMessages = primary.messages as Array<{
      role: "user" | "assistant"
      content: MessageContent
    }>

    if (primary.was_truncated) {
      this.logger.log(
        `Applied truncation (${contextLabel}): ${primary.original_token_count} -> ${primary.truncated_token_count} tokens`
      )

      // Post-truncation integrity repair: fix any orphaned tool blocks
      // Use 'global' mode because truncation may leave tool_use/tool_result
      // pairs separated across non-adjacent messages.
      const postTruncNormalized = normalizeToolProtocolMessages(
        truncatedMessages as Array<{
          role: "user" | "assistant"
          content: unknown
        }>,
        {
          mode: "global",
          pendingToolUseIds: options?.pendingToolUseIds,
        }
      )
      if (postTruncNormalized.changed) {
        this.logger.warn(
          `Post-truncation integrity repair (${contextLabel}): ` +
            `injected ${postTruncNormalized.injectedToolResults} synthetic tool_result, ` +
            `removed ${postTruncNormalized.removedToolResults} orphan tool_result`
        )
        return postTruncNormalized.messages as Array<{
          role: "user" | "assistant"
          content: MessageContent
        }>
      }
    }

    return truncatedMessages
  }

  private buildUserInputTooLargeMessage(estimatedTokens: number): string {
    return (
      `输入内容过长，已超过 Google Cloud Code 的上下文限制（估算 ${estimatedTokens} tokens，最大 200000）。` +
      `请缩小范围或分段发送；如果是代码分析，请先指定文件路径和关键区间，我会分步读取并分析。`
    )
  }

  /**
   * Build backend error text for Cursor users.
   * Preserve the raw backend error so users can paste it into issue reports.
   */
  private buildBackendErrorMessage(
    backendLabel: string,
    backendModel: string,
    errorMessage: string
  ): string {
    const raw = errorMessage.trim().slice(0, 4000)

    return (
      `⚠️ Backend request failed

` +
      `backend=${backendLabel}
` +
      `model=${backendModel}

` +
      `Raw error:
` +
      `\`\`\`text
${raw}
\`\`\``
    )
  }

  private buildConversationCheckpoint(
    session: ChatSession,
    conversationId: string,
    model: string
  ): Buffer {
    return this.grpcService.createConversationCheckpointResponse(
      conversationId,
      model,
      {
        messageBlobIds: session.messageBlobIds,
        usedTokens: session.usedTokens || 0,
        maxTokens: this.resolveCheckpointMaxTokens(session),
        workspaceUri: session.projectContext?.rootPath
          ? `file://${session.projectContext.rootPath}`
          : undefined,
        readPaths: Array.from(session.readPaths),
        fileStates: Object.fromEntries(session.fileStates),
        turns: session.turns,
        todos: session.todos,
      }
    )
  }

  private *finalizeAssistantContinuationTurn(
    session: ChatSession,
    conversationId: string,
    text?: string
  ): Generator<Buffer> {
    if (text) {
      this.sessionManager.addMessage(session.conversationId, "assistant", text)
    }

    const turnId = this.generateTurnId(
      session.conversationId,
      session.turns.length
    )
    this.sessionManager.addTurn(session.conversationId, turnId)

    yield this.buildConversationCheckpoint(
      session,
      conversationId,
      session.model
    )
    yield this.grpcService.createServerHeartbeatResponse()
    yield this.grpcService.createAgentTurnEndedResponse()
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async *emitAgentFinalTextResponse(
    session: ChatSession,
    text: string
  ): AsyncGenerator<Buffer> {
    yield this.grpcService.createAgentTextResponse(text)
    this.sessionManager.addMessage(session.conversationId, "assistant", text)

    const turnId = this.generateTurnId(
      session.conversationId,
      session.turns.length
    )
    this.sessionManager.addTurn(session.conversationId, turnId)

    const checkpoint = this.grpcService.createConversationCheckpointResponse(
      session.conversationId,
      session.model,
      {
        messageBlobIds: session.messageBlobIds,
        usedTokens: session.usedTokens || 0,
        maxTokens: this.resolveCheckpointMaxTokens(session),
        workspaceUri: session.projectContext?.rootPath
          ? `file://${session.projectContext.rootPath}`
          : undefined,
        readPaths: Array.from(session.readPaths),
        fileStates: Object.fromEntries(session.fileStates),
        turns: session.turns,
        todos: session.todos,
      }
    )
    yield checkpoint
    yield this.grpcService.createServerHeartbeatResponse()
    yield this.grpcService.createAgentTurnEndedResponse()
  }

  private isChunkableReadTool(toolName: string): boolean {
    const normalized = toolName.toLowerCase()
    return (
      normalized === "read_file" ||
      normalized === "read_file_v2" ||
      normalized.includes("read_file") ||
      normalized.includes("list_directory") ||
      normalized.includes("list_dir") ||
      normalized.includes("grep")
    )
  }

  private isShellLikeTool(toolName: string): boolean {
    const normalized = toolName.toLowerCase()
    return (
      normalized.includes("run_terminal_command") ||
      normalized.includes("terminal") ||
      normalized.includes("shell") ||
      normalized.includes("run_command")
    )
  }

  private isMutatingFileTool(toolName: string): boolean {
    const normalized = toolName.toLowerCase()
    return (
      normalized.includes("write") ||
      normalized.includes("edit") ||
      normalized.includes("delete")
    )
  }

  private isEditToolInvocation(toolName: string): boolean {
    const normalized = toolName.trim().toLowerCase()
    if (!normalized) return false
    if (normalized === "edit" || normalized === "edit_file") return true

    const definitionKey = resolveCursorToolDefinitionKey(toolName)
    if (!definitionKey) return false

    return (
      definitionKey === "CLIENT_SIDE_TOOL_V2_EDIT_FILE" ||
      definitionKey === "CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2"
    )
  }

  private trimSampleByChars(text: string): string {
    if (text.length <= this.LARGE_TOOL_RESULT_SAMPLE_MAX_CHARS) return text
    return (
      text.slice(0, this.LARGE_TOOL_RESULT_SAMPLE_MAX_CHARS) +
      "\n... [sample truncated]"
    )
  }

  private adaptToolResultForContext(
    toolName: string,
    toolInput: Record<string, unknown>,
    content: string
  ): string {
    const estimatedTokens = Math.ceil(content.length / 4)
    if (estimatedTokens <= this.LARGE_TOOL_RESULT_TOKEN_THRESHOLD) {
      return content
    }

    const target =
      typeof toolInput.path === "string" && toolInput.path.length > 0
        ? toolInput.path
        : typeof toolInput.command === "string" && toolInput.command.length > 0
          ? `command: ${toolInput.command.slice(0, 180)}`
          : "(unknown path)"
    const lines = content.split(/\r?\n/)
    const totalLines = lines.length

    const headSample = this.trimSampleByChars(
      lines.slice(0, this.LARGE_TOOL_RESULT_HEAD_LINES).join("\n")
    )
    const tailSample = this.trimSampleByChars(
      lines.slice(-this.LARGE_TOOL_RESULT_TAIL_LINES).join("\n")
    )
    const omittedLines = Math.max(
      totalLines -
        this.LARGE_TOOL_RESULT_HEAD_LINES -
        this.LARGE_TOOL_RESULT_TAIL_LINES,
      0
    )

    this.logger.warn(
      `Large tool result adapted for context: tool=${toolName}, target=${target}, ` +
        `size=${content.length} chars (~${estimatedTokens} tokens), lines=${totalLines}`
    )

    let strategy: string[]
    if (this.isChunkableReadTool(toolName)) {
      strategy = [
        `The full output is too large for a single Cloud Code request. Use chunked analysis instead.`,
        `Recommended strategy:`,
        `1. Use grep_search to locate relevant symbols/errors first.`,
        `2. Use read_file with start_line/end_line windows (<= 400 lines each).`,
        `3. Iterate chunk-by-chunk and keep intermediate notes before final synthesis.`,
      ]
    } else if (this.isShellLikeTool(toolName)) {
      strategy = [
        `Terminal output is very large and cannot be kept in full context safely.`,
        `Recommended strategy:`,
        `1. Re-run the command with narrower scope (target one directory/file).`,
        `2. Pipe output to grep/head/tail to keep only relevant lines.`,
        `3. Persist full logs to a file and read in chunks when needed.`,
      ]
    } else if (this.isMutatingFileTool(toolName)) {
      strategy = [
        `Mutation tool output is too large (usually full-file snapshot after write/edit).`,
        `Recommended strategy:`,
        `1. Use read_file on the changed file in focused line ranges.`,
        `2. Prefer diff/grep verification instead of embedding full file content.`,
        `3. Keep only key snippets in context for follow-up reasoning.`,
      ]
    } else {
      strategy = [
        `Tool output is too large to keep in full context.`,
        `Recommended strategy:`,
        `1. Narrow tool scope and request focused subsets.`,
        `2. Keep a concise intermediate summary before final synthesis.`,
      ]
    }

    return [
      `[Tool output adapted for context limit]`,
      `Tool: ${toolName}`,
      `Target: ${target}`,
      `Original size: ${content.length} chars (~${estimatedTokens} tokens), ${totalLines} lines.`,
      ...strategy,
      ``,
      `--- HEAD SAMPLE ---`,
      headSample,
      `--- END HEAD SAMPLE ---`,
      ``,
      `--- TAIL SAMPLE ---`,
      tailSample,
      `--- END TAIL SAMPLE ---`,
      ``,
      `[Omitted middle lines: ${omittedLines}]`,
    ].join("\n")
  }

  private countSubstringOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0
    let count = 0
    let cursor = 0
    while (true) {
      const idx = haystack.indexOf(needle, cursor)
      if (idx < 0) return count
      count += 1
      cursor = idx + needle.length
    }
  }

  /**
   * Build full file text for edit/edit_file/edit_file_v2 tools.
   * Protocol requirement: writeArgs.fileText must be the complete file content,
   * not just the replacement snippet.
   */
  private applyEditInputToFileText(
    beforeContent: string,
    toolInput: ToolInputWithPath
  ): { fileText: string; warning?: string } {
    const explicitFullFileText =
      typeof toolInput.file_text === "string" ? toolInput.file_text : undefined
    if (explicitFullFileText !== undefined) {
      return { fileText: explicitFullFileText }
    }

    const searchText =
      typeof toolInput.search === "string"
        ? toolInput.search
        : typeof toolInput.old_text === "string"
          ? toolInput.old_text
          : undefined
    const replaceText =
      typeof toolInput.replace === "string"
        ? toolInput.replace
        : typeof toolInput.new_text === "string"
          ? toolInput.new_text
          : undefined

    if (searchText === undefined || replaceText === undefined) {
      return {
        fileText: beforeContent,
        warning:
          "edit_file input missing search/replace pair; skipped destructive overwrite",
      }
    }

    if (searchText.length === 0) {
      // When beforeContent is empty (new file creation) and search is empty,
      // this is a valid "create new file" pattern: the LLM passes old_text=""
      // + new_text="content" to write the entire file. Allow it through.
      if (beforeContent.length === 0 && replaceText.length > 0) {
        return { fileText: replaceText }
      }
      return {
        fileText: beforeContent,
        warning:
          "edit_file search text is empty; skipped destructive overwrite",
      }
    }

    const occurrenceCount = this.countSubstringOccurrences(
      beforeContent,
      searchText
    )
    if (occurrenceCount === 0) {
      return {
        fileText: beforeContent,
        warning: "edit_file search text not found; no changes applied",
      }
    }
    if (occurrenceCount > 1) {
      return {
        fileText: beforeContent,
        warning: `edit_file search text matched ${occurrenceCount} times; expected unique match`,
      }
    }

    return {
      fileText: beforeContent.replace(searchText, replaceText),
    }
  }

  private normalizeInlineWebToolFamily(
    toolName: string
  ): InlineWebToolFamily | undefined {
    const snake = toolName
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
    const compact = toolName.toLowerCase().replace(/[^a-z0-9]+/g, "")

    if (snake.includes("web_search") || compact.includes("websearch")) {
      return "web_search"
    }
    if (snake.includes("web_fetch") || compact.includes("webfetch")) {
      return "web_fetch"
    }
    return undefined
  }

  private normalizeDeferredToolFamily(
    toolName: string
  ): DeferredToolFamily | undefined {
    const webFamily = this.normalizeInlineWebToolFamily(toolName)
    if (webFamily) return webFamily

    const definitionKey = resolveCursorToolDefinitionKey(toolName)
    if (definitionKey) {
      switch (definitionKey) {
        case "CLIENT_SIDE_TOOL_V2_WEB_SEARCH":
          return "web_search"
        case "CLIENT_SIDE_TOOL_V2_WEB_FETCH":
          return "web_fetch"
        case "CLIENT_SIDE_TOOL_V2_FETCH":
          return "fetch"
        case "CLIENT_SIDE_TOOL_V2_RECORD_SCREEN":
          return "record_screen"
        case "CLIENT_SIDE_TOOL_V2_COMPUTER_USE":
          return "computer_use"
        case "CLIENT_SIDE_TOOL_V2_REFLECT":
          return "reflect"
        case "CLIENT_SIDE_TOOL_V2_START_GRIND_EXECUTION":
          return "start_grind_execution"
        case "CLIENT_SIDE_TOOL_V2_START_GRIND_PLANNING":
          return "start_grind_planning"
        case "CLIENT_SIDE_TOOL_V2_ASK_QUESTION":
        case "CLIENT_SIDE_TOOL_V2_ASK_FOLLOWUP_QUESTION":
          return "ask_question"
        case "CLIENT_SIDE_TOOL_V2_CREATE_PLAN":
          return "create_plan"
        case "CLIENT_SIDE_TOOL_V2_SWITCH_MODE":
          return "switch_mode"
        case "CLIENT_SIDE_TOOL_V2_EXA_SEARCH":
          return "exa_search"
        case "CLIENT_SIDE_TOOL_V2_EXA_FETCH":
          return "exa_fetch"
        case "CLIENT_SIDE_TOOL_V2_SETUP_VM_ENVIRONMENT":
          return "setup_vm_environment"
        case "CLIENT_SIDE_TOOL_V2_TODO_READ":
          return "todo_read"
        case "CLIENT_SIDE_TOOL_V2_TODO_WRITE":
          return "todo_write"
        case "CLIENT_SIDE_TOOL_V2_TASK":
        case "CLIENT_SIDE_TOOL_V2_TASK_V2":
        case "CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP":
        case "CLIENT_SIDE_TOOL_V2_AWAIT_TASK":
        case "CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT":
          return "task"
        case "CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF":
        case "CLIENT_SIDE_TOOL_V2_REAPPLY":
          return "apply_agent_diff"
        case "CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE":
        case "CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM":
          return "generate_image"
        case "CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS":
          return "report_bugfix_results"
        case "CLIENT_SIDE_TOOL_V2_FILE_SEARCH":
          return "file_search"
        case "CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH":
          return "glob_search"
        case "CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL":
          return "semantic_search"
        case "CLIENT_SIDE_TOOL_V2_DEEP_SEARCH":
          return "deep_search"
        case "CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES":
          return "read_semsearch_files"
        case "CLIENT_SIDE_TOOL_V2_FETCH_RULES":
          return "fetch_rules"
        case "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS":
          return "search_symbols"
        case "CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE":
          return "knowledge_base"
        case "CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST":
          return "fetch_pull_request"
        case "CLIENT_SIDE_TOOL_V2_FIX_LINTS":
          return "fix_lints"
        case "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION":
          return "go_to_definition"
        case "CLIENT_SIDE_TOOL_V2_READ_PROJECT":
          return "read_project"
      }
    }

    const snake = toolName
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
    const compact = toolName.toLowerCase().replace(/[^a-z0-9]+/g, "")

    if (snake.includes("ask_question") || compact.includes("askquestion")) {
      return "ask_question"
    }
    if (snake.includes("create_plan") || compact.includes("createplan")) {
      return "create_plan"
    }
    if (snake.includes("switch_mode") || compact.includes("switchmode")) {
      return "switch_mode"
    }
    if (snake.includes("exa_search") || compact.includes("exasearch")) {
      return "exa_search"
    }
    if (snake.includes("exa_fetch") || compact.includes("exafetch")) {
      return "exa_fetch"
    }
    if (
      snake === "fetch" ||
      snake === "fetch_tool_call" ||
      compact === "fetch" ||
      compact === "fetchtoolcall" ||
      compact === "clientsidetoolv2fetch"
    ) {
      return "fetch"
    }
    if (snake.includes("record_screen") || compact.includes("recordscreen")) {
      return "record_screen"
    }
    if (snake.includes("computer_use") || compact.includes("computeruse")) {
      return "computer_use"
    }
    if (snake.includes("deep_search") || compact.includes("deepsearch")) {
      return "deep_search"
    }
    if (
      snake.includes("semantic_search") ||
      snake.includes("sem_search") ||
      compact.includes("semanticsearch") ||
      compact.includes("semsearch")
    ) {
      return "semantic_search"
    }
    if (
      snake.includes("glob_file_search") ||
      snake.includes("glob_search") ||
      snake.includes("glob_tool_call") ||
      compact.includes("globfilesearch") ||
      compact.includes("globsearch") ||
      compact.includes("globtoolcall")
    ) {
      return "glob_search"
    }
    if (
      snake.includes("file_search") ||
      compact.includes("filesearch") ||
      compact.includes("searchfiles")
    ) {
      return "file_search"
    }
    if (
      snake.includes("todo_read") ||
      snake.includes("read_todos") ||
      compact.includes("todoread") ||
      compact.includes("readtodos")
    ) {
      return "todo_read"
    }
    if (
      snake.includes("todo_write") ||
      snake.includes("update_todos") ||
      compact.includes("todowrite") ||
      compact.includes("updatetodos")
    ) {
      return "todo_write"
    }
    if (
      snake === "task" ||
      snake.includes("task_v2") ||
      snake.includes("task_tool_call") ||
      compact === "task" ||
      compact.includes("subagent") ||
      compact.includes("tasktoolcall")
    ) {
      return "task"
    }
    if (
      snake.includes("setup_vm_environment") ||
      compact.includes("setupvmenvironment")
    ) {
      return "setup_vm_environment"
    }
    if (
      snake.includes("apply_agent_diff") ||
      compact.includes("applyagentdiff")
    ) {
      return "apply_agent_diff"
    }
    if (snake.includes("generate_image") || compact.includes("generateimage")) {
      return "generate_image"
    }
    if (
      snake.includes("report_bugfix_results") ||
      compact.includes("reportbugfixresults")
    ) {
      return "report_bugfix_results"
    }
    if (
      snake.includes("read_semsearch_files") ||
      compact.includes("readsemsearchfiles")
    ) {
      return "read_semsearch_files"
    }
    if (snake.includes("reapply") || compact.includes("reapply")) {
      return "reapply"
    }
    if (snake.includes("fetch_rules") || compact.includes("fetchrules")) {
      return "fetch_rules"
    }
    if (snake.includes("search_symbols") || compact.includes("searchsymbols")) {
      return "search_symbols"
    }
    if (
      snake.includes("background_composer_followup") ||
      compact.includes("backgroundcomposerfollowup")
    ) {
      return "background_composer_followup"
    }
    if (snake.includes("knowledge_base") || compact.includes("knowledgebase")) {
      return "knowledge_base"
    }
    if (
      snake.includes("fetch_pull_request") ||
      compact.includes("fetchpullrequest")
    ) {
      return "fetch_pull_request"
    }
    if (snake.includes("create_diagram") || compact.includes("creatediagram")) {
      return "create_diagram"
    }
    if (snake.includes("fix_lints") || compact.includes("fixlints")) {
      return "fix_lints"
    }
    if (
      snake.includes("go_to_definition") ||
      compact.includes("gotodefinition")
    ) {
      return "go_to_definition"
    }
    if (
      snake.includes("start_grind_execution") ||
      compact.includes("startgrindexecution")
    ) {
      return "start_grind_execution"
    }
    if (
      snake.includes("start_grind_planning") ||
      compact.includes("startgrindplanning")
    ) {
      return "start_grind_planning"
    }
    if (snake.includes("reflect") || compact.includes("reflect")) {
      return "reflect"
    }
    if (snake.includes("await_task") || compact.includes("awaittask")) {
      return "await_task"
    }
    if (snake.includes("read_project") || compact.includes("readproject")) {
      return "read_project"
    }
    if (snake.includes("update_project") || compact.includes("updateproject")) {
      return "update_project"
    }
    return undefined
  }

  private resolveExecDispatchTarget(
    session: ChatSession,
    toolName: string,
    input: Record<string, unknown>
  ): ExecDispatchResolution {
    const mcpToolDef = resolveMcpToolDefinition(session.mcpToolDefs, toolName)
    if (mcpToolDef) {
      try {
        return {
          target: {
            toolName: "CLIENT_SIDE_TOOL_V2_MCP",
            input: buildMcpDispatchInput(input, mcpToolDef),
            toolFamilyHint: "mcp",
          },
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return {
          errorMessage: `Invalid MCP dispatch payload for "${toolName}": ${reason}`,
        }
      }
    }

    const normalizedToolName = toolName.trim().toLowerCase()
    if (
      normalizedToolName === "mcp" ||
      normalizedToolName === "mcp_tool" ||
      normalizedToolName === "client_side_tool_v2_mcp" ||
      normalizedToolName === "client_side_tool_v2_call_mcp_tool"
    ) {
      try {
        const resolved = resolveMcpCallFieldsFromContract(input)
        return {
          target: {
            toolName: "CLIENT_SIDE_TOOL_V2_MCP",
            input: {
              ...input,
              name: resolved.name,
              toolName: resolved.toolName,
              providerIdentifier: resolved.providerIdentifier,
              arguments: resolved.rawArgs,
            },
            toolFamilyHint: "mcp",
          },
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const fallbackMcpDef = this.selectFallbackMcpToolDefinition(
          session.mcpToolDefs,
          input
        )
        if (fallbackMcpDef) {
          try {
            return {
              target: {
                toolName: "CLIENT_SIDE_TOOL_V2_MCP",
                input: buildMcpDispatchInput(input, fallbackMcpDef),
                toolFamilyHint: "mcp",
              },
            }
          } catch (fallbackError) {
            const fallbackReason =
              fallbackError instanceof Error
                ? fallbackError.message
                : String(fallbackError)
            return {
              errorMessage:
                `Invalid MCP dispatch payload for "${toolName}": ${reason}; ` +
                `fallback MCP tool definition failed: ${fallbackReason}`,
            }
          }
        }

        const availableMcpTools =
          session.mcpToolDefs && session.mcpToolDefs.length > 0
            ? session.mcpToolDefs.map((def) => def.name).join(", ")
            : "(none)"
        return {
          errorMessage:
            `Invalid MCP dispatch payload for "${toolName}": ${reason}; ` +
            `declare and call an entry from mcpToolDefs instead (available: ${availableMcpTools})`,
        }
      }
    }

    const inlineOnlyToolCase =
      this.grpcService.getProtocolInlineOnlyToolCase(toolName)
    if (inlineOnlyToolCase) {
      return {
        errorMessage:
          `Tool "${toolName}" maps to ${inlineOnlyToolCase} and must stay inline; ` +
          "exec hop is forbidden by agent.v1 protocol mapping",
      }
    }

    if (this.grpcService.isExecDispatchableTool(toolName)) {
      return {
        target: {
          toolName,
          input,
        },
      }
    }

    return {}
  }

  private selectFallbackMcpToolDefinition(
    mcpToolDefs: ChatSession["mcpToolDefs"],
    input: Record<string, unknown>
  ) {
    if (!mcpToolDefs || mcpToolDefs.length === 0) return undefined

    const normalize = (value: unknown): string =>
      typeof value === "string"
        ? value
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "")
            .trim()
        : ""

    const requestedName = normalize(input.name)
    const requestedToolName = normalize(input.toolName || input.tool_name)
    const requestedProvider = normalize(
      input.providerIdentifier || input.provider_identifier || input.serverName
    )

    if (requestedName) {
      const exactByName = mcpToolDefs.find(
        (def) => normalize(def?.name) === requestedName
      )
      if (exactByName) return exactByName
    }

    if (requestedToolName) {
      const exactByToolName = mcpToolDefs.find(
        (def) => normalize(def?.toolName) === requestedToolName
      )
      if (exactByToolName) return exactByToolName
    }

    if (requestedProvider) {
      const byProvider = mcpToolDefs.filter(
        (def) => normalize(def?.providerIdentifier) === requestedProvider
      )
      if (byProvider.length > 0) return byProvider[0]
    }

    return mcpToolDefs[0]
  }

  private normalizeTodoStatus(value: unknown): SessionTodoStatus {
    if (typeof value === "number") {
      switch (Math.floor(value)) {
        case 2:
          return "in_progress"
        case 3:
          return "completed"
        case 4:
          return "cancelled"
        default:
          return "pending"
      }
    }

    const normalized =
      typeof value === "string"
        ? value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
        : ""
    if (normalized === "in_progress" || normalized === "inprogress") {
      return "in_progress"
    }
    if (normalized === "todo_status_in_progress") {
      return "in_progress"
    }
    if (normalized === "completed" || normalized === "done") {
      return "completed"
    }
    if (normalized === "todo_status_completed") {
      return "completed"
    }
    if (normalized === "cancelled" || normalized === "canceled") {
      return "cancelled"
    }
    if (
      normalized === "todo_status_cancelled" ||
      normalized === "todo_status_canceled"
    ) {
      return "cancelled"
    }
    return "pending"
  }

  private todoStatusToProtocolEnum(status: SessionTodoStatus): number {
    switch (status) {
      case "in_progress":
        return 2
      case "completed":
        return 3
      case "cancelled":
        return 4
      default:
        return 1
    }
  }

  private serializeTodoItemForTool(
    todo: SessionTodoItem
  ): Record<string, unknown> {
    return {
      id: todo.id,
      content: todo.content,
      status: this.todoStatusToProtocolEnum(todo.status),
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt,
      dependencies: todo.dependencies,
    }
  }

  /**
   * Convert session todos into the format expected by CreatePlanRequestQuery.args.todos.
   */
  private sessionTodosToCreatePlanTodos(
    conversationId: string
  ): Array<Record<string, unknown>> {
    const session = this.sessionManager.getSession(conversationId)
    if (!session || session.todos.length === 0) return []
    return session.todos.map((todo) => this.serializeTodoItemForTool(todo))
  }

  /**
   * Parse phases from LLM tool input for CreatePlanRequestQuery.
   */
  private parsePhasesFromInput(
    input: Record<string, unknown>
  ): Array<{ name: string; todos: Array<Record<string, unknown>> }> {
    const rawPhases = input.phases
    if (!Array.isArray(rawPhases)) return []
    return rawPhases
      .filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === "object"
      )
      .map((phase) => ({
        name:
          typeof phase.name === "string"
            ? phase.name.trim()
            : typeof phase.title === "string"
              ? phase.title.trim()
              : "",
        todos: Array.isArray(phase.todos)
          ? phase.todos
              .filter(
                (t): t is Record<string, unknown> =>
                  !!t && typeof t === "object"
              )
              .map((t) => ({
                id: typeof t.id === "string" ? t.id : "",
                content:
                  typeof t.content === "string"
                    ? t.content
                    : typeof t.text === "string"
                      ? t.text
                      : "",
                status: t.status ?? 1,
                dependencies: Array.isArray(t.dependencies)
                  ? t.dependencies.filter(
                      (d): d is string => typeof d === "string"
                    )
                  : [],
              }))
          : [],
      }))
  }

  private parseTodoItemsForSession(
    input: Record<string, unknown>
  ): SessionTodoItem[] {
    const candidateRaw =
      input.todos || input.items || input.updated_todos || input.updatedTodos
    const candidates = Array.isArray(candidateRaw) ? candidateRaw : []
    const nowTs = Date.now()
    const parsed: SessionTodoItem[] = []

    for (const [index, entry] of candidates.entries()) {
      if (!entry || typeof entry !== "object") continue
      const item = entry as Record<string, unknown>
      const idRaw =
        this.pickFirstString(item, ["id", "todo_id", "todoId"]) || ""
      const contentRaw =
        this.pickFirstString(item, ["content", "text", "title"]) || ""
      const dependencies = this.pickStringArray(item, [
        "dependencies",
        "depends_on",
        "dependsOn",
      ])
      const createdAtRaw =
        this.pickFirstNumber(item, ["createdAt", "created_at"]) ?? nowTs
      const updatedAtRaw =
        this.pickFirstNumber(item, ["updatedAt", "updated_at"]) ?? nowTs

      parsed.push({
        id: idRaw || `todo_${nowTs}_${index}`,
        content: contentRaw,
        status: this.normalizeTodoStatus(item.status),
        createdAt: Math.floor(createdAtRaw),
        updatedAt: Math.floor(updatedAtRaw),
        dependencies,
      })
    }

    return parsed
  }

  private collectTodoItemValidationIssues(
    input: Record<string, unknown>,
    merge: boolean,
    existingTodosById: Map<string, SessionTodoItem>
  ): { missingIdIndexes: number[]; missingContentIndexes: number[] } {
    const candidateRaw =
      input.todos || input.items || input.updated_todos || input.updatedTodos
    const candidates = Array.isArray(candidateRaw) ? candidateRaw : []
    const missingIdIndexes: number[] = []
    const missingContentIndexes: number[] = []

    for (const [index, entry] of candidates.entries()) {
      if (!entry || typeof entry !== "object") continue
      const item = entry as Record<string, unknown>
      const idRaw =
        this.pickFirstString(item, ["id", "todo_id", "todoId"])?.trim() || ""
      const contentRaw =
        this.pickFirstString(item, ["content", "text", "title"])?.trim() || ""

      if (!idRaw) {
        missingIdIndexes.push(index)
      }

      const existingContent = idRaw
        ? existingTodosById.get(idRaw)?.content?.trim() || ""
        : ""
      const canReuseExistingContent = merge && existingContent.length > 0
      if (!contentRaw && !canReuseExistingContent) {
        missingContentIndexes.push(index)
      }
    }

    return {
      missingIdIndexes,
      missingContentIndexes,
    }
  }

  private parseTodoStatusFilter(
    input: Record<string, unknown>
  ): SessionTodoStatus[] {
    const statusFilterRaw = input.status_filter || input.statusFilter
    if (!Array.isArray(statusFilterRaw)) return []
    return statusFilterRaw.map((status) => this.normalizeTodoStatus(status))
  }

  private pickStringArray(
    source: Record<string, unknown>,
    keys: string[]
  ): string[] {
    for (const key of keys) {
      const raw = source[key]
      if (Array.isArray(raw)) {
        const values = raw
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter((item) => item.length > 0)
        if (values.length > 0) {
          return values
        }
      }
      if (typeof raw === "string" && raw.trim() !== "") {
        return [raw.trim()]
      }
    }
    return []
  }

  private normalizeToolToken(toolName: string): string {
    return toolName.toLowerCase().replace(/[^a-z0-9_]+/g, "_")
  }

  private pickFirstString(
    source: Record<string, unknown>,
    keys: string[]
  ): string | undefined {
    for (const key of keys) {
      const raw = source[key]
      if (typeof raw === "string" && raw.trim() !== "") {
        return raw.trim()
      }
    }
    return undefined
  }

  private pickFirstNumber(
    source: Record<string, unknown>,
    keys: string[]
  ): number | undefined {
    for (const key of keys) {
      const raw = source[key]
      if (typeof raw === "number" && Number.isFinite(raw)) {
        return Math.floor(raw)
      }
      if (typeof raw === "string" && raw.trim() !== "") {
        const parsed = Number.parseInt(raw, 10)
        if (Number.isFinite(parsed)) {
          return Math.floor(parsed)
        }
      }
    }
    return undefined
  }

  private pickFirstBoolean(
    source: Record<string, unknown>,
    keys: string[]
  ): boolean | undefined {
    for (const key of keys) {
      const raw = source[key]
      if (typeof raw === "boolean") return raw
      if (typeof raw === "string") {
        const normalized = raw.trim().toLowerCase()
        if (normalized === "true") return true
        if (normalized === "false") return false
      }
    }
    return undefined
  }

  private normalizeAskQuestionOptionId(
    value: string,
    fallback: string
  ): string {
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
    return normalized || fallback
  }

  private normalizeAskQuestionOptions(
    rawOptions: unknown,
    questionIndex: number
  ): AskQuestionInteractionOption[] {
    if (!Array.isArray(rawOptions)) return []

    const options: AskQuestionInteractionOption[] = []
    const seenOptionIds = new Set<string>()

    for (const [optionIndex, entry] of rawOptions.entries()) {
      let id = ""
      let label = ""

      if (typeof entry === "string") {
        label = entry.trim()
      } else if (entry && typeof entry === "object") {
        const candidate = entry as Record<string, unknown>
        id =
          this.pickFirstString(candidate, ["id", "optionId", "option_id"]) || ""
        label =
          this.pickFirstString(candidate, [
            "label",
            "text",
            "title",
            "name",
            "value",
          ]) || ""
      }

      if (!id && !label) continue
      if (!id) {
        id = this.normalizeAskQuestionOptionId(
          label,
          `opt_${questionIndex}_${optionIndex + 1}`
        )
      }
      if (!label) {
        label = id
      }
      if (seenOptionIds.has(id)) continue

      seenOptionIds.add(id)
      options.push({ id, label })
    }

    return options
  }

  private normalizeAskQuestionInteractionArgs(
    input: Record<string, unknown>,
    toolCallId: string
  ): {
    title: string
    questions: AskQuestionInteractionQuestion[]
    runAsync: boolean
    asyncOriginalToolCallId: string
  } {
    const explicitTitle =
      this.pickFirstString(input, ["title", "question", "prompt"]) || ""
    const runAsync =
      this.pickFirstBoolean(input, ["run_async", "runAsync"]) || false
    const explicitAsyncOriginalToolCallId =
      this.pickFirstString(input, [
        "asyncOriginalToolCallId",
        "async_original_tool_call_id",
      ]) || ""
    const questionCandidates = Array.isArray(input.questions)
      ? input.questions
      : []

    const questions: AskQuestionInteractionQuestion[] = []
    for (const [index, questionEntry] of questionCandidates.entries()) {
      if (!questionEntry || typeof questionEntry !== "object") continue
      const question = questionEntry as Record<string, unknown>
      const prompt =
        this.pickFirstString(question, [
          "prompt",
          "question",
          "title",
          "label",
        ]) ||
        explicitTitle ||
        `Question ${index + 1}`
      const id =
        this.pickFirstString(question, ["id", "questionId", "question_id"]) ||
        `q${index + 1}`
      const options = this.normalizeAskQuestionOptions(
        Array.isArray(question.options)
          ? question.options
          : Array.isArray(question.choices)
            ? question.choices
            : [],
        index + 1
      )
      const allowMultiple =
        this.pickFirstBoolean(question, ["allowMultiple", "allow_multiple"]) ||
        false

      questions.push({
        id,
        prompt,
        options,
        allowMultiple,
      })
    }

    if (questions.length === 0) {
      questions.push({
        id: "q1",
        prompt: explicitTitle || "Follow-up",
        options: this.normalizeAskQuestionOptions(
          Array.isArray(input.options)
            ? input.options
            : Array.isArray(input.choices)
              ? input.choices
              : [],
          1
        ),
        allowMultiple:
          this.pickFirstBoolean(input, ["allowMultiple", "allow_multiple"]) ||
          false,
      })
    }

    return {
      title: explicitTitle || questions[0]?.prompt || "Follow-up",
      questions,
      runAsync,
      asyncOriginalToolCallId: runAsync
        ? explicitAsyncOriginalToolCallId || toolCallId
        : explicitAsyncOriginalToolCallId,
    }
  }

  private extractLatestUserMessageText(conversationId: string): string {
    const session = this.sessionManager.getSession(conversationId)
    if (!session || session.messages.length === 0) return ""

    for (let i = session.messages.length - 1; i >= 0; i--) {
      const message = session.messages[i]
      if (!message) continue
      if (message.role !== "user") continue
      if (typeof message.content === "string") {
        return message.content.trim()
      }
    }
    return ""
  }

  private hasTemporalIntent(text: string): boolean {
    if (!text) return false
    return /(?:\blatest\b|\brecent\b|\bcurrent\b|\btoday\b|\bnow\b|\bnewest\b|\bup[- ]to[- ]date\b|\bthis (?:week|month|year)\b|\bas of\b|最新|最近|近期|当前|现在|今天|本周|本月|今年|截至|近况)/i.test(
      text
    )
  }

  private hasExplicitTemporalConstraint(text: string): boolean {
    if (!text) return false
    return /(?:\b(?:19|20)\d{2}\b|\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/(?:19|20)\d{2}\b|(?:19|20)\d{2}年|\d{1,2}月\d{1,2}日)/.test(
      text
    )
  }

  /**
   * Normalize model-generated web search query using user temporal intent:
   * - If user did NOT ask time-sensitive info, avoid accidental stale-year anchors (e.g. 2025).
   * - If user DID ask time-sensitive info and query lacks date/year, append current year.
   * - If user explicitly provided a date/year, preserve model query unchanged.
   */
  private normalizeWebSearchQueryForUserIntent(
    conversationId: string,
    rawQuery: string
  ): string {
    const baseQuery = rawQuery.trim()
    if (!baseQuery) return ""

    const userText = this.extractLatestUserMessageText(conversationId)
    const userHasTemporalIntent = this.hasTemporalIntent(userText)
    const userHasExplicitTime = this.hasExplicitTemporalConstraint(userText)

    if (userHasExplicitTime) {
      return baseQuery
    }

    const currentYear = new Date().getFullYear()

    if (!userHasTemporalIntent) {
      // Remove only near-current standalone year anchors; keep historical years intact.
      const staleYears = [currentYear - 1, currentYear - 2, currentYear - 3]
      let normalized = baseQuery
      for (const year of staleYears) {
        const yearToken = String(year)
        normalized = normalized
          .replace(new RegExp(`\\b${yearToken}\\b`, "g"), " ")
          .replace(new RegExp(`${yearToken}年`, "g"), " ")
      }
      normalized = normalized.replace(/\s+/g, " ").trim()
      if (normalized) {
        return normalized
      }
      return baseQuery
    }

    if (this.hasExplicitTemporalConstraint(baseQuery)) {
      return baseQuery
    }

    return `${baseQuery} ${currentYear}`.trim()
  }

  private htmlToPlainText(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  }

  private extractHtmlTitle(html: string): string {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    if (!match?.[1]) return ""
    return match[1].replace(/\s+/g, " ").trim()
  }

  private async fetchUrlDocument(url: string): Promise<{
    url: string
    contentType: string
    title: string
    content: string
  }> {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "protocol-bridge-web-fetch/1.0",
      },
      signal: AbortSignal.timeout(20_000),
    })

    const contentType = response.headers.get("content-type") || ""
    const body = await response.text()

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 280)}`)
    }

    let title = ""
    let text = body
    if (contentType.toLowerCase().includes("html")) {
      title = this.extractHtmlTitle(body)
      text = this.htmlToPlainText(body)
    }

    return {
      url,
      contentType,
      title,
      content: text.trim(),
    }
  }

  private async executeInlineWebTool(
    conversationId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    const family = this.normalizeInlineWebToolFamily(toolName)
    if (!family) {
      return {
        content: `[inline tool error] unsupported web tool: ${toolName}`,
        state: {
          status: "error",
          message: `unsupported web tool: ${toolName}`,
        },
      }
    }

    if (family === "web_search") {
      const query =
        this.pickFirstString(input, ["query", "search_term", "searchTerm"]) ||
        ""
      const normalizedQuery = this.normalizeWebSearchQueryForUserIntent(
        conversationId,
        query
      )
      const domain = this.pickFirstString(input, ["domain"]) || ""
      if (!normalizedQuery) {
        return {
          content: "[web_search error] Missing required query parameter",
          state: {
            status: "error",
            message: "missing query",
          },
        }
      }

      try {
        const effectiveQuery = domain
          ? `${normalizedQuery} site:${domain}`
          : normalizedQuery
        const result = await this.googleService.executeWebSearch(effectiveQuery)
        const maxChars = 18_000
        const summary =
          result.length > maxChars
            ? `${result.slice(0, maxChars)}\n\n...[truncated]`
            : result
        const domainLine = domain ? `\nDomain preference: ${domain}` : ""
        const queryLine =
          normalizedQuery === query
            ? `Search query: ${query}`
            : `Search query: ${query}\nNormalized query: ${normalizedQuery}`
        return {
          content: `${queryLine}${domainLine}\n\n${summary}`,
          state: { status: "success" },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: `[web_search error] ${message}`,
          state: { status: "error", message },
        }
      }
    }

    const url =
      this.pickFirstString(input, [
        "url",
        "Url",
        "document_id",
        "documentId",
      ]) || ""
    if (!url) {
      return {
        content: "[web_fetch error] Missing required url parameter",
        state: {
          status: "error",
          message: "missing url",
        },
      }
    }

    try {
      const doc = await this.fetchUrlDocument(url)
      const contentBody =
        doc.content.length > 18_000
          ? `${doc.content.slice(0, 18_000)}\n\n...[truncated]`
          : doc.content
      const content =
        `URL: ${doc.url}\n` +
        `Title: ${doc.title || "(unknown)"}\n` +
        `Content-Type: ${doc.contentType || "unknown"}\n\n` +
        contentBody
      return {
        content,
        state: { status: "success" },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: `[web_fetch error] ${message}`,
        state: { status: "error", message },
      }
    }
  }

  private extractInteractionResultCase(rawResponse: unknown): {
    responseCase?: string
    resultCase?: string
    resultValue?: Record<string, unknown>
  } {
    if (!rawResponse || typeof rawResponse !== "object") {
      return {}
    }

    const responseOneOf = (rawResponse as { result?: unknown }).result
    if (!responseOneOf || typeof responseOneOf !== "object") {
      return {}
    }

    const responseCase =
      typeof (responseOneOf as { case?: unknown }).case === "string"
        ? ((responseOneOf as { case: string }).case ?? "")
        : undefined
    const responseValue = (responseOneOf as { value?: unknown }).value
    if (!responseValue || typeof responseValue !== "object") {
      return { responseCase }
    }

    const level1 = (responseValue as { result?: unknown }).result
    if (!level1 || typeof level1 !== "object") {
      return { responseCase }
    }

    if (typeof (level1 as { case?: unknown }).case === "string") {
      return {
        responseCase,
        resultCase: (level1 as { case: string }).case,
        resultValue:
          (level1 as { value?: Record<string, unknown> }).value || undefined,
      }
    }

    const level2 = (level1 as { result?: unknown }).result
    if (level2 && typeof level2 === "object") {
      if (typeof (level2 as { case?: unknown }).case === "string") {
        return {
          responseCase,
          resultCase: (level2 as { case: string }).case,
          resultValue:
            (level2 as { value?: Record<string, unknown> }).value || undefined,
        }
      }
    }

    return { responseCase }
  }

  private extractInteractionRejectedReason(rawResponse: unknown): string {
    const parsed = this.extractInteractionResultCase(rawResponse)
    const reason = parsed.resultValue?.reason
    if (typeof reason === "string" && reason.trim() !== "") {
      return reason.trim()
    }
    return "request rejected by user"
  }

  private extractInteractionErrorMessage(rawResponse: unknown): string {
    const parsed = this.extractInteractionResultCase(rawResponse)
    const candidates = [
      parsed.resultValue?.error,
      parsed.resultValue?.errorMessage,
      parsed.resultValue?.message,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim() !== "") {
        return candidate.trim()
      }
    }
    return "request failed"
  }

  private normalizeAskQuestionProjectionAnswers(
    value: unknown
  ): AskQuestionProjectionAnswer[] {
    if (!Array.isArray(value)) return []

    const answers: AskQuestionProjectionAnswer[] = []
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue
      const answer = entry as Record<string, unknown>
      const questionId =
        this.pickFirstString(answer, ["questionId", "question_id"]) || ""
      const freeformText =
        this.pickFirstString(answer, ["freeformText", "freeform_text"]) || ""
      const selectedOptionIds = this.pickStringArray(answer, [
        "selectedOptionIds",
        "selected_option_ids",
      ]).filter((id) => id.trim().length > 0)

      const normalized: AskQuestionProjectionAnswer = {}
      if (questionId.trim()) normalized.questionId = questionId.trim()
      if (selectedOptionIds.length > 0)
        normalized.selectedOptionIds = selectedOptionIds
      if (freeformText.trim()) normalized.freeformText = freeformText.trim()
      answers.push(normalized)
    }
    return answers
  }

  private extractReferencesFromText(
    content: string,
    fallbackQuery: string,
    limit = 10
  ): Array<Record<string, unknown>> {
    const references: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g

    let match: RegExpExecArray | null
    while ((match = markdownLinkPattern.exec(content)) !== null) {
      const title = (match[1] || "").trim()
      const url = (match[2] || "").trim()
      if (!url || seen.has(url)) continue
      seen.add(url)
      references.push({
        title: title || url,
        url,
        text: "",
      })
      if (references.length >= limit) break
    }

    const plainUrlPattern = /https?:\/\/[^\s<>"')]+/g
    while (
      references.length < limit &&
      (match = plainUrlPattern.exec(content)) !== null
    ) {
      const url = (match[0] || "").trim().replace(/[.,;:!?]+$/, "")
      if (!url || seen.has(url)) continue
      seen.add(url)
      references.push({
        title: url,
        url,
        text: "",
      })
    }

    if (references.length === 0) {
      const query = fallbackQuery.trim()
      if (query) {
        references.push({
          title: query,
          url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
          text: "",
        })
      }
    }

    return references
  }

  private async executeInlineExaSearch(
    conversationId: string,
    input: Record<string, unknown>
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    const rawQuery =
      this.pickFirstString(input, ["query", "search_term", "searchTerm"]) || ""
    const query = this.normalizeWebSearchQueryForUserIntent(
      conversationId,
      rawQuery
    )
    if (!query) {
      return {
        content: "[exa_search error] Missing required query parameter",
        state: { status: "error", message: "missing query" },
      }
    }

    try {
      const result = await this.googleService.executeWebSearch(query)
      const maxChars = 18_000
      const summary =
        result.length > maxChars
          ? `${result.slice(0, maxChars)}\n\n...[truncated]`
          : result
      const references = this.extractReferencesFromText(summary, query)
      input.query = query
      input.references = references
      return {
        content: `Exa query: ${query}\n\n${summary}`,
        state: { status: "success" },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: `[exa_search error] ${message}`,
        state: { status: "error", message },
      }
    }
  }

  private async executeInlineExaFetch(input: Record<string, unknown>): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    const ids = this.pickStringArray(input, ["ids", "id", "urls", "url"])
    if (ids.length === 0) {
      return {
        content: "[exa_fetch error] Missing required ids parameter",
        state: { status: "error", message: "missing ids" },
      }
    }

    const uniqueIds = Array.from(new Set(ids)).slice(0, 4)
    const chunks: string[] = []
    const contents: Array<Record<string, unknown>> = []

    for (const id of uniqueIds) {
      if (!/^https?:\/\//i.test(id)) {
        chunks.push(`ID: ${id}\n[skip] non-http id is not fetchable in proxy`)
        continue
      }

      try {
        const doc = await this.fetchUrlDocument(id)
        const snippet =
          doc.content.length > 4_500
            ? `${doc.content.slice(0, 4_500)}\n...[truncated]`
            : doc.content
        contents.push({
          title: doc.title || doc.url,
          url: doc.url,
          text: snippet,
          publishedDate: "",
        })
        chunks.push(
          `URL: ${doc.url}\nTitle: ${doc.title || "(unknown)"}\n\n${snippet}`
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        chunks.push(`URL: ${id}\n[exa_fetch error] ${message}`)
      }
    }

    input.ids = uniqueIds
    input.contents = contents
    if (contents.length === 0) {
      return {
        content:
          chunks.length > 0
            ? chunks.join("\n\n---\n\n")
            : "[exa_fetch error] No fetchable ids succeeded",
        state: { status: "error", message: "no fetchable ids succeeded" },
      }
    }

    return {
      content: chunks.join("\n\n---\n\n"),
      state: { status: "success" },
    }
  }

  private parseInlineFetchHeaders(
    input: Record<string, unknown>
  ): Record<string, string> {
    const headers: Record<string, string> = {}
    const rawHeaders = input.headers ?? input.header

    if (Array.isArray(rawHeaders)) {
      for (const entry of rawHeaders) {
        if (Array.isArray(entry) && entry.length >= 2) {
          const key =
            typeof entry[0] === "string"
              ? entry[0].trim()
              : String(entry[0] || "")
          const value =
            typeof entry[1] === "string"
              ? entry[1].trim()
              : String(entry[1] || "")
          if (key && value) {
            headers[key] = value
          }
          continue
        }
        if (!entry || typeof entry !== "object") continue
        const candidate = entry as Record<string, unknown>
        const key = this.pickFirstString(candidate, ["key", "name", "header"])
        const value = this.pickFirstString(candidate, ["value"])
        if (key && value) {
          headers[key] = value
        }
      }
      return headers
    }

    if (rawHeaders && typeof rawHeaders === "object") {
      for (const [key, value] of Object.entries(rawHeaders)) {
        if (!key || typeof value !== "string") continue
        const normalizedKey = key.trim()
        const normalizedValue = value.trim()
        if (normalizedKey && normalizedValue) {
          headers[normalizedKey] = normalizedValue
        }
      }
      return headers
    }

    if (typeof rawHeaders === "string") {
      const lines = rawHeaders.split(/\r?\n/)
      for (const line of lines) {
        const separator = line.indexOf(":")
        if (separator <= 0) continue
        const key = line.slice(0, separator).trim()
        const value = line.slice(separator + 1).trim()
        if (key && value) {
          headers[key] = value
        }
      }
    }

    return headers
  }

  private async executeInlineFetch(input: Record<string, unknown>): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    const rawUrl =
      this.pickFirstString(input, [
        "url",
        "Url",
        "document_id",
        "documentId",
      ]) || ""
    if (!rawUrl) {
      return {
        content: "[fetch error] Missing required url parameter",
        state: { status: "error", message: "missing url" },
      }
    }

    let normalizedUrl: string
    try {
      const parsed = new URL(rawUrl)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return {
          content: `[fetch error] Unsupported URL protocol: ${parsed.protocol}`,
          state: { status: "error", message: "unsupported url protocol" },
        }
      }
      normalizedUrl = parsed.toString()
    } catch {
      return {
        content: `[fetch error] Invalid URL: ${rawUrl}`,
        state: { status: "error", message: "invalid url" },
      }
    }

    const method =
      (
        this.pickFirstString(input, ["method", "httpMethod", "http_method"]) ||
        "GET"
      )
        .trim()
        .toUpperCase() || "GET"
    const bodyRaw = input.body ?? input.data ?? input.payload
    let body: string | undefined
    if (method !== "GET" && method !== "HEAD" && bodyRaw !== undefined) {
      if (typeof bodyRaw === "string") {
        body = bodyRaw
      } else if (
        bodyRaw &&
        typeof bodyRaw === "object" &&
        !Buffer.isBuffer(bodyRaw)
      ) {
        try {
          body = JSON.stringify(bodyRaw)
        } catch {
          return {
            content: "[fetch error] Failed to serialize request body to JSON",
            state: { status: "error", message: "invalid request body" },
          }
        }
      } else if (
        typeof bodyRaw === "number" ||
        typeof bodyRaw === "boolean" ||
        typeof bodyRaw === "bigint"
      ) {
        body = String(bodyRaw)
      }
    }

    const headers = this.parseInlineFetchHeaders(input)
    if (
      !Object.keys(headers).some((key) => key.toLowerCase() === "user-agent")
    ) {
      headers["User-Agent"] = "protocol-bridge-fetch/1.0"
    }
    if (
      body &&
      typeof bodyRaw === "object" &&
      bodyRaw !== null &&
      !Buffer.isBuffer(bodyRaw) &&
      !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")
    ) {
      headers["Content-Type"] = "application/json"
    }

    try {
      const response = await fetch(normalizedUrl, {
        method,
        headers,
        body,
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      })
      const contentType = response.headers.get("content-type") || ""
      const responseText = await response.text()
      const bodyPreview =
        responseText.length > 18_000
          ? `${responseText.slice(0, 18_000)}\n...[truncated]`
          : responseText

      input.url = normalizedUrl
      input.statusCode = response.status
      input.status_code = response.status
      input.contentType = contentType
      input.content_type = contentType

      if (!response.ok) {
        const message = `HTTP ${response.status}`
        const content =
          `[fetch error] ${message}\n` +
          `URL: ${normalizedUrl}\n` +
          `Status: ${response.status}\n` +
          `Content-Type: ${contentType || "unknown"}\n\n` +
          bodyPreview
        return {
          content,
          state: { status: "error", message },
        }
      }

      return {
        content:
          `URL: ${normalizedUrl}\n` +
          `Status: ${response.status}\n` +
          `Content-Type: ${contentType || "unknown"}\n\n` +
          bodyPreview,
        state: { status: "success" },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: `[fetch error] ${message}`,
        state: { status: "error", message },
      }
    }
  }

  private executeInlineRecordScreen(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const modeValue = input.mode
    let mode: "start" | "save" | "discard" = "start"
    if (typeof modeValue === "number" && Number.isFinite(modeValue)) {
      const normalized = Math.floor(modeValue)
      if (normalized === 2) mode = "save"
      if (normalized === 3) mode = "discard"
    } else {
      const modeText = (
        this.pickFirstString(input, ["mode"]) || "start"
      ).toLowerCase()
      if (modeText.includes("save")) {
        mode = "save"
      } else if (modeText.includes("discard")) {
        mode = "discard"
      }
    }

    const modeEnum = mode === "save" ? 2 : mode === "discard" ? 3 : 1
    input.mode = modeEnum
    const saveAsFilename =
      this.pickFirstString(input, ["saveAsFilename", "save_as_filename"]) || ""
    if (saveAsFilename) {
      input.saveAsFilename = saveAsFilename
      input.save_as_filename = saveAsFilename
    }

    if (mode === "save") {
      const path =
        saveAsFilename || `.cursor-protocol-smoke/recording-${Date.now()}.webm`
      const durationMs =
        this.pickFirstNumber(input, [
          "recordingDurationMs",
          "durationMs",
          "duration",
        ]) ?? 0
      input.path = path
      input.filePath = path
      input.file_path = path
      input.recordingDurationMs = durationMs
      input.durationMs = durationMs
      input.duration = durationMs
      return {
        content: `[record_screen success] mode=save path=${path} duration_ms=${durationMs}`,
        state: { status: "success" },
      }
    }

    if (mode === "discard") {
      return {
        content: "[record_screen success] mode=discard",
        state: { status: "success" },
      }
    }

    return {
      content: "[record_screen success] mode=start",
      state: { status: "success" },
    }
  }

  private executeInlineComputerUse(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const actions = Array.isArray(input.actions)
      ? input.actions.filter((entry) => !!entry && typeof entry === "object")
      : []
    const durationMs =
      this.pickFirstNumber(input, ["durationMs", "duration_ms"]) ?? 0

    input.actions = actions
    input.actionCount = actions.length
    input.action_count = actions.length
    input.durationMs = durationMs
    input.duration_ms = durationMs

    return {
      content: `[computer_use success] actions=${actions.length} duration_ms=${durationMs}`,
      state: { status: "success" },
    }
  }

  private executeInlineTodoRead(
    conversationId: string,
    input: Record<string, unknown>
  ): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) {
      return {
        content: "[todo_read error] Session not found",
        state: { status: "error", message: "session not found" },
      }
    }

    const statusFilter = this.parseTodoStatusFilter(input)
    const idFilter = this.pickStringArray(input, ["id_filter", "idFilter"])
    const idFilterSet = new Set(idFilter)

    const filteredTodos = session.todos.filter((todo) => {
      if (statusFilter.length > 0 && !statusFilter.includes(todo.status)) {
        return false
      }
      if (idFilterSet.size > 0 && !idFilterSet.has(todo.id)) {
        return false
      }
      return true
    })

    const serializedTodos = filteredTodos.map((todo) =>
      this.serializeTodoItemForTool(todo)
    )
    input.status_filter = statusFilter.map((status) =>
      this.todoStatusToProtocolEnum(status)
    )
    input.statusFilter = input.status_filter
    input.id_filter = idFilter
    input.idFilter = idFilter
    input.todos = serializedTodos
    input.total_count = filteredTodos.length
    input.totalCount = filteredTodos.length

    const preview =
      filteredTodos.length > 0
        ? filteredTodos
            .slice(0, 20)
            .map(
              (todo) =>
                `- [${todo.status}] ${todo.id}: ${todo.content || "(empty)"}`
            )
            .join("\n")
        : "- (no todos)"

    return {
      content: `[todo_read success] total=${filteredTodos.length}\n${preview}`,
      state: { status: "success" },
    }
  }

  private executeInlineTodoWrite(
    conversationId: string,
    input: Record<string, unknown>
  ): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) {
      return {
        content: "[todo_write error] Session not found",
        state: { status: "error", message: "session not found" },
      }
    }

    const merge = this.pickFirstBoolean(input, ["merge"]) || false
    const existingTodosById = new Map<string, SessionTodoItem>(
      session.todos.map((todo) => [todo.id, todo])
    )
    const validationIssues = this.collectTodoItemValidationIssues(
      input,
      merge,
      existingTodosById
    )
    if (validationIssues.missingIdIndexes.length > 0) {
      return {
        content:
          "[todo_write error] Todo id is required for index(es): " +
          validationIssues.missingIdIndexes.join(", "),
        state: { status: "error", message: "missing todo id" },
      }
    }
    if (validationIssues.missingContentIndexes.length > 0) {
      return {
        content:
          "[todo_write error] Todo content is required for index(es): " +
          validationIssues.missingContentIndexes.join(", "),
        state: { status: "error", message: "missing todo content" },
      }
    }
    const incomingTodos = this.parseTodoItemsForSession(input)
    if (incomingTodos.length === 0) {
      return {
        content: "[todo_write error] Missing required todos payload",
        state: { status: "error", message: "missing todos" },
      }
    }

    let nextTodos: SessionTodoItem[]
    if (merge) {
      const byId = new Map<string, SessionTodoItem>(existingTodosById)
      for (const incoming of incomingTodos) {
        const existing = byId.get(incoming.id)
        byId.set(incoming.id, {
          id: incoming.id,
          content: incoming.content || existing?.content || "",
          status: incoming.status || existing?.status || "pending",
          createdAt: existing?.createdAt || incoming.createdAt,
          updatedAt: Date.now(),
          dependencies:
            incoming.dependencies.length > 0
              ? incoming.dependencies
              : existing?.dependencies || [],
        })
      }
      nextTodos = Array.from(byId.values())
    } else {
      nextTodos = incomingTodos.map((todo) => ({
        ...todo,
        updatedAt: Date.now(),
      }))
    }

    this.sessionManager.replaceTodos(session.conversationId, nextTodos)
    const serializedTodos = nextTodos.map((todo) =>
      this.serializeTodoItemForTool(todo)
    )
    input.merge = merge
    input.todos = serializedTodos
    input.updated_todos = serializedTodos
    input.updatedTodos = serializedTodos
    input.total_count = nextTodos.length
    input.totalCount = nextTodos.length

    const preview =
      nextTodos.length > 0
        ? nextTodos
            .slice(0, 20)
            .map(
              (todo) =>
                `- [${todo.status}] ${todo.id}: ${todo.content || "(empty)"}`
            )
            .join("\n")
        : "- (no todos)"

    return {
      content:
        `[todo_write success] merge=${merge ? "true" : "false"} total=${nextTodos.length}\n` +
        preview,
      state: { status: "success" },
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // SUB-AGENT (task) – event-driven state machine
  // ────────────────────────────────────────────────────────────────────

  /**
   * Execute a sub-agent for the "task" tool.
   * Runs LLM turns in a loop, dispatches tool calls inline, and yields
   * protocol buffers throughout.
   */
  private async *executeSubAgentTask(
    conversationId: string,
    parentToolCallId: string,
    input: Record<string, unknown>
  ): AsyncGenerator<Buffer> {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) {
      yield* this.emitInlineToolResult(
        conversationId,
        parentToolCallId,
        "[task error] session not found",
        { status: "error", message: "session not found" }
      )
      return
    }

    const description =
      this.pickFirstString(input, ["description", "prompt", "task"]) || ""
    if (!description) {
      yield* this.emitInlineToolResult(
        conversationId,
        parentToolCallId,
        "[task error] Missing required description/prompt",
        { status: "error", message: "missing description" }
      )
      return
    }

    // Create sub-agent context
    const subagentId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ctx: SubAgentContext = {
      subagentId,
      parentToolCallId,
      parentModelCallId: "",
      messages: [
        {
          role: "user" as const,
          content: `You are a sub-agent. Complete the following task:\n\n${description}`,
        },
      ],
      model: session.model || "gemini-2.5-flash",
      tools: [],
      accumulatedText: "",
      pendingToolCallIds: new Set(),
      startTime: Date.now(),
      turnCount: 0,
      toolCallCount: 0,
      modifiedFiles: [],
      currentTurnToolCalls: [],
      pendingToolResults: new Map(),
      expectedToolCallIds: new Set(),
    }

    this.sessionManager.setSubAgentContext(conversationId, ctx)
    this.logger.log(
      `[SubAgent] Created ${subagentId} for parent tool call ${parentToolCallId}`
    )

    const MAX_TURNS = 20

    // ── Main LLM turn loop ──
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      ctx.turnCount++
      this.logger.log(
        `[SubAgent] ${subagentId} turn ${ctx.turnCount}/${MAX_TURNS}`
      )

      // Build DTO for this turn
      const dto: CreateMessageDto = {
        model: ctx.model,
        messages: ctx.messages.map((m) => ({
          role: m.role,
          content: m.content as any,
        })),
        max_tokens: 8192,
        stream: true,
        _conversationId: conversationId,
      }

      let fullText = ""
      const toolCalls: Array<{
        id: string
        name: string
        inputJson: string
      }> = []
      let currentToolCall: {
        id: string
        name: string
        inputJson: string
      } | null = null

      try {
        const stream = this.getBackendStream(dto)

        for await (const sseEventStr of stream) {
          const event = this.parseSseEvent(sseEventStr)
          if (!event) continue

          if (event.type === "content_block_start") {
            const cb = event.data.content_block
            if (cb?.type === "tool_use" && cb.id && cb.name) {
              currentToolCall = {
                id: cb.id,
                name: cb.name,
                inputJson: "",
              }
            }
          } else if (event.type === "content_block_delta") {
            const delta = event.data.delta
            if (delta?.type === "text_delta" && delta.text) {
              fullText += delta.text
            } else if (delta?.type === "input_json_delta" && currentToolCall) {
              currentToolCall.inputJson += delta.partial_json || ""
            }
          } else if (event.type === "content_block_stop") {
            if (currentToolCall) {
              toolCalls.push(currentToolCall)
              currentToolCall = null
            }
          }
        }
      } catch (error) {
        this.logger.error(`[SubAgent] LLM stream error: ${String(error)}`)
        yield* this.completeSubAgent(
          conversationId,
          `[sub-agent error] ${String(error)}`
        )
        return
      }

      ctx.accumulatedText = fullText

      // Build assistant message for history
      const assistantContentParts: Array<Record<string, unknown>> = []
      if (fullText) {
        assistantContentParts.push({ type: "text", text: fullText })
      }
      for (const tc of toolCalls) {
        let parsedInput: Record<string, unknown> = {}
        try {
          parsedInput = JSON.parse(tc.inputJson || "{}")
        } catch {
          parsedInput = { _raw: tc.inputJson }
        }
        assistantContentParts.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: parsedInput,
        })
      }
      if (assistantContentParts.length > 0) {
        ctx.messages.push({
          role: "assistant",
          content: assistantContentParts as any,
        })
      }

      // No tool calls → sub-agent is done
      if (toolCalls.length === 0) {
        yield* this.completeSubAgent(conversationId, fullText)
        return
      }

      // ── Dispatch tool calls (all handled inline for now) ──
      ctx.toolCallCount += toolCalls.length
      const toolResults: Array<{
        type: string
        tool_use_id: string
        content: string
      }> = []

      for (const tc of toolCalls) {
        let parsedInput: Record<string, unknown> = {}
        try {
          parsedInput = JSON.parse(tc.inputJson || "{}")
        } catch {
          parsedInput = { _raw: tc.inputJson }
        }

        // Try to dispatch as a deferred tool
        const family = this.classifyDeferredToolFamily(tc.name)
        if (family) {
          this.logger.log(
            `[SubAgent] Inline deferred tool: ${tc.name} (${tc.id})`
          )
          try {
            const result = await this.executeDeferredTool(
              conversationId,
              family,
              tc.name,
              parsedInput
            )
            toolResults.push({
              type: "tool_result",
              tool_use_id: tc.id,
              content: result.content,
            })
          } catch (err) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: tc.id,
              content: `[tool error] ${String(err)}`,
            })
          }
        } else {
          // Not a deferred tool – unsupported in sub-agent
          this.logger.warn(
            `[SubAgent] Unsupported exec tool: ${tc.name} (${tc.id})`
          )
          toolResults.push({
            type: "tool_result",
            tool_use_id: tc.id,
            content: `[tool error] Tool "${tc.name}" is not available in sub-agent context`,
          })
        }
      }

      // Add tool results to conversation
      ctx.messages.push({
        role: "user",
        content: toolResults as any,
      })
    }

    // Reached max turns
    yield* this.completeSubAgent(
      conversationId,
      ctx.accumulatedText || "[sub-agent reached max turns]"
    )
  }

  /**
   * Complete the sub-agent and emit result for the parent's task tool call.
   */
  private async *completeSubAgent(
    conversationId: string,
    finalText: string
  ): AsyncGenerator<Buffer> {
    const subAgentCtx = this.sessionManager.getSubAgentContext(conversationId)
    if (!subAgentCtx) return

    const durationMs = Date.now() - subAgentCtx.startTime
    this.logger.log(
      `[SubAgent] Completed ${subAgentCtx.subagentId}: ` +
        `${subAgentCtx.turnCount} turns, ${subAgentCtx.toolCallCount} tool calls, ${durationMs}ms`
    )

    yield* this.emitInlineToolResult(
      conversationId,
      subAgentCtx.parentToolCallId,
      finalText || "[sub-agent completed with no output]",
      { status: "success" }
    )

    this.sessionManager.clearSubAgentContext(conversationId)
  }

  /**
   * Classify a tool name to its DeferredToolFamily, or null if it's not deferred.
   */
  private classifyDeferredToolFamily(
    toolName: string
  ): DeferredToolFamily | null {
    const DEFERRED_TOOL_MAP: Record<string, DeferredToolFamily> = {
      web_search: "web_search",
      web_fetch: "web_fetch",
      fetch: "fetch",
      read_file: "read_semsearch_files",
      list_dir: "file_search",
      file_search: "file_search",
      grep_search: "semantic_search",
      codebase_search: "semantic_search",
      todo_read: "todo_read",
      todo_write: "todo_write",
    }
    return DEFERRED_TOOL_MAP[toolName] || null
  }

  private executeInlineApplyAgentDiff(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    input.applied_changes = []
    input.appliedChanges = []
    return {
      content: "[apply_agent_diff success] acknowledged in proxy runtime",
      state: { status: "success" },
    }
  }

  private executeInlineGenerateImage(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const prompt = this.pickFirstString(input, ["prompt", "description"]) || ""
    if (!prompt) {
      return {
        content: "[generate_image error] Missing required prompt",
        state: { status: "error", message: "missing prompt" },
      }
    }
    return {
      content:
        "[generate_image error] image generation backend is not configured in this proxy runtime",
      state: { status: "error", message: "generate_image unsupported" },
    }
  }

  private executeInlineReportBugfixResults(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const rawResults = Array.isArray(input.results) ? input.results : []
    const normalized = normalizeBugfixResultItemsFromContract(rawResults)
    const normalizedResults = normalized.items.map((entry) => ({
      bugId: entry.bugId,
      bug_id: entry.bugId,
      bugTitle: entry.bugTitle,
      bug_title: entry.bugTitle,
      verdict: entry.verdict,
      explanation: entry.explanation,
    }))

    input.results = normalizedResults
    if (rawResults.length === 0) {
      return {
        content:
          "[report_bugfix_results error] Missing required results array with at least one item",
        state: { status: "error", message: "missing results" },
      }
    }

    if (normalizedResults.length === 0) {
      const ignored =
        normalized.invalidIndexes.length > 0
          ? `ignored_invalid_items=${normalized.invalidIndexes.join(",")}`
          : "ignored_invalid_items=unknown"
      return {
        content: `[report_bugfix_results error] No valid bugfix result entries (${ignored})`,
        state: { status: "error", message: "no valid results" },
      }
    }

    if (normalized.invalidIndexes.length > 0) {
      return {
        content:
          "[report_bugfix_results success] " +
          `results=${normalizedResults.length}, ` +
          `ignored_invalid_items=${normalized.invalidIndexes.join(",")}`,
        state: { status: "success" },
      }
    }

    return {
      content: `[report_bugfix_results success] results=${normalizedResults.length}`,
      state: { status: "success" },
    }
  }

  private resolveWorkspaceRoot(conversationId: string): string {
    const session = this.sessionManager.getSession(conversationId)
    const root = session?.projectContext?.rootPath
    return typeof root === "string" && root.trim() !== "" ? root : process.cwd()
  }

  private async collectWorkspacePaths(
    rootPath: string,
    options?: { maxFiles?: number; maxDepth?: number }
  ): Promise<string[]> {
    const maxFiles = options?.maxFiles ?? 5_000
    const maxDepth = options?.maxDepth ?? 8
    const skipDirs = new Set([
      ".git",
      ".svn",
      ".hg",
      "node_modules",
      ".next",
      "dist",
      "build",
      "target",
      "__pycache__",
      ".idea",
      ".vscode",
    ])

    const fs = await import("fs/promises")
    const path = await import("path")

    const files: string[] = []
    const queue: Array<{ abs: string; rel: string; depth: number }> = [
      { abs: rootPath, rel: "", depth: 0 },
    ]

    while (queue.length > 0 && files.length < maxFiles) {
      const current = queue.pop()
      if (!current) break
      let entries: Array<{
        isDirectory: () => boolean
        isFile: () => boolean
        name: string
      }> = []
      try {
        entries = await fs.readdir(current.abs, {
          withFileTypes: true,
        })
      } catch {
        continue
      }

      for (const entry of entries) {
        const rel = current.rel
          ? path.join(current.rel, entry.name)
          : entry.name
        const abs = path.join(current.abs, entry.name)

        if (entry.isDirectory()) {
          if (current.depth >= maxDepth) continue
          if (skipDirs.has(entry.name)) continue
          queue.push({ abs, rel, depth: current.depth + 1 })
          continue
        }

        if (entry.isFile()) {
          files.push(rel)
          if (files.length >= maxFiles) break
        }
      }
    }

    return files
  }

  private buildGlobLikeRegex(pattern: string): RegExp {
    const normalizedPattern = pattern.replace(/\\/g, "/")
    const escaped = normalizedPattern
      .replace(/\*\*\//g, ":::DOUBLE_STAR_SLASH:::")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ":::DOUBLE_STAR:::")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/:::DOUBLE_STAR_SLASH:::/g, "(?:.*/)?")
      .replace(/:::DOUBLE_STAR:::/g, ".*")
    return new RegExp(`^${escaped}$`, "i")
  }

  private shouldTreatFileSearchQueryAsGlob(query: string): boolean {
    const normalized = query.trim()
    if (!normalized) return false
    return (
      normalized.includes("*") ||
      normalized.includes("?") ||
      normalized.includes("[") ||
      normalized.includes("]") ||
      normalized.includes("{") ||
      normalized.includes("}") ||
      normalized.includes("**")
    )
  }

  private async executeInlineFileSearchFamily(
    conversationId: string,
    family: "file_search" | "glob_search",
    input: Record<string, unknown>
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    const query =
      this.pickFirstString(input, ["query", "pattern", "search_term"]) || ""
    if (!query) {
      return {
        content: `[${family} error] Missing required query/pattern`,
        state: { status: "error", message: "missing query/pattern" },
      }
    }

    const rootPath = this.resolveWorkspaceRoot(conversationId)
    const path = await import("path")
    const normalizedRootPath = path.resolve(rootPath).replace(/\\/g, "/")
    const effectiveFamily =
      family === "file_search" && this.shouldTreatFileSearchQueryAsGlob(query)
        ? "glob_search"
        : family
    const normalizedQuery =
      effectiveFamily === "glob_search"
        ? this.normalizeGlobPatternQuery(query, normalizedRootPath)
        : query
    const files = await this.collectWorkspacePaths(rootPath)
    const globRegex =
      effectiveFamily === "glob_search"
        ? this.buildGlobLikeRegex(normalizedQuery)
        : null

    const matches = files
      .filter((file) =>
        globRegex
          ? globRegex.test(file.replace(/\\/g, "/"))
          : file.toLowerCase().includes(normalizedQuery.toLowerCase())
      )
      .slice(0, 200)

    input.path = rootPath
    input.query = normalizedQuery
    input.pattern = normalizedQuery
    input.originalQuery = query
    input.matches = matches
    input.files = matches
    input.total_matches = matches.length
    input.totalMatches = matches.length

    const preview =
      matches.length > 0
        ? matches
            .slice(0, 80)
            .map((file) => `- ${file}`)
            .join("\n")
        : "- (no matches)"
    return {
      content:
        `[${family} success] mode=${effectiveFamily} query=${normalizedQuery} total=${matches.length}\n` +
        preview,
      state: { status: "success" },
    }
  }

  private normalizeGlobPatternQuery(
    query: string,
    normalizedRootPath: string
  ): string {
    let normalizedQuery = query.trim().replace(/\\/g, "/")
    if (!normalizedQuery) return normalizedQuery

    if (normalizedQuery.startsWith("file://")) {
      try {
        const parsed = new URL(normalizedQuery)
        normalizedQuery = decodeURIComponent(parsed.pathname).replace(
          /\\/g,
          "/"
        )
      } catch {
        // Keep the original query if URL parsing fails.
      }
    }

    const normalizedRoot = normalizedRootPath
      .replace(/\\/g, "/")
      .replace(/\/+$/g, "")
    normalizedQuery = normalizedQuery.replace(/\/{2,}/g, "/")

    if (normalizedQuery === normalizedRoot) {
      return "**/*"
    }
    if (normalizedQuery.startsWith(`${normalizedRoot}/`)) {
      return normalizedQuery.slice(normalizedRoot.length + 1)
    }
    if (normalizedQuery.startsWith("./")) {
      return normalizedQuery.slice(2)
    }

    return normalizedQuery
  }

  private primeGlobDeferredInputForProtocol(
    conversationId: string,
    input: Record<string, unknown>
  ): void {
    const rawPattern =
      this.pickFirstString(input, [
        "pattern",
        "globPattern",
        "glob_pattern",
        "query",
        "search_term",
        "searchTerm",
      ]) || ""
    if (!rawPattern) return

    const rootPath = this.resolveWorkspaceRoot(conversationId)
    const normalizedRootPath = rootPath.replace(/\\/g, "/")
    const workspaceRelativePattern = this.normalizeGlobPatternQuery(
      rawPattern,
      normalizedRootPath
    )

    input.path = rootPath
    input.targetDirectory = rootPath
    input.target_directory = rootPath
    input.pattern = workspaceRelativePattern
    input.query = workspaceRelativePattern
    input.originalQuery = rawPattern
  }

  private primeTodoWriteDeferredInputForProtocol(
    input: Record<string, unknown>
  ): void {
    const merge = this.pickFirstBoolean(input, ["merge"]) || false
    const validationIssues = this.collectTodoItemValidationIssues(
      input,
      merge,
      new Map()
    )
    if (
      validationIssues.missingIdIndexes.length > 0 ||
      validationIssues.missingContentIndexes.length > 0
    ) {
      return
    }

    const parsedTodos = this.parseTodoItemsForSession(input)
    if (parsedTodos.length === 0) return

    input.merge = merge
    input.todos = parsedTodos.map((todo) => this.serializeTodoItemForTool(todo))
  }

  private async executeInlineSemanticLikeSearch(
    conversationId: string,
    family: "semantic_search" | "deep_search",
    input: Record<string, unknown>
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    const query = this.pickFirstString(input, ["query", "search_term"]) || ""
    if (!query) {
      return {
        content: `[${family} error] Missing required query`,
        state: { status: "error", message: "missing query" },
      }
    }

    const rootPath = this.resolveWorkspaceRoot(conversationId)
    const targetDirectories = this.pickStringArray(input, [
      "targetDirectories",
      "target_directories",
    ])
    const maxResults = family === "deep_search" ? 200 : 120
    const providerResponse = await this.semanticSearchProvider.search({
      conversationId,
      family,
      query,
      rootPath,
      targetDirectories,
      maxResults,
    })

    const results = providerResponse.results
      .slice(0, maxResults)
      .map((entry) => ({
        path: entry.path,
        score: entry.score,
        snippet: entry.snippet,
      }))
    input.path = rootPath
    input.query = query
    input.targetDirectories = targetDirectories
    input.results = results
    input.total_matches = results.length
    input.totalMatches = results.length
    input.semantic_search_provider = providerResponse.provider

    if (providerResponse.status !== "success") {
      const providerReason =
        providerResponse.message || "semantic index backend unavailable"
      return {
        content: `[${family} error] ${providerReason}`,
        state: {
          status: "error",
          message: providerReason,
        },
      }
    }

    const preview =
      results.length > 0
        ? results
            .slice(0, 80)
            .map((entry) => {
              const score = Number.isFinite(entry.score)
                ? entry.score.toFixed(3)
                : "0.000"
              const snippet =
                typeof entry.snippet === "string" && entry.snippet.trim()
                  ? ` :: ${entry.snippet.trim().replace(/\s+/g, " ").slice(0, 120)}`
                  : ""
              return `- [score=${score}] ${entry.path}${snippet}`
            })
            .join("\n")
        : "- (no matches)"

    return {
      content:
        `[${family} success] provider=${providerResponse.provider} ` +
        `query=${query} total=${results.length}\n${preview}`,
      state: { status: "success" },
    }
  }

  private async readWorkspaceFileSnippet(
    rootPath: string,
    targetPath: string,
    maxLength: number = 4_500
  ): Promise<{ path: string; content: string } | undefined> {
    const path = await import("path")
    const fs = await import("fs/promises")

    const normalizedRoot = path.resolve(rootPath)
    const abs = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(normalizedRoot, targetPath)
    if (!abs.startsWith(normalizedRoot)) {
      return undefined
    }

    let content = ""
    try {
      content = await fs.readFile(abs, "utf-8")
    } catch {
      return undefined
    }

    const relPath = path.relative(normalizedRoot, abs)
    return {
      path: relPath.replace(/\\/g, "/"),
      content:
        content.length > maxLength
          ? `${content.slice(0, maxLength)}\n...[truncated]`
          : content,
    }
  }

  private async executeInlineReadSemsearchFiles(
    conversationId: string,
    input: Record<string, unknown>
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    const filePaths = this.pickStringArray(input, [
      "file_paths",
      "paths",
      "files",
    ])
    if (filePaths.length === 0) {
      return {
        content: "[read_semsearch_files error] Missing required file_paths",
        state: { status: "error", message: "missing file_paths" },
      }
    }

    const rootPath = this.resolveWorkspaceRoot(conversationId)
    const collected: Array<{ path: string; content: string }> = []
    for (const filePath of filePaths.slice(0, 20)) {
      const snippet = await this.readWorkspaceFileSnippet(rootPath, filePath)
      if (snippet) collected.push(snippet)
    }

    input.files = collected.map((entry) => ({
      path: entry.path,
      content: entry.content,
    }))
    input.file_paths = collected.map((entry) => entry.path)
    input.total_count = collected.length
    input.totalCount = collected.length

    const preview =
      collected.length > 0
        ? collected
            .map((entry) => `Path: ${entry.path}\n${entry.content}`)
            .join("\n\n---\n\n")
        : "- (no readable files)"
    return {
      content: `[read_semsearch_files success] total=${collected.length}\n${preview}`,
      state: { status: "success" },
    }
  }

  private executeInlineReapply(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const patch = this.pickFirstString(input, ["patch", "diff"]) || ""
    if (!patch) {
      return {
        content: "[reapply error] Missing patch/diff payload",
        state: { status: "error", message: "missing patch" },
      }
    }
    input.applied = false
    input.reason =
      "patch reapply is acknowledged but not auto-applied in proxy runtime"
    return {
      content:
        "[reapply success] patch request acknowledged; automatic patch replay is not enabled in this proxy runtime",
      state: { status: "success" },
    }
  }

  private async executeInlineFetchRules(
    conversationId: string,
    input: Record<string, unknown>
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    const rootPath = this.resolveWorkspaceRoot(conversationId)
    const candidates = [
      ".cursor/rules",
      ".cursor/rules.md",
      ".cursorrules",
      ".cursor/AGENTS.md",
      "AGENTS.md",
      ".agent/rules.md",
    ]
    const rules: Array<{ path: string; content: string }> = []
    for (const candidate of candidates) {
      const snippet = await this.readWorkspaceFileSnippet(
        rootPath,
        candidate,
        3_500
      )
      if (snippet) rules.push(snippet)
    }

    input.rules = rules
    input.total_count = rules.length
    input.totalCount = rules.length
    input.path = rules[0]?.path || ""

    const preview =
      rules.length > 0
        ? rules
            .map((rule) => `Path: ${rule.path}\n${rule.content}`)
            .join("\n\n---\n\n")
        : "- (no rules found)"
    return {
      content: `[fetch_rules success] total=${rules.length}\n${preview}`,
      state: { status: "success" },
    }
  }

  private async executeInlineSearchSymbols(
    conversationId: string,
    input: Record<string, unknown>
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    const query = this.pickFirstString(input, ["query", "symbol"]) || ""
    if (!query) {
      return {
        content: "[search_symbols error] Missing required query",
        state: { status: "error", message: "missing query" },
      }
    }
    input.query = query
    return this.executeInlineSemanticLikeSearch(
      conversationId,
      "semantic_search",
      input
    )
  }

  private executeInlineBackgroundComposerFollowup(
    input: Record<string, unknown>
  ): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const message = this.pickFirstString(input, ["message", "prompt"]) || ""
    if (!message) {
      return {
        content:
          "[background_composer_followup error] Missing required message",
        state: { status: "error", message: "missing message" },
      }
    }
    input.accepted = true
    return {
      content:
        "[background_composer_followup success] follow-up accepted by proxy runtime",
      state: { status: "success" },
    }
  }

  private async executeInlineKnowledgeBase(
    conversationId: string,
    input: Record<string, unknown>
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    const query = this.pickFirstString(input, ["query", "search_term"]) || ""
    if (!query) {
      return {
        content: "[knowledge_base error] Missing required query",
        state: { status: "error", message: "missing query" },
      }
    }
    input.query = query
    return this.executeInlineSemanticLikeSearch(
      conversationId,
      "deep_search",
      input
    )
  }

  private async executeInlineFetchPullRequest(
    input: Record<string, unknown>
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    const url = this.pickFirstString(input, ["url", "id"]) || ""
    if (!url) {
      return {
        content: "[fetch_pull_request error] Missing required url/id",
        state: { status: "error", message: "missing url/id" },
      }
    }
    if (!/^https?:\/\//i.test(url)) {
      return {
        content:
          "[fetch_pull_request error] Only absolute http(s) URLs are supported",
        state: { status: "error", message: "unsupported pull request locator" },
      }
    }
    try {
      const doc = await this.fetchUrlDocument(url)
      const snippet =
        doc.content.length > 5_500
          ? `${doc.content.slice(0, 5_500)}\n...[truncated]`
          : doc.content
      input.url = doc.url
      input.title = doc.title
      return {
        content: `URL: ${doc.url}\nTitle: ${doc.title || "(unknown)"}\n\n${snippet}`,
        state: { status: "success" },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: `[fetch_pull_request error] ${message}`,
        state: { status: "error", message },
      }
    }
  }

  private executeInlineCreateDiagram(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const prompt = this.pickFirstString(input, ["prompt", "description"]) || ""
    if (!prompt) {
      return {
        content: "[create_diagram error] Missing required prompt",
        state: { status: "error", message: "missing prompt" },
      }
    }
    const mermaid = [
      "flowchart TD",
      `  A[Request] --> B[${prompt.slice(0, 80) || "Diagram"}]`,
      "  B --> C[Implementation]",
      "  C --> D[Verification]",
    ].join("\n")
    input.diagram_format = "mermaid"
    input.diagram = mermaid
    return {
      content: `[create_diagram success]\n\`\`\`mermaid\n${mermaid}\n\`\`\``,
      state: { status: "success" },
    }
  }

  private async executeInlineFixLints(
    conversationId: string,
    input: Record<string, unknown>
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    const rootPath = this.resolveWorkspaceRoot(conversationId)
    const execution = await this.clientSideToolV2Executor.executeFixLints(
      rootPath,
      input
    )

    input.client_side_tool_v2 = {
      tool: "CLIENT_SIDE_TOOL_V2_FIX_LINTS",
      replay: execution.replay,
    }
    input.fix_lints_replay = execution.replay
    input.file_results = execution.replay.fix.fileResults
    input.before_diagnostics_total = execution.replay.before.totalDiagnostics
    input.after_diagnostics_total = execution.replay.after.totalDiagnostics
    input.paths = execution.replay.fix.fileResults.map(
      (entry) => entry.filePath || entry.relativePath
    )

    return {
      content: execution.content,
      state: {
        status: execution.status,
        message: execution.message,
      },
    }
  }

  private async executeInlineGoToDefinition(
    conversationId: string,
    input: Record<string, unknown>
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    const symbol = this.pickFirstString(input, ["symbol", "query"]) || ""
    if (!symbol) {
      return {
        content: "[go_to_definition error] Missing required symbol",
        state: { status: "error", message: "missing symbol" },
      }
    }
    input.query = symbol
    return this.executeInlineSemanticLikeSearch(
      conversationId,
      "semantic_search",
      input
    )
  }

  private executeInlineAwaitTask(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const taskId = this.pickFirstString(input, ["task_id", "taskId"]) || ""
    input.task_id = taskId
    input.completed = true
    return {
      content: `[await_task success] ${taskId || "task"} completed`,
      state: { status: "success" },
    }
  }

  private async executeInlineReadProject(
    conversationId: string,
    input: Record<string, unknown>
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    const rootPath = this.resolveWorkspaceRoot(conversationId)
    const key = this.pickFirstString(input, ["key"]) || ""
    const candidates = [
      "package.json",
      "tsconfig.json",
      "README.md",
      "AGENTS.md",
    ]
    const docs: Array<{ path: string; content: string }> = []
    for (const candidate of candidates) {
      const snippet = await this.readWorkspaceFileSnippet(
        rootPath,
        candidate,
        2_600
      )
      if (snippet) docs.push(snippet)
    }
    input.key = key
    input.path = rootPath
    input.documents = docs
    input.total_count = docs.length
    input.totalCount = docs.length
    const preview =
      docs.length > 0
        ? docs
            .map((doc) => `Path: ${doc.path}\n${doc.content}`)
            .join("\n\n---\n\n")
        : "- (no project metadata files found)"
    return {
      content: `[read_project success] root=${rootPath}\n${preview}`,
      state: { status: "success" },
    }
  }

  private executeInlineUpdateProject(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const key = this.pickFirstString(input, ["key"]) || ""
    const value = this.pickFirstString(input, ["value"]) || ""
    if (!key) {
      return {
        content: "[update_project error] Missing required key",
        state: { status: "error", message: "missing key" },
      }
    }
    input.key = key
    input.value = value
    input.updated = true
    return {
      content:
        "[update_project success] project metadata update acknowledged in proxy runtime",
      state: { status: "success" },
    }
  }

  private executeInlineReflect(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const unexpectedActionOutcomes =
      this.pickFirstString(input, [
        "unexpectedActionOutcomes",
        "unexpected_action_outcomes",
      ]) || ""
    const relevantInstructions =
      this.pickFirstString(input, [
        "relevantInstructions",
        "relevant_instructions",
      ]) || ""
    const scenarioAnalysis =
      this.pickFirstString(input, ["scenarioAnalysis", "scenario_analysis"]) ||
      ""
    const criticalSynthesis =
      this.pickFirstString(input, [
        "criticalSynthesis",
        "critical_synthesis",
        "explanation",
      ]) || ""
    const nextSteps =
      this.pickFirstString(input, ["nextSteps", "next_steps"]) || ""

    const details: string[] = []
    if (unexpectedActionOutcomes) {
      details.push(`unexpected_action_outcomes: ${unexpectedActionOutcomes}`)
    }
    if (relevantInstructions) {
      details.push(`relevant_instructions: ${relevantInstructions}`)
    }
    if (scenarioAnalysis) {
      details.push(`scenario_analysis: ${scenarioAnalysis}`)
    }
    if (criticalSynthesis) {
      details.push(`critical_synthesis: ${criticalSynthesis}`)
    }
    if (nextSteps) {
      details.push(`next_steps: ${nextSteps}`)
    }

    const message =
      details.length > 0
        ? `[reflect success]\n${details.join("\n")}`
        : "[reflect success] reflection acknowledged"
    return {
      content: message,
      state: { status: "success" },
    }
  }

  private executeInlineStartGrindExecution(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const explanation = this.pickFirstString(input, ["explanation"]) || ""
    const message = explanation
      ? `[start_grind_execution success] ${explanation}`
      : "[start_grind_execution success]"
    return {
      content: message,
      state: { status: "success" },
    }
  }

  private executeInlineStartGrindPlanning(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const explanation = this.pickFirstString(input, ["explanation"]) || ""
    const message = explanation
      ? `[start_grind_planning success] ${explanation}`
      : "[start_grind_planning success]"
    return {
      content: message,
      state: { status: "success" },
    }
  }

  private executeInlineSetupVmEnvironment(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const unsupportedMessage =
      this.getUnsupportedDeferredToolMessage("setup_vm_environment") ||
      "setup_vm_environment backend is not configured in this proxy runtime"
    const installCommand =
      this.pickFirstString(input, ["installCommand", "install_command"]) || ""
    const startCommand =
      this.pickFirstString(input, ["startCommand", "start_command"]) || ""
    const lines = [`[setup_vm_environment error] ${unsupportedMessage}`]
    if (installCommand) {
      lines.push(`install_command: ${installCommand}`)
    }
    if (startCommand) {
      lines.push(`start_command: ${startCommand}`)
    }
    return {
      content: lines.join("\n"),
      state: { status: "error", message: unsupportedMessage },
    }
  }

  private async executeDeferredTool(
    conversationId: string,
    family: DeferredToolFamily,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    if (family === "web_search" || family === "web_fetch") {
      return this.executeInlineWebTool(conversationId, toolName, input)
    }
    if (family === "fetch") {
      return this.executeInlineFetch(input)
    }
    if (family === "record_screen") {
      return Promise.resolve(this.executeInlineRecordScreen(input))
    }
    if (family === "computer_use") {
      return Promise.resolve(this.executeInlineComputerUse(input))
    }
    if (family === "exa_search") {
      return this.executeInlineExaSearch(conversationId, input)
    }
    if (family === "exa_fetch") {
      return this.executeInlineExaFetch(input)
    }
    if (family === "todo_read") {
      return this.executeInlineTodoRead(conversationId, input)
    }
    if (family === "todo_write") {
      return this.executeInlineTodoWrite(conversationId, input)
    }
    if (family === "task") {
      // Sub-agent is handled via the async generator path in runDeferredToolIfNeeded,
      // not through executeDeferredTool. This should not be reached.
      return {
        content: "[task error] sub-agent should use the generator path",
        state: {
          status: "error" as ToolResultStatus,
          message: "wrong dispatch path",
        },
      }
    }
    if (family === "apply_agent_diff") {
      return this.executeInlineApplyAgentDiff(input)
    }
    if (family === "generate_image") {
      return this.executeInlineGenerateImage(input)
    }
    if (family === "report_bugfix_results") {
      return this.executeInlineReportBugfixResults(input)
    }
    if (family === "file_search" || family === "glob_search") {
      return this.executeInlineFileSearchFamily(conversationId, family, input)
    }
    if (family === "semantic_search" || family === "deep_search") {
      return this.executeInlineSemanticLikeSearch(conversationId, family, input)
    }
    if (family === "read_semsearch_files") {
      return this.executeInlineReadSemsearchFiles(conversationId, input)
    }
    if (family === "reapply") {
      return this.executeInlineReapply(input)
    }
    if (family === "fetch_rules") {
      return this.executeInlineFetchRules(conversationId, input)
    }
    if (family === "search_symbols") {
      return this.executeInlineSearchSymbols(conversationId, input)
    }
    if (family === "background_composer_followup") {
      return this.executeInlineBackgroundComposerFollowup(input)
    }
    if (family === "knowledge_base") {
      return this.executeInlineKnowledgeBase(conversationId, input)
    }
    if (family === "fetch_pull_request") {
      return this.executeInlineFetchPullRequest(input)
    }
    if (family === "create_diagram") {
      return this.executeInlineCreateDiagram(input)
    }
    if (family === "fix_lints") {
      return this.executeInlineFixLints(conversationId, input)
    }
    if (family === "go_to_definition") {
      return this.executeInlineGoToDefinition(conversationId, input)
    }
    if (family === "await_task") {
      return this.executeInlineAwaitTask(input)
    }
    if (family === "read_project") {
      return this.executeInlineReadProject(conversationId, input)
    }
    if (family === "update_project") {
      return this.executeInlineUpdateProject(input)
    }
    if (family === "reflect") {
      return this.executeInlineReflect(input)
    }
    if (family === "start_grind_execution") {
      return this.executeInlineStartGrindExecution(input)
    }
    if (family === "start_grind_planning") {
      return this.executeInlineStartGrindPlanning(input)
    }
    if (family === "setup_vm_environment") {
      return this.executeInlineSetupVmEnvironment(input)
    }
    return {
      content: `[${family} error] unsupported deferred tool family`,
      state: {
        status: "error",
        message: "unsupported deferred tool family",
      },
    }
  }

  private buildSyntheticInlineToolRequest(
    toolCallId: string,
    content: string,
    state: { status: ToolResultStatus; message?: string },
    inlineProjection?: ParsedToolResult["inlineProjection"]
  ): ParsedCursorRequest {
    return {
      conversation: [],
      newMessage: "",
      model: "",
      thinkingLevel: 0,
      unifiedMode: "AGENT",
      isAgentic: true,
      supportedTools: [],
      useWeb: false,
      toolResults: [
        {
          toolCallId,
          toolType: 0,
          resultCase: "inline_tool_result",
          resultData: Buffer.alloc(0),
          inlineContent: content,
          inlineState: state,
          inlineProjection,
        },
      ],
    }
  }

  private async *emitInlineToolResult(
    conversationId: string,
    toolCallId: string,
    content: string,
    state: { status: ToolResultStatus; message?: string },
    inlineProjection?: ParsedToolResult["inlineProjection"]
  ): AsyncGenerator<Buffer> {
    const syntheticRequest = this.buildSyntheticInlineToolRequest(
      toolCallId,
      content,
      state,
      inlineProjection
    )
    yield* this.handleToolResult(conversationId, syntheticRequest)
  }

  private async *failPendingToolCallsWithProtocolError(
    conversationId: string,
    reason: string
  ): AsyncGenerator<Buffer> {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) return

    const pendingIds = Array.from(session.pendingToolCalls.keys())
    if (pendingIds.length === 0) {
      this.logger.error(
        `Protocol error with no pending tool calls to fail: ${reason}`
      )
      return
    }

    this.logger.error(
      `Protocol error, failing ${pendingIds.length} pending tool call(s): ${reason}`
    )
    for (const pendingId of pendingIds) {
      if (!session.pendingToolCalls.has(pendingId)) continue
      yield* this.emitInlineToolResult(
        conversationId,
        pendingId,
        `[protocol error] ${reason}`,
        { status: "error", message: reason }
      )
    }
  }

  private async *handleDeferredToolInteractionResponse(
    conversationId: string,
    payload: Record<string, unknown> | undefined,
    rawResponse: unknown
  ): AsyncGenerator<Buffer, boolean> {
    if (!payload) return false
    if (
      payload.kind !== "inline_web_tool" &&
      payload.kind !== "deferred_tool"
    ) {
      return false
    }

    const toolCallId = this.pickFirstString(payload, ["toolCallId"]) || ""
    const toolName = this.pickFirstString(payload, ["toolName"]) || ""
    const toolInputValue = payload.toolInput
    const toolInput =
      toolInputValue && typeof toolInputValue === "object"
        ? (toolInputValue as Record<string, unknown>)
        : {}
    const family =
      (this.pickFirstString(payload, ["family"]) as DeferredToolFamily) ||
      this.normalizeDeferredToolFamily(toolName)

    if (!toolCallId || !toolName || !family) {
      this.logger.warn(
        `Deferred interaction payload missing metadata: ${JSON.stringify(payload).slice(0, 240)}`
      )
      return true
    }

    const session = this.sessionManager.getSession(conversationId)
    if (!session?.pendingToolCalls.has(toolCallId)) {
      this.logger.warn(
        `Deferred interaction response ignored: pending tool call not found (${toolCallId})`
      )
      return true
    }

    const parsed = this.extractInteractionResultCase(rawResponse)

    if (family === "ask_question") {
      switch (parsed.resultCase) {
        case "success": {
          const answers = this.normalizeAskQuestionProjectionAnswers(
            parsed.resultValue?.answers
          )
          const content =
            answers.length > 0
              ? `[ask_question success] ${JSON.stringify(answers)}`
              : "[ask_question success]"
          yield* this.emitInlineToolResult(
            conversationId,
            toolCallId,
            content,
            {
              status: "success",
            },
            {
              askQuestionResult: {
                resultCase: "success",
                answers,
              },
            }
          )
          return true
        }
        case "async":
          yield* this.emitInlineToolResult(
            conversationId,
            toolCallId,
            "[ask_question async] waiting for async completion",
            { status: "success", message: "async response" },
            {
              askQuestionResult: {
                resultCase: "async",
              },
            }
          )
          return true
        case "rejected": {
          const reason = this.extractInteractionRejectedReason(rawResponse)
          yield* this.emitInlineToolResult(
            conversationId,
            toolCallId,
            `[ask_question rejected] ${reason}`,
            { status: "rejected", message: reason },
            {
              askQuestionResult: {
                resultCase: "rejected",
                reason,
              },
            }
          )
          return true
        }
        default: {
          const message = this.extractInteractionErrorMessage(rawResponse)
          yield* this.emitInlineToolResult(
            conversationId,
            toolCallId,
            `[ask_question error] ${message}`,
            { status: "error", message },
            {
              askQuestionResult: {
                resultCase: "error",
                errorMessage: message,
              },
            }
          )
          return true
        }
      }
    }

    if (family === "create_plan") {
      if (parsed.resultCase === "success") {
        const planUriRaw = (
          rawResponse as {
            result?: { value?: { result?: { planUri?: unknown } } }
          }
        ).result?.value?.result?.planUri
        const planUri =
          typeof planUriRaw === "string" && planUriRaw.trim() !== ""
            ? planUriRaw.trim()
            : ""
        const uriLine = planUri ? `\nplan_uri: ${planUri}` : ""
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          `[create_plan success]${uriLine}`,
          { status: "success" }
        )
      } else {
        const message = this.extractInteractionErrorMessage(rawResponse)
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          `[create_plan error] ${message}`,
          { status: "error", message }
        )
      }
      return true
    }

    if (family === "switch_mode") {
      if (parsed.resultCase === "rejected") {
        const reason = this.extractInteractionRejectedReason(rawResponse)
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          `[switch_mode rejected] ${reason}`,
          { status: "rejected", message: reason }
        )
        return true
      }
      const targetMode =
        this.pickFirstString(toolInput, ["targetModeId", "target_mode_id"]) ||
        "(unchanged)"
      yield* this.emitInlineToolResult(
        conversationId,
        toolCallId,
        `[switch_mode success] target_mode=${targetMode}`,
        { status: "success" }
      )
      return true
    }

    if (family === "setup_vm_environment") {
      if (parsed.resultCase === "success") {
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          "[setup_vm_environment success]",
          { status: "success" }
        )
      } else {
        const message = parsed.resultCase
          ? this.extractInteractionErrorMessage(rawResponse)
          : "setup_vm_environment result missing success state"
        const normalizedMessage = message.trim() || "request failed"
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          `[setup_vm_environment error] ${normalizedMessage}`,
          { status: "error", message: normalizedMessage }
        )
      }
      return true
    }

    if (parsed.resultCase === "rejected") {
      const reason = this.extractInteractionRejectedReason(rawResponse)
      yield* this.emitInlineToolResult(
        conversationId,
        toolCallId,
        `[${family} rejected] ${reason}`,
        { status: "rejected", message: reason }
      )
      return true
    }

    // Sub-agent: use async generator path instead of synchronous executeDeferredTool
    if (family === "task") {
      yield* this.executeSubAgentTask(conversationId, toolCallId, toolInput)
      return true
    }

    const result = await this.executeDeferredTool(
      conversationId,
      family,
      toolName,
      toolInput
    )
    yield* this.emitInlineToolResult(
      conversationId,
      toolCallId,
      result.content,
      result.state
    )
    return true
  }

  private buildInteractionQueryForDeferredTool(
    conversationId: string,
    interactionQueryId: number,
    family: DeferredToolFamily,
    toolCallId: string,
    input: Record<string, unknown>
  ): Buffer | undefined {
    if (family === "web_search") {
      const searchTerm =
        this.pickFirstString(input, ["query", "search_term", "searchTerm"]) ||
        ""
      return this.grpcService.createInteractionQueryResponse(
        interactionQueryId,
        "webSearchRequestQuery",
        {
          args: {
            searchTerm,
            toolCallId,
          },
        }
      )
    }

    if (family === "web_fetch") {
      const url =
        this.pickFirstString(input, [
          "url",
          "Url",
          "document_id",
          "documentId",
        ]) || ""
      return this.grpcService.createInteractionQueryResponse(
        interactionQueryId,
        "webFetchRequestQuery",
        {
          args: {
            url,
            toolCallId,
          },
        }
      )
    }

    if (family === "ask_question") {
      const askQuestionArgs = this.normalizeAskQuestionInteractionArgs(
        input,
        toolCallId
      )
      return this.grpcService.createInteractionQueryResponse(
        interactionQueryId,
        "askQuestionInteractionQuery",
        {
          args: askQuestionArgs,
          toolCallId,
        }
      )
    }

    if (family === "create_plan") {
      const title = this.pickFirstString(input, ["title", "name"]) || ""

      // LLM tool definition sends `steps: string[]`, map to plan text and todos
      const rawSteps = Array.isArray(input.steps) ? input.steps : []
      const stepsStrings = rawSteps
        .map((s: unknown) => (typeof s === "string" ? s.trim() : ""))
        .filter((s: string) => s.length > 0)

      // Build plan text: prefer explicit plan/overview, then compose from steps as markdown
      let plan =
        this.pickFirstString(input, ["plan", "overview"]) ||
        this.pickFirstString(input, ["description"]) ||
        ""
      if (!plan && stepsStrings.length > 0) {
        plan = stepsStrings
          .map((s: string, i: number) => `${i + 1}. ${s}`)
          .join("\n")
      }
      if (!plan) {
        plan = title || "Plan"
      }

      // Build todos: prefer session todos, then convert steps strings
      let todos = this.sessionTodosToCreatePlanTodos(conversationId)
      if (
        (!todos || (Array.isArray(todos) && todos.length === 0)) &&
        stepsStrings.length > 0
      ) {
        const nowTs = Date.now()
        todos = stepsStrings.map((content: string, index: number) => ({
          id: `step_${nowTs}_${index}`,
          content,
          status: 1, // TODO_STATUS_PENDING
          createdAt: BigInt(nowTs),
          updatedAt: BigInt(nowTs),
          dependencies: [],
        }))
      }

      return this.grpcService.createInteractionQueryResponse(
        interactionQueryId,
        "createPlanRequestQuery",
        {
          args: {
            plan,
            todos,
            overview: this.pickFirstString(input, ["overview"]) || "",
            name: title,
            isProject:
              this.pickFirstBoolean(input, ["isProject", "is_project"]) ||
              false,
            phases: this.parsePhasesFromInput(input),
          },
          toolCallId,
        }
      )
    }

    if (family === "switch_mode") {
      return this.grpcService.createInteractionQueryResponse(
        interactionQueryId,
        "switchModeRequestQuery",
        {
          args: {
            targetModeId:
              this.pickFirstString(input, ["targetModeId", "target_mode_id"]) ||
              "",
            explanation:
              this.pickFirstString(input, ["explanation"]) || undefined,
            toolCallId,
          },
        }
      )
    }

    if (family === "exa_search") {
      const query = this.pickFirstString(input, ["query"]) || ""
      return this.grpcService.createInteractionQueryResponse(
        interactionQueryId,
        "exaSearchRequestQuery",
        {
          args: {
            query,
            type: this.pickFirstString(input, ["type"]) || "",
            numResults:
              this.pickFirstNumber(input, ["num_results", "numResults"]) || 5,
            toolCallId,
          },
        }
      )
    }

    if (family === "exa_fetch") {
      const ids = this.pickStringArray(input, ["ids", "id", "urls", "url"])
      return this.grpcService.createInteractionQueryResponse(
        interactionQueryId,
        "exaFetchRequestQuery",
        {
          args: {
            ids,
            toolCallId,
          },
        }
      )
    }

    if (family === "setup_vm_environment") {
      return this.grpcService.createInteractionQueryResponse(
        interactionQueryId,
        "setupVmEnvironmentArgs",
        {
          installCommand:
            this.pickFirstString(input, [
              "installCommand",
              "install_command",
            ]) || "",
          startCommand:
            this.pickFirstString(input, ["startCommand", "start_command"]) ||
            "",
        }
      )
    }

    return undefined
  }

  private shouldUseInteractionQueryForDeferredTool(
    family: DeferredToolFamily
  ): boolean {
    return DEFERRED_INTERACTION_QUERY_FAMILIES.has(family)
  }

  private getUnsupportedDeferredToolMessage(
    family: DeferredToolFamily
  ): string | undefined {
    return UNSUPPORTED_DEFERRED_TOOL_MESSAGES[family]
  }

  private async *runDeferredToolIfNeeded(
    conversationId: string,
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>
  ): AsyncGenerator<Buffer, boolean> {
    const family = this.normalizeDeferredToolFamily(toolName)
    if (!family) {
      return false
    }

    const unsupportedMessage = this.getUnsupportedDeferredToolMessage(family)
    if (unsupportedMessage) {
      yield* this.emitInlineToolResult(
        conversationId,
        toolCallId,
        `[${family} error] ${unsupportedMessage}`,
        { status: "error", message: unsupportedMessage }
      )
      return true
    }

    const rawQuery =
      this.pickFirstString(input, ["query", "search_term", "searchTerm"]) || ""
    const query =
      family === "web_search" || family === "exa_search"
        ? this.normalizeWebSearchQueryForUserIntent(conversationId, rawQuery)
        : rawQuery
    const queryOrPattern =
      this.pickFirstString(input, [
        "query",
        "search_term",
        "searchTerm",
        "pattern",
      ]) || ""
    const url =
      this.pickFirstString(input, [
        "url",
        "Url",
        "document_id",
        "documentId",
      ]) || ""
    const ids = this.pickStringArray(input, ["ids", "id", "urls", "url"])

    if (
      (family === "web_search" ||
        family === "exa_search" ||
        family === "semantic_search" ||
        family === "deep_search" ||
        family === "search_symbols" ||
        family === "knowledge_base") &&
      !query
    ) {
      yield* this.emitInlineToolResult(
        conversationId,
        toolCallId,
        `[${family} error] Missing required query parameter`,
        { status: "error", message: "missing query" }
      )
      return true
    }

    if (
      (family === "file_search" || family === "glob_search") &&
      !queryOrPattern
    ) {
      yield* this.emitInlineToolResult(
        conversationId,
        toolCallId,
        `[${family} error] Missing required query/pattern parameter`,
        { status: "error", message: "missing query/pattern" }
      )
      return true
    }

    if (family === "web_fetch" && !url) {
      yield* this.emitInlineToolResult(
        conversationId,
        toolCallId,
        "[web_fetch error] Missing required url parameter",
        { status: "error", message: "missing url" }
      )
      return true
    }

    if (family === "exa_fetch" && ids.length === 0) {
      yield* this.emitInlineToolResult(
        conversationId,
        toolCallId,
        "[exa_fetch error] Missing required ids parameter",
        { status: "error", message: "missing ids" }
      )
      return true
    }

    if (family === "read_semsearch_files") {
      const paths = this.pickStringArray(input, [
        "file_paths",
        "paths",
        "files",
      ])
      if (paths.length === 0) {
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          "[read_semsearch_files error] Missing required file_paths",
          { status: "error", message: "missing file_paths" }
        )
        return true
      }
    }

    if (family === "go_to_definition") {
      const symbol = this.pickFirstString(input, ["symbol", "query"]) || ""
      if (!symbol) {
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          "[go_to_definition error] Missing required symbol",
          { status: "error", message: "missing symbol" }
        )
        return true
      }
    }

    if (!this.shouldUseInteractionQueryForDeferredTool(family)) {
      const result = await this.executeDeferredTool(
        conversationId,
        family,
        toolName,
        input
      )
      yield* this.emitInlineToolResult(
        conversationId,
        toolCallId,
        result.content,
        result.state
      )
      return true
    }

    const normalizedInput: Record<string, unknown> = {
      ...input,
      ...(family === "web_search" ? { query } : {}),
    }

    const payload = {
      kind: "deferred_tool",
      family,
      toolCallId,
      toolName,
      toolInput: normalizedInput,
    }
    const { id: interactionQueryId } =
      this.sessionManager.registerInteractionQuery(
        conversationId,
        "deferred_tool",
        payload
      )

    const queryMessage = this.buildInteractionQueryForDeferredTool(
      conversationId,
      interactionQueryId,
      family,
      toolCallId,
      normalizedInput
    )
    if (!queryMessage) {
      yield* this.emitInlineToolResult(
        conversationId,
        toolCallId,
        `[${family} error] unsupported deferred interaction query`,
        { status: "error", message: "unsupported deferred interaction query" }
      )
      return true
    }

    yield queryMessage
    return true
  }

  private parseToolInputJson(inputJson: string): Record<string, unknown> {
    if (!inputJson) return {}
    try {
      return JSON.parse(inputJson) as Record<string, unknown>
    } catch (error) {
      this.logger.error(`Failed to parse tool input JSON: ${String(error)}`)
      return {}
    }
  }

  private shouldEmitToolCallStarted(
    _deferredToolFamily: DeferredToolFamily | undefined,
    _canDispatchExec: boolean
  ): boolean {
    // Always emit started updates so Cursor can create the tool bubble before
    // completion updates arrive (deferred tools included).
    return true
  }

  private appendAssistantToolUseMessage(
    conversationId: string,
    toolCall: ActiveToolCall,
    input: Record<string, unknown>,
    accumulatedText: string
  ): void {
    const messageContent: MessageContentItem[] = []
    if (accumulatedText) {
      messageContent.push({
        type: "text",
        text: accumulatedText,
      })
    }
    messageContent.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.name,
      input: input,
    })
    this.sessionManager.addMessage(conversationId, "assistant", messageContent)
  }

  private createPendingToolCheckpointResponse(
    conversationId: string,
    session: ChatSession,
    checkpointModel: string,
    workspaceRootPath: string | undefined,
    toolCall: ActiveToolCall,
    input: Record<string, unknown>
  ): Buffer {
    const checkpointData = {
      messageBlobIds: session.messageBlobIds,
      pendingToolCalls: [
        {
          id: toolCall.id,
          name: toolCall.name,
          input,
        },
      ],
      usedTokens: session.usedTokens,
      maxTokens: this.resolveCheckpointMaxTokens(session),
      workspaceUri: workspaceRootPath
        ? `file://${workspaceRootPath}`
        : undefined,
      readPaths: Array.from(session.readPaths),
      fileStates: Object.fromEntries(session.fileStates),
      turns: session.turns,
      todos: session.todos,
    }

    return this.grpcService.createConversationCheckpointResponse(
      conversationId,
      checkpointModel,
      checkpointData
    )
  }

  private *dispatchExecMessagesForTool(
    conversationId: string,
    session: ChatSession,
    toolCall: ActiveToolCall,
    input: Record<string, unknown>,
    dispatchTarget: ExecDispatchTarget
  ): Generator<Buffer> {
    if (this.isEditToolInvocation(toolCall.name)) {
      const typedInput = input as ToolInputWithPath
      const readExecId = this.sessionManager.nextExecId(conversationId)
      const readExecMsg = this.grpcService.createReadExecMessage(
        toolCall.id,
        String(typedInput.path || ""),
        readExecId
      )
      this.sessionManager.registerPendingToolExecId(
        conversationId,
        toolCall.id,
        readExecId
      )
      yield readExecMsg
      return
    }

    const execIdNumber = this.sessionManager.nextExecId(conversationId)
    const toolCallBuffer = this.grpcService.createAgentToolCallResponse(
      dispatchTarget.toolName,
      toolCall.id,
      dispatchTarget.input,
      execIdNumber
    )
    this.sessionManager.registerPendingToolExecId(
      conversationId,
      toolCall.id,
      execIdNumber
    )
    yield toolCallBuffer
  }

  private async *registerAndDispatchToolInvocation(
    params: ToolInvocationDispatchParams
  ): AsyncGenerator<Buffer, ToolDispatchOutcome> {
    const {
      conversationId,
      session,
      toolCall,
      accumulatedText,
      checkpointModel,
      workspaceRootPath,
    } = params

    const input = this.parseToolInputJson(toolCall.inputJson)

    const deferredToolFamily = this.normalizeDeferredToolFamily(toolCall.name)
    if (deferredToolFamily === "glob_search") {
      this.primeGlobDeferredInputForProtocol(conversationId, input)
    }
    if (deferredToolFamily === "todo_write") {
      this.primeTodoWriteDeferredInputForProtocol(input)
    }
    const execDispatchResolution = this.resolveExecDispatchTarget(
      session,
      toolCall.name,
      input
    )
    const execDispatchTarget = execDispatchResolution.target
    const dispatchErrorMessage = execDispatchResolution.errorMessage
    const canDispatchExec = Boolean(execDispatchTarget)
    const protocolToolName = execDispatchTarget?.toolName || toolCall.name
    const protocolToolInput = execDispatchTarget?.input || input
    const protocolToolFamilyHint = execDispatchTarget?.toolFamilyHint

    await this.sessionManager.addPendingToolCall(
      conversationId,
      toolCall.id,
      protocolToolName,
      protocolToolInput,
      protocolToolFamilyHint,
      toolCall.modelCallId
    )

    const stepId = this.sessionManager.incrementStepId(conversationId)
    yield this.grpcService.createStepStartedResponse(stepId)

    if (this.shouldEmitToolCallStarted(deferredToolFamily, canDispatchExec)) {
      const toolStarted = this.grpcService.createToolCallStartedResponse(
        toolCall.id,
        protocolToolName,
        protocolToolInput,
        protocolToolFamilyHint,
        toolCall.modelCallId
      )
      yield toolStarted
      this.sessionManager.markPendingToolCallStarted(
        conversationId,
        toolCall.id
      )
    }

    if (!deferredToolFamily && canDispatchExec && execDispatchTarget) {
      yield* this.dispatchExecMessagesForTool(
        conversationId,
        session,
        toolCall,
        input,
        execDispatchTarget
      )
    } else if (!deferredToolFamily && !canDispatchExec) {
      this.logger.warn(
        dispatchErrorMessage ||
          `Tool "${toolCall.name}" has no ExecServerMessage mapping; using inline error completion`
      )
    }

    yield this.createPendingToolCheckpointResponse(
      conversationId,
      session,
      checkpointModel,
      workspaceRootPath,
      toolCall,
      input
    )

    this.appendAssistantToolUseMessage(
      conversationId,
      toolCall,
      input,
      accumulatedText
    )

    if (deferredToolFamily) {
      const handledInline = yield* this.runDeferredToolIfNeeded(
        conversationId,
        toolCall.id,
        toolCall.name,
        input
      )
      if (handledInline) {
        return "completed_inline"
      }
    }

    if (!deferredToolFamily && !canDispatchExec) {
      const message =
        dispatchErrorMessage ||
        `tool "${toolCall.name}" is not executable via ExecServerMessage`
      yield* this.emitInlineToolResult(
        conversationId,
        toolCall.id,
        `[tool error] ${message}`,
        { status: "error", message }
      )
      return "completed_inline"
    }

    return "waiting_for_result"
  }

  private *emitToolCompletedAndStep(
    conversationId: string,
    session: ChatSession,
    pendingToolCall: PendingToolCall,
    toolCallId: string,
    toolResultContent: string,
    stepStartTime: number,
    extraData?: ToolCompletedExtraData
  ): Generator<Buffer> {
    if (!pendingToolCall.startedEmitted) {
      this.logger.warn(
        `toolCallStarted missing before completion for ${toolCallId} (${pendingToolCall.toolName}); emitting fallback started`
      )
      const startedFallback = this.grpcService.createToolCallStartedResponse(
        toolCallId,
        pendingToolCall.toolName,
        pendingToolCall.toolInput,
        pendingToolCall.toolFamilyHint,
        pendingToolCall.modelCallId
      )
      yield startedFallback
      pendingToolCall.startedEmitted = true
    }

    const toolCompleted = this.grpcService.createToolCallCompletedResponse(
      toolCallId,
      pendingToolCall.toolName,
      pendingToolCall.toolInput,
      toolResultContent,
      pendingToolCall.toolFamilyHint,
      pendingToolCall.modelCallId,
      extraData
    )
    yield toolCompleted

    const durationMs = Date.now() - stepStartTime
    const stepCompleted = this.grpcService.createStepCompletedResponse(
      session.stepId,
      durationMs
    )
    yield stepCompleted
  }

  /**
   * Handle bidirectional streaming chat
   * This is the main entry point for ConnectRPC streaming
   *
   * Architecture:
   * - Each BiDi stream connection represents ONE conversation session
   * - conversationId is established on the first message and persists for the entire stream
   * - All subsequent messages (including tool results) use this conversationId
   */
  async *handleBidiStream(
    inputMessages: AsyncIterable<Buffer>
  ): AsyncGenerator<Buffer> {
    let conversationId: string | undefined
    let isFirstMessage = true

    try {
      for await (const messageBuffer of inputMessages) {
        this.logger.debug(`Received message: ${messageBuffer.length} bytes`)

        // Parse the protobuf message
        const parsed = cursorRequestParser.parseRequest(messageBuffer)

        if (!parsed) {
          this.logger.warn("Failed to parse message")
          continue
        }

        // Handle Agent control messages (heartbeats, stream close)
        if (parsed.isAgentControlMessage) {
          // Resume/control requests may arrive first on a retried stream.
          // Bind the stream to conversationId early so subsequent tool results can be matched.
          if (!conversationId && parsed.conversationId) {
            conversationId = parsed.conversationId
            this.sessionManager.getOrCreateSession(conversationId, parsed)
            this.logger.log(
              `BiDi control stream attached to conversation: ${conversationId}`
            )
            isFirstMessage = false
          }

          if (conversationId) {
            this.sessionManager.touchSession(conversationId)
          }

          // Respond to heartbeat messages with server heartbeat
          if (
            parsed.agentControlType === "heartbeat" ||
            parsed.agentControlType === "execHeartbeat"
          ) {
            // Log heartbeat only once per minute to avoid spam
            const now = Date.now()
            if (now - this.lastHeartbeatLog > this.HEARTBEAT_LOG_INTERVAL) {
              this.logger.debug("Heartbeat active (logging once per minute)")
              this.lastHeartbeatLog = now
            }
            const serverHeartbeat =
              this.grpcService.createServerHeartbeatResponse()
            yield serverHeartbeat
          } else if (
            (parsed.agentControlType === "execStreamClose" ||
              parsed.agentControlType === "execThrow") &&
            conversationId
          ) {
            const shouldEndStream = yield* this.handleExecClientControlMessage(
              conversationId,
              parsed
            )
            if (shouldEndStream) {
              return
            }
          } else {
            this.logger.debug(
              `Agent control message: ${parsed.agentControlType}`
            )
          }

          // Continue processing other messages
          continue
        }

        // Handle different message types
        // 1. InteractionResponse（客户端回复 InteractionQuery）
        if (parsed.interactionResponse && conversationId) {
          const { id, resultCase, approved, rawResponse } =
            parsed.interactionResponse
          const hasSession = this.sessionManager.touchSession(conversationId)
          this.logger.log(
            `收到 InteractionResponse id=${id} case=${resultCase} approved=${approved}`
          )
          if (!hasSession) {
            this.logger.error(
              `InteractionResponse received for missing session ${conversationId}; ending stream to avoid hanging pending turn`
            )
            return
          }
          const resolvedInteraction =
            this.sessionManager.resolveInteractionQuery(conversationId, id, {
              approved,
              resultCase,
              rawResponse,
            })

          if (!resolvedInteraction) {
            const reason = `unmatched interactionResponse id=${id} case=${resultCase}`
            yield* this.failPendingToolCallsWithProtocolError(
              conversationId,
              reason
            )
            const sessionAfterFailure =
              this.sessionManager.getSession(conversationId)
            const hasPendingAfterFailure =
              sessionAfterFailure?.pendingToolCalls &&
              sessionAfterFailure.pendingToolCalls.size > 0
            if (!hasPendingAfterFailure) {
              return
            }
            continue
          }

          const handledInline =
            yield* this.handleDeferredToolInteractionResponse(
              conversationId,
              resolvedInteraction.payload,
              rawResponse
            )
          if (handledInline) {
            const sessionAfterInline =
              this.sessionManager.getSession(conversationId)
            const hasMorePendingToolCalls =
              sessionAfterInline?.pendingToolCalls &&
              sessionAfterInline.pendingToolCalls.size > 0

            if (!hasMorePendingToolCalls) {
              this.logger.log(
                "No more pending tool calls after inline interaction - ending stream for this turn"
              )
              return
            }
          }
          continue
        }

        // 2. Tool 结果
        if (parsed.toolResults && parsed.toolResults.length > 0) {
          // This is a tool result message
          if (!conversationId) {
            this.logger.error(
              "Received tool result before conversation was established"
            )
            continue
          }

          this.sessionManager.touchSession(conversationId)

          this.logger.log(
            `Received tool result: ${parsed.toolResults[0]!.toolCallId || "(will match by order)"}`
          )
          try {
            yield* this.handleToolResult(conversationId, parsed)
          } catch (error) {
            this.logger.error(
              `Failed to handle tool result without tearing down stream: ${String(error)}`
            )
            continue
          }

          // After handleToolResult, check if we should end the stream
          // If there are no more pending tool calls, the turn is complete
          const sessionAfterTool =
            this.sessionManager.getSession(conversationId)
          const hasMorePendingToolCalls =
            sessionAfterTool?.pendingToolCalls &&
            sessionAfterTool.pendingToolCalls.size > 0

          if (!hasMorePendingToolCalls) {
            // CRITICAL: End the stream after tool result processing completes.
            // handleToolResult already emits checkpoint + turn_ended when it
            // receives a proper message_stop from the backend, or emits a
            // fallback text response when the backend returns empty.
            // We just need to close the BiDi stream loop here.
            this.logger.log(
              "No more pending tool calls after tool result - ending stream for this turn"
            )
            return
          } else {
            this.logger.log(
              `Still waiting for ${sessionAfterTool.pendingToolCalls.size} more tool result(s)`
            )
          }
        } else if (this.isChatTurn(parsed)) {
          // This is a new chat message (text and/or images) or a resume_action turn.
          if (parsed.newMessage) {
            this.logger.log(
              `Received chat message: "${parsed.newMessage.substring(0, 50)}..."`
            )
          } else if (parsed.attachedImages?.length) {
            this.logger.log(
              `Received image-only chat message (${parsed.attachedImages.length} image(s))`
            )
          } else {
            this.logger.log(
              `Received resumeAction: conversationId=${parsed.conversationId || "(none)"}`
            )
          }
          this.logger.log(
            `>>> isAgentic = ${parsed.isAgentic}, unifiedMode = ${parsed.unifiedMode}, model = ${parsed.model}`
          )

          // On first message: establish conversationId for this BiDi stream
          if (isFirstMessage) {
            // Use conversationId from message if present, otherwise generate new one
            conversationId =
              parsed.conversationId || this.generateConversationId()
            this.logger.log(
              `BiDi stream started for conversation: ${conversationId}`
            )

            // CRITICAL: Create session BEFORE sending KV messages
            // This ensures blobIds can be tracked in the session
            this.sessionManager.getOrCreateSession(conversationId, parsed)
            this.logger.log(
              `Session created for conversation: ${conversationId}`
            )

            // Rotate the stream ID so we can detect orphaned tool calls from closed streams
            this.sessionManager.rotateStreamId(conversationId)

            // Agent mode: send initial KV messages only for fresh user-message turns.
            // resume_action carries no new prompt and should not emit synthetic user_query.
            if (parsed.isAgentic && parsed.newMessage) {
              this.logger.log(
                `>>> Agent mode detected, sending initial KV messages`
              )

              // Reset KV counter for new conversation
              this.kvStorageService.resetCounter()

              // Generate trace ID for this conversation
              const traceId = generateTraceId()

              // KV Message 1: System prompt (no ID for first message)
              const systemPrompt = this.buildSystemPrompt(parsed)
              const kvSystemMessage =
                this.kvStorageService.createSetBlobMessage(
                  { type: "system_prompt", content: systemPrompt },
                  traceId,
                  false
                )
              const kvSystemBuffer =
                this.grpcService.createKvServerMessageResponse(kvSystemMessage)
              yield kvSystemBuffer

              // Track blobId for checkpoint
              this.sessionManager.addMessageBlobId(
                conversationId,
                kvSystemMessage.setBlobArgs!.blobId
              )

              // KV Message 2: User info
              const userInfo = {
                type: "user_info",
                workspaceId: parsed.projectContext?.rootPath || "unknown",
              }
              const kvUserMessage = this.kvStorageService.createSetBlobMessage(
                userInfo,
                traceId
              )
              const kvUserBuffer =
                this.grpcService.createKvServerMessageResponse(kvUserMessage)
              yield kvUserBuffer

              // Track blobId for checkpoint
              this.sessionManager.addMessageBlobId(
                conversationId,
                kvUserMessage.setBlobArgs!.blobId
              )

              // KV Message 3: User query
              const userQuery = {
                type: "user_query",
                query: parsed.newMessage,
                timestamp: Date.now(),
              }
              const kvQueryMessage = this.kvStorageService.createSetBlobMessage(
                userQuery,
                traceId
              )
              const kvQueryBuffer =
                this.grpcService.createKvServerMessageResponse(kvQueryMessage)
              yield kvQueryBuffer

              // Track blobId for checkpoint
              this.sessionManager.addMessageBlobId(
                conversationId,
                kvQueryMessage.setBlobArgs!.blobId
              )

              this.logger.log(`>>> Agent mode: sent 3 initial KV messages`)
            }

            // Agent mode: skip stream_start (not needed)
            this.logger.log(`>>> Agent mode: skipping stream_start`)
            isFirstMessage = false
          }

          const sessionBeforeRun = this.sessionManager.getSession(
            conversationId!
          )
          if (parsed.isResumeAction && sessionBeforeRun?.restartRecovery) {
            this.logger.warn(
              `resumeAction hit restored interrupted state for ${conversationId}`
            )
            this.repairInterruptedToolProtocol(
              sessionBeforeRun,
              sessionBeforeRun.restartRecovery
            )
            yield* this.emitAgentFinalTextResponse(
              sessionBeforeRun,
              sessionBeforeRun.restartRecovery.notice
            )
            this.sessionManager.clearRestartRecovery(conversationId!)
            return
          }
          if (
            parsed.isResumeAction &&
            sessionBeforeRun &&
            sessionBeforeRun.pendingToolCalls.size > 0
          ) {
            // Rebind the pending tool calls to the current stream ID, since
            // the tool results will arrive on this new stream.
            const reboundCount =
              this.sessionManager.rebindPendingToolCallsToCurrentStream(
                conversationId!
              )
            if (reboundCount > 0) {
              this.logger.log(
                `resumeAction: rebound ${reboundCount} pending tool call(s) to current stream`
              )
            }
            // Re-check: if there are still pending tool calls on the CURRENT stream, wait
            const stillPending = this.sessionManager.getSession(conversationId!)
            if (stillPending && stillPending.pendingToolCalls.size > 0) {
              this.logger.log(
                `resumeAction attached to stream, waiting for ${stillPending.pendingToolCalls.size} pending tool result(s)`
              )
              continue
            }
            // No pending tool calls remain — fall through to handle as new turn
            this.logger.log(
              `resumeAction: no pending tool calls remain, proceeding as new turn`
            )
          }
          if (sessionBeforeRun && sessionBeforeRun.pendingToolCalls.size > 0) {
            // Stale pending tool calls from a previous (now-closed) BiDi stream.
            // These tool results will NEVER arrive because the old stream is gone.
            // Clear them to avoid a permanent dead-lock where the system waits forever.
            const clearedCount = this.sessionManager.clearStalePendingToolCalls(
              conversationId!
            )
            this.logger.warn(
              `Cleared ${clearedCount} stale pending tool call(s) from previous stream; proceeding with new chat turn`
            )
          }

          // Handle run turn with the established conversationId.
          yield* this.handleChatMessage(conversationId!, parsed)

          // After handleChatMessage, check if there are pending tool calls
          // If there are, continue the loop to wait for tool results
          // If not, END THE STREAM - Cursor expects each turn to be a separate BiDi stream
          const session = this.sessionManager.getSession(conversationId!)
          const hasPendingToolCalls =
            session?.pendingToolCalls && session.pendingToolCalls.size > 0

          if (hasPendingToolCalls) {
            this.logger.log(
              `Waiting for ${session.pendingToolCalls.size} tool result(s)`
            )
          } else {
            // CRITICAL: End the stream after turn completes with no pending tool calls
            // Cursor expects each turn to be a separate BiDi stream request
            // The client will send a new POST /agent.v1.AgentService/Run request
            // with conversationState for the next turn
            this.logger.log(
              "No pending tool calls, turn completed - ending stream for this turn"
            )
            // Exit the loop to allow the stream to close properly
            // This will trigger connectRPCHandler.endStream() which sends the EndStreamResponse
            return
          }
        } else {
          this.logger.warn("Unknown message type")
        }
      }

      this.logger.log(`Stream ended for conversation: ${conversationId}`)
    } catch (error) {
      this.logger.error("Error in bidi stream", error)
      // Don't throw raw error - it may contain circular references (e.g., TLS certificates)
      // Instead, throw a clean error with just the message
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      throw new Error(`BiDi stream failed: ${errorMessage}`)
    }
  }

  /**
   * Handle initial chat message
   * conversationId is now guaranteed to be set by handleBidiStream
   *
   * CRITICAL CHANGE: Real-time tool call sending
   * - Tool calls are sent IMMEDIATELY when detected (content_block_stop)
   * - No batching or waiting for message_stop
   * - Text streaming continues concurrently with tool execution
   */
  private async *handleChatMessage(
    conversationId: string,
    parsed: ParsedCursorRequest
  ): AsyncGenerator<Buffer> {
    // Get or create session with the provided conversationId
    const session = this.sessionManager.getOrCreateSession(
      conversationId,
      parsed
    )

    // Map Cursor model name to backend model name
    const route = this.modelRouter.resolveModel(parsed.model)
    const backendModel = route.model
    this.logger.debug(
      `Mapped Cursor model "${parsed.model}" to backend model "${backendModel}" (backend=${route.backend})`
    )

    // Build message history
    // For multi-turn conversations, use session.messages (which includes history)
    // For first turn, session.messages will be initialized from parsed.conversation
    let rawMessages: Array<{
      role: "user" | "assistant"
      content: MessageContent
    }>
    let usingSessionHistory = false

    if (session.messages.length > 0) {
      usingSessionHistory = true
      // Multi-turn: use session history
      // CRITICAL: Append the new user message from this turn to session history
      // Without this, the new message only exists in parsed.conversation
      // and the model would never see it
      if (parsed.newMessage || parsed.attachedImages?.length) {
        const last = session.messages[session.messages.length - 1]
        const userContent = this.buildUserContentWithImages(
          parsed.newMessage,
          parsed.attachedImages
        )
        if (
          !(
            last?.role === "user" &&
            this.messageContentsEqual(last.content, userContent)
          )
        ) {
          this.sessionManager.addMessage(conversationId, "user", userContent)
          this.logger.debug(
            `Appended new user message to session (${parsed.newMessage.length} chars${parsed.attachedImages?.length ? `, ${parsed.attachedImages.length} image(s)` : ""})`
          )
        } else {
          this.logger.debug(
            "Skipped duplicate tail user message append for this turn"
          )
        }
      }
      rawMessages = session.messages
      this.logger.debug(
        `Using session history: ${rawMessages.length} message(s) from previous turns`
      )
    } else {
      // First turn: use parsed conversation
      rawMessages = parsed.conversation.map((msg, idx) => {
        // For the last user message, attach images if present
        if (
          idx === parsed.conversation.length - 1 &&
          msg.role === "user" &&
          parsed.attachedImages?.length
        ) {
          return {
            role: msg.role,
            content: this.buildUserContentWithImages(
              msg.content,
              parsed.attachedImages
            ),
          }
        }
        return {
          role: msg.role,
          content: msg.content,
        }
      })
      this.logger.debug(
        `First turn: using ${rawMessages.length} message(s) from request`
      )
    }

    const pendingToolUseIds =
      this.sessionManager.getPendingToolCallIds(conversationId)
    rawMessages = this.normalizeHistoryForBackend(
      rawMessages,
      `chat pre-truncation: ${conversationId}`,
      { pendingToolUseIds }
    )
    if (usingSessionHistory) {
      this.sessionManager.replaceMessages(conversationId, rawMessages)
    }

    const useGoogleContextMessages = this.isCloudCodeBackend(route.backend)
    const contextMessages = useGoogleContextMessages
      ? this.buildGoogleContextMessages(parsed, conversationId)
      : []
    const systemPrompt = useGoogleContextMessages
      ? this.buildGoogleSystemPrompt(parsed)
      : this.buildSystemPrompt(parsed)

    // Add tools in strict protocol order:
    // request supportedTools > session supportedTools > empty (no implicit defaults)
    let toolsToUse: string[] = []

    if (parsed.supportedTools && parsed.supportedTools.length > 0) {
      // Use tools from the current request
      toolsToUse = parsed.supportedTools
      this.logger.debug(
        `Using ${toolsToUse.length} tools from client request: ${toolsToUse.join(", ")}`
      )
    } else if (session.supportedTools && session.supportedTools.length > 0) {
      // Use tools from the session (from previous requests)
      toolsToUse = session.supportedTools
      this.logger.debug(
        `Using ${toolsToUse.length} tools from session: ${toolsToUse.join(", ")}`
      )
    } else {
      // Parser should already reconstruct official built-in capability set.
      // Reaching an empty tool list here usually indicates a malformed or
      // unsupported client payload, so keep the list empty and log loudly.
      toolsToUse = []
      this.logger.warn(
        "No supportedTools in request or session after parser capability reconstruction; continuing with empty tool list"
      )
    }

    const mcpToolDefs =
      parsed.mcpToolDefs && parsed.mcpToolDefs.length > 0
        ? parsed.mcpToolDefs
        : session.mcpToolDefs
    const apiTools = buildToolsForApi(toolsToUse, { mcpToolDefs })

    // Apply truncation to stay within token limits
    const budget = this.resolveMessageBudget(route.backend, {
      parsed,
      session,
      contextTokens: contextMessages.length
        ? this.truncator.countTokens(contextMessages as UnifiedMessage[])
        : 0,
      systemPrompt,
      toolDefinitions: apiTools,
    })

    const shouldUseSummaryTruncation =
      !this.hasStructuredToolContent(rawMessages)
    const messages = this.truncateMessagesForBackend(
      conversationId,
      route.backend,
      rawMessages,
      {
        maxTokens: budget.maxTokens,
        systemPromptTokens: budget.systemPromptTokens,
      },
      {
        preferSummary: shouldUseSummaryTruncation,
        contextLabel: `chat pre-send: ${conversationId}`,
        pendingToolUseIds,
      }
    )

    // 场景一：用户直接粘贴超大文本。不要盲目裁剪后继续请求，直接给出明确提示。
    if (this.isCloudCodeBackend(route.backend)) {
      const latestUserText = this.extractLatestUserPlainText(messages)
      if (latestUserText) {
        const latestUserTokens = Math.ceil(latestUserText.length / 4)
        if (latestUserTokens >= this.CLOUD_CODE_SOFT_CONTEXT_LIMIT_TOKENS) {
          this.logger.warn(
            `Plain user input too large for Cloud Code: ~${latestUserTokens} tokens`
          )
          yield* this.emitAgentFinalTextResponse(
            session,
            this.buildUserInputTooLargeMessage(latestUserTokens)
          )
          return
        }
      }
    }

    // Build Anthropic-style DTO
    const dto: CreateMessageDto = {
      model: backendModel,
      messages: [...contextMessages, ...messages],
      system: systemPrompt || undefined,
      max_tokens: budget.maxOutputTokens,
      stream: true,
    }

    dto.tools = apiTools
    dto._conversationId = conversationId
    dto._contextTokenBudget = budget.maxTokens
    if (pendingToolUseIds.length > 0) {
      dto._pendingToolUseIds = pendingToolUseIds
    }
    this.logger.debug(`Added ${dto.tools.length} tool definition(s) to request`)

    // Add thinking if needed
    if (parsed.thinkingLevel > 0) {
      dto.thinking = {
        type: "enabled",
        budget_tokens: this.getCursorThinkingBudget(parsed.thinkingLevel),
      }
    }

    // Call backend API (routed based on model name)
    try {
      const stream = this.getBackendStream(dto)

      // Generate base modelCallId for this conversation turn
      const modelCallBaseId = crypto.randomUUID()
      let toolCallIndex = 0

      // Track accumulated text for history
      let accumulatedText = ""

      // Track current tool call being accumulated
      // 使用会话级 execId（单调递增跨多轮对话）
      let currentToolCall: ActiveToolCall | null = null

      // Track edit content streaming state (for real-time edit UI)
      let editStreamState: {
        markerFound: boolean
        contentStartIdx: number
        lastSentRawLen: number
      } | null = null

      // Track thinking block state
      let isInThinkingBlock = false
      let thinkingStartTime = 0

      let heartbeatCount = 0

      for await (const item of this.streamWithHeartbeat(stream)) {
        // 心跳：保持 Cursor 连接活跃
        if (item.type === "heartbeat") {
          yield this.grpcService.createHeartbeatResponse()
          if (heartbeatCount === 0) {
            yield this.grpcService.createThinkingDeltaResponse("Generating...")
          }
          heartbeatCount++
          continue
        }
        const sseEvent = item.value

        // Parse SSE event (format: "event: type\ndata: {...}\n\n")
        const event = this.parseSseEvent(sseEvent)
        if (!event) continue

        // Convert backend event to Cursor protobuf format
        if (event.type === "content_block_start") {
          const contentBlock = event.data.content_block
          if (
            contentBlock?.type === "tool_use" &&
            contentBlock.id &&
            contentBlock.name
          ) {
            // Start accumulating tool call with unique modelCallId
            const modelCallId = this.generateModelCallId(
              modelCallBaseId,
              toolCallIndex++
            )
            currentToolCall = {
              id: contentBlock.id,
              name: contentBlock.name,
              inputJson: "",
              modelCallId,
            }
            // Initialize edit content streaming for edit tools
            if (this.isEditToolInvocation(currentToolCall.name)) {
              editStreamState = {
                markerFound: false,
                contentStartIdx: 0,
                lastSentRawLen: 0,
              }
            } else {
              editStreamState = null
            }
            this.logger.debug(
              `Tool call started: ${currentToolCall.name} (${currentToolCall.id}) modelCallId: ${modelCallId}`
            )
          } else if (contentBlock?.type === "thinking") {
            // Thinking block started - track state for thinkingCompleted
            isInThinkingBlock = true
            thinkingStartTime = Date.now()
            this.logger.debug("Thinking block started")
          }
        } else if (event.type === "content_block_delta") {
          const delta = event.data.delta
          if (delta?.type === "text_delta" && delta.text) {
            // AgentService/Run: send text delta using AgentServerMessage format
            const textResponse = this.grpcService.createAgentTextResponse(
              delta.text
            )
            yield textResponse

            // Accumulate text for history
            accumulatedText += delta.text

            // Send tokenDelta for Agent mode (estimate tokens from text)
            const { estimateTokenCount } = await import("./agent-helpers")
            const outputTokens = estimateTokenCount(delta.text)
            if (outputTokens > 0) {
              const tokenDelta = this.grpcService.createTokenDeltaResponse(
                0,
                outputTokens
              )
              yield tokenDelta
            }
          } else if (delta?.type === "input_json_delta" && currentToolCall) {
            // Accumulate tool input JSON
            currentToolCall.inputJson += delta.partial_json || ""
            // Do not emit partial tool-call deltas for each JSON chunk.
            // In Cursor plain-text fallback this creates repeated "[Tool: ...]" lines.

            // Real-time edit content streaming: extract new_text field content incrementally
            if (editStreamState && currentToolCall) {
              const json = currentToolCall.inputJson
              if (!editStreamState.markerFound) {
                // Search for the content field marker in accumulated JSON
                for (const key of [
                  '"new_text":"',
                  '"new_text": "',
                  '"file_text":"',
                  '"file_text": "',
                ]) {
                  const idx = json.indexOf(key)
                  if (idx >= 0) {
                    editStreamState.markerFound = true
                    editStreamState.contentStartIdx = idx + key.length
                    this.logger.debug(
                      `Edit stream: found content marker at idx=${editStreamState.contentStartIdx}`
                    )
                    break
                  }
                }
              }
              if (editStreamState.markerFound) {
                const rawContent = json.substring(
                  editStreamState.contentStartIdx
                )
                // Avoid cutting in the middle of an escape sequence
                let safeEnd = rawContent.length
                if (rawContent.endsWith("\\")) safeEnd--
                if (safeEnd > editStreamState.lastSentRawLen) {
                  const newRaw = rawContent.substring(
                    editStreamState.lastSentRawLen,
                    safeEnd
                  )
                  editStreamState.lastSentRawLen = safeEnd
                  // JSON string unescape
                  const unescaped = newRaw
                    .replace(/\\n/g, "\n")
                    .replace(/\\t/g, "\t")
                    .replace(/\\r/g, "\r")
                    .replace(/\\\\/g, "\\")
                    .replace(/\\"/g, '"')
                  if (unescaped) {
                    const toolCallDelta =
                      this.grpcService.createToolCallDeltaResponse(
                        currentToolCall.id,
                        currentToolCall.name,
                        "stream_content",
                        unescaped,
                        currentToolCall.modelCallId
                      )
                    if (toolCallDelta.length > 0) {
                      yield toolCallDelta
                    }
                  }
                }
              }
            }
          } else if (delta?.type === "thinking_delta" && delta.thinking) {
            // Send thinking delta for Agent mode
            const thinkingDelta = this.grpcService.createThinkingDeltaResponse(
              delta.thinking
            )
            yield thinkingDelta
          }
        } else if (event.type === "content_block_stop") {
          // Handle thinking block end
          if (isInThinkingBlock) {
            const thinkingDurationMs = Date.now() - thinkingStartTime
            this.logger.debug(
              `Thinking block ended, duration: ${thinkingDurationMs}ms`
            )
            const thinkingCompleted =
              this.grpcService.createThinkingCompletedResponse(
                thinkingDurationMs
              )
            yield thinkingCompleted
            isInThinkingBlock = false
          }

          if (currentToolCall) {
            this.logger.log(
              `Tool call completed: ${currentToolCall.name}, sending IMMEDIATELY and waiting for result`
            )
            const dispatchOutcome =
              yield* this.registerAndDispatchToolInvocation({
                conversationId: session.conversationId,
                session,
                toolCall: currentToolCall,
                accumulatedText,
                checkpointModel: parsed.model,
                workspaceRootPath: parsed.projectContext?.rootPath,
              })
            if (dispatchOutcome === "waiting_for_result") {
              this.logger.log(`Waiting for tool result: ${currentToolCall.id}`)
            }
            return
          }
        } else if (event.type === "message_stop") {
          // No tool calls - message complete
          // Agent mode: text was already sent in real-time, just send turn_ended signal
          // CRITICAL: Agent mode requires turn_ended signal to complete
          this.logger.log("Agent mode: sending turn_ended signal")

          // CRITICAL: Add text-only message to history
          if (accumulatedText) {
            this.sessionManager.addMessage(
              session.conversationId,
              "assistant",
              accumulatedText
            )
            this.logger.log(
              `Added text message to history (${accumulatedText.length} chars)`
            )
          }

          // CRITICAL: Send conversationCheckpointUpdate before turn_ended
          // This is required for multi-turn conversations to work properly

          // Generate and add new turn ID
          const turnId = this.generateTurnId(
            session.conversationId,
            session.turns.length
          )
          this.sessionManager.addTurn(session.conversationId, turnId)

          const checkpoint =
            this.grpcService.createConversationCheckpointResponse(
              session.conversationId,
              session.model,
              {
                messageBlobIds: session.messageBlobIds,
                usedTokens: session.usedTokens || 0,
                maxTokens: this.resolveCheckpointMaxTokens(session),
                workspaceUri: session.projectContext?.rootPath
                  ? `file://${session.projectContext.rootPath}`
                  : undefined,
                readPaths: Array.from(session.readPaths),
                fileStates: Object.fromEntries(session.fileStates),
                turns: session.turns,
                todos: session.todos,
              }
            )
          yield checkpoint
          this.logger.log("Sent conversationCheckpointUpdate")

          const serverHeartbeat =
            this.grpcService.createServerHeartbeatResponse()
          yield serverHeartbeat
          const turnEnded = this.grpcService.createAgentTurnEndedResponse()
          yield turnEnded

          // After sending turn_ended, return from handleChatMessage
          // The handleBidiStream will check for pending tool calls and end the stream
          // Cursor expects each turn to be a separate BiDi stream request
          this.logger.log(
            "Turn ended, returning to handleBidiStream to close stream"
          )
          return
        }
      }
    } catch (error) {
      const backendLabel = route.backend
      const errorMessage =
        error instanceof Error ? error.message : String(error)

      // Self-healing: detect "No tool output found" 400 errors caused by
      // orphaned tool_use blocks after context truncation. Sanitize the
      // session messages and log a warning instead of crashing.
      if (
        errorMessage.includes("No tool output found for function call") ||
        errorMessage.includes("invalid_request_error")
      ) {
        this.logger.warn(
          `Detected tool protocol error from ${backendLabel} backend, ` +
            `sanitizing session messages for ${conversationId}: ${errorMessage}`
        )
        const session = this.sessionManager.getSession(conversationId)
        if (session) {
          const sanitized = this.toolIntegrity.sanitizeMessages(
            session.messages as UnifiedMessage[],
            {
              pendingToolUseIds: Array.from(session.pendingToolCalls.keys()),
            }
          )
          if (
            sanitized.removedOrphanToolUses > 0 ||
            sanitized.removedOrphanToolResults > 0
          ) {
            this.sessionManager.replaceMessages(
              conversationId,
              sanitized.messages as Array<{
                role: "user" | "assistant"
                content: MessageContent
              }>
            )
            this.logger.warn(
              `Session sanitized: removed ${sanitized.removedOrphanToolUses} orphan tool_use, ` +
                `${sanitized.removedOrphanToolResults} orphan tool_result. ` +
                `Session will be clean for next retry from Cursor.`
            )
          }
        }
      }

      this.logger.error(
        `Error streaming from ${backendLabel} backend (cursorModel=${parsed.model}, backendModel=${backendModel})`,
        error
      )

      // Instead of throwing (which causes Cursor to show generic "Internal Error"),
      // send a friendly error message as assistant text so the user sees what's wrong.
      const friendlyMessage = this.buildBackendErrorMessage(
        backendLabel,
        backendModel,
        errorMessage
      )
      yield this.grpcService.createAgentTextResponse(friendlyMessage)

      // Send heartbeat + turn ended so Cursor renders this as a normal turn
      yield this.grpcService.createServerHeartbeatResponse()
      yield this.grpcService.createAgentTurnEndedResponse()
      return
    }
  }

  /**
   * Handle tool result and continue conversation
   *
   * Real-time feedback loop with backend-aware continuation:
   * - Receive tool result -> immediately add to message history
   * - Continue the model turn as soon as the target backend allows it
   * - Strict backends must wait until the current assistant tool batch is closed
   *
   * Flow:
   * 1. Receive tool result -> format it
   * 2. Remove from pendingToolCalls
   * 3. Immediately add tool_use + tool_result to message history
   * 4. Continue now, or defer until the remaining tool results arrive
   * 5. AI may return more tool calls -> send them immediately
   */

  /**
   * Handle shell_stream events (streaming shell output)
   *
   * ShellStream events come in real-time as the shell command executes:
   *   - start: Command started executing
   *   - stdout: Standard output chunk
   *   - stderr: Standard error chunk
   *   - exit: Command finished with exit code
   *
   * We send real-time UI updates and only complete the tool call on exit.
   */
  private *emitPostToolContinuationError(
    conversationId: string,
    backend: BackendType,
    error: unknown,
    context: {
      toolCallId: string
      toolName: string
      cursorModel: string
      backendModel: string
    }
  ): Generator<Buffer> {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const summary =
      `Tool ${context.toolName} (${context.toolCallId}) completed, ` +
      `but post-tool continuation failed on ${backend} backend: ${errorMessage}`

    this.logger.error(
      `[PostToolContinuation] ${summary} ` +
        `(cursorModel=${context.cursorModel}, backendModel=${context.backendModel})`,
      error instanceof Error ? error.stack : undefined
    )

    if (/rate limit|usage limit|429/i.test(errorMessage)) {
      this.logger.warn(
        `[PostToolContinuation] Backend appears rate-limited; ` +
          `tool execution succeeded but agent continuation could not continue automatically`
      )
    }

    // Send checkpoint before turn_ended (required for rollback consistency).
    // Matches the pattern in handleChatMessage, emitAgentFinalTextResponse,
    // and handleToolResultContinuation to ensure all turn-ending paths
    // produce a valid conversationCheckpointUpdate.
    const session = this.sessionManager.getSession(conversationId)
    if (session) {
      const turnId = this.generateTurnId(conversationId, session.turns.length)
      this.sessionManager.addTurn(conversationId, turnId)

      const checkpoint = this.grpcService.createConversationCheckpointResponse(
        conversationId,
        session.model,
        {
          messageBlobIds: session.messageBlobIds,
          usedTokens: session.usedTokens || 0,
          maxTokens: this.resolveCheckpointMaxTokens(session),
          workspaceUri: session.projectContext?.rootPath
            ? `file://${session.projectContext.rootPath}`
            : undefined,
          readPaths: Array.from(session.readPaths),
          fileStates: Object.fromEntries(session.fileStates),
          turns: session.turns,
          todos: session.todos,
        }
      )
      yield checkpoint
      this.logger.log(
        "Sent conversationCheckpointUpdate (post-tool continuation error)"
      )
    }

    const heartbeat = this.grpcService.createServerHeartbeatResponse()
    yield heartbeat
    const turnEnded = this.grpcService.createAgentTurnEndedResponse()
    yield turnEnded
  }

  private async *handleShellStreamEvent(
    conversationId: string,
    toolCallId: string,
    resultData: Buffer,
    stepStartTime: number
  ): AsyncGenerator<Buffer> {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) {
      this.logger.error(`Session not found for shell stream: ${conversationId}`)
      return
    }

    let shellStream: ShellStream
    try {
      // NOTE: resultData contains the full ExecClientMessage payload, not raw ShellStream bytes.
      const execMsg = fromBinary(ExecClientMessageSchema, resultData)
      if (execMsg.message.case !== "shellStream") {
        this.logger.warn(
          `Expected shellStream message, got ${execMsg.message.case || "empty"}`
        )
        return
      }
      shellStream = execMsg.message.value
    } catch (error) {
      this.logger.error(
        `Failed to decode shell_stream payload: ${String(error)}`
      )
      return
    }
    let eventCase = shellStream.event.case
    let shellResultState: ToolResultStatus | undefined
    let shellResultMessage: string | undefined
    let syntheticExitCode: number | undefined

    // Initialize shell stream tracking if not already done
    if (!this.sessionManager.getShellOutput(conversationId, toolCallId)) {
      this.sessionManager.initShellStream(conversationId, toolCallId)
    }

    // Handle start event
    if (eventCase === "start") {
      this.logger.debug(`Shell stream start for ${toolCallId}`)
      this.sessionManager.markShellStarted(conversationId, toolCallId)
      const startEvent = shellStream.event.value as
        | { sandboxPolicy?: { type?: unknown } }
        | undefined
      const startResponse = this.grpcService.createShellOutputStartResponse(
        startEvent?.sandboxPolicy
      )
      yield startResponse
      return
    }

    // Handle stdout event - send real-time update
    if (eventCase === "stdout") {
      const stdoutEvent = shellStream.event.value as
        | { data?: string }
        | undefined
      const data = stdoutEvent?.data || ""
      if (data) {
        this.logger.debug(
          `Shell stream stdout for ${toolCallId}: ${data.length} chars`
        )
        this.sessionManager.appendShellStdout(conversationId, toolCallId, data)

        // Send real-time UI update
        const stdoutResponse =
          this.grpcService.createShellOutputStdoutResponse(data)
        yield stdoutResponse
      }
      return
    }

    // Handle stderr event - send real-time update
    if (eventCase === "stderr") {
      const stderrEvent = shellStream.event.value as
        | { data?: string }
        | undefined
      const data = stderrEvent?.data || ""
      if (data) {
        this.logger.debug(
          `Shell stream stderr for ${toolCallId}: ${data.length} chars`
        )
        this.sessionManager.appendShellStderr(conversationId, toolCallId, data)

        // Send real-time UI update
        const stderrResponse =
          this.grpcService.createShellOutputStderrResponse(data)
        yield stderrResponse
      }
      return
    }

    // Handle rejected/permission_denied/backgrounded
    if (eventCase === "rejected" || eventCase === "permissionDenied") {
      this.logger.warn(
        `Shell stream rejected/permission denied for ${toolCallId}`
      )
      shellResultState =
        eventCase === "permissionDenied" ? "permission_denied" : "rejected"
      const reasonValue = shellStream.event.value as {
        reason?: string
        error?: string
      }
      const denialMessage =
        reasonValue?.reason ||
        reasonValue?.error ||
        (eventCase === "permissionDenied"
          ? "permission denied"
          : "shell command rejected")
      shellResultMessage = denialMessage
      this.sessionManager.appendShellStderr(
        conversationId,
        toolCallId,
        denialMessage
      )
      yield this.grpcService.createShellOutputStderrResponse(denialMessage)

      // Cursor may not send an explicit exit after rejection. Synthesize one so
      // pending shell tool calls can be completed deterministically.
      // NOTE: Do NOT mutate shellStream.event — use a local flag instead.
      const SHELL_EXIT_CODE_CANNOT_EXECUTE = 126
      syntheticExitCode = SHELL_EXIT_CODE_CANNOT_EXECUTE
      eventCase = "exit"
    }

    if (eventCase === "backgrounded") {
      this.logger.debug(`Shell stream backgrounded for ${toolCallId}`)
      // Don't complete the tool call, it continues in background
      return
    }

    // Handle exit event - NOW we complete the tool call
    if (eventCase === "exit") {
      // Use typed access for real exit events; fall back to synthetic values
      // from the rejection path above.
      let exitCode: number
      let exitCwd: string
      let exitAborted: boolean
      if (shellStream.event.case === "exit") {
        exitCode = syntheticExitCode ?? shellStream.event.value.code
        exitCwd = shellStream.event.value.cwd
        exitAborted = shellStream.event.value.aborted
      } else {
        // Rejection-synthesized exit — shellStream.event still holds the original event
        exitCode = syntheticExitCode ?? 0
        exitCwd = ""
        exitAborted = false
      }
      const signal = "" // ShellStreamExit 没有 signal 字段
      this.logger.log(
        `Shell stream exit for ${toolCallId}: code=${exitCode}, signal=${signal}, cwd=${exitCwd}, aborted=${exitAborted}`
      )
      this.sessionManager.setShellExit(
        conversationId,
        toolCallId,
        exitCode,
        signal || undefined
      )

      // Send exit event to UI
      const exitResponse = this.grpcService.createShellOutputExitResponse(
        exitCode,
        exitAborted,
        exitCwd
      )
      yield exitResponse

      // Get accumulated output
      const shellOutput = this.sessionManager.getShellOutput(
        conversationId,
        toolCallId
      )
      const fullOutput = shellOutput
        ? `${shellOutput.stdout}${shellOutput.stderr ? `\n[stderr]\n${shellOutput.stderr}` : ""}`
        : ""

      // NOW consume the pending tool call and complete it
      const pendingToolCall = this.sessionManager.consumePendingToolCall(
        conversationId,
        toolCallId
      )

      if (!pendingToolCall) {
        this.logger.warn(`No pending tool call found for exit: ${toolCallId}`)
        return
      }

      const rawToolResultContent =
        fullOutput || `Command completed with exit code ${exitCode}`
      const adaptedToolResultContent = this.adaptToolResultForContext(
        pendingToolCall.toolName,
        pendingToolCall.toolInput,
        rawToolResultContent
      )

      yield* this.emitToolCompletedAndStep(
        conversationId,
        session,
        pendingToolCall,
        toolCallId,
        adaptedToolResultContent,
        stepStartTime,
        {
          shellResult: {
            stdout: shellOutput?.stdout || "",
            stderr: shellOutput?.stderr || "",
            exitCode,
          },
          toolResultState: {
            status:
              shellResultState ||
              (exitAborted
                ? "aborted"
                : exitCode === 0
                  ? "success"
                  : "failure"),
            message: shellResultMessage,
          },
        }
      )

      // Add tool result to message history and continue AI
      this.appendToolResultWithIntegrity(
        session,
        toolCallId,
        pendingToolCall.toolName,
        pendingToolCall.toolInput,
        adaptedToolResultContent
      )

      // Continue AI generation
      const route = this.modelRouter.resolveModel(session.model)
      const backendModel = route.model
      const backendLabel = route.backend
      const remainingPendingToolUseIds =
        this.sessionManager.getPendingToolCallIds(conversationId)

      if (
        this.shouldDeferToolBatchContinuation(
          route.backend,
          remainingPendingToolUseIds
        )
      ) {
        this.logger.log(
          `Deferring ${route.backend} shell continuation until ${remainingPendingToolUseIds.length} pending tool result(s) arrive`
        )
        return
      }

      const toolsToUse = session.supportedTools || []
      if (toolsToUse.length === 0) {
        this.logger.warn(
          "Tool-result continuation running with empty supportedTools (strict mode)"
        )
      }

      const apiTools = buildToolsForApi(toolsToUse, {
        mcpToolDefs: session.mcpToolDefs,
      })
      const useGoogleContextMessages = this.isCloudCodeBackend(route.backend)
      const contextMessages = useGoogleContextMessages
        ? this.buildGoogleContextMessages(session, conversationId)
        : []
      const systemPrompt = useGoogleContextMessages
        ? this.buildGoogleSystemPrompt(session)
        : this.buildSystemPrompt(session)
      const budget = this.resolveMessageBudget(route.backend, {
        session,
        contextTokens: contextMessages.length
          ? this.truncator.countTokens(contextMessages as UnifiedMessage[])
          : 0,
        systemPrompt,
        toolDefinitions: apiTools,
      })

      const normalizedShellHistory = this.normalizeHistoryForBackend(
        session.messages as Array<{
          role: "user" | "assistant"
          content: MessageContent
        }>,
        `shell continuation: ${conversationId}`,
        {
          pendingToolUseIds: remainingPendingToolUseIds,
        }
      )
      this.sessionManager.replaceMessages(
        conversationId,
        normalizedShellHistory
      )

      const truncatedShellMessages = this.truncateMessagesForBackend(
        conversationId,
        route.backend,
        normalizedShellHistory,
        {
          maxTokens: budget.maxTokens,
          systemPromptTokens: budget.systemPromptTokens,
        },
        {
          preferSummary: !this.hasStructuredToolContent(normalizedShellHistory),
          contextLabel: `shell continuation: ${conversationId}`,
          pendingToolUseIds: remainingPendingToolUseIds,
        }
      )

      const dto: CreateMessageDto = {
        model: backendModel,
        messages: [...contextMessages, ...truncatedShellMessages],
        system: systemPrompt || undefined,
        max_tokens: budget.maxOutputTokens,
        stream: true,
        tools: apiTools,
      }
      dto._pendingToolUseIds = remainingPendingToolUseIds

      // 续流中保持 thinking 配置（与主流一致）
      if (session.thinkingLevel > 0) {
        dto.thinking = {
          type: "enabled",
          budget_tokens: this.getCursorThinkingBudget(session.thinkingLevel),
        }
      }

      let accumulatedText = ""
      const continuationModelCallBaseId = crypto.randomUUID()
      let continuationToolCallIndex = 0
      // 使用会话级 session.execId（已在 handleChatMessage 中初始化）

      // Track thinking block state
      let isInThinkingBlock = false
      let thinkingStartTime = 0

      let currentToolCall: ActiveToolCall | null = null

      try {
        const stream = this.getBackendStream(dto)

        for await (const sseEvent of stream) {
          const event = this.parseSseEvent(sseEvent)
          if (!event) continue

          if (event.type === "content_block_start") {
            const contentBlock = event.data.content_block
            if (
              contentBlock?.type === "tool_use" &&
              contentBlock.id &&
              contentBlock.name
            ) {
              const modelCallId = this.generateModelCallId(
                continuationModelCallBaseId,
                continuationToolCallIndex++
              )
              currentToolCall = {
                id: contentBlock.id,
                name: contentBlock.name,
                inputJson: "",
                modelCallId,
              }
            } else if (contentBlock?.type === "thinking") {
              // Thinking block started
              isInThinkingBlock = true
              thinkingStartTime = Date.now()
            }
          } else if (event.type === "content_block_delta") {
            const delta = event.data.delta
            if (delta?.type === "text_delta" && delta.text) {
              const textResponse = this.grpcService.createAgentTextResponse(
                delta.text
              )
              yield textResponse
              accumulatedText += delta.text
            } else if (delta?.type === "input_json_delta" && currentToolCall) {
              currentToolCall.inputJson += delta.partial_json || ""
              // Suppress per-chunk partial tool deltas to avoid duplicated tool
              // markers in plain-text fallback UI.
            } else if (delta?.type === "thinking_delta" && delta.thinking) {
              // Send thinking delta
              yield this.grpcService.createThinkingDeltaResponse(delta.thinking)
            }
          } else if (event.type === "content_block_stop") {
            // Handle thinking block end
            if (isInThinkingBlock) {
              const thinkingDurationMs = Date.now() - thinkingStartTime
              yield this.grpcService.createThinkingCompletedResponse(
                thinkingDurationMs
              )
              isInThinkingBlock = false
            }
            if (currentToolCall) {
              const dispatchOutcome =
                yield* this.registerAndDispatchToolInvocation({
                  conversationId,
                  session,
                  toolCall: currentToolCall,
                  accumulatedText,
                  checkpointModel: session.model,
                  workspaceRootPath: session.projectContext?.rootPath,
                })
              if (dispatchOutcome === "waiting_for_result") {
                this.logger.log(
                  `Waiting for tool result: ${currentToolCall.id}`
                )
              }
              return
            }
          } else if (event.type === "message_stop") {
            // AI finished without more tool calls
            if (accumulatedText) {
              this.sessionManager.addMessage(
                session.conversationId,
                "assistant",
                accumulatedText
              )
            }

            // Send turn completion messages（与 handleChatMessage 一致：先 checkpoint 再 turnEnded）
            const checkpointData = {
              messageBlobIds: session.messageBlobIds,
              usedTokens: session.usedTokens,
              maxTokens: this.resolveCheckpointMaxTokens(session),
              workspaceUri: session.projectContext?.rootPath
                ? `file://${session.projectContext.rootPath}`
                : undefined,
              readPaths: Array.from(session.readPaths),
              fileStates: Object.fromEntries(session.fileStates),
              turns: session.turns,
              todos: session.todos,
            }

            const checkpoint =
              this.grpcService.createConversationCheckpointResponse(
                session.conversationId,
                session.model,
                checkpointData
              )
            yield checkpoint

            const heartbeat = this.grpcService.createServerHeartbeatResponse()
            yield heartbeat
            const turnEnded = this.grpcService.createAgentTurnEndedResponse()
            yield turnEnded
          }
        }
      } catch (error) {
        yield* this.emitPostToolContinuationError(
          conversationId,
          backendLabel,
          error,
          {
            toolCallId,
            toolName: pendingToolCall.toolName,
            cursorModel: session.model,
            backendModel,
          }
        )
        return
      }
    }
  }

  private async *handleToolResult(
    conversationId: string,
    parsed: ParsedCursorRequest
  ): AsyncGenerator<Buffer> {
    // Track step timing for stepCompleted message
    const stepStartTime = Date.now()

    const session = this.sessionManager.getSession(conversationId)
    if (!session) {
      this.logger.error(`Session not found: ${conversationId}`)
      return
    }

    if (!parsed.toolResults || parsed.toolResults.length === 0) {
      this.logger.warn("No tool results in parsed request")
      return
    }

    const toolResult = parsed.toolResults[0]!

    const execNumericId = this.normalizePositiveInteger(toolResult.toolType)
    let toolCallId = toolResult.toolCallId

    // Prefer protocol-level id mapping (ExecServerMessage.id -> pending tool call).
    if (
      (!toolCallId || !session.pendingToolCalls.has(toolCallId)) &&
      execNumericId
    ) {
      const mappedToolCallId = this.sessionManager.getPendingToolCallIdByExecId(
        conversationId,
        execNumericId
      )
      if (mappedToolCallId) {
        this.logger.log(
          `Mapped tool result by exec id: execId=${execNumericId} -> toolCallId=${mappedToolCallId}`
        )
        toolCallId = mappedToolCallId
      }
    }

    if (!toolCallId) {
      const reason = `tool result missing toolCallId (execId=${execNumericId || "(none)"})`
      yield* this.failPendingToolCallsWithProtocolError(conversationId, reason)
      return
    }

    if (toolCallId && !session.pendingToolCalls.has(toolCallId)) {
      const reason =
        `tool result referenced non-pending toolCallId=${toolCallId} ` +
        `(execId=${execNumericId || "(none)"})`
      yield* this.failPendingToolCallsWithProtocolError(conversationId, reason)
      return
    }

    this.logger.log(
      `Received tool result: ${toolCallId} (${toolResult.resultCase})`
    )

    // Handle shell_stream events separately (streaming shell output)
    // These events come in real-time and shouldn't consume the pending tool call
    // until the exit event arrives
    if (toolResult.resultCase === "shell_stream") {
      yield* this.handleShellStreamEvent(
        conversationId,
        toolCallId,
        toolResult.resultData,
        stepStartTime
      )
      return
    }

    // CRITICAL: Edit 工具使用串行双消息协议（readArgs → read_result → writeArgs → write_result）
    // read_result 到达时：仅当读取成功且拿到完整内容，才发送 writeArgs。
    // 若 read_result 非 success（或无法提取内容），直接按该 read_result 结束工具调用，避免空内容覆盖写入。
    if (toolResult.resultCase === "read_result") {
      const candidatePending = session.pendingToolCalls.get(toolCallId)
      const isEditPending =
        !!candidatePending &&
        this.isEditToolInvocation(candidatePending.toolName)
      const editPending = isEditPending ? candidatePending : undefined
      if (editPending) {
        let readSuccessContent: string | undefined

        // 从 read_result 中提取文件内容作为 beforeContent
        try {
          const { fromBinary } = await import("@bufbuild/protobuf")
          const { ExecClientMessageSchema } =
            await import("../../gen/agent/v1_pb")
          const execMsg = fromBinary(
            ExecClientMessageSchema,
            toolResult.resultData
          )
          if (
            execMsg.message.case === "readResult" &&
            execMsg.message.value.result.case === "success"
          ) {
            const readOutput = execMsg.message.value.result.value.output
            if (
              readOutput?.case === "content" &&
              typeof readOutput.value === "string"
            ) {
              readSuccessContent = readOutput.value
            } else if (
              readOutput?.case === "data" &&
              readOutput.value instanceof Uint8Array
            ) {
              readSuccessContent = new TextDecoder().decode(readOutput.value)
            }
          }
        } catch (e) {
          this.logger.warn(
            `Failed to extract read_result content: ${String(e)}`
          )
        }

        if (typeof readSuccessContent !== "string") {
          // Check if this is a new-file creation scenario:
          // The file doesn't exist yet, but the agent wants to create it
          // via file_text or replace/new_text content.
          const typedInputCheck = editPending.toolInput as ToolInputWithPath
          const hasFileText = typeof typedInputCheck.file_text === "string"
          const hasNewContent =
            typeof typedInputCheck.replace === "string" ||
            typeof typedInputCheck.new_text === "string"

          if (hasFileText || hasNewContent) {
            // New file creation: treat beforeContent as empty and proceed
            // with writeArgs so the file is actually created on disk.
            this.logger.log(
              `Edit tool ${editPending.toolCallId} read_result failed (new file); proceeding with writeArgs using empty beforeContent`
            )
            readSuccessContent = ""
          } else {
            editPending.editApplyWarning =
              "edit_file read_result did not return readable success content; skipped write step"
            this.logger.warn(
              `Edit tool ${editPending.toolCallId} read_result not usable, skipping writeArgs`
            )
            // Fall through: consume pending tool call and complete this turn with read_result.
          }
        }

        // Send writeArgs if we have usable content (either from successful
        // read or recovered empty content for new-file creation).
        if (typeof readSuccessContent === "string") {
          editPending.beforeContent = readSuccessContent
          this.logger.log(
            `Cached beforeContent from read_result for ${editPending.toolCallId}: ${readSuccessContent.length} chars`
          )

          // 串行协议第二步：发送 writeArgs
          const typedInput = editPending.toolInput as ToolInputWithPath
          const computedEdit = this.applyEditInputToFileText(
            editPending.beforeContent,
            typedInput
          )
          editPending.editApplyWarning = computedEdit.warning
          if (computedEdit.warning) {
            this.logger.warn(
              `Edit apply warning for ${editPending.toolCallId}: ${computedEdit.warning}`
            )
          }
          const writeExecId = this.sessionManager.nextExecId(conversationId)
          const writeExecMsg = this.grpcService.createWriteExecMessage(
            editPending.toolCallId,
            String(typedInput.path || ""),
            computedEdit.fileText,
            writeExecId
          )
          this.sessionManager.registerPendingToolExecId(
            conversationId,
            editPending.toolCallId,
            writeExecId
          )
          this.logger.log(
            `Sending writeArgs for edit tool ${editPending.toolCallId} (串行协议第二步, execId=${writeExecId})`
          )
          yield writeExecMsg
          return
        }
      }
    }

    // Get the pending tool call (this also removes it from pendingToolCalls)
    const pendingToolCall = this.sessionManager.consumePendingToolCall(
      conversationId,
      toolCallId
    )

    if (!pendingToolCall) {
      this.logger.warn(`No pending tool call found for: ${toolCallId}`)
      return
    }

    // Update toolResult with the correct toolCallId
    toolResult.toolCallId = toolCallId

    // Format tool result content
    const rawToolResultContent = this.formatToolResult(toolResult)
    let toolResultContent = this.adaptToolResultForContext(
      pendingToolCall.toolName,
      pendingToolCall.toolInput,
      rawToolResultContent
    )
    const toolResultState = this.deriveToolResultState(toolResult)
    if (pendingToolCall.editApplyWarning) {
      toolResultContent =
        `${toolResultContent}\n\n` +
        `[edit_apply_warning] ${pendingToolCall.editApplyWarning}`
    }

    // CRITICAL: For Agent mode, send real-time feedback before completion
    // Send heartbeat to keep connection alive
    this.logger.debug("Agent mode: sending HeartbeatUpdate")
    const heartbeat = this.grpcService.createHeartbeatResponse()
    yield heartbeat

    // For run_terminal_command, stream the output using ShellOutputDeltaUpdate
    // NOTE: DO NOT send duplicate stdout - only send ShellOutput messages OR ToolCallDelta, not both
    if (
      pendingToolCall.toolName === "run_terminal_command" ||
      pendingToolCall.toolName === "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2"
    ) {
      // Send shell output start
      this.logger.debug(
        `Agent mode: sending ShellOutputStartResponse for ${pendingToolCall.toolName}`
      )
      const startResponse = this.grpcService.createShellOutputStartResponse()
      yield startResponse

      // Stream the output content (stdout) - only via ShellOutput, NOT ToolCallDelta
      if (toolResultContent.length > 0) {
        this.logger.debug(
          `Agent mode: sending ShellOutputStdoutResponse (${toolResultContent.length} chars)`
        )
        const stdoutResponse =
          this.grpcService.createShellOutputStdoutResponse(toolResultContent)
        yield stdoutResponse

        // REMOVED: ToolCallDelta duplicate - stdout is already sent via ShellOutputStdoutResponse
        // The previous code was sending the same content twice, causing repeated UI display
      }

      // Send exit signal (success = code 0)
      this.logger.debug(
        `Agent mode: sending ShellOutputExitResponse for ${pendingToolCall.toolName}`
      )
      const exitResponse = this.grpcService.createShellOutputExitResponse(
        0,
        false
      )
      yield exitResponse
    } else if (this.isEditToolInvocation(pendingToolCall.toolName)) {
      // For edit tools, avoid replaying the full replacement text as a live delta.
      // Cursor can render this as a brand-new unnamed buffer / full-file rewrite.
      // The structured started/completed payloads already carry the file path and
      // before/after content needed for a correct edit preview.
      const toolInput = pendingToolCall.toolInput as ToolInputWithPath
      const streamContent = String(toolInput.replace || "")
      this.logger.debug(
        `Agent mode: suppressing edit stream_content delta for ${pendingToolCall.toolName} ` +
          `(path=${toolInput.path || "(unknown)"}, length=${streamContent.length})`
      )
    } else {
      // For other non-shell tools, skip ToolCallDelta
      this.logger.debug(
        `Agent mode: skipping ToolCallDeltaUpdate for non-shell tool ${pendingToolCall.toolName}`
      )
    }

    // Prepare extra data for edit tools (full file content)
    let extraData: ToolCompletedExtraData | undefined
    if (toolResultState) {
      extraData = { toolResultState }
    }
    if (toolResult.inlineProjection?.askQuestionResult) {
      extraData = {
        ...(extraData || {}),
        askQuestionResult: toolResult.inlineProjection.askQuestionResult,
      }
    }
    if (this.isEditToolInvocation(pendingToolCall.toolName)) {
      try {
        const fs = await import("fs/promises")
        const toolInput = pendingToolCall.toolInput as ToolInputWithPath
        const filePath = toolInput.path
        if (filePath && typeof filePath === "string") {
          // Read the file content after edit
          const afterContent = await fs.readFile(filePath, "utf-8")

          // Use beforeContent captured when tool call was registered
          const beforeContent = pendingToolCall.beforeContent || ""

          extraData = {
            ...(extraData || {}),
            beforeContent,
            afterContent,
          }
          this.logger.debug(
            `Prepared edit diff data: ${filePath} (before=${beforeContent.length}, after=${afterContent.length} bytes)`
          )
          this.logger.debug(
            `Edit preview payload ready: tool=${pendingToolCall.toolName}, path=${filePath}, ` +
              `before=${beforeContent.length}, after=${afterContent.length}, ` +
              `modelCallId=${pendingToolCall.modelCallId || "(none)"}`
          )

          // Track file state in session
          this.sessionManager.addFileState(
            conversationId,
            filePath,
            beforeContent,
            afterContent
          )
        }
      } catch (e) {
        this.logger.warn(
          `Failed to read file for edit result: ${String(e)}; using empty afterContent`
        )
        extraData = {
          ...(extraData || {}),
          beforeContent: pendingToolCall.beforeContent || "",
          afterContent: "",
        }
      }
    } else if (
      pendingToolCall.toolName === "read_file" ||
      pendingToolCall.toolName === "read_file_v2"
    ) {
      // Track read operation
      const toolInput = pendingToolCall.toolInput as ToolInputWithPath
      const filePath = toolInput.path
      if (filePath && typeof filePath === "string") {
        this.sessionManager.addReadPath(conversationId, filePath)
      }
    } else if (
      pendingToolCall.toolName === "run_terminal_command_v2" ||
      pendingToolCall.toolName === "shell" ||
      pendingToolCall.toolName === "run_command"
    ) {
      // Extract ShellResult details for correct UI display
      try {
        if (
          toolResult &&
          toolResult.resultData &&
          toolResult.resultData.length > 0
        ) {
          // 使用生成的 protobuf 类型解析 ShellResult
          const execMsg = fromBinary(
            ExecClientMessageSchema,
            toolResult.resultData
          )
          let stdout = ""
          let stderr = ""
          let shellExitCode = 0

          if (execMsg.message.case === "shellResult") {
            const sr = execMsg.message.value
            if (sr.result.case === "success") {
              stdout = sr.result.value.stdout || ""
              stderr = sr.result.value.stderr || ""
              shellExitCode = sr.result.value.exitCode ?? 0
            } else if (sr.result.case === "failure") {
              stdout = sr.result.value.stdout || ""
              stderr = sr.result.value.stderr || ""
              shellExitCode = sr.result.value.exitCode ?? 1
            }
          }

          extraData = {
            ...(extraData || {}),
            shellResult: {
              stdout: stdout || toolResultContent, // Fallback to content string
              stderr: stderr,
              exitCode: shellExitCode,
            },
          }
        }
      } catch (e) {
        this.logger.error(`Failed to parse shell result: ${String(e)}`)
      }
    }

    // Preserve rich read/ls/grep/delete/diagnostics/list_mcp_resources/read_mcp_resource
    // payloads in ToolCallCompleted
    // instead of reducing to text-only.
    try {
      if (
        toolResult &&
        toolResult.resultData &&
        toolResult.resultData.length > 0
      ) {
        const execMsg = fromBinary(
          ExecClientMessageSchema,
          toolResult.resultData
        )
        if (execMsg.message.case === "readResult") {
          const readResult = execMsg.message.value.result
          if (readResult.case === "success") {
            const output = readResult.value.output
            extraData = {
              ...(extraData || {}),
              readSuccess: {
                path: readResult.value.path,
                content: output?.case === "content" ? output.value : undefined,
                data:
                  output?.case === "data" && output.value instanceof Uint8Array
                    ? output.value
                    : undefined,
                totalLines: readResult.value.totalLines,
                fileSize: readResult.value.fileSize,
                truncated: readResult.value.truncated,
              },
            }
          }
        }
        if (execMsg.message.case === "lsResult") {
          const lsResult = execMsg.message.value.result
          const directoryTreeRoot =
            lsResult.case === "success" || lsResult.case === "timeout"
              ? lsResult.value.directoryTreeRoot
              : undefined
          if (directoryTreeRoot) {
            extraData = {
              ...(extraData || {}),
              lsDirectoryTreeRoot: directoryTreeRoot as unknown as Record<
                string,
                unknown
              >,
            }
          }
        }
        if (execMsg.message.case === "grepResult") {
          const grepResult = execMsg.message.value.result
          if (grepResult.case === "success") {
            const grepSuccessValue = grepResult.value as unknown as Record<
              string,
              unknown
            >
            const toMaybeString = (value: unknown): string | undefined => {
              if (typeof value === "string") return value
              if (
                typeof value === "number" ||
                typeof value === "boolean" ||
                typeof value === "bigint"
              ) {
                return String(value)
              }
              return undefined
            }
            const grepPattern =
              toMaybeString(grepSuccessValue.pattern) ||
              grepResult.value.pattern
            const grepPath =
              toMaybeString(grepSuccessValue.path) || grepResult.value.path
            const grepOutputMode =
              toMaybeString(grepSuccessValue.outputMode) ||
              toMaybeString(grepSuccessValue.output_mode) ||
              grepResult.value.outputMode
            const grepWorkspaceResults = (grepSuccessValue.workspaceResults ??
              grepSuccessValue.workspace_results ??
              grepResult.value.workspaceResults) as unknown as Record<
              string,
              unknown
            >
            const grepActiveEditorResult =
              (grepSuccessValue.activeEditorResult ??
                grepSuccessValue.active_editor_result ??
                grepResult.value.activeEditorResult) as
                | Record<string, unknown>
                | undefined

            extraData = {
              ...(extraData || {}),
              grepSuccess: {
                pattern: grepPattern,
                path: grepPath,
                outputMode: grepOutputMode,
                workspaceResults: grepWorkspaceResults,
                activeEditorResult: grepActiveEditorResult,
              },
            }
          }
        }
        if (execMsg.message.case === "deleteResult") {
          const deleteResult = execMsg.message.value.result
          if (deleteResult.case === "success") {
            extraData = {
              ...(extraData || {}),
              deleteSuccess: {
                path: deleteResult.value.path,
                deletedFile: deleteResult.value.deletedFile,
                fileSize: deleteResult.value.fileSize,
                prevContent: deleteResult.value.prevContent,
              },
            }
          }
        }
        if (execMsg.message.case === "diagnosticsResult") {
          const diagnosticsSuccess = this.extractDiagnosticsSuccessPayload(
            execMsg.message.value.result
          )
          if (diagnosticsSuccess) {
            extraData = {
              ...(extraData || {}),
              diagnosticsSuccess,
            }
          }
        }
        if (execMsg.message.case === "writeShellStdinResult") {
          const writeShellStdinSuccess =
            this.extractWriteShellStdinSuccessPayload(
              execMsg.message.value.result
            )
          if (writeShellStdinSuccess) {
            extraData = {
              ...(extraData || {}),
              writeShellStdinSuccess,
            }
          }
        }
        if (execMsg.message.case === "listMcpResourcesExecResult") {
          const listResult = execMsg.message.value.result
          if (listResult.case === "success") {
            const resources: Array<Record<string, unknown>> = []
            if (Array.isArray(listResult.value.resources)) {
              for (const rawResource of listResult.value.resources) {
                if (!rawResource || typeof rawResource !== "object") continue
                const resource = rawResource as unknown as Record<
                  string,
                  unknown
                >

                const uri = (
                  this.pickFirstString(resource, ["uri"]) || ""
                ).trim()
                if (!uri) continue

                const rawAnnotations =
                  resource.annotations &&
                  typeof resource.annotations === "object"
                    ? (resource.annotations as Record<string, unknown>)
                    : {}
                const annotations: Record<string, string> = {}
                for (const [rawKey, rawValue] of Object.entries(
                  rawAnnotations
                )) {
                  const key = rawKey.trim()
                  if (!key) continue
                  if (typeof rawValue === "string") {
                    annotations[key] = rawValue.trim()
                    continue
                  }
                  if (
                    typeof rawValue === "number" ||
                    typeof rawValue === "boolean" ||
                    typeof rawValue === "bigint"
                  ) {
                    annotations[key] = String(rawValue).trim()
                  }
                }

                const mimeType =
                  this.pickFirstString(resource, ["mimeType", "mime_type"]) ||
                  ""
                resources.push({
                  uri,
                  name: this.pickFirstString(resource, ["name"]) || "",
                  description:
                    this.pickFirstString(resource, ["description"]) || "",
                  mimeType,
                  server: this.pickFirstString(resource, ["server"]) || "",
                  annotations,
                })
              }
            }

            extraData = {
              ...(extraData || {}),
              listMcpResourcesSuccess: {
                resources,
              },
            }
          }
        }
        if (execMsg.message.case === "readMcpResourceExecResult") {
          const readMcpResult = execMsg.message.value.result
          if (readMcpResult.case === "success") {
            const successValue = readMcpResult.value
            const annotations: Record<string, string> = {}
            if (
              successValue.annotations &&
              typeof successValue.annotations === "object"
            ) {
              for (const [rawKey, rawValue] of Object.entries(
                successValue.annotations as Record<string, unknown>
              )) {
                const key = rawKey.trim()
                if (!key) continue
                if (typeof rawValue === "string") {
                  annotations[key] = rawValue.trim()
                  continue
                }
                if (
                  typeof rawValue === "number" ||
                  typeof rawValue === "boolean" ||
                  typeof rawValue === "bigint"
                ) {
                  annotations[key] = String(rawValue).trim()
                }
              }
            }

            extraData = {
              ...(extraData || {}),
              readMcpResourceSuccess: {
                uri: successValue.uri,
                name: successValue.name,
                description: successValue.description,
                mimeType: successValue.mimeType,
                annotations,
                downloadPath: successValue.downloadPath,
                text:
                  successValue.content.case === "text"
                    ? successValue.content.value
                    : undefined,
                blob:
                  successValue.content.case === "blob"
                    ? successValue.content.value
                    : undefined,
              },
            }
          }
        }
      }
    } catch (e) {
      this.logger.debug(
        `Failed to parse read/ls/grep/delete/diagnostics/write_shell_stdin/list_mcp_resources/read_mcp_resource result payload: ${String(e)}`
      )
    }

    // Send ToolCallCompleted + StepCompleted using unified lifecycle projection.
    yield* this.emitToolCompletedAndStep(
      conversationId,
      session,
      pendingToolCall,
      toolCallId,
      toolResultContent,
      stepStartTime,
      extraData
    )

    // CRITICAL: Immediately add tool_result to message history
    // NOTE: The assistant message with tool_use was already added in handleChatMessage
    // We only need to add the user message with tool_result here
    this.logger.log(`Adding tool_result to message history and continuing AI`)

    // Add user message with this single tool result
    this.appendToolResultWithIntegrity(
      session,
      toolCallId,
      pendingToolCall.toolName,
      pendingToolCall.toolInput,
      toolResultContent
    )

    // Continue AI generation immediately for backends that allow partial
    // tool-result continuation. Cloud Code must wait until the current
    // assistant tool batch is fully closed.
    // Map Cursor model name to backend model name
    const route = this.modelRouter.resolveModel(session.model)
    const backendModel = route.model
    const remainingPendingToolUseIds =
      this.sessionManager.getPendingToolCallIds(conversationId)
    this.logger.debug(
      `Mapped Cursor model "${session.model}" to backend model "${backendModel}" for tool result continuation (backend=${route.backend})`
    )

    if (
      this.shouldDeferToolBatchContinuation(
        route.backend,
        remainingPendingToolUseIds
      )
    ) {
      this.logger.log(
        `Deferring ${route.backend} tool continuation until ${remainingPendingToolUseIds.length} pending tool result(s) arrive`
      )
      return
    }

    const toolsForContinuation = session.supportedTools || []
    if (toolsForContinuation.length === 0) {
      this.logger.warn(
        "Continuation generation running with empty supportedTools (strict mode)"
      )
    }

    const continuationTools = buildToolsForApi(toolsForContinuation, {
      mcpToolDefs: session.mcpToolDefs,
    })
    const useGoogleContextMessages = this.isCloudCodeBackend(route.backend)
    const contextMessages = useGoogleContextMessages
      ? this.buildGoogleContextMessages(session, conversationId)
      : []
    const systemPrompt = useGoogleContextMessages
      ? this.buildGoogleSystemPrompt(session)
      : this.buildSystemPrompt(session)
    const budget = this.resolveMessageBudget(route.backend, {
      session,
      contextTokens: contextMessages.length
        ? this.truncator.countTokens(contextMessages as UnifiedMessage[])
        : 0,
      systemPrompt,
      toolDefinitions: continuationTools,
    })

    const normalizedContinuationHistory = this.normalizeHistoryForBackend(
      session.messages as Array<{
        role: "user" | "assistant"
        content: MessageContent
      }>,
      `tool continuation: ${conversationId}`,
      {
        pendingToolUseIds: remainingPendingToolUseIds,
      }
    )
    this.sessionManager.replaceMessages(
      conversationId,
      normalizedContinuationHistory
    )

    const truncatedContinuationMessages = this.truncateMessagesForBackend(
      conversationId,
      route.backend,
      normalizedContinuationHistory,
      {
        maxTokens: budget.maxTokens,
        systemPromptTokens: budget.systemPromptTokens,
      },
      {
        preferSummary: !this.hasStructuredToolContent(
          normalizedContinuationHistory
        ),
        contextLabel: `tool continuation: ${conversationId}`,
        pendingToolUseIds: remainingPendingToolUseIds,
      }
    )

    const dto: CreateMessageDto = {
      model: backendModel,
      messages: [...contextMessages, ...truncatedContinuationMessages],
      system: systemPrompt || undefined,
      max_tokens: budget.maxOutputTokens,
      stream: true,
      tools: continuationTools,
    }
    dto._pendingToolUseIds = remainingPendingToolUseIds

    // 续流中保持 thinking 配置（与主流一致）
    if (session.thinkingLevel > 0) {
      dto.thinking = {
        type: "enabled",
        budget_tokens: this.getCursorThinkingBudget(session.thinkingLevel),
      }
    }

    // Stream the continuation - may include more tool calls (routed based on model)
    const stream = this.getBackendStream(dto)

    // Generate base modelCallId for continuation tool calls
    const continuationModelCallBaseId = crypto.randomUUID()
    let continuationToolCallIndex = 0

    // Track accumulated text for history
    let accumulatedText = ""

    // Track thinking block state
    let isInThinkingBlock = false
    let thinkingStartTime = 0

    // Track edit content streaming state (for real-time edit UI)
    let editStreamState: {
      markerFound: boolean
      contentStartIdx: number
      lastSentRawLen: number
    } | null = null

    // Track tool calls for registration (same as handleChatMessage)
    // 使用会话级 session.execId
    let currentToolCall: ActiveToolCall | null = null

    let heartbeatCount = 0

    for await (const item of this.streamWithHeartbeat(stream)) {
      // 心跳：保持 Cursor 连接活跃
      if (item.type === "heartbeat") {
        yield this.grpcService.createHeartbeatResponse()
        if (heartbeatCount === 0) {
          yield this.grpcService.createThinkingDeltaResponse("Generating...")
        }
        heartbeatCount++
        continue
      }

      const sseEvent = item.value

      const event = this.parseSseEvent(sseEvent)
      if (!event) continue

      if (event.type === "content_block_start") {
        const contentBlock = event.data.content_block
        if (
          contentBlock?.type === "tool_use" &&
          contentBlock.id &&
          contentBlock.name
        ) {
          const modelCallId = this.generateModelCallId(
            continuationModelCallBaseId,
            continuationToolCallIndex++
          )
          currentToolCall = {
            id: contentBlock.id,
            name: contentBlock.name,
            inputJson: "",
            modelCallId,
          }
          // Initialize edit content streaming for edit tools
          if (this.isEditToolInvocation(currentToolCall.name)) {
            editStreamState = {
              markerFound: false,
              contentStartIdx: 0,
              lastSentRawLen: 0,
            }
          } else {
            editStreamState = null
          }
          this.logger.debug(
            `Tool call started: ${currentToolCall.name} (${currentToolCall.id}) modelCallId: ${modelCallId}`
          )
        } else if (contentBlock?.type === "thinking") {
          // Thinking block started
          isInThinkingBlock = true
          thinkingStartTime = Date.now()
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.data.delta
        if (delta?.type === "text_delta" && delta.text) {
          // Agent mode: send text delta immediately for real-time streaming
          const textResponse = this.grpcService.createAgentTextResponse(
            delta.text
          )
          yield textResponse

          // Accumulate text
          accumulatedText += delta.text

          // Send tokenDelta (match handleChatMessage flow)
          const { estimateTokenCount } = await import("./agent-helpers")
          const outputTokens = estimateTokenCount(delta.text)
          if (outputTokens > 0) {
            const tokenDelta = this.grpcService.createTokenDeltaResponse(
              0,
              outputTokens
            )
            yield tokenDelta
          }
        } else if (delta?.type === "input_json_delta" && currentToolCall) {
          currentToolCall.inputJson += delta.partial_json || ""
          // Do not emit per-chunk partial tool deltas. Cursor plain-text
          // fallback can render each delta as duplicated tool text.

          // Real-time edit content streaming: extract new_text field content incrementally
          if (editStreamState && currentToolCall) {
            const json = currentToolCall.inputJson
            if (!editStreamState.markerFound) {
              for (const key of [
                '"new_text":"',
                '"new_text": "',
                '"file_text":"',
                '"file_text": "',
              ]) {
                const idx = json.indexOf(key)
                if (idx >= 0) {
                  editStreamState.markerFound = true
                  editStreamState.contentStartIdx = idx + key.length
                  this.logger.debug(
                    `Edit stream (continuation): found content marker at idx=${editStreamState.contentStartIdx}`
                  )
                  break
                }
              }
            }
            if (editStreamState.markerFound) {
              const rawContent = json.substring(editStreamState.contentStartIdx)
              let safeEnd = rawContent.length
              if (rawContent.endsWith("\\")) safeEnd--
              if (safeEnd > editStreamState.lastSentRawLen) {
                const newRaw = rawContent.substring(
                  editStreamState.lastSentRawLen,
                  safeEnd
                )
                editStreamState.lastSentRawLen = safeEnd
                const unescaped = newRaw
                  .replace(/\\n/g, "\n")
                  .replace(/\\t/g, "\t")
                  .replace(/\\r/g, "\r")
                  .replace(/\\\\/g, "\\")
                  .replace(/\\"/g, '"')
                if (unescaped) {
                  const toolCallDelta =
                    this.grpcService.createToolCallDeltaResponse(
                      currentToolCall.id,
                      currentToolCall.name,
                      "stream_content",
                      unescaped,
                      currentToolCall.modelCallId
                    )
                  if (toolCallDelta.length > 0) {
                    yield toolCallDelta
                  }
                }
              }
            }
          }
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          // Send thinking delta
          yield this.grpcService.createThinkingDeltaResponse(delta.thinking)
        }
      } else if (event.type === "content_block_stop") {
        // Handle thinking block end
        if (isInThinkingBlock) {
          const thinkingDurationMs = Date.now() - thinkingStartTime
          yield this.grpcService.createThinkingCompletedResponse(
            thinkingDurationMs
          )
          isInThinkingBlock = false
        }
        if (currentToolCall) {
          this.logger.log(
            `Tool call completed: ${currentToolCall.name}, sending IMMEDIATELY and waiting for result`
          )
          const dispatchOutcome = yield* this.registerAndDispatchToolInvocation(
            {
              conversationId,
              session,
              toolCall: currentToolCall,
              accumulatedText,
              checkpointModel: session.model,
              workspaceRootPath: session.projectContext?.rootPath,
            }
          )
          if (dispatchOutcome === "waiting_for_result") {
            this.logger.log(`Waiting for tool result: ${currentToolCall.id}`)
          }
          return
        }
      } else if (event.type === "message_stop") {
        // No tool calls - conversation complete
        // Agent mode: send turn_ended signal (text was already sent in real-time)
        this.logger.log(
          "Agent mode: no more tool calls, sending turn_ended signal"
        )

        yield* this.finalizeAssistantContinuationTurn(
          session,
          conversationId,
          accumulatedText || undefined
        )
        this.logger.log("Sent conversationCheckpointUpdate (continuation)")
        return
      }
    }

    // ─── Empty stream detection & retry ───────────────────────────────
    // If we reach here, the for-await loop exited without hitting
    // message_stop or dispatching a tool call. This means the backend
    // returned an empty stream (0 blocks, no text, no tool calls).
    // This is abnormal — a well-behaved AI should always produce output.
    //
    // Protocol requirement: Cursor expects every turn to end with either
    // a tool dispatch (waiting_for_result) or a turn_ended signal with
    // text content. An empty stream exit violates this contract and
    // causes Cursor to open a new chat window via resumeAction.
    //
    // Strategy: retry the continuation request once. If still empty,
    // emit a fallback text response to maintain protocol integrity.

    if (!accumulatedText && !currentToolCall) {
      this.logger.warn(
        `[Empty Stream] Continuation returned empty response for ${conversationId}; retrying once`
      )

      // Retry: rebuild and resend the same continuation request
      try {
        const retryStream = this.getBackendStream(dto)
        let retryAccumulatedText = ""
        let retryHasToolCall = false
        const retryModelCallBaseId = crypto.randomUUID()
        let retryToolCallIndex = 0
        let retryCurrentToolCall: ActiveToolCall | null = null
        let retryIsInThinkingBlock = false
        let retryThinkingStartTime = 0
        let retryHeartbeatCount = 0

        for await (const retryItem of this.streamWithHeartbeat(retryStream)) {
          if (retryItem.type === "heartbeat") {
            yield this.grpcService.createHeartbeatResponse()
            if (retryHeartbeatCount === 0) {
              yield this.grpcService.createThinkingDeltaResponse(
                "Generating..."
              )
            }
            retryHeartbeatCount++
            continue
          }

          const retrySseEvent = retryItem.value
          const retryEvent = this.parseSseEvent(retrySseEvent)
          if (!retryEvent) continue

          if (retryEvent.type === "content_block_start") {
            const contentBlock = retryEvent.data.content_block
            if (
              contentBlock?.type === "tool_use" &&
              contentBlock.id &&
              contentBlock.name
            ) {
              const modelCallId = this.generateModelCallId(
                retryModelCallBaseId,
                retryToolCallIndex++
              )
              retryCurrentToolCall = {
                id: contentBlock.id,
                name: contentBlock.name,
                inputJson: "",
                modelCallId,
              }
              retryHasToolCall = true
            } else if (contentBlock?.type === "thinking") {
              retryIsInThinkingBlock = true
              retryThinkingStartTime = Date.now()
            }
          } else if (retryEvent.type === "content_block_delta") {
            const delta = retryEvent.data.delta
            if (delta?.type === "text_delta" && delta.text) {
              const textResponse = this.grpcService.createAgentTextResponse(
                delta.text
              )
              yield textResponse
              retryAccumulatedText += delta.text

              const { estimateTokenCount } = await import("./agent-helpers")
              const outputTokens = estimateTokenCount(delta.text)
              if (outputTokens > 0) {
                yield this.grpcService.createTokenDeltaResponse(0, outputTokens)
              }
            } else if (
              delta?.type === "input_json_delta" &&
              retryCurrentToolCall
            ) {
              retryCurrentToolCall.inputJson += delta.partial_json || ""
            } else if (delta?.type === "thinking_delta" && delta.thinking) {
              yield this.grpcService.createThinkingDeltaResponse(delta.thinking)
            }
          } else if (retryEvent.type === "content_block_stop") {
            if (retryIsInThinkingBlock) {
              const thinkingDurationMs = Date.now() - retryThinkingStartTime
              yield this.grpcService.createThinkingCompletedResponse(
                thinkingDurationMs
              )
              retryIsInThinkingBlock = false
            }
            if (retryCurrentToolCall) {
              this.logger.log(
                `[Retry] Tool call completed: ${retryCurrentToolCall.name}, dispatching`
              )
              const dispatchOutcome =
                yield* this.registerAndDispatchToolInvocation({
                  conversationId,
                  session,
                  toolCall: retryCurrentToolCall,
                  accumulatedText: retryAccumulatedText,
                  checkpointModel: session.model,
                  workspaceRootPath: session.projectContext?.rootPath,
                })
              if (dispatchOutcome === "waiting_for_result") {
                this.logger.log(
                  `[Retry] Waiting for tool result: ${retryCurrentToolCall.id}`
                )
              }
              return
            }
          } else if (retryEvent.type === "message_stop") {
            this.logger.log(
              "[Retry] message_stop received, ending continuation"
            )
            yield* this.finalizeAssistantContinuationTurn(
              session,
              conversationId,
              retryAccumulatedText || undefined
            )
            return
          }
        }

        // Retry also produced output — check if it was meaningful
        if (retryAccumulatedText || retryHasToolCall) {
          if (retryHasToolCall) {
            this.logger.warn(
              `[Retry] Stream exited after tool-call output without message_stop for ${conversationId}; awaiting tool result path`
            )
            return
          }

          this.logger.warn(
            `[Retry] Stream exited after text output without message_stop for ${conversationId}; finalizing turn defensively`
          )
          yield* this.finalizeAssistantContinuationTurn(
            session,
            conversationId,
            retryAccumulatedText || undefined
          )
          return
        }
      } catch (retryError) {
        this.logger.warn(`[Empty Stream] Retry failed: ${String(retryError)}`)
      }

      // Both attempts returned empty — emit fallback text to maintain
      // protocol integrity. Without this, Cursor receives no assistant
      // output and opens a new chat window.
      this.logger.warn(
        `[Empty Stream] Both attempts returned empty for ${conversationId}; emitting fallback text response`
      )
      yield* this.emitAgentFinalTextResponse(
        session,
        "I'll continue from here. What would you like me to do next?"
      )
      return
    }
  }

  /**
   * Parse SSE event string
   */
  private parseSseEvent(sseEvent: string): SseEvent | null {
    try {
      // SSE format: "event: type\ndata: {...}\n\n"
      const lines = sseEvent.split("\n")
      let eventType = ""
      let eventData = ""

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.substring(7).trim()
        } else if (line.startsWith("data: ")) {
          eventData = line.substring(6).trim()
        }
      }

      if (!eventType || !eventData) {
        return null
      }

      return {
        type: eventType,
        data: JSON.parse(eventData) as SseEventData,
      }
    } catch (error) {
      this.logger.warn(`Failed to parse SSE event: ${String(error)}`)
      return null
    }
  }

  /**
   * 格式化 tool result（使用生成的 protobuf 类型解析）
   *
   * 通过 fromBinary(ExecClientMessageSchema) 解析 buffer，
   * 再根据 message.case 分发到各个类型化结果处理分支。
   */
  private deriveStatusFromGenericResult(result: unknown):
    | {
        status: ToolResultStatus
        message?: string
      }
    | undefined {
    if (!result || typeof result !== "object") return undefined

    const resultOneOf = result as {
      case?: unknown
      value?: Record<string, unknown>
    }
    if (typeof resultOneOf.case !== "string") return undefined

    const resultCase = resultOneOf.case
    const value = resultOneOf.value || {}
    const messageCandidates = [
      value.reason,
      value.error,
      value.errorMessage,
      value.message,
    ]
    let message: string | undefined
    for (const candidate of messageCandidates) {
      if (typeof candidate === "string" && candidate.trim() !== "") {
        message = candidate.trim()
        break
      }
    }

    switch (resultCase) {
      case "success":
      case "approved":
      case "startSuccess":
      case "backgrounded":
        return { status: "success", message }
      case "failure":
        return { status: "failure", message }
      case "error":
      case "fileBusy":
      case "noSpace":
        return { status: "error", message }
      case "timeout":
        return { status: "timeout", message }
      case "rejected":
        return { status: "rejected", message }
      case "permissionDenied":
        return { status: "permission_denied", message }
      case "spawnError":
        return { status: "spawn_error", message }
      case "fileNotFound":
      case "notFound":
        return { status: "file_not_found", message }
      case "invalidFile":
      case "notFile":
        return { status: "invalid_file", message }
      default:
        return undefined
    }
  }

  private extractDiagnosticsSuccessPayload(
    diagnosticsResult: unknown
  ): ToolCompletedExtraData["diagnosticsSuccess"] | undefined {
    if (!diagnosticsResult || typeof diagnosticsResult !== "object") {
      return undefined
    }
    const resultOneOf = diagnosticsResult as {
      case?: unknown
      value?: unknown
    }
    if (resultOneOf.case !== "success") {
      return undefined
    }
    if (!resultOneOf.value || typeof resultOneOf.value !== "object") {
      return undefined
    }

    const value = resultOneOf.value as Record<string, unknown>
    const diagnostics = Array.isArray(value.diagnostics)
      ? value.diagnostics
          .filter(
            (entry): entry is Record<string, unknown> =>
              Boolean(entry) && typeof entry === "object"
          )
          .map((entry) => ({ ...entry }))
      : []
    const totalDiagnosticsRaw =
      value.totalDiagnostics ?? value.total_diagnostics
    const totalDiagnostics =
      typeof totalDiagnosticsRaw === "number" &&
      Number.isFinite(totalDiagnosticsRaw) &&
      totalDiagnosticsRaw >= 0
        ? Math.floor(totalDiagnosticsRaw)
        : diagnostics.length
    const path =
      typeof value.path === "string" && value.path.trim() !== ""
        ? value.path
        : undefined

    return {
      path,
      diagnostics,
      totalDiagnostics,
    }
  }

  private extractWriteShellStdinSuccessPayload(
    writeShellStdinResult: unknown
  ): ToolCompletedExtraData["writeShellStdinSuccess"] | undefined {
    if (!writeShellStdinResult || typeof writeShellStdinResult !== "object") {
      return undefined
    }
    const resultOneOf = writeShellStdinResult as {
      case?: unknown
      value?: unknown
    }
    if (resultOneOf.case !== "success") {
      return undefined
    }
    if (!resultOneOf.value || typeof resultOneOf.value !== "object") {
      return undefined
    }

    const value = resultOneOf.value as Record<string, unknown>
    const toUint32 = (raw: unknown): number => {
      const numeric = Number(raw)
      if (!Number.isFinite(numeric) || numeric < 0) {
        return 0
      }
      return Math.floor(numeric)
    }

    return {
      shellId: toUint32(value.shellId ?? value.shell_id),
      terminalFileLengthBeforeInputWritten: toUint32(
        value.terminalFileLengthBeforeInputWritten ??
          value.terminal_file_length_before_input_written
      ),
    }
  }

  private stringifyResultValue(
    value: unknown,
    maxChars: number = 3200
  ): string {
    if (typeof value === "string") {
      return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value
    }
    try {
      const raw = JSON.stringify(value)
      if (!raw) return ""
      return raw.length > maxChars ? `${raw.slice(0, maxChars)}...` : raw
    } catch {
      return ""
    }
  }

  private formatGenericExecResult(
    msgCase: string,
    payload: unknown
  ): string | undefined {
    if (!payload || typeof payload !== "object") return undefined

    const result = (payload as { result?: unknown }).result
    if (!result || typeof result !== "object") return undefined

    const resultOneOf = result as {
      case?: unknown
      value?: Record<string, unknown>
    }
    if (typeof resultOneOf.case !== "string") return undefined

    const resultCase = resultOneOf.case
    const value = resultOneOf.value || {}

    if (
      resultCase === "success" ||
      resultCase === "approved" ||
      resultCase === "startSuccess"
    ) {
      const contentOneOf =
        value.content &&
        typeof value.content === "object" &&
        !Array.isArray(value.content)
          ? (value.content as { case?: unknown; value?: unknown })
          : undefined
      if (
        contentOneOf?.case === "text" &&
        typeof contentOneOf.value === "string" &&
        contentOneOf.value.trim() !== ""
      ) {
        return contentOneOf.value
      }
      if (
        contentOneOf?.case === "blob" &&
        contentOneOf.value instanceof Uint8Array
      ) {
        return `[binary content] ${contentOneOf.value.length} bytes`
      }

      const textFields = [
        value.markdown,
        value.text,
        value.stdout,
        value.output,
      ]
      for (const field of textFields) {
        if (typeof field === "string" && field.trim() !== "") {
          return field
        }
      }

      const structuredFields = [
        value.content,
        value.resources,
        value.fileDiagnostics,
        value.references,
        value.contents,
        value.results,
        value.conversationSteps,
        value.answers,
        value.todos,
      ]
      for (const field of structuredFields) {
        if (field !== undefined) {
          const serialized = this.stringifyResultValue(field)
          if (serialized) return serialized
        }
      }

      return `[${msgCase}] success`
    }

    if (resultCase === "rejected") {
      const reason =
        typeof value.reason === "string" && value.reason.trim() !== ""
          ? value.reason.trim()
          : "request rejected"
      return `[${msgCase} rejected] ${reason}`
    }

    if (resultCase === "timeout") {
      return `[${msgCase} timeout]`
    }

    if (resultCase === "permissionDenied") {
      return "[permission denied]"
    }

    if (resultCase === "spawnError") {
      const err =
        typeof value.error === "string" && value.error.trim() !== ""
          ? value.error.trim()
          : "failed to spawn process"
      return `[spawn error] ${err}`
    }

    if (resultCase === "fileNotFound" || resultCase === "notFound") {
      const path =
        typeof value.path === "string" && value.path.trim() !== ""
          ? value.path.trim()
          : typeof value.uri === "string" && value.uri.trim() !== ""
            ? value.uri.trim()
            : ""
      return `[file not found] ${path}`.trim()
    }

    if (
      resultCase === "error" ||
      resultCase === "failure" ||
      resultCase === "noSpace" ||
      resultCase === "fileBusy"
    ) {
      const errorMessageCandidates = [
        value.error,
        value.errorMessage,
        value.message,
      ]
      for (const candidate of errorMessageCandidates) {
        if (typeof candidate === "string" && candidate.trim() !== "") {
          return `[${msgCase} error] ${candidate.trim()}`
        }
      }
      const serialized = this.stringifyResultValue(value)
      return serialized
        ? `[${msgCase} ${resultCase}] ${serialized}`
        : `[${msgCase}] ${resultCase}`
    }

    const serialized = this.stringifyResultValue(value)
    if (serialized) {
      return `[${msgCase} ${resultCase}] ${serialized}`
    }
    return `[${msgCase}] ${resultCase}`
  }

  private deriveToolResultStateFromBuffer(
    resultData: Buffer
  ): { status: ToolResultStatus; message?: string } | undefined {
    if (!resultData || resultData.length === 0) return undefined

    try {
      const execMsg = fromBinary(ExecClientMessageSchema, resultData)
      const msgCase = execMsg.message.case
      if (!msgCase) return undefined

      if (msgCase === "shellResult") {
        const shellCase = execMsg.message.value.result.case
        switch (shellCase) {
          case "success":
            return { status: "success" }
          case "failure":
            return { status: "failure" }
          case "timeout":
            return { status: "timeout" }
          case "rejected":
            return { status: "rejected" }
          case "spawnError":
            return { status: "spawn_error" }
          case "permissionDenied":
            return { status: "permission_denied" }
          default:
            return undefined
        }
      }

      if (msgCase === "shellStream") {
        const eventCase = execMsg.message.value.event.case
        switch (eventCase) {
          case "rejected":
            return { status: "rejected" }
          case "permissionDenied":
            return { status: "permission_denied" }
          case "exit": {
            const code = execMsg.message.value.event.value.code ?? 0
            return { status: code === 0 ? "success" : "failure" }
          }
          default:
            return undefined
        }
      }

      if (msgCase === "readResult") {
        const readCase = execMsg.message.value.result.case
        switch (readCase) {
          case "success":
            return { status: "success" }
          case "rejected":
            return { status: "rejected" }
          case "fileNotFound":
            return { status: "file_not_found" }
          case "permissionDenied":
            return { status: "permission_denied" }
          case "invalidFile":
            return { status: "invalid_file" }
          case "error":
            return { status: "error" }
          default:
            return undefined
        }
      }

      if (msgCase === "writeResult") {
        const writeCase = execMsg.message.value.result.case
        switch (writeCase) {
          case "success":
            return { status: "success" }
          case "rejected":
            return { status: "rejected" }
          case "permissionDenied":
            return { status: "permission_denied" }
          case "noSpace":
          case "error":
            return { status: "error" }
          default:
            return undefined
        }
      }

      if (msgCase === "deleteResult") {
        const deleteCase = execMsg.message.value.result.case
        switch (deleteCase) {
          case "success":
            return { status: "success" }
          case "rejected":
            return { status: "rejected" }
          case "fileNotFound":
            return { status: "file_not_found" }
          case "permissionDenied":
            return { status: "permission_denied" }
          case "notFile":
            return { status: "invalid_file" }
          case "fileBusy":
            return { status: "file_busy" }
          case "error":
            return { status: "error" }
          default:
            return undefined
        }
      }

      if (msgCase === "lsResult") {
        const lsCase = execMsg.message.value.result.case
        switch (lsCase) {
          case "success":
            return { status: "success" }
          case "rejected":
            return { status: "rejected" }
          case "timeout":
            return { status: "timeout" }
          case "error":
            return { status: "error" }
          default:
            return undefined
        }
      }

      if (msgCase === "grepResult") {
        const grepCase = execMsg.message.value.result.case
        if (grepCase === "success") return { status: "success" }
        if (grepCase === "error") return { status: "error" }
      }

      const genericStatus = this.deriveStatusFromGenericResult(
        (execMsg.message.value as { result?: unknown }).result
      )
      if (genericStatus) {
        return genericStatus
      }
    } catch (error) {
      this.logger.debug(
        `Failed to derive tool result state from buffer: ${String(error)}`
      )
    }

    return undefined
  }

  private deriveToolResultState(
    toolResult: ParsedToolResult
  ): { status: ToolResultStatus; message?: string } | undefined {
    if (toolResult.inlineState) {
      return toolResult.inlineState
    }
    return this.deriveToolResultStateFromBuffer(toolResult.resultData)
  }

  private formatToolResult(toolResult: ParsedToolResult): string {
    if (typeof toolResult.inlineContent === "string") {
      return toolResult.inlineContent
    }

    if (!toolResult.resultData || toolResult.resultData.length === 0) {
      return `Tool execution completed: ${toolResult.resultCase}`
    }

    try {
      const resultCase = toolResult.resultCase
      this.logger.debug(
        `[FORMAT_TOOL_RESULT] resultCase: ${resultCase}, buffer size: ${toolResult.resultData.length} bytes`
      )

      // 解析 ExecClientMessage
      const execMsg = fromBinary(ExecClientMessageSchema, toolResult.resultData)
      const msgCase = execMsg.message.case

      if (!msgCase) {
        this.logger.warn(`ExecClientMessage.message.case 未设置，回退文本`)
        return toolResult.resultData.toString("utf-8")
      }

      // ──── Shell Result ────
      if (msgCase === "shellResult") {
        return this.formatShellResultTyped(execMsg.message.value)
      }

      // ──── Shell Stream ────
      if (msgCase === "shellStream") {
        return this.formatShellStreamTyped(execMsg.message.value)
      }

      // ──── Read Result ────
      if (msgCase === "readResult") {
        return this.formatReadResultTyped(execMsg.message.value)
      }

      // ──── Write Result ────
      if (msgCase === "writeResult") {
        return this.formatWriteResultTyped(execMsg.message.value)
      }

      // ──── Delete Result ────
      if (msgCase === "deleteResult") {
        return this.formatDeleteResultTyped(execMsg.message.value)
      }

      // ──── Ls Result ────
      if (msgCase === "lsResult") {
        return this.formatLsResultTyped(execMsg.message.value)
      }

      // ──── Grep Result ────
      if (msgCase === "grepResult") {
        return this.formatGrepResultTyped(execMsg.message.value)
      }

      // ──── Diagnostics Result ────
      if (msgCase === "diagnosticsResult") {
        return this.formatDiagnosticsResultTyped(execMsg.message.value)
      }

      // ──── Background Shell Spawn Result ────
      if (msgCase === "backgroundShellSpawnResult") {
        return this.formatBgShellSpawnTyped(execMsg.message.value)
      }

      const generic = this.formatGenericExecResult(
        msgCase,
        execMsg.message.value
      )
      if (generic) {
        return generic
      }

      this.logger.debug(`未特殊处理的 result case: ${msgCase}`)
      return `Tool execution completed: ${resultCase}`
    } catch (error) {
      this.logger.error(`Failed to format tool result: ${String(error)}`)
      return `Tool execution completed: ${toolResult.resultCase}`
    }
  }

  // ──── 类型化 Result 格式化方法 ────

  private formatDiagnosticsResultTyped(result: DiagnosticsResult): string {
    const r = result.result

    if (r.case === "success") {
      const value = (r.value || {}) as Record<string, unknown>
      const path =
        typeof value.path === "string" && value.path.trim() !== ""
          ? value.path.trim()
          : "(unknown)"
      const diagnostics = Array.isArray(value.diagnostics)
        ? value.diagnostics.filter(
            (entry): entry is Record<string, unknown> =>
              !!entry && typeof entry === "object"
          )
        : []
      const totalRaw = value.totalDiagnostics ?? value.total_diagnostics
      const totalDiagnostics =
        typeof totalRaw === "number" &&
        Number.isFinite(totalRaw) &&
        totalRaw >= 0
          ? Math.floor(totalRaw)
          : diagnostics.length

      const lines = [
        "[diagnosticsResult success]",
        `path: ${path}`,
        `total_diagnostics: ${totalDiagnostics}`,
      ]

      if (diagnostics.length > 0) {
        lines.push("diagnostics:")
        const maxItems = 20
        for (const diagnostic of diagnostics.slice(0, maxItems)) {
          const message =
            typeof diagnostic.message === "string" &&
            diagnostic.message.trim() !== ""
              ? diagnostic.message.trim()
              : "(no message)"
          const severityNumber = Number(diagnostic.severity)
          const severity = Number.isFinite(severityNumber)
            ? Math.floor(severityNumber)
            : "unknown"
          const source =
            typeof diagnostic.source === "string" &&
            diagnostic.source.trim() !== ""
              ? diagnostic.source.trim()
              : undefined
          const code =
            typeof diagnostic.code === "string" && diagnostic.code.trim() !== ""
              ? diagnostic.code.trim()
              : undefined

          let location = ""
          const range =
            diagnostic.range &&
            typeof diagnostic.range === "object" &&
            !Array.isArray(diagnostic.range)
              ? (diagnostic.range as Record<string, unknown>)
              : undefined
          const start =
            range?.start &&
            typeof range.start === "object" &&
            !Array.isArray(range.start)
              ? (range.start as Record<string, unknown>)
              : undefined
          const end =
            range?.end &&
            typeof range.end === "object" &&
            !Array.isArray(range.end)
              ? (range.end as Record<string, unknown>)
              : undefined
          if (
            start &&
            typeof start.line === "number" &&
            typeof start.column === "number"
          ) {
            const startLoc = `L${start.line + 1}:C${start.column + 1}`
            if (
              end &&
              typeof end.line === "number" &&
              typeof end.column === "number"
            ) {
              location = `${startLoc}-L${end.line + 1}:C${end.column + 1}`
            } else {
              location = startLoc
            }
          }

          const metadataParts = [`severity=${severity}`]
          if (source) metadataParts.push(`source=${source}`)
          if (code) metadataParts.push(`code=${code}`)
          const metadata = metadataParts.join(", ")
          lines.push(
            `- ${location ? `${location} ` : ""}${message} (${metadata})`
          )
        }
        if (diagnostics.length > 20) {
          lines.push(
            `- ... ${diagnostics.length - 20} more diagnostics omitted`
          )
        }
      }

      return lines.join("\n")
    }

    if (r.case === "error") {
      return `[diagnosticsResult error] ${r.value?.error || "diagnostics failed"}`
    }
    if (r.case === "rejected") {
      return `[diagnosticsResult rejected] ${r.value?.reason || "request rejected"}`
    }
    if (r.case === "fileNotFound") {
      return `[diagnosticsResult file_not_found] ${r.value?.path || ""}`.trim()
    }
    if (r.case === "permissionDenied") {
      return `[diagnosticsResult permission_denied] ${r.value?.path || ""}`.trim()
    }

    return "[diagnosticsResult] unknown"
  }

  private formatShellResultTyped(result: ShellResult): string {
    const r = result.result
    if (r.case === "success") {
      const v = r.value
      const output: string[] = []
      if (v.stdout) output.push(v.stdout)
      if (v.stderr) output.push(`[stderr] ${v.stderr}`)
      if (output.length > 0) return output.join("\n")
      return `Command completed with exit code ${v.exitCode ?? 0}`
    }
    if (r.case === "failure") {
      const v = r.value
      const output: string[] = []
      if (v.stdout) output.push(v.stdout)
      if (v.stderr) output.push(`[stderr] ${v.stderr}`)
      if (output.length > 0) return output.join("\n")
      return `Command failed with exit code ${v.exitCode ?? 1}`
    }
    if (r.case === "timeout") return "[shell timeout]"
    if (r.case === "rejected") return "[shell rejected]"
    if (r.case === "spawnError") {
      return `[spawn error] ${r.value.error || "Failed to spawn process"}`
    }
    if (r.case === "permissionDenied") return "[permission denied]"
    return "Command completed"
  }

  private formatShellStreamTyped(stream: ShellStream): string {
    const e = stream.event
    if (e.case === "stdout") return e.value.data || ""
    if (e.case === "stderr") return `[stderr] ${e.value.data || ""}`
    if (e.case === "exit") return `[exit] code=${e.value.code ?? 0}`
    if (e.case === "start") return "[shell started]"
    if (e.case === "rejected") return "[shell rejected]"
    if (e.case === "permissionDenied") return "[permission denied]"
    if (e.case === "backgrounded") return "[backgrounded]"
    return ""
  }

  private formatReadResultTyped(result: ReadResult): string {
    const r = result.result
    if (r.case === "success") {
      const v = r.value
      // ReadSuccess 有 oneof output: content (string) | data (bytes)
      if (v.output?.case === "content" && v.output.value) {
        this.logger.debug(
          `Read success content: ${v.output.value.length} chars`
        )
        return v.output.value
      }
      if (v.output?.case === "data" && v.output.value?.length > 0) {
        this.logger.debug(`Read success data: ${v.output.value.length} bytes`)
        return new TextDecoder().decode(v.output.value)
      }
      if (v.path) return `[Read ${v.path}: no content returned]`
    }
    if (r.case === "error") {
      return `[read error] ${r.value.error || "Unknown error"}${r.value.path ? ` (path: ${r.value.path})` : ""}`
    }
    if (r.case === "rejected") return "[read rejected]"
    if (r.case === "fileNotFound")
      return `[file not found] ${r.value.path || ""}`
    if (r.case === "permissionDenied") return "[permission denied]"
    if (r.case === "invalidFile") return "[invalid file]"
    return "Read completed"
  }

  private formatWriteResultTyped(result: WriteResult): string {
    const r = result.result
    if (r.case === "success") {
      const v = r.value
      if (v.fileContentAfterWrite) {
        this.logger.debug(
          `Write success: ${v.path}, ${v.fileContentAfterWrite.length} chars`
        )
        return v.fileContentAfterWrite
      }
      return `File written successfully: ${v.path || "unknown"} (${v.linesCreated || 0} lines, ${v.fileSize || 0} bytes)`
    }
    if (r.case === "permissionDenied") return `[write permission denied]`
    if (r.case === "noSpace") return "[write error] No space left on device"
    if (r.case === "error") {
      return `[write error] ${r.value.error || "Unknown error"}${r.value.path ? ` (path: ${r.value.path})` : ""}`
    }
    if (r.case === "rejected") return "[write rejected]"
    return "File written successfully"
  }

  private formatDeleteResultTyped(result: DeleteResult): string {
    const r = result.result
    if (r.case === "success") {
      const v = r.value
      if (v.prevContent) {
        this.logger.debug(
          `Delete success: ${v.path}, prev content ${v.prevContent.length} chars`
        )
        return v.prevContent
      }
      return `File deleted successfully: ${v.deletedFile || v.path || "unknown"} (${v.fileSize || 0} bytes)`
    }
    if (r.case === "fileNotFound")
      return `[delete error] File not found: ${r.value.path || ""}`
    if (r.case === "notFile")
      return `[delete error] Not a file: ${r.value.path || ""}`
    if (r.case === "permissionDenied") return `[delete permission denied]`
    if (r.case === "fileBusy")
      return `[delete error] File busy: ${r.value.path || ""}`
    if (r.case === "rejected") return "[delete rejected]"
    if (r.case === "error") {
      return `[delete error] ${r.value.error || "Unknown error"}${r.value.path ? ` (path: ${r.value.path})` : ""}`
    }
    return "File deleted successfully"
  }

  private formatLsResultTyped(result: LsResult): string {
    const r = result.result
    if (r.case === "success") {
      const tree = r.value.directoryTreeRoot
      if (tree) {
        // 递归收集目录树
        const lines: string[] = []
        this.collectTreeLines(tree, "", lines)
        if (lines.length > 0) return lines.join("\n")
        return tree.absPath || "Directory listed"
      }
    }
    if (r.case === "error") {
      return `[ls error] ${r.value.error || "Unknown error"}${r.value.path ? ` (path: ${r.value.path})` : ""}`
    }
    if (r.case === "rejected") return "[ls rejected]"
    if (r.case === "timeout") return "[ls timeout]"
    return "Directory listed"
  }

  /**
   * 递归收集目录树为文本行
   */
  private collectTreeLines(
    node: LsDirectoryTreeNode,
    indent: string,
    lines: string[]
  ): void {
    if (node.absPath) {
      lines.push(`${indent}${node.absPath}/`)
    }
    // 子目录（递归）
    if (node.childrenDirs) {
      for (const dir of node.childrenDirs) {
        const dirName = dir.absPath?.split("/").pop() || dir.absPath
        lines.push(`${indent}  ${dirName}/`)
        // 递归子目录（限制深度避免输出过大）
        if (lines.length < 500) {
          this.collectTreeLines(dir, indent + "  ", lines)
        }
      }
    }
    // 文件
    if (node.childrenFiles) {
      for (const f of node.childrenFiles) {
        if (f.name) lines.push(`${indent}  ${f.name}`)
      }
    }
  }

  private formatGrepResultTyped(result: GrepResult): string {
    const r = result.result
    if (r.case === "success") {
      const v = r.value
      // GrepSuccess 有 workspaceResults map<string, GrepUnionResult>
      if (v.workspaceResults) {
        const lines: string[] = []
        for (const [_workspace, unionResult] of Object.entries(
          v.workspaceResults
        )) {
          const ur = unionResult
          if (!ur?.result) continue

          if (ur.result.case === "content") {
            // GrepContentResult { matches: GrepFileMatch[] }
            const contentResult = ur.result.value
            if (contentResult.matches) {
              for (const fileMatch of contentResult.matches) {
                // GrepFileMatch { file: string, matches: GrepContentMatch[] }
                if (fileMatch.matches) {
                  for (const m of fileMatch.matches) {
                    if (!m.isContextLine) {
                      lines.push(
                        `${fileMatch.file}:${m.lineNumber}:${m.content}`
                      )
                    }
                  }
                }
              }
            }
            if (contentResult.totalMatchedLines) {
              lines.push(
                `\n(${contentResult.totalMatchedLines} total matched lines)`
              )
            }
          } else if (ur.result.case === "files") {
            // GrepFilesResult { files: string[] }
            const filesResult = ur.result.value
            if (filesResult.files) {
              lines.push(...filesResult.files)
            }
            if (filesResult.totalFiles) {
              lines.push(`\n(${filesResult.totalFiles} total files)`)
            }
          } else if (ur.result.case === "count") {
            // GrepCountResult { counts: GrepFileCount[] }
            const countResult = ur.result.value
            if (countResult.counts) {
              for (const c of countResult.counts) {
                lines.push(`${c.file}: ${c.count} matches`)
              }
            }
            if (countResult.totalMatches) {
              lines.push(
                `\n(${countResult.totalMatches} total matches in ${countResult.totalFiles} files)`
              )
            }
          }
        }
        if (lines.length > 0) return lines.join("\n")
      }
      return `Grep completed: pattern="${v.pattern || "N/A"}", path="${v.path || "N/A"}"`
    }
    if (r.case === "error") {
      return `[grep error] ${r.value.error || "Unknown error"}`
    }
    return "Grep completed"
  }

  private formatBgShellSpawnTyped(result: BackgroundShellSpawnResult): string {
    const r = result.result
    if (r.case === "success") {
      const v = r.value
      return `Background shell spawned successfully (shell_id: ${v.shellId}, pid: ${v.pid}, command: ${v.command || "N/A"}, cwd: ${v.workingDirectory || "N/A"})`
    }
    if (r.case === "error") {
      const v = r.value
      return `Background shell spawn error: ${v.error || "Unknown error"} (command: ${v.command || "N/A"}, cwd: ${v.workingDirectory || "N/A"})`
    }
    if (r.case === "rejected") return "Background shell spawn rejected"
    if (r.case === "permissionDenied")
      return "Background shell spawn permission denied"
    return "Background shell spawn completed"
  }

  /**
   * Build system prompt from context
   */
  private buildSystemPrompt(context: PromptContext): string {
    const parts: string[] = []

    if (context.customSystemPrompt) {
      parts.push(context.customSystemPrompt)
    }

    const cursorRulesSection = this.buildCursorRulesSection(context.cursorRules)
    if (cursorRulesSection) {
      parts.push(cursorRulesSection)
    }

    if (context.cursorCommands && context.cursorCommands.length > 0) {
      const commandBlocks = context.cursorCommands.map((command) =>
        [`/${command.name}`, command.content].join("\n")
      )
      parts.push("Selected Cursor Commands:\n" + commandBlocks.join("\n\n"))
    }

    if (context.explicitContext) {
      parts.push("Explicit Context:\n" + context.explicitContext)
    }

    if (context.projectContext) {
      const workspaceInfo = [
        `Current working directory: ${context.projectContext.rootPath}`,
      ]
      if (context.projectContext.directories.length > 1) {
        workspaceInfo.push(
          `Open workspaces: ${context.projectContext.directories.join(", ")}`
        )
      }
      parts.push(workspaceInfo.join("\n"))
    }

    if (context.codeChunks && context.codeChunks.length > 0) {
      const chunkTexts = context.codeChunks.map((chunk) => {
        const lineInfo = chunk.startLine
          ? `:${chunk.startLine}-${chunk.endLine}`
          : ""
        return `--- ${chunk.path}${lineInfo} ---\n${chunk.content}`
      })
      parts.push("Code Context:\n" + chunkTexts.join("\n\n"))
    }

    return parts.join("\n\n")
  }

  private buildGoogleSystemPrompt(context: PromptContext): string {
    const parts: string[] = []
    if (context.customSystemPrompt) {
      parts.push(context.customSystemPrompt)
    }
    if (context.explicitContext) {
      parts.push("Explicit Context:\n" + context.explicitContext)
    }
    return parts.join("\n\n")
  }

  private buildGoogleContextMessages(
    context: PromptContext,
    conversationId: string
  ): Array<{ role: "user" | "assistant"; content: MessageContent }> {
    const contextMessages: Array<{
      role: "user" | "assistant"
      content: MessageContent
    }> = []
    let stepId = 0

    if (context.projectContext) {
      const workspaceMappings = context.projectContext.directories
        .map((dir) => `${dir} -> ${dir.split("/").slice(-2).join("/")}`)
        .join("\n")
      contextMessages.push({
        role: "user",
        content: [
          "<user_information>",
          "The USER's OS version is mac.",
          `The user has ${context.projectContext.directories.length} active workspaces, each defined by a URI and a CorpusName. Multiple URIs potentially map to the same CorpusName. The mapping is shown as follows in the format [URI] -> [CorpusName]:`,
          workspaceMappings,
          "Code relating to the user's requests should be written in the locations listed above. Avoid writing project code files to tmp, in the .gemini dir, or directly to the Desktop and similar folders unless explicitly asked.",
          "</user_information>",
        ].join("\n"),
      })
    }

    {
      const mcpLines: string[] = [
        "<mcp_servers>",
        "The Model Context Protocol (MCP) is a standard that connects AI systems with external tools and data sources.",
        "MCP servers extend your capabilities by providing access to specialized functions, external information, and services.",
        "The following MCP servers are available to you. Each server may provide (potentially truncated) additional recommendations and best practices.",
      ]
      if (context.mcpToolDefs && context.mcpToolDefs.length > 0) {
        const seenServers = new Set<string>()
        for (const def of context.mcpToolDefs) {
          if (
            def.providerIdentifier &&
            !seenServers.has(def.providerIdentifier)
          ) {
            seenServers.add(def.providerIdentifier)
            mcpLines.push(`# ${def.providerIdentifier}`)
          }
        }
      }
      mcpLines.push("</mcp_servers>")
      contextMessages.push({ role: "user", content: mcpLines.join("\n") })
    }

    {
      const artifactDir = `${process.env.HOME || "/tmp"}/.gemini/antigravity/brain/${conversationId}`
      contextMessages.push({
        role: "user",
        content: `<artifacts>\nArtifact Directory Path: ${artifactDir}\n</artifacts>`,
      })
    }

    if (context.cursorRules && context.cursorRules.length > 0) {
      const ruleContents = context.cursorRules
        .map((rule) => (typeof rule === "string" ? rule : rule.content))
        .filter((content) => typeof content === "string" && content.trim())
      if (ruleContents.length > 0) {
        contextMessages.push({
          role: "user",
          content:
            "<user_rules>\n" + ruleContents.join("\n") + "\n</user_rules>",
        })
      }
    } else {
      contextMessages.push({
        role: "user",
        content:
          "<user_rules>\nThe user has not defined any custom rules.\n</user_rules>",
      })
    }

    {
      const wfLines: string[] = [
        "<workflows>",
        "You have the ability to use and create workflows, which are well-defined steps on how to achieve a particular thing. These workflows are defined as .md files in {.agents,.agent,_agents,_agent}/workflows.",
        "The workflow files follow the following YAML frontmatter + markdown format:",
        "---",
        "description: [short title, e.g. how to deploy the application]",
        "---",
        "[specific steps on how to run this workflow]",
        "",
        " - You might be asked to create a new workflow. If so, create a new file in {.agents,.agent,_agents,_agent}/workflows/[filename].md (use absolute path) following the format described above. Be very specific with your instructions.",
        " - If a workflow step has a '// turbo' annotation above it, you can auto-run the workflow step if it involves the run_terminal_command tool, by setting 'SafeToAutoRun' to true. This annotation ONLY applies for this single step.",
        "   - For example if a workflow includes:",
        "```",
        "2. Make a folder called foo",
        "// turbo",
        "3. Make a folder called bar",
        "```",
        "You should auto-run step 3, but use your usual judgement for step 2.",
        " - If a workflow has a '// turbo-all' annotation anywhere, you MUST auto-run EVERY step that involves the run_terminal_command tool, by setting 'SafeToAutoRun' to true. This annotation applies to EVERY step.",
        " - If a workflow looks relevant, or the user explicitly uses a slash command like /slash-command, then use the read_file tool to read {.agents,.agent,_agents,_agent}/workflows/slash-command.md.",
        "",
      ]

      if (context.cursorCommands && context.cursorCommands.length > 0) {
        wfLines.push("The following user-defined commands are available:")
        wfLines.push("")
        for (const cmd of context.cursorCommands) {
          wfLines.push(`### /${cmd.name}`)
          wfLines.push(cmd.content)
          wfLines.push("")
        }
      }

      wfLines.push("</workflows>")
      contextMessages.push({
        role: "user",
        content: wfLines.join("\n"),
      })
    }

    {
      const metadataLines: string[] = [
        `Step Id: ${stepId++}`,
        "",
        "<ADDITIONAL_METADATA>",
        `The current local time is: ${this.formatCurrentLocalTimeWithOffset()}. This is the latest source of truth for time; do not attempt to get the time any other way.`,
        "",
        "The user's current state is as follows:",
      ]
      if (context.codeChunks && context.codeChunks.length > 0) {
        const activeDoc = context.codeChunks[0]
        if (activeDoc) {
          metadataLines.push(
            `Active Document: ${activeDoc.path} (LANGUAGE_UNKNOWN)`
          )
          if (activeDoc.startLine !== undefined) {
            metadataLines.push(`Cursor is on line: ${activeDoc.startLine}`)
          }
        }
      }
      metadataLines.push("No browser pages are currently open.")
      metadataLines.push("</ADDITIONAL_METADATA>")

      contextMessages.push({
        role: "user",
        content: metadataLines.join("\n"),
      })
    }

    {
      const ephLines: string[] = [
        `Step Id: ${stepId++}`,
        "The following is an <EPHEMERAL_MESSAGE> not actually sent by the user. It is provided by the system as a set of reminders and general important information to pay attention to. Do NOT respond to this message, just act accordingly.",
        "",
        "<EPHEMERAL_MESSAGE>",
        "<artifact_reminder>",
        "You have not yet created any artifacts. Please follow the artifact guidelines and create them as needed based on the task.",
        "CRITICAL REMINDER: remember that user-facing artifacts should be AS CONCISE AS POSSIBLE. Keep this in mind when editing artifacts.",
        "</artifact_reminder>",
        "<no_active_task_reminder>",
        "You are currently not in a task because: a task boundary has never been set yet in this conversation.",
        "If there is no obvious task from the user or if you are just conversing, then it is acceptable to not have a task set. If you are just handling simple one-off requests, such as explaining a single file, or making one or two ad-hoc code edit requests, or making an obvious refactoring request such as renaming or moving code into a helper function, it is also acceptable to not have a task set.",
        "Otherwise, you should use the task_boundary tool to set a task if there is one evident.",
        "Since you are NOT in an active task section, DO NOT call the `notify_user` tool unless you are requesting review of files.",
        "</no_active_task_reminder>",
        "</EPHEMERAL_MESSAGE>",
      ]
      contextMessages.push({ role: "user", content: ephLines.join("\n") })
    }

    return contextMessages
  }

  private buildCursorRulesSection(
    rules?: PromptContext["cursorRules"] | string[]
  ): string | null {
    if (!Array.isArray(rules) || rules.length === 0) {
      return null
    }

    const renderedRules = rules.map((rule, index) =>
      this.formatCursorRule(rule, index)
    )
    return "Cursor Rules:\n" + renderedRules.join("\n\n")
  }

  private formatCursorRule(rule: CursorRule | string, index: number): string {
    if (typeof rule === "string") {
      return [`[Rule ${index + 1}]`, "content:", rule].join("\n")
    }

    const lines = [`[Rule ${index + 1}]`]

    if (rule.fullPath) {
      lines.push(`full_path: ${rule.fullPath}`)
    }

    const ruleType = this.getCursorRuleTypeLabel(rule)
    if (ruleType) {
      lines.push(`type: ${ruleType}`)
    }

    const ruleSource = this.getCursorRuleSourceLabel(rule.source)
    if (ruleSource) {
      lines.push(`source: ${ruleSource}`)
    }

    const typeCase = rule.type?.type.case
    if (typeCase === "fileGlobbed" && rule.type?.type.value.globs.length) {
      lines.push(`globs: ${rule.type.type.value.globs.join(", ")}`)
    }
    if (
      typeCase === "agentFetched" &&
      rule.type?.type.value.description.trim()
    ) {
      lines.push(`description: ${rule.type.type.value.description.trim()}`)
    }
    if (rule.environments.length > 0) {
      lines.push(`environments: ${rule.environments.join(", ")}`)
    }
    if (rule.disabledEnvironments.length > 0) {
      lines.push(
        `disabled_environments: ${rule.disabledEnvironments.join(", ")}`
      )
    }
    if (rule.gitRemoteOrigin) {
      lines.push(`git_remote_origin: ${rule.gitRemoteOrigin}`)
    }
    if (rule.plugin) {
      lines.push(`plugin: ${rule.plugin}`)
    }
    if (rule.marketplace) {
      lines.push(`marketplace: ${rule.marketplace}`)
    }
    if (rule.parseError) {
      lines.push(`parse_error: ${rule.parseError}`)
    }

    lines.push("content:")
    lines.push(rule.content || "")

    return lines.join("\n")
  }

  private getCursorRuleTypeLabel(rule: CursorRule): string | null {
    switch (rule.type?.type.case) {
      case "global":
        return "global"
      case "fileGlobbed":
        return "file_globbed"
      case "agentFetched":
        return "agent_fetched"
      case "manuallyAttached":
        return "manually_attached"
      default:
        return null
    }
  }

  private getCursorRuleSourceLabel(
    source: CursorRule["source"]
  ): string | null {
    switch (source) {
      case CursorRuleSource.TEAM:
        return "team"
      case CursorRuleSource.USER:
        return "user"
      default:
        return null
    }
  }

  private formatCurrentLocalTimeWithOffset(): string {
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, "0")
    const day = String(now.getDate()).padStart(2, "0")
    const hours = String(now.getHours()).padStart(2, "0")
    const minutes = String(now.getMinutes()).padStart(2, "0")
    const seconds = String(now.getSeconds()).padStart(2, "0")

    const offsetMinutesEast = -now.getTimezoneOffset()
    const sign = offsetMinutesEast >= 0 ? "+" : "-"
    const offsetAbs = Math.abs(offsetMinutesEast)
    const offsetHours = String(Math.floor(offsetAbs / 60)).padStart(2, "0")
    const offsetMinutes = String(offsetAbs % 60).padStart(2, "0")

    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetMinutes}`
  }

  /**
   * Cursor only exposes medium/high thinking in its public protocol.
   * Preserve a distinct highest tier for downstream backends by mapping
   * high/max-mode to the canonical xhigh budget bucket.
   */
  private getCursorThinkingBudget(thinkingLevel: number): number {
    if (thinkingLevel >= 2) return 32768
    if (thinkingLevel === 1) return 8192
    return 0
  }

  // buildToolDefinitions removed — now using buildToolsForApi from cursor-tool-mapper.ts

  /**
   * Generate conversation ID
   */
  private generateConversationId(): string {
    return `conv_${Date.now()}_${Math.random().toString(36).substring(7)}`
  }

  /**
   * Generate turn ID using SHA-256 hash
   * Format: Base64-encoded hash (44 characters)
   */
  private generateTurnId(conversationId: string, turnIndex: number): string {
    const data = `${conversationId}-turn-${turnIndex}-${Date.now()}`
    const hash = crypto.createHash("sha256")
    hash.update(data)
    return hash.digest("base64")
  }
}
