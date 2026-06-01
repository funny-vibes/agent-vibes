import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import { Injectable, Logger } from "@nestjs/common"
import { spawn, spawnSync } from "child_process"
import * as crypto from "crypto"
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "fs"
import * as os from "os"
import * as path from "path"
import {
  buildSubAgentMemorySourceCompactionId,
  CodexContextAdapterService,
  ContextCompactRunnerService,
  type ContextAttachmentSnapshot,
  type ContextCompactRunnerSummaryProvider,
  type ContextCompactionCandidate,
  type ContextCompactionResult,
  ContextProjectionBudgetExceededError,
  ContextHookExecutorService,
  type ContextInvestigationMemoryEntry,
  ContextManagerService,
  ContextNativeManagementService,
  ContextPipelineService,
  ContextRequestPlannerService,
  type ContextRequestBudget,
  type ContextProjectionBudget,
  type ContextSessionMemoryEntry,
  type ContextToolResultReplacementState,
  type ContextUsageSnapshot,
  detectPromptTooLong,
  extractText,
  formatSubAgentMemoryEntry,
  isMessageRecord,
  type LooseMessageContent,
  normalizeToolProtocolMessages,
  type PreCompactHookPayload,
  type SubAgentMemoryFormatInput,
  TokenCounterService,
  ToolIntegrityService,
  ToolResultStorageService,
  UnifiedMessage,
} from "../../context"
import {
  AgentConversationTurnStructureSchema,
  AgentMode,
  type BackgroundShellSpawnResult,
  type ConversationStep,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  type CursorRule,
  CursorRuleSource,
  type DeleteResult,
  type DiagnosticsResult,
  ExecClientMessageSchema,
  type GrepResult,
  type ListMcpResourcesExecResult,
  type LsDirectoryTreeNode,
  type LsResult,
  type ReadMcpResourceExecResult,
  type ReadResult,
  type ShellResult,
  ShellStream,
  UserMessageSchema,
  type WriteResult,
} from "../../gen/agent/v1_pb"
import {
  AnthropicApiService,
  DEFAULT_CLAUDE_API_CONTEXT_LIMIT_TOKENS,
} from "../../llm/anthropic/anthropic-api.service"
import { KiroService } from "../../llm/aws/kiro.service"
import { GoogleService } from "../../llm/google/google.service"
import { ImageGenerationService } from "../../llm/image-generation/image-generation.service"
import { type CodexExecutionRequest } from "../../llm/openai/codex-request-builder"
import { CodexService } from "../../llm/openai/codex.service"
import { OpenaiCompatService } from "../../llm/openai/openai-compat.service"
import { UpstreamRequestAbortedError } from "../../llm/shared/abort-signal"
import {
  BackendType,
  ModelRouteResult,
  ModelRouterService,
} from "../../llm/shared/model-router.service"
import {
  applyThinkingIntentToDto,
  buildThinkingIntentFromCursorRequest,
  normalizeRequestedThinkingEffort,
  type RequestedThinkingEffort,
} from "../../llm/shared/thinking-intent"
import { backendRequiresCompleteToolBatchBeforeContinuation } from "../../llm/shared/tool-continuation-policy"
import type { AnthropicResponse } from "../../shared/anthropic"
import {
  canonicalizeOfficialAntigravityToolInvocation as canonicalizeOfficialAntigravityToolInvocationFromContract,
  extractOfficialAntigravityArtifactMetadata as extractOfficialAntigravityArtifactMetadataFromContract,
  type OfficialAntigravityArtifactMetadata,
  type OfficialAntigravityCanonicalToolInvocation,
} from "../../shared/official-antigravity-tools"
import { CreateMessageDto } from "../anthropic/dto/create-message.dto"
import { BufferChannel } from "./concurrency/buffer-channel"
import { CursorGrpcService } from "./cursor-grpc.service"
import { KnowledgeBaseService } from "./knowledge-base.service"
import { KvStorageService } from "./kv-storage.service"
import { SemanticSearchProviderService } from "./semantic-search-provider.service"
import { BackendStreamAbortRegistry } from "./session/backend-stream-abort-registry"
import {
  isPathWithinAllowedRoots,
  normalizePathForBoundaryCheck,
} from "./session/workspace-root-resolver"
import {
  ChatSession,
  ChatSessionManager,
  EditFailureContext,
  InterruptedToolCallInfo,
  PendingToolCall,
  SessionActiveToolBatch,
  SessionBackgroundCommand,
  SessionRestartRecovery,
  SessionTodoItem,
  SessionTodoStatus,
  SessionTopLevelAgentTurnState,
  SubAgentContext,
} from "./session/chat-session.service"
import { ToolExecutionCoordinatorService } from "./session/tool-execution-coordinator.service"
import { type CursorSkillMetadata, CursorSkillsManager } from "./skills"
import { SubagentBackgroundWorker } from "./subagents/subagent-background-worker.service"
import {
  SubagentExecBridgeService,
  type SubagentExecResult,
} from "./subagents/subagent-exec-bridge.service"
import { SubagentRegistryService } from "./subagents/subagent-registry.service"
import { SubagentTaskRegistry } from "./subagents/subagent-task-registry.service"
import { projectSubAgentFinalSynthesisMessages } from "./subagents/subagent-final-synthesis-projector"
import { resolveSubagentToolSurface } from "./subagents/subagent-tool-resolver"
import {
  type SubagentTaskMetadata,
  SubagentTranscriptStore,
} from "./subagents/subagent-transcript-store.service"
import {
  getSubagentSystemPrompt,
  type SubagentDefinition,
} from "./subagents/types"
import { generateBlobId, generateTraceId } from "./tools/agent-helpers"
import { normalizeBugfixResultItems as normalizeBugfixResultItemsFromContract } from "./tools/bugfix-result-normalizer"
import { ClientSideToolV2ExecutorService } from "./tools/client-side-tool-v2-executor.service"
import {
  type AttachedImage,
  cursorRequestParser,
  ParsedCursorRequest,
  ParsedToolResult,
} from "./tools/cursor-request-parser"
import {
  buildToolsForApi,
  buildToolsForApiWithDefer,
  type DeferredToolDescriptor,
  getDefaultCodexImplicitAgentToolNames,
  matchesImplicitDefaultAgentToolNames,
  resolveCursorToolDefinitionKey,
  type ToolDefinition,
} from "./tools/cursor-tool-mapper"
import {
  type DiscoverToolCatalogEntry,
  formatDiscoverToolResultText,
  handleDiscoverToolCall,
} from "./tools/discover-tool-handler"
import {
  buildMcpDispatchInput,
  normalizeMcpToolIdentifier,
  resolveMcpCallFields as resolveMcpCallFieldsFromContract,
  resolveMcpToolDefinition,
} from "./tools/mcp-call-contract"
import {
  DISCOVER_TOOL_NAME,
  pickStrategy as pickDeferStrategy,
} from "./tools/tool-defer-policy"
import {
  buildNumberedLineEntries,
  extractEditFailureSelection,
  findToolResultAppendPlan,
  formatLineNumberedSnippet,
  messageContainsToolResult,
} from "./tools/tool-protocol-helpers"
import {
  WebSearchAbortError,
  WebSearchEmptyResultError,
  WebSearchService,
} from "./web-search"

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
  type: "text_delta" | "input_json_delta" | "thinking_delta" | "signature_delta"
  text?: string
  partial_json?: string
  thinking?: string
  signature?: string
}

interface CursorToolCapabilityOptionsForRoute {
  webSearchEnabled?: boolean
  webFetchEnabled?: boolean
}

/**
 * SSE Event data structure
 */
interface SseEventData {
  content_block?: SseContentBlock
  delta?: SseDelta
  message?: {
    id?: string
    [key: string]: unknown
  }
  index?: number
  usage?: {
    input_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    output_tokens?: number
  }
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
  | "selectedCursorRulePaths"
  | "selectedCursorRuleNames"
> & {
  newMessage?: ParsedCursorRequest["newMessage"]
  activeCursorSkillNames?: string[]
}

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
  content: string | Array<Record<string, unknown>>
  [key: string]: unknown
}

interface ThinkingContentItem {
  type: "thinking"
  thinking: string
  signature?: string
  [key: string]: unknown
}

type MessageContentItem =
  | TextContentItem
  | ToolUseContentItem
  | ToolResultContentItem
  | ThinkingContentItem

/**
 * Message content type - compatible with chat-session.manager.ts
 */
type MessageContent = LooseMessageContent

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

type _CloudCodeProtocolRecoveryAction =
  | "start_new_session"
  | "remove_bad_tool_call"

interface CloudCodeProtocolRecoveryPayload extends Record<string, unknown> {
  kind: "cloud_code_protocol_recovery"
  backendLabel: string
  backendModel: string
  toolUseId: string
  requestId?: string
  detail: string
}

interface ParsedCloudCodeProtocolError {
  toolUseId: string
  requestId?: string
  detail: string
}

type InlineWebToolFamily = "web_search" | "web_fetch"

type DeferredToolFamily =
  | InlineWebToolFamily
  | "command_status"
  | "read_todos"
  | "update_todos"
  | "update_plan"
  | "get_mcp_tools"
  | "list_mcp_resource_templates"
  | "read_url_content"
  | "view_content_chunk"
  | "view_image"
  | "fetch"
  | "record_screen"
  | "computer_use"
  | "reflect"
  | "start_grind_execution"
  | "start_grind_planning"
  | "ask_question"
  | "request_user_input"
  | "create_plan"
  | "switch_mode"
  | "exa_search"
  | "exa_fetch"
  | "setup_vm_environment"
  | "task"
  | "spawn_agent"
  | "send_input"
  | "resume_agent"
  | "wait_agent"
  | "close_agent"
  | "apply_patch"
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
  | "ai_attribution"
  | "await"
  | "kill_agent"
  | "mcp_auth"
  | "read_project"
  | "update_project"
  // 新增 proto 更新后的 Exec 工具
  | "force_background_shell"
  | "force_background_subagent"
  | "mcp_state_exec"
  | "subagent_await"
  // 新增交互工具
  | "communicate_update"
  | "send_final_summary"
  | "blame_by_file_path"
  | "report_bug"
  | "set_active_branch"
  // ExecServerMessage 补齐
  | "request_context"
  | "redacted_read"
  // InteractionQuery 补齐
  | "pr_management"

const DEFERRED_INTERACTION_QUERY_FAMILIES: ReadonlySet<DeferredToolFamily> =
  new Set<DeferredToolFamily>([
    "web_search",
    "web_fetch",
    "ask_question",
    "request_user_input",
    "create_plan",
    "switch_mode",
    "exa_search",
    "exa_fetch",
    "setup_vm_environment",
    // 新增 proto 更新后的 InteractionQuery 工具
    "generate_image",
    "mcp_auth",
    // InteractionQuery 补齐
    "pr_management",
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

interface EditResolvedMatch {
  requestedStartLine?: number
  requestedEndLine?: number
  matchedStartLine: number
  matchedEndLine: number
  chunkIndex?: number
}

interface CompatibilityNormalizedText {
  normalized: string
  normalizedToOriginal: number[]
  normalizedBoundary: boolean[]
}

interface CompatibilityNormalizedMatch {
  normalizedOffset: number
  originalStart: number
  originalEnd: number
}

interface CompatibilityNormalizedMatchSet {
  allMatches: CompatibilityNormalizedMatch[]
  matchesInRange: CompatibilityNormalizedMatch[]
}

interface ActiveToolCall {
  id: string
  name: string
  inputJson: string
  modelCallId: string
}

interface HistoryToolMetadata {
  toolName: string
  input: Record<string, unknown>
}

interface HistoryToolResultCandidate extends HistoryToolMetadata {
  toolUseId: string
  content: string
  size: number
}

type ToolDispatchOutcome = "waiting_for_result" | "completed_inline"

type AssistantTurnCompletionMode = "initial" | "continuation"

interface HandleToolResultOptions {
  continueGeneration?: boolean
  streamId?: string
  /**
   * Whether to dispatch the next queued edit on the same path after the
   * current edit_file_v2 invocation is consumed. Defaults to true. Aborted /
   * synthetic tool result paths (execThrow, recovery, missing-output) set
   * this to false so the proxy stops feeding fresh readArgs into a stream
   * that the client has already torn down.
   */
  dispatchNextQueuedEditOnConsume?: boolean
}

interface BackendStreamHints {
  /**
   * When set, callers should treat this as the upper bound for context
   * tokens used when (re)building the request DTO.  This is how
   * `executeBackendStreamWithFallback` injects the smaller budget produced
   * by reactive prompt-too-long recovery without requiring callers to
   * re-thread the parameter through every closure.
   */
  budgetOverride?: { maxTokens?: number }
}

interface BackendStreamOptions {
  buildDtoForRoute?: (
    route: ModelRouteResult,
    hints?: BackendStreamHints
  ) => CreateMessageDto
  buildCodexRequestForRoute?: (
    route: ModelRouteResult,
    hints?: BackendStreamHints
  ) => CodexExecutionRequest
  prepareContextForRoute?: (
    route: ModelRouteResult,
    hints?: BackendStreamHints
  ) => Promise<void>
  abortSignal?: AbortSignal
  streamAbortBinding?: {
    conversationId: string
    streamId: string
  }
  /**
   * Stable identifier used to track consecutive prompt-too-long failures
   * and to drive the reactive-recovery circuit breaker living on
   * `ContextManagerService`.  Falls back to a route-based key when
   * absent — that still prevents infinite retry but loses cross-call
   * counting between turns.
   */
  recoveryKey?: string
  /**
   * Snapshot used by the reactive-recovery path to rebuild attachments
   * after a prompt-too-long failure.  Optional; recovery falls back to
   * an empty snapshot when omitted.
   */
  recoveryAttachmentSnapshot?: ContextAttachmentSnapshot
}

interface ExecDispatchTarget {
  toolName: string
  input: Record<string, unknown>
  toolFamilyHint?: "mcp" | "web_fetch"
}

interface PreparedToolInvocation {
  activeToolCall: ActiveToolCall
  canonicalToolName: string
  input: Record<string, unknown>
  historyToolName: string
  historyToolInput: Record<string, unknown>
  codexToolCallType: "function" | "custom"
  deferredToolFamily?: DeferredToolFamily
  execDispatchTarget?: ExecDispatchTarget
  dispatchErrorMessage?: string
  canDispatchExec: boolean
  protocolToolName: string
  protocolToolInput: Record<string, unknown>
  protocolToolFamilyHint?: "mcp" | "web_fetch"
}

interface TopLevelContinuationDecision {
  adviseSynthesis: boolean
  historyTokens: number
  promptTokens: number
  availableHistoryBudgetTokens: number
  continuationCount: number
  consecutiveReadOnlyBatches: number
  verificationReadOnlyBatches: number
  reasons: string[]
}

type AvoidableShellCommandClassification = {
  kind: "file_write"
  recommendedTool: "edit_file_v2"
  reason: string
}

interface AssistantTurnStreamParams {
  conversationId: string
  session: ChatSession
  stream: AsyncGenerator<string, void, unknown>
  streamId?: string
  checkpointModel: string
  workspaceRootPath?: string
  mode: AssistantTurnCompletionMode
  emitInitialHeartbeat?: boolean
  emitTokenDeltas?: boolean
  streamAbortContext: string
  messageStopAbortContext: string
}

interface AssistantTurnStreamOutcome {
  kind:
    | "completed"
    | "waiting_for_results"
    | "empty"
    | "partial_without_message_stop"
    | "aborted"
  accumulatedText: string
  finalUsage?: ContextUsageSnapshot
  toolCallCount: number
}

type CanonicalToolInvocation = OfficialAntigravityCanonicalToolInvocation

interface CursorArtifactUiProjection {
  toolName: "update_todos"
  toolInput: Record<string, unknown>
  content: string
  toolResultState: { status: ToolResultStatus; message?: string }
}

interface LegacyWebDocument {
  id: string
  url: string
  title: string
  contentType: string
  chunks: string[]
  createdAt: number
}

interface ExecDispatchResolution {
  target?: ExecDispatchTarget
  errorMessage?: string
}

const BROWSER_MCP_TOOL_PREFIX = "cursor-ide-browser-browser_"
const BROWSER_CONTEXT_INITIALIZER_TOOL_NAMES = new Set(["navigate", "tabs"])
const BROWSER_CONTEXT_FREE_TOOL_NAMES = new Set([
  "tabs",
  "lock",
  "profile_start",
  "profile_stop",
])

interface SyntheticCodexAgentState {
  agentId: string
  conversationId: string
  status: "running" | "completed" | "closed"
  createdAt: number
  updatedAt: number
  nickname?: string
  agentType?: string
  model?: string
  message?: string
  lastInput?: string
}

interface ToolCompletedExtraData {
  beforeContent?: string
  afterContent?: string
  editSuccess?: {
    linesAdded?: number
    linesRemoved?: number
    diffString?: string
    message?: string
  }
  readSuccess?: {
    path?: string
    content?: string
    data?: Uint8Array
    totalLines?: number
    fileSize?: bigint | number
    truncated?: boolean
    rangeApplied?: boolean
    relatedCursorRulePaths?: string[]
    relatedCursorRules?: Array<Record<string, unknown>>
  }
  shellResult?: {
    stdout?: string
    stderr?: string
    exitCode?: number
    shellId?: number
    pid?: number
    interleavedOutput?: string
    msToWait?: number
    localExecutionTimeMs?: number
    executionTime?: number
    aborted?: boolean
    abortReason?: number
    backgroundReason?: number
    outputLocation?: {
      filePath?: string
      sizeBytes?: bigint | number
      lineCount?: bigint | number
    }
    terminalsFolder?: string
    timeoutBehavior?: number
    hardTimeout?: number
    requestedSandboxPolicy?: { type?: unknown } | null
    isBackground?: boolean
    description?: string
    classifierResult?: Record<string, unknown>
    closeStdin?: boolean
    fileOutputThresholdBytes?: bigint | number
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
  taskSuccess?: {
    conversationSteps?: Array<Record<string, unknown>>
    agentId?: string
    isBackground?: boolean
    durationMs?: bigint | number
    resultSuffix?: string
    transcriptPath?: string
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
  generateImageSuccess?: {
    filePath?: string
    imageData?: string
  }
  editFailureContext?: EditFailureContext & {
    currentRangeSnippet?: string
    currentRangeSnippetStartLine?: number
    currentRangeSnippetEndLine?: number
    currentRangeSnippetTruncated?: boolean
    matchCountInFile?: number
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

interface MaterializedConversationTurnForCheckpoint {
  userText: string
  userMessageId: string
  steps: ConversationStep[]
}

interface TranscriptToolResultForCheckpoint {
  content: string
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

interface CompletedTurnCheckpointState {
  session: ChatSession
  blobMessages: Buffer[]
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
  private readonly codexInstallationId = crypto.randomUUID()
  private readonly backendStreamAbortRegistry = new BackendStreamAbortRegistry()
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
  // Official Antigravity agent payload samples use a much smaller Cloud Code
  // output budget than the generic Anthropic path. Matching that default keeps
  // requests closer to the native Go client and avoids overly heavy asks.
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
  private readonly INFLATING_READONLY_TOOL_RESULT_MAX_LINES = 24
  private readonly INFLATING_READONLY_TOOL_RESULT_MAX_CHARS = 4_000
  private readonly INFLATING_READONLY_TOOL_STORAGE_THRESHOLD_CHARS = 4_000
  private readonly GENERIC_TOOL_RESULT_STORAGE_THRESHOLD_CHARS = 50_000
  private readonly AGGREGATE_TOOL_RESULT_STORAGE_BUDGET_CHARS = 200_000
  private readonly LARGE_READ_FILE_SIZE_BYTES = 256 * 1024
  private readonly OFFICIAL_VIEW_FILE_MAX_LINES = 800
  private readonly OFFICIAL_VIEW_FILE_MAX_RESULT_TOKENS = 18_000
  private readonly OFFICIAL_VIEW_FILE_BINARY_EXTENSIONS = new Set([
    ".7z",
    ".avi",
    ".bin",
    ".bmp",
    ".dll",
    ".exe",
    ".flac",
    ".gif",
    ".gz",
    ".ico",
    ".jpeg",
    ".jpg",
    ".m4a",
    ".mkv",
    ".mov",
    ".mp3",
    ".mp4",
    ".ogg",
    ".otf",
    ".pdf",
    ".png",
    ".rar",
    ".so",
    ".tar",
    ".tgz",
    ".ttf",
    ".wav",
    ".webm",
    ".webp",
    ".woff",
    ".woff2",
    ".zip",
  ])
  private readonly GREP_RESULT_PREVIEW_MAX_LINES = 120
  private readonly TOP_LEVEL_AGENT_READONLY_ADVISORY_TURNS = 3
  private readonly TOP_LEVEL_AGENT_READONLY_ADVISORY_WATERMARK = 0.72
  private readonly TOP_LEVEL_AGENT_CONTINUATION_COMPLETION_THRESHOLD = 0.9
  private readonly TOP_LEVEL_AGENT_SUMMARY_MEMORY_LIMIT = 8
  private readonly TOOL_BATCH_SUMMARY_DETAILS_LIMIT = 6
  private readonly LEGACY_WEB_DOCUMENT_CHUNK_SIZE = 4_000
  private readonly MAX_LEGACY_WEB_DOCUMENTS_PER_CONVERSATION = 12
  private readonly EMPTY_CONTEXT_ATTACHMENT_SNAPSHOT: ContextAttachmentSnapshot =
    {
      readPaths: [],
      fileStates: [],
      todos: [],
    }
  private readonly legacyWebDocumentsByConversation = new Map<
    string,
    Map<string, LegacyWebDocument>
  >()
  private readonly syntheticCodexAgents = new Map<
    string,
    SyntheticCodexAgentState
  >()
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
    private readonly toolExecutionCoordinator: ToolExecutionCoordinatorService,
    private readonly grpcService: CursorGrpcService,
    private readonly googleService: GoogleService,
    private readonly imageGenerationService: ImageGenerationService,
    private readonly codexService: CodexService,
    private readonly anthropicApiService: AnthropicApiService,
    private readonly openaiCompatService: OpenaiCompatService,
    private readonly modelRouter: ModelRouterService,
    private readonly kvStorageService: KvStorageService,
    private readonly contextManager: ContextManagerService,
    private readonly contextCompactRunner: ContextCompactRunnerService,
    private readonly codexContextAdapter: CodexContextAdapterService,
    private readonly contextRequestPlanner: ContextRequestPlannerService,
    private readonly contextNativeManagement: ContextNativeManagementService,
    private readonly contextPipeline: ContextPipelineService,
    private readonly clientSideToolV2Executor: ClientSideToolV2ExecutorService,
    private readonly semanticSearchProvider: SemanticSearchProviderService,
    private readonly tokenCounter: TokenCounterService,
    private readonly toolIntegrity: ToolIntegrityService,
    private readonly knowledgeBaseService: KnowledgeBaseService,
    private readonly kiroService: KiroService,
    private readonly cursorSkillsManager: CursorSkillsManager,
    private readonly subagentRegistry: SubagentRegistryService,
    private readonly subagentExecBridge: SubagentExecBridgeService,
    private readonly subagentBackgroundWorker: SubagentBackgroundWorker,
    private readonly subagentTaskRegistry: SubagentTaskRegistry,
    private readonly subagentTranscriptStore: SubagentTranscriptStore,
    private readonly contextHookExecutor: ContextHookExecutorService,
    private readonly toolResultStorage: ToolResultStorageService,
    private readonly webSearchService: WebSearchService
  ) {
    // Register provider adapter cleanup on session expiry/deletion.
    // This ensures provider resources (Codex WS connections, warmup caches) are released.
    this.sessionManager.registerSessionCleanupHandler(
      (conversationId, session) => {
        const backend = session.lastAssistantBackend
        if (backend) {
          this.resolveProviderAdapter(backend)?.dispose(conversationId)
        }
      }
    )
  }

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
    try {
      while (!done) {
        // 启动一次 next() 获取后端数据
        const dataPromise = iterator.next()

        // 循环等待，期间每隔 intervalMs 发送心跳
        let resolved = false
        while (!resolved) {
          let timeoutId: NodeJS.Timeout | undefined
          const timer = new Promise<"timeout">((resolve) => {
            timeoutId = setTimeout(() => resolve("timeout"), intervalMs)
          })

          const race = await Promise.race([
            dataPromise.then((r) => ({ source: "data" as const, result: r })),
            timer.then((t) => ({ source: t })),
          ])
          if (timeoutId) {
            clearTimeout(timeoutId)
          }

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
            const now = Date.now()
            if (now - this.lastHeartbeatLog > this.HEARTBEAT_LOG_INTERVAL) {
              this.logger.debug(
                "Sending keepalive heartbeat while waiting for backend (logging once per minute)"
              )
              this.lastHeartbeatLog = now
            }
            yield { type: "heartbeat" as const }
          }
        }
      }
    } finally {
      if (!done && typeof iterator.return === "function") {
        try {
          await iterator.return()
        } catch {
          // Ignore cleanup errors from upstream iterators.
        }
      }
    }
  }

  /**
   * Handle exec-level control messages from Cursor client.
   * - `execStreamClose`: informational, does not finalize pending tool calls.
   * - `execThrow`: client-side abort; finalize in-flight tool calls and end the aborted turn.
   */
  private buildAbortedToolResultRequest(
    session: ChatSession,
    toolCallId: string,
    toolType: number,
    content: string,
    message: string
  ): ParsedCursorRequest {
    return {
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
          toolCallId,
          toolType,
          resultCase: "mcp_result",
          resultData: Buffer.alloc(0),
          inlineContent: content,
          inlineState: {
            status: "aborted",
            message,
          },
        },
      ],
    }
  }

  private buildClientToolErrorResultRequest(
    session: ChatSession,
    toolCallId: string,
    toolType: number,
    content: string,
    message: string
  ): ParsedCursorRequest {
    return {
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
          toolCallId,
          toolType,
          resultCase: "mcp_result",
          resultData: Buffer.alloc(0),
          inlineContent: content,
          inlineState: {
            status: "error",
            message,
          },
        },
      ],
    }
  }

  private shouldReturnExecThrowToModel(
    pendingToolCall: PendingToolCall
  ): boolean {
    const normalizedToolName = pendingToolCall.toolName.trim().toLowerCase()
    const normalizedHistoryToolName = (pendingToolCall.historyToolName || "")
      .trim()
      .toLowerCase()

    return (
      pendingToolCall.toolFamilyHint === "mcp" ||
      normalizedToolName === "client_side_tool_v2_mcp" ||
      normalizedToolName === "client_side_tool_v2_call_mcp_tool" ||
      normalizedHistoryToolName.startsWith("cursor-ide-") ||
      normalizedHistoryToolName.startsWith("user-")
    )
  }

  private isTaskLikePendingToolCall(
    pendingToolCall: PendingToolCall | undefined
  ): boolean {
    if (!pendingToolCall) return false
    const family = this.normalizeDeferredToolFamily(pendingToolCall.toolName)
    return family === "task" || family === "await_task"
  }

  private buildRuntimeInterruptedRecovery(
    reason: string,
    interruptedToolCalls: InterruptedToolCallInfo[],
    interruptedSubAgent?: SessionRestartRecovery["interruptedSubAgent"]
  ): SessionRestartRecovery {
    const trimmedReason = reason.trim() || "connection closed"
    const sampleNames = interruptedToolCalls
      .slice(0, 3)
      .map((toolCall) => toolCall.toolName || toolCall.toolCallId)
    let notice =
      `The previous turn was interrupted before all tool results were received.` +
      `\nreason: ${trimmedReason}`

    if (sampleNames.length > 0) {
      notice += `\ninterrupted tools: ${sampleNames.join(", ")}`
      if (interruptedToolCalls.length > sampleNames.length) {
        notice += `, +${interruptedToolCalls.length - sampleNames.length} more`
      }
    }

    if (interruptedSubAgent) {
      notice += `\ninterrupted sub-agent: ${interruptedSubAgent.subagentId}`
    }

    return {
      restoredAt: new Date(),
      notice,
      interruptedToolCalls,
      interruptedInteractionQueryCount: 0,
      interruptedSubAgent,
    }
  }

  private interruptPendingToolCallsForRecovery(
    conversationId: string,
    toolCallIds: string[],
    reason: string
  ): number {
    const session = this.sessionManager.getSession(conversationId)
    if (!session || toolCallIds.length === 0) return 0

    const uniqueToolCallIds = Array.from(
      new Set(
        toolCallIds
          .map((toolCallId) =>
            typeof toolCallId === "string" ? toolCallId.trim() : ""
          )
          .filter(Boolean)
      )
    )
    if (uniqueToolCallIds.length === 0) return 0

    const interruptedToolCalls: InterruptedToolCallInfo[] = []
    let interruptedSubAgent: SessionRestartRecovery["interruptedSubAgent"]
    // Sub-agent ids whose state machine we tear down at the end of this
    // sweep. Built up per-toolCallId so we only kill the sub-agents
    // whose pending work was actually interrupted, leaving any sibling
    // sub-agent (running concurrently from the same parent batch)
    // untouched.
    const interruptedSubagentIds = new Set<string>()

    for (const toolCallId of uniqueToolCallIds) {
      const pendingToolCall = session.pendingToolCalls.get(toolCallId)
      if (!pendingToolCall) continue

      interruptedToolCalls.push({
        toolCallId: pendingToolCall.toolCallId,
        toolName: pendingToolCall.toolName,
        sentAt: pendingToolCall.sentAt,
      })

      // Resolve the owning sub-agent. Try parent-tool-call first
      // (matches the `task` envelope), then subagent-owner (inner
      // tool call dispatched on behalf of a sub-agent), then a
      // toolCallId fallback that walks pendingToolCallIds /
      // currentTurnToolCalls of every active sub-agent.
      const ownerCtx =
        this.sessionManager.getSubAgentContextByToolCallId(
          conversationId,
          toolCallId
        ) ??
        (pendingToolCall.subagentOwner
          ? this.sessionManager.getSubAgentContextById(
              conversationId,
              pendingToolCall.subagentOwner
            )
          : undefined)
      if (ownerCtx) {
        interruptedSubagentIds.add(ownerCtx.subagentId)
        interruptedSubAgent = {
          subagentId: ownerCtx.subagentId,
          parentToolCallId: ownerCtx.parentToolCallId,
          turnCount: ownerCtx.turnCount,
          toolCallCount: ownerCtx.toolCallCount,
        }
      }

      // Sub-agent ExecServerMessage waiter: when this pending tool call
      // belongs to a sub-agent's LLM turn, the sub-agent worker is
      // currently `await`ing SubagentExecBridge.awaitResult. Reject that
      // promise NOW so the sub-agent loop unwinds and stops emitting
      // heartbeats forever. Without this, the heartbeat ticker
      // re-entered the await every 10s even after the BiDi stream that
      // could deliver the result was closed (see bash sub-agent timing
      // analysis from 2026-05-17 trace).
      if (pendingToolCall.subagentOwner) {
        this.subagentExecBridge.rejectToolCall(
          toolCallId,
          new Error(`sub-agent exec aborted: ${reason}`)
        )
      }

      this.sessionManager.clearPendingToolCall(
        conversationId,
        toolCallId,
        `interrupted: ${reason}`
      )
    }

    if (interruptedToolCalls.length === 0) {
      return 0
    }

    // Record an "interrupted" session-memory breadcrumb for each
    // sub-agent we are about to tear down, BEFORE clearing the
    // context — once the context is cleared we lose access to the
    // turn / tool-call counts. This is what keeps the parent agent
    // from re-spawning the same task on its next turn.
    for (const subagentId of interruptedSubagentIds) {
      const ctx = this.sessionManager.getSubAgentContextById(
        conversationId,
        subagentId
      )
      if (!ctx) continue
      this.recordAbortedSubAgentMemory(
        conversationId,
        ctx,
        "interrupted",
        reason
      )
    }

    // Tear down only the sub-agents we just interrupted; sibling
    // sub-agents from the same batch remain alive.
    for (const subagentId of interruptedSubagentIds) {
      this.sessionManager.clearSubAgentContext(conversationId, subagentId)
    }

    const refreshedSession = this.sessionManager.getSession(conversationId)
    if (refreshedSession) {
      this.repairInterruptedToolProtocol(
        refreshedSession,
        this.buildRuntimeInterruptedRecovery(
          reason,
          interruptedToolCalls,
          interruptedSubAgent
        )
      )
    }

    this.logger.warn(
      `Interrupted ${interruptedToolCalls.length} pending tool call(s) for recovery: ` +
        `${interruptedToolCalls.map((toolCall) => toolCall.toolName || toolCall.toolCallId).join(", ")}`
    )
    return interruptedToolCalls.length
  }

  private isSubAgentAbortError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /sub-agent (exec )?(aborted|cancelled)|conversation cancelled|new user turn arrived/i.test(
      message
    )
  }

  private cancelActiveForegroundSubAgent(
    conversationId: string,
    reason: string,
    options?: {
      targetSubagentId?: string
      includeBackground?: boolean
    }
  ): number {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) return 0

    // Pick which sub-agents to cancel:
    //   - targetSubagentId set → just that one (no-op when not active)
    //   - otherwise → every foreground sub-agent (skipping backgrounded
    //     entries unless includeBackground is set)
    const candidates: SubAgentContext[] = []
    if (options?.targetSubagentId) {
      const ctx = this.sessionManager.getSubAgentContextById(
        conversationId,
        options.targetSubagentId
      )
      if (!ctx) return 0
      if (ctx.isBackground && !options.includeBackground) return 0
      candidates.push(ctx)
    } else {
      for (const ctx of this.sessionManager.listSubAgentContexts(
        conversationId
      )) {
        if (ctx.isBackground && !options?.includeBackground) continue
        candidates.push(ctx)
      }
    }
    if (candidates.length === 0) return 0

    let totalCleared = 0
    for (const ctx of candidates) {
      const ownedPendingIds = Array.from(session.pendingToolCalls.values())
        .filter(
          (pending) =>
            pending.subagentOwner === ctx.subagentId ||
            pending.toolCallId === ctx.parentToolCallId
        )
        .map((pending) => pending.toolCallId)

      // Reject every Exec waiter the sub-agent had outstanding so its
      // worker loop unwinds (rejectToolCall is keyed by toolCallId so
      // we cannot use the conversation-wide `rejectConversation` —
      // that would also break sibling sub-agents we're not cancelling).
      for (const toolCallId of ownedPendingIds) {
        this.subagentExecBridge.rejectToolCall(
          toolCallId,
          new Error(`sub-agent cancelled: ${reason}`)
        )
        this.sessionManager.clearPendingToolCall(
          conversationId,
          toolCallId,
          `sub-agent cancelled: ${reason}`
        )
      }
      this.recordAbortedSubAgentMemory(conversationId, ctx, "cancelled", reason)
      this.sessionManager.clearSubAgentContext(conversationId, ctx.subagentId)
      this.logger.warn(
        `Cancelled sub-agent ${ctx.subagentId}: cleared ${ownedPendingIds.length} pending tool call(s)`
      )
      totalCleared += ownedPendingIds.length
    }
    return totalCleared
  }

  private async *abortPendingToolCallsOnStream(
    conversationId: string,
    session: ChatSession,
    streamId: string,
    reason: string,
    options?: {
      primaryToolCallId?: string
      primaryToolType?: number
      primaryContent?: string
      siblingContent?: string
      siblingMessage?: string
    }
  ): AsyncGenerator<Buffer, number> {
    const pendingToolCallIds =
      this.sessionManager.getPendingToolCallIdsByStream(
        conversationId,
        streamId
      )
    let abortedCount = 0

    const taskLikeToolCallIds = pendingToolCallIds.filter((pendingToolCallId) =>
      this.isTaskLikePendingToolCall(
        session.pendingToolCalls.get(pendingToolCallId)
      )
    )
    if (taskLikeToolCallIds.length > 0) {
      abortedCount += this.interruptPendingToolCallsForRecovery(
        conversationId,
        taskLikeToolCallIds,
        reason
      )
    }

    for (const pendingToolCallId of pendingToolCallIds) {
      if (taskLikeToolCallIds.includes(pendingToolCallId)) continue
      if (!session.pendingToolCalls.has(pendingToolCallId)) continue

      const isPrimary =
        pendingToolCallId === options?.primaryToolCallId &&
        typeof options.primaryContent === "string"
      const syntheticParsed = this.buildAbortedToolResultRequest(
        session,
        pendingToolCallId,
        isPrimary ? (options?.primaryToolType ?? 0) : 0,
        isPrimary
          ? options.primaryContent!
          : options?.siblingContent ||
              `Tool execution aborted by client.\nreason: ${reason}`,
        isPrimary ? reason : options?.siblingMessage || reason
      )

      yield* this.handleToolResult(conversationId, syntheticParsed, {
        continueGeneration: false,
        // The outer loop will feed an aborted result for every remaining
        // pending tool (including any queued edits on the same path), so
        // the per-consume picker must not dispatch a fresh readArgs onto
        // a stream the client has already torn down.
        dispatchNextQueuedEditOnConsume: false,
      })
      abortedCount++
    }

    return abortedCount
  }

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

    const reason = (parsed.agentControlError || "").trim()
    const stack = (parsed.agentControlStackTrace || "").trim()
    const safeReason = reason
      ? reason.slice(0, 800)
      : "execution aborted by client"

    const resolvedToolCallId = mappedToolCallId
    if (!resolvedToolCallId) {
      const currentStreamPendingIds =
        this.sessionManager.getPendingToolCallIdsByStream(
          conversationId,
          session.currentStreamId
        )
      const reasonSummary =
        `execThrow id=${execNumericId} has no mapped pending toolCallId ` +
        `(pending=${currentStreamPendingIds.length ? currentStreamPendingIds.join(", ") : "(none)"})`
      if (currentStreamPendingIds.length === 0) {
        this.logger.warn(reasonSummary)
        return true
      }

      this.logger.warn(
        `Exec throw without mapping; aborting ${currentStreamPendingIds.length} pending tool call(s) on current stream`
      )
      yield* this.abortPendingToolCallsOnStream(
        conversationId,
        session,
        session.currentStreamId,
        reasonSummary
      )
      return true
    }

    const pendingToolCall = session.pendingToolCalls.get(resolvedToolCallId)
    if (!pendingToolCall) {
      this.logger.warn(
        `Exec throw mapped tool call not pending anymore: execId=${execNumericId}, toolCallId=${resolvedToolCallId}`
      )
      return true
    }

    const abortedStreamId = pendingToolCall.streamId
    if (this.isTaskLikePendingToolCall(pendingToolCall)) {
      this.interruptPendingToolCallsForRecovery(
        conversationId,
        [pendingToolCall.toolCallId],
        safeReason
      )

      const remainingIds = this.sessionManager.getPendingToolCallIdsByStream(
        conversationId,
        abortedStreamId
      )
      if (remainingIds.length === 0) {
        this.logger.log(
          `Exec throw converted task interruption into recovery state for ${conversationId}`
        )
        return true
      }

      this.logger.warn(
        `Exec throw for task-like tool ${pendingToolCall.toolCallId} left ${remainingIds.length} pending tool call(s) on aborted stream; draining siblings`
      )
      yield* this.abortPendingToolCallsOnStream(
        conversationId,
        session,
        abortedStreamId,
        safeReason
      )
      return true
    }

    const toolResultContent = stack
      ? `Tool execution aborted by client.\nreason: ${safeReason}\nstack: ${stack.slice(0, 2000)}`
      : `Tool execution aborted by client.\nreason: ${safeReason}`

    if (this.shouldReturnExecThrowToModel(pendingToolCall)) {
      const toolLabel =
        pendingToolCall.historyToolName || pendingToolCall.toolName
      const recoverableContent = stack
        ? `[client_tool error] ${toolLabel} failed in Cursor client.\nreason: ${safeReason}\nstack: ${stack.slice(0, 2000)}\nDo not retry this exact client tool unless the required Cursor-side capability is available.`
        : `[client_tool error] ${toolLabel} failed in Cursor client.\nreason: ${safeReason}\nDo not retry this exact client tool unless the required Cursor-side capability is available.`
      this.logger.warn(
        `Exec throw from recoverable client tool ${toolLabel}; returning error to model instead of aborting turn`
      )
      yield* this.handleToolResult(
        conversationId,
        this.buildClientToolErrorResultRequest(
          session,
          pendingToolCall.toolCallId,
          execNumericId,
          recoverableContent,
          safeReason
        ),
        {
          continueGeneration: true,
        }
      )

      const sessionAfterRecoverableError =
        this.sessionManager.getSession(conversationId)
      if (!this.hasPendingStreamWork(sessionAfterRecoverableError)) {
        this.logger.log(
          `Recoverable client tool error handled for conversation ${conversationId}; ending stream after model continuation`
        )
        return true
      }
      return false
    }

    yield* this.handleToolResult(
      conversationId,
      this.buildAbortedToolResultRequest(
        session,
        pendingToolCall.toolCallId,
        execNumericId,
        toolResultContent,
        safeReason
      ),
      {
        continueGeneration: false,
        // execThrow drains every pending tool call on the stream via
        // abortPendingToolCallsOnStream; queued edits on the same path will
        // be aborted by that loop too. Suppress the per-consume picker so
        // we don't re-dispatch readArgs onto a stream the client already
        // tore down.
        dispatchNextQueuedEditOnConsume: false,
      }
    )

    const remainingIds = this.sessionManager.getPendingToolCallIdsByStream(
      conversationId,
      abortedStreamId
    )
    if (remainingIds.length === 0) {
      this.logger.log(
        `Exec throw finalized aborted turn for conversation ${conversationId}`
      )
      return true
    }

    this.logger.warn(
      `Exec throw for ${pendingToolCall.toolCallId} left ${remainingIds.length} pending tool call(s) on aborted stream; draining them`
    )
    yield* this.abortPendingToolCallsOnStream(
      conversationId,
      session,
      abortedStreamId,
      "sibling tool call was aborted, draining remaining pending calls"
    )
    this.logger.log(
      `All pending tool calls on aborted stream drained after exec throw for ${pendingToolCall.toolCallId}`
    )
    return true
  }

  private async *handleConversationCancelAction(
    conversationId: string,
    parsed: ParsedCursorRequest
  ): AsyncGenerator<Buffer, boolean> {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) {
      this.logger.warn(
        `Cancel action received for unknown conversation: ${conversationId}`
      )
      return true
    }

    const rawReason = (parsed.agentControlError || "").trim()
    const safeReason = rawReason
      ? rawReason.slice(0, 800)
      : "conversation cancelled by client"
    const cancelledSubAgentPendingCount = this.cancelActiveForegroundSubAgent(
      conversationId,
      safeReason
    )
    const pendingIds = this.sessionManager.getPendingToolCallIdsByStream(
      conversationId,
      session.currentStreamId
    )

    this.logger.warn(
      `Cancel action received for conversation ${conversationId}: reason=${safeReason}, ` +
        `pendingCurrentStream=${pendingIds.length}, cancelledSubAgentPending=${cancelledSubAgentPendingCount}`
    )

    if (pendingIds.length === 0) {
      return true
    }

    yield* this.abortPendingToolCallsOnStream(
      conversationId,
      session,
      session.currentStreamId,
      safeReason
    )
    this.logger.log(
      `Cancel action finalized ${pendingIds.length} pending tool call(s) on current stream`
    )
    return true
  }

  /**
   * Handle a `ConversationAction.summarizeAction` from the IDE.
   *
   * The IDE fires this when the user explicitly asks to summarise the
   * conversation (Composer's "Summarise Conversation" command-palette
   * entry). The proto message itself is empty — it is purely a control
   * signal. The bridge owns the actual compaction algorithm
   * (`ContextManagerService.manualCompact` → `ContextCompactionService`),
   * so the IDE has no state to send; it just delegates the trigger.
   *
   * Pipeline:
   *   1. Resolve the session and its compaction-relevant state.
   *   2. Run the bridge's manual compaction with a tight synthetic
   *      budget so the planner always commits a boundary even when
   *      the transcript is comfortably below the model's context cap.
   *      This matches what the dashboard `Post /api/context/compact`
   *      does for the Diagnostics tab.
   *   3. If a commit lands, queue the summary into
   *      `pendingContextSummaryUiUpdate` so the next outbound frame
   *      window streams summaryStarted → summaryUpdate(text) →
   *      summaryCompleted to the IDE. We yield those three frames
   *      eagerly here too so the user sees the summary appear without
   *      waiting for the next user turn.
   *   4. If the planner returned no progress (transcript too small to
   *      compact), we silently bail — the user will see nothing change
   *      in the IDE, which matches the dashboard endpoint's behaviour.
   *
   * Returns `true` to mean "this control message ended the BiDi window";
   * the parent dispatcher will close the response stream after we
   * return.
   *
   * Architectural note: cursor IDE itself has its own `summarizeAction`
   * handler that runs in `cursor-agent-exec` (the official agent
   * runtime). When that runtime is in charge it does its own compaction
   * and emits its own summary lifecycle. In the agent-vibes deployment
   * cursor-agent-exec is bypassed (the bridge is the agent runtime),
   * so we own the entire compaction pipeline here. This is the
   * "client-has-it-bridge-skips, client-doesnt-bridge-handles" rule
   * applied to compaction: the bridge only fires when nobody else owns
   * the conversation's transcript.
   */
  private async *handleConversationSummarizeAction(
    conversationId: string
  ): AsyncGenerator<Buffer, boolean> {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) {
      this.logger.warn(
        `Summarize action received for unknown conversation: ${conversationId}`
      )
      return true
    }

    // The IDE-driven "summarise now" flow expects a fresh boundary
    // commit even when the transcript is well within budget. A tight
    // 4 000-token synthetic budget guarantees the planner picks up the
    // squeeze; operators wanting different behaviour can use the
    // dashboard endpoint with a custom `maxTokens`. Mirrors
    // `ContextController.manualCompact` defaults so both entry points
    // produce the same shape of commit.
    const MANUAL_SUMMARIZE_BUDGET = 4_000

    let applied: Awaited<
      ReturnType<ContextCompactRunnerService["compactIfNeeded"]>
    >
    let hookUserMessage: string | undefined
    try {
      const route = this.modelRouter.resolveModel(session.model)
      const manualBudget = {
        maxTokens: MANUAL_SUMMARIZE_BUDGET,
        systemPromptTokens: 0,
      }
      if (route.backend === "codex") {
        const promptContext = this.buildPromptContextFromSession(session)
        const systemPrompt = this.buildCodexSystemPrompt(
          promptContext,
          session.deferredToolCatalog
        )
        const referenceContextItem =
          this.codexContextAdapter.buildReferenceContextItem({
            conversationId,
            model: route.model || session.model,
            systemPrompt,
            contextTokenLimit: manualBudget.maxTokens,
            serviceTier: this.resolveRequestedCodexServiceTier(
              session.requestedModelParameters
            ),
            reasoningEffort: this.resolveRequestedReasoningEffort(
              session.requestedModelParameters
            ),
          })
        applied = await this.codexContextAdapter.compactIfNeeded(
          session.contextState,
          this.buildContextAttachmentSnapshot(session),
          {
            ...manualBudget,
            strategy: "manual",
            referenceContextItem,
            injectionMode: "pre_turn",
            hookProvider: async (candidate) => {
              hookUserMessage = await this.runPreCompactHookForCandidate(
                session,
                "manual",
                route,
                manualBudget,
                candidate
              )
              return hookUserMessage
            },
            remoteCompactProvider: async ({ messages }) => ({
              replacementHistory:
                await this.codexService.compactConversationHistory({
                  model: route.model || session.model,
                  system: systemPrompt,
                  messages: this.toCodexConversationMessages(messages),
                  conversationId,
                  serviceTier: this.resolveRequestedCodexServiceTier(
                    session.requestedModelParameters
                  ),
                  textVerbosity: "low",
                }),
            }),
          }
        )
      } else {
        applied = await this.contextCompactRunner.compactIfNeeded(
          session.contextState,
          this.buildContextAttachmentSnapshot(session),
          {
            ...manualBudget,
            strategy: "manual",
            integrityMode: this.shouldUseStrictAdjacentToolIntegrity(
              route.backend
            )
              ? "strict-adjacent"
              : "global",
            summaryProvider: this.buildNoToolsCompactSummaryProvider(
              route,
              session,
              `manual summarize: ${conversationId}`
            ),
            hookProvider: async (candidate) => {
              hookUserMessage = await this.runPreCompactHookForCandidate(
                session,
                "manual",
                route,
                manualBudget,
                candidate
              )
              return hookUserMessage
            },
          }
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(
        `Summarize action failed for ${conversationId}: ${message}`
      )
      return true
    }

    if (!applied) {
      this.logger.log(`Summarize action: no_progress for ${conversationId}`)
      return true
    }

    this.sessionManager.markContextStateDirty(conversationId)
    this.logger.warn(
      `Summarize action applied for ${conversationId}: ` +
        `commit=${applied.commit.id} ` +
        `archived=${applied.commit.archivedMessageCount} ` +
        `summary=${applied.commit.summaryTokenCount} tokens` +
        (hookUserMessage ? " (with preCompact hook)" : "")
    )

    const renderedSummary = hookUserMessage
      ? `${hookUserMessage}\n\n${applied.commit.summary}`
      : applied.commit.summary

    // Queue the summary lifecycle so any later turn that runs through
    // `emitPendingContextSummaryUiUpdate` will pick it up. We also
    // yield the three frames eagerly right here so the IDE updates its
    // chat view immediately rather than waiting for the next user
    // message to start.
    this.queuePendingContextSummaryUiUpdate(session, conversationId, {
      compactionId: applied.commit.id,
      summary: renderedSummary,
      epoch: session.contextState.compactionEpoch || 0,
    })
    yield* this.emitPendingContextSummaryUiUpdate(conversationId)
    return true
  }

  async compactConversationNow(
    conversationId: string,
    maxTokens: number
  ): Promise<{
    applied: boolean
    estimatedTokens?: number
    archivedMessageCount?: number
    summaryTokenCount?: number
  }> {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) {
      throw new Error(`Session not found: ${conversationId}`)
    }
    const route = this.modelRouter.resolveModel(session.model)
    let hookUserMessage: string | undefined
    const manualBudget = { maxTokens, systemPromptTokens: 0 }
    const plan =
      route.backend === "codex"
        ? await this.compactCodexSessionForRoute(session, route, manualBudget, {
            contextLabel: `manual compact api: ${conversationId}`,
            strategy: "manual",
            injectionMode: "pre_turn",
            hookProvider: async (candidate) => {
              hookUserMessage = await this.runPreCompactHookForCandidate(
                session,
                "manual",
                route,
                manualBudget,
                candidate
              )
              return hookUserMessage
            },
          })
        : await this.contextCompactRunner.compactIfNeeded(
            session.contextState,
            this.buildContextAttachmentSnapshot(session),
            {
              ...manualBudget,
              strategy: "manual",
              integrityMode: this.shouldUseStrictAdjacentToolIntegrity(
                route.backend
              )
                ? "strict-adjacent"
                : "global",
              summaryProvider: this.buildNoToolsCompactSummaryProvider(
                route,
                session,
                `manual compact api: ${conversationId}`
              ),
              hookProvider: async (candidate) => {
                hookUserMessage = await this.runPreCompactHookForCandidate(
                  session,
                  "manual",
                  route,
                  manualBudget,
                  candidate
                )
                return hookUserMessage
              },
            }
          )
    if (!plan) {
      return { applied: false }
    }
    this.sessionManager.markContextStateDirty(conversationId)
    const renderedSummary = hookUserMessage
      ? `${hookUserMessage}\n\n${plan.commit.summary}`
      : plan.commit.summary
    this.queuePendingContextSummaryUiUpdate(session, conversationId, {
      compactionId: plan.commit.id,
      summary: renderedSummary,
      epoch: session.contextState.compactionEpoch || 0,
    })
    return {
      applied: true,
      estimatedTokens: plan.estimatedTokens,
      archivedMessageCount: plan.commit.archivedMessageCount,
      summaryTokenCount: plan.commit.summaryTokenCount,
    }
  }

  private async *handleBackgroundShellAction(
    conversationId: string,
    parsed: ParsedCursorRequest
  ): AsyncGenerator<Buffer, boolean> {
    const session = this.sessionManager.getSession(conversationId)
    const toolCallId = parsed.agentControlToolCallId?.trim() || ""
    if (!session || !toolCallId) {
      this.logger.warn(
        `Background shell action ignored: conversation=${conversationId}, toolCallId=${toolCallId || "(none)"}`
      )
      return false
    }

    const pendingToolCall = session.pendingToolCalls.get(toolCallId)
    const existingBackground =
      this.sessionManager.findBackgroundCommandByToolCallId(
        conversationId,
        toolCallId
      )
    if (!pendingToolCall) {
      if (existingBackground) {
        this.logger.debug(
          `Background shell action already applied: ${conversationId} toolCallId=${toolCallId}`
        )
      } else {
        this.logger.warn(
          `Background shell action referenced non-pending toolCallId=${toolCallId}`
        )
      }
      return false
    }

    const firstExecId = Array.from(pendingToolCall.execIds)[0]
    const commandId =
      existingBackground?.commandId ||
      (typeof firstExecId === "number" ? String(firstExecId) : toolCallId)
    const backgroundCommand =
      existingBackground ||
      this.sessionManager.markPendingShellToolBackgrounded(
        conversationId,
        toolCallId,
        commandId
      )
    if (!backgroundCommand) {
      this.logger.warn(
        `Failed to background shell tool call: ${conversationId} toolCallId=${toolCallId}`
      )
      return false
    }

    const shellOutput = this.sessionManager.getShellOutput(
      conversationId,
      toolCallId
    )
    const stdout = shellOutput?.stdout || backgroundCommand.stdout.join("")
    const stderr = shellOutput?.stderr || backgroundCommand.stderr.join("")
    const combinedOutput =
      `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim()
    const numericShellId = Number(backgroundCommand.commandId)

    yield* this.emitInlineToolResult(
      conversationId,
      toolCallId,
      combinedOutput ||
        `Command running in background (CommandId: ${backgroundCommand.commandId})`,
      { status: "success" },
      undefined,
      undefined,
      {
        shellResult: {
          stdout,
          stderr,
          shellId: Number.isFinite(numericShellId)
            ? Math.floor(numericShellId)
            : undefined,
          pid: backgroundCommand.pid,
          terminalsFolder: backgroundCommand.terminalsFolder,
          isBackground: true,
          msToWait: backgroundCommand.msToWait,
          backgroundReason: backgroundCommand.backgroundReason,
        },
      }
    )

    this.logger.log(
      `Background shell action settled parent tool: ${conversationId} toolCallId=${toolCallId} commandId=${backgroundCommand.commandId}`
    )
    return false
  }

  /**
   * Handle a `ConversationAction.asyncAskQuestionCompletionAction` from the IDE.
   *
   * Path: when the agent calls `ask_question(run_async=true)`, the bridge
   * settles the synchronous `partialToolCall` with an `AskQuestionResult.async`
   * placeholder, releasing the agent turn early. The user later answers in
   * the IDE's queued-question UI, and the IDE sends this ConversationAction
   * carrying the original toolCallId, original args, and the actual result
   * (`success` with answers / `rejected` with reason / `error`).
   *
   * Without a handler, two things break:
   *   1. The IDE's "Queued" panel never clears, because nothing on the
   *      bridge side acknowledges that the action was consumed.
   *   2. The agent's conversation history has no record of what the user
   *      actually answered — only the `[ask_question async] waiting…`
   *      placeholder from the original sync settlement.
   *
   * This handler emits an `userMessageAppended` interaction update
   * carrying a textual rendering of the user's answer, which:
   *   - is the IDE-canonical signal that the queued question is consumed
   *     (so the "1 Queued" indicator clears), and
   *   - lets the IDE chat view render the user's response in-line so
   *     subsequent agent turns can see it.
   */
  private async *handleAsyncAskQuestionCompletionAction(
    conversationId: string,
    parsed: ParsedCursorRequest,
    streamId?: string
  ): AsyncGenerator<Buffer, boolean> {
    const completion = parsed.agentControlAsyncAskCompletion
    const toolCallId =
      completion?.originalToolCallId ||
      parsed.agentControlToolCallId?.trim() ||
      ""

    if (!completion) {
      this.logger.warn(
        `Async ask completion missing structured payload: conversation=${conversationId} toolCallId=${toolCallId || "(none)"}`
      )
      return false
    }

    const renderedAnswer = this.renderAsyncAskCompletionAnswer(completion)

    const messageId = `async_ask_completion_${
      toolCallId || crypto.randomUUID()
    }`

    this.logger.log(
      `ConversationAction.asyncAskQuestionCompletion settled: ${conversationId} toolCallId=${
        toolCallId || "(none)"
      } case=${completion.resultCase} answers=${
        completion.answers?.length ?? 0
      }`
    )

    yield this.grpcService.createUserMessageAppendedResponse(
      renderedAnswer,
      messageId
    )

    // Clear the IDE's "Queued" badge for this question.
    // ─────────────────────────────────────────────────
    // The original `ask_question(run_async=true)` tool call was already
    // sync-settled with an `AskQuestionResult.async` placeholder when the
    // agent turn ended. That placeholder is what the IDE renders as the
    // "1 Queued · Question responses queued" indicator at the top of the
    // conversation. The placeholder has no expiry — without an explicit
    // protocol signal that the question is now resolved, the indicator
    // never disappears, even after the user has actually answered.
    //
    // The IDE's queued list is keyed by the original `toolCallId`, and
    // its bookkeeping is monotonic (latest result wins). So we re-emit a
    // `toolCallCompleted(askQuestionToolCall)` carrying the same toolCall
    // Id, but with the *real* result (`success`/`rejected`/`error`)
    // instead of `async`. The IDE merges this into the queued state and
    // drops the badge. On builds that already cleared the badge from the
    // userMessageAppended above, this is a harmless no-op (the bubble
    // result section just refreshes from `async (waiting)` to whatever
    // the user actually picked).
    if (toolCallId) {
      const completedFrame = this.buildAskQuestionAsyncCompletedFrame(
        toolCallId,
        completion
      )
      if (completedFrame) {
        yield completedFrame
      }
    }

    return yield* this.continueAgentFromControlUserMessage(
      conversationId,
      parsed,
      renderedAnswer,
      streamId,
      "async ask completion"
    )
  }

  private renderAsyncAskCompletionAnswer(
    completion: NonNullable<
      ParsedCursorRequest["agentControlAsyncAskCompletion"]
    >
  ): string {
    switch (completion.resultCase) {
      case "success": {
        const parts: string[] = []
        for (const a of completion.answers || []) {
          const segments: string[] = []
          if (a.selectedOptionIds.length > 0) {
            segments.push(a.selectedOptionIds.join(", "))
          }
          if (a.freeformText && a.freeformText.length > 0) {
            segments.push(a.freeformText)
          }
          const rendered = segments.join(" — ").trim()
          if (rendered) {
            parts.push(a.questionId ? `${a.questionId}: ${rendered}` : rendered)
          }
        }
        if (parts.length === 0) {
          return "[ask_question answered]"
        }
        return `[ask_question answered] ${parts.join(" | ")}`
      }
      case "rejected":
        return `[ask_question rejected] ${
          completion.rejectedReason || "(no reason)"
        }`
      case "error":
        return `[ask_question error] ${
          completion.errorMessage || "(no message)"
        }`
      case "async":
        return "[ask_question async] (still pending)"
      default:
        return "[ask_question answered] (unknown result)"
    }
  }

  private buildControlContinuationRequest(
    session: ChatSession,
    parsed: ParsedCursorRequest,
    newMessage: string
  ): ParsedCursorRequest {
    return {
      ...parsed,
      conversation: [],
      newMessage,
      model: parsed.model?.trim() || session.model,
      thinkingLevel: session.thinkingLevel,
      thinkingDetailsRequested: session.thinkingDetailsRequested,
      unifiedMode: "AGENT",
      isAgentic: true,
      supportedTools: session.supportedTools || [],
      useWeb: session.useWeb,
      conversationId: session.conversationId,
      projectContext: session.projectContext,
      codeChunks: session.codeChunks,
      cursorRules: session.cursorRules,
      selectedCursorRulePaths: session.selectedCursorRulePaths,
      selectedCursorRuleNames: session.selectedCursorRuleNames,
      cursorCommands: session.cursorCommands,
      customSystemPrompt: session.customSystemPrompt,
      explicitContext: session.explicitContext,
      contextTokenLimit: session.contextTokenLimit,
      contextMaxMode: session.contextMaxMode,
      usedContextTokens: session.usedContextTokens,
      requestedMaxOutputTokens: session.requestedMaxOutputTokens,
      requestedModelParameters: session.requestedModelParameters,
      requestContextEnv: session.requestContextEnv,
      attachedImages: [],
      toolResults: [],
      isAgentControlMessage: false,
      agentControlType: undefined,
      mcpToolDefs: session.mcpToolDefs,
    }
  }

  private async *continueAgentFromControlUserMessage(
    conversationId: string,
    parsed: ParsedCursorRequest,
    newMessage: string,
    streamId: string | undefined,
    reason: string
  ): AsyncGenerator<Buffer, boolean> {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) {
      this.logger.warn(
        `Cannot continue from ${reason}: session not found (${conversationId})`
      )
      return false
    }
    if (!newMessage.trim()) {
      this.logger.warn(
        `Cannot continue from ${reason}: empty synthetic user message (${conversationId})`
      )
      return false
    }

    this.logger.log(
      `Continuing agent from ${reason}: conversation=${conversationId}`
    )
    const continuationParsed = this.buildControlContinuationRequest(
      session,
      parsed,
      newMessage
    )
    yield* this.handleChatMessage(conversationId, continuationParsed, streamId)

    const sessionAfter = this.sessionManager.getSession(conversationId)
    if (this.hasPendingStreamWork(sessionAfter)) {
      this.logger.log(
        `Control continuation waiting for ${this.describePendingStreamWork(
          sessionAfter
        )}`
      )
      return false
    }
    return true
  }

  /**
   * Builds a `toolCallCompleted(askQuestionToolCall)` frame that
   * "upgrades" a previously-async `ask_question` placeholder into its
   * real terminal result. Returns `undefined` if we cannot construct a
   * useful frame (e.g. completion still nested-async).
   */
  private buildAskQuestionAsyncCompletedFrame(
    toolCallId: string,
    completion: NonNullable<
      ParsedCursorRequest["agentControlAsyncAskCompletion"]
    >
  ): Buffer | undefined {
    if (completion.resultCase === "async") {
      return undefined
    }

    type AskQuestionResultProjection = NonNullable<
      ParsedToolResult["inlineProjection"]
    >["askQuestionResult"]

    let projection: AskQuestionResultProjection
    let summaryContent: string
    let toolResultStatus: ToolResultStatus
    let toolResultMessage: string | undefined
    switch (completion.resultCase) {
      case "success": {
        const answers = (completion.answers || []).map((a) => ({
          questionId: a.questionId || "",
          selectedOptionIds: Array.isArray(a.selectedOptionIds)
            ? a.selectedOptionIds.filter(
                (id): id is string => typeof id === "string" && id.length > 0
              )
            : [],
          freeformText:
            typeof a.freeformText === "string" && a.freeformText.length > 0
              ? a.freeformText
              : undefined,
        }))
        projection = {
          resultCase: "success",
          answers,
        }
        summaryContent =
          answers.length > 0
            ? `[ask_question success] ${JSON.stringify(answers)}`
            : "[ask_question success]"
        toolResultStatus = "success"
        break
      }
      case "rejected": {
        const reason =
          completion.rejectedReason && completion.rejectedReason.length > 0
            ? completion.rejectedReason
            : "rejected"
        projection = {
          resultCase: "rejected",
          reason,
        }
        summaryContent = `[ask_question rejected] ${reason}`
        toolResultStatus = "rejected"
        toolResultMessage = reason
        break
      }
      case "error":
      default: {
        const errorMessage =
          completion.errorMessage && completion.errorMessage.length > 0
            ? completion.errorMessage
            : "ask_question failed"
        projection = {
          resultCase: "error",
          errorMessage,
        }
        summaryContent = `[ask_question error] ${errorMessage}`
        toolResultStatus = "error"
        toolResultMessage = errorMessage
        break
      }
    }

    return this.grpcService.createToolCallCompletedResponse(
      toolCallId,
      "ask_question",
      // Empty args object — the IDE keeps the args from the original
      // toolCallStarted frame; here we only care about `result`.
      {},
      summaryContent,
      // Let the grpc service derive the proto family from the toolName —
      // `ToolFamily` is private to cursor-grpc.service and not re-exported.
      undefined,
      "",
      {
        toolResultState: {
          status: toolResultStatus,
          message: toolResultMessage,
        },
        askQuestionResult: projection,
      }
    )
  }

  private async *handleBackgroundSubagentAction(
    conversationId: string,
    parsed: ParsedCursorRequest
  ): AsyncGenerator<Buffer, boolean> {
    const requestedToolCallId = parsed.agentControlToolCallId?.trim() || ""
    const subAgentCtx = this.sessionManager.markSubAgentBackgrounded(
      conversationId,
      requestedToolCallId || undefined
    )
    if (!subAgentCtx) {
      this.logger.warn(
        `Background subagent action ignored: conversation=${conversationId}, toolCallId=${requestedToolCallId || "(none)"}`
      )
      return false
    }

    if (
      !this.sessionManager
        .getSession(conversationId)
        ?.pendingToolCalls.has(subAgentCtx.parentToolCallId)
    ) {
      this.logger.debug(
        `Background subagent action already settled parent tool: ${conversationId} parentToolCallId=${subAgentCtx.parentToolCallId}`
      )
      return false
    }

    const durationMs = Date.now() - subAgentCtx.startTime
    yield* this.emitInlineToolResult(
      conversationId,
      subAgentCtx.parentToolCallId,
      `Sub-agent running in background (agentId: ${subAgentCtx.subagentId})`,
      { status: "success" },
      {
        taskSuccess: {
          agentId: subAgentCtx.subagentId,
          isBackground: true,
          durationMs,
        },
      }
    )

    this.logger.log(
      `Background subagent action settled parent tool: ${conversationId} subagentId=${subAgentCtx.subagentId}, parentToolCallId=${subAgentCtx.parentToolCallId}`
    )
    return false
  }

  private summarizeBackendError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return message.length > 200 ? `${message.slice(0, 200)}…` : message
  }

  private async *executeBackendStreamWithFallback(
    model: string,
    route: ModelRouteResult,
    attemptedBackends: Set<string> = new Set(),
    options?: BackendStreamOptions
  ): AsyncGenerator<string, void, unknown> {
    attemptedBackends.add(route.backend)
    // Buffer envelope events (message_start, ping) AND structural events
    // (content_block_start, content_block_stop) so we can discard them on
    // fallback.  Only once a content_block_delta arrives (i.e., actual
    // user-visible content has been streamed) do we flush & lock in.
    let emittedAny = false
    let buffer: string[] = []
    let activeHints: BackendStreamHints | undefined

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

    const recoveryKey =
      options?.recoveryKey ??
      `cursor:routed:${route.backend}:${route.model}:${model}`
    const reactiveAttachmentSnapshot =
      options?.recoveryAttachmentSnapshot ??
      this.EMPTY_CONTEXT_ATTACHMENT_SNAPSHOT
    let reactiveRetried = false

    try {
      while (true) {
        try {
          await options?.prepareContextForRoute?.(route, activeHints)
          const backendStream = this.resolveBackendStream(
            route,
            options,
            activeHints
          )
          this.logger.log(
            `Routing to ${route.backend} backend for model: ${route.model}` +
              (activeHints?.budgetOverride
                ? ` (reactive recovery budget=${activeHints.budgetOverride.maxTokens})`
                : "")
          )
          for await (const event of backendStream) {
            yield* handleEvent(event)
          }
          if (!emittedAny) {
            for (const b of buffer) yield b
          }
          this.contextManager.resetReactiveFailures(recoveryKey)
          return
        } catch (innerError) {
          if (innerError instanceof UpstreamRequestAbortedError)
            throw innerError
          if (emittedAny || reactiveRetried) throw innerError
          const detection = detectPromptTooLong(innerError)
          if (!detection.matched) throw innerError

          const recovery = this.computeReactiveRecoveryHints(
            route,
            options,
            detection,
            recoveryKey,
            reactiveAttachmentSnapshot,
            activeHints
          )
          if (!recovery) {
            throw innerError
          }
          activeHints = recovery
          reactiveRetried = true
          buffer = []
          this.logger.warn(
            `[REACTIVE-COMPACT] retrying ${route.backend}/${route.model} after prompt-too-long with budget=${recovery.budgetOverride?.maxTokens}`
          )
        }
      }
    } catch (error) {
      if (error instanceof UpstreamRequestAbortedError) {
        throw error
      }
      const fallback = this.modelRouter.getFallbackRoute(model, route.backend)
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
          `Backend ${route.backend} failed for ${model}: ${this.summarizeBackendError(
            error
          )}; falling back to ${fallback.backend}`
        )
        yield* this.executeBackendStreamWithFallback(
          model,
          fallback,
          attemptedBackends,
          options
        )
        return
      }

      throw error
    }
  }

  /**
   * Translate an upstream prompt-too-long failure into a smaller-budget
   * retry hint, after consulting the reactive-recovery circuit breaker.
   * Returns `undefined` when the breaker is open or the recovery would
   * not actually shrink the budget enough to matter.
   */
  private computeReactiveRecoveryHints(
    _route: ModelRouteResult,
    _options: BackendStreamOptions | undefined,
    detection: { actualTokens?: number; maxTokens?: number },
    recoveryKey: string,
    _attachmentSnapshot: ContextAttachmentSnapshot,
    previousHints: BackendStreamHints | undefined
  ): BackendStreamHints | undefined {
    const previousBudget = previousHints?.budgetOverride?.maxTokens
    const baselineBudget = previousBudget ?? this.DEFAULT_HISTORY_MAX_TOKENS
    const upstreamMax =
      typeof detection.maxTokens === "number" &&
      Number.isFinite(detection.maxTokens) &&
      detection.maxTokens > 0
        ? detection.maxTokens
        : undefined
    const nextBudget = upstreamMax
      ? Math.max(
          256,
          Math.min(
            baselineBudget,
            upstreamMax - Math.max(2048, Math.floor(upstreamMax * 0.04))
          )
        )
      : Math.max(256, Math.floor(baselineBudget * 0.75))
    if (nextBudget >= baselineBudget) {
      this.logger.warn(
        `[REACTIVE-COMPACT] giving up for ${recoveryKey}: no smaller budget available`
      )
      return undefined
    }

    return { budgetOverride: { maxTokens: nextBudget } }
  }

  /**
   * Get the appropriate message stream based on model
   * Uses ModelRouterService for centralized routing logic
   */
  private async *getBackendStream(
    model: string,
    options?: BackendStreamOptions
  ): AsyncGenerator<string, void, unknown> {
    const route = this.modelRouter.resolveModel(model)
    const registration = options?.streamAbortBinding
      ? this.backendStreamAbortRegistry.register(
          options.streamAbortBinding.conversationId,
          options.streamAbortBinding.streamId
        )
      : null

    try {
      yield* this.executeBackendStreamWithFallback(model, route, new Set(), {
        ...options,
        abortSignal: registration?.controller.signal ?? options?.abortSignal,
      })
    } finally {
      registration?.release()
    }
  }

  private buildPromptContextFromSession(session: ChatSession): PromptContext {
    const latestUserMessage =
      this.extractLatestUserPlainText(
        session.messages as Array<{
          role: "user" | "assistant"
          content: MessageContent
        }>
      ) || undefined

    return {
      projectContext: session.projectContext,
      codeChunks: session.codeChunks,
      cursorRules: session.cursorRules,
      selectedCursorRulePaths: session.selectedCursorRulePaths,
      selectedCursorRuleNames: session.selectedCursorRuleNames,
      activeCursorSkillNames: session.activeCursorSkillNames,
      cursorCommands: session.cursorCommands,
      customSystemPrompt: session.customSystemPrompt,
      explicitContext: session.explicitContext,
      mcpToolDefs: session.mcpToolDefs,
      newMessage: latestUserMessage,
    }
  }

  /**
   * Resolve the sub-agent tool surface + system addendum that
   * `buildSubAgentStreamingDtoForRoute` and the two Codex sub-agent
   * request builders all share. Centralising this matters because the
   * Codex / openai-compat path used to pass neither the tool definitions
   * nor the addendum, leaving GPT-backed sub-agents with an empty tool
   * surface (every smoke probe came back with `tool calls: 0`).
   *
   * `forceFinalSynthesis` mirrors the matching flag on the DTO builder:
   * on the post-MAX_TURNS synthesis turn we strip tools and swap in a
   * "produce a final answer from tool_results" addendum so the LLM
   * cannot emit more tool_use blocks.
   */
  private resolveSubAgentToolSurface(
    candidateTools: unknown,
    forceFinalSynthesis: boolean
  ): {
    toolDefinitions: ToolDefinition[] | undefined
    systemAddendum: string
  } {
    const toolDefinitions = forceFinalSynthesis
      ? undefined
      : Array.isArray(candidateTools) && candidateTools.length > 0
        ? (candidateTools as ToolDefinition[])
        : undefined

    const availableToolNames = (toolDefinitions || [])
      .map((tool) => tool?.name)
      .filter((value): value is string => typeof value === "string")

    const systemAddendum = forceFinalSynthesis
      ? "You are a sub-agent that has reached its turn limit. You can " +
        "no longer use any tools. The conversation above already contains " +
        "every tool_result you collected. Your task NOW is to write a " +
        "single final assistant message that synthesizes those results " +
        "into a clear answer for the parent agent. Do not ask follow-up " +
        "questions, do not announce you ran out of turns — just produce " +
        "the best answer you can from the evidence on hand. Be concise " +
        "but complete; cite specific findings from the tool_results when " +
        "relevant."
      : "You are a sub-agent. Operate strictly within the tool surface " +
        "below; never invent tools. Use read-only workspace tools such as " +
        "grep_search, read_file, and list_directory only when they are listed. " +
        "Use shell/edit/delete only when those tools are explicitly listed " +
        "for this agent. " +
        (availableToolNames.length > 0
          ? `Available tools: ${availableToolNames.join(", ")}. `
          : "No tools are available in this sub-agent. ") +
        "Use the smallest number of tool calls needed, then produce a final " +
        "plain-text summary as your last assistant message (no tool_use)."

    return { toolDefinitions, systemAddendum }
  }

  private buildSubAgentStreamingDtoForRoute(
    session: ChatSession,
    ctx: SubAgentContext,
    conversationId: string,
    streamRoute: ModelRouteResult,
    hints?: BackendStreamHints,
    options?: {
      /**
       * When true, the sub-agent has hit its maxTurns limit and is doing
       * a forced "synthesis" turn:
       *   - tools are removed from the DTO so the LLM cannot emit any
       *     more tool_use blocks (which would never be dispatched);
       *   - the system addendum reframes the task as "produce a final
       *     answer from the tool_results already in your context".
       *
       * Without this, max-turn-limited sub-agents return either an empty
       * accumulatedText or the literal placeholder
       * `[sub-agent reached max turns]`, wasting all the work the
       * earlier turns did. With it, we get one last LLM pass that
       * actually synthesizes a useful answer from the collected
       * tool_results.
       */
      forceFinalSynthesis?: boolean
    }
  ): CreateMessageDto {
    const forceFinalSynthesis = options?.forceFinalSynthesis === true
    // Pass the curated sub-agent tool surface so the model actually emits
    // tool_use blocks instead of meta-thinking text. ctx.tools is built up
    // front in executeSubAgentTask via buildToolsForApi(). On a final
    // synthesis turn we deliberately omit the tools so the LLM has no
    // choice but to write a plain-text answer.
    const {
      toolDefinitions: subAgentToolDefinitions,
      systemAddendum: subAgentSystemAddendum,
    } = this.resolveSubAgentToolSurface(ctx.tools, forceFinalSynthesis)

    const dto = this.buildStreamingDtoForRoute(streamRoute, {
      model: ctx.model,
      promptContext: this.buildPromptContextFromSession(session),
      conversationId,
      session,
      thinkingLevel: session.thinkingLevel,
      thinkingDetailsRequested: session.thinkingDetailsRequested,
      budgetOverride: hints?.budgetOverride,
      toolDefinitions: subAgentToolDefinitions,
      additionalSystemPrompt: subAgentSystemAddendum,
      buildMessages: (budget) => {
        const compacted = this.contextRequestPlanner.projectMessages(
          ctx.messages.map((message) => ({
            role: message.role,
            content: message.content as UnifiedMessage["content"],
          })) as UnifiedMessage[],
          this.EMPTY_CONTEXT_ATTACHMENT_SNAPSHOT,
          budget,
          { strategy: "auto" }
        )

        if (forceFinalSynthesis) {
          return projectSubAgentFinalSynthesisMessages(
            compacted.messages as Array<{
              role: "user" | "assistant"
              content: unknown
            }>
          ) as CreateMessageDto["messages"]
        }

        return compacted.messages as CreateMessageDto["messages"]
      },
    })

    dto.max_tokens = Math.min(8192, dto.max_tokens ?? 8192)
    return dto
  }

  private buildStreamingDtoForRoute(
    route: ModelRouteResult,
    options: {
      model: string
      promptContext: PromptContext
      conversationId?: string
      session?: ChatSession
      toolDefinitions?: CreateMessageDto["tools"]
      additionalSystemPrompt?: string
      pendingToolUseIds?: string[]
      thinkingLevel?: number
      thinkingDetailsRequested?: boolean
      suppressThinkingSummary?: boolean
      budgetOverride?: { maxTokens?: number }
      buildMessages: (
        budget: ContextRequestBudget
      ) => CreateMessageDto["messages"]
    }
  ): CreateMessageDto {
    const useGoogleContextMessages = this.isCloudCodeBackend(route.backend)
    const contextMessages =
      useGoogleContextMessages && options.conversationId
        ? this.buildGoogleContextMessages(
            options.promptContext,
            options.conversationId
          )
        : []
    const systemPrompt = useGoogleContextMessages
      ? this.buildGoogleSystemPrompt(options.promptContext)
      : this.buildSystemPrompt(
          options.promptContext,
          options.session?.deferredToolCatalog
        )
    const effectiveSystemPrompt = options.additionalSystemPrompt
      ? [systemPrompt, options.additionalSystemPrompt]
          .filter((part) => typeof part === "string" && part.trim().length > 0)
          .join("\n\n")
      : systemPrompt
    const budget = this.resolveMessageBudget(route.backend, {
      session: options.session,
      protectedContextTokens: contextMessages.length
        ? this.tokenCounter.countMessages(contextMessages as UnifiedMessage[])
        : 0,
      systemPrompt: effectiveSystemPrompt,
      toolDefinitions: options.toolDefinitions,
      model: options.model,
      budgetOverride: options.budgetOverride,
    })
    const historyMessages = options.buildMessages(budget)
    // Cloud Code expects the official per-message transcript shape.
    // Do not collapse user history or tool_result adjacency will break.
    const outgoingMessages = [
      ...contextMessages,
      ...historyMessages,
    ] as CreateMessageDto["messages"]
    const historyTokens = historyMessages.length
      ? this.tokenCounter.countMessages(historyMessages as UnifiedMessage[])
      : 0
    const totalMessageTokens = outgoingMessages.length
      ? this.tokenCounter.countMessages(outgoingMessages as UnifiedMessage[])
      : 0

    const dto: CreateMessageDto = {
      model: route.model,
      messages: outgoingMessages,
      system: effectiveSystemPrompt || undefined,
      max_tokens: budget.maxOutputTokens,
      stream: true,
    }

    if (options.toolDefinitions) {
      dto.tools = options.toolDefinitions
    }
    const nativeContextManagement =
      this.contextNativeManagement.buildAnthropicContextManagement({
        backend: route.backend,
        messages: outgoingMessages as UnifiedMessage[],
        maxTokens: budget.maxTokens,
        systemPromptTokens: budget.systemPromptTokens,
        autoCompactTokenLimit: budget.autoCompactTokenLimit,
      })
    if (nativeContextManagement) {
      dto.context_management = nativeContextManagement
    }
    if (options.conversationId) {
      dto._conversationId = options.conversationId
    }
    dto._contextTokenBudget = budget.maxTokens
    if (options.pendingToolUseIds && options.pendingToolUseIds.length > 0) {
      dto._pendingToolUseIds = options.pendingToolUseIds
    }

    const requestedReasoningEffort = this.resolveRequestedReasoningEffort(
      options.session?.requestedModelParameters
    )
    const suppressThinkingSummary = this.shouldSuppressThinkingSummaryForRoute(
      route.backend,
      options.session?.requestedModelParameters,
      options.suppressThinkingSummary
    )

    const shouldRequestThinkingSummary = suppressThinkingSummary
      ? false
      : options.thinkingDetailsRequested === true ||
        (route.backend === "codex" &&
          ((options.thinkingLevel || 0) > 0 ||
            (!!requestedReasoningEffort &&
              requestedReasoningEffort !== "none")))

    if ((options.thinkingLevel || 0) > 0 || requestedReasoningEffort) {
      const thinkingIntent = this.buildCursorThinkingIntent(
        options.thinkingLevel || 0,
        route.model,
        requestedReasoningEffort
      )
      applyThinkingIntentToDto(dto, thinkingIntent)
    }
    dto._includeThinkingSummary = shouldRequestThinkingSummary

    const requestedServiceTier = this.resolveRequestedCodexServiceTier(
      options.session?.requestedModelParameters
    )
    if (route.backend === "codex" && requestedServiceTier) {
      dto.service_tier = requestedServiceTier
    }

    this.logger.debug(
      `Prompt assembly for ${route.backend}: protectedContextMessages=${contextMessages.length}, ` +
        `historyMessages=${historyMessages.length}, historyTokens=${historyTokens}, totalMessageTokens=${totalMessageTokens}, ` +
        `thinkingSummary=${dto._includeThinkingSummary === true}`
    )

    return dto
  }

  private buildCodexStreamingRequestForRoute(
    route: ModelRouteResult,
    options: {
      model: string
      promptContext: PromptContext
      conversationId?: string
      session?: ChatSession
      toolDefinitions?: ToolDefinition[]
      additionalSystemPrompt?: string
      pendingToolUseIds?: string[]
      thinkingLevel?: number
      thinkingDetailsRequested?: boolean
      suppressThinkingSummary?: boolean
      budgetOverride?: { maxTokens?: number }
      buildMessages: (
        budget: ContextRequestBudget
      ) => CodexExecutionRequest["messages"]
    }
  ): CodexExecutionRequest {
    const systemPrompt = this.buildCodexSystemPrompt(
      options.promptContext,
      options.session?.deferredToolCatalog
    )
    const effectiveSystemPrompt = options.additionalSystemPrompt
      ? [systemPrompt, options.additionalSystemPrompt]
          .filter((part) => typeof part === "string" && part.trim().length > 0)
          .join("\n\n")
      : systemPrompt
    const budget = this.resolveMessageBudget(route.backend, {
      session: options.session,
      protectedContextTokens: 0,
      systemPrompt: effectiveSystemPrompt,
      toolDefinitions: options.toolDefinitions,
      model: options.model,
      budgetOverride: options.budgetOverride,
    })
    const historyMessages = options.buildMessages(budget)
    const requestedReasoningEffort = this.resolveRequestedReasoningEffort(
      options.session?.requestedModelParameters
    )
    const suppressThinkingSummary = this.shouldSuppressThinkingSummaryForRoute(
      route.backend,
      options.session?.requestedModelParameters,
      options.suppressThinkingSummary
    )
    const thinkingIntent =
      (options.thinkingLevel || 0) > 0 || requestedReasoningEffort
        ? this.buildCursorThinkingIntent(
            options.thinkingLevel || 0,
            route.model,
            requestedReasoningEffort
          )
        : undefined
    // previous_response_id 现在由 CodexService.streamViaWebSocket() 在 transport 层自动注入，
    // 不再在这里管理。对标官方 prepare_websocket_request() 设计。
    const historyTokens = historyMessages.length
      ? this.tokenCounter.countMessages(historyMessages as UnifiedMessage[])
      : 0
    const totalMessageTokens = historyMessages.length
      ? this.tokenCounter.countMessages(historyMessages as UnifiedMessage[])
      : 0

    const shouldRequestThinkingSummary = suppressThinkingSummary
      ? false
      : options.thinkingDetailsRequested === true ||
        (route.backend === "codex" &&
          ((options.thinkingLevel || 0) > 0 ||
            (!!requestedReasoningEffort &&
              requestedReasoningEffort !== "none")))

    const request: CodexExecutionRequest = {
      model: route.model,
      system: effectiveSystemPrompt || undefined,
      messages: historyMessages,
      conversationId: options.conversationId,
      pendingToolUseIds:
        options.pendingToolUseIds && options.pendingToolUseIds.length > 0
          ? options.pendingToolUseIds
          : undefined,
      includeThinkingSummary: shouldRequestThinkingSummary,
      serviceTier: this.resolveRequestedCodexServiceTier(
        options.session?.requestedModelParameters
      ),
      clientMetadata: this.buildCodexClientMetadata(
        options.session,
        options.conversationId
      ),
      textVerbosity: "low",
    }

    if (options.toolDefinitions && options.toolDefinitions.length > 0) {
      request.tools = options.toolDefinitions
    }

    if (thinkingIntent) {
      request.thinkingIntent = thinkingIntent
    }

    this.logger.debug(
      `Prompt assembly for codex-native: protectedContextMessages=0, ` +
        `historyMessages=${historyMessages.length}, historyTokens=${historyTokens}, totalMessageTokens=${totalMessageTokens}, ` +
        `thinkingSummary=${request.includeThinkingSummary === true}, ` +
        `inputMessages=${request.messages.length}`
    )

    return request
  }

  /**
   * Fire-and-forget warmup via the ProviderAdapter interface.
   * Resolved adapter determines provider-specific behavior:
   *   - Codex: establish WebSocket + optional generate:false prompt cache warmup
   *   - Claude/Gemini: no-op (HTTP transport, no prewarming needed)
   */
  private startProviderWarmup(
    route: ModelRouteResult,
    conversationId: string | undefined,
    reason: string,
    options?: {
      pendingToolUseIds?: string[]
    }
  ): void {
    const isContinuationWarmup =
      reason.includes("continuation") ||
      reason.includes("shell") ||
      reason.includes("tool")
    if (route.backend === "codex" && isContinuationWarmup) {
      this.logger.debug(
        `Skipping Codex ${reason} warmup for ${conversationId || "global"}; the stream request will reuse or rebuild the turn connection directly`
      )
      return
    }

    this.resolveProviderAdapter(route.backend)?.warmup({
      model: route.model,
      conversationId,
      reason,
      pendingToolUseIds: options?.pendingToolUseIds,
    })
  }

  /**
   * Resolve the ProviderAdapter for a given backend type.
   * Returns undefined for backends that don't have an adapter yet.
   */
  private resolveProviderAdapter(
    backend: BackendType
  ):
    | import("../../llm/shared/provider-adapter.interface").ProviderAdapter
    | undefined {
    switch (backend) {
      case "codex":
        return this.codexService
      case "claude-api":
        return this.anthropicApiService
      case "google":
        return this.googleService
      default:
        return undefined
    }
  }

  /**
   * Resolve the backend-specific SSE stream for a given route.
   * Centralizes the request-type resolution + stream creation that was
   * previously scattered across the if-else chain in executeBackendStreamWithFallback.
   *
   * All backends return AsyncGenerator<string> (Claude-compatible SSE events).
   */
  private resolveBackendStream(
    route: ModelRouteResult,
    options?: BackendStreamOptions,
    hints?: BackendStreamHints
  ): AsyncGenerator<string, void, unknown> {
    switch (route.backend) {
      case "codex": {
        const codexRequest = options?.buildCodexRequestForRoute?.(route, hints)
        if (!codexRequest) {
          throw new Error(
            `Missing Codex request builder for backend ${route.backend} (${route.model})`
          )
        }
        return this.codexService.sendMessageStream(
          codexRequest,
          options?.abortSignal
        )
      }
      case "claude-api": {
        const routedDto = options?.buildDtoForRoute?.(route, hints)
        if (!routedDto) {
          throw new Error(
            `Missing DTO builder for backend ${route.backend} (${route.model})`
          )
        }
        return this.anthropicApiService.sendClaudeMessageStream(
          routedDto,
          {},
          options?.abortSignal
        )
      }
      case "kiro": {
        const routedDto = options?.buildDtoForRoute?.(route, hints)
        if (!routedDto) {
          throw new Error(
            `Missing DTO builder for backend ${route.backend} (${route.model})`
          )
        }
        return this.kiroService.sendClaudeMessageStream(
          routedDto,
          options?.abortSignal
        )
      }
      case "openai-compat": {
        const routedDto = options?.buildDtoForRoute?.(route, hints)
        if (!routedDto) {
          throw new Error(
            `Missing DTO builder for backend ${route.backend} (${route.model})`
          )
        }
        return this.openaiCompatService.sendClaudeMessageStream(
          routedDto,
          options?.abortSignal
        )
      }
      case "google":
      default: {
        const routedDto = options?.buildDtoForRoute?.(route, hints)
        if (!routedDto) {
          throw new Error(
            `Missing DTO builder for backend ${route.backend} (${route.model})`
          )
        }
        return this.googleService.sendClaudeMessageStream(
          routedDto,
          options?.abortSignal
        )
      }
    }
  }

  private buildCodexClientMetadata(
    session: ChatSession | undefined,
    conversationId?: string
  ): Record<string, string> | undefined {
    const normalizedConversationId = conversationId?.trim()
    if (!normalizedConversationId) {
      return undefined
    }

    const requestOrdinal = Math.max(1, (session?.turns.length || 0) + 1)
    const turnMetadata: Record<string, unknown> = {
      session_id: normalizedConversationId,
      thread_source: "user",
      turn_id: `${normalizedConversationId}:${requestOrdinal}`,
      sandbox: "none",
    }

    const rootPath = session?.projectContext?.rootPath?.trim()
    if (rootPath) {
      turnMetadata.workspaces = {
        [rootPath]: {},
      }
    }

    return {
      "x-codex-window-id": `${normalizedConversationId}:${requestOrdinal}`,
      "x-codex-turn-metadata": JSON.stringify(turnMetadata),
      "x-codex-installation-id": this.codexInstallationId,
    }
  }

  private normalizePositiveInteger(value: unknown): number | undefined {
    if (typeof value !== "number") return undefined
    if (!Number.isFinite(value) || value <= 0) return undefined
    return Math.floor(value)
  }

  private getBackendContextLimit(
    backend: BackendType,
    model?: string
  ): number | undefined {
    if (backend === "google" || backend === "google-claude") {
      return this.CLOUD_CODE_CONTEXT_LIMIT_TOKENS
    }
    if (backend === "claude-api" && model) {
      return (
        this.anthropicApiService.getConfiguredMaxContextTokens(model) ??
        DEFAULT_CLAUDE_API_CONTEXT_LIMIT_TOKENS
      )
    }
    if (backend === "kiro" && model) {
      return this.kiroService.getConfiguredMaxContextTokens(model) ?? 1_000_000
    }
    if (backend === "openai-compat") {
      return this.openaiCompatService.getConfiguredMaxContextTokens(model)
    }
    return undefined
  }

  private resolveCheckpointMaxTokens(session: ChatSession): number {
    let backendLimit: number | undefined
    try {
      const route = this.modelRouter.resolveModel(session.model)
      backendLimit = this.getBackendContextLimit(route.backend, session.model)
    } catch (error) {
      this.logger.warn(
        `Failed to resolve backend for checkpoint budget (model=${session.model}): ${String(error)}`
      )
    }
    const protocolLimit = this.normalizePositiveInteger(
      session.contextTokenLimit
    )

    let resolved =
      session.contextMaxMode && backendLimit
        ? backendLimit
        : protocolLimit || this.DEFAULT_HISTORY_MAX_TOKENS
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
      protectedContextTokens?: number
      systemPrompt?: string
      toolDefinitions?: unknown
      model?: string
      budgetOverride?: { maxTokens?: number }
    }
  ): ContextRequestBudget {
    const backendContextLimit = this.getBackendContextLimit(
      backend,
      options?.model
    )
    let effectiveBackendContextLimit = backendContextLimit
    if (backend === "google" || backend === "google-claude") {
      const cloudHardLimit =
        backendContextLimit || this.CLOUD_CODE_CONTEXT_LIMIT_TOKENS
      effectiveBackendContextLimit = Math.min(
        cloudHardLimit,
        this.CLOUD_CODE_SOFT_CONTEXT_LIMIT_TOKENS
      )
      if (cloudHardLimit > effectiveBackendContextLimit) {
        this.logger.warn(
          `Applying Cloud Code safety budget clamp: ${cloudHardLimit} -> ${effectiveBackendContextLimit}`
        )
      }
    }

    const parsedContextLimit = this.normalizePositiveInteger(
      options?.parsed?.contextTokenLimit
    )
    const sessionContextLimit = this.normalizePositiveInteger(
      options?.session?.contextTokenLimit
    )
    const parsedHasContextMode =
      typeof options?.parsed?.contextMaxMode === "boolean"
    const maxMode =
      options?.parsed?.contextMaxMode === true ||
      (!parsedHasContextMode && options?.session?.contextMaxMode === true)
    let protocolContextLimit = parsedContextLimit
    if (!protocolContextLimit) {
      if (maxMode && effectiveBackendContextLimit) {
        protocolContextLimit = effectiveBackendContextLimit
      } else if (!parsedHasContextMode) {
        protocolContextLimit = sessionContextLimit
      }
    }

    const overrideMax = this.normalizePositiveInteger(
      options?.budgetOverride?.maxTokens
    )
    let requestedMaxTokens = protocolContextLimit
    if (
      overrideMax &&
      (!requestedMaxTokens || overrideMax < requestedMaxTokens)
    ) {
      this.logger.warn(
        `Reactive recovery override active: clamping context budget ${requestedMaxTokens || effectiveBackendContextLimit || this.DEFAULT_HISTORY_MAX_TOKENS} -> ${overrideMax}`
      )
      requestedMaxTokens = overrideMax
    }

    const maxOutputTokens = this.resolveMaxOutputTokens(
      backend,
      options?.parsed,
      options?.session
    )
    const requestedServiceTier =
      backend === "codex"
        ? this.resolveRequestedCodexServiceTier(
            options?.parsed?.requestedModelParameters ||
              options?.session?.requestedModelParameters
          )
        : undefined
    const protectedContextTokens = options?.protectedContextTokens || 0
    const backendSystemPromptTokens =
      backend === "google" || backend === "google-claude"
        ? this.googleService.getSystemPromptTokenEstimate()
        : 0
    const fixedOverheadTokens =
      backend === "google" || backend === "google-claude"
        ? this.CLOUD_CODE_EXTRA_OVERHEAD_TOKENS
        : this.GENERIC_EXTRA_OVERHEAD_TOKENS

    const budget = this.contextRequestPlanner.resolveBudget({
      backend,
      protocolMaxTokens: requestedMaxTokens,
      backendMaxTokens: effectiveBackendContextLimit,
      defaultMaxTokens: this.DEFAULT_HISTORY_MAX_TOKENS,
      protectedContextTokens,
      systemPrompt: options?.systemPrompt,
      toolDefinitions: options?.toolDefinitions,
      backendSystemPromptTokens,
      fixedOverheadTokens,
      maxOutputTokens,
      requestedServiceTier,
    })

    if (budget.backendClampedFrom && budget.backendClampedTo) {
      this.logger.warn(
        `Cursor protocol context limit ${budget.backendClampedFrom} exceeds backend cap ${budget.backendClampedTo}, clamping`
      )
    }

    if (budget.autoCompactTokenLimit) {
      this.logger.debug(
        `Auto compact limit resolved: backend=${backend}, hardMaxTokens=${budget.maxTokens}, ` +
          `autoCompactTokenLimit=${budget.autoCompactTokenLimit}`
      )
    }

    this.logger.debug(
      `Token budget resolved: backend=${backend}, maxTokens=${budget.maxTokens}, ` +
        `systemPromptTokens=${budget.systemPromptTokens} (protectedContext=${protectedContextTokens}, backendSystem=${backendSystemPromptTokens}), ` +
        `maxOutput=${budget.maxOutputTokens}, autoCompactTokenLimit=${budget.autoCompactTokenLimit || "(none)"}, ` +
        `maxMode=${maxMode}`
    )

    return budget
  }

  private buildContextAttachmentSnapshot(
    session: ChatSession
  ): ContextAttachmentSnapshot {
    return {
      activeSubAgents: this.sessionManager
        .listSubAgentContexts(session.conversationId)
        .map((ctx) => ({
          subagentId: ctx.subagentId,
          model: ctx.model,
          turnCount: ctx.turnCount,
          toolCallCount: ctx.toolCallCount,
          modifiedFiles: [...ctx.modifiedFiles],
          pendingToolCallIds: Array.from(ctx.expectedToolCallIds),
        })),
      readPaths: Array.from(session.readPaths),
      fileStates: Array.from(session.fileStates.entries()).map(
        ([path, state]) => ({
          path,
          beforeContent: state.beforeContent,
          afterContent: state.afterContent,
        })
      ),
      todos: session.todos.map((todo) => ({
        content: todo.content,
        status: todo.status,
      })),
      sessionMemory: (session.contextState.sessionMemory || []).map(
        (entry) => ({
          kind: entry.kind,
          text: entry.text,
          createdAt: entry.createdAt,
          weight: entry.weight,
        })
      ),
      investigationSummaries:
        this.sessionManager.getInvestigationMemoryAttachmentSnapshot(
          session.conversationId
        ),
    }
  }

  private extractUsageSnapshot(
    event: SseEvent
  ): ContextUsageSnapshot | undefined {
    const usage = event.data.usage
    if (!usage) return undefined

    const inputTokens =
      typeof usage.input_tokens === "number"
        ? Math.max(0, usage.input_tokens)
        : 0
    const cachedInputTokens =
      typeof usage.cache_read_input_tokens === "number"
        ? Math.max(0, usage.cache_read_input_tokens)
        : 0
    const cacheCreationInputTokens =
      typeof usage.cache_creation_input_tokens === "number"
        ? Math.max(0, usage.cache_creation_input_tokens)
        : 0
    const outputTokens =
      typeof usage.output_tokens === "number"
        ? Math.max(0, usage.output_tokens)
        : 0

    if (
      inputTokens === 0 &&
      cachedInputTokens === 0 &&
      cacheCreationInputTokens === 0 &&
      outputTokens === 0
    ) {
      return undefined
    }

    return {
      inputTokens,
      cachedInputTokens,
      cacheCreationInputTokens,
      outputTokens,
      totalTokens:
        inputTokens +
        cachedInputTokens +
        cacheCreationInputTokens +
        outputTokens,
      recordedAt: Date.now(),
    }
  }

  private isCloudCodeBackend(backend: BackendType): boolean {
    return backend === "google" || backend === "google-claude"
  }

  private shouldUseStrictAdjacentToolIntegrity(backend: BackendType): boolean {
    return (
      this.isCloudCodeBackend(backend) ||
      backend === "kiro" ||
      backend === "claude-api"
    )
  }

  private hasPendingStreamWork(session: ChatSession | undefined): boolean {
    return Boolean(
      session &&
      (session.pendingToolCalls.size > 0 ||
        session.pendingInteractionQueries.size > 0)
    )
  }

  private describePendingStreamWork(session: ChatSession | undefined): string {
    if (!session) {
      return "pendingToolCalls=0, pendingInteractionQueries=0"
    }
    return (
      `pendingToolCalls=${session.pendingToolCalls.size}, ` +
      `pendingInteractionQueries=${session.pendingInteractionQueries.size}`
    )
  }

  private summarizeStreamId(streamId: string | undefined): string {
    return streamId ? streamId.substring(0, 8) : "(none)"
  }

  private abortBackendRequestsForSupersededStreams(
    conversationId: string,
    streamId: string,
    context: string
  ): void {
    const abortedCount = this.backendStreamAbortRegistry.abortOtherStreams(
      conversationId,
      streamId,
      `Superseded by stream ${this.summarizeStreamId(streamId)} during ${context}`
    )
    if (abortedCount > 0) {
      this.logger.log(
        `Aborted ${abortedCount} backend request(s) for superseded stream(s) on ${conversationId} during ${context}`
      )
    }
  }

  private abortBackendRequestsForStream(
    conversationId: string,
    streamId: string,
    context: string
  ): void {
    const abortedCount = this.backendStreamAbortRegistry.abortStream(
      conversationId,
      streamId,
      `Stream ${this.summarizeStreamId(streamId)} aborted during ${context}`
    )
    if (abortedCount > 0) {
      this.logger.log(
        `Aborted ${abortedCount} backend request(s) for stream ${this.summarizeStreamId(streamId)} on ${conversationId} during ${context}`
      )
    }
  }

  private shouldAbortSupersededStream(
    conversationId: string,
    streamId: string | undefined,
    context: string
  ): boolean {
    if (!streamId) {
      return false
    }

    const currentStreamId =
      this.sessionManager.getCurrentStreamId(conversationId)
    if (!currentStreamId || currentStreamId === streamId) {
      return false
    }

    this.logger.warn(
      `Stopping superseded stream for ${conversationId} during ${context}: ` +
        `${this.summarizeStreamId(streamId)} != ${this.summarizeStreamId(currentStreamId)}`
    )
    return true
  }

  private *maybeEmitCloudCodeProtocolRecoveryQuery(
    conversationId: string,
    backend: BackendType,
    backendModel: string,
    error: unknown
  ): Generator<Buffer, boolean> {
    if (!this.isCloudCodeBackend(backend)) {
      return false
    }

    const errorMessage = error instanceof Error ? error.message : String(error)
    return yield* this.emitCloudCodeProtocolRecoveryQuery(
      conversationId,
      backend,
      backendModel,
      errorMessage
    )
  }

  private extractMissingToolOutputCallId(error: unknown): string | null {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const match = errorMessage.match(
      /No tool output found for function call ([A-Za-z0-9_-]+)\.?/
    )
    return match?.[1] || null
  }

  private repairMissingToolOutputProtocolState(
    conversationId: string,
    contextLabel: string,
    error: unknown
  ): boolean {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) {
      return false
    }

    let repaired = false
    const missingToolCallId = this.extractMissingToolOutputCallId(error)
    if (missingToolCallId) {
      const clearedPending = this.sessionManager.clearPendingToolCall(
        conversationId,
        missingToolCallId,
        "repairing orphaned tool call after backend rejected missing tool output"
      )
      if (clearedPending) {
        repaired = true
      } else {
        this.logger.warn(
          `Protocol repair (${contextLabel}) could not find pending tool call ${missingToolCallId} to clear`
        )
      }
    }

    const refreshedSession = this.sessionManager.getSession(conversationId)
    if (!refreshedSession) {
      return repaired
    }

    if (
      this.sanitizeSessionToolProtocol(
        conversationId,
        `Protocol repair (${contextLabel})`,
        Array.from(refreshedSession.pendingToolCalls.keys())
      )
    ) {
      repaired = true
    }

    return repaired
  }

  private sanitizeSessionToolProtocol(
    conversationId: string,
    contextLabel: string,
    pendingToolUseIds?: string[]
  ): boolean {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) {
      return false
    }

    const sanitized = this.toolIntegrity.sanitizeMessages(
      session.messages as UnifiedMessage[],
      {
        pendingToolUseIds:
          pendingToolUseIds ?? Array.from(session.pendingToolCalls.keys()),
      }
    )

    if (
      sanitized.removedOrphanToolUses === 0 &&
      sanitized.removedOrphanToolResults === 0
    ) {
      return false
    }

    this.sessionManager.replaceMessages(
      conversationId,
      sanitized.messages as Array<{
        role: "user" | "assistant"
        content: MessageContent
      }>
    )
    this.logger.warn(
      `${contextLabel} injected ${sanitized.removedOrphanToolUses} synthetic tool_result block(s) and removed ${sanitized.removedOrphanToolResults} orphan tool_result block(s)`
    )
    return true
  }

  private shouldDeferToolBatchContinuation(
    conversationId: string,
    backend: BackendType,
    pendingToolUseIds: string[]
  ): boolean {
    if (!backendRequiresCompleteToolBatchBeforeContinuation(backend)) {
      return false
    }

    return (
      pendingToolUseIds.length > 0 ||
      this.sessionManager.hasUnsettledAssistantToolBatchForBackend(
        conversationId,
        backend
      )
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
        return extractText(message.content)
      }

      return null
    }

    return null
  }

  private extractPlainTextContent(
    content: MessageContent | undefined
  ): string | null {
    if (typeof content === "string") {
      return content
    }

    if (!Array.isArray(content)) {
      return null
    }

    const nonTextBlock = content.find((block) => block.type !== "text")
    if (nonTextBlock) {
      return null
    }

    return extractText(content)
  }

  private isTransientAssistantInfrastructureText(text: string): boolean {
    const normalized = text.trim()
    if (!normalized) {
      return false
    }

    return (
      normalized.startsWith(
        "Cloud Code streamGenerateContent stream failed:"
      ) ||
      normalized.startsWith(
        "Cloud Code streamGenerateContent first chunk timeout after"
      ) ||
      normalized.startsWith(
        "Cloud Code streamGenerateContent idle timeout after"
      ) ||
      normalized.startsWith("Cloud Code API invalid_request_error:") ||
      normalized.startsWith("⚠️ Backend request failed") ||
      normalized.includes("Cloud Code streamGenerateContent stream failed:") ||
      normalized.includes(
        "Cloud Code streamGenerateContent first chunk timeout after"
      ) ||
      normalized.includes(
        "Cloud Code streamGenerateContent idle timeout after"
      ) ||
      normalized.includes("Cloud Code API invalid_request_error:") ||
      normalized.includes(
        'Invalid JSON payload received. Unknown name "__removedFunctionResponses"'
      ) ||
      normalized.includes("No tool output found for function call") ||
      normalized.includes(
        "Each tool_result block must have a corresponding tool_use block in the previous message."
      )
    )
  }

  private stripTransientAssistantInfrastructureMessages(
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>
  ): {
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>
    removedMessages: number
  } {
    const cleaned: Array<{
      role: "user" | "assistant"
      content: MessageContent
    }> = []
    let removedMessages = 0

    for (const message of messages) {
      if (message.role === "assistant") {
        const plainText = this.extractPlainTextContent(message.content)
        if (
          plainText &&
          this.isTransientAssistantInfrastructureText(plainText)
        ) {
          removedMessages++
          continue
        }
      }

      cleaned.push(message)
    }

    return { messages: cleaned, removedMessages }
  }

  private cleanSessionHistoryForTransientAssistantInfrastructureMessages(
    session: ChatSession,
    contextLabel: string
  ): ChatSession {
    const cleaned = this.stripTransientAssistantInfrastructureMessages(
      session.messages
    )
    if (cleaned.removedMessages === 0) {
      return session
    }

    this.logger.warn(
      `Removed ${cleaned.removedMessages} transient assistant infrastructure message(s) from session ` +
        `${session.conversationId} (${contextLabel})`
    )
    this.sessionManager.replaceMessages(
      session.conversationId,
      cleaned.messages
    )
    return this.sessionManager.getSession(session.conversationId) || session
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

  private coerceContentToBlocks(content: MessageContent): MessageContentItem[] {
    if (typeof content === "string") {
      if (!content.trim()) return []
      return [{ type: "text", text: content }]
    }

    if (!Array.isArray(content)) return []
    return content
      .filter((block) => !!block && typeof block === "object")
      .map((block) => ({ ...block })) as MessageContentItem[]
  }

  private mergeMessageContents(
    left: MessageContent,
    right: MessageContent
  ): MessageContent {
    if (typeof left === "string" && typeof right === "string") {
      if (!left) return right
      if (!right) return left
      return `${left}\n\n${right}`
    }

    const blocks = [
      ...this.coerceContentToBlocks(left),
      ...this.coerceContentToBlocks(right),
    ]
    if (blocks.length === 0) return ""

    if (
      blocks.every(
        (block) => block.type === "text" && typeof block.text === "string"
      )
    ) {
      return blocks.map((block) => String(block.text || "")).join("\n\n")
    }

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

  private removeHistoricalToolUseForReinjection(
    session: ChatSession,
    toolCallId: string
  ): boolean {
    let removed = false

    const rewrittenMessages = session.messages.flatMap((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        return [message]
      }

      const filtered = message.content.filter((block) => {
        if (!block || typeof block !== "object") return true
        return !(
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          block.id === toolCallId
        )
      })

      if (filtered.length === message.content.length) {
        return [message]
      }

      removed = true
      if (filtered.length === 0) {
        return []
      }

      return [
        {
          ...message,
          content: filtered as MessageContent,
        },
      ]
    })

    if (!removed) {
      return false
    }

    this.sessionManager.replaceMessages(
      session.conversationId,
      rewrittenMessages
    )
    return true
  }

  private appendToolResultWithIntegrity(
    session: ChatSession,
    toolCallId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResultContent: string | Array<Record<string, unknown>>,
    structuredContent?: Record<string, unknown>,
    toolCallType: "function" | "custom" = "function"
  ): void {
    const appendPlan = findToolResultAppendPlan(
      session.messages as Array<{
        role: "user" | "assistant"
        content: unknown
      }>,
      toolCallId
    )
    if (appendPlan?.mode === "merge_into_existing_user_message") {
      const targetUserMessageIndex = appendPlan.userMessageIndex
      if (targetUserMessageIndex != null) {
        const targetUserMessage = session.messages[targetUserMessageIndex]
        if (
          targetUserMessage?.role === "user" &&
          messageContainsToolResult(targetUserMessage.content, toolCallId)
        ) {
          return
        }
        if (
          targetUserMessage?.role === "user" &&
          !messageContainsToolResult(targetUserMessage.content, toolCallId)
        ) {
          const mergedMessages = session.messages.map((message, index) => {
            if (index !== targetUserMessageIndex) {
              return message
            }
            const blocks = Array.isArray(message.content)
              ? message.content.map((block) => structuredClone(block))
              : []
            blocks.push({
              type: "tool_result",
              tool_use_id: toolCallId,
              content: toolResultContent,
              tool_call_type: toolCallType,
              ...(structuredContent ? { structuredContent } : {}),
            })
            return {
              ...message,
              content: blocks as MessageContent,
            }
          })
          this.sessionManager.replaceMessages(
            session.conversationId,
            mergedMessages
          )
          return
        }
      }
    }

    if (appendPlan?.mode === "append_new_user_message") {
      this.sessionManager.addMessage(session.conversationId, "user", [
        {
          type: "tool_result" as const,
          tool_use_id: toolCallId,
          content: toolResultContent,
          tool_call_type: toolCallType,
          ...(structuredContent ? { structuredContent } : {}),
        },
      ])
      return
    }

    const lastMessage = session.messages[session.messages.length - 1]
    if (
      !lastMessage ||
      lastMessage.role !== "assistant" ||
      !this.messageHasToolUse(lastMessage.content, toolCallId)
    ) {
      const relocatedHistoricalToolUse =
        this.removeHistoricalToolUseForReinjection(session, toolCallId)

      this.logger.warn(
        relocatedHistoricalToolUse
          ? `Tool protocol repair: relocating existing assistant tool_use before tool_result (${toolCallId})`
          : `Tool protocol repair: injecting synthetic assistant tool_use before tool_result (${toolCallId})`
      )
      const syntheticToolUse: MessageContentItem[] = [
        {
          type: "tool_use",
          id: toolCallId,
          name: toolName || "unknown_tool",
          input: toolInput || {},
          tool_call_type: toolCallType,
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
        tool_call_type: toolCallType,
        ...(structuredContent ? { structuredContent } : {}),
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
          content: [
            ...nextMessage.content,
            ...missingResults,
          ] as MessageContent,
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
      `restart recovery: ${session.conversationId}`,
      {
        conversationId: session.conversationId,
        replacementState: session.contextState.toolResultReplacementState,
      }
    )
    this.sessionManager.replaceMessages(
      session.conversationId,
      normalizedMessages
    )
  }

  private normalizeHistoryForBackend(
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>,
    contextLabel: string,
    options?: {
      pendingToolUseIds?: string[]
      conversationId?: string
      replacementState?: ContextToolResultReplacementState
    }
  ): Array<{ role: "user" | "assistant"; content: MessageContent }> {
    const compacted = this.compactInflatingReadonlyToolHistory(messages, {
      conversationId: options?.conversationId,
      replacementState: options?.replacementState,
    })
    const stripped = this.stripTransientAssistantInfrastructureMessages(
      compacted.messages
    )
    if (
      compacted.compactedToolInputs > 0 ||
      compacted.compactedToolResults > 0
    ) {
      this.logger.warn(
        `History projection (${contextLabel}) compacted ${compacted.compactedToolInputs} inflated tool input(s), ` +
          `${compacted.compactedToolResults} inflated tool result(s)`
      )
    }
    if (stripped.removedMessages > 0) {
      this.logger.warn(
        `History projection (${contextLabel}) removed ${stripped.removedMessages} transient assistant infrastructure message(s)`
      )
    }

    const normalized = normalizeToolProtocolMessages(
      stripped.messages as Array<{
        role: "user" | "assistant"
        content: unknown
      }>,
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

  private cloneHistoryValue(value: unknown): unknown {
    try {
      return structuredClone(value)
    } catch {
      try {
        return JSON.parse(JSON.stringify(value)) as unknown
      } catch {
        return value
      }
    }
  }

  private cloneHistoryRecord(
    input: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {}
    }
    const cloned = this.cloneHistoryValue(input)
    return cloned && typeof cloned === "object" && !Array.isArray(cloned)
      ? (cloned as Record<string, unknown>)
      : {}
  }

  private stringifyHistoryForComparison(value: unknown): string {
    try {
      return JSON.stringify(value)
    } catch {
      return ""
    }
  }

  private removeInflatedHistoryFields(
    input: Record<string, unknown>
  ): Record<string, unknown> {
    const next = this.cloneHistoryRecord(input)
    for (const key of [
      "documents",
      "results",
      "rules",
      "available_skills",
      "search_hits",
      "files",
      "file_results",
      "client_side_tool_v2",
      "fix_lints_replay",
      "before_diagnostics_total",
      "after_diagnostics_total",
      "beforeDiagnosticsTotal",
      "afterDiagnosticsTotal",
    ]) {
      delete next[key]
    }
    return next
  }

  private pickHistoryFields(
    input: Record<string, unknown>,
    keys: string[]
  ): Record<string, unknown> {
    const next: Record<string, unknown> = {}
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue
      next[key] = this.cloneHistoryValue(input[key])
    }
    return next
  }

  private compactToolInputForHistory(
    toolName: string,
    input: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    const source = this.cloneHistoryRecord(input)
    const family = this.normalizeDeferredToolFamily(toolName)

    if (family === "read_project") {
      return this.pickHistoryFields(source, ["key", "path"])
    }

    if (family === "fetch_rules") {
      return this.pickHistoryFields(source, [
        "skill_name",
        "skillName",
        "query",
        "path",
      ])
    }

    if (
      family === "semantic_search" ||
      family === "deep_search" ||
      family === "search_symbols" ||
      family === "go_to_definition"
    ) {
      return this.pickHistoryFields(source, [
        "query",
        "search_term",
        "symbol",
        "path",
        "targetDirectories",
        "target_directories",
      ])
    }

    if (family === "read_semsearch_files") {
      return this.pickHistoryFields(source, ["file_paths", "paths", "files"])
    }

    if (family === "fix_lints") {
      return this.pickHistoryFields(source, ["paths", "path"])
    }

    return this.removeInflatedHistoryFields(source)
  }

  private compactLineOrientedReadonlyToolResult(
    content: string,
    options?: { maxLines?: number; maxChars?: number }
  ): string {
    if (!content) return content
    if (content.includes("[history compacted:")) return content

    const maxLines =
      options?.maxLines ?? this.INFLATING_READONLY_TOOL_RESULT_MAX_LINES
    const maxChars =
      options?.maxChars ?? this.INFLATING_READONLY_TOOL_RESULT_MAX_CHARS
    const lines = content.split(/\r?\n/)
    if (content.length <= maxChars && lines.length <= maxLines) {
      return content
    }

    let head = lines.slice(0, maxLines).join("\n")
    if (head.length > maxChars) {
      head = head.slice(0, maxChars).trimEnd()
    }
    const omittedLines = Math.max(lines.length - maxLines, 0)
    const omittedChars = Math.max(content.length - head.length, 0)
    return [
      head,
      `[history compacted: omitted ${omittedLines} line(s), ${omittedChars} char(s)]`,
    ]
      .filter(Boolean)
      .join("\n")
  }

  private compactReadProjectResultForHistory(content: string): string {
    if (!content || content.includes("[history compacted:")) return content
    if (content.length <= this.INFLATING_READONLY_TOOL_RESULT_MAX_CHARS) {
      return content
    }

    const lines = content.split(/\r?\n/)
    const firstLine = lines[0] || "[read_project success]"
    const body = lines.slice(1).join("\n").trim()
    const sections = body
      .split(/\n{2}---\n{2}/)
      .map((section) => section.trim())
      .filter(Boolean)
    if (sections.length === 0) {
      return this.compactLineOrientedReadonlyToolResult(content)
    }

    const compactSections = sections.slice(0, 8).map((section) => {
      const sectionLines = section.split(/\r?\n/)
      const pathLine = sectionLines[0] || "Path: (unknown)"
      const sectionBody = sectionLines.slice(1).join("\n").trim()
      const preview =
        sectionBody.length > 900
          ? `${sectionBody.slice(0, 900).trimEnd()}\n[document preview truncated]`
          : sectionBody
      return [pathLine, preview].filter(Boolean).join("\n")
    })
    const compactContent = [firstLine, compactSections.join("\n\n---\n\n")]
      .filter(Boolean)
      .join("\n\n")
    const omittedSections = Math.max(
      sections.length - compactSections.length,
      0
    )
    const omittedChars = Math.max(content.length - compactContent.length, 0)

    return [
      compactContent,
      `[history compacted: omitted ${omittedSections} document(s), ${omittedChars} char(s)]`,
    ]
      .filter(Boolean)
      .join("\n\n")
  }

  private compactReadonlyToolResultForHistory(
    toolName: string,
    content: string,
    toolInput?: Record<string, unknown>
  ): string {
    const family = this.normalizeDeferredToolFamily(toolName)
    if (family === "read_project") {
      return this.compactReadProjectResultForHistory(content)
    }
    if (
      family === "semantic_search" ||
      family === "deep_search" ||
      family === "search_symbols" ||
      family === "go_to_definition" ||
      (family === "fetch_rules" &&
        !this.pickFirstString(toolInput || {}, ["skill_name", "skillName"]))
    ) {
      return this.compactLineOrientedReadonlyToolResult(content)
    }
    return content
  }

  private isStoredToolResultReferenceContent(content: string): boolean {
    return content.includes("[tool_result stored]")
  }

  private isClearedToolResultContent(content: string): boolean {
    return content.includes("[Old tool result content cleared]")
  }

  private normalizeEmptyToolResultContent(
    toolName: string,
    content: string
  ): string {
    return content.trim().length === 0
      ? `(${toolName || "tool"} completed with no output)`
      : content
  }

  private rememberToolResultReplacement(
    replacementState: ContextToolResultReplacementState | undefined,
    toolUseId: string,
    replacement: string,
    reason: "empty" | "microcompact" = "empty"
  ): void {
    if (!replacementState || !toolUseId) return
    const seen = new Set(replacementState.seenToolUseIds || [])
    seen.add(toolUseId)
    replacementState.seenToolUseIds = Array.from(seen)
    replacementState.replacementByToolUseId = {
      ...(replacementState.replacementByToolUseId || {}),
      [toolUseId]: replacement,
    }
    const records = replacementState.records || []
    if (
      !records.some(
        (record) =>
          record.kind === "tool-result" &&
          record.toolUseId === toolUseId &&
          record.replacement === replacement
      )
    ) {
      replacementState.records = [
        ...records,
        {
          kind: "tool-result",
          toolUseId,
          replacement,
          reason,
          createdAt: Date.now(),
        },
      ]
    }
  }

  private markToolResultSeen(
    replacementState: ContextToolResultReplacementState | undefined,
    toolUseId: string
  ): void {
    if (!replacementState || !toolUseId) return
    const seen = new Set(replacementState.seenToolUseIds || [])
    if (seen.has(toolUseId)) return
    seen.add(toolUseId)
    replacementState.seenToolUseIds = Array.from(seen)
  }

  private hasToolResultSeen(
    replacementState: ContextToolResultReplacementState | undefined,
    toolUseId: string
  ): boolean {
    return !!replacementState?.seenToolUseIds?.includes(toolUseId)
  }

  private isInflatingReadonlyToolResult(
    toolName: string,
    toolInput?: Record<string, unknown>
  ): boolean {
    const family = this.normalizeDeferredToolFamily(toolName)
    return (
      family === "read_project" ||
      family === "semantic_search" ||
      family === "deep_search" ||
      family === "search_symbols" ||
      family === "go_to_definition" ||
      family === "read_semsearch_files" ||
      (family === "fetch_rules" &&
        !this.pickFirstString(toolInput || {}, ["skill_name", "skillName"]))
    )
  }

  private shouldStoreToolResultForHistory(
    toolName: string,
    content: string,
    toolInput?: Record<string, unknown>
  ): boolean {
    if (
      !content ||
      this.isStoredToolResultReferenceContent(content) ||
      this.isClearedToolResultContent(content)
    ) {
      return false
    }

    if (this.isInflatingReadonlyToolResult(toolName, toolInput)) {
      const lineCount = content.split(/\r?\n/).length
      return (
        content.length > this.INFLATING_READONLY_TOOL_STORAGE_THRESHOLD_CHARS ||
        lineCount > this.INFLATING_READONLY_TOOL_RESULT_MAX_LINES
      )
    }

    return content.length > this.GENERIC_TOOL_RESULT_STORAGE_THRESHOLD_CHARS
  }

  private storeToolResultForHistory(
    conversationId: string | undefined,
    toolUseId: string,
    toolName: string,
    content: string,
    toolInput?: Record<string, unknown>,
    replacementState?: ContextToolResultReplacementState,
    options?: {
      force?: boolean
      reason?: "per_tool" | "aggregate"
      freezeSeen?: boolean
    }
  ): string {
    const normalizedContent = this.normalizeEmptyToolResultContent(
      toolName,
      content
    )
    if (normalizedContent !== content) {
      this.rememberToolResultReplacement(
        replacementState,
        toolUseId,
        normalizedContent,
        "empty"
      )
      return normalizedContent
    }

    if (!conversationId || !toolUseId || !normalizedContent) {
      return this.compactReadonlyToolResultForHistory(
        toolName,
        normalizedContent,
        toolInput
      )
    }
    if (
      this.isStoredToolResultReferenceContent(normalizedContent) ||
      this.isClearedToolResultContent(normalizedContent)
    ) {
      return normalizedContent
    }

    const existingReplacement =
      replacementState?.replacementByToolUseId?.[toolUseId]
    if (existingReplacement) {
      return existingReplacement
    }

    const thresholdChars = this.isInflatingReadonlyToolResult(
      toolName,
      toolInput
    )
      ? this.INFLATING_READONLY_TOOL_STORAGE_THRESHOLD_CHARS
      : this.GENERIC_TOOL_RESULT_STORAGE_THRESHOLD_CHARS
    const processed = this.toolResultStorage.processToolResultForHistory({
      conversationId,
      toolUseId,
      toolName,
      content: normalizedContent,
      replacementState,
      force: options?.force,
      reason: options?.reason || "per_tool",
      thresholdChars,
    })

    if (processed !== normalizedContent) {
      return processed
    }

    return this.compactReadonlyToolResultForHistory(
      toolName,
      normalizedContent,
      toolInput
    )
  }

  private collectAggregateToolResultBudgetGroups(
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>
  ): HistoryToolResultCandidate[][] {
    const toolUsesById = new Map<string, HistoryToolMetadata>()
    const groups: HistoryToolResultCandidate[][] = []
    let currentGroup: HistoryToolResultCandidate[] = []
    const flush = () => {
      if (currentGroup.length > 0) {
        groups.push(currentGroup)
        currentGroup = []
      }
    }

    for (const message of messages) {
      if (!Array.isArray(message.content)) {
        continue
      }

      if (message.role === "assistant") {
        flush()
        for (const block of message.content) {
          if (!this.isLooseRecord(block) || block.type !== "tool_use") continue
          const id = typeof block.id === "string" ? block.id : ""
          if (!id) continue
          const toolName =
            typeof block.name === "string" && block.name
              ? block.name
              : "unknown_tool"
          const input =
            block.input &&
            typeof block.input === "object" &&
            !Array.isArray(block.input)
              ? (block.input as Record<string, unknown>)
              : {}
          toolUsesById.set(id, { toolName, input })
        }
        continue
      }

      for (const block of message.content) {
        if (!this.isLooseRecord(block) || block.type !== "tool_result") {
          continue
        }
        const toolUseId =
          typeof block.tool_use_id === "string" ? block.tool_use_id : ""
        const content = typeof block.content === "string" ? block.content : ""
        if (
          !toolUseId ||
          !content ||
          this.isStoredToolResultReferenceContent(content) ||
          this.isClearedToolResultContent(content)
        ) {
          continue
        }
        const pairedTool = toolUsesById.get(toolUseId)
        if (!pairedTool) continue
        currentGroup.push({
          toolUseId,
          toolName: pairedTool.toolName,
          input: pairedTool.input,
          content,
          size: content.length,
        })
      }
    }
    flush()
    return groups
  }

  private selectAggregateToolResultsToStore(
    fresh: HistoryToolResultCandidate[],
    frozenSize: number,
    limit: number
  ): HistoryToolResultCandidate[] {
    let remaining = frozenSize + fresh.reduce((sum, item) => sum + item.size, 0)
    if (remaining <= limit) return []

    const selected: HistoryToolResultCandidate[] = []
    for (const candidate of [...fresh].sort((a, b) => b.size - a.size)) {
      if (remaining <= limit) break
      selected.push(candidate)
      remaining -= candidate.size
    }
    return selected
  }

  private applyToolResultReplacementMap(
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>,
    replacementByToolUseId: ReadonlyMap<string, string>
  ): Array<{ role: "user" | "assistant"; content: MessageContent }> {
    return messages.map((message) => {
      if (message.role !== "user" || !Array.isArray(message.content)) {
        return message
      }
      let touched = false
      const content = message.content.map((block) => {
        if (!this.isLooseRecord(block) || block.type !== "tool_result") {
          return block
        }
        const toolUseId =
          typeof block.tool_use_id === "string" ? block.tool_use_id : ""
        const replacement = replacementByToolUseId.get(toolUseId)
        if (replacement === undefined) {
          return block
        }
        touched = true
        return { ...block, content: replacement }
      })
      return touched
        ? { ...message, content: content as MessageContent }
        : message
    })
  }

  private enforceAggregateToolResultBudgetForHistory(
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>,
    options?: {
      conversationId?: string
      replacementState?: ContextToolResultReplacementState
    }
  ): {
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>
    changed: boolean
    storedToolResults: number
  } {
    const replacementState = options?.replacementState
    const conversationId = options?.conversationId
    if (!replacementState || !conversationId) {
      return { messages, changed: false, storedToolResults: 0 }
    }

    const replacementMap = new Map<string, string>()
    let storedToolResults = 0
    for (const group of this.collectAggregateToolResultBudgetGroups(messages)) {
      const fresh: HistoryToolResultCandidate[] = []
      const frozenSize = 0
      for (const candidate of group) {
        const replacement =
          replacementState.replacementByToolUseId?.[candidate.toolUseId]
        if (replacement !== undefined) {
          replacementMap.set(candidate.toolUseId, replacement)
          continue
        }
        fresh.push(candidate)
      }

      const selected = this.selectAggregateToolResultsToStore(
        fresh,
        frozenSize,
        this.AGGREGATE_TOOL_RESULT_STORAGE_BUDGET_CHARS
      )
      const selectedIds = new Set(selected.map((item) => item.toolUseId))
      for (const candidate of fresh) {
        if (!selectedIds.has(candidate.toolUseId)) {
          this.markToolResultSeen(replacementState, candidate.toolUseId)
        }
      }

      for (const candidate of selected) {
        const replacement = this.storeToolResultForHistory(
          conversationId,
          candidate.toolUseId,
          candidate.toolName,
          candidate.content,
          candidate.input,
          replacementState,
          { force: true, reason: "aggregate", freezeSeen: false }
        )
        this.markToolResultSeen(replacementState, candidate.toolUseId)
        if (replacement !== candidate.content) {
          replacementMap.set(candidate.toolUseId, replacement)
          storedToolResults++
        }
      }
    }

    if (replacementMap.size === 0) {
      return { messages, changed: false, storedToolResults }
    }
    return {
      messages: this.applyToolResultReplacementMap(messages, replacementMap),
      changed: true,
      storedToolResults,
    }
  }

  private compactInflatingReadonlyToolHistory(
    messages: Array<{
      role: "user" | "assistant"
      content: MessageContent
    }>,
    options?: {
      conversationId?: string
      replacementState?: ContextToolResultReplacementState
    }
  ): {
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>
    compactedToolInputs: number
    compactedToolResults: number
  } {
    let changed = false
    let compactedToolInputs = 0
    let compactedToolResults = 0
    const toolUsesById = new Map<
      string,
      { toolName: string; input: Record<string, unknown> }
    >()

    const nextMessages = messages.map((message) => {
      if (!Array.isArray(message.content)) {
        return message
      }

      let contentChanged = false
      const nextContent = message.content.map((block) => {
        if (!this.isLooseRecord(block)) {
          return block
        }

        if (message.role === "assistant" && block.type === "tool_use") {
          const id = typeof block.id === "string" ? block.id : ""
          const toolName =
            typeof block.name === "string" && block.name
              ? block.name
              : "unknown_tool"
          const input =
            block.input &&
            typeof block.input === "object" &&
            !Array.isArray(block.input)
              ? (block.input as Record<string, unknown>)
              : {}
          const compactInput = this.compactToolInputForHistory(toolName, input)
          toolUsesById.set(id, { toolName, input: compactInput })

          if (
            this.stringifyHistoryForComparison(compactInput) ===
            this.stringifyHistoryForComparison(input)
          ) {
            return block
          }

          contentChanged = true
          compactedToolInputs++
          return {
            ...block,
            input: compactInput,
          }
        }

        if (message.role === "user" && block.type === "tool_result") {
          const toolUseId =
            typeof block.tool_use_id === "string" ? block.tool_use_id : ""
          const pairedTool = toolUsesById.get(toolUseId)
          if (!pairedTool || typeof block.content !== "string") {
            return block
          }
          const existingReplacement =
            options?.replacementState?.replacementByToolUseId?.[toolUseId]
          const compactContent = existingReplacement
            ? existingReplacement
            : this.storeToolResultForHistory(
                options?.conversationId,
                toolUseId,
                pairedTool.toolName,
                block.content,
                pairedTool.input,
                options?.replacementState
              )

          const fallbackCompactContent =
            compactContent === block.content
              ? this.compactReadonlyToolResultForHistory(
                  pairedTool.toolName,
                  block.content,
                  pairedTool.input
                )
              : compactContent
          if (fallbackCompactContent === block.content) {
            return block
          }

          contentChanged = true
          compactedToolResults++
          return {
            ...block,
            content: fallbackCompactContent,
          }
        }

        return block
      })

      if (!contentChanged) {
        return message
      }

      changed = true
      return {
        ...message,
        content: nextContent as MessageContent,
      }
    })

    const afterPerToolPass = changed ? nextMessages : messages
    const aggregate = this.enforceAggregateToolResultBudgetForHistory(
      afterPerToolPass,
      options
    )
    if (aggregate.changed) {
      changed = true
      compactedToolResults += aggregate.storedToolResults
    }

    return {
      messages: changed ? aggregate.messages : messages,
      compactedToolInputs,
      compactedToolResults,
    }
  }

  private queuePendingContextSummaryUiUpdate(
    session: ChatSession,
    conversationId: string,
    options?: {
      compactionId?: string
      summary?: string
      epoch?: number
    }
  ): void {
    const activeCompactionId =
      options?.compactionId || session.contextState.activeCompactionId
    if (!activeCompactionId) {
      return
    }

    const epoch =
      typeof options?.epoch === "number"
        ? options.epoch
        : session.contextState.compactionEpoch || 0

    if (
      session.lastEmittedContextSummaryCompactionId === activeCompactionId &&
      session.lastEmittedContextSummaryCompactionEpoch === epoch &&
      !session.pendingContextSummaryUiUpdate
    ) {
      return
    }
    if (
      session.pendingContextSummaryUiUpdate?.compactionId ===
        activeCompactionId &&
      session.pendingContextSummaryUiUpdate.epoch === epoch
    ) {
      return
    }

    const activeCommit = session.contextState.compactionHistory.find(
      (commit) => commit.id === activeCompactionId
    )
    const summary = options?.summary || activeCommit?.summary
    if (!summary?.trim()) {
      return
    }

    session.pendingContextSummaryUiUpdate = {
      compactionId: activeCompactionId,
      summary,
      epoch,
    }
    this.sessionManager.markSessionDirty(conversationId)
  }

  private *emitPendingContextSummaryUiUpdate(
    conversationId: string
  ): Generator<Buffer> {
    const session = this.sessionManager.getSession(conversationId)
    const pending = session?.pendingContextSummaryUiUpdate
    if (!session || !pending) {
      return
    }

    yield this.grpcService.createSummaryStartedResponse()
    yield this.grpcService.createSummaryResponse(pending.summary)
    yield this.grpcService.createSummaryCompletedResponse()

    session.lastEmittedContextSummaryCompactionId = pending.compactionId
    session.lastEmittedContextSummaryCompactionEpoch = pending.epoch
    session.pendingContextSummaryUiUpdate = undefined
    this.sessionManager.markSessionDirty(conversationId)
    this.logger.log(
      `Emitted context compaction summary UI update for ${conversationId}: ${pending.compactionId}`
    )
  }

  private truncateMessagesForBackend(
    session: ChatSession,
    backend: BackendType,
    budget: ContextProjectionBudget,
    options?: {
      contextLabel?: string
      model?: string
      pendingToolUseIds?: string[]
      strategy?: "auto" | "manual" | "reactive"
      dryRun?: boolean
    }
  ): Array<{ role: "user" | "assistant"; content: MessageContent }> {
    const contextLabel = options?.contextLabel || session.conversationId
    const integrityMode = this.shouldUseStrictAdjacentToolIntegrity(backend)
      ? "strict-adjacent"
      : "global"
    const primary = this.contextRequestPlanner.projectState(
      session.contextState,
      this.buildContextAttachmentSnapshot(session),
      budget,
      {
        pendingToolUseIds: options?.pendingToolUseIds,
        integrityMode,
        strategy: options?.strategy || "auto",
        dryRun: options?.dryRun,
        nativeCacheEdits: this.shouldUseClaudeNativeCacheEdits(
          backend,
          options?.model || session.model
        ),
      }
    )
    this.resetCodexContinuationAfterProjectionRewrite(
      backend,
      session.conversationId,
      options?.model || session.model,
      primary,
      contextLabel
    )
    if (primary.appliedCompaction) {
      this.sessionManager.markContextStateDirty(session.conversationId)
      this.queuePendingContextSummaryUiUpdate(session, session.conversationId, {
        compactionId: primary.appliedCompaction.commit.id,
        summary: primary.appliedCompaction.commit.summary,
        epoch: session.contextState.compactionEpoch || 0,
      })
      this.logger.log(
        `Applied context compaction (${contextLabel}): estimated ${primary.estimatedTokens} tokens after projection`
      )
    }
    if (options?.dryRun && primary.wasCompacted) {
      this.logger.debug(
        `Dry-run context compaction projected (${contextLabel}): estimated ${primary.estimatedTokens} tokens`
      )
    }
    if (primary.snipCompaction?.changed) {
      this.logger.log(
        `Applied snip compaction (${contextLabel}): ` +
          `${primary.snipCompaction.removedRecords} live records summarized, ` +
          `${primary.snipCompaction.retainedRecords} retained`
      )
    }
    if (primary.microcompactCompaction?.changed) {
      this.logger.log(
        `Applied ${primary.microcompactCompaction.trigger} microcompact (${contextLabel}): ` +
          `${primary.microcompactCompaction.clearedToolResults} results across ` +
          `${primary.microcompactCompaction.compactedRounds} API rounds`
      )
    }
    if (
      primary.nativeCacheEditCompaction?.changed ||
      (primary.nativeCacheEditCompaction?.newlyRegisteredToolResults ?? 0) > 0
    ) {
      this.sessionManager.markContextStateDirty(session.conversationId)
    }
    if (primary.nativeCacheEditCompaction?.changed) {
      this.logger.log(
        `Applied native cache edits (${contextLabel}): ` +
          `${primary.nativeCacheEditCompaction.newlyDeletedToolResults} tool results, ` +
          `${primary.nativeCacheEditCompaction.pinnedEditBlocks} pinned edit block(s)`
      )
    }

    const projectedForBackend =
      backend === "codex"
        ? this.codexContextAdapter.projectCodexMessages(
            session.contextState,
            primary.messages,
            {
              maxTokens: budget.maxTokens,
              systemPromptTokens: budget.systemPromptTokens,
              pendingToolUseIds: options?.pendingToolUseIds,
            }
          )
        : primary.messages

    const truncatedMessages = projectedForBackend as Array<{
      role: "user" | "assistant"
      content: MessageContent
    }>

    const postTruncNormalized = normalizeToolProtocolMessages(
      truncatedMessages as Array<{
        role: "user" | "assistant"
        content: unknown
      }>,
      {
        mode: integrityMode,
        pendingToolUseIds: options?.pendingToolUseIds,
      }
    )
    if (postTruncNormalized.changed) {
      this.logger.warn(
        `Post-projection integrity repair (${contextLabel}, mode=${integrityMode}): ` +
          `injected ${postTruncNormalized.injectedToolResults} synthetic tool_result, ` +
          `removed ${postTruncNormalized.removedToolResults} orphan tool_result`
      )
      const repairedMessages = postTruncNormalized.messages as Array<{
        role: "user" | "assistant"
        content: MessageContent
      }>
      const modelMessages =
        this.stripSubAgentUiPayloadsForBackend(repairedMessages)
      this.updatePendingRequestContextLedger(
        session,
        primary.projectedMessages,
        modelMessages
      )
      return modelMessages
    }

    const modelMessages =
      this.stripSubAgentUiPayloadsForBackend(truncatedMessages)
    this.updatePendingRequestContextLedger(
      session,
      primary.projectedMessages,
      modelMessages
    )
    return modelMessages
  }

  private toCodexConversationMessages(
    messages: UnifiedMessage[]
  ): CodexExecutionRequest["messages"] {
    return messages.flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") {
        return []
      }
      return [
        {
          role: message.role,
          content: message.content,
        },
      ]
    })
  }

  private async compactCodexSessionForRoute(
    session: ChatSession,
    route: ModelRouteResult,
    budget: ContextProjectionBudget,
    options: {
      contextLabel: string
      model?: string
      pendingToolUseIds?: string[]
      toolDefinitions?: ToolDefinition[]
      strategy: "auto" | "manual" | "reactive"
      injectionMode: "pre_turn" | "mid_turn"
      hookUserMessage?: string
      hookProvider?: (
        candidate: ContextCompactionCandidate
      ) => Promise<string | undefined>
    }
  ) {
    const promptContext = this.buildPromptContextFromSession(session)
    const systemPrompt = this.buildCodexSystemPrompt(
      promptContext,
      session.deferredToolCatalog
    )
    const referenceContextItem =
      this.codexContextAdapter.buildReferenceContextItem({
        conversationId: session.conversationId,
        model: options.model || route.model || session.model,
        systemPrompt,
        toolDefinitions: options.toolDefinitions,
        contextTokenLimit: budget.maxTokens,
        serviceTier: this.resolveRequestedCodexServiceTier(
          session.requestedModelParameters
        ),
        reasoningEffort: this.resolveRequestedReasoningEffort(
          session.requestedModelParameters
        ),
      })
    return this.codexContextAdapter.compactIfNeeded(
      session.contextState,
      this.buildContextAttachmentSnapshot(session),
      {
        maxTokens: budget.maxTokens,
        systemPromptTokens: budget.systemPromptTokens,
        autoCompactTokenLimit: budget.autoCompactTokenLimit,
        predictiveCompactTokenLimit: budget.predictiveCompactTokenLimit,
        strategy: options.strategy,
        integrityMode: "global",
        referenceContextItem,
        injectionMode: options.injectionMode,
        hookUserMessage: options.hookUserMessage,
        hookProvider: options.hookProvider,
        remoteCompactProvider: async ({ messages }) => ({
          replacementHistory:
            await this.codexService.compactConversationHistory({
              model: options.model || route.model || session.model,
              system: systemPrompt,
              messages: this.toCodexConversationMessages(messages),
              tools: options.toolDefinitions,
              conversationId: session.conversationId,
              pendingToolUseIds: options.pendingToolUseIds,
              serviceTier: this.resolveRequestedCodexServiceTier(
                session.requestedModelParameters
              ),
              textVerbosity: "low",
            }),
        }),
      }
    )
  }

  private async prepareContextWithCompactRunner(
    session: ChatSession,
    route: ModelRouteResult,
    budget: ContextProjectionBudget,
    options: {
      contextLabel: string
      model?: string
      pendingToolUseIds?: string[]
      toolDefinitions?: ToolDefinition[]
      strategy: "auto" | "manual" | "reactive"
      hookUserMessage?: string
    }
  ): Promise<void> {
    return this.contextPipeline.runMutation(
      session.conversationId,
      options.contextLabel,
      () =>
        this.prepareContextWithCompactRunnerUnlocked(
          session,
          route,
          budget,
          options
        )
    )
  }

  private async prepareContextWithCompactRunnerUnlocked(
    session: ChatSession,
    route: ModelRouteResult,
    budget: ContextProjectionBudget,
    options: {
      contextLabel: string
      model?: string
      pendingToolUseIds?: string[]
      toolDefinitions?: ToolDefinition[]
      strategy: "auto" | "manual" | "reactive"
      hookUserMessage?: string
    }
  ): Promise<void> {
    const integrityMode = this.shouldUseStrictAdjacentToolIntegrity(
      route.backend
    )
      ? "strict-adjacent"
      : "global"
    if (route.backend === "codex") {
      let hookUserMessage = options.hookUserMessage
      const promptContext = this.buildPromptContextFromSession(session)
      const systemPrompt = this.buildCodexSystemPrompt(
        promptContext,
        session.deferredToolCatalog
      )
      const referenceContextItem =
        this.codexContextAdapter.buildReferenceContextItem({
          conversationId: session.conversationId,
          model: options.model || route.model || session.model,
          systemPrompt,
          toolDefinitions: options.toolDefinitions,
          contextTokenLimit: budget.maxTokens,
          serviceTier: this.resolveRequestedCodexServiceTier(
            session.requestedModelParameters
          ),
          reasoningEffort: this.resolveRequestedReasoningEffort(
            session.requestedModelParameters
          ),
        })
      const plan = await this.codexContextAdapter.compactIfNeeded(
        session.contextState,
        this.buildContextAttachmentSnapshot(session),
        {
          maxTokens: budget.maxTokens,
          systemPromptTokens: budget.systemPromptTokens,
          autoCompactTokenLimit: budget.autoCompactTokenLimit,
          predictiveCompactTokenLimit: budget.predictiveCompactTokenLimit,
          strategy: options.strategy,
          integrityMode,
          referenceContextItem,
          injectionMode:
            options.strategy === "reactive" ? "mid_turn" : "pre_turn",
          hookUserMessage,
          hookProvider: async (candidate) => {
            hookUserMessage = await this.runPreCompactHookForCandidate(
              session,
              options.strategy,
              route,
              budget,
              candidate,
              options.model
            )
            return hookUserMessage
          },
          remoteCompactProvider: async ({ messages }) => ({
            replacementHistory:
              await this.codexService.compactConversationHistory({
                model: options.model || route.model || session.model,
                system: systemPrompt,
                messages: this.toCodexConversationMessages(messages),
                tools: options.toolDefinitions,
                conversationId: session.conversationId,
                pendingToolUseIds: options.pendingToolUseIds,
                serviceTier: this.resolveRequestedCodexServiceTier(
                  session.requestedModelParameters
                ),
                textVerbosity: "low",
              }),
          }),
        }
      )
      if (!plan) return

      this.sessionManager.markContextStateDirty(session.conversationId)
      const renderedSummary = hookUserMessage
        ? `${hookUserMessage}\n\n${plan.commit.summary}`
        : plan.commit.summary
      this.queuePendingContextSummaryUiUpdate(session, session.conversationId, {
        compactionId: plan.commit.id,
        summary: renderedSummary,
        epoch: session.contextState.compactionEpoch || 0,
      })
      this.logger.log(
        `Context compact applied: backend=${route.backend}, model=${options.model || route.model || session.model}, ` +
          `strategy=${options.strategy}, budget=${budget.maxTokens}, estimatedTokens=${plan.estimatedTokens}, ` +
          `compactionId=${plan.commit.id}`
      )
      this.resetCodexContinuationAfterProjectionRewrite(
        route.backend,
        session.conversationId,
        options.model || session.model,
        {
          messages: [],
          projectedMessages: [],
          estimatedTokens: plan.estimatedTokens,
          wasCompacted: true,
          appliedCompaction: plan,
        },
        options.contextLabel
      )
      return
    }
    const provider = this.buildNoToolsCompactSummaryProvider(
      route,
      session,
      options.contextLabel
    )
    let hookUserMessage = options.hookUserMessage
    const plan = await this.contextCompactRunner.compactIfNeeded(
      session.contextState,
      this.buildContextAttachmentSnapshot(session),
      {
        maxTokens: budget.maxTokens,
        systemPromptTokens: budget.systemPromptTokens,
        autoCompactTokenLimit: budget.autoCompactTokenLimit,
        predictiveCompactTokenLimit: budget.predictiveCompactTokenLimit,
        strategy: options.strategy,
        integrityMode,
        summaryProvider: provider,
        hookUserMessage,
        hookProvider: async (candidate) => {
          hookUserMessage = await this.runPreCompactHookForCandidate(
            session,
            options.strategy,
            route,
            budget,
            candidate,
            options.model
          )
          return hookUserMessage
        },
      }
    )
    if (!plan) return

    this.sessionManager.markContextStateDirty(session.conversationId)
    const renderedSummary = hookUserMessage
      ? `${hookUserMessage}\n\n${plan.commit.summary}`
      : plan.commit.summary
    this.queuePendingContextSummaryUiUpdate(session, session.conversationId, {
      compactionId: plan.commit.id,
      summary: renderedSummary,
      epoch: session.contextState.compactionEpoch || 0,
    })
    this.logger.log(
      `Context compact applied: backend=${route.backend}, model=${options.model || route.model || session.model}, ` +
        `strategy=${options.strategy}, budget=${budget.maxTokens}, estimatedTokens=${plan.estimatedTokens}, ` +
        `compactionId=${plan.commit.id}`
    )
    this.resetCodexContinuationAfterProjectionRewrite(
      route.backend,
      session.conversationId,
      options.model || session.model,
      {
        messages: [],
        projectedMessages: [],
        estimatedTokens: plan.estimatedTokens,
        wasCompacted: true,
        appliedCompaction: plan,
      },
      options.contextLabel
    )
  }

  private async runPreCompactHookForCandidate(
    session: ChatSession,
    strategy: "auto" | "manual" | "reactive",
    route: ModelRouteResult,
    budget: Pick<ContextProjectionBudget, "maxTokens" | "systemPromptTokens">,
    candidate: ContextCompactionCandidate,
    model?: string
  ): Promise<string | undefined> {
    const contextTokens = Math.max(
      0,
      candidate.sourceTokenCount + candidate.retainedTokenCount
    )
    const contextWindow = Math.max(
      1,
      budget.maxTokens - budget.systemPromptTokens
    )
    const archivedMessageCount =
      candidate.archivedRecords.filter(isMessageRecord).length
    const hookPayload: PreCompactHookPayload = {
      trigger: this.toPreCompactHookTrigger(strategy),
      context_usage_percent: Math.min(
        100,
        Math.max(0, Math.round((contextTokens / contextWindow) * 100))
      ),
      context_tokens: contextTokens,
      context_window_size: contextWindow,
      message_count:
        session.contextState.records.filter(isMessageRecord).length,
      messages_to_compact: archivedMessageCount,
      is_first_compaction: session.contextState.compactionHistory.length === 0,
      conversation_id: session.conversationId,
      generation_id: candidate.commitId,
      model: model || route.model || session.model,
    }
    return this.contextHookExecutor.runPreCompactHook(
      session.projectContext?.rootPath,
      hookPayload
    )
  }

  private toPreCompactHookTrigger(
    strategy: "auto" | "manual" | "reactive"
  ): string {
    switch (strategy) {
      case "manual":
        return "manual"
      case "reactive":
        return "context_full"
      case "auto":
        return "automatic"
    }
  }

  private buildNoToolsCompactSummaryProvider(
    route: ModelRouteResult,
    session: ChatSession,
    contextLabel: string
  ): ContextCompactRunnerSummaryProvider {
    return async ({ prompt, maxTokens }) => {
      const dto: CreateMessageDto = {
        model: route.model,
        max_tokens: Math.max(256, Math.min(4096, maxTokens)),
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        tools: [],
        stream: false,
      }
      if (session.conversationId) {
        dto._conversationId = `${session.conversationId}:compact`
      }
      const response = await this.sendNoToolsCompactRequest(route, dto)
      const summary = this.extractTextFromAnthropicResponse(response)
      this.logger.log(
        `No-tools compact summary generated (${contextLabel}): model=${route.model}, tokens=${response.usage?.output_tokens || 0}`
      )
      return { summary }
    }
  }

  private async sendNoToolsCompactRequest(
    route: ModelRouteResult,
    dto: CreateMessageDto
  ): Promise<AnthropicResponse> {
    switch (route.backend) {
      case "codex":
        throw new Error(
          "Codex compact must use the Codex context adapter and Responses compact endpoint."
        )
      case "claude-api":
        return this.anthropicApiService.sendClaudeMessage(dto)
      case "kiro":
        return this.kiroService.sendClaudeMessage(dto)
      case "openai-compat":
        return this.openaiCompatService.sendClaudeMessage(dto)
      case "google":
      case "google-claude":
        return this.googleService.sendClaudeMessage(dto)
    }
  }

  private extractTextFromAnthropicResponse(
    response: AnthropicResponse
  ): string {
    return (response.content || [])
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n")
      .trim()
  }

  private stripSubAgentUiPayloadsForBackend(
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>
  ): Array<{ role: "user" | "assistant"; content: MessageContent }> {
    let changed = false
    const nextMessages = messages.map((message) => {
      if (message.role !== "user" || !Array.isArray(message.content)) {
        return message
      }

      let contentChanged = false
      const nextContent = message.content.map((block) => {
        if (!this.isLooseRecord(block) || block.type !== "tool_result") {
          return block
        }

        let nextBlock: Record<string, unknown> = block
        const structured = this.isLooseRecord(block.structuredContent)
          ? block.structuredContent
          : undefined
        const strippedStructured =
          this.stripTaskSuccessConversationSteps(structured)
        if (strippedStructured !== structured) {
          nextBlock = {
            ...nextBlock,
            structuredContent: strippedStructured,
          }
          contentChanged = true
        }

        const compactedContent = this.compactSubAgentReportForBackend(
          nextBlock.content
        )
        if (compactedContent !== nextBlock.content) {
          nextBlock = {
            ...nextBlock,
            content: compactedContent,
          }
          contentChanged = true
        }

        return nextBlock
      })

      if (!contentChanged) return message
      changed = true
      return {
        ...message,
        content: nextContent as MessageContent,
      }
    })

    return changed ? nextMessages : messages
  }

  private stripTaskSuccessConversationSteps(
    structured: Record<string, unknown> | undefined
  ): Record<string, unknown> | undefined {
    if (!structured) return structured
    const taskSuccess = structured.taskSuccess
    if (
      !this.isLooseRecord(taskSuccess) ||
      !Array.isArray(taskSuccess.conversationSteps)
    ) {
      return structured
    }

    const { conversationSteps: _conversationSteps, ...taskSuccessRest } =
      taskSuccess
    return {
      ...structured,
      taskSuccess: taskSuccessRest,
    }
  }

  private compactSubAgentReportForBackend(content: unknown): unknown {
    if (typeof content === "string") {
      return this.compactSubAgentReportText(content)
    }
    if (!Array.isArray(content)) {
      return content
    }

    let changed = false
    const nextContent = content.map((item) => {
      if (!this.isLooseRecord(item) || item.type !== "text") {
        return item
      }
      const text = typeof item.text === "string" ? item.text : ""
      const compacted = this.compactSubAgentReportText(text)
      if (compacted === text) return item
      changed = true
      return {
        ...item,
        text: compacted,
      }
    })
    return changed ? nextContent : content
  }

  private compactSubAgentReportText(text: string): string {
    if (
      !/(?:Sub-agent execution summary:|Sub-agent result metadata:)/i.test(text)
    ) {
      return text
    }

    const sections = text.split(/\n\s*---\s*\n/u)
    const finalBlock =
      sections.length > 1 ? sections[0]?.trim() || "" : text.trim()
    const rest = sections.length > 1 ? sections.slice(1).join("\n---\n") : text
    const lines = rest
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)

    const metadataLines = lines.filter((line) =>
      /^(?:Sub-agent execution summary:|Sub-agent result metadata:|- agentId:|- turns:|- tool calls:|- duration:|- modified files:)/i.test(
        line
      )
    )
    const evidenceLines = lines
      .filter((line) => /^\d+\.\s+/.test(line))
      .slice(0, 6)

    const rendered: string[] = []
    if (finalBlock) rendered.push(finalBlock)
    if (metadataLines.length > 0 || evidenceLines.length > 0) {
      rendered.push("---")
      rendered.push(
        [
          "Sub-agent result metadata:",
          ...metadataLines.filter(
            (line) =>
              !/^(?:Sub-agent execution summary:|Sub-agent result metadata:)$/i.test(
                line
              )
          ),
        ].join("\n")
      )
    }
    if (evidenceLines.length > 0) {
      rendered.push(`Key tool evidence:\n${evidenceLines.join("\n")}`)
    }
    return rendered.join("\n\n").trim() || text
  }

  private shouldUseClaudeNativeCacheEdits(
    backend: BackendType,
    model?: string
  ): boolean {
    if (backend !== "claude-api") return false
    const betaHeader =
      process.env.ANTHROPIC_CACHE_EDITING_BETA_HEADER?.trim() ||
      process.env.CACHE_EDITING_BETA_HEADER?.trim() ||
      ""
    if (!betaHeader) return false
    if (!model) return false
    return /claude-[a-z]+-4[-\d]/i.test(model) || /claude-4/i.test(model)
  }

  private resetCodexContinuationAfterProjectionRewrite(
    backend: BackendType,
    conversationId: string | undefined,
    modelName: string | undefined,
    result: ContextCompactionResult,
    contextLabel: string
  ): void {
    if (backend !== "codex") {
      return
    }

    const projectionRewritten =
      result.wasCompacted ||
      result.snipCompaction?.changed === true ||
      result.microcompactCompaction?.changed === true ||
      result.toolResultCompaction?.changed === true ||
      result.messages.length < result.projectedMessages.length
    if (!projectionRewritten) {
      return
    }

    this.codexService.resetConversationContinuationState(
      conversationId,
      modelName,
      `context projection rewritten (${contextLabel})`
    )
  }

  private updatePendingRequestContextLedger(
    session: ChatSession,
    projectedMessages: Array<{
      role: "user" | "assistant"
      content: MessageContent
      source?: string
      attachmentKind?: string
    }>,
    finalMessages: Array<{
      role: "user" | "assistant"
      content: MessageContent
    }>
  ): void {
    const projectionLedger = this.contextManager.buildProjectionLedger(
      session.contextState,
      projectedMessages as Parameters<
        ContextManagerService["buildProjectionLedger"]
      >[1]
    )

    session.pendingRequestContextLedger = {
      promptTokenCount: this.tokenCounter.countMessages(
        finalMessages.map((message) => ({
          role: message.role,
          content: message.content as UnifiedMessage["content"],
        })) as UnifiedMessage[]
      ),
      recordedCompactionId: projectionLedger.recordedCompactionId,
      attachmentFingerprint: projectionLedger.attachmentFingerprint,
    }
  }

  private commitAssistantUsageLedger(
    session: ChatSession,
    assistantRecordId: string,
    usage: ContextUsageSnapshot,
    assistantContent: UnifiedMessage["content"]
  ): void {
    this.contextManager.recordAssistantUsage(
      session.contextState,
      assistantRecordId,
      usage,
      {
        promptTokenCount: session.pendingRequestContextLedger?.promptTokenCount,
        recordedCompactionId:
          session.pendingRequestContextLedger?.recordedCompactionId,
        attachmentFingerprint:
          session.pendingRequestContextLedger?.attachmentFingerprint,
        assistantMessage: {
          role: "assistant",
          content: assistantContent,
        },
      }
    )
    this.sessionManager.recordAssistantResponseUsage(
      session.conversationId,
      assistantRecordId,
      usage,
      session.contextState.usageLedger
    )
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

  private buildRetryParsedRequestFromSession(
    session: ChatSession
  ): ParsedCursorRequest {
    return {
      conversation: [],
      newMessage: "",
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      unifiedMode: session.isAgentic ? "AGENT" : "CHAT",
      isAgentic: session.isAgentic,
      supportedTools: [...session.supportedTools],
      useWeb: session.useWeb,
      conversationId: session.conversationId,
      projectContext: session.projectContext,
      codeChunks: session.codeChunks,
      cursorRules: session.cursorRules,
      selectedCursorRulePaths: session.selectedCursorRulePaths,
      selectedCursorRuleNames: session.selectedCursorRuleNames,
      cursorCommands: session.cursorCommands,
      customSystemPrompt: session.customSystemPrompt,
      explicitContext: session.explicitContext,
      contextTokenLimit: session.contextTokenLimit,
      contextMaxMode: session.contextMaxMode,
      usedContextTokens: session.usedContextTokens,
      requestedMaxOutputTokens: session.requestedMaxOutputTokens,
      requestedModelParameters: session.requestedModelParameters,
      mcpToolDefs: session.mcpToolDefs,
    }
  }

  private optimizeImplicitCodexTools(
    backend: BackendType,
    toolNames: string[],
    options?: CursorToolCapabilityOptionsForRoute
  ): string[] {
    if (backend !== "codex" || toolNames.length === 0) {
      return toolNames
    }

    const toolCapabilityOptions = {
      webSearchEnabled: options?.webSearchEnabled,
      webFetchEnabled: options?.webFetchEnabled,
    }

    if (
      !matchesImplicitDefaultAgentToolNames(toolNames, toolCapabilityOptions)
    ) {
      return toolNames
    }

    const optimized = getDefaultCodexImplicitAgentToolNames(
      toolCapabilityOptions
    )
    if (optimized.length === 0 || optimized.length >= toolNames.length) {
      return toolNames
    }

    this.logger.debug(
      `Optimized implicit Codex tool profile: ${toolNames.length} -> ${optimized.length}`
    )
    return optimized
  }

  /**
   * Image generation tools are now always exposed to the model — no
   * client-side intent gating. Modern LLMs reliably decide when to use them.
   */
  private tryParseJsonRecord(value: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }

  private parseCloudCodeToolProtocolError(
    errorMessage: string
  ): ParsedCloudCodeProtocolError | null {
    if (!errorMessage || !errorMessage.includes("Cloud Code")) {
      return null
    }

    const jsonCandidates: string[] = [errorMessage]
    const firstBrace = errorMessage.indexOf("{")
    if (firstBrace >= 0) {
      jsonCandidates.push(errorMessage.slice(firstBrace))
    }

    let normalizedDetail = errorMessage
    let requestId: string | undefined

    for (const candidate of jsonCandidates) {
      const outer = this.tryParseJsonRecord(candidate)
      if (!outer) continue

      const outerError =
        outer.error &&
        typeof outer.error === "object" &&
        !Array.isArray(outer.error)
          ? (outer.error as Record<string, unknown>)
          : undefined
      const outerMessage =
        outerError && typeof outerError.message === "string"
          ? outerError.message
          : undefined
      if (outerMessage) {
        normalizedDetail = outerMessage
      }

      if (!outerMessage) break

      const nested = this.tryParseJsonRecord(outerMessage)
      if (!nested) break

      const nestedError =
        nested.error &&
        typeof nested.error === "object" &&
        !Array.isArray(nested.error)
          ? (nested.error as Record<string, unknown>)
          : undefined
      const nestedMessage =
        nestedError && typeof nestedError.message === "string"
          ? nestedError.message
          : undefined
      if (nestedMessage) {
        normalizedDetail = nestedMessage
      }
      if (typeof nested.request_id === "string" && nested.request_id.trim()) {
        requestId = nested.request_id.trim()
      }
      break
    }

    if (
      !normalizedDetail.includes("unexpected") ||
      !normalizedDetail.includes("tool_result") ||
      !normalizedDetail.includes("tool_use_id")
    ) {
      return null
    }

    const toolUseIdMatch =
      normalizedDetail.match(/tool_result blocks:\s*([A-Za-z0-9_-]+)/i) ||
      normalizedDetail.match(/tool_use_id.*?:\s*([A-Za-z0-9_-]+)/i)
    const toolUseId = toolUseIdMatch?.[1]?.trim()
    if (!toolUseId) return null

    return {
      toolUseId,
      requestId,
      detail: normalizedDetail.trim().slice(0, 1000),
    }
  }

  private *emitCloudCodeProtocolRecoveryQuery(
    conversationId: string,
    backendLabel: string,
    backendModel: string,
    errorMessage: string
  ): Generator<Buffer, boolean> {
    const parsed = this.parseCloudCodeToolProtocolError(errorMessage)
    if (!parsed) return false

    const session = this.sessionManager.getSession(conversationId)
    if (!session) return false

    const payload: CloudCodeProtocolRecoveryPayload = {
      kind: "cloud_code_protocol_recovery",
      backendLabel,
      backendModel,
      toolUseId: parsed.toolUseId,
      requestId: parsed.requestId,
      detail: parsed.detail,
    }
    const { id: queryId } = this.sessionManager.registerInteractionQuery(
      conversationId,
      "cloud_code_protocol_recovery",
      payload
    )

    const requestSuffix = parsed.requestId
      ? `\nrequest_id=${parsed.requestId}`
      : ""
    const toolSuffix = `\ntool_use_id=${parsed.toolUseId}`
    const prompt =
      "Cloud Code 因工具调用历史不合法拒绝了这次请求。" +
      toolSuffix +
      requestSuffix +
      "\n请选择恢复方式："

    yield this.grpcService.createInteractionQueryResponse(
      queryId,
      "askQuestionInteractionQuery",
      {
        args: {
          title: "Cloud Code 会话恢复",
          questions: [
            {
              id: "recovery_action",
              prompt,
              options: [
                {
                  id: "start_new_session",
                  label: "等待修复，开启新会话",
                },
                {
                  id: "remove_bad_tool_call",
                  label: "移除错误工具调用并继续",
                },
              ],
              allowMultiple: false,
            },
          ],
          runAsync: false,
          asyncOriginalToolCallId: "",
        },
        toolCallId: `cloud_code_protocol_recovery_${crypto.randomUUID()}`,
      }
    )

    this.logger.warn(
      `Cloud Code protocol recovery query emitted for ${conversationId}: ` +
        `tool_use_id=${parsed.toolUseId}` +
        (parsed.requestId ? ` request_id=${parsed.requestId}` : "")
    )
    return true
  }

  private extractSelectedAskQuestionOptionId(
    rawResponse: unknown,
    questionId?: string
  ): string | undefined {
    const parsed = this.extractInteractionResultCase(rawResponse)
    const answers = this.normalizeAskQuestionProjectionAnswers(
      parsed.resultValue?.answers
    )
    for (const answer of answers) {
      if (questionId && answer.questionId && answer.questionId !== questionId) {
        continue
      }
      const selected = answer.selectedOptionIds?.find(
        (id) => typeof id === "string" && id.trim().length > 0
      )
      if (selected) return selected
    }
    return undefined
  }

  private removeToolCallPairFromHistory(
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>,
    toolUseId: string,
    pendingToolUseIds?: string[],
    options?: {
      conversationId?: string
      replacementState?: ContextToolResultReplacementState
    }
  ): {
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>
    removedToolUses: number
    removedToolResults: number
  } {
    let removedToolUses = 0
    let removedToolResults = 0
    const compacted: Array<{
      role: "user" | "assistant"
      content: MessageContent
    }> = []

    for (const message of messages) {
      let nextContent = message.content

      if (Array.isArray(message.content)) {
        const filtered = message.content.filter((block) => {
          if (!block || typeof block !== "object") return true
          if (
            block.type === "tool_use" &&
            typeof block.id === "string" &&
            block.id === toolUseId
          ) {
            removedToolUses++
            return false
          }
          if (
            block.type === "tool_result" &&
            typeof block.tool_use_id === "string" &&
            block.tool_use_id === toolUseId
          ) {
            removedToolResults++
            return false
          }
          return true
        })

        if (filtered.length === 0) {
          continue
        }
        nextContent = filtered as MessageContent
      }

      const previous = compacted[compacted.length - 1]
      if (previous?.role === message.role) {
        previous.content = this.mergeMessageContents(
          previous.content,
          nextContent
        )
        continue
      }

      compacted.push({
        role: message.role,
        content: nextContent,
      })
    }

    const normalized = this.normalizeHistoryForBackend(
      compacted,
      `cloud code protocol recovery: ${toolUseId}`,
      {
        pendingToolUseIds,
        conversationId: options?.conversationId,
        replacementState: options?.replacementState,
      }
    )

    return {
      messages: normalized,
      removedToolUses,
      removedToolResults,
    }
  }

  private async *handleCloudCodeProtocolRecoveryInteractionResponse(
    conversationId: string,
    payload: Record<string, unknown> | undefined,
    rawResponse: unknown
  ): AsyncGenerator<Buffer, boolean> {
    if (!payload || payload.kind !== "cloud_code_protocol_recovery") {
      return false
    }

    const session = this.sessionManager.getSession(conversationId)
    if (!session) return true

    const typedPayload = payload as unknown as CloudCodeProtocolRecoveryPayload
    const parsed = this.extractInteractionResultCase(rawResponse)

    if (parsed.resultCase !== "success") {
      const reason =
        parsed.resultCase === "rejected"
          ? this.extractInteractionRejectedReason(rawResponse)
          : this.extractInteractionErrorMessage(rawResponse)
      yield* this.emitAgentFinalTextResponse(
        session,
        `Cloud Code 会话恢复未执行：${reason}`
      )
      return true
    }

    const action =
      this.extractSelectedAskQuestionOptionId(rawResponse, "recovery_action") ||
      "start_new_session"

    if (action === "remove_bad_tool_call") {
      const cleaned = this.removeToolCallPairFromHistory(
        session.messages,
        typedPayload.toolUseId,
        Array.from(session.pendingToolCalls.keys()),
        {
          conversationId,
          replacementState: session.contextState.toolResultReplacementState,
        }
      )

      const removedPending =
        this.sessionManager.consumePendingToolCall(
          conversationId,
          typedPayload.toolUseId
        ) != null

      if (cleaned.removedToolUses > 0 || cleaned.removedToolResults > 0) {
        this.sessionManager.replaceMessages(conversationId, cleaned.messages)
      }

      const latestSession =
        this.sessionManager.getSession(conversationId) || session
      const removedCount =
        cleaned.removedToolUses +
        cleaned.removedToolResults +
        (removedPending ? 1 : 0)

      if (removedCount === 0) {
        const requestSuffix = typedPayload.requestId
          ? ` request_id=${typedPayload.requestId}.`
          : ""
        yield* this.emitAgentFinalTextResponse(
          latestSession,
          `未找到可清理的错误工具调用，无法自动继续当前会话。建议开启新会话。${requestSuffix}`
        )
        return true
      }

      this.logger.warn(
        `Cloud Code recovery cleaned tool_use_id=${typedPayload.toolUseId}, retrying conversation ${conversationId}` +
          (typedPayload.requestId
            ? ` request_id=${typedPayload.requestId}`
            : "")
      )

      try {
        const retryParsed =
          this.buildRetryParsedRequestFromSession(latestSession)
        yield* this.handleChatMessage(conversationId, retryParsed)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        yield* this.emitAgentFinalTextResponse(
          latestSession,
          `Cloud Code 会话已清理，但自动重试失败：${message}`
        )
      }
      return true
    }

    const requestSuffix = typedPayload.requestId
      ? ` request_id=${typedPayload.requestId}.`
      : ""
    yield* this.emitAgentFinalTextResponse(
      session,
      `已保留当前会话原样。建议等待修复后开启新会话继续。${requestSuffix}`
    )
    return true
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
        compactionHistory: this.extractCompactionHistoryForCheckpoint(session),
      }
    )
  }

  private encodeBlobId(blobId: string): Uint8Array {
    return new TextEncoder().encode(blobId)
  }

  private createProtocolBlobSetMessage(
    schema: unknown,
    value: unknown
  ): { blobId: string; buffer: Buffer } {
    const bytes = toBinary(schema as never, value as never)
    const blobId = generateBlobId(Buffer.from(bytes))
    const kvMessage = this.kvStorageService.createSetBinaryBlobMessage(
      blobId,
      bytes
    )
    return {
      blobId,
      buffer: this.grpcService.createKvServerMessageResponse(kvMessage),
    }
  }

  private materializeConversationTurnBlobs(session: ChatSession): {
    turns: string[]
    blobMessages: Buffer[]
  } {
    const materializedTurns =
      this.buildMaterializedConversationTurnsForCheckpoint(session)
    const blobMessages: Buffer[] = []
    const turns: string[] = []

    for (const turn of materializedTurns) {
      const userMessage = create(UserMessageSchema, {
        text: turn.userText,
        messageId: turn.userMessageId,
        mode: AgentMode.AGENT,
        conversationStateBlobId: new Uint8Array(),
      })
      const userBlob = this.createProtocolBlobSetMessage(
        UserMessageSchema,
        userMessage
      )
      blobMessages.push(userBlob.buffer)

      const stepBlobIds = turn.steps.map((step) => {
        const stepBlob = this.createProtocolBlobSetMessage(
          ConversationStepSchema,
          step
        )
        blobMessages.push(stepBlob.buffer)
        return stepBlob.blobId
      })

      const agentTurn = create(AgentConversationTurnStructureSchema, {
        userMessage: this.encodeBlobId(userBlob.blobId),
        steps: stepBlobIds.map((blobId) => this.encodeBlobId(blobId)),
      })
      const turnStructure = create(ConversationTurnStructureSchema, {
        turn: {
          case: "agentConversationTurn" as const,
          value: agentTurn,
        },
      })
      const turnBlob = this.createProtocolBlobSetMessage(
        ConversationTurnStructureSchema,
        turnStructure
      )
      blobMessages.push(turnBlob.buffer)
      turns.push(turnBlob.blobId)
    }

    return { turns, blobMessages }
  }

  private buildMaterializedConversationTurnsForCheckpoint(
    session: ChatSession
  ): MaterializedConversationTurnForCheckpoint[] {
    const toolResults = this.buildTranscriptToolResultIndex(
      session.messageRecords
    )
    const turns: MaterializedConversationTurnForCheckpoint[] = []
    let currentTurn: MaterializedConversationTurnForCheckpoint | undefined

    const flushTurn = () => {
      if (!currentTurn) return
      if (currentTurn.userText.trim() || currentTurn.steps.length > 0) {
        turns.push(currentTurn)
      }
      currentTurn = undefined
    }

    for (const record of session.messageRecords) {
      if (record.role === "user") {
        if (this.isToolResultOnlyTranscriptContent(record.content)) {
          continue
        }
        flushTurn()
        currentTurn = {
          userText: extractText(record.content),
          userMessageId: record.id,
          steps: [],
        }
        continue
      }

      if (record.role !== "assistant") {
        continue
      }

      if (!currentTurn) {
        currentTurn = {
          userText: "",
          userMessageId: record.id,
          steps: [],
        }
      }
      currentTurn.steps.push(
        ...this.buildConversationStepsFromAssistantTranscriptRecord(
          record.content,
          toolResults,
          session
        )
      )
    }

    flushTurn()
    return turns
  }

  private buildTranscriptToolResultIndex(
    records: ChatSession["messageRecords"]
  ): Map<string, TranscriptToolResultForCheckpoint> {
    const results = new Map<string, TranscriptToolResultForCheckpoint>()
    for (const record of records) {
      if (record.role !== "user" || !Array.isArray(record.content)) {
        continue
      }
      for (const block of record.content) {
        if (!this.isLooseRecord(block) || block.type !== "tool_result") {
          continue
        }
        const toolUseId =
          typeof block.tool_use_id === "string" ? block.tool_use_id : ""
        if (!toolUseId) continue
        results.set(toolUseId, {
          content: this.stringifyToolResultContent(block.content),
          structuredContent: this.isLooseRecord(block.structuredContent)
            ? block.structuredContent
            : undefined,
          isError: block.is_error === true,
        })
      }
    }
    return results
  }

  private buildConversationStepsFromAssistantTranscriptRecord(
    content: LooseMessageContent,
    toolResults: Map<string, TranscriptToolResultForCheckpoint>,
    session?: ChatSession
  ): ConversationStep[] {
    if (typeof content === "string") {
      const text = content.trim()
      return text ? [this.grpcService.buildAssistantConversationStep(text)] : []
    }

    if (!Array.isArray(content)) {
      return []
    }

    const steps: ConversationStep[] = []
    for (const block of content) {
      if (!this.isLooseRecord(block)) continue
      if (block.type === "text" && typeof block.text === "string") {
        const text = block.text.trim()
        if (text) {
          steps.push(this.grpcService.buildAssistantConversationStep(text))
        }
        continue
      }
      if (block.type === "tool_use") {
        const toolCallId = typeof block.id === "string" ? block.id : ""
        const toolName = typeof block.name === "string" ? block.name : ""
        if (!toolCallId || !toolName) continue
        const input = this.isLooseRecord(block.input) ? block.input : {}
        const result = toolResults.get(toolCallId)
        const extraData = this.buildToolCompletionExtraDataForCheckpoint(
          toolName,
          result?.structuredContent
        )
        // Resolve the proto family hint with session-aware MCP lookup
        // so checkpoint replay projects MCP / web_fetch tool calls to
        // their dedicated proto cases instead of truncatedToolCall.
        const familyHint = this.classifyExecToolFamilyHint(toolName, session)
        steps.push(
          this.grpcService.buildToolCallConversationStep(
            toolName,
            toolCallId,
            input,
            result?.content || "",
            extraData,
            familyHint
          )
        )
      }
    }
    return steps
  }

  private buildToolCompletionExtraDataForCheckpoint(
    toolName: string,
    structuredContent: Record<string, unknown> | undefined
  ): ToolCompletedExtraData | undefined {
    if (
      toolName.trim().toLowerCase() === "task" &&
      this.isLooseRecord(structuredContent?.taskSuccess)
    ) {
      return {
        taskSuccess:
          structuredContent.taskSuccess as ToolCompletedExtraData["taskSuccess"],
      }
    }
    return undefined
  }

  private isLooseRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }

  private isToolResultOnlyTranscriptContent(
    content: LooseMessageContent
  ): boolean {
    return (
      Array.isArray(content) &&
      content.length > 0 &&
      content.every(
        (block) => this.isLooseRecord(block) && block.type === "tool_result"
      )
    )
  }

  private stringifyToolResultContent(content: unknown): string {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .map((entry) => {
          if (this.isLooseRecord(entry) && typeof entry.text === "string") {
            return entry.text
          }
          return JSON.stringify(this.toJsonSafe(entry))
        })
        .filter(Boolean)
        .join("\n")
    }
    if (content == null) return ""
    return JSON.stringify(this.toJsonSafe(content))
  }

  private toJsonSafe(value: unknown): unknown {
    if (typeof value === "bigint") {
      return value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value.toString()
    }
    if (value instanceof Uint8Array) {
      return Array.from(value)
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.toJsonSafe(item))
    }
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {}
      for (const [key, nested] of Object.entries(value)) {
        if (typeof nested === "undefined" || typeof nested === "function") {
          continue
        }
        result[key] = this.toJsonSafe(nested)
      }
      return result
    }
    return value
  }

  private recordCompletedTurnIfNeeded(
    session: ChatSession,
    shouldRecordTurn: boolean,
    contextLabel: string
  ): CompletedTurnCheckpointState {
    const activeSession =
      this.sessionManager.getSession(session.conversationId) || session

    if (!shouldRecordTurn) {
      this.logger.debug(
        `Skipping turn append for ${activeSession.conversationId} (${contextLabel}): no durable assistant response was persisted`
      )
      return { session: activeSession, blobMessages: [] }
    }

    const { turns, blobMessages } =
      this.materializeConversationTurnBlobs(activeSession)
    activeSession.turns = turns
    this.sessionManager.markSessionDirty(activeSession.conversationId)
    this.logger.debug(
      `Materialized ${turns.length} checkpoint turn blob(s) for ${activeSession.conversationId} (${contextLabel})`
    )
    return { session: activeSession, blobMessages }
  }

  private *finalizeInitialAssistantTurn(
    session: ChatSession,
    conversationId: string,
    text: string,
    usage?: ContextUsageSnapshot
  ): Generator<Buffer> {
    this.logger.log("Agent mode: sending turn_ended signal")

    let assistantRecordId: string | undefined
    if (text) {
      assistantRecordId = this.sessionManager.addMessage(
        session.conversationId,
        "assistant",
        text
      )
      this.logger.log(`Added text message to history (${text.length} chars)`)
    }
    if (assistantRecordId && usage) {
      this.commitAssistantUsageLedger(session, assistantRecordId, usage, text)
    }

    const completedTurn = this.recordCompletedTurnIfNeeded(
      session,
      !!assistantRecordId,
      `message_stop: ${conversationId}`
    )
    for (const blobMessage of completedTurn.blobMessages) {
      yield blobMessage
    }
    const completedSession = completedTurn.session

    const checkpoint = this.grpcService.createConversationCheckpointResponse(
      completedSession.conversationId,
      completedSession.model,
      {
        messageBlobIds: completedSession.messageBlobIds,
        usedTokens: completedSession.usedTokens || 0,
        maxTokens: this.resolveCheckpointMaxTokens(completedSession),
        workspaceUri: completedSession.projectContext?.rootPath
          ? `file://${completedSession.projectContext.rootPath}`
          : undefined,
        readPaths: Array.from(completedSession.readPaths),
        fileStates: Object.fromEntries(completedSession.fileStates),
        turns: completedSession.turns,
        todos: completedSession.todos,
        compactionHistory:
          this.extractCompactionHistoryForCheckpoint(completedSession),
      }
    )
    yield checkpoint
    this.logger.log("Sent conversationCheckpointUpdate")
    yield this.grpcService.createServerHeartbeatResponse()
    yield this.grpcService.createAgentTurnEndedResponse()
    this.logger.log("Turn ended, returning to handleBidiStream to close stream")
  }

  private async *processAssistantTurnStream(
    params: AssistantTurnStreamParams
  ): AsyncGenerator<Buffer, AssistantTurnStreamOutcome> {
    const {
      conversationId,
      session,
      stream,
      streamId,
      checkpointModel,
      workspaceRootPath,
      mode,
      emitInitialHeartbeat = false,
      emitTokenDeltas = true,
      streamAbortContext,
      messageStopAbortContext,
    } = params

    const modelCallBaseId = crypto.randomUUID()
    let toolCallIndex = 0
    let accumulatedText = ""
    let finalUsage: ContextUsageSnapshot | undefined
    let currentToolCall: ActiveToolCall | null = null
    const assistantBlocks: MessageContentItem[] = []
    const preparedTools: PreparedToolInvocation[] = []
    let editStreamState: {
      markerFound: boolean
      contentStartIdx: number
      lastSentRawLen: number
    } | null = null
    let isInThinkingBlock = false
    let thinkingStartTime = 0
    let currentThinkingBlock: ThinkingContentItem | null = null

    if (emitInitialHeartbeat) {
      yield this.grpcService.createHeartbeatResponse()
    }

    const heartbeatStream = this.streamWithHeartbeat(stream)
    const heartbeatIterator = heartbeatStream[Symbol.asyncIterator]()
    let assistantStreamClosed = false
    const closeAssistantStream = async (): Promise<void> => {
      if (
        assistantStreamClosed ||
        typeof heartbeatIterator.return !== "function"
      ) {
        assistantStreamClosed = true
        return
      }
      assistantStreamClosed = true
      try {
        await heartbeatIterator.return(undefined)
      } catch {
        // Ignore cleanup errors from upstream iterators during tool continuation.
      }
    }

    try {
      while (true) {
        const nextItem = await heartbeatIterator.next()
        if (nextItem.done) {
          break
        }
        const item = nextItem.value
        if (
          this.shouldAbortSupersededStream(
            conversationId,
            streamId,
            streamAbortContext
          )
        ) {
          return {
            kind: "aborted",
            accumulatedText,
            finalUsage,
            toolCallCount: preparedTools.length,
          }
        }

        if (item.type === "heartbeat") {
          yield this.grpcService.createHeartbeatResponse()
          continue
        }

        const event = this.parseSseEvent(item.value)
        if (!event) continue

        if (event.type === "message_start") {
          const backend = this.modelRouter.resolveModel(session.model).backend
          const messageId =
            event.data.message && typeof event.data.message.id === "string"
              ? event.data.message.id
              : undefined
          this.sessionManager.markAssistantBackend(
            conversationId,
            backend,
            backend === "codex" ? messageId : undefined
          )
          continue
        }

        if (event.type === "content_block_start") {
          const contentBlock = event.data.content_block
          if (
            contentBlock?.type === "tool_use" &&
            contentBlock.id &&
            contentBlock.name
          ) {
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
            isInThinkingBlock = true
            thinkingStartTime = Date.now()
            currentThinkingBlock = this.startAssistantThinkingBlock(
              assistantBlocks,
              contentBlock.signature
            )
            this.logger.debug("Thinking block started")
          }
          continue
        }

        if (event.type === "content_block_delta") {
          const delta = event.data.delta
          if (delta?.type === "text_delta" && delta.text) {
            yield this.grpcService.createAgentTextResponse(delta.text)
            accumulatedText += delta.text
            this.appendAssistantTextBlock(assistantBlocks, delta.text)

            if (emitTokenDeltas) {
              const { estimateTokenCount } =
                await import("./tools/agent-helpers")
              const outputTokens = estimateTokenCount(delta.text)
              if (outputTokens > 0) {
                yield this.grpcService.createTokenDeltaResponse(0, outputTokens)
              }
            }
          } else if (delta?.type === "input_json_delta" && currentToolCall) {
            currentToolCall.inputJson += delta.partial_json || ""

            if (editStreamState) {
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
          } else if (delta?.type === "thinking_delta") {
            this.appendAssistantThinkingDelta(
              currentThinkingBlock,
              delta.thinking || ""
            )
            if (
              typeof delta.thinking === "string" &&
              delta.thinking.length > 0
            ) {
              yield this.grpcService.createThinkingDeltaResponse(
                delta.thinking,
                session.model
              )
            }
          } else if (delta?.type === "signature_delta") {
            this.setAssistantThinkingSignature(
              currentThinkingBlock,
              delta.signature
            )
          }
          continue
        }

        if (event.type === "message_delta") {
          finalUsage = this.extractUsageSnapshot(event) || finalUsage
          continue
        }

        if (event.type === "content_block_stop") {
          if (isInThinkingBlock) {
            const thinkingDurationMs = Date.now() - thinkingStartTime
            yield this.grpcService.createThinkingCompletedResponse(
              thinkingDurationMs
            )
            isInThinkingBlock = false
            currentThinkingBlock = null
          }

          if (currentToolCall) {
            const preparedTool = this.buildPreparedToolInvocation(
              session,
              currentToolCall
            )
            this.appendPreparedToolUseBlock(assistantBlocks, preparedTool)
            preparedTools.push(preparedTool)
            this.logger.log(
              `Tool call completed: ${preparedTool.protocolToolName}, queued for batched dispatch`
            )
            currentToolCall = null
            editStreamState = null
          }
          continue
        }

        if (event.type === "message_stop") {
          if (
            this.shouldAbortSupersededStream(
              conversationId,
              streamId,
              messageStopAbortContext
            )
          ) {
            return {
              kind: "aborted",
              accumulatedText,
              finalUsage,
              toolCallCount: preparedTools.length,
            }
          }

          if (preparedTools.length > 0) {
            await closeAssistantStream()
            const dispatchOutcome = yield* this.dispatchPreparedToolBatch(
              conversationId,
              session,
              streamId,
              checkpointModel,
              workspaceRootPath,
              assistantBlocks,
              preparedTools
            )
            return {
              kind:
                dispatchOutcome === "waiting_for_result"
                  ? "waiting_for_results"
                  : "completed",
              accumulatedText,
              finalUsage,
              toolCallCount: preparedTools.length,
            }
          }

          if (mode === "initial") {
            yield* this.finalizeInitialAssistantTurn(
              session,
              conversationId,
              accumulatedText,
              finalUsage
            )
          } else {
            this.logger.log(
              "Agent mode: no more tool calls, sending turn_ended signal"
            )
            yield* this.finalizeAssistantContinuationTurn(
              session,
              conversationId,
              accumulatedText || undefined,
              finalUsage
            )
            this.logger.log("Sent conversationCheckpointUpdate (continuation)")
          }

          return {
            kind: "completed",
            accumulatedText,
            finalUsage,
            toolCallCount: 0,
          }
        }
      }

      if (preparedTools.length > 0) {
        this.logger.warn(
          `Assistant stream exited without message_stop after ${preparedTools.length} tool call(s); dispatching batched tools defensively`
        )
        const dispatchOutcome = yield* this.dispatchPreparedToolBatch(
          conversationId,
          session,
          streamId,
          checkpointModel,
          workspaceRootPath,
          assistantBlocks,
          preparedTools
        )
        return {
          kind:
            dispatchOutcome === "waiting_for_result"
              ? "waiting_for_results"
              : "completed",
          accumulatedText,
          finalUsage,
          toolCallCount: preparedTools.length,
        }
      }

      return {
        kind: accumulatedText ? "partial_without_message_stop" : "empty",
        accumulatedText,
        finalUsage,
        toolCallCount: 0,
      }
    } finally {
      await closeAssistantStream()
    }
  }

  private *finalizeAssistantContinuationTurn(
    session: ChatSession,
    conversationId: string,
    text?: string,
    usage?: ContextUsageSnapshot
  ): Generator<Buffer> {
    const activeSession =
      this.cleanSessionHistoryForTransientAssistantInfrastructureMessages(
        session,
        `finalizeAssistantContinuationTurn: ${conversationId}`
      )

    let assistantRecordId: string | undefined
    if (text && !this.isTransientAssistantInfrastructureText(text)) {
      assistantRecordId = this.sessionManager.addMessage(
        activeSession.conversationId,
        "assistant",
        text
      )
    } else if (text) {
      this.logger.warn(
        `Skipping persistence of transient assistant infrastructure text during continuation finalization for ${conversationId}`
      )
    }
    if (assistantRecordId && usage) {
      this.commitAssistantUsageLedger(
        activeSession,
        assistantRecordId,
        usage,
        text || ""
      )
    }

    const completedTurn = this.recordCompletedTurnIfNeeded(
      activeSession,
      !!assistantRecordId,
      `continuation finalization: ${conversationId}`
    )
    for (const blobMessage of completedTurn.blobMessages) {
      yield blobMessage
    }
    const completedSession = completedTurn.session

    yield this.buildConversationCheckpoint(
      completedSession,
      conversationId,
      completedSession.model
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

    const activeSession =
      this.cleanSessionHistoryForTransientAssistantInfrastructureMessages(
        session,
        `emitAgentFinalTextResponse: ${session.conversationId}`
      )
    const shouldPersist = !this.isTransientAssistantInfrastructureText(text)

    if (shouldPersist) {
      const lastMessage =
        activeSession.messages[activeSession.messages.length - 1]
      if (lastMessage?.role === "assistant") {
        this.sessionManager.replaceMessages(activeSession.conversationId, [
          ...activeSession.messages.slice(0, -1),
          {
            role: "assistant",
            content: this.mergeMessageContents(lastMessage.content, text),
          },
        ])
      } else {
        this.sessionManager.addMessage(
          activeSession.conversationId,
          "assistant",
          text
        )
      }
    } else {
      this.logger.warn(
        `Skipping persistence of transient assistant infrastructure text for ${activeSession.conversationId}`
      )
    }

    const completedTurn = this.recordCompletedTurnIfNeeded(
      activeSession,
      shouldPersist,
      `final text response: ${activeSession.conversationId}`
    )
    for (const blobMessage of completedTurn.blobMessages) {
      yield blobMessage
    }
    const completedSession = completedTurn.session

    const checkpoint = this.grpcService.createConversationCheckpointResponse(
      completedSession.conversationId,
      completedSession.model,
      {
        messageBlobIds: completedSession.messageBlobIds,
        usedTokens: completedSession.usedTokens || 0,
        maxTokens: this.resolveCheckpointMaxTokens(completedSession),
        workspaceUri: completedSession.projectContext?.rootPath
          ? `file://${completedSession.projectContext.rootPath}`
          : undefined,
        readPaths: Array.from(completedSession.readPaths),
        fileStates: Object.fromEntries(completedSession.fileStates),
        turns: completedSession.turns,
        todos: completedSession.todos,
        compactionHistory:
          this.extractCompactionHistoryForCheckpoint(completedSession),
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
      normalized.includes("replace") ||
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

    const targetFile =
      typeof toolInput.TargetFile === "string" ? toolInput.TargetFile : ""
    const pathCandidates = [
      toolInput.path,
      toolInput.SearchPath,
      toolInput.searchPath,
      toolInput.search_path,
      toolInput.AbsolutePath,
      toolInput.absolutePath,
      toolInput.absolute_path,
      toolInput.DirectoryPath,
      toolInput.directoryPath,
      toolInput.directory_path,
    ]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
    const target =
      pathCandidates[0] ||
      (targetFile.length > 0
        ? targetFile
        : typeof toolInput.command === "string" && toolInput.command.length > 0
          ? `command: ${toolInput.command.slice(0, 180)}`
          : "(unknown path)")
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
        `3. Do not switch to run_terminal_command with grep, rg, sed, cat, head, or tail unless the user explicitly asked for shell commands.`,
        `4. Iterate chunk-by-chunk and keep intermediate notes before final synthesis.`,
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

  private formatToolResultForHistory(
    toolName: string,
    toolInput: Record<string, unknown>,
    content: string,
    toolResultState?: { status: ToolResultStatus; message?: string },
    extraData?: ToolCompletedExtraData
  ): string {
    if (
      this.isMutatingFileTool(toolName) &&
      this.pickFirstString(toolInput, [
        "path",
        "file_path",
        "filePath",
        "TargetFile",
        "targetFile",
        "target_file",
      ])
    ) {
      return this.formatMutatingFileToolResultForHistory(
        toolName,
        toolInput,
        content,
        toolResultState,
        extraData?.editFailureContext
      )
    }

    const normalizedToolName = toolName.trim().toLowerCase()
    if (
      normalizedToolName === "run_command" ||
      normalizedToolName === "run_terminal_command" ||
      normalizedToolName === "run_terminal_command_v2" ||
      normalizedToolName === "exec_command" ||
      normalizedToolName === "shell"
    ) {
      return this.formatShellToolResultForHistory(
        toolName,
        toolInput,
        content,
        toolResultState,
        extraData?.shellResult
      )
    }

    if (
      normalizedToolName === "send_command_input" ||
      normalizedToolName === "write_shell_stdin" ||
      normalizedToolName === "write_stdin"
    ) {
      return this.formatWriteShellStdinResultForHistory(
        toolName,
        toolInput,
        content,
        toolResultState,
        extraData?.writeShellStdinSuccess
      )
    }

    if (normalizedToolName === "command_status") {
      return content
    }

    const family = this.normalizeDeferredToolFamily(toolName)
    if (family === "web_search") {
      const query =
        this.pickFirstString(toolInput, [
          "query",
          "search_term",
          "searchTerm",
        ]) || ""
      const references: Array<{ title: string; url: string }> = []
      const seenUrls = new Set<string>()
      const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g
      const plainUrlPattern = /https?:\/\/[^\s<>"')]+/g
      let match: RegExpExecArray | null

      while ((match = markdownLinkPattern.exec(content)) !== null) {
        const title = (match[1] || "").trim()
        const url = (match[2] || "").trim()
        if (!url || seenUrls.has(url)) continue
        seenUrls.add(url)
        references.push({ title: title || url, url })
        if (references.length >= 8) break
      }
      while (
        references.length < 8 &&
        (match = plainUrlPattern.exec(content)) !== null
      ) {
        const url = (match[0] || "").trim().replace(/[.,;:!?]+$/, "")
        if (!url || seenUrls.has(url)) continue
        seenUrls.add(url)
        references.push({ title: url, url })
      }

      if (toolResultState?.status === "rejected") {
        return `[web_search rejected] ${toolResultState.message || "request rejected"}`
      }
      if (toolResultState && toolResultState.status !== "success") {
        return `[web_search error] ${toolResultState.message || "request failed"}`
      }

      const lines = ["[web_search success]"]
      if (query) lines.push(`query: ${query}`)
      if (references && references.length > 0) {
        lines.push("sources:")
        for (const ref of references.slice(0, 8)) {
          const title = (ref.title || ref.url || "(untitled)").trim()
          const url = (ref.url || "").trim()
          lines.push(`- ${title}${url ? ` — ${url}` : ""}`)
        }
        if (references.length > 8) {
          lines.push(`- ... ${references.length - 8} more source(s)`)
        }
        return lines.join("\n")
      }

      const compact = content.replace(/\s+/g, " ").trim()
      if (compact) lines.push(compact.slice(0, 1200))
      return lines.join("\n\n")
    }

    if (family === "web_fetch") {
      const url =
        this.pickFirstString(toolInput, [
          "url",
          "Url",
          "document_id",
          "documentId",
        ]) || ""

      if (toolResultState?.status === "rejected") {
        return `[web_fetch rejected] ${toolResultState.message || "request rejected"}`
      }
      if (toolResultState && toolResultState.status !== "success") {
        return `[web_fetch error] ${toolResultState.message || "request failed"}`
      }

      const titleMatch = content.match(/(?:^|\n)Title:\s*(.+)\s*$/im)
      const compactBody = content
        .replace(/(?:^|\n)URL:\s*.+$/im, "")
        .replace(/(?:^|\n)Title:\s*.+$/im, "")
        .replace(/(?:^|\n)Content-Type:\s*.+$/im, "")
        .trim()
        .replace(/\s+/g, " ")
      const preview = compactBody.slice(0, 1600)

      const lines = ["[web_fetch success]"]
      if (url) lines.push(`url: ${url}`)
      if (titleMatch?.[1]?.trim()) lines.push(`title: ${titleMatch[1].trim()}`)
      if (preview) lines.push("", preview)
      return lines.join("\n")
    }

    return content
  }

  private formatShellToolResultForHistory(
    toolName: string,
    toolInput: Record<string, unknown>,
    content: string,
    toolResultState?: { status: ToolResultStatus; message?: string },
    shellResult?: ToolCompletedExtraData["shellResult"]
  ): string {
    const normalizedToolName =
      (toolName || "run_command").trim() || "run_command"
    const command =
      this.pickFirstString(toolInput, ["command", "CommandLine", "cmd"]) || ""
    const cwd =
      this.pickFirstString(toolInput, [
        "cwd",
        "Cwd",
        "working_directory",
        "workingDirectory",
      ]) || ""

    if (!shellResult) {
      if (toolResultState?.status === "rejected") {
        return toolResultState.message || content || "request rejected"
      }
      if (toolResultState && toolResultState.status !== "success") {
        return toolResultState.message || content || "request failed"
      }
    }

    return this.formatCodexUnifiedExecToolResultForHistory(content, {
      wallTimeMs:
        shellResult?.localExecutionTimeMs ?? shellResult?.executionTime ?? 0,
      sessionId: shellResult?.shellId,
      exitCode:
        shellResult?.isBackground === true ? undefined : shellResult?.exitCode,
      fallbackSessionId:
        toolResultState?.status === "success"
          ? undefined
          : shellResult?.shellId,
      fallbackText:
        toolResultState?.message ||
        (command || cwd
          ? `${normalizedToolName} failed${command ? ` while running ${command}` : ""}${cwd ? ` in ${cwd}` : ""}`
          : undefined),
    })
  }

  private formatWriteShellStdinResultForHistory(
    toolName: string,
    toolInput: Record<string, unknown>,
    content: string,
    toolResultState?: { status: ToolResultStatus; message?: string },
    writeShellStdinSuccess?: ToolCompletedExtraData["writeShellStdinSuccess"]
  ): string {
    const commandId =
      this.pickFirstString(toolInput, [
        "CommandId",
        "commandId",
        "command_id",
        "shellId",
        "shell_id",
      ]) || ""

    if (!writeShellStdinSuccess && toolResultState?.status === "rejected") {
      return toolResultState.message || content || "request rejected"
    }
    if (
      !writeShellStdinSuccess &&
      toolResultState &&
      toolResultState.status !== "success"
    ) {
      return toolResultState.message || content || "request failed"
    }

    const resolvedSessionId =
      (commandId ? Number.parseInt(commandId, 10) : undefined) ??
      writeShellStdinSuccess?.shellId

    return this.formatCodexUnifiedExecToolResultForHistory(content, {
      wallTimeMs: 0,
      sessionId:
        typeof resolvedSessionId === "number" &&
        Number.isFinite(resolvedSessionId)
          ? resolvedSessionId
          : undefined,
      fallbackText: toolResultState?.message,
    })
  }

  private formatCodexUnifiedExecToolResultForHistory(
    output: string,
    options: {
      wallTimeMs?: number
      sessionId?: number
      exitCode?: number
      originalTokenCount?: number
      fallbackSessionId?: number
      fallbackText?: string
    } = {}
  ): string {
    const wallTimeMs =
      typeof options.wallTimeMs === "number" &&
      Number.isFinite(options.wallTimeMs)
        ? Math.max(0, options.wallTimeMs)
        : 0
    const sections = [`Wall time: ${(wallTimeMs / 1000).toFixed(4)} seconds`]

    if (
      typeof options.exitCode === "number" &&
      Number.isFinite(options.exitCode)
    ) {
      sections.push(`Process exited with code ${options.exitCode}`)
    }

    const sessionId =
      typeof options.sessionId === "number" &&
      Number.isFinite(options.sessionId)
        ? options.sessionId
        : typeof options.fallbackSessionId === "number" &&
            Number.isFinite(options.fallbackSessionId)
          ? options.fallbackSessionId
          : undefined

    if (
      sessionId != null &&
      (options.exitCode == null || !Number.isFinite(options.exitCode))
    ) {
      sections.push(`Process running with session ID ${sessionId}`)
    }

    if (
      typeof options.originalTokenCount === "number" &&
      Number.isFinite(options.originalTokenCount)
    ) {
      sections.push(`Original token count: ${options.originalTokenCount}`)
    }

    sections.push("Output:")
    sections.push(output || options.fallbackText || "")
    return sections.join("\n")
  }

  private formatMutatingFileToolResultForHistory(
    toolName: string,
    toolInput: Record<string, unknown>,
    content: string,
    toolResultState?: { status: ToolResultStatus; message?: string },
    editFailureContext?: ToolCompletedExtraData["editFailureContext"]
  ): string {
    const path =
      this.pickFirstString(toolInput, [
        "path",
        "file_path",
        "filePath",
        "TargetFile",
        "targetFile",
        "target_file",
      ]) || ""
    const normalizedToolName = (toolName || "file_tool").trim() || "file_tool"
    const warningMarker = "\n\n[edit_apply_warning] "
    const warningIdx = content.indexOf(warningMarker)
    const payload =
      warningIdx >= 0 ? content.slice(0, warningIdx).trimEnd() : content
    const warning =
      warningIdx >= 0
        ? content.slice(warningIdx + warningMarker.length).trim()
        : ""

    if (toolResultState?.status === "rejected") {
      return `[${normalizedToolName} rejected] ${toolResultState.message || "request rejected"}${path ? ` (path: ${path})` : ""}`
    }
    if (toolResultState && toolResultState.status !== "success") {
      if (editFailureContext && content.trim()) {
        return content
      }
      return `[${normalizedToolName} error] ${toolResultState.message || "request failed"}${path ? ` (path: ${path})` : ""}`
    }

    const lines = [`[${normalizedToolName} success]`]
    if (path) lines.push(`path: ${path}`)
    lines.push(
      `result: full file snapshot omitted from model history to avoid context explosion`
    )
    if (payload) lines.push(`omitted_payload_size: ${payload.length} chars`)
    if (warning) lines.push(`warning: ${warning}`)
    lines.push(
      `follow_up: use read_file with focused line ranges or grep_search if more context is needed; avoid shell grep/sed/cat when structured tools can express the request`
    )
    return lines.join("\n")
  }

  private toDiffLines(content: string): string[] {
    if (!content) return []
    const lines = content.split(/\r?\n/)
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop()
    }
    return lines
  }

  private countEditLineDelta(
    beforeContent: string,
    afterContent: string
  ): { linesAdded: number; linesRemoved: number } {
    const beforeLines = this.toDiffLines(beforeContent)
    const afterLines = this.toDiffLines(afterContent)

    let prefix = 0
    while (
      prefix < beforeLines.length &&
      prefix < afterLines.length &&
      beforeLines[prefix] === afterLines[prefix]
    ) {
      prefix++
    }

    let beforeEnd = beforeLines.length - 1
    let afterEnd = afterLines.length - 1
    while (
      beforeEnd >= prefix &&
      afterEnd >= prefix &&
      beforeLines[beforeEnd] === afterLines[afterEnd]
    ) {
      beforeEnd--
      afterEnd--
    }

    const beforeRemaining = beforeLines.slice(prefix, beforeEnd + 1)
    const afterRemaining = afterLines.slice(prefix, afterEnd + 1)

    if (beforeRemaining.length === 0 || afterRemaining.length === 0) {
      return {
        linesAdded: afterRemaining.length,
        linesRemoved: beforeRemaining.length,
      }
    }

    const maxCells = 1_000_000
    if (beforeRemaining.length * afterRemaining.length > maxCells) {
      return {
        linesAdded: afterRemaining.length,
        linesRemoved: beforeRemaining.length,
      }
    }

    let previous: number[] = new Array<number>(afterRemaining.length + 1).fill(
      0
    )
    for (const beforeLine of beforeRemaining) {
      const current: number[] = new Array<number>(
        afterRemaining.length + 1
      ).fill(0)
      for (let index = 1; index <= afterRemaining.length; index++) {
        current[index] =
          beforeLine === afterRemaining[index - 1]
            ? (previous[index - 1] ?? 0) + 1
            : Math.max(previous[index] ?? 0, current[index - 1] ?? 0)
      }
      previous = current
    }

    const lcsLength: number = previous[afterRemaining.length] ?? 0
    return {
      linesAdded: afterRemaining.length - lcsLength,
      linesRemoved: beforeRemaining.length - lcsLength,
    }
  }

  private createEditUnifiedDiff(
    displayPath: string,
    beforeContent: string,
    afterContent: string
  ): string | undefined {
    if (beforeContent === afterContent) return undefined

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createTwoFilesPatch } = require("diff") as typeof import("diff")
      const patch = createTwoFilesPatch(
        `a/${displayPath}`,
        `b/${displayPath}`,
        beforeContent,
        afterContent,
        undefined,
        undefined,
        { context: 3 }
      )
      return patch.trim() || undefined
    } catch (err) {
      this.logger.warn(
        `Failed to create edit unified diff for ${displayPath}: ${(err as Error).message}`
      )
      return undefined
    }
  }

  private buildEditSuccessExtraData(
    displayPath: string,
    beforeContent: string,
    afterContent: string
  ): ToolCompletedExtraData["editSuccess"] {
    const { linesAdded, linesRemoved } = this.countEditLineDelta(
      beforeContent,
      afterContent
    )
    const diffString = this.createEditUnifiedDiff(
      displayPath,
      beforeContent,
      afterContent
    )

    return {
      linesAdded,
      linesRemoved,
      diffString,
    }
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

  private findSubstringOffsets(haystack: string, needle: string): number[] {
    if (!needle) return []
    const offsets: number[] = []
    let cursor = 0
    while (true) {
      const idx = haystack.indexOf(needle, cursor)
      if (idx < 0) return offsets
      offsets.push(idx)
      cursor = idx + needle.length
    }
  }

  /**
   * Fallback: CRLF normalization matching.
   * Models typically emit LF-only text even when the file uses CRLF (Windows).
   * Normalize both sides to LF for matching, then locate the corresponding
   * region in the original content and apply the replacement there.
   */
  private attemptCrlfNormalizedMatch(
    content: string,
    range: { startOffset: number; endOffset: number; lineStarts: number[] },
    options: {
      searchText: string
      replaceText: string
      allowMultiple?: boolean
      startLine?: number
      endLine?: number
      warningPrefix: string
    }
  ): {
    fileText: string
    resolvedMatch?: EditResolvedMatch
  } | null {
    const { searchText, replaceText } = options
    const allowMultiple = options.allowMultiple || false

    // Only attempt if there is a CRLF mismatch scenario
    const contentHasCrlf = content.includes("\r\n")
    const searchHasCrlf = searchText.includes("\r\n")
    if (!contentHasCrlf && !searchHasCrlf) return null
    // If both already use the same line endings, this fallback won't help
    if (contentHasCrlf === searchHasCrlf) return null

    const normalizedContent = content.replace(/\r\n/g, "\n")
    const normalizedSearch = searchText.replace(/\r\n/g, "\n")
    const normalizedReplace = replaceText.replace(/\r\n/g, "\n")

    const normalizedRange = {
      startOffset: content.slice(0, range.startOffset).replace(/\r\n/g, "\n")
        .length,
      endOffset: content.slice(0, range.endOffset).replace(/\r\n/g, "\n")
        .length,
    }

    const allNormalizedOffsets = this.findSubstringOffsets(
      normalizedContent,
      normalizedSearch
    )
    const matchesInRange = allNormalizedOffsets.filter((offset) => {
      const matchEnd = offset + normalizedSearch.length
      return (
        offset >= normalizedRange.startOffset &&
        matchEnd <= normalizedRange.endOffset
      )
    })

    const effectiveMatches =
      allNormalizedOffsets.length === 1 ? allNormalizedOffsets : matchesInRange

    if (effectiveMatches.length === 0) return null
    if (!allowMultiple && effectiveMatches.length > 1) return null

    // Map the normalized offset back to the original content offset.
    // Build a mapping: for each position in normalizedContent, track the
    // corresponding position in the original content.
    const firstMatch = effectiveMatches[0] as number
    const originalOffset = this.mapNormalizedOffsetToOriginal(
      content,
      firstMatch
    )
    const originalMatchEnd = this.mapNormalizedOffsetToOriginal(
      content,
      firstMatch + normalizedSearch.length
    )

    // Determine the correct replacement text: if the file uses CRLF, the
    // replacement should also use CRLF to maintain consistency.
    const finalReplace = contentHasCrlf
      ? normalizedReplace.replace(/\n/g, "\r\n")
      : normalizedReplace

    if (allowMultiple && effectiveMatches.length > 1) {
      // Apply all matches in reverse order to preserve offsets
      let result = content
      const sortedMatches = [...effectiveMatches].sort((a, b) => b - a)
      for (const normalizedMatchOffset of sortedMatches) {
        const origStart = this.mapNormalizedOffsetToOriginal(
          content,
          normalizedMatchOffset
        )
        const origEnd = this.mapNormalizedOffsetToOriginal(
          content,
          normalizedMatchOffset + normalizedSearch.length
        )
        result =
          result.slice(0, origStart) + finalReplace + result.slice(origEnd)
      }
      this.logger.debug(
        `${options.warningPrefix}: CRLF normalization retry succeeded ` +
          `(${effectiveMatches.length} matches, content=${contentHasCrlf ? "CRLF" : "LF"}, search=${searchHasCrlf ? "CRLF" : "LF"})`
      )
      return { fileText: result }
    }

    const matchedStartLine = this.resolveLineNumberFromOffset(
      range.lineStarts,
      originalOffset
    )
    const matchedEndLine = this.resolveLineNumberFromOffset(
      range.lineStarts,
      Math.max(originalOffset, originalMatchEnd - 1)
    )

    this.logger.debug(
      `${options.warningPrefix}: CRLF normalization retry succeeded ` +
        `(content=${contentHasCrlf ? "CRLF" : "LF"}, search=${searchHasCrlf ? "CRLF" : "LF"})`
    )

    return {
      fileText:
        content.slice(0, originalOffset) +
        finalReplace +
        content.slice(originalMatchEnd),
      resolvedMatch: {
        requestedStartLine: options.startLine,
        requestedEndLine: options.endLine,
        matchedStartLine,
        matchedEndLine,
      },
    }
  }

  /**
   * Map an offset in CRLF-normalized (LF-only) content back to the
   * corresponding offset in the original content.
   */
  private mapNormalizedOffsetToOriginal(
    originalContent: string,
    normalizedOffset: number
  ): number {
    let origPos = 0
    let normPos = 0
    while (normPos < normalizedOffset && origPos < originalContent.length) {
      if (
        originalContent[origPos] === "\r" &&
        origPos + 1 < originalContent.length &&
        originalContent[origPos + 1] === "\n"
      ) {
        // CRLF pair in original maps to single LF in normalized
        origPos += 2
        normPos += 1
      } else {
        origPos += 1
        normPos += 1
      }
    }
    return origPos
  }

  /**
   * Build an NFKC-normalized view of a string while retaining a map back to the
   * original UTF-16 offsets. The boundary bitmap prevents replacing half of a
   * compatibility-expanded character such as a ligature.
   */
  private buildCompatibilityNormalizedText(
    value: string
  ): CompatibilityNormalizedText {
    const normalizedParts: string[] = []
    const normalizedToOriginal: number[] = [0]
    const normalizedBoundary: boolean[] = [true]
    let originalOffset = 0
    let normalizedOffset = 0

    for (const char of value) {
      const originalStart = originalOffset
      const originalEnd = originalStart + char.length
      const normalizedChar = char.normalize("NFKC")
      normalizedParts.push(normalizedChar)

      for (let index = 0; index < normalizedChar.length; index++) {
        normalizedToOriginal[normalizedOffset + index] = originalStart
        normalizedBoundary[normalizedOffset + index] = index === 0
      }

      normalizedOffset += normalizedChar.length
      normalizedToOriginal[normalizedOffset] = originalEnd
      normalizedBoundary[normalizedOffset] = true
      originalOffset = originalEnd
    }

    return {
      normalized: normalizedParts.join(""),
      normalizedToOriginal,
      normalizedBoundary,
    }
  }

  private findCompatibilityNormalizedMatches(
    content: string,
    searchText: string,
    range: { startOffset: number; endOffset: number }
  ): CompatibilityNormalizedMatchSet {
    const normalizedContent = this.buildCompatibilityNormalizedText(content)
    const normalizedSearch = searchText.normalize("NFKC")
    if (normalizedSearch.length === 0) {
      return { allMatches: [], matchesInRange: [] }
    }

    const normalizedRange = {
      startOffset: content.slice(0, range.startOffset).normalize("NFKC").length,
      endOffset: content.slice(0, range.endOffset).normalize("NFKC").length,
    }
    const normalizedOffsets = this.findSubstringOffsets(
      normalizedContent.normalized,
      normalizedSearch
    )
    const allMatches = normalizedOffsets
      .map((normalizedOffset): CompatibilityNormalizedMatch | null => {
        const normalizedEnd = normalizedOffset + normalizedSearch.length
        if (
          !normalizedContent.normalizedBoundary[normalizedOffset] ||
          !normalizedContent.normalizedBoundary[normalizedEnd]
        ) {
          return null
        }

        const originalStart =
          normalizedContent.normalizedToOriginal[normalizedOffset]
        const originalEnd =
          normalizedContent.normalizedToOriginal[normalizedEnd]
        if (originalStart == null || originalEnd == null) return null

        const actualSlice = content.slice(originalStart, originalEnd)
        if (actualSlice.normalize("NFKC") !== normalizedSearch) return null

        return {
          normalizedOffset,
          originalStart,
          originalEnd,
        }
      })
      .filter((match): match is CompatibilityNormalizedMatch => match !== null)

    const matchesInRange = allMatches.filter((match) => {
      const normalizedEnd = match.normalizedOffset + normalizedSearch.length
      return (
        match.normalizedOffset >= normalizedRange.startOffset &&
        normalizedEnd <= normalizedRange.endOffset
      )
    })

    return {
      allMatches,
      matchesInRange,
    }
  }

  private commonPrefixLength(left: string, right: string): number {
    const limit = Math.min(left.length, right.length)
    let offset = 0
    while (offset < limit && left[offset] === right[offset]) {
      offset += 1
    }
    return offset
  }

  private commonSuffixLength(
    left: string,
    right: string,
    prefixLength: number
  ): number {
    const limit = Math.min(left.length, right.length) - prefixLength
    let offset = 0
    while (
      offset < limit &&
      left[left.length - 1 - offset] === right[right.length - 1 - offset]
    ) {
      offset += 1
    }
    return offset
  }

  /**
   * When a match was found through NFKC compatibility normalization, preserve
   * unchanged fullwidth/curly/compatibility characters from the actual file
   * around the edited region. This mirrors claude-code's "find actual string"
   * approach: use tolerant matching to locate the real span, but avoid changing
   * typography that the replacement did not semantically edit.
   */
  private preserveCompatibilityStyleForReplacement(
    actualSearchText: string,
    requestedSearchText: string,
    requestedReplaceText: string
  ): string {
    const normalizedActual = actualSearchText.normalize("NFKC")
    const normalizedSearch = requestedSearchText.normalize("NFKC")
    const normalizedReplace = requestedReplaceText.normalize("NFKC")
    if (normalizedActual !== normalizedSearch) return requestedReplaceText
    if (normalizedSearch === normalizedReplace) return requestedReplaceText

    const prefixLength = this.commonPrefixLength(
      normalizedSearch,
      normalizedReplace
    )
    const suffixLength = this.commonSuffixLength(
      normalizedSearch,
      normalizedReplace,
      prefixLength
    )
    if (prefixLength === 0 && suffixLength === 0) return requestedReplaceText

    const actualMap = this.buildCompatibilityNormalizedText(actualSearchText)
    const replaceMap =
      this.buildCompatibilityNormalizedText(requestedReplaceText)
    const searchSuffixStart = normalizedSearch.length - suffixLength
    const replaceSuffixStart = normalizedReplace.length - suffixLength

    if (
      !actualMap.normalizedBoundary[prefixLength] ||
      !actualMap.normalizedBoundary[searchSuffixStart] ||
      !replaceMap.normalizedBoundary[prefixLength] ||
      !replaceMap.normalizedBoundary[replaceSuffixStart]
    ) {
      return requestedReplaceText
    }

    const actualPrefixEnd = actualMap.normalizedToOriginal[prefixLength]
    const actualSuffixStart = actualMap.normalizedToOriginal[searchSuffixStart]
    const replaceMiddleStart = replaceMap.normalizedToOriginal[prefixLength]
    const replaceMiddleEnd = replaceMap.normalizedToOriginal[replaceSuffixStart]
    if (
      actualPrefixEnd == null ||
      actualSuffixStart == null ||
      replaceMiddleStart == null ||
      replaceMiddleEnd == null
    ) {
      return requestedReplaceText
    }

    return (
      actualSearchText.slice(0, actualPrefixEnd) +
      requestedReplaceText.slice(replaceMiddleStart, replaceMiddleEnd) +
      actualSearchText.slice(actualSuffixStart)
    )
  }

  /**
   * Fallback: Unicode compatibility matching.
   * Models may copy current text through a UI/font/input path that normalizes
   * fullwidth punctuation such as `：`/`；` into ASCII `:`/`;`. Match with NFKC
   * only when the normalized target is unambiguous, then apply to the original
   * byte span.
   */
  private attemptCompatibilityNormalizedMatch(
    content: string,
    range: { startOffset: number; endOffset: number; lineStarts: number[] },
    options: {
      searchText: string
      replaceText: string
      allowMultiple?: boolean
      startLine?: number
      endLine?: number
      warningPrefix: string
    }
  ): {
    fileText: string
    resolvedMatch?: EditResolvedMatch
  } | null {
    const { searchText, replaceText } = options
    const allowMultiple = options.allowMultiple || false
    const normalizedSearch = searchText.normalize("NFKC")
    const searchChangedByNormalization = normalizedSearch !== searchText
    // Eligibility check: NFKC normalization only matters if the
    // requested range OR the search text actually contains
    // compatibility characters. Earlier code ran
    // `content.normalize("NFKC")` on the entire file on every edit;
    // for a 1MB file with no fullwidth characters that is ~3-5ms of
    // pure waste per failed match. Slice the range first — even a
    // 200KB file rarely has more than a few hundred chars of edit
    // window — and only fall through to the full-file work when the
    // range or search has at least one normalize-changing codepoint.
    const rangeSlice = content.slice(range.startOffset, range.endOffset)
    const rangeChangedByNormalization =
      rangeSlice.normalize("NFKC") !== rangeSlice
    if (!rangeChangedByNormalization && !searchChangedByNormalization) {
      return null
    }

    const matchSet = this.findCompatibilityNormalizedMatches(
      content,
      searchText,
      range
    )
    const effectiveMatches =
      matchSet.allMatches.length === 1
        ? matchSet.allMatches
        : matchSet.matchesInRange

    if (effectiveMatches.length === 0) return null
    if (!allowMultiple && effectiveMatches.length > 1) return null

    const replacementForMatch = (match: CompatibilityNormalizedMatch): string =>
      this.preserveCompatibilityStyleForReplacement(
        content.slice(match.originalStart, match.originalEnd),
        searchText,
        replaceText
      )

    if (allowMultiple && effectiveMatches.length > 1) {
      let result = content
      const sortedMatches = [...effectiveMatches].sort(
        (left, right) => right.originalStart - left.originalStart
      )
      for (const match of sortedMatches) {
        result =
          result.slice(0, match.originalStart) +
          replacementForMatch(match) +
          result.slice(match.originalEnd)
      }
      this.logger.debug(
        `${options.warningPrefix}: Unicode compatibility normalization retry succeeded ` +
          `(${effectiveMatches.length} matches)`
      )
      return { fileText: result }
    }

    const firstMatch = effectiveMatches[0] as CompatibilityNormalizedMatch
    const matchedStartLine = this.resolveLineNumberFromOffset(
      range.lineStarts,
      firstMatch.originalStart
    )
    const matchedEndLine = this.resolveLineNumberFromOffset(
      range.lineStarts,
      Math.max(firstMatch.originalStart, firstMatch.originalEnd - 1)
    )

    this.logger.debug(
      `${options.warningPrefix}: Unicode compatibility normalization retry succeeded ` +
        `(lines ${matchedStartLine}-${matchedEndLine})`
    )

    return {
      fileText:
        content.slice(0, firstMatch.originalStart) +
        replacementForMatch(firstMatch) +
        content.slice(firstMatch.originalEnd),
      resolvedMatch: {
        requestedStartLine: options.startLine,
        requestedEndLine: options.endLine,
        matchedStartLine,
        matchedEndLine,
      },
    }
  }

  private buildCompatibilityNormalizedFailureHint(
    content: string,
    searchText: string,
    range: { startOffset: number; endOffset: number }
  ): string {
    const rangeSlice = content.slice(range.startOffset, range.endOffset)
    const rangeChangedByNormalization =
      rangeSlice.normalize("NFKC") !== rangeSlice
    const searchChangedByNormalization =
      searchText.normalize("NFKC") !== searchText
    if (!rangeChangedByNormalization && !searchChangedByNormalization) {
      return ""
    }

    const matchSet = this.findCompatibilityNormalizedMatches(
      content,
      searchText,
      range
    )
    if (matchSet.allMatches.length === 0) return ""

    const inRangeCount = matchSet.matchesInRange.length
    if (matchSet.allMatches.length === 1) {
      return " A Unicode compatibility-normalized match exists in the file, but it could not be applied safely; re-copy the exact current text, especially fullwidth/halfwidth punctuation."
    }
    if (inRangeCount > 0) {
      return ` Unicode compatibility-normalized TargetContent matches ${inRangeCount} time(s) in the requested range and ${matchSet.allMatches.length} time(s) in the file; narrow StartLine/EndLine or copy a more unique exact snippet.`
    }
    return ` Unicode compatibility-normalized TargetContent exists ${matchSet.allMatches.length} time(s) elsewhere in the file; re-read the target lines and copy exact punctuation.`
  }

  /**
   * Fallback: trailing whitespace tolerance matching.
   * Models sometimes omit or add trailing spaces/tabs that differ from the
   * actual file content.  Normalize trailing whitespace per line for matching,
   * then locate the corresponding region in the original content.
   */
  private attemptTrailingWhitespaceNormalizedMatch(
    content: string,
    range: { startOffset: number; endOffset: number; lineStarts: number[] },
    options: {
      searchText: string
      replaceText: string
      allowMultiple?: boolean
      startLine?: number
      endLine?: number
      warningPrefix: string
    }
  ): {
    fileText: string
    resolvedMatch?: EditResolvedMatch
  } | null {
    const { searchText, replaceText } = options
    const allowMultiple = options.allowMultiple || false

    // Only attempt if the search text contains newlines (multi-line edit)
    // and there's a plausible trailing whitespace difference
    if (!searchText.includes("\n")) return null

    const stripTrailing = (text: string): string =>
      text
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/, ""))
        .join("\n")

    const strippedSearch = stripTrailing(searchText)
    // If stripping didn't change anything, this fallback won't help
    if (strippedSearch === searchText) {
      // Also check if the content has trailing whitespace that the search lacks
      const targetSlice = content.slice(range.startOffset, range.endOffset)
      const strippedTarget = stripTrailing(targetSlice)
      if (strippedTarget === targetSlice) return null
    }

    // Try matching the stripped search against the stripped content
    const strippedContent = stripTrailing(content)
    const strippedAllOffsets = this.findSubstringOffsets(
      strippedContent,
      strippedSearch
    )
    if (strippedAllOffsets.length === 0) return null
    if (!allowMultiple && strippedAllOffsets.length > 1) return null

    // Map the stripped offset back to the original content.
    // Since we only strip trailing whitespace (not add chars), each line in
    // stripped content is <= the original line.  We map by line number.
    const strippedLines = strippedContent.split("\n")
    const originalLines = content.split("\n")

    // Find which line the match starts on in stripped content
    const matchOffset = strippedAllOffsets[0] as number
    let charCount = 0
    let matchStartLine = 0
    for (let i = 0; i < strippedLines.length; i++) {
      const lineLen = strippedLines[i]?.length ?? 0
      if (charCount + lineLen >= matchOffset) {
        matchStartLine = i
        break
      }
      charCount += lineLen + 1 // +1 for \n
    }

    // Find the match end line
    const matchEndInStripped = matchOffset + strippedSearch.length
    charCount = 0
    let matchEndLine = 0
    for (let i = 0; i < strippedLines.length; i++) {
      const lineLen = strippedLines[i]?.length ?? 0
      const lineEnd = charCount + lineLen
      if (lineEnd >= matchEndInStripped) {
        matchEndLine = i
        break
      }
      charCount += lineLen + 1
    }

    // Reconstruct the original offset range from line numbers
    const origStartOffset = this.computeOriginalOffsetFromLine(
      originalLines,
      matchStartLine,
      matchOffset - this.computeLineStartOffset(strippedLines, matchStartLine)
    )
    const origEndOffset = this.computeOriginalOffsetFromLine(
      originalLines,
      matchEndLine,
      matchEndInStripped -
        this.computeLineStartOffset(strippedLines, matchEndLine)
    )

    // Verify the replacement makes sense: the original slice should have
    // the same content as searchText when both are trailing-ws-stripped
    const originalSlice = content.slice(origStartOffset, origEndOffset)
    if (stripTrailing(originalSlice) !== strippedSearch) return null

    // Apply the replacement.  Preserve the file's trailing whitespace style
    // by using the replaceText as-is (the model's intended output).
    const matchedStart = this.resolveLineNumberFromOffset(
      range.lineStarts,
      origStartOffset
    )
    const matchedEnd = this.resolveLineNumberFromOffset(
      range.lineStarts,
      Math.max(origStartOffset, origEndOffset - 1)
    )

    this.logger.debug(
      `${options.warningPrefix}: trailing whitespace normalization retry succeeded ` +
        `(lines ${matchedStart}-${matchedEnd})`
    )

    return {
      fileText:
        content.slice(0, origStartOffset) +
        replaceText +
        content.slice(origEndOffset),
      resolvedMatch: {
        requestedStartLine: options.startLine,
        requestedEndLine: options.endLine,
        matchedStartLine: matchedStart,
        matchedEndLine: matchedEnd,
      },
    }
  }

  /**
   * Compute the character offset of the start of a given line index
   * within a lines array (joined by \n).
   */
  private computeLineStartOffset(lines: string[], lineIndex: number): number {
    let offset = 0
    for (let i = 0; i < lineIndex && i < lines.length; i++) {
      offset += (lines[i]?.length ?? 0) + 1 // +1 for \n
    }
    return offset
  }

  /**
   * Compute the original content offset given a line index and a column
   * offset within that line.
   */
  private computeOriginalOffsetFromLine(
    originalLines: string[],
    lineIndex: number,
    columnOffset: number
  ): number {
    let offset = 0
    for (let i = 0; i < lineIndex && i < originalLines.length; i++) {
      offset += (originalLines[i]?.length ?? 0) + 1 // +1 for \n
    }
    return (
      offset + Math.min(columnOffset, originalLines[lineIndex]?.length ?? 0)
    )
  }

  private pickFirstRawString(
    source: Record<string, unknown>,
    keys: string[],
    options?: { allowEmpty?: boolean }
  ): string | undefined {
    const allowEmpty = options?.allowEmpty ?? false
    for (const key of keys) {
      const raw = source[key]
      if (typeof raw !== "string") continue
      if (allowEmpty || raw.length > 0) {
        return raw
      }
    }
    return undefined
  }

  private computeContentLineStarts(content: string): number[] {
    const lineStarts = [0]
    for (let index = 0; index < content.length; index++) {
      if (content[index] === "\n") {
        lineStarts.push(index + 1)
      }
    }
    return lineStarts
  }

  private resolveLineNumberFromOffset(
    lineStarts: number[],
    offset: number
  ): number {
    if (lineStarts.length === 0) return 1

    let low = 0
    let high = lineStarts.length - 1
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const lineStart = lineStarts[mid] ?? 0
      const nextLineStart =
        mid + 1 < lineStarts.length
          ? (lineStarts[mid + 1] ?? Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER
      if (offset < lineStart) {
        high = mid - 1
        continue
      }
      if (offset >= nextLineStart) {
        low = mid + 1
        continue
      }
      return mid + 1
    }

    return Math.max(1, Math.min(lineStarts.length, low + 1))
  }

  private resolveContentLineRange(
    content: string,
    startLine?: number,
    endLine?: number
  ): {
    startOffset: number
    endOffset: number
    lineStarts: number[]
    warning?: string
  } {
    const lineStarts = this.computeContentLineStarts(content)

    const totalLines = Math.max(1, lineStarts.length)
    const resolvedStartLine = startLine ?? 1
    const resolvedEndLine = endLine ?? totalLines

    if (
      !Number.isFinite(resolvedStartLine) ||
      !Number.isFinite(resolvedEndLine) ||
      resolvedStartLine < 1 ||
      resolvedEndLine < resolvedStartLine ||
      resolvedEndLine > totalLines
    ) {
      return {
        startOffset: 0,
        endOffset: content.length,
        lineStarts,
        warning: `edit_file line range ${resolvedStartLine}-${resolvedEndLine} is invalid for ${totalLines} line(s)`,
      }
    }

    const startOffset = lineStarts[resolvedStartLine - 1] ?? 0
    const endOffset =
      resolvedEndLine < totalLines
        ? (lineStarts[resolvedEndLine] ?? content.length)
        : content.length

    return {
      startOffset,
      endOffset,
      lineStarts,
    }
  }

  private applySearchReplaceWithinRange(
    content: string,
    options: {
      searchText: string
      replaceText: string
      allowMultiple?: boolean
      startLine?: number
      endLine?: number
      warningPrefix: string
    }
  ): {
    fileText: string
    warning?: string
    failureContext?: EditFailureContext
    resolvedMatch?: EditResolvedMatch
    /**
     * Set when the edit was intentionally skipped because it would be a
     * no-op (e.g. searchText === replaceText). NOT a failure: callers
     * should report success and surface a short explanatory note rather
     * than `[edit_apply_failed]`. Letting the caller distinguish
     * between "edit failed" and "edit was idempotent" prevents the
     * model from looping on a perfectly-fine tool call.
     */
    noopReason?: "identical_search_replace"
  } {
    const searchText = options.searchText
    const replaceText = options.replaceText
    const allowMultiple = options.allowMultiple || false

    // Guard 1: identical search/replace is a no-op edit. Models occasionally
    // emit this when retrying after a partial response, when the bridge's
    // upstream proxy duplicates a tool_use input, or — most commonly —
    // when the model wants to *assert* a piece of state already exists
    // (search=`alpha`, replace=`alpha`) without changing it. Older bridge
    // builds reported this as `[edit_apply_failed]`, which the model
    // misread as a real failure and looped on. New behaviour: short-
    // circuit with `noopReason` so the caller emits a success result with
    // a brief "no-op" note, never touching disk.
    if (searchText === replaceText && searchText.length > 0) {
      return {
        fileText: content,
        noopReason: "identical_search_replace",
      }
    }

    // Guard 2: replacement embeds the entire search text and is much larger.
    // This is the classic "model pasted both old and new content" failure
    // mode (observed when the model intends to APPEND but expresses it as a
    // search/replace). Without rejection the bridge would write the
    // append-shaped block, leaving the original snippet still present in
    // the file — so the next identical edit_file_v2 call would match again
    // and append the same block a second time, causing duplication.
    //
    // Heuristic: searchText is at least 80 chars (avoid false positives on
    // tiny renames), replaceText starts with the searchText verbatim, and
    // replaceText is at least 4× larger than searchText, and the user did
    // not pass allow_multiple. The 4× ratio comfortably allows legitimate
    // "wrap with surrounding context" edits while catching the
    // duplicate-paste pattern.
    if (
      !allowMultiple &&
      searchText.length >= 80 &&
      replaceText.length >= searchText.length * 4 &&
      replaceText.startsWith(searchText)
    ) {
      return {
        fileText: content,
        warning:
          `${options.warningPrefix} appears to embed the entire search ` +
          `snippet at the start of the replacement (search_len=${searchText.length}, ` +
          `replace_len=${replaceText.length}); refusing to apply as it ` +
          `usually indicates the model intended to append additional ` +
          `content. Either trim the duplicated prefix from replace, or ` +
          `split this into a smaller search snippet plus an explicit ` +
          `append edit.`,
        failureContext: {
          filePath: "",
          reason: "self_swallowing_replace",
          startLine: options.startLine,
          endLine: options.endLine,
          allowMultiple,
          searchText,
          replaceTextLength: replaceText.length,
        },
      }
    }

    if (searchText.length === 0) {
      return {
        fileText: content,
        warning: `${options.warningPrefix} has empty target content`,
        failureContext: {
          filePath: "",
          reason: "empty_target",
          startLine: options.startLine,
          endLine: options.endLine,
          allowMultiple,
          searchText,
          replaceTextLength: replaceText.length,
        },
      }
    }

    const range = this.resolveContentLineRange(
      content,
      options.startLine,
      options.endLine
    )
    if (range.warning) {
      return {
        fileText: content,
        warning: range.warning,
        failureContext: {
          filePath: "",
          reason: "range_invalid",
          startLine: options.startLine,
          endLine: options.endLine,
          allowMultiple,
          searchText,
          replaceTextLength: replaceText.length,
        },
      }
    }

    const targetSlice = content.slice(range.startOffset, range.endOffset)
    const allMatchOffsets = this.findSubstringOffsets(content, searchText)
    const matchesWithinRange = allMatchOffsets.filter((offset) => {
      const matchEnd = offset + searchText.length
      return offset >= range.startOffset && matchEnd <= range.endOffset
    })
    const occurrenceCount = matchesWithinRange.length
    const singleGlobalMatchOffset =
      allMatchOffsets.length === 1 ? allMatchOffsets[0] : undefined
    if (singleGlobalMatchOffset != null) {
      const globalEndOffset = singleGlobalMatchOffset + searchText.length
      const matchedStartLine = this.resolveLineNumberFromOffset(
        range.lineStarts,
        singleGlobalMatchOffset
      )
      const matchedEndLine = this.resolveLineNumberFromOffset(
        range.lineStarts,
        Math.max(singleGlobalMatchOffset, globalEndOffset - 1)
      )
      return {
        fileText:
          content.slice(0, singleGlobalMatchOffset) +
          replaceText +
          content.slice(globalEndOffset),
        resolvedMatch: {
          requestedStartLine: options.startLine,
          requestedEndLine: options.endLine,
          matchedStartLine,
          matchedEndLine,
        },
      }
    }
    if (occurrenceCount === 1 && allMatchOffsets.length > 1) {
      const rangeMatchOffset = matchesWithinRange[0]
      if (rangeMatchOffset != null) {
        const rangeMatchEnd = rangeMatchOffset + searchText.length
        const matchedStartLine = this.resolveLineNumberFromOffset(
          range.lineStarts,
          rangeMatchOffset
        )
        const matchedEndLine = this.resolveLineNumberFromOffset(
          range.lineStarts,
          Math.max(rangeMatchOffset, rangeMatchEnd - 1)
        )
        return {
          fileText:
            content.slice(0, rangeMatchOffset) +
            replaceText +
            content.slice(rangeMatchEnd),
          resolvedMatch: {
            requestedStartLine: options.startLine,
            requestedEndLine: options.endLine,
            matchedStartLine,
            matchedEndLine,
          },
        }
      }
    }
    const replacementOffsetsInRange = this.findSubstringOffsets(
      targetSlice,
      replaceText
    )
    if (occurrenceCount === 0) {
      // Workaround: Cloud Code API / model sometimes returns over-escaped
      // backslashes in functionCall.args (e.g. `\\` instead of `\` for
      // template literal content).  Before failing, try collapsing one
      // layer of backslash escaping and re-match.
      if (searchText.includes("\\\\")) {
        const unescapedSearch = searchText.replace(/\\\\/g, "\\")
        const unescapedReplace = replaceText.replace(/\\\\/g, "\\")
        const retryResult = this.applySearchReplaceWithinRange(content, {
          ...options,
          searchText: unescapedSearch,
          replaceText: unescapedReplace,
        })
        if (!retryResult.warning) {
          this.logger.debug(
            `${options.warningPrefix}: over-escape retry succeeded ` +
              `(collapsed ${searchText.length - unescapedSearch.length} excess backslash chars)`
          )
          return retryResult
        }
      }

      // Fallback: CRLF normalization — models typically emit LF-only search
      // text even when the file uses CRLF (common on Windows).  Normalize
      // both sides to LF for matching, then apply the edit on the original
      // content using the mapped offset.
      const crlfFallbackResult = this.attemptCrlfNormalizedMatch(
        content,
        range,
        options
      )
      if (crlfFallbackResult) {
        return crlfFallbackResult
      }

      // Fallback: Unicode compatibility normalization — models sometimes copy
      // fullwidth punctuation through a path that turns it into ASCII
      // punctuation. Only accept an unambiguous normalized match.
      const compatibilityFallbackResult =
        this.attemptCompatibilityNormalizedMatch(content, range, options)
      if (compatibilityFallbackResult) {
        return compatibilityFallbackResult
      }

      // Fallback: trailing whitespace tolerance — models sometimes omit or
      // add trailing spaces/tabs that differ from the actual file content.
      // Normalize trailing whitespace per line for matching, then apply the
      // edit on the original content.
      const trailingWsFallbackResult =
        this.attemptTrailingWhitespaceNormalizedMatch(content, range, options)
      if (trailingWsFallbackResult) {
        return trailingWsFallbackResult
      }

      // Following claude-code's design: searchText not found is always a
      // failure — never silently assume the edit was "already applied".
      // If replaceText happens to exist in the range, add a diagnostic
      // hint but still fail so the model re-reads and decides explicitly.
      const replacementOccurrenceCount =
        replaceText.length > 0 ? replacementOffsetsInRange.length : 0
      const possiblyAppliedHint =
        replacementOccurrenceCount > 0
          ? " ReplacementContent already exists in the target range — this edit may have been previously applied. If so, the file is already in the desired state; do not retry."
          : ""
      const retryGuidance =
        searchText.length >= 400
          ? " Re-run view_file, copy the current file text verbatim, and prefer a shorter unique TargetContent excerpt instead of a large block."
          : " Re-run view_file and copy the current file text verbatim before retrying."
      const rangeLabel =
        options.startLine != null || options.endLine != null
          ? ` ${options.startLine ?? "?"}-${options.endLine ?? "?"}`
          : ""
      const outOfRangeDiagnosis =
        allMatchOffsets.length > 0
          ? ` TargetContent exists ${allMatchOffsets.length} time(s) elsewhere in the current file, so the requested line window is inaccurate or not selective enough.`
          : ""
      const compatibilityDiagnosis =
        this.buildCompatibilityNormalizedFailureHint(content, searchText, range)
      return {
        fileText: content,
        warning:
          `${options.warningPrefix} target content not found in specified line range${rangeLabel}; ` +
          `ensure StartLine/EndLine fully cover the entire TargetContent and re-read a slightly wider window.` +
          outOfRangeDiagnosis +
          compatibilityDiagnosis +
          possiblyAppliedHint +
          retryGuidance,
        failureContext: {
          filePath: "",
          reason: "target_not_found",
          startLine: options.startLine,
          endLine: options.endLine,
          allowMultiple,
          searchText,
          replaceTextLength: replaceText.length,
        },
      }
    }
    if (!allowMultiple && occurrenceCount > 1) {
      const rangeLabel =
        options.startLine != null || options.endLine != null
          ? ` ${options.startLine ?? "?"}-${options.endLine ?? "?"}`
          : ""
      return {
        fileText: content,
        warning:
          `${options.warningPrefix} matched ${occurrenceCount} times in specified line range${rangeLabel}; ` +
          `narrow StartLine/EndLine so the TargetContent is unique`,
        failureContext: {
          filePath: "",
          reason: "ambiguous_target",
          startLine: options.startLine,
          endLine: options.endLine,
          allowMultiple,
          searchText,
          replaceTextLength: replaceText.length,
        },
      }
    }

    const replacedSlice = targetSlice.split(searchText).join(replaceText)

    return {
      fileText:
        content.slice(0, range.startOffset) +
        replacedSlice +
        content.slice(range.endOffset),
    }
  }

  private compactEditLogPreview(value: string, maxChars = 120): string {
    const compact = value.replace(/\s+/g, " ").trim()
    if (compact.length <= maxChars) return compact
    return `${compact.slice(0, Math.max(maxChars - 3, 0))}...`
  }

  private isOfficialEditHistoryToolName(toolName?: string): boolean {
    const normalized = (toolName || "").trim().toLowerCase()
    return (
      normalized === "replace_file_content" ||
      normalized === "multi_replace_file_content" ||
      normalized === "write_to_file"
    )
  }

  private summarizeEditInvocationForLogs(
    toolInput: ToolInputWithPath,
    options?: {
      historyToolName?: string
      protocolToolName?: string
      failureContext?: EditFailureContext
    }
  ): string {
    const parts: string[] = []
    const historyToolName = options?.historyToolName?.trim()
    const protocolToolName = options?.protocolToolName?.trim()
    const failureContext = options?.failureContext

    if (historyToolName) {
      parts.push(`history_tool=${historyToolName}`)
      parts.push(
        `tool_origin=${this.isOfficialEditHistoryToolName(historyToolName) ? "official_antigravity" : "internal_edit"}`
      )
    } else if (protocolToolName) {
      parts.push(
        `tool_origin=${this.isEditToolInvocation(protocolToolName) ? "internal_edit" : "unknown"}`
      )
    }

    if (protocolToolName) {
      parts.push(`protocol_tool=${protocolToolName}`)
    }

    if (failureContext) {
      parts.push(`failure_reason=${failureContext.reason}`)
      if (typeof failureContext.chunkIndex === "number") {
        parts.push(`chunk_index=${failureContext.chunkIndex + 1}`)
      }
      if (typeof failureContext.matchCountInFile === "number") {
        parts.push(`target_matches_in_file=${failureContext.matchCountInFile}`)
      }
    }

    const inputSummary = this.summarizeEditToolInputForLogs(toolInput)
    if (inputSummary) {
      parts.push(inputSummary)
    }

    return parts.join(" | ")
  }

  private summarizeEditToolInputForLogs(toolInput: ToolInputWithPath): string {
    const input = toolInput as Record<string, unknown>
    const parts: string[] = []
    const filePath = typeof toolInput.path === "string" ? toolInput.path : ""
    if (filePath) parts.push(`path=${filePath}`)

    const overwrite = this.pickFirstBoolean(input, ["overwrite", "Overwrite"])
    if (typeof overwrite === "boolean") {
      parts.push(`overwrite=${overwrite}`)
    }

    if (typeof toolInput.file_text === "string") {
      parts.push(`file_text_len=${toolInput.file_text.length}`)
      return parts.join(" | ")
    }

    const rawReplacementChunks = Array.isArray(input.replacementChunks)
      ? input.replacementChunks
      : []
    if (rawReplacementChunks.length > 0) {
      parts.push(`replacement_chunks=${rawReplacementChunks.length}`)
      const chunkPreview = rawReplacementChunks
        .slice(0, 3)
        .map((rawChunk, index) => {
          if (!rawChunk || typeof rawChunk !== "object") {
            return `#${index + 1}:invalid`
          }
          const chunk = rawChunk as Record<string, unknown>
          const startLine = this.pickFirstNumber(chunk, [
            "startLine",
            "start_line",
            "StartLine",
          ])
          const endLine = this.pickFirstNumber(chunk, [
            "endLine",
            "end_line",
            "EndLine",
          ])
          const allowMultiple = this.pickFirstBoolean(chunk, [
            "allowMultiple",
            "allow_multiple",
            "AllowMultiple",
          ])
          const searchText =
            this.pickFirstRawString(chunk, [
              "targetContent",
              "target_content",
              "TargetContent",
              "search",
            ]) ?? ""
          const replaceText =
            this.pickFirstRawString(
              chunk,
              [
                "replacementContent",
                "replacement_content",
                "ReplacementContent",
                "replace",
              ],
              { allowEmpty: true }
            ) ?? ""
          const summary = [`#${index + 1}`]
          if (startLine != null || endLine != null) {
            summary.push(`lines=${startLine ?? "?"}-${endLine ?? "?"}`)
          }
          if (typeof allowMultiple === "boolean") {
            summary.push(`allowMultiple=${allowMultiple}`)
          }
          summary.push(`search_len=${searchText.length}`)
          if (searchText.length > 0) {
            summary.push(
              `search_preview=${JSON.stringify(this.compactEditLogPreview(searchText, 80))}`
            )
          }
          summary.push(`replace_len=${replaceText.length}`)
          return summary.join(",")
        })
        .join(" ; ")
      if (chunkPreview) {
        parts.push(`chunk_preview=${chunkPreview}`)
      }
      return parts.join(" | ")
    }

    const searchText =
      this.pickFirstRawString(input, ["search", "old_text"], {
        allowEmpty: true,
      }) ?? ""
    const replaceText =
      this.pickFirstRawString(input, ["replace", "new_text"], {
        allowEmpty: true,
      }) ?? ""
    const startLine = this.pickFirstNumber(input, [
      "start_line",
      "startLine",
      "StartLine",
    ])
    const endLine = this.pickFirstNumber(input, [
      "end_line",
      "endLine",
      "EndLine",
    ])
    const allowMultiple = this.pickFirstBoolean(input, [
      "allow_multiple",
      "allowMultiple",
      "AllowMultiple",
    ])

    if (startLine != null || endLine != null) {
      parts.push(`lines=${startLine ?? "?"}-${endLine ?? "?"}`)
    }
    if (typeof allowMultiple === "boolean") {
      parts.push(`allowMultiple=${allowMultiple}`)
    }
    parts.push(`search_len=${searchText.length}`)
    if (searchText.length > 0) {
      parts.push(
        `search_preview=${JSON.stringify(this.compactEditLogPreview(searchText))}`
      )
    }
    parts.push(`replace_len=${replaceText.length}`)

    return parts.join(" | ")
  }

  private maybeRecordReadSnapshot(
    conversationId: string,
    pendingToolCall: PendingToolCall,
    rawToolResultContent: string,
    toolResultState?: { status: ToolResultStatus; message?: string }
  ): void {
    const normalizedToolName = pendingToolCall.toolName.trim().toLowerCase()
    const normalizedHistoryToolName = (pendingToolCall.historyToolName || "")
      .trim()
      .toLowerCase()
    const isReadLikeTool =
      normalizedToolName === "read_file" ||
      normalizedToolName === "read_file_v2" ||
      normalizedHistoryToolName === "view_file"
    if (!isReadLikeTool) {
      return
    }
    if (toolResultState && toolResultState.status !== "success") {
      return
    }

    const filePath =
      this.pickFirstString(pendingToolCall.toolInput, ["path"]) ||
      this.pickFirstString(pendingToolCall.historyToolInput || {}, [
        "TargetFile",
        "AbsolutePath",
      ]) ||
      ""
    if (!filePath || !rawToolResultContent) {
      return
    }

    const startLine = this.pickFirstNumber(pendingToolCall.toolInput, [
      "start_line",
      "startLine",
      "StartLine",
    ])
    const endLine = this.pickFirstNumber(pendingToolCall.toolInput, [
      "end_line",
      "endLine",
      "EndLine",
    ])
    const recorded = this.sessionManager.addReadSnapshot(conversationId, {
      filePath,
      startLine,
      endLine,
      content: rawToolResultContent,
      sourceToolName:
        pendingToolCall.historyToolName ||
        pendingToolCall.toolName ||
        "read_file",
    })
    if (recorded) {
      this.logger.debug(
        `Recorded read snapshot for ${filePath} (${startLine ?? "?"}-${endLine ?? "?"})`
      )
    }
  }

  private buildEditFailureContext(
    pendingToolCall: PendingToolCall
  ): ToolCompletedExtraData["editFailureContext"] | undefined {
    const beforeContent = pendingToolCall.beforeContent
    if (typeof beforeContent !== "string") {
      return undefined
    }

    const toolInput = pendingToolCall.toolInput
    const selection =
      pendingToolCall.editFailureContext ||
      (() => {
        const extracted = extractEditFailureSelection(
          toolInput,
          pendingToolCall.editApplyWarning
        )
        if (!extracted) return undefined
        return {
          filePath:
            this.pickFirstString(toolInput, [
              "path",
              "filePath",
              "file_path",
              "TargetFile",
            ]) || "",
          reason: "target_not_found" as const,
          ...extracted,
        }
      })()
    if (!selection) {
      return undefined
    }

    const snippet = formatLineNumberedSnippet(beforeContent, {
      startLine: selection.startLine,
      endLine: selection.endLine,
      maxLines: 120,
    })
    const searchText =
      typeof selection.searchText === "string" ? selection.searchText : ""
    const matchCountInFile =
      searchText.length > 0
        ? this.countSubstringOccurrences(beforeContent, searchText)
        : undefined

    return {
      ...selection,
      currentRangeSnippet: snippet.snippet,
      currentRangeSnippetStartLine: snippet.startLine,
      currentRangeSnippetEndLine: snippet.endLine,
      currentRangeSnippetTruncated: snippet.truncated,
      matchCountInFile,
    }
  }

  private buildEditFailureToolResultContent(
    conversationId: string,
    pendingToolCall: PendingToolCall
  ): {
    content: string
    context?: ToolCompletedExtraData["editFailureContext"]
  } {
    const warning =
      pendingToolCall.editApplyWarning || "edit_file apply failed before write"
    const context = this.buildEditFailureContext(pendingToolCall)
    if (!context) {
      return {
        content: `[edit_apply_failed]\nreason: ${warning}`,
      }
    }

    const lines = ["[edit_apply_failed]"]
    if (context.filePath) {
      lines.push(`path: ${context.filePath}`)
    }
    lines.push(`reason: ${warning}`)
    if (
      context.currentRangeSnippetStartLine != null ||
      context.currentRangeSnippetEndLine != null
    ) {
      lines.push(
        `requested_range: ${context.currentRangeSnippetStartLine ?? context.startLine ?? "?"}-${context.currentRangeSnippetEndLine ?? context.endLine ?? "?"}`
      )
    }
    if (typeof context.searchText === "string") {
      lines.push(`target_content_length: ${context.searchText.length}`)
    }
    if (typeof context.replaceTextLength === "number") {
      lines.push(`replacement_content_length: ${context.replaceTextLength}`)
    }
    if (typeof context.matchCountInFile === "number") {
      lines.push(
        `target_content_matches_in_current_file: ${context.matchCountInFile}`
      )
      lines.push(
        context.matchCountInFile > 0
          ? "diagnosis: TargetContent exists in the current file, but not inside the requested line window. Fix StartLine/EndLine."
          : "diagnosis: TargetContent does not exist verbatim in the current file. Re-copy the exact current_text before retrying."
      )
    }
    const latestSnapshot = this.sessionManager.getLatestReadSnapshot(
      conversationId,
      context.filePath,
      {
        startLine: context.startLine,
        endLine: context.endLine,
        requireCoverage: false,
      }
    )
    if (latestSnapshot?.sourceToolName) {
      lines.push(`latest_snapshot_source: ${latestSnapshot.sourceToolName}`)
    }
    lines.push("current_text:")
    lines.push(context.currentRangeSnippet || "[no current text available]")
    if (context.currentRangeSnippetTruncated) {
      lines.push("[current_text truncated]")
    }

    return {
      content: lines.join("\n"),
      context,
    }
  }

  private toStructuredToolResultScalar(
    value: string | number | boolean | bigint | undefined
  ): string | number | boolean | undefined {
    if (value == null) return undefined
    if (typeof value === "bigint") return value.toString()
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : undefined
    }
    return value
  }

  private buildOfficialViewFileStructuredToolResult(
    pendingToolCall: PendingToolCall,
    extraData?: ToolCompletedExtraData
  ): Record<string, unknown> | undefined {
    const readContent = extraData?.readSuccess?.content
    if (typeof readContent !== "string") {
      return undefined
    }

    const actualInput = pendingToolCall.toolInput || {}
    const historyInput = pendingToolCall.historyToolInput || {}
    const filePath =
      extraData?.readSuccess?.path ||
      this.pickFirstString(actualInput, ["path", "filePath", "file_path"]) ||
      this.pickFirstString(historyInput, [
        "AbsolutePath",
        "path",
        "filePath",
        "file_path",
      ]) ||
      ""
    const actualStartLine =
      this.pickFirstNumber(actualInput, [
        "start_line",
        "startLine",
        "StartLine",
      ]) ?? 1
    const requestedStartLine = this.pickFirstNumber(historyInput, [
      "StartLine",
      "startLine",
      "start_line",
    ])
    const requestedEndLine = this.pickFirstNumber(historyInput, [
      "EndLine",
      "endLine",
      "end_line",
    ])
    const numbered = buildNumberedLineEntries(readContent, actualStartLine)
    const structured: Record<string, unknown> = {
      output: numbered.text.length > 0 ? numbered.text : readContent,
      AbsolutePath: filePath,
      StartLine: actualStartLine,
      EndLine: numbered.endLine,
      IncludeLineNumbers: true,
      ReturnedLineCount: numbered.lines.length,
    }

    if (readContent.length === 0) {
      structured.IsEmpty = true
    }

    if (numbered.lines.length > 0) {
      structured.Lines = numbered.lines
    }

    if (requestedStartLine != null && requestedStartLine !== actualStartLine) {
      structured.RequestedStartLine = requestedStartLine
    }
    if (requestedEndLine != null && requestedEndLine !== numbered.endLine) {
      structured.RequestedEndLine = requestedEndLine
    }

    const totalLines = this.toStructuredToolResultScalar(
      extraData?.readSuccess?.totalLines
    )
    if (totalLines != null) {
      structured.TotalLines = totalLines
    }

    const fileSizeBytes = this.toStructuredToolResultScalar(
      extraData?.readSuccess?.fileSize
    )
    if (fileSizeBytes != null) {
      structured.FileSizeBytes = fileSizeBytes
    }

    if (typeof extraData?.readSuccess?.truncated === "boolean") {
      structured.Truncated = extraData.readSuccess.truncated
    }

    const isSkillFile = this.pickFirstBoolean(historyInput, [
      "IsSkillFile",
      "isSkillFile",
      "is_skill_file",
    ])
    if (typeof isSkillFile === "boolean") {
      structured.IsSkillFile = isSkillFile
    }

    return structured
  }

  private buildOfficialEditFailureStructuredToolResult(
    toolResultContent: string,
    toolResultState: { status: ToolResultStatus; message?: string } | undefined,
    extraData?: ToolCompletedExtraData
  ): Record<string, unknown> | undefined {
    const context = extraData?.editFailureContext
    if (!context) {
      return undefined
    }

    const structured: Record<string, unknown> = {
      output:
        toolResultState?.message ||
        toolResultContent.split(/\r?\n/, 1)[0] ||
        "[edit_apply_failed]",
      AbsolutePath: context.filePath,
      FailureReason: context.reason,
    }

    if (context.startLine != null) {
      structured.RequestedStartLine = context.startLine
    }
    if (context.endLine != null) {
      structured.RequestedEndLine = context.endLine
    }
    if (typeof context.allowMultiple === "boolean") {
      structured.AllowMultiple = context.allowMultiple
    }
    if (typeof context.searchText === "string") {
      structured.TargetContent = context.searchText
      structured.TargetContentLength = context.searchText.length
    }
    if (typeof context.replaceTextLength === "number") {
      structured.ReplacementContentLength = context.replaceTextLength
    }
    if (typeof context.matchCountInFile === "number") {
      structured.TargetContentMatchesInCurrentFile = context.matchCountInFile
      structured.Diagnosis =
        context.matchCountInFile > 0
          ? "TargetContent exists in the current file, but not inside the requested line window."
          : "TargetContent does not exist verbatim in the current file."
    }
    if (typeof context.currentRangeSnippet === "string") {
      structured.CurrentTextWithLineNumbers = context.currentRangeSnippet
    }
    if (context.currentRangeSnippetStartLine != null) {
      structured.CurrentTextStartLine = context.currentRangeSnippetStartLine
    }
    if (context.currentRangeSnippetEndLine != null) {
      structured.CurrentTextEndLine = context.currentRangeSnippetEndLine
    }
    if (typeof context.currentRangeSnippetTruncated === "boolean") {
      structured.CurrentTextTruncated = context.currentRangeSnippetTruncated
    }

    return structured
  }

  private buildStructuredHistoryToolResult(
    pendingToolCall: PendingToolCall,
    toolResultContent: string,
    toolResultState: { status: ToolResultStatus; message?: string } | undefined,
    extraData?: ToolCompletedExtraData
  ): Record<string, unknown> | undefined {
    const historyToolName = (
      pendingToolCall.historyToolName ||
      pendingToolCall.toolName ||
      ""
    )
      .trim()
      .toLowerCase()

    if (historyToolName === "view_file") {
      return this.buildOfficialViewFileStructuredToolResult(
        pendingToolCall,
        extraData
      )
    }

    if (historyToolName === "task" && extraData?.taskSuccess) {
      return {
        taskSuccess: this.toJsonSafe(extraData.taskSuccess),
      }
    }

    if (
      historyToolName === "replace_file_content" ||
      historyToolName === "multi_replace_file_content" ||
      historyToolName === "write_to_file"
    ) {
      return this.buildOfficialEditFailureStructuredToolResult(
        toolResultContent,
        toolResultState,
        extraData
      )
    }

    return undefined
  }

  /**
   * Build full file text for edit/edit_file/edit_file_v2 tools.
   * Protocol requirement: writeArgs.fileText must be the complete file content,
   * not just the replacement snippet.
   */
  private applyEditInputToFileText(
    beforeContent: string,
    toolInput: ToolInputWithPath
  ): {
    fileText: string
    warning?: string
    failureContext?: EditFailureContext
    resolvedMatches?: EditResolvedMatch[]
    /**
     * Forwarded from `applySearchReplaceWithinRange` when the entire
     * edit collapsed to a no-op (search === replace). Caller MUST treat
     * this as success and emit a short "no-op" inline result rather
     * than `[edit_apply_failed]`. Mirrors the new contract on
     * `applySearchReplaceWithinRange`.
     */
    noopReason?: "identical_search_replace"
  } {
    const explicitFullFileText =
      typeof toolInput.file_text === "string" ? toolInput.file_text : undefined
    const filePath = typeof toolInput.path === "string" ? toolInput.path : ""
    if (explicitFullFileText !== undefined) {
      const overwrite = this.pickFirstBoolean(
        toolInput as Record<string, unknown>,
        ["overwrite", "Overwrite"]
      )
      if (beforeContent.length > 0 && overwrite !== true) {
        return {
          fileText: beforeContent,
          warning:
            "write_to_file target already exists and requires overwrite=true; no changes applied",
          failureContext: {
            filePath,
            reason: "unsafe_overwrite",
          },
        }
      }
      return { fileText: explicitFullFileText }
    }

    const rawReplacementChunks = Array.isArray(
      (toolInput as Record<string, unknown>).replacementChunks
    )
      ? ((toolInput as Record<string, unknown>).replacementChunks as unknown[])
      : []
    if (rawReplacementChunks.length > 0) {
      const normalizedChunks = rawReplacementChunks.map((rawChunk, index) => ({
        rawChunk,
        index,
      }))
      const orderedChunks = normalizedChunks.every(({ rawChunk }) => {
        if (!rawChunk || typeof rawChunk !== "object") return false
        const chunk = rawChunk as Record<string, unknown>
        return (
          this.pickFirstNumber(chunk, [
            "startLine",
            "start_line",
            "StartLine",
          ]) != null &&
          this.pickFirstNumber(chunk, ["endLine", "end_line", "EndLine"]) !=
            null
        )
      })
        ? [...normalizedChunks].sort((left, right) => {
            const leftChunk = left.rawChunk as Record<string, unknown>
            const rightChunk = right.rawChunk as Record<string, unknown>
            const leftStart =
              this.pickFirstNumber(leftChunk, [
                "startLine",
                "start_line",
                "StartLine",
              ]) || 0
            const rightStart =
              this.pickFirstNumber(rightChunk, [
                "startLine",
                "start_line",
                "StartLine",
              ]) || 0
            if (rightStart !== leftStart) return rightStart - leftStart

            const leftEnd =
              this.pickFirstNumber(leftChunk, [
                "endLine",
                "end_line",
                "EndLine",
              ]) || 0
            const rightEnd =
              this.pickFirstNumber(rightChunk, [
                "endLine",
                "end_line",
                "EndLine",
              ]) || 0
            if (rightEnd !== leftEnd) return rightEnd - leftEnd
            return right.index - left.index
          })
        : normalizedChunks

      let nextContent = beforeContent
      const resolvedMatches: EditResolvedMatch[] = []
      let allChunksNoop = true
      for (const { rawChunk, index } of orderedChunks) {
        if (!rawChunk || typeof rawChunk !== "object") {
          return {
            fileText: beforeContent,
            warning: `edit_file replacement chunk ${index + 1} is invalid`,
            failureContext: {
              filePath,
              reason: "invalid_chunk",
              chunkIndex: index,
            },
          }
        }
        const chunk = rawChunk as Record<string, unknown>
        const searchText = this.pickFirstRawString(chunk, [
          "targetContent",
          "target_content",
          "TargetContent",
          "search",
        ])
        const replaceText = this.pickFirstRawString(
          chunk,
          [
            "replacementContent",
            "replacement_content",
            "ReplacementContent",
            "replace",
          ],
          { allowEmpty: true }
        )
        const allowMultiple = this.pickFirstBoolean(chunk, [
          "allowMultiple",
          "allow_multiple",
          "AllowMultiple",
        ])
        const startLine = this.pickFirstNumber(chunk, [
          "startLine",
          "start_line",
          "StartLine",
        ])
        const endLine = this.pickFirstNumber(chunk, [
          "endLine",
          "end_line",
          "EndLine",
        ])

        if (searchText === undefined || replaceText === undefined) {
          return {
            fileText: beforeContent,
            warning: `edit_file replacement chunk ${index + 1} is missing target/replacement content`,
            failureContext: {
              filePath,
              reason: "missing_content",
              startLine,
              endLine,
              allowMultiple,
              chunkIndex: index,
            },
          }
        }
        const chunkEdit = this.applySearchReplaceWithinRange(nextContent, {
          searchText,
          replaceText,
          allowMultiple,
          startLine,
          endLine,
          warningPrefix: `edit_file replacement chunk ${index + 1}`,
        })
        if (chunkEdit.warning) {
          return {
            fileText: beforeContent,
            warning: chunkEdit.warning,
            failureContext: chunkEdit.failureContext
              ? {
                  ...chunkEdit.failureContext,
                  filePath,
                  chunkIndex: index,
                }
              : {
                  filePath,
                  reason: "target_not_found",
                  startLine,
                  endLine,
                  allowMultiple,
                  searchText,
                  replaceTextLength: replaceText.length,
                  chunkIndex: index,
                },
          }
        }

        if (chunkEdit.resolvedMatch) {
          resolvedMatches.push({
            ...chunkEdit.resolvedMatch,
            chunkIndex: index,
          })
        }
        if (!chunkEdit.noopReason) {
          allChunksNoop = false
        }
        nextContent = chunkEdit.fileText
      }

      return {
        fileText: nextContent,
        ...(resolvedMatches.length > 0 ? { resolvedMatches } : {}),
        // Surface noopReason only when *every* chunk collapsed to a
        // no-op. A mix of real edits + no-op chunks is still a real
        // edit; we just don't bother differentiating per-chunk.
        ...(allChunksNoop && orderedChunks.length > 0
          ? { noopReason: "identical_search_replace" as const }
          : {}),
      }
    }

    const searchText =
      this.pickFirstRawString(
        toolInput as Record<string, unknown>,
        ["search", "old_text"],
        { allowEmpty: true }
      ) ?? undefined
    const replaceText =
      this.pickFirstRawString(
        toolInput as Record<string, unknown>,
        ["replace", "new_text"],
        { allowEmpty: true }
      ) ?? undefined
    const allowMultiple = this.pickFirstBoolean(
      toolInput as Record<string, unknown>,
      [
        // claude-code-aligned public field — preferred name in the
        // edit_file_v2 schema, mirrors FileEditTool.replace_all.
        "replace_all",
        "replaceAll",
        // Bridge-historical aliases kept for tolerant parsing.
        "allow_multiple",
        "allowMultiple",
        "AllowMultiple",
      ]
    )
    const startLine = this.pickFirstNumber(
      toolInput as Record<string, unknown>,
      ["start_line", "startLine", "StartLine"]
    )
    const endLine = this.pickFirstNumber(toolInput as Record<string, unknown>, [
      "end_line",
      "endLine",
      "EndLine",
    ])

    if (searchText === undefined || replaceText === undefined) {
      return {
        fileText: beforeContent,
        warning:
          "edit_file input missing search/replace pair; skipped destructive overwrite",
        failureContext: {
          filePath,
          reason: "missing_search_replace",
          startLine,
          endLine,
          allowMultiple,
          searchText: searchText ?? "",
          replaceTextLength: replaceText?.length ?? 0,
        },
      }
    }

    if (searchText.length === 0) {
      if (beforeContent.length === 0) {
        return { fileText: replaceText }
      }
      return {
        fileText: beforeContent,
        warning:
          "edit_file search text is empty; skipped destructive overwrite",
        failureContext: {
          filePath,
          reason: "empty_search",
          startLine,
          endLine,
          allowMultiple,
          searchText,
          replaceTextLength: replaceText.length,
        },
      }
    }

    const searchReplaceResult = this.applySearchReplaceWithinRange(
      beforeContent,
      {
        searchText,
        replaceText,
        allowMultiple,
        startLine,
        endLine,
        warningPrefix: "edit_file search text",
      }
    )
    if (!searchReplaceResult.failureContext) {
      return {
        ...searchReplaceResult,
        ...(searchReplaceResult.resolvedMatch
          ? { resolvedMatches: [searchReplaceResult.resolvedMatch] }
          : {}),
      }
    }
    return {
      ...searchReplaceResult,
      failureContext: {
        ...searchReplaceResult.failureContext,
        filePath,
      },
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

  private normalizeLegacyWebDocumentToolName(
    toolName: string
  ): "read_url_content" | "view_content_chunk" | undefined {
    const snake = toolName
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
    const compact = toolName.toLowerCase().replace(/[^a-z0-9]+/g, "")

    if (
      snake.includes("read_url_content") ||
      compact.includes("readurlcontent")
    ) {
      return "read_url_content"
    }
    if (
      snake.includes("view_content_chunk") ||
      compact.includes("viewcontentchunk")
    ) {
      return "view_content_chunk"
    }
    return undefined
  }

  private hasMeaningfulInlineFetchHeaders(
    input: Record<string, unknown>
  ): boolean {
    const candidates = [
      input.headers,
      input.header,
      input.requestHeaders,
      input.request_headers,
    ]

    for (const candidate of candidates) {
      if (!candidate) continue
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return true
      }
      if (Array.isArray(candidate) && candidate.length > 0) {
        return true
      }
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        Object.keys(candidate as Record<string, unknown>).length > 0
      ) {
        return true
      }
    }

    return false
  }

  private hasMeaningfulInlineFetchBody(
    input: Record<string, unknown>
  ): boolean {
    const bodyRaw = input.body ?? input.data ?? input.payload
    if (bodyRaw === undefined || bodyRaw === null) return false
    if (typeof bodyRaw === "string") return bodyRaw.trim().length > 0
    if (typeof bodyRaw === "number" || typeof bodyRaw === "boolean") {
      return true
    }
    if (typeof bodyRaw === "bigint") return true
    if (Array.isArray(bodyRaw)) return bodyRaw.length > 0
    if (Buffer.isBuffer(bodyRaw)) return bodyRaw.length > 0
    if (typeof bodyRaw === "object") {
      return Object.keys(bodyRaw as Record<string, unknown>).length > 0
    }
    return false
  }

  private shouldCanonicalizeFetchAsWebFetch(
    input: Record<string, unknown>
  ): boolean {
    const rawUrl =
      this.pickFirstString(input, [
        "url",
        "Url",
        "document_id",
        "documentId",
      ]) || ""
    if (!rawUrl) return false

    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return false
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false
    }

    const method =
      (
        this.pickFirstString(input, ["method", "httpMethod", "http_method"]) ||
        "GET"
      )
        .trim()
        .toUpperCase() || "GET"

    if (method !== "GET") return false
    if (this.hasMeaningfulInlineFetchHeaders(input)) return false
    if (this.hasMeaningfulInlineFetchBody(input)) return false

    return true
  }

  private extractOfficialAntigravityArtifactMetadata(
    input: Record<string, unknown>
  ): OfficialAntigravityArtifactMetadata | undefined {
    return extractOfficialAntigravityArtifactMetadataFromContract(input)
  }

  private deriveArtifactTitleFromMarkdown(
    markdown: string,
    fallbackPath: string
  ): string {
    const headingMatch = markdown.match(/^\s*#\s+(.+?)\s*$/m)
    if (headingMatch?.[1]) {
      return headingMatch[1].trim()
    }

    const base = path.basename(
      fallbackPath || "artifact",
      path.extname(fallbackPath || "artifact")
    )
    return base.replace(/[_-]+/g, " ").trim() || "Artifact"
  }

  private parseMarkdownTodoItemsForArtifact(
    markdown: string,
    idPrefix: string
  ): Array<Record<string, unknown>> {
    const lines = markdown.split(/\r?\n/)
    const checkboxPattern = /^\s*(?:[-*+]|\d+\.)\s+\[([ xX/])\]\s+(.+?)\s*$/
    const bulletPattern = /^\s*(?:[-*+]|\d+\.)\s+(.+?)\s*$/
    let inCodeFence = false
    let hasCheckboxItems = false

    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        inCodeFence = !inCodeFence
        continue
      }
      if (inCodeFence) continue
      if (checkboxPattern.test(line)) {
        hasCheckboxItems = true
        break
      }
    }

    const todos: Array<Record<string, unknown>> = []
    inCodeFence = false
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        inCodeFence = !inCodeFence
        continue
      }
      if (inCodeFence) continue

      const checkboxMatch = line.match(checkboxPattern)
      if (checkboxMatch) {
        const statusToken = (checkboxMatch[1] || " ").trim().toLowerCase()
        const content = (checkboxMatch[2] || "").trim()
        if (!content) continue
        const slug = content
          .toLowerCase()
          .replace(/[`*_~[\]()]/g, "")
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
          .slice(0, 48)
        todos.push({
          id: `${idPrefix}_${todos.length + 1}${slug ? `_${slug}` : ""}`,
          content,
          status:
            statusToken === "x"
              ? "completed"
              : statusToken === "/"
                ? "in_progress"
                : "pending",
          dependencies: [],
        })
        continue
      }

      if (hasCheckboxItems) continue

      const bulletMatch = line.match(bulletPattern)
      if (!bulletMatch) continue
      const content = (bulletMatch[1] || "").trim()
      if (!content || content.startsWith("#")) continue
      const slug = content
        .toLowerCase()
        .replace(/[`*_~[\]()]/g, "")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 48)
      todos.push({
        id: `${idPrefix}_${todos.length + 1}${slug ? `_${slug}` : ""}`,
        content,
        status: "pending",
        dependencies: [],
      })
    }

    return todos
  }

  private buildCursorArtifactUiProjection(
    conversationId: string,
    pendingToolCall: PendingToolCall,
    afterContent: string
  ): CursorArtifactUiProjection | null {
    const metadata = this.extractOfficialAntigravityArtifactMetadata(
      pendingToolCall.toolInput
    )
    const artifactType = metadata?.artifactType
    // Google's implementation_plan is a technical design document — not the
    // same as Cursor's create_plan (an interactive step/todo manager).
    // Only "task" artifacts map to Cursor UI projections (update_todos).
    if (artifactType !== "task") {
      return null
    }

    const artifactPath =
      this.pickFirstString(pendingToolCall.toolInput, [
        "path",
        "filePath",
        "file_path",
        "TargetFile",
      ]) || ""
    const description =
      this.pickFirstString(pendingToolCall.toolInput, [
        "description",
        "Description",
      ]) || ""

    let todos = this.parseMarkdownTodoItemsForArtifact(
      afterContent,
      "artifact_task"
    )
    if (todos.length === 0) {
      const fallbackContent =
        metadata?.summary ||
        description ||
        this.deriveArtifactTitleFromMarkdown(afterContent, artifactPath)
      todos = [
        {
          id: "artifact_task_1",
          content: fallbackContent,
          status: "pending",
          dependencies: [],
        },
      ]
    }

    const toolInput: Record<string, unknown> = {
      merge: false,
      todos,
    }
    const todoWriteResult = this.executeInlineTodoWrite(
      conversationId,
      toolInput
    )
    return {
      toolName: "update_todos",
      toolInput,
      content: todoWriteResult.content,
      toolResultState: todoWriteResult.state,
    }
  }

  private shouldProjectOfficialArtifactAsCursorUi(
    toolName: string,
    toolInput: Record<string, unknown>
  ): boolean {
    if (!this.isEditToolInvocation(toolName)) return false
    const metadata = this.extractOfficialAntigravityArtifactMetadata(toolInput)
    return metadata?.artifactType === "task"
  }

  private canonicalizeOfficialAntigravityToolInvocation(
    toolName: string,
    input: Record<string, unknown>
  ): CanonicalToolInvocation | null {
    return canonicalizeOfficialAntigravityToolInvocationFromContract(
      toolName,
      input
    )
  }

  private extractCodexAgentTextFromItems(items: unknown): string {
    if (!Array.isArray(items)) {
      return ""
    }

    return items
      .flatMap((item) => {
        if (!item || typeof item !== "object") return []
        const record = item as Record<string, unknown>
        const text = this.pickFirstString(record, [
          "text",
          "path",
          "name",
          "image_url",
        ])
        return text ? [text] : []
      })
      .join("\n")
      .trim()
  }

  private buildSyntheticCodexAgentMessage(
    input: Record<string, unknown>
  ): string {
    const message = this.pickFirstString(input, ["message"]) || ""
    const itemsText = this.extractCodexAgentTextFromItems(input.items)
    return [message, itemsText]
      .filter((part) => part.trim().length > 0)
      .join("\n\n")
  }

  private buildSyntheticCodexAgentPayload(
    agent: SyntheticCodexAgentState
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      id: agent.agentId,
      agent_id: agent.agentId,
      status: agent.status,
      created_at: agent.createdAt,
      updated_at: agent.updatedAt,
    }
    if (agent.nickname) {
      payload.nickname = agent.nickname
    }
    if (agent.agentType) {
      payload.agent_type = agent.agentType
    }
    if (agent.model) {
      payload.model = agent.model
    }
    if (agent.message) {
      payload.message = agent.message
    }
    if (agent.lastInput) {
      payload.last_input = agent.lastInput
    }
    return payload
  }

  private canonicalizeCodexCliToolInvocation(
    toolName: string,
    input: Record<string, unknown>
  ): CanonicalToolInvocation | null {
    const normalized = toolName.trim().toLowerCase()

    if (normalized === "exec_command") {
      const command = this.pickFirstString(input, ["cmd", "command"]) || ""
      const cwd =
        this.pickFirstString(input, ["workdir", "cwd", "workingDirectory"]) ||
        ""
      const timeout =
        this.pickFirstNumber(input, ["yield_time_ms", "yieldTimeMs"]) || 0
      return {
        toolName: "run_terminal_command",
        input: {
          command,
          cwd,
          timeout,
          description:
            this.pickFirstString(input, ["justification", "description"]) || "",
          enableWriteShellStdinTool: true,
          shell: this.pickFirstString(input, ["shell"]) || "",
          closeStdin: false,
          tty: this.pickFirstBoolean(input, ["tty"]) || false,
        },
        historyToolName: "exec_command",
        historyToolInput: input,
      }
    }

    if (normalized === "write_stdin") {
      const shellId =
        this.pickFirstNumber(input, ["session_id", "sessionId", "shellId"]) || 0
      const chars =
        this.pickFirstString(input, ["chars", "data", "input"]) || ""
      return {
        toolName: "write_shell_stdin",
        input: {
          shellId,
          chars,
          data: chars,
        },
        historyToolName: "write_stdin",
        historyToolInput: input,
      }
    }

    if (normalized === "list_mcp_resources") {
      return {
        toolName: "list_mcp_resources",
        input: {
          serverName:
            this.pickFirstString(input, ["server", "serverName"]) || "",
          cursor: this.pickFirstString(input, ["cursor"]) || "",
        },
        historyToolName: "list_mcp_resources",
        historyToolInput: input,
      }
    }

    if (normalized === "list_mcp_resource_templates") {
      return {
        toolName: "list_mcp_resource_templates",
        input,
        historyToolName: "list_mcp_resource_templates",
        historyToolInput: input,
      }
    }

    if (normalized === "read_mcp_resource") {
      return {
        toolName: "read_mcp_resource",
        input: {
          serverName:
            this.pickFirstString(input, ["server", "serverName"]) || "",
          uri: this.pickFirstString(input, ["uri"]) || "",
        },
        historyToolName: "read_mcp_resource",
        historyToolInput: input,
      }
    }

    if (
      normalized === "update_plan" ||
      normalized === "request_user_input" ||
      normalized === "view_image" ||
      normalized === "spawn_agent" ||
      normalized === "send_input" ||
      normalized === "resume_agent" ||
      normalized === "wait_agent" ||
      normalized === "close_agent" ||
      normalized === "apply_patch"
    ) {
      return {
        toolName: normalized,
        input,
        historyToolName: normalized,
        historyToolInput: input,
      }
    }

    return null
  }

  private canonicalizeToolInvocation(
    toolName: string,
    input: Record<string, unknown>
  ): CanonicalToolInvocation {
    const antigravityInvocation =
      this.canonicalizeOfficialAntigravityToolInvocation(toolName, input)
    if (antigravityInvocation) {
      return antigravityInvocation
    }

    const codexCliInvocation = this.canonicalizeCodexCliToolInvocation(
      toolName,
      input
    )
    if (codexCliInvocation) {
      return codexCliInvocation
    }

    const family = this.normalizeDeferredToolFamily(toolName)
    if (family === "fetch" && this.shouldCanonicalizeFetchAsWebFetch(input)) {
      return {
        toolName: "web_fetch",
        input,
      }
    }

    if (family === "exa_search") {
      return {
        toolName: "web_search",
        input: {
          ...input,
          query:
            this.pickFirstString(input, [
              "query",
              "searchTerm",
              "search_term",
            ]) || "",
        },
      }
    }

    return {
      toolName,
      input,
    }
  }

  /**
   * Pre-dispatch input validator registry, keyed by canonical tool name.
   *
   * Each entry is invoked from `buildPreparedToolInvocation` *after*
   * canonicalization but *before* dispatch resolution. A non-undefined
   * return is folded into the standard `validationErrorMessage` channel,
   * so the dispatcher emits the error through the same inline tool-result
   * envelope the model already understands — no need for a per-tool
   * if/else cascade in the dispatcher.
   *
   * Add a new entry here when a tool has a constraint that is cheaper to
   * check on the bridge side than to roundtrip to the IDE / backend (e.g.
   * workspace-root bounds, mutually exclusive fields, schema invariants
   * the proto layer doesn't enforce).
   *
   * Mirrors the per-tool validator pattern in
   * `apps/protocol-bridge/src/shared/official-antigravity-tools.ts::validateOfficialEditChunk`
   * and claude-code's zod refinement validators on each builtin tool's
   * input schema.
   */
  private static readonly CURSOR_TOOL_INPUT_VALIDATORS: Record<
    string,
    (
      input: Record<string, unknown>,
      ctx: { projectRoot?: string }
    ) => string | undefined
  > = {
    /**
     * `read_lints`: the IDE-side diagnostic provider rejects paths that
     * fall outside the active workspace root with `path is outside
     * workspace root`. Catch absolute out-of-bounds paths up front so
     * the model gets a structured message instead of a generic IDE
     * error after the round-trip.
     *
     * - Empty paths / no projectRoot: skip (let the IDE answer).
     * - Relative paths: skip (IDE resolves them against root, always
     *   in-bounds).
     * - Absolute paths: must live under projectRoot.
     */
    read_lints: (input, ctx): string | undefined => {
      const rootPath = ctx.projectRoot?.trim()
      if (!rootPath) return undefined

      const rawPaths = input.paths
      const candidatePaths: string[] = []
      if (Array.isArray(rawPaths)) {
        for (const candidate of rawPaths) {
          if (typeof candidate === "string" && candidate.trim().length > 0) {
            candidatePaths.push(candidate.trim())
          }
        }
      } else if (typeof rawPaths === "string" && rawPaths.trim().length > 0) {
        candidatePaths.push(rawPaths.trim())
      }
      if (candidatePaths.length === 0) return undefined

      let normalizedRoot = rootPath
      try {
        normalizedRoot = path.resolve(rootPath)
      } catch {
        // best-effort; if path.resolve throws (rare), keep the raw value.
      }
      const rootWithSep = normalizedRoot.endsWith(path.sep)
        ? normalizedRoot
        : `${normalizedRoot}${path.sep}`
      const outOfBounds: string[] = []
      for (const candidate of candidatePaths) {
        if (!path.isAbsolute(candidate)) continue
        let resolved = candidate
        try {
          resolved = path.resolve(candidate)
        } catch {
          // path.resolve almost never throws on a string input; ignore.
        }
        if (resolved !== normalizedRoot && !resolved.startsWith(rootWithSep)) {
          outOfBounds.push(candidate)
        }
      }
      if (outOfBounds.length === 0) return undefined

      const sample = outOfBounds.slice(0, 3).join(", ")
      const more =
        outOfBounds.length > 3 ? ` (+${outOfBounds.length - 3} more)` : ""
      return (
        `read_lints rejected: paths must live under the active workspace root ` +
        `"${normalizedRoot}". Out-of-bounds path(s): ${sample}${more}. ` +
        `Use a workspace-relative path or an absolute path that resolves under ` +
        `the workspace root.`
      )
    },
  }

  /**
   * Run the registered input validator for `canonicalToolName`, if any.
   * Returns the error message it produced, or undefined when no
   * validator is registered or the validator passed.
   */
  private runRegisteredToolInputValidator(
    session: ChatSession,
    canonicalToolName: string,
    input: Record<string, unknown>
  ): string | undefined {
    const validator =
      CursorConnectStreamService.CURSOR_TOOL_INPUT_VALIDATORS[canonicalToolName]
    if (!validator) return undefined
    return validator(input, {
      projectRoot: session.projectContext?.rootPath,
    })
  }

  private normalizeOfficialViewFileInvocation(
    session: ChatSession,
    invocation: CanonicalToolInvocation
  ): CanonicalToolInvocation {
    if (
      invocation.toolName !== "read_file" ||
      (invocation.historyToolName || "").trim().toLowerCase() !== "view_file"
    ) {
      return invocation
    }

    const filePath =
      this.pickFirstString(invocation.input, [
        "path",
        "file_path",
        "filePath",
        "AbsolutePath",
      ]) ||
      this.pickFirstString(invocation.historyToolInput || {}, [
        "AbsolutePath",
        "path",
        "file_path",
        "filePath",
      ]) ||
      ""
    if (!filePath) {
      return invocation
    }

    if (!this.shouldAutoWindowOfficialViewFile(filePath)) {
      return this.stripOfficialViewFileWindow(invocation)
    }

    const requestedStartLine = this.pickFirstNumber(invocation.input, [
      "start_line",
      "startLine",
      "StartLine",
    ])
    const requestedEndLine = this.pickFirstNumber(invocation.input, [
      "end_line",
      "endLine",
      "EndLine",
    ])

    const resolvedWindow = this.resolveOfficialViewFileWindow(
      filePath,
      requestedStartLine,
      requestedEndLine,
      !session.readPaths.has(filePath)
    )
    if (resolvedWindow.validationErrorMessage) {
      return {
        ...invocation,
        validationErrorMessage: resolvedWindow.validationErrorMessage,
      }
    }

    const nextInput = {
      ...invocation.input,
      start_line: resolvedWindow.startLine,
      end_line: resolvedWindow.endLine,
    }

    if (
      nextInput.start_line !== invocation.input.start_line ||
      nextInput.end_line !== invocation.input.end_line
    ) {
      this.logger.debug(
        `Normalized official view_file window for ${filePath}: ` +
          `${requestedStartLine ?? "?"}-${requestedEndLine ?? "?"} -> ` +
          `${resolvedWindow.startLine}-${resolvedWindow.endLine}`
      )
    }

    return {
      ...invocation,
      input: nextInput,
    }
  }

  private shouldAutoWindowOfficialViewFile(filePath: string): boolean {
    const extension = path.extname(filePath).toLowerCase()
    if (extension && this.OFFICIAL_VIEW_FILE_BINARY_EXTENSIONS.has(extension)) {
      return false
    }

    let fd: number | null = null
    try {
      fd = openSync(filePath, "r")
      const sample = Buffer.allocUnsafe(4096)
      const bytesRead = readSync(fd, sample, 0, sample.length, 0)
      if (bytesRead <= 0) {
        return true
      }

      return this.isLikelyTextViewFileBuffer(sample.subarray(0, bytesRead))
    } catch {
      return true
    } finally {
      if (fd != null) {
        closeSync(fd)
      }
    }
  }

  private isLikelyTextViewFileBuffer(sample: Buffer): boolean {
    if (sample.length === 0) {
      return true
    }

    let suspiciousByteCount = 0
    for (const byte of sample) {
      if (byte === 0) {
        return false
      }

      const isSuspiciousControlByte =
        (byte >= 1 && byte <= 8) ||
        byte === 11 ||
        byte === 12 ||
        (byte >= 14 && byte <= 31) ||
        byte === 127
      if (isSuspiciousControlByte) {
        suspiciousByteCount += 1
      }
    }

    return suspiciousByteCount / sample.length < 0.3
  }

  private stripOfficialViewFileWindow(
    invocation: CanonicalToolInvocation
  ): CanonicalToolInvocation {
    const stripLineFields = (
      value: Record<string, unknown> | undefined
    ): Record<string, unknown> | undefined => {
      if (!value) {
        return value
      }

      const nextValue = { ...value }
      delete nextValue.start_line
      delete nextValue.startLine
      delete nextValue.StartLine
      delete nextValue.end_line
      delete nextValue.endLine
      delete nextValue.EndLine
      return nextValue
    }

    return {
      ...invocation,
      input: stripLineFields(invocation.input) || {},
      historyToolInput: stripLineFields(invocation.historyToolInput),
    }
  }

  private resolveOfficialViewFileWindow(
    filePath: string,
    requestedStartLine?: number,
    requestedEndLine?: number,
    expandFirstReadWindow = false
  ): {
    startLine: number
    endLine: number
    validationErrorMessage?: string
  } {
    const hasRequestedStart =
      requestedStartLine != null && Number.isFinite(requestedStartLine)
    const hasRequestedEnd =
      requestedEndLine != null && Number.isFinite(requestedEndLine)

    if (hasRequestedStart && requestedStartLine < 1) {
      return {
        startLine: 1,
        endLine: 1,
        validationErrorMessage:
          "view_file StartLine must be >= 1. Re-run with a valid StartLine/EndLine range.",
      }
    }
    if (hasRequestedEnd && requestedEndLine < 1) {
      return {
        startLine: 1,
        endLine: 1,
        validationErrorMessage:
          "view_file EndLine must be >= 1. Re-run with a valid StartLine/EndLine range.",
      }
    }
    if (
      hasRequestedStart &&
      hasRequestedEnd &&
      requestedEndLine < requestedStartLine
    ) {
      return {
        startLine: 1,
        endLine: 1,
        validationErrorMessage:
          "view_file EndLine must be >= StartLine. Re-run with a valid StartLine/EndLine range.",
      }
    }

    let totalLines = 1
    let lines: string[] = []
    try {
      const stats = statSync(filePath)
      if (!stats.isFile()) {
        return {
          startLine: requestedStartLine ?? 1,
          endLine: requestedEndLine ?? requestedStartLine ?? 1,
        }
      }
      const content = readFileSync(filePath, "utf8")
      lines = this.splitContentLinesForViewFile(content)
      totalLines = Math.max(1, lines.length)
    } catch {
      return {
        startLine: requestedStartLine ?? 1,
        endLine: requestedEndLine ?? requestedStartLine ?? 1,
      }
    }

    const normalizedRequestedStart = hasRequestedStart
      ? Math.floor(requestedStartLine)
      : undefined
    const normalizedRequestedEnd = hasRequestedEnd
      ? Math.floor(requestedEndLine)
      : undefined

    if (
      normalizedRequestedStart != null &&
      normalizedRequestedStart > totalLines
    ) {
      return {
        startLine: totalLines,
        endLine: totalLines,
        validationErrorMessage:
          `view_file StartLine ${normalizedRequestedStart} is outside this file ` +
          `(${totalLines} line(s)). Re-run with a valid StartLine/EndLine range.`,
      }
    }
    const candidateWindow = this.buildOfficialViewFileCandidateWindow(
      totalLines,
      normalizedRequestedStart,
      normalizedRequestedEnd,
      expandFirstReadWindow
    )
    if (
      candidateWindow.endLine - candidateWindow.startLine + 1 >
      this.OFFICIAL_VIEW_FILE_MAX_LINES
    ) {
      return {
        startLine: candidateWindow.startLine,
        endLine: candidateWindow.endLine,
        validationErrorMessage:
          `view_file can return at most ${this.OFFICIAL_VIEW_FILE_MAX_LINES} lines at a time. ` +
          `Re-run with a narrower StartLine/EndLine range.`,
      }
    }

    const fit = this.fitOfficialViewFileWindowToBudget(lines, candidateWindow, {
      requestedStartLine: normalizedRequestedStart,
      requestedEndLine: normalizedRequestedEnd,
    })
    if (fit.validationErrorMessage) {
      return fit
    }

    return fit
  }

  private buildOfficialViewFileCandidateWindow(
    totalLines: number,
    requestedStartLine?: number,
    requestedEndLine?: number,
    expandFirstReadWindow = false
  ): { startLine: number; endLine: number } {
    const maxLines = this.OFFICIAL_VIEW_FILE_MAX_LINES

    let startLine = requestedStartLine
    let endLine = requestedEndLine

    if (startLine == null && endLine == null) {
      startLine = 1
      endLine = Math.min(totalLines, maxLines)
    } else if (startLine != null && endLine == null) {
      endLine = Math.min(totalLines, startLine + (maxLines - 1))
    } else if (startLine == null && endLine != null) {
      startLine = Math.max(1, endLine - (maxLines - 1))
    }

    const safeStartLine = Math.max(1, Math.min(totalLines, startLine ?? 1))
    const safeEndLine = Math.max(
      safeStartLine,
      Math.min(totalLines, endLine ?? safeStartLine)
    )

    if (!expandFirstReadWindow) {
      return {
        startLine: safeStartLine,
        endLine: safeEndLine,
      }
    }

    return this.expandOfficialViewFileWindowToTargetSpan(
      safeStartLine,
      safeEndLine,
      totalLines,
      maxLines
    )
  }

  private expandOfficialViewFileWindowToTargetSpan(
    startLine: number,
    endLine: number,
    totalLines: number,
    targetSpan: number
  ): { startLine: number; endLine: number } {
    const currentSpan = Math.max(1, endLine - startLine + 1)
    if (currentSpan >= targetSpan) {
      return { startLine, endLine }
    }

    let expandBefore = Math.min(
      startLine - 1,
      Math.floor((targetSpan - currentSpan) / 2)
    )
    let expandAfter = Math.min(
      totalLines - endLine,
      targetSpan - currentSpan - expandBefore
    )
    let remaining = targetSpan - currentSpan - expandBefore - expandAfter

    if (remaining > 0) {
      const extraBefore = Math.min(startLine - 1 - expandBefore, remaining)
      expandBefore += extraBefore
      remaining -= extraBefore
    }

    if (remaining > 0) {
      const extraAfter = Math.min(totalLines - endLine - expandAfter, remaining)
      expandAfter += extraAfter
    }

    return {
      startLine: Math.max(1, startLine - expandBefore),
      endLine: Math.min(totalLines, endLine + expandAfter),
    }
  }

  private fitOfficialViewFileWindowToBudget(
    lines: string[],
    candidateWindow: { startLine: number; endLine: number },
    options: {
      requestedStartLine?: number
      requestedEndLine?: number
    }
  ): {
    startLine: number
    endLine: number
    validationErrorMessage?: string
  } {
    const candidateLineCosts: number[] = []
    for (
      let lineNumber = candidateWindow.startLine;
      lineNumber <= candidateWindow.endLine;
      lineNumber++
    ) {
      const text = lines[lineNumber - 1] ?? ""
      candidateLineCosts.push(
        this.tokenCounter.countText(`${lineNumber} | ${text}`, false)
      )
    }

    const prefixSums = [0]
    for (const cost of candidateLineCosts) {
      prefixSums.push((prefixSums[prefixSums.length - 1] ?? 0) + cost)
    }

    const rangeTokens = (startLine: number, endLine: number): number => {
      const startIndex = startLine - candidateWindow.startLine
      const endIndex = endLine - candidateWindow.startLine + 1
      const tokenSum =
        (prefixSums[endIndex] ?? 0) - (prefixSums[startIndex] ?? 0)
      return tokenSum + Math.max(0, endLine - startLine) + 48
    }

    const requiredStartLine =
      options.requestedStartLine ??
      options.requestedEndLine ??
      candidateWindow.startLine
    const requiredEndLine =
      options.requestedEndLine ??
      options.requestedStartLine ??
      candidateWindow.startLine

    if (
      rangeTokens(requiredStartLine, requiredEndLine) >
      this.OFFICIAL_VIEW_FILE_MAX_RESULT_TOKENS
    ) {
      const rangeLabel =
        options.requestedStartLine != null || options.requestedEndLine != null
          ? `${requiredStartLine}-${requiredEndLine}`
          : `${candidateWindow.startLine}-${candidateWindow.endLine}`
      return {
        startLine: requiredStartLine,
        endLine: requiredEndLine,
        validationErrorMessage:
          `view_file window ${rangeLabel} is too dense to return safely because the file contains very long lines. ` +
          `Re-run with a narrower StartLine/EndLine range or use grep_search first to locate the relevant section.`,
      }
    }

    let fittedStartLine = candidateWindow.startLine
    let fittedEndLine = candidateWindow.endLine

    while (
      rangeTokens(fittedStartLine, fittedEndLine) >
      this.OFFICIAL_VIEW_FILE_MAX_RESULT_TOKENS
    ) {
      const canTrimStart = fittedStartLine < requiredStartLine
      const canTrimEnd = fittedEndLine > requiredEndLine
      if (!canTrimStart && !canTrimEnd) {
        break
      }

      if (canTrimStart && canTrimEnd) {
        const startCost =
          candidateLineCosts[fittedStartLine - candidateWindow.startLine] ?? 0
        const endCost =
          candidateLineCosts[fittedEndLine - candidateWindow.startLine] ?? 0
        if (startCost >= endCost) {
          fittedStartLine += 1
        } else {
          fittedEndLine -= 1
        }
        continue
      }

      if (canTrimStart) {
        fittedStartLine += 1
      } else {
        fittedEndLine -= 1
      }
    }

    if (
      rangeTokens(fittedStartLine, fittedEndLine) >
      this.OFFICIAL_VIEW_FILE_MAX_RESULT_TOKENS
    ) {
      return {
        startLine: fittedStartLine,
        endLine: fittedEndLine,
        validationErrorMessage:
          `view_file window ${fittedStartLine}-${fittedEndLine} is still too large to return safely. ` +
          `Re-run with a narrower StartLine/EndLine range or use grep_search first to locate the relevant section.`,
      }
    }

    return {
      startLine: fittedStartLine,
      endLine: fittedEndLine,
    }
  }

  private splitContentLinesForViewFile(content: string): string[] {
    if (content.length === 0) {
      return []
    }

    const lines = content.split(/\r?\n/)
    if (
      lines.length > 0 &&
      lines[lines.length - 1] === "" &&
      /\r?\n$/.test(content)
    ) {
      lines.pop()
    }
    return lines
  }

  private normalizeDeferredToolFamily(
    toolName: string
  ): DeferredToolFamily | undefined {
    const webFamily = this.normalizeInlineWebToolFamily(toolName)
    if (webFamily) return webFamily

    const legacyWebDocumentFamily =
      this.normalizeLegacyWebDocumentToolName(toolName)
    if (legacyWebDocumentFamily) return legacyWebDocumentFamily

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
        case "CLIENT_SIDE_TOOL_V2_TODO_READ":
          return "read_todos"
        case "CLIENT_SIDE_TOOL_V2_TODO_WRITE":
          return "update_todos"
        case "CLIENT_SIDE_TOOL_V2_CREATE_PLAN":
          return "create_plan"
        case "CLIENT_SIDE_TOOL_V2_SWITCH_MODE":
          return "switch_mode"
        case "CLIENT_SIDE_TOOL_V2_EXA_SEARCH":
          return "exa_search"
        case "CLIENT_SIDE_TOOL_V2_EXA_FETCH":
          return "exa_fetch"
        case "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS":
          return "get_mcp_tools"
        case "CLIENT_SIDE_TOOL_V2_SETUP_VM_ENVIRONMENT":
          return "setup_vm_environment"
        case "CLIENT_SIDE_TOOL_V2_TASK":
        case "CLIENT_SIDE_TOOL_V2_TASK_V2":
          return "task"
        case "CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP":
          return "background_composer_followup"
        case "CLIENT_SIDE_TOOL_V2_AWAIT_TASK":
          return "await_task"
        case "CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT":
          return "update_project"
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
        case "CLIENT_SIDE_TOOL_V2_AI_ATTRIBUTION":
          return "ai_attribution"
        case "CLIENT_SIDE_TOOL_V2_AWAIT":
          return "await"
        case "CLIENT_SIDE_TOOL_V2_MCP_AUTH":
          return "mcp_auth"
      }
    }

    const snake = toolName
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
    const compact = toolName.toLowerCase().replace(/[^a-z0-9]+/g, "")

    if (snake.includes("command_status") || compact.includes("commandstatus")) {
      return "command_status"
    }
    if (snake === "update_plan" || compact === "updateplan") {
      return "update_plan"
    }
    if (snake === "request_user_input" || compact === "requestuserinput") {
      return "request_user_input"
    }
    if (
      snake === "list_mcp_resource_templates" ||
      compact === "listmcpresourcetemplates"
    ) {
      return "list_mcp_resource_templates"
    }
    if (snake === "view_image" || compact === "viewimage") {
      return "view_image"
    }
    if (snake === "spawn_agent" || compact === "spawnagent") {
      return "spawn_agent"
    }
    if (snake === "send_input" || compact === "sendinput") {
      return "send_input"
    }
    if (snake === "resume_agent" || compact === "resumeagent") {
      return "resume_agent"
    }
    if (snake === "wait_agent" || compact === "waitagent") {
      return "wait_agent"
    }
    if (snake === "close_agent" || compact === "closeagent") {
      return "close_agent"
    }
    if (snake === "apply_patch" || compact === "applypatch") {
      return "apply_patch"
    }
    if (snake.includes("ask_question") || compact.includes("askquestion")) {
      return "ask_question"
    }
    if (snake.includes("read_todos") || compact.includes("readtodos")) {
      return "read_todos"
    }
    if (snake.includes("update_todos") || compact.includes("updatetodos")) {
      return "update_todos"
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
    if (snake.includes("get_mcp_tools") || compact.includes("getmcptools")) {
      return "get_mcp_tools"
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
      snake === "task" ||
      snake.includes("task_v2") ||
      snake.includes("task_tool_call") ||
      compact === "task" ||
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
    // wait_agent is the friendlier alias the dynamic task tool prompt
    // suggests for "wait until the background sub-agent finishes" — it
    // routes to exactly the same registry-aware await flow as
    // await_task. Keep this above the read_project arm so the path
    // pattern wait_*_agent doesn't accidentally catch project lookups.
    if (snake.includes("wait_agent") || compact.includes("waitagent")) {
      return "await_task"
    }
    if (snake.includes("kill_agent") || compact.includes("killagent")) {
      return "kill_agent"
    }
    if (snake.includes("read_project") || compact.includes("readproject")) {
      return "read_project"
    }
    if (snake.includes("update_project") || compact.includes("updateproject")) {
      return "update_project"
    }
    // 新增 proto 更新后的 Exec 工具模糊匹配
    if (
      snake.includes("force_background_shell") ||
      compact.includes("forcebackgroundshell")
    ) {
      return "force_background_shell"
    }
    if (
      snake.includes("force_background_subagent") ||
      compact.includes("forcebackgroundsubagent")
    ) {
      return "force_background_subagent"
    }
    if (snake.includes("mcp_state_exec") || compact.includes("mcpstateexec")) {
      return "mcp_state_exec"
    }
    if (snake.includes("subagent_await") || compact.includes("subagentawait")) {
      return "subagent_await"
    }
    // 新增交互工具模糊匹配
    if (
      snake.includes("communicate_update") ||
      compact.includes("communicateupdate")
    ) {
      return "communicate_update"
    }
    if (
      snake.includes("send_final_summary") ||
      compact.includes("sendfinalsummary")
    ) {
      return "send_final_summary"
    }
    if (
      snake.includes("blame_by_file_path") ||
      compact.includes("blamebyfilepath")
    ) {
      return "blame_by_file_path"
    }
    if (snake.includes("report_bug") || compact.includes("reportbug")) {
      // 避免与 report_bugfix_results 冲突
      if (!snake.includes("bugfix") && !compact.includes("bugfix")) {
        return "report_bug"
      }
    }
    if (
      snake.includes("set_active_branch") ||
      compact.includes("setactivebranch")
    ) {
      return "set_active_branch"
    }
    // ExecServerMessage 补齐模糊匹配
    if (
      snake.includes("request_context") ||
      compact.includes("requestcontext")
    ) {
      return "request_context"
    }
    if (snake.includes("redacted_read") || compact.includes("redactedread")) {
      return "redacted_read"
    }
    // InteractionQuery 补齐模糊匹配
    if (
      snake.includes("pr_management") ||
      compact.includes("prmanagement") ||
      snake.includes("create_pr") ||
      compact.includes("createpr")
    ) {
      return "pr_management"
    }
    return undefined
  }

  private normalizeBrowserMcpActionName(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
  }

  private resolveBrowserMcpToolAction(
    declaredToolName: string,
    rawToolName?: string,
    input?: Record<string, unknown>
  ): string | undefined {
    const candidates = [
      declaredToolName,
      rawToolName || "",
      typeof input?.name === "string" ? input.name : "",
      typeof input?.toolName === "string" ? input.toolName : "",
      typeof input?.tool_name === "string" ? input.tool_name : "",
    ]

    for (const candidate of candidates) {
      const normalized = candidate.trim().toLowerCase()
      if (!normalized) continue

      const compact = normalized.replace(/[^a-z0-9]+/g, "_")
      const browserPrefix = this.normalizeBrowserMcpActionName(
        BROWSER_MCP_TOOL_PREFIX
      )
      if (compact.startsWith(`${browserPrefix}_`)) {
        return this.normalizeBrowserMcpActionName(
          compact.slice(browserPrefix.length + 1)
        )
      }

      if (normalized.startsWith("browser_")) {
        return this.normalizeBrowserMcpActionName(
          normalized.slice("browser_".length)
        )
      }

      if (normalized.startsWith("browser-")) {
        return this.normalizeBrowserMcpActionName(
          normalized.slice("browser-".length)
        )
      }
    }

    return undefined
  }

  private getBrowserMcpArguments(
    input: Record<string, unknown>
  ): Record<string, unknown> {
    const args = input.arguments
    if (args && typeof args === "object" && !Array.isArray(args)) {
      return args as Record<string, unknown>
    }
    return input
  }

  private validateBrowserMcpDispatch(
    session: ChatSession,
    declaredToolName: string,
    input: Record<string, unknown>,
    rawToolName?: string
  ): string | undefined {
    const action = this.resolveBrowserMcpToolAction(
      declaredToolName,
      rawToolName,
      input
    )
    if (!action) return undefined

    if (
      BROWSER_CONTEXT_INITIALIZER_TOOL_NAMES.has(action) ||
      BROWSER_CONTEXT_FREE_TOOL_NAMES.has(action)
    ) {
      return undefined
    }

    const args = this.getBrowserMcpArguments(input)
    const explicitViewId =
      typeof args.viewId === "string" ? args.viewId.trim() : ""
    if (session.browserContext?.hasPage || explicitViewId) {
      return undefined
    }

    return (
      `Browser MCP 工具 "${declaredToolName}" 需要先存在 active browser page；` +
      `当前 session 还没有通过 cursor-ide-browser-browser_navigate 打开页面，` +
      `也没有通过 cursor-ide-browser-browser_tabs 创建/选择 tab。` +
      `请先调用 cursor-ide-browser-browser_navigate({ "url": "..." })，` +
      `再重试 "${declaredToolName}"。`
    )
  }

  private recordBrowserMcpDispatch(
    session: ChatSession,
    declaredToolName: string,
    input: Record<string, unknown>,
    rawToolName?: string
  ): void {
    const action = this.resolveBrowserMcpToolAction(
      declaredToolName,
      rawToolName,
      input
    )
    if (!action) return

    const args = this.getBrowserMcpArguments(input)
    const tabAction =
      typeof args.action === "string" ? args.action.trim().toLowerCase() : ""
    const explicitViewId =
      typeof args.viewId === "string" ? args.viewId.trim() : ""
    const opensPage =
      action === "navigate" ||
      explicitViewId.length > 0 ||
      (action === "tabs" && ["new", "select"].includes(tabAction))
    const hasPage = Boolean(session.browserContext?.hasPage || opensPage)

    if (!hasPage) return

    const nextUrl =
      typeof args.url === "string" && args.url.trim()
        ? args.url.trim()
        : session.browserContext?.lastUrl
    session.browserContext = {
      hasPage,
      lastToolName: declaredToolName,
      lastUrl: nextUrl,
      updatedAt: Date.now(),
    }
  }

  /**
   * 把模型/客户端给出的 MCP server 名归一化到 IDE 实际挂载的 providerIdentifier。
   *
   * 背景：
   *  - Cursor IDE 注册 user-defined MCP server 时会自动加 `user-` 前缀，
   *    所以 cursor-mcp 端的 server registry 用 `user-context7` 之类作为 key。
   *  - 模型 / 用户调用 list_mcp_resources / read_mcp_resource / mcp_tool 时
   *    经常只传短名（"context7"），bridge 直接转发会导致 IDE
   *    端 registry lookup miss、回报 `Server "context7" not found`，但实际
   *    通道是健康的。
   *  - bridge 一侧能拿到 IDE 真正用的 server registry key —— 它由
   *    `cursor-request-parser.ts::computeMcpIdeRegistryKey` 在
   *    `appendMcpToolDef` 入库时一次性算好，存到
   *    `McpToolDef.ideRegistryKey`。该字段同时承担"短名 → prefixed key"
   *    的去歧义责任：若 wire 上 `provider_identifier` 已是 prefixed 形式，
   *    `ideRegistryKey === providerIdentifier`，函数就退化成 identity；
   *    若是短名则补回 prefixed 段。
   *
   * 匹配策略（按优先级）：
   *  1. 完全相等：caller 已经传了 IDE 端期望的 server key
   *     （`ideRegistryKey` 优先，否则 `providerIdentifier`）
   *  2. 归一化字符串相等（去除非字母数字、忽略大小写）后再比一遍同样两个字段
   *  3. 都不命中则原样返回，让 IDE 给真实错误（合法的"server 真没挂"）
   *
   * 命中后总是返回 `ideRegistryKey`（IDE 端能识别）；当 `ideRegistryKey`
   * 为空时回退到 `providerIdentifier`。
   */
  private resolveMountedMcpServer(
    session: ChatSession,
    requestedServer: string
  ): string {
    const trimmed = (requestedServer || "").trim()
    if (!trimmed) return trimmed

    const defs = session.mcpToolDefs || []
    if (defs.length === 0) return trimmed

    // Each tool def contributes at most one candidate — the IDE
    // registry key (with `providerIdentifier` as a fallback when
    // `ideRegistryKey` is empty). Multiple defs from the same server
    // collapse to the same candidate, so we de-dupe by forward value.
    type Candidate = {
      /** Value forwarded to the IDE if this candidate matches. */
      forward: string
      /** Short alias kept for matching against caller input. */
      provider: string
    }
    const candidates: Candidate[] = []
    const seenForwards = new Set<string>()
    for (const def of defs) {
      const forward = (
        def?.ideRegistryKey ||
        def?.providerIdentifier ||
        ""
      ).trim()
      if (!forward || seenForwards.has(forward)) continue
      seenForwards.add(forward)
      candidates.push({
        forward,
        provider: (def?.providerIdentifier || "").trim() || forward,
      })
    }
    if (candidates.length === 0) return trimmed

    // Exact match: caller already typed the IDE registry key (or the
    // short alias when wire-level identifiers are already correct).
    for (const candidate of candidates) {
      if (candidate.forward === trimmed) return candidate.forward
      if (candidate.provider === trimmed) return candidate.forward
    }

    const normalizedRequested = normalizeMcpToolIdentifier(trimmed)
    if (!normalizedRequested) return trimmed

    for (const candidate of candidates) {
      const normalizedForward = normalizeMcpToolIdentifier(candidate.forward)
      const normalizedProvider = normalizeMcpToolIdentifier(candidate.provider)
      if (
        normalizedForward === normalizedRequested ||
        normalizedProvider === normalizedRequested
      ) {
        return candidate.forward
      }
    }

    // No match — let the IDE return the real "Server X not found" error
    // so the model can self-correct using the available-servers hint
    // (mirrors claude-code's ListMcpResourcesTool contract).
    return trimmed
  }

  /**
   * 对 mcp / list_mcp_resources / read_mcp_resource / get_mcp_tools 工具的
   * input 做 server alias 归一化。返回新 input（不改原对象）。
   *
   * 触达字段：`serverName` / `server` / `server_name` /
   * `providerIdentifier` / `provider_identifier`。任意一个被重写，其它字段
   * 也跟着同步，避免 IDE 端拿到不一致的几个 server 字段。
   */
  private normalizeMcpServerInInput(
    session: ChatSession,
    input: Record<string, unknown>
  ): Record<string, unknown> {
    const candidateKeys = [
      "serverName",
      "server",
      "server_name",
      "providerIdentifier",
      "provider_identifier",
    ] as const

    let requested = ""
    for (const key of candidateKeys) {
      const value = input[key]
      if (typeof value === "string" && value.trim().length > 0) {
        requested = value.trim()
        break
      }
    }
    if (!requested) return input

    const resolved = this.resolveMountedMcpServer(session, requested)
    if (!resolved || resolved === requested) return input

    const next: Record<string, unknown> = { ...input }
    for (const key of candidateKeys) {
      const current = next[key]
      if (typeof current === "string" && current.trim()) {
        next[key] = resolved
      }
    }
    this.logger.debug(
      `MCP server alias rewrite: "${requested}" -> "${resolved}" ` +
        `(matched against mounted providerIdentifier set)`
    )
    return next
  }

  /**
   * 判断 toolName 是否需要 MCP server 名归一化。
   *
   * 包含 cursor-tool-mapper 暴露的 user-facing 名 + protocol case 名 +
   * 内部 family 名（`mcp` / `mcp_tool` / `list_mcp_resources` /
   * `read_mcp_resource` / `get_mcp_tools`）。
   */
  private isMcpServerScopedTool(toolName: string): boolean {
    const normalized = (toolName || "").trim().toLowerCase()
    if (!normalized) return false
    return (
      normalized === "mcp" ||
      normalized === "mcp_tool" ||
      normalized === "list_mcp_resources" ||
      normalized === "read_mcp_resource" ||
      normalized === "get_mcp_tools" ||
      normalized === "client_side_tool_v2_mcp" ||
      normalized === "client_side_tool_v2_call_mcp_tool" ||
      normalized === "client_side_tool_v2_list_mcp_resources" ||
      normalized === "client_side_tool_v2_read_mcp_resource" ||
      normalized === "client_side_tool_v2_get_mcp_tools"
    )
  }

  private resolveExecDispatchTarget(
    session: ChatSession,
    toolName: string,
    input: Record<string, unknown>
  ): ExecDispatchResolution {
    const mcpToolDef = resolveMcpToolDefinition(session.mcpToolDefs, toolName)
    if (mcpToolDef) {
      try {
        const dispatchInput = buildMcpDispatchInput(input, mcpToolDef)
        const browserDispatchError = this.validateBrowserMcpDispatch(
          session,
          mcpToolDef.name,
          dispatchInput,
          mcpToolDef.toolName
        )
        if (browserDispatchError) {
          return { errorMessage: browserDispatchError }
        }
        this.recordBrowserMcpDispatch(
          session,
          mcpToolDef.name,
          dispatchInput,
          mcpToolDef.toolName
        )
        return {
          target: {
            toolName: "CLIENT_SIDE_TOOL_V2_MCP",
            input: dispatchInput,
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
    const readDispatchError = this.validateReadDispatchTarget(
      normalizedToolName,
      input
    )
    if (readDispatchError) {
      return {
        errorMessage: readDispatchError,
      }
    }

    const avoidableShellDispatchError = this.buildAvoidableShellDispatchError(
      session,
      normalizedToolName,
      input
    )
    if (avoidableShellDispatchError) {
      return {
        errorMessage: avoidableShellDispatchError,
      }
    }

    if (
      normalizedToolName === "mcp" ||
      normalizedToolName === "mcp_tool" ||
      normalizedToolName === "client_side_tool_v2_mcp" ||
      normalizedToolName === "client_side_tool_v2_call_mcp_tool"
    ) {
      try {
        const resolved = resolveMcpCallFieldsFromContract(input)

        // Validate the composed name against the session's registered
        // mcpToolDefs. composeMcpName uses providerIdentifier (e.g.
        // "context7") to build the name, but the IDE may register tools
        // with a different prefix (e.g. "user-context7-resolve-library-id").
        // When the composed name doesn't match any registered def, fall
        // back to the def registry to find the canonical name.
        let finalName = resolved.name
        let finalToolName = resolved.toolName
        let finalProvider = resolved.providerIdentifier
        const registeredDef = resolveMcpToolDefinition(
          session.mcpToolDefs,
          finalName
        )
        if (!registeredDef && session.mcpToolDefs?.length) {
          // composeMcpName produced a name the IDE doesn't recognize.
          // Try to find the correct def by matching providerIdentifier +
          // toolName against the registry.
          const correctedDef = session.mcpToolDefs.find((def) => {
            if (!def || typeof def.name !== "string") return false
            const defProvider = normalizeMcpToolIdentifier(
              def.providerIdentifier || ""
            )
            const defToolName = normalizeMcpToolIdentifier(def.toolName || "")
            const reqProvider = normalizeMcpToolIdentifier(finalProvider)
            const reqToolName = normalizeMcpToolIdentifier(finalToolName)
            // Match: provider contains requested (or vice versa) AND
            // toolName matches exactly
            return (
              defToolName === reqToolName &&
              (defProvider === reqProvider ||
                defProvider.includes(reqProvider) ||
                reqProvider.includes(defProvider))
            )
          })
          if (correctedDef) {
            finalName = correctedDef.name
            finalToolName = correctedDef.toolName || finalToolName
            finalProvider = correctedDef.providerIdentifier || finalProvider
            this.logger.debug(
              `MCP name correction: composeMcpName produced ` +
                `"${resolved.name}" but IDE registry has ` +
                `"${correctedDef.name}"; using registered name`
            )
          }
        }

        const dispatchInput: Record<string, unknown> = {
          ...input,
          name: finalName,
          toolName: finalToolName,
          providerIdentifier: finalProvider,
          arguments: resolved.rawArgs,
        }
        const browserDispatchError = this.validateBrowserMcpDispatch(
          session,
          finalName,
          dispatchInput,
          finalToolName
        )
        if (browserDispatchError) {
          return { errorMessage: browserDispatchError }
        }
        this.recordBrowserMcpDispatch(
          session,
          finalName,
          dispatchInput,
          finalToolName
        )
        return {
          target: {
            toolName: "CLIENT_SIDE_TOOL_V2_MCP",
            input: dispatchInput,
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
            const fallbackDispatchInput = buildMcpDispatchInput(
              input,
              fallbackMcpDef
            )
            const browserDispatchError = this.validateBrowserMcpDispatch(
              session,
              fallbackMcpDef.name,
              fallbackDispatchInput,
              fallbackMcpDef.toolName
            )
            if (browserDispatchError) {
              return { errorMessage: browserDispatchError }
            }
            this.recordBrowserMcpDispatch(
              session,
              fallbackMcpDef.name,
              fallbackDispatchInput,
              fallbackMcpDef.toolName
            )
            return {
              target: {
                toolName: "CLIENT_SIDE_TOOL_V2_MCP",
                input: fallbackDispatchInput,
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
      // Inline-only tools must not be encoded as ExecServerMessage. Return an
      // empty resolution so the deferred/inline tool path in
      // buildPreparedToolInvocation -> runDeferredToolIfNeeded can take over.
      // Returning an errorMessage here would short-circuit the deferred path
      // and surface a hard "exec hop is forbidden" failure to the caller, even
      // though the tool itself is perfectly callable through the inline
      // InteractionQuery / inline tool-result channel.
      return {}
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

  private validateReadDispatchTarget(
    normalizedToolName: string,
    input: Record<string, unknown>
  ): string | undefined {
    if (
      normalizedToolName !== "read_file" &&
      normalizedToolName !== "read_file_v2"
    ) {
      return undefined
    }

    const filePath =
      this.pickFirstString(input, [
        "path",
        "file_path",
        "filePath",
        "AbsolutePath",
      ]) || ""
    if (!filePath) {
      return undefined
    }

    let fileSize = 0
    try {
      const stats = statSync(filePath)
      if (!stats.isFile()) {
        return undefined
      }
      fileSize = stats.size
    } catch {
      return undefined
    }

    if (fileSize <= this.LARGE_READ_FILE_SIZE_BYTES) {
      return undefined
    }

    if (this.hasBoundedReadWindow(input)) {
      return undefined
    }

    return (
      `File is too large to read without a bounded line window ` +
      `(${fileSize} bytes > ${this.LARGE_READ_FILE_SIZE_BYTES} bytes). ` +
      `Re-run with start_line and end_line, or use grep_search first to locate the relevant section.`
    )
  }

  private hasBoundedReadWindow(input: Record<string, unknown>): boolean {
    const explicitLimit = this.pickFirstNumber(input, ["limit", "Limit"])
    if (explicitLimit != null && explicitLimit > 0) {
      return true
    }

    const startLine = this.pickFirstNumber(input, [
      "start_line",
      "startLine",
      "StartLine",
    ])
    const endLine = this.pickFirstNumber(input, [
      "end_line",
      "endLine",
      "EndLine",
    ])
    return (
      startLine != null &&
      endLine != null &&
      Number.isFinite(startLine) &&
      Number.isFinite(endLine) &&
      endLine >= startLine
    )
  }

  private serializeTodoItemForTool(
    todo: SessionTodoItem
  ): Record<string, unknown> {
    return {
      id: todo.id,
      content: todo.content,
      status: todo.status,
      createdAt: String(todo.createdAt),
      updatedAt: String(todo.updatedAt),
      dependencies: todo.dependencies,
    }
  }

  private serializeTodoItemForCreatePlan(
    todo: SessionTodoItem
  ): Record<string, unknown> {
    return {
      id: todo.id,
      content: todo.content,
      status: this.todoStatusToProtocolEnum(todo.status),
      createdAt: BigInt(todo.createdAt),
      updatedAt: BigInt(todo.updatedAt),
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
    return session.todos.map((todo) =>
      this.serializeTodoItemForCreatePlan(todo)
    )
  }

  /**
   * Parse phases from LLM tool input for CreatePlanRequestQuery.
   */
  private parsePhasesFromInput(
    input: Record<string, unknown>
  ): Array<{ name: string; todos: Array<Record<string, unknown>> }> {
    const rawPhases = input.phases
    if (!Array.isArray(rawPhases)) return []
    const nowTs = Date.now()
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
              .map((t, index) => {
                const createdAtRaw =
                  this.pickFirstNumber(t, ["createdAt", "created_at"]) ?? nowTs
                const updatedAtRaw =
                  this.pickFirstNumber(t, ["updatedAt", "updated_at"]) ?? nowTs
                return {
                  id:
                    this.pickFirstString(t, ["id", "todo_id", "todoId"]) ||
                    `phase_todo_${nowTs}_${index}`,
                  content:
                    this.pickFirstString(t, ["content", "text", "title"]) || "",
                  status: this.todoStatusToProtocolEnum(
                    this.normalizeTodoStatus(t.status)
                  ),
                  createdAt: BigInt(Math.floor(createdAtRaw)),
                  updatedAt: BigInt(Math.floor(updatedAtRaw)),
                  dependencies: Array.isArray(t.dependencies)
                    ? t.dependencies.filter(
                        (d): d is string => typeof d === "string"
                      )
                    : [],
                }
              })
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

  private normalizeRequestUserInputInteractionArgs(
    input: Record<string, unknown>,
    toolCallId: string
  ): {
    title: string
    questions: AskQuestionInteractionQuestion[]
    runAsync: boolean
    asyncOriginalToolCallId: string
  } {
    const rawQuestions = Array.isArray(input.questions) ? input.questions : []
    const questions: AskQuestionInteractionQuestion[] = []

    for (const [index, entry] of rawQuestions.entries()) {
      if (!entry || typeof entry !== "object") continue
      const question = entry as Record<string, unknown>
      const prompt =
        this.pickFirstString(question, [
          "question",
          "prompt",
          "header",
          "title",
        ]) || `Question ${index + 1}`
      const id =
        this.pickFirstString(question, ["id", "questionId", "question_id"]) ||
        `q${index + 1}`
      const rawOptions = Array.isArray(question.options) ? question.options : []
      const options: AskQuestionInteractionOption[] = []
      const seenOptionIds = new Set<string>()

      for (const [optionIndex, optionEntry] of rawOptions.entries()) {
        let optionId = ""
        let label = ""
        if (typeof optionEntry === "string") {
          label = optionEntry.trim()
        } else if (optionEntry && typeof optionEntry === "object") {
          const option = optionEntry as Record<string, unknown>
          optionId =
            this.pickFirstString(option, ["id", "optionId", "option_id"]) || ""
          label =
            this.pickFirstString(option, [
              "label",
              "title",
              "name",
              "value",
              "text",
              "description",
            ]) || ""
        }

        if (!label && !optionId) continue
        if (!optionId) {
          optionId = this.normalizeAskQuestionOptionId(
            label,
            `opt_${index + 1}_${optionIndex + 1}`
          )
        }
        if (!label) {
          label = optionId
        }
        if (seenOptionIds.has(optionId)) continue
        seenOptionIds.add(optionId)
        options.push({ id: optionId, label })
      }

      questions.push({
        id,
        prompt,
        options,
        allowMultiple: false,
      })
    }

    if (questions.length === 0) {
      return this.normalizeAskQuestionInteractionArgs(input, toolCallId)
    }

    return {
      title:
        this.pickFirstString(input, ["title", "prompt"]) ||
        questions[0]?.prompt ||
        "User input required",
      questions,
      runAsync: false,
      asyncOriginalToolCallId: toolCallId,
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
    // Remove non-content elements entirely
    let cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<header[\s\S]*?<\/header>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")

    // Convert block-level elements to newlines
    cleaned = cleaned
      .replace(
        /<\/(p|div|section|article|h[1-6]|li|tr|br|blockquote|pre|dd|dt)>/gi,
        "\n"
      )
      .replace(/<(br|hr)\s*\/?>/gi, "\n")

    // Convert headings to markdown-style
    cleaned = cleaned.replace(
      /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_match, level, text) => {
        const prefix = "#".repeat(Number(level))
        const cleanText = text.replace(/<[^>]+>/g, "").trim()
        return cleanText ? `\n${prefix} ${cleanText}\n` : "\n"
      }
    )

    // Convert links to markdown
    cleaned = cleaned.replace(
      /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_match, href, text) => {
        const cleanText = text.replace(/<[^>]+>/g, "").trim()
        if (
          !cleanText ||
          !href ||
          href.startsWith("#") ||
          href.startsWith("javascript:")
        ) {
          return cleanText
        }
        return `[${cleanText}](${href})`
      }
    )

    // Convert list items
    cleaned = cleaned.replace(/<li[^>]*>/gi, "- ")

    // Strip remaining tags
    cleaned = cleaned.replace(/<[^>]+>/g, " ")

    // Decode HTML entities
    cleaned = cleaned
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))

    // Normalize whitespace
    cleaned = cleaned
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()

    return cleaned
  }

  private extractHtmlTitle(html: string): string {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    if (!match?.[1]) return ""
    return match[1].replace(/\s+/g, " ").trim()
  }

  private async fetchUrlDocument(
    url: string,
    externalSignal?: AbortSignal
  ): Promise<{
    url: string
    contentType: string
    title: string
    content: string
  }> {
    // Compose the per-request timeout with any external abort signal
    // (e.g. the worker's `AbortController.signal` for a background
    // sub-agent). `AbortSignal.any` returns a signal that aborts as
    // soon as ANY input aborts, so a kill_agent fired mid-fetch
    // unwinds without having to wait for the full 20s timeout.
    const timeoutSignal = AbortSignal.timeout(20_000)
    const signal = externalSignal
      ? AbortSignal.any([timeoutSignal, externalSignal])
      : timeoutSignal

    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "protocol-bridge-web-fetch/1.0",
      },
      signal,
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

  private splitLegacyWebDocumentIntoChunks(content: string): string[] {
    const normalized = content.trim()
    if (!normalized) return [""]

    const chunkSize = Math.max(1, this.LEGACY_WEB_DOCUMENT_CHUNK_SIZE)
    const chunks: string[] = []
    for (let cursor = 0; cursor < normalized.length; cursor += chunkSize) {
      chunks.push(normalized.slice(cursor, cursor + chunkSize).trim())
    }

    return chunks.filter((chunk) => chunk.length > 0)
  }

  private storeLegacyWebDocument(
    conversationId: string,
    doc: {
      url: string
      title: string
      contentType: string
      content: string
    }
  ): LegacyWebDocument {
    const chunks = this.splitLegacyWebDocumentIntoChunks(doc.content)
    const storedDoc: LegacyWebDocument = {
      id: `doc_${crypto.randomUUID()}`,
      url: doc.url,
      title: doc.title,
      contentType: doc.contentType,
      chunks: chunks.length > 0 ? chunks : [""],
      createdAt: Date.now(),
    }

    let conversationDocs =
      this.legacyWebDocumentsByConversation.get(conversationId)
    if (!conversationDocs) {
      conversationDocs = new Map<string, LegacyWebDocument>()
      this.legacyWebDocumentsByConversation.set(
        conversationId,
        conversationDocs
      )
    }

    conversationDocs.set(storedDoc.id, storedDoc)
    while (
      conversationDocs.size > this.MAX_LEGACY_WEB_DOCUMENTS_PER_CONVERSATION
    ) {
      const oldestDocumentId = conversationDocs.keys().next().value
      if (!oldestDocumentId) break
      conversationDocs.delete(oldestDocumentId)
    }

    return storedDoc
  }

  private getLegacyWebDocument(
    conversationId: string,
    documentId: string
  ): LegacyWebDocument | undefined {
    return this.legacyWebDocumentsByConversation
      .get(conversationId)
      ?.get(documentId)
  }

  private async executeInlineReadUrlContent(
    conversationId: string,
    input: Record<string, unknown>,
    options?: { abortSignal?: AbortSignal }
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    const url = this.pickFirstString(input, ["url", "Url"]) || ""
    if (!url) {
      return {
        content: "[read_url_content error] Missing required Url parameter",
        state: { status: "error", message: "missing Url" },
      }
    }

    try {
      const doc = await this.fetchUrlDocument(url, options?.abortSignal)
      const storedDoc = this.storeLegacyWebDocument(conversationId, doc)
      const firstChunk = storedDoc.chunks[0] || "[empty document]"
      const totalChunks = storedDoc.chunks.length

      input.url = doc.url
      input.Url = doc.url
      input.document_id = storedDoc.id
      input.documentId = storedDoc.id
      input.chunk_count = totalChunks
      input.chunkCount = totalChunks

      const lines = [
        "[read_url_content success]",
        `DocumentId: ${storedDoc.id}`,
        `URL: ${doc.url}`,
        `Title: ${doc.title || "(unknown)"}`,
        `Content-Type: ${doc.contentType || "unknown"}`,
        `Chunk: 1/${totalChunks}`,
      ]

      if (totalChunks > 1) {
        lines.push(
          `Use view_content_chunk with document_id="${storedDoc.id}" and position=2..${totalChunks} to continue reading. Positions are 1-based; position=0 also returns the first chunk.`
        )
      }

      lines.push("", firstChunk)

      return {
        content: lines.join("\n"),
        state: { status: "success" },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: `[read_url_content error] ${message}`,
        state: { status: "error", message },
      }
    }
  }

  private executeInlineViewContentChunk(
    conversationId: string,
    input: Record<string, unknown>
  ): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const documentId =
      this.pickFirstString(input, ["document_id", "documentId"]) || ""
    if (!documentId) {
      return {
        content:
          "[view_content_chunk error] Missing required document_id parameter",
        state: { status: "error", message: "missing document_id" },
      }
    }

    const requestedPosition = this.pickFirstNumber(input, [
      "position",
      "chunk_position",
      "chunkPosition",
    ])
    if (requestedPosition === undefined) {
      return {
        content:
          "[view_content_chunk error] Missing required position parameter",
        state: { status: "error", message: "missing position" },
      }
    }

    if (this.toolResultStorage.isToolResultDocumentId(documentId)) {
      const storedToolRefs =
        this.sessionManager.getContextState(conversationId)
          ?.toolResultReplacementState?.storedByToolUseId
      const chunkResult = this.toolResultStorage.readChunk(
        conversationId,
        documentId,
        requestedPosition,
        storedToolRefs
      )
      if (chunkResult.status === "success") {
        const lines = [
          "[view_content_chunk success]",
          `DocumentId: ${chunkResult.reference.documentId}`,
          `Type: tool_result`,
          `Tool: ${chunkResult.reference.toolName}`,
          `Chunk: ${chunkResult.chunkNumber}/${chunkResult.chunkCount}`,
        ]
        if (chunkResult.nextPosition) {
          lines.push(`Next chunk position: ${chunkResult.nextPosition}`)
        }
        lines.push("", chunkResult.chunk || "[empty tool result chunk]")

        input.document_id = chunkResult.reference.documentId
        input.documentId = chunkResult.reference.documentId
        input.position = chunkResult.chunkNumber
        input.chunkIndex = chunkResult.chunkNumber - 1

        return {
          content: lines.join("\n"),
          state: { status: "success" },
        }
      }

      if (chunkResult.status === "position_out_of_range") {
        return {
          content:
            `[view_content_chunk error] position ${requestedPosition} is out of range. ` +
            `Available positions: 1-${chunkResult.chunkCount} (or 0 for the first chunk).`,
          state: { status: "error", message: "position out of range" },
        }
      }

      return {
        content:
          `[view_content_chunk error] Unknown DocumentId: ${documentId}. ` +
          "The stored tool result is missing or expired.",
        state: { status: "error", message: "unknown document_id" },
      }
    }

    const storedDoc = this.getLegacyWebDocument(conversationId, documentId)
    if (!storedDoc) {
      return {
        content:
          `[view_content_chunk error] Unknown DocumentId: ${documentId}. ` +
          "Call read_url_content first in the same conversation.",
        state: { status: "error", message: "unknown document_id" },
      }
    }

    const chunkIndex = requestedPosition <= 0 ? 0 : requestedPosition - 1
    if (chunkIndex < 0 || chunkIndex >= storedDoc.chunks.length) {
      return {
        content:
          `[view_content_chunk error] position ${requestedPosition} is out of range. ` +
          `Available positions: 1-${storedDoc.chunks.length} (or 0 for the first chunk).`,
        state: { status: "error", message: "position out of range" },
      }
    }

    const chunkNumber = chunkIndex + 1
    const lines = [
      "[view_content_chunk success]",
      `DocumentId: ${storedDoc.id}`,
      `URL: ${storedDoc.url}`,
      `Title: ${storedDoc.title || "(unknown)"}`,
      `Chunk: ${chunkNumber}/${storedDoc.chunks.length}`,
    ]
    if (chunkNumber < storedDoc.chunks.length) {
      lines.push(`Next chunk position: ${chunkNumber + 1}`)
    }
    lines.push("", storedDoc.chunks[chunkIndex] || "[empty document]")

    input.document_id = storedDoc.id
    input.documentId = storedDoc.id
    input.position = chunkNumber
    input.chunkIndex = chunkIndex

    return {
      content: lines.join("\n"),
      state: { status: "success" },
    }
  }

  private async executeInlineWebTool(
    conversationId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: { abortSignal?: AbortSignal }
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
    projection?: ParsedToolResult["inlineProjection"]
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

      // Resolve the active backend so the factory can pick the right
      // adapter. We deliberately re-resolve per call (rather than
      // caching on the session) — the model can change mid-conversation
      // and the factory is cheap.
      const session = this.sessionManager.getSession(conversationId)
      let backend: BackendType | undefined
      if (session?.model) {
        try {
          backend = this.modelRouter.resolveModel(session.model).backend
        } catch (error) {
          this.logger.debug(
            `[web_search] model router could not resolve backend for session ` +
              `${conversationId} model=${session.model}: ` +
              `${error instanceof Error ? error.message : String(error)}`
          )
        }
      }

      // Schema fields lifted from claude-code's WebSearchTool input
      // schema. The connect-stream input bag uses snake_case (Cursor
      // protocol convention); we accept either casing for forward
      // compatibility with future protocol updates.
      const toStringList = (value: unknown): string[] =>
        Array.isArray(value)
          ? value
              .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
              .filter((entry) => entry.length > 0)
          : []
      const allowedDomains = toStringList(
        input.allowed_domains ?? input.allowedDomains
      )
      const blockedDomains = toStringList(
        input.blocked_domains ?? input.blockedDomains
      )
      const numResults = this.pickFirstNumber(input, [
        "num_results",
        "numResults",
        "max_results",
        "maxResults",
      ])
      const livecrawlRaw = this.pickFirstString(input, [
        "livecrawl",
        "live_crawl",
      ])
      const livecrawl =
        livecrawlRaw === "preferred" || livecrawlRaw === "fallback"
          ? livecrawlRaw
          : undefined
      const searchTypeRaw = this.pickFirstString(input, [
        "search_type",
        "searchType",
      ])
      const searchType =
        searchTypeRaw === "auto" ||
        searchTypeRaw === "fast" ||
        searchTypeRaw === "deep"
          ? searchTypeRaw
          : undefined
      const contextMaxCharacters = this.pickFirstNumber(input, [
        "context_max_characters",
        "contextMaxCharacters",
      ])

      try {
        const response = await this.webSearchService.executeSearch(
          backend,
          normalizedQuery,
          {
            allowedDomains:
              allowedDomains.length > 0 ? allowedDomains : undefined,
            blockedDomains:
              blockedDomains.length > 0 ? blockedDomains : undefined,
            numResults: numResults && numResults > 0 ? numResults : undefined,
            livecrawl,
            searchType,
            contextMaxCharacters:
              contextMaxCharacters && contextMaxCharacters > 0
                ? contextMaxCharacters
                : undefined,
            domain: domain || undefined,
            conversationId,
            model: session?.model,
            abortSignal: options?.abortSignal,
          }
        )

        const headerLines = [`Search query: ${query}`]
        if (normalizedQuery !== query) {
          headerLines.push(`Normalized query: ${normalizedQuery}`)
        }
        if (domain) {
          headerLines.push(`Domain preference: ${domain}`)
        }
        headerLines.push(`Adapter: ${response.adapter}`)

        const linkLines: string[] = []
        for (const result of response.results) {
          const title = result.title || result.url
          let line = `- [${title}](${result.url})`
          const snippet = result.chunk || result.snippet
          if (snippet) {
            const trimmedSnippet = snippet
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 280)
            if (trimmedSnippet) {
              line += `: ${trimmedSnippet}`
            }
          }
          linkLines.push(line)
        }

        const content =
          headerLines.join("\n") +
          "\n\nLinks:\n" +
          linkLines.join("\n") +
          "\n\nREMINDER: cite the URLs above using markdown hyperlinks when " +
          "you use this information in your reply."

        return {
          content,
          state: { status: "success" },
          projection: {
            webSearchResult: {
              query: normalizedQuery,
              references: response.results.map((r) => ({
                title: r.title || r.url,
                url: r.url,
                chunk: r.chunk || r.snippet || "",
              })),
            },
          },
        }
      } catch (error) {
        // Caller-side aborts surface as WebSearchAbortError; treat them
        // as a "rejected" tool result so connect-stream short-circuits
        // the in-flight tool call without emitting a "search failed"
        // banner that the model would then have to interpret.
        if (error instanceof WebSearchEmptyResultError) {
          this.logger.warn(
            `[web_search] ${error.adapter} returned no results for ` +
              `query "${error.query.slice(0, 80)}"; returning empty success`
          )
          return {
            content:
              `Search query: ${normalizedQuery}\n` +
              `Adapter: ${error.adapter}\n\n` +
              "No search results were found. Try a broader query, another " +
              "search adapter, or fetch a known URL directly with web_fetch.",
            state: { status: "success" },
            projection: {
              webSearchResult: {
                query: normalizedQuery,
                references: [],
              },
            },
          }
        }
        if (error instanceof WebSearchAbortError) {
          return {
            content: "[web_search aborted]",
            state: { status: "rejected", message: "aborted" },
          }
        }
        const message = error instanceof Error ? error.message : String(error)
        this.logger.warn(
          `[web_search] tool call failed: ${message.slice(0, 240)}`
        )
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
      const doc = await this.fetchUrlDocument(url, options?.abortSignal)
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
        projection: {
          webFetchResult: {
            url: doc.url,
            title: doc.title,
            contentType: doc.contentType,
            markdown: contentBody,
          },
        },
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
    input: Record<string, unknown>,
    _options?: { abortSignal?: AbortSignal }
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
      const searchResult = await this.googleService.executeWebSearch(query)
      const maxChars = 18_000
      const summary =
        searchResult.text.length > maxChars
          ? `${searchResult.text.slice(0, maxChars)}\n\n...[truncated]`
          : searchResult.text
      const references =
        searchResult.references.length > 0
          ? searchResult.references.map((ref) => ({
              title: ref.title || ref.url,
              url: ref.url,
              text: ref.chunk || "",
              publishedDate: "",
            }))
          : this.extractReferencesFromText(summary, query)
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

  private async executeInlineExaFetch(
    input: Record<string, unknown>,
    options?: { abortSignal?: AbortSignal }
  ): Promise<{
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
      if (options?.abortSignal?.aborted) {
        chunks.push(`ID: ${id}\n[aborted] kill signal received mid-batch`)
        break
      }
      if (!/^https?:\/\//i.test(id)) {
        chunks.push(`ID: ${id}\n[skip] non-http id is not fetchable in proxy`)
        continue
      }

      try {
        const doc = await this.fetchUrlDocument(id, options?.abortSignal)
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

  private async executeInlineFetch(
    input: Record<string, unknown>,
    options?: { abortSignal?: AbortSignal }
  ): Promise<{
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
        signal: options?.abortSignal
          ? AbortSignal.any([AbortSignal.timeout(20_000), options.abortSignal])
          : AbortSignal.timeout(20_000),
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
    input.status_filter = statusFilter
    input.statusFilter = statusFilter
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

  /**
   * After an inline todo_write, emit a createPlanRequestQuery so that
   * Cursor IDE renders the TODO panel.  This bridges the gap between
   * agent-vibes' inline execution model and Cursor's expectation that
   * update_todos is a client-side tool whose UI side-effects happen
   * locally.
   */
  private *emitCreatePlanQueryForTodoWrite(
    conversationId: string,
    toolCallId: string,
    input: Record<string, unknown>
  ): Generator<Buffer> {
    const todos = this.sessionTodosToCreatePlanTodos(conversationId)
    if (!todos || todos.length === 0) {
      return
    }

    // Keep the plan body brief and non-duplicative. The actual checklist
    // belongs in `todos`, which Cursor renders in the lower section.
    const plan =
      this.pickFirstString(input, ["plan", "overview", "description"]) ||
      this.pickFirstString(input, ["title", "name"]) ||
      "Task Plan"

    const { id: interactionQueryId } =
      this.sessionManager.registerInteractionQuery(
        conversationId,
        "deferred_tool",
        {
          kind: "deferred_tool",
          family: "create_plan",
          toolCallId,
          toolName: "create_plan",
          toolInput: input,
        }
      )

    this.logger.debug(
      `Emitting createPlanRequestQuery after todo_write (${todos.length} todos, queryId=${interactionQueryId})`
    )

    yield this.grpcService.createInteractionQueryResponse(
      interactionQueryId,
      "createPlanRequestQuery",
      {
        args: {
          plan,
          todos,
          overview: "",
          name:
            this.pickFirstString(input, ["title", "name", "plan"]) ||
            "Task Plan",
          isProject: false,
          phases: this.parsePhasesFromInput(input),
        },
        toolCallId,
      }
    )
  }

  // ────────────────────────────────────────────────────────────────────
  // SUB-AGENT (task) – event-driven state machine
  // ────────────────────────────────────────────────────────────────────

  /**
   * Resolve which model the sub-agent should run on, applying the same
   * precedence claude-code uses:
   *
   *   1. agent.model === "inherit" → use the parent session model
   *   2. agent.model is a specific model id → use that
   *   3. agent.model undefined → use the parent session model (matches
   *      claude-code's getDefaultSubagentModel fallback for built-ins)
   *
   * Special-cases the bridge's "gemini-2.5-flash" fallback only when the
   * parent session itself has no model recorded.
   */
  private resolveSubAgentModel(
    agent: SubagentDefinition,
    session: ChatSession
  ): string {
    const parentModel = session.model || "gemini-2.5-flash"
    if (!agent.model || agent.model === "inherit") return parentModel
    return agent.model
  }

  /**
   * Map an Exec-dispatchable user-facing tool name to the
   * `toolFamilyHint` field on PendingToolCall. Mirrors the cases in
   * cursor-grpc.service.ts::detectToolFamily but only for the families
   * the bridge actually allow-lists for sub-agent dispatch.
   *
   * Returning undefined is fine — the hint is a hint, not a contract;
   * handleToolResult derives the real family from `toolName` when the
   * hint is missing.
   */
  /**
   * Map an Exec-dispatchable user-facing tool name to the
   * `toolFamilyHint` field on PendingToolCall. Mirrors the cases in
   * cursor-grpc.service.ts::detectToolFamily but only for the families
   * the bridge actually allow-lists for sub-agent dispatch.
   *
   * Pass `session` when the resolution should also recognize MCP tools
   * by walking `session.mcpToolDefs`. Without that argument, MCP tool
   * names whose normalized form does not literally contain "mcp"
   * (e.g. third-party MCP tools like `user-context7-resolve-library-id`
   * or `cursor-ide-browser-browser_navigate`) fall through to
   * `undefined` and downstream `detectToolFamily` projects them as
   * `truncatedToolCall` → the IDE renders `[Tool: truncatedToolCall]`
   * fallback labels in the assistant text stream. The session-aware
   * branch fixes that by checking the session's MCP tool registry.
   *
   * Returning undefined is fine — the hint is a hint, not a contract;
   * handleToolResult derives the real family from `toolName` when the
   * hint is missing.
   */
  private classifyExecToolFamilyHint(
    toolName: string,
    session?: ChatSession
  ): "mcp" | "web_fetch" | undefined {
    if (
      session &&
      resolveMcpToolDefinition(session.mcpToolDefs, toolName) !== undefined
    ) {
      return "mcp"
    }
    const normalized = toolName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
    if (normalized.includes("mcp")) return "mcp"
    if (normalized.includes("webfetch")) return "web_fetch"
    return undefined
  }

  /**
   * Format an ExecClientMessage payload returned to a sub-agent into
   * the human-readable text that goes into the sub-agent's tool_result
   * message. Re-uses the parent agent's formatToolResult by building a
   * minimal ParsedToolResult shim so all the existing per-case
   * formatters (shell / read / grep / ls / write / delete / diagnostics)
   * apply unchanged.
   */
  private formatSubAgentExecResultAsText(
    toolName: string,
    execResult: SubagentExecResult
  ): string {
    // Streamed shellStream path: synthesise a human-readable shell
    // result block from the buffered stdout/stderr/exitCode rather
    // than running the parsed-result formatter (which expects a real
    // proto-encoded payload). This keeps the formatting consistent
    // with formatShellResultAsText for the synchronous path so the
    // sub-agent's LLM sees the same shape no matter which path the
    // IDE chose.
    if (
      execResult.resultCase === "shellResult" &&
      execResult.resultData === undefined &&
      (execResult.streamedStdout !== undefined ||
        execResult.streamedStderr !== undefined ||
        execResult.streamedExitCode !== undefined ||
        execResult.streamedStatus !== undefined)
    ) {
      const parts: string[] = []
      const status = execResult.streamedStatus || "success"
      const code = execResult.streamedExitCode ?? 0
      parts.push(`[shell ${status}] exit_code=${code}`)
      const stdout = execResult.streamedStdout || ""
      if (stdout.length > 0) {
        parts.push(`--- stdout ---`)
        parts.push(stdout.trimEnd())
      }
      const stderr = execResult.streamedStderr || ""
      if (stderr.length > 0) {
        parts.push(`--- stderr ---`)
        parts.push(stderr.trimEnd())
      }
      if (stdout.length === 0 && stderr.length === 0) {
        parts.push("(no output)")
      }
      return parts.join("\n")
    }

    if (execResult.resultData === undefined) {
      this.logger.warn(
        `[SubAgent] formatSubAgentExecResultAsText got result without ` +
          `resultData and not a streamed shell result: ` +
          `tool=${toolName}, case=${execResult.resultCase}`
      )
      return `[tool result for ${toolName}: ${execResult.resultCase}]`
    }
    const synthetic: ParsedToolResult = {
      toolCallId: "",
      toolType: 0,
      resultCase: execResult.resultCase,
      resultData: execResult.resultData,
    }
    try {
      return this.formatToolResult(synthetic)
    } catch (error) {
      this.logger.warn(
        `[SubAgent] Failed to format exec result for ${toolName}: ${String(error)}`
      )
      return `[tool result for ${toolName}: ${execResult.resultCase}]`
    }
  }

  /**
   * Build the SubagentDefinitions array passed to buildToolsForApi so the
   * top-level agent's `task` tool description enumerates available
   * sub-agents (mirrors claude-code's getPrompt(agentDefinitions)).
   *
   * Returns undefined when the registry has no sub-agents available, so
   * the static description is preserved instead of generating a misleading
   * "no sub-agents" listing.
   */
  private buildSubagentDefinitionsForToolPrompt(
    session: ChatSession
  ): NonNullable<
    Parameters<typeof buildToolsForApi>[1]
  >["subagentDefinitions"] {
    const projectCwd = session.projectContext?.rootPath || process.cwd()
    const subagents = this.subagentRegistry.getAll(projectCwd)
    if (subagents.length === 0) return undefined
    return subagents.map((agent) => {
      const surface = resolveSubagentToolSurface(agent)
      return {
        agentType: agent.agentType,
        whenToUse: agent.whenToUse,
        toolNames: surface.toolNames,
      }
    })
  }

  /**
   * Execute a sub-agent for the "task" tool.
   *
   * Honours `subagent_type` from the model — looks up the matching
   * SubagentDefinition (built-in or `.cursor/agents/*.md` custom), uses
   * its `getSystemPrompt()` / `systemPrompt` body as the sub-agent's
   * system message, and resolves its tool surface via the same
   * resolveSubagentToolSurface() the parent agent's `task` tool prompt
   * uses. This mirrors claude-code's runAgent() + resolveAgentTools()
   * design where every sub-agent gets exactly the prompt + tools its
   * definition declared, instead of the legacy hard-coded inline list.
   *
   * Runs LLM turns in a loop, dispatches tool calls inline, and yields
   * protocol buffers throughout. All sub-agent-produced events are
   * mirrored to the parent task bubble through taskToolCallDelta so the
   * IDE renders them in real time inside the parent's task tool card.
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

    // claude-code TaskCreateTool field semantics:
    //   - `prompt`  : the actual brief the sub-agent should act on.
    //   - `description` : 3-5 word UI label shown in the parent task
    //     bubble while the sub-agent runs.
    // We prefer `prompt` so the sub-agent receives the real task body.
    // `description` and the legacy `task` alias are fallbacks for older
    // callers that only set the UI label.
    const description =
      this.pickFirstString(input, ["prompt", "task", "description"]) || ""
    if (!description) {
      yield* this.emitInlineToolResult(
        conversationId,
        parentToolCallId,
        "[task error] Missing required prompt (or fallback description)",
        { status: "error", message: "missing prompt" }
      )
      return
    }

    // Resolve the requested sub-agent definition. The model passes
    // `subagent_type` to pick a specific agent. Unknown / missing types
    // fall back to general-purpose, matching claude-code's behaviour.
    const requestedAgentType =
      this.pickFirstString(input, ["subagent_type", "subagentType", "type"]) ||
      ""
    const projectCwd = session.projectContext?.rootPath || process.cwd()
    const allSubagents = this.subagentRegistry.getAll(projectCwd)
    const agentDefinition: SubagentDefinition | undefined = requestedAgentType
      ? this.subagentRegistry.findByType(requestedAgentType, projectCwd)
      : undefined
    const effectiveAgent: SubagentDefinition =
      agentDefinition ||
      allSubagents.find((agent) => agent.agentType === "general-purpose") ||
      allSubagents[0]!
    if (!agentDefinition && requestedAgentType) {
      this.logger.warn(
        `[SubAgent] Unknown subagent_type '${requestedAgentType}'; falling back to '${effectiveAgent.agentType}'.`
      )
    }

    // Resolve the agent's effective tool surface. This is the single
    // source of truth — both the dynamic `task` tool description (so the
    // parent model picks the right agentType) and the sub-agent's actual
    // LLM turn use this same resolver, preventing drift.
    const surface = resolveSubagentToolSurface(effectiveAgent)
    if (surface.ignoredAllowlistEntries.length > 0) {
      this.logger.warn(
        `[SubAgent] '${effectiveAgent.agentType}' frontmatter declared ` +
          `tools that aren't sub-agent-safe: ` +
          `${surface.ignoredAllowlistEntries.join(", ")}; ignored.`
      )
    }
    const subAgentTools = buildToolsForApi(surface.toolNames, {
      mcpToolDefs: session.mcpToolDefs,
      backend: this.modelRouter.resolveModel(
        this.resolveSubAgentModel(effectiveAgent, session)
      ).backend,
      forSubAgent: true,
    })

    // Create sub-agent context
    const subagentId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const parentPendingToolCall = session.pendingToolCalls.get(parentToolCallId)
    const parentTaskModelCallId = parentPendingToolCall?.modelCallId || ""

    const allowedWorkspaceRoots =
      this.sessionManager.listAllowedWorkspaceRoots(conversationId)
    const primaryRoot = this.resolveWorkspaceRoot(conversationId)
    const workingDirectoriesPrompt =
      this.formatAdditionalWorkingDirectoriesPrompt(
        allowedWorkspaceRoots,
        primaryRoot
      )
    const systemPrompt = `${getSubagentSystemPrompt(effectiveAgent)}${workingDirectoriesPrompt}`
    const subAgentModel = this.resolveSubAgentModel(effectiveAgent, session)

    const ctx: SubAgentContext = {
      subagentId,
      parentToolCallId,
      parentModelCallId: parentTaskModelCallId,
      messages: [
        // System prompt slot. The bridge LLM router treats the first
        // message with role 'user' that begins with `system:` as a system
        // prompt for backends that don't have a dedicated system field;
        // for backends that do (Anthropic, Codex), the upstream DTO
        // builder unwraps it. The agent definition's prompt becomes the
        // system message verbatim — claude-code does the same.
        {
          role: "user" as const,
          content: `${systemPrompt}\n\n--- TASK ---\n\n${description}`,
        },
      ],
      model: subAgentModel,
      tools: subAgentTools,
      accumulatedText: "",
      pendingToolCallIds: new Set(),
      startTime: Date.now(),
      turnCount: 0,
      toolCallCount: 0,
      modifiedFiles: [],
      currentTurnToolCalls: [],
      pendingToolResults: new Map(),
      expectedToolCallIds: new Set(),
      conversationSteps: [],
      allowedWorkspaceRoots,
    }

    this.sessionManager.setSubAgentContext(conversationId, ctx)
    this.logger.log(
      `[SubAgent] Created ${subagentId} (agentType=${effectiveAgent.agentType}, ` +
        `source=${effectiveAgent.source}, tools=${surface.toolNames.length}, ` +
        `model=${subAgentModel}) for parent tool call ${parentToolCallId}`
    )

    // Helper: wrap an inner sub-agent InteractionUpdate as a
    // ToolCallDeltaUpdate(taskToolCallDelta) anchored to the parent task
    // tool call. This is the official protocol channel that lets the
    // IDE render sub-agent activity inside the parent task bubble in real
    // time instead of waiting for the final inline_tool_result.
    const yieldSubAgentUpdate = (
      innerUpdate: ReturnType<
        typeof this.grpcService.buildInnerTextDeltaInteractionUpdate
      >
    ): Buffer =>
      this.grpcService.wrapAsTaskToolCallDelta(
        parentToolCallId,
        parentTaskModelCallId,
        innerUpdate
      )

    // Per-agent maxTurns honours the frontmatter override
    // (`maxTurns: <int>`) the same way claude-code's loadAgentsDir does;
    // 20 is the bridge default carried over from the previous fixed cap.
    const MAX_TURNS = effectiveAgent.maxTurns ?? 20

    // ── Main LLM turn loop ──
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      ctx.turnCount++
      this.logger.log(
        `[SubAgent] ${subagentId} turn ${ctx.turnCount}/${MAX_TURNS}`
      )

      // Keep the outer BiDi stream alive while this sub-agent turn is in
      // flight. The sub-agent consumes its inner LLM stream silently
      // (events accumulate into ctx.messages, no buffers are yielded out
      // until tool dispatch / completion), so without an explicit beat
      // the IDE NAL stall detector aborts the parent BiDi stream after
      // ~60s with a misleading "proxy restarted" error. One beat per
      // turn boundary covers the gap between LLM stream end and the
      // tool dispatch loop starting on the next iteration.
      yield this.grpcService.createHeartbeatResponse()

      const buildSubAgentDtoForRoute = (
        streamRoute: ModelRouteResult,
        hints?: BackendStreamHints
      ): CreateMessageDto =>
        this.buildSubAgentStreamingDtoForRoute(
          session,
          ctx,
          conversationId,
          streamRoute,
          hints
        )

      const buildSubAgentCodexRequestForRoute = (
        streamRoute: ModelRouteResult,
        hints?: BackendStreamHints
      ): CodexExecutionRequest => {
        // Mirror the Anthropic DTO path: a sub-agent on the Codex
        // backend MUST receive the same tool definitions and system
        // addendum, otherwise GPT-routed sub-agents come back with
        // `tool calls: 0` and answer "no tools are available".
        const { toolDefinitions, systemAddendum } =
          this.resolveSubAgentToolSurface(ctx.tools, false)
        return this.buildCodexStreamingRequestForRoute(streamRoute, {
          model: ctx.model,
          promptContext: this.buildPromptContextFromSession(session),
          conversationId,
          session,
          thinkingLevel: session.thinkingLevel,
          thinkingDetailsRequested: session.thinkingDetailsRequested,
          budgetOverride: hints?.budgetOverride,
          toolDefinitions,
          additionalSystemPrompt: systemAddendum,
          buildMessages: (budget) => {
            const compacted = this.contextRequestPlanner.projectMessages(
              ctx.messages.map((message) => ({
                role: message.role,
                content: message.content as UnifiedMessage["content"],
              })) as UnifiedMessage[],
              this.EMPTY_CONTEXT_ATTACHMENT_SNAPSHOT,
              budget,
              { strategy: "auto" }
            )
            this.resetCodexContinuationAfterProjectionRewrite(
              streamRoute.backend,
              conversationId,
              streamRoute.model,
              compacted,
              `sub-agent: ${conversationId}:${ctx.subagentId}`
            )

            return compacted.messages as CodexExecutionRequest["messages"]
          },
        })
      }

      const route = this.modelRouter.resolveModel(ctx.model)
      const streamModel = route.model

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
        const stream = this.getBackendStream(streamModel, {
          buildDtoForRoute: buildSubAgentDtoForRoute,
          buildCodexRequestForRoute: buildSubAgentCodexRequestForRoute,
          recoveryKey: `cursor:subagent:${conversationId}:${subagentId}`,
        })

        // Wrap the inner LLM stream in streamWithHeartbeat so quiet
        // backend stretches (Kiro / Codex / Google can pause 30s+
        // before the first token on long prompts) still produce
        // outbound heartbeats on the parent BiDi stream.
        const heartbeatStream = this.streamWithHeartbeat(stream)
        for await (const item of heartbeatStream) {
          if (item.type === "heartbeat") {
            yield this.grpcService.createHeartbeatResponse()
            continue
          }

          const event = this.parseSseEvent(item.value)
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
              // Mirror sub-agent assistant text to the IDE in real time
              // through the parent task tool call's ToolCallDeltaUpdate
              // envelope so the parent task bubble streams sub-agent
              // output instead of staying silent until completion.
              yield yieldSubAgentUpdate(
                this.grpcService.buildInnerTextDeltaInteractionUpdate(
                  delta.text
                )
              )
            } else if (delta?.type === "thinking_delta" && delta.thinking) {
              // Mirror sub-agent thinking deltas through the same channel
              // so the IDE renders them in the dedicated thinking section
              // of the parent task bubble.
              yield yieldSubAgentUpdate(
                this.grpcService.buildInnerThinkingDeltaInteractionUpdate(
                  delta.thinking,
                  ctx.model
                )
              )
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
          ctx.subagentId,
          `[sub-agent error] ${String(error)}`
        )
        return
      }

      ctx.accumulatedText = fullText

      // Build assistant message for history
      const assistantContentParts: Array<Record<string, unknown>> = []
      if (fullText) {
        assistantContentParts.push({ type: "text", text: fullText })
        // ConversationStep accumulation: push the assistant text so the
        // parent task bubble's expandable detail panel can render this
        // turn's reply.
        ctx.conversationSteps.push(
          this.grpcService.buildAssistantConversationStep(fullText)
        )
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
        yield* this.completeSubAgent(conversationId, ctx.subagentId, fullText)
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

        // Beat between tools so individual long deferred tools
        // (web_fetch / deep_search / read_semsearch_files / fetch) cannot
        // collectively starve the parent BiDi stream past the IDE NAL
        // stall window even when they each finish under that window.
        yield this.grpcService.createHeartbeatResponse()

        // Resolve the proto family hint once per inner tool so
        // every downstream envelope (started, completed,
        // ConversationStep) projects to the right ToolCall oneof case.
        // Passing `session` makes MCP tool resolution use the session's
        // mcpToolDefs registry so third-party MCP tool names (which do
        // NOT literally contain "mcp" — `user-context7-resolve-library-id`,
        // `cursor-ide-browser-browser_navigate`, ...) still get the
        // "mcp" hint instead of falling through to truncatedToolCall.
        const innerToolFamilyHint = this.classifyExecToolFamilyHint(
          tc.name,
          session
        )

        // Mirror the sub-agent's tool lifecycle (started -> completed)
        // to the IDE through the parent task tool call's taskToolCallDelta
        // channel. The IDE renders these as nested tool-call bubbles
        // inside the parent task bubble so the user can see exactly which
        // tool the sub-agent is using right now, with the same UX as the
        // top-level agent's own tool calls.
        //
        // IMPORTANT: do NOT pass our internal `classifyDeferredToolFamily`
        // result here. That classifier returns the bridge's *deferred*
        // family namespace (e.g. "file_search", "semantic_search",
        // "read_semsearch_files") which the grpc-service `familyToCase`
        // map does not understand — those names fall through to the
        // truncatedToolCall placeholder and the IDE renders them as
        // `[Tool: truncatedToolCall]`. We pass the dedicated MCP /
        // web_fetch hint computed above for tools that detectToolFamily
        // cannot recognize from the name alone, and let grpc-service
        // derive the family itself for everything else (`glob_search` ->
        // "glob", `semantic_search` -> "sem_search", etc.).
        yield yieldSubAgentUpdate(
          this.grpcService.buildInnerToolCallStartedInteractionUpdate(
            tc.id,
            tc.name,
            parsedInput,
            innerToolFamilyHint,
            ctx.subagentId
          )
        )

        // Dispatch sub-agent tool calls along one of four paths:
        //   1. Bridge-local read-only tools — grep/read/list are executed
        //      inside the bridge. Cursor renders nested sub-agent tool UI
        //      through taskToolCallDelta, but the matching ExecClientMessage
        //      is not guaranteed to return through the parent stream.
        //   2. ExecServerMessage round-trip — when the tool name maps to
        //      an Exec-dispatchable family (run_terminal_command,
        //      edit_file_v2, delete_file, ...).
        //   3. Inline deferred — for tools that can be serviced entirely
        //      inside the bridge (web search/fetch, semantic search,
        //      todo/plan, MCP, reflect, ...).
        //   4. Hard error — tool is in neither category. Tell the model
        //      what is available so it stops looping on a non-existent
        //      tool.
        const family = this.classifyDeferredToolFamily(tc.name)
        const isExecDispatchable =
          !family && this.grpcService.isExecDispatchableTool(tc.name)
        let toolResultContent: string
        let toolResultStatus: "success" | "error" = "success"
        let toolCompletedExtraData: ToolCompletedExtraData | undefined
        const bridgeInlineResult = await this.executeSubAgentBridgeInlineTool(
          conversationId,
          tc.name,
          parsedInput,
          ctx.allowedWorkspaceRoots
        )
        if (bridgeInlineResult) {
          this.logger.log(
            `[SubAgent] Bridge-inline tool: ${tc.name} (${tc.id})`
          )
          toolResultContent = bridgeInlineResult.content
          if (bridgeInlineResult.state.status === "error") {
            toolResultStatus = "error"
          }
          toolCompletedExtraData = bridgeInlineResult.extraData
          toolResults.push({
            type: "tool_result",
            tool_use_id: tc.id,
            content: toolResultContent,
          })
        } else if (isExecDispatchable) {
          this.logger.log(
            `[SubAgent] Exec-dispatch tool: ${tc.name} (${tc.id})`
          )
          // Register pending tool call BEFORE yielding so handleToolResult
          // can resolve it when the IDE replies. The `subagentOwner`
          // field is what tells handleToolResult to bypass the parent
          // continuation pipeline.
          this.sessionManager.addPendingToolCall(
            conversationId,
            tc.id,
            tc.name,
            parsedInput,
            innerToolFamilyHint,
            ctx.subagentId,
            undefined,
            undefined,
            undefined,
            ctx.subagentId
          )
          const execIdNumber = this.sessionManager.nextExecId(conversationId)
          this.sessionManager.registerPendingToolExecId(
            conversationId,
            tc.id,
            execIdNumber
          )
          const waitPromise = this.subagentExecBridge.awaitResult(
            conversationId,
            ctx.subagentId,
            tc.id
          )
          try {
            // Yield the ExecServerMessage on the parent BiDi stream so the
            // IDE actually executes the tool. We use the same encoder the
            // top-level agent uses — sub-agent and parent share the same
            // proto envelope shape.
            //
            // For run_terminal_command specifically: force the IDE into
            // the synchronous shellArgs path (single shellResult) rather
            // than the default streaming shellStreamArgs path (multiple
            // shellStream chunks then a shellResult). Empirically, the
            // IDE side does NOT execute shellStreamArgs envelopes for
            // sub-agent-owned tool calls — the `Mapped execId=...` log
            // shows on dispatch, but no ExecClientMessage of any kind
            // ever returns. Other Exec-dispatchable tools (grep_search,
            // read_file, etc.) work normally for sub-agents because
            // their envelopes are non-streaming. shellArgs IS supported
            // for sub-agents and yields a single shellResult that flows
            // back through SubagentExecBridge.deliverResult. The bridge
            // ALSO has stream-aware support
            // (deliverShellStreamChunk) for defensive completeness, in
            // case future IDE builds enable streaming shell for
            // sub-agents — but the dispatch path keeps the synchronous
            // hint so we never depend on that capability here.
            const subAgentToolInput =
              tc.name === "run_terminal_command" ||
              tc.name === "run_terminal_command_v2"
                ? { ...parsedInput, synchronous: true }
                : innerToolFamilyHint === "mcp"
                  ? this.correctMcpToolInputName(session, parsedInput)
                  : parsedInput
            yield this.grpcService.createAgentToolCallResponse(
              tc.name,
              tc.id,
              subAgentToolInput as never,
              execIdNumber
            )
            // Keep the parent BiDi stream alive while we wait for the IDE
            // to return the ExecClientMessage. The IDE sometimes takes
            // 30-90s before the first byte (file system slow, prompt
            // approval dialog, etc.); without an explicit beat the NAL
            // stall detector aborts the parent stream with a misleading
            // "proxy restarted" error, even though bridge-side processing
            // is healthy.
            //
            // Implementation: Promise.race the bridge waiter against a
            // timeout token; on timeout yield a heartbeat and re-race
            // until the real waiter wins.
            let execResult: SubagentExecResult | undefined
            const HEARTBEAT_MS = this.KEEPALIVE_INTERVAL
            while (true) {
              type RaceWinner =
                | { kind: "result"; value: SubagentExecResult }
                | { kind: "heartbeat" }
              let timeoutHandle: NodeJS.Timeout | undefined
              const heartbeatToken = new Promise<RaceWinner>((resolve) => {
                timeoutHandle = setTimeout(
                  () => resolve({ kind: "heartbeat" as const }),
                  HEARTBEAT_MS
                )
              })
              const winner: RaceWinner = await Promise.race([
                waitPromise.then((value) => ({
                  kind: "result" as const,
                  value,
                })),
                heartbeatToken,
              ])
              if (timeoutHandle) {
                clearTimeout(timeoutHandle)
              }
              if (winner.kind === "result") {
                execResult = winner.value
                break
              }
              this.logger.debug(
                `[SubAgent] Heartbeat while waiting for exec result ` +
                  `${tc.id} (${tc.name}, subagent=${ctx.subagentId})`
              )
              yield this.grpcService.createHeartbeatResponse()
            }
            toolResultContent = this.formatSubAgentExecResultAsText(
              tc.name,
              execResult
            )
            // Tool was consumed by the bridge — clear pending entry so
            // it does not leak past the sub-agent's lifetime.
            this.sessionManager.consumePendingToolCall(conversationId, tc.id)
            toolResults.push({
              type: "tool_result",
              tool_use_id: tc.id,
              content: toolResultContent,
            })
          } catch (err) {
            if (this.isSubAgentAbortError(err)) {
              const message = err instanceof Error ? err.message : String(err)
              this.sessionManager.consumePendingToolCall(conversationId, tc.id)
              // Drop a session-memory breadcrumb BEFORE clearing the
              // context so the parent agent's next turn can see that
              // this sub-agent ran (and was aborted) without us
              // having to keep the sub-agent context alive.
              this.recordAbortedSubAgentMemory(
                conversationId,
                ctx,
                "aborted",
                `${tc.name} (${tc.id}): ${message}`
              )
              // Tear down only this sub-agent's context; sibling
              // sub-agents in the same parent batch keep running.
              this.sessionManager.clearSubAgentContext(
                conversationId,
                ctx.subagentId
              )
              this.logger.warn(
                `[SubAgent] Aborted ${ctx.subagentId} while waiting for ` +
                  `${tc.name} (${tc.id}): ${message}`
              )
              return
            }
            toolResultStatus = "error"
            toolResultContent = `[tool error] ${String(err)}`
            // Pending tool call may have been consumed already by an
            // abort path; consume defensively.
            this.sessionManager.consumePendingToolCall(conversationId, tc.id)
            toolResults.push({
              type: "tool_result",
              tool_use_id: tc.id,
              content: toolResultContent,
            })
          }
        } else if (family) {
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
            toolResultContent = result.content
            if (result.state?.status === "error") {
              toolResultStatus = "error"
            }
            toolResults.push({
              type: "tool_result",
              tool_use_id: tc.id,
              content: result.content,
            })
          } catch (err) {
            toolResultStatus = "error"
            toolResultContent = `[tool error] ${String(err)}`
            toolResults.push({
              type: "tool_result",
              tool_use_id: tc.id,
              content: toolResultContent,
            })
          }
        } else {
          // Tool maps to neither an inline deferred family nor an
          // Exec-dispatchable family. Tell the model exactly which
          // tools ARE available so it can re-plan instead of looping on
          // a non-existent tool.
          this.logger.warn(`[SubAgent] Unsupported tool: ${tc.name} (${tc.id})`)
          const availableToolNames = (
            (ctx.tools as unknown as ToolDefinition[]) || []
          )
            .map((t) => t?.name)
            .filter((value): value is string => typeof value === "string")
          const availableHint =
            availableToolNames.length > 0
              ? `Available tools in this sub-agent: ${availableToolNames.join(", ")}.`
              : "No tools are available in this sub-agent."
          toolResultStatus = "error"
          toolResultContent =
            `[tool error] Tool "${tc.name}" is not available in this ` +
            `sub-agent. ` +
            availableHint +
            " Please complete the task using only those tools, or " +
            "summarize what you have so far if you cannot continue."
          toolResults.push({
            type: "tool_result",
            tool_use_id: tc.id,
            content: toolResultContent,
          })
        }

        // Emit the matching toolCallCompleted into the parent task bubble.
        // Note we always send the lifecycle pair even when the tool failed,
        // so the IDE never leaves a "started but never completed" stub.
        // Use the same per-tool family hint we computed before
        // toolCallStarted so MCP tools project to mcpToolCall rather
        // than falling through to truncatedToolCall.
        yield yieldSubAgentUpdate(
          this.grpcService.buildInnerToolCallCompletedInteractionUpdate(
            tc.id,
            tc.name,
            parsedInput,
            toolResultContent,
            innerToolFamilyHint,
            ctx.subagentId,
            toolCompletedExtraData
          )
        )
        // ConversationStep accumulation: push a toolCall step so the
        // parent task bubble's detail panel renders the per-tool
        // breakdown (which tools the sub-agent used + their results).
        // Same family-hint as above so the per-step record uses the
        // matching proto oneof case.
        ctx.conversationSteps.push(
          this.grpcService.buildToolCallConversationStep(
            tc.name,
            tc.id,
            parsedInput,
            toolResultContent,
            toolCompletedExtraData,
            innerToolFamilyHint
          )
        )
        // Surface success/failure via log so trace audits can correlate
        // sub-agent tool result statuses without re-reading payloads.
        if (toolResultStatus === "error") {
          this.logger.warn(
            `[SubAgent] Tool ${tc.name} (${tc.id}) returned error to sub-agent`
          )
        }
      }

      // Add tool results to conversation
      ctx.messages.push({
        role: "user",
        content: toolResults as any,
      })
    }

    // Reached max turns. Before settling the parent task tool call,
    // run one more LLM pass with tools removed and a system addendum
    // forcing a final synthesis. Without this, the parent agent
    // receives `ctx.accumulatedText` (often empty — the LLM was still
    // emitting tool_use blocks when the loop bailed) or the literal
    // `[sub-agent reached max turns]` placeholder, wasting every tool
    // call the sub-agent already paid for.
    //
    // The synthesis turn re-uses the same backend stream + heartbeat
    // wrapper as a normal sub-agent turn. The DTO it sends is
    // identical except (a) `tools: undefined`, (b) a synthesis-only
    // system addendum, (c) injects a final user nudge so the
    // assistant has an explicit instruction tied to the just-collected
    // tool_results.
    this.logger.log(
      `[SubAgent] ${subagentId} reached MAX_TURNS=${MAX_TURNS}; running final synthesis turn (no tools)`
    )
    ctx.turnCount++
    ctx.messages.push({
      role: "user",
      content:
        "You have reached your turn limit. Stop calling tools. Using " +
        "only the tool_results already in this conversation, write a " +
        "single final assistant message that synthesizes your findings " +
        "into a clear answer. This is your last turn.",
    })

    let synthesisText = ""
    try {
      const buildSynthesisDtoForRoute = (
        streamRoute: ModelRouteResult,
        hints?: BackendStreamHints
      ): CreateMessageDto =>
        this.buildSubAgentStreamingDtoForRoute(
          session,
          ctx,
          conversationId,
          streamRoute,
          hints,
          { forceFinalSynthesis: true }
        )

      const buildSynthesisCodexRequestForRoute = (
        streamRoute: ModelRouteResult,
        hints?: BackendStreamHints
      ): CodexExecutionRequest => {
        // Synthesis turn: tools are intentionally undefined, but the
        // model still needs the "produce a final answer from
        // tool_results" addendum so it doesn't sit silent. Anthropic
        // DTO path supplies this via the forceFinalSynthesis branch in
        // buildSubAgentStreamingDtoForRoute; the Codex path used to
        // skip it entirely.
        const { systemAddendum } = this.resolveSubAgentToolSurface(
          undefined,
          true
        )
        return this.buildCodexStreamingRequestForRoute(streamRoute, {
          model: ctx.model,
          promptContext: this.buildPromptContextFromSession(session),
          conversationId,
          session,
          thinkingLevel: session.thinkingLevel,
          thinkingDetailsRequested: session.thinkingDetailsRequested,
          budgetOverride: hints?.budgetOverride,
          additionalSystemPrompt: systemAddendum,
          // No toolDefinitions — synthesis turn must be text-only.
          buildMessages: (budget) => {
            const compacted = this.contextRequestPlanner.projectMessages(
              ctx.messages.map((message) => ({
                role: message.role,
                content: message.content as UnifiedMessage["content"],
              })) as UnifiedMessage[],
              this.EMPTY_CONTEXT_ATTACHMENT_SNAPSHOT,
              budget,
              { strategy: "auto" }
            )
            this.resetCodexContinuationAfterProjectionRewrite(
              streamRoute.backend,
              conversationId,
              streamRoute.model,
              compacted,
              `sub-agent synthesis: ${conversationId}:${ctx.subagentId}`
            )

            return projectSubAgentFinalSynthesisMessages(
              compacted.messages as Array<{
                role: "user" | "assistant"
                content: unknown
              }>
            ) as CodexExecutionRequest["messages"]
          },
        })
      }

      // Heartbeat at the synthesis turn boundary, mirroring what
      // every other LLM turn in this loop does.
      yield this.grpcService.createHeartbeatResponse()

      const route = this.modelRouter.resolveModel(ctx.model)
      const streamModel = route.model
      const stream = this.getBackendStream(streamModel, {
        buildDtoForRoute: buildSynthesisDtoForRoute,
        buildCodexRequestForRoute: buildSynthesisCodexRequestForRoute,
        recoveryKey: `cursor:subagent:${conversationId}:${subagentId}:synthesis`,
      })
      const heartbeatStream = this.streamWithHeartbeat(stream)

      for await (const item of heartbeatStream) {
        if (item.type === "heartbeat") {
          yield this.grpcService.createHeartbeatResponse()
          continue
        }

        const event = this.parseSseEvent(item.value)
        if (!event) continue

        if (event.type === "content_block_delta") {
          const delta = event.data.delta
          if (delta?.type === "text_delta" && delta.text) {
            synthesisText += delta.text
            // Mirror synthesis text to the parent task bubble so the
            // final answer streams in real time, matching the UX of
            // an in-loop sub-agent turn.
            yield yieldSubAgentUpdate(
              this.grpcService.buildInnerTextDeltaInteractionUpdate(delta.text)
            )
          }
          // tool_use deltas are intentionally ignored on the synthesis
          // turn — even if the model emits one (it should not, since
          // we did not pass any tool definitions), there is no
          // dispatcher to handle it and we want a pure text answer.
        }
        // Other event types (block_start / block_stop / message_*) are
        // safe to ignore for the synthesis pass — we only need text.
      }
    } catch (synthesisErr) {
      // Synthesis is best-effort. If the LLM call itself fails, fall
      // back to whatever we accumulated during the main loop so we
      // still hand the parent something rather than leaving the task
      // tool call hung.
      this.logger.warn(
        `[SubAgent] ${subagentId} synthesis turn failed: ${String(
          synthesisErr
        )}`
      )
    }

    const finalText =
      synthesisText.trim().length > 0
        ? synthesisText
        : ctx.accumulatedText || "[sub-agent reached max turns]"

    // Persist the synthesis text into the conversation log so any
    // follow-up tooling (transcript audit, conversation step renderer)
    // sees a clean assistant message at the end of the sub-agent's
    // history rather than a stale "[reached max turns]" placeholder.
    if (synthesisText.trim().length > 0) {
      ctx.messages.push({
        role: "assistant",
        content: synthesisText,
      })
      ctx.accumulatedText = synthesisText
    }

    yield* this.completeSubAgent(conversationId, ctx.subagentId, finalText)
  }

  // ────────────────────────────────────────────────────────────────────
  // Background sub-agent host hooks
  // ────────────────────────────────────────────────────────────────────
  //
  // These two methods are the surface SubagentBackgroundWorker calls
  // into. They re-use the bridge's existing LLM routing + inline tool
  // executors, just packaged as plain async functions instead of the
  // foreground generator that yields BiDi buffers.
  //
  // Why public methods on this service rather than a separate class:
  // - getBackendStream / streamWithHeartbeat / executeDeferredTool /
  //   buildSubAgentStreamingDtoForRoute / buildCodexStreamingRequestForRoute
  //   all live here as private members and depend on a bunch of other
  //   private state. Re-implementing them in a worker would either
  //   duplicate a lot of code or require exposing a sprawling DI surface.
  // - Keeping them here lets the worker stay a thin loop that focuses on
  //   transcript / metadata bookkeeping.

  /** Run a single sub-agent LLM turn for a background worker. Drives the
   * existing backend stream, parses SSE events, accumulates text +
   * thinking + tool_use blocks, and returns the aggregated turn result.
   * Does NOT yield buffers — background workers have no live BiDi stream
   * to write to. */
  async runBackgroundSubAgentLlmTurn(
    conversationId: string,
    args: {
      subagentId: string
      messages: Array<{ role: "user" | "assistant"; content: unknown }>
      model: string
      toolNames: string[]
      abortSignal: AbortSignal
      /**
       * When true, the worker is doing its post-MAX_TURNS synthesis
       * pass. Strips tools from the DTO and swaps the system addendum
       * to "produce a final answer from existing tool_results" — same
       * mechanism the foreground sub-agent uses on its synthesis turn.
       */
      forceFinalSynthesis?: boolean
    }
  ): Promise<{
    fullText: string
    toolCalls: Array<{ id: string; name: string; inputJson: string }>
    error?: string
  }> {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) {
      return {
        fullText: "",
        toolCalls: [],
        error: "session not found",
      }
    }

    // Expand tool NAMES into proper ToolDefinition[] using the same
    // builder the foreground sub-agent / parent agent use. Worker passes
    // names only because it has no access to per-session MCP defs nor to
    // the backend-specific tool encoder. Without this expansion the
    // backend gets `[{ name: "semantic_search" }]`-style stubs and
    // schema validation fails silently inside the SSE generator,
    // leaving the worker's await stuck forever.
    //
    // On a forceFinalSynthesis pass we deliberately skip the expansion
    // and pass an empty list so buildSubAgentStreamingDtoForRoute drops
    // the tools key off the DTO entirely.
    const route = this.modelRouter.resolveModel(args.model)
    const toolDefinitions = args.forceFinalSynthesis
      ? []
      : buildToolsForApi(args.toolNames, {
          mcpToolDefs: session.mcpToolDefs,
          backend: route.backend,
          forSubAgent: true,
        })

    // Construct a minimal SubAgentContext for the existing
    // buildSubAgentStreamingDtoForRoute helper. The worker owns the
    // canonical message history; this ctx is throwaway scaffolding.
    const tempCtx: SubAgentContext = {
      subagentId: args.subagentId,
      parentToolCallId: "",
      parentModelCallId: "",
      messages: args.messages.map((m) => ({
        role: m.role,
        content: m.content as MessageContent,
      })),
      model: args.model,
      tools: toolDefinitions,
      accumulatedText: "",
      pendingToolCallIds: new Set(),
      startTime: Date.now(),
      turnCount: 0,
      toolCallCount: 0,
      modifiedFiles: [],
      currentTurnToolCalls: [],
      pendingToolResults: new Map(),
      expectedToolCallIds: new Set(),
      conversationSteps: [],
    }

    const buildDtoForRoute = (
      streamRoute: ModelRouteResult,
      hints?: BackendStreamHints
    ): CreateMessageDto =>
      this.buildSubAgentStreamingDtoForRoute(
        session,
        tempCtx,
        conversationId,
        streamRoute,
        hints,
        { forceFinalSynthesis: args.forceFinalSynthesis === true }
      )

    const buildCodexRequestForRoute = (
      streamRoute: ModelRouteResult,
      hints?: BackendStreamHints
    ): CodexExecutionRequest => {
      // Background sub-agent on Codex needs the SAME tool surface and
      // system addendum the Anthropic DTO path injects. Without this,
      // GPT-routed background sub-agents see no tools and immediately
      // return a "no tools available" assistant message after `turn=1,
      // tools=0` — exactly the failure mode reported in the smoke
      // probe. On the post-MAX_TURNS synthesis pass we strip tools
      // anyway, so we honour args.forceFinalSynthesis here.
      const { toolDefinitions: codexTools, systemAddendum: codexAddendum } =
        this.resolveSubAgentToolSurface(
          tempCtx.tools,
          args.forceFinalSynthesis === true
        )
      return this.buildCodexStreamingRequestForRoute(streamRoute, {
        model: args.model,
        promptContext: this.buildPromptContextFromSession(session),
        conversationId,
        session,
        thinkingLevel: session.thinkingLevel,
        thinkingDetailsRequested: session.thinkingDetailsRequested,
        budgetOverride: hints?.budgetOverride,
        toolDefinitions: codexTools,
        additionalSystemPrompt: codexAddendum,
        buildMessages: (budget) => {
          const compacted = this.contextRequestPlanner.projectMessages(
            tempCtx.messages.map((message) => ({
              role: message.role,
              content: message.content as UnifiedMessage["content"],
            })) as UnifiedMessage[],
            this.EMPTY_CONTEXT_ATTACHMENT_SNAPSHOT,
            budget,
            { strategy: "auto" }
          )
          this.resetCodexContinuationAfterProjectionRewrite(
            streamRoute.backend,
            conversationId,
            streamRoute.model,
            compacted,
            `background sub-agent: ${conversationId}:${args.subagentId}`
          )
          if (args.forceFinalSynthesis === true) {
            return projectSubAgentFinalSynthesisMessages(
              compacted.messages as Array<{
                role: "user" | "assistant"
                content: unknown
              }>
            ) as CodexExecutionRequest["messages"]
          }
          return compacted.messages as CodexExecutionRequest["messages"]
        },
      })
    }

    const streamModel = route.model

    let fullText = ""
    const toolCalls: Array<{ id: string; name: string; inputJson: string }> = []
    let currentToolCall: {
      id: string
      name: string
      inputJson: string
    } | null = null

    try {
      const stream = this.getBackendStream(streamModel, {
        buildDtoForRoute,
        buildCodexRequestForRoute,
        recoveryKey: `cursor:subagent:bg:${conversationId}:${args.subagentId}`,
        // Plumb the worker's AbortController signal all the way down
        // into the backend SSE stream so kill_agent / registry.kill()
        // can short-circuit the upstream HTTP request, not just the
        // for-await loop below. Without this the SSE source keeps
        // streaming and the loop just races between an event arriving
        // and the abortSignal flipping — fine when events are
        // frequent, but the LLM may hold the stream open between
        // turns, leaving kill signals stranded.
        abortSignal: args.abortSignal,
      })

      // No outer BiDi stream to keep alive, so we don't need
      // streamWithHeartbeat. We DO honour the abortSignal so the
      // registry's kill() can short-circuit the SSE loop.
      for await (const sseEventStr of stream) {
        if (args.abortSignal.aborted) {
          return {
            fullText,
            toolCalls,
            error: "aborted",
          }
        }
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
      return {
        fullText,
        toolCalls,
        error: String(error),
      }
    }

    return { fullText, toolCalls }
  }

  /** Run a single bridge-local / inline tool for a background worker.
   * Re-uses the same dispatcher as foreground sub-agents so read-only
   * workspace tools and service-backed tools share one semantic path. */
  async runBackgroundInlineDeferredTool(
    conversationId: string,
    toolName: string,
    parsedInput: Record<string, unknown>,
    options?: { abortSignal?: AbortSignal }
  ): Promise<{ content: string; status: "success" | "error" }> {
    if (options?.abortSignal?.aborted) {
      return {
        content: "[tool aborted] background sub-agent kill signal received",
        status: "error",
      }
    }

    const bridgeInline = await this.executeSubAgentBridgeInlineTool(
      conversationId,
      toolName,
      parsedInput
    )
    if (bridgeInline) {
      return {
        content: bridgeInline.content,
        status: bridgeInline.state.status === "error" ? "error" : "success",
      }
    }

    const family = this.classifyDeferredToolFamily(toolName)
    if (!family) {
      return {
        content:
          `[tool error] '${toolName}' is not a known bridge-local or ` +
          `inline tool family — background sub-agents only support ` +
          `bridge-local / inline tools.`,
        status: "error",
      }
    }
    try {
      const result = await this.executeDeferredTool(
        conversationId,
        family,
        toolName,
        parsedInput,
        options
      )
      return {
        content: result.content,
        status: result.state?.status === "error" ? "error" : "success",
      }
    } catch (err) {
      // Distinguish operator-initiated kill from generic tool errors so
      // the worker's transcript records the correct terminal status.
      if (
        options?.abortSignal?.aborted ||
        (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        return {
          content: `[tool aborted] ${toolName} cancelled by kill_agent`,
          status: "error",
        }
      }
      return {
        content: `[tool error] ${String(err)}`,
        status: "error",
      }
    }
  }

  /**
   * Parse the `run_in_background` flag from a `task` tool call's input.
   * Accepts boolean true / "true" / 1 (claude-code's tolerant parse).
   * Anything else falls back to false (foreground).
   */
  private parseRunInBackgroundFlag(input: Record<string, unknown>): boolean {
    const raw =
      input.run_in_background ??
      input.runInBackground ??
      input.background ??
      input.is_background
    if (typeof raw === "boolean") return raw
    if (typeof raw === "number") return raw === 1
    if (typeof raw === "string") {
      const normalized = raw.trim().toLowerCase()
      return normalized === "true" || normalized === "1" || normalized === "yes"
    }
    return false
  }

  /**
   * Background sub-agent spawn path.
   *
   * 1. Resolve sub-agent definition + model the same way the foreground
   *    path does (so subagent_type and inheritance stay symmetric).
   * 2. Spawn the worker. The worker runs entirely off-stream — no
   *    BiDi yields — and persists progress to
   *    ~/.cursor/subagents/<agentId>/{transcript.jsonl, metadata.json,
   *    result.txt}.
   * 3. Register the runtime handle in SubagentTaskRegistry so the
   *    parent agent can later query / kill the task across BiDi
   *    streams.
   * 4. IMMEDIATELY settle the parent task tool with a
   *    `taskSuccess { agentId, isBackground: true, transcriptPath }`
   *    projection. The parent agent receives the agentId in its tool
   *    result and can use `read_file` on the transcript / result paths
   *    to follow up.
   */
  private async *spawnBackgroundSubAgent(
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
    // claude-code TaskCreateTool field semantics:
    //   - `prompt`  : the actual brief the sub-agent should act on.
    //   - `description` : 3-5 word UI label shown in the parent task
    //     bubble while the sub-agent runs.
    // We prefer `prompt` so the sub-agent receives the real task body.
    // `description` and the legacy `task` alias are fallbacks for older
    // callers that only set the UI label.
    const description =
      this.pickFirstString(input, ["prompt", "task", "description"]) || ""
    if (!description) {
      yield* this.emitInlineToolResult(
        conversationId,
        parentToolCallId,
        "[task error] Missing required prompt (or fallback description)",
        { status: "error", message: "missing prompt" }
      )
      return
    }

    const requestedAgentType =
      this.pickFirstString(input, ["subagent_type", "subagentType", "type"]) ||
      ""
    const projectCwd = session.projectContext?.rootPath || process.cwd()
    const allSubagents = this.subagentRegistry.getAll(projectCwd)
    const agentDefinition: SubagentDefinition | undefined = requestedAgentType
      ? this.subagentRegistry.findByType(requestedAgentType, projectCwd)
      : undefined
    const effectiveAgent: SubagentDefinition =
      agentDefinition ||
      allSubagents.find((agent) => agent.agentType === "general-purpose") ||
      allSubagents[0]!
    if (!agentDefinition && requestedAgentType) {
      this.logger.warn(
        `[BackgroundSubAgent] Unknown subagent_type '${requestedAgentType}'; ` +
          `falling back to '${effectiveAgent.agentType}'.`
      )
    }
    const subAgentModel = this.resolveSubAgentModel(effectiveAgent, session)

    // Spawn the worker. donePromise resolves when the worker terminates
    // (regardless of success / failure / kill); we don't await it here
    // — the parent task tool settles immediately so the BiDi stream can
    // close.
    const spawn = this.subagentBackgroundWorker.spawn({
      parentConversationId: conversationId,
      parentToolCallId,
      description,
      agent: effectiveAgent,
      model: subAgentModel,
      allowedWorkspaceRoots:
        this.sessionManager.listAllowedWorkspaceRoots(conversationId),
      host: {
        logger: this.logger,
        runInlineDeferredTool: (
          convId: string,
          toolName: string,
          parsedInput: Record<string, unknown>,
          options?: { abortSignal?: AbortSignal }
        ) =>
          this.runBackgroundInlineDeferredTool(
            convId,
            toolName,
            parsedInput,
            options
          ),
        runSubAgentLlmTurn: (convId, llmArgs) =>
          this.runBackgroundSubAgentLlmTurn(convId, llmArgs),
        // ConversationStep builders — wrap the grpc service helpers so
        // the worker stays decoupled from the proto schema and only
        // sees opaque step blobs.
        buildAssistantStep: (text: string) =>
          this.grpcService.buildAssistantConversationStep(text),
        buildToolCallStep: ({ toolName, callId, parsedInput, resultContent }) =>
          this.grpcService.buildToolCallConversationStep(
            toolName,
            callId,
            parsedInput,
            resultContent,
            undefined,
            // Session-aware family hint so MCP tool calls inside a
            // background sub-agent project to mcpToolCall instead of
            // the truncatedToolCall fallback (which the IDE renders as
            // `[Tool: truncatedToolCall]` in the parent task bubble's
            // detail panel).
            this.classifyExecToolFamilyHint(toolName, session)
          ),
      },
    })

    this.subagentTaskRegistry.register(
      {
        agentId: spawn.agentId,
        parentConversationId: conversationId,
        abortController: spawn.abortController,
        donePromise: spawn.donePromise,
        startedAt: spawn.metadata.startedAt,
      },
      spawn.metadata
    )

    const transcriptPath = this.subagentTranscriptStore.getTranscriptPath(
      spawn.agentId
    )
    const resultPath = this.subagentTranscriptStore.getResultPath(spawn.agentId)
    const ackContent =
      `Background sub-agent spawned.\n` +
      `agentId: ${spawn.agentId}\n` +
      `agentType: ${effectiveAgent.agentType}\n` +
      `model: ${subAgentModel}\n` +
      `transcript: ${transcriptPath}\n` +
      `result: ${resultPath}\n\n` +
      `The sub-agent is now running asynchronously. To check progress, ` +
      `use read_file on the transcript path. To read the final answer ` +
      `once the task is complete, use read_file on the result path.`

    yield* this.emitInlineToolResult(
      conversationId,
      parentToolCallId,
      ackContent,
      { status: "success" },
      {
        taskSuccess: {
          agentId: spawn.agentId,
          isBackground: true,
          durationMs: 0,
          transcriptPath,
        },
      }
    )
  }

  private findTaskToolUseForHistory(
    session: ChatSession,
    toolCallId: string
  ): { toolName: string; toolInput: Record<string, unknown> } {
    for (let i = session.messageRecords.length - 1; i >= 0; i--) {
      const record = session.messageRecords[i]
      if (
        !record ||
        record.role !== "assistant" ||
        !Array.isArray(record.content)
      ) {
        continue
      }
      for (const block of record.content) {
        if (!this.isLooseRecord(block) || block.type !== "tool_use") continue
        if (block.id !== toolCallId) continue
        return {
          toolName: typeof block.name === "string" ? block.name : "task",
          toolInput: this.isLooseRecord(block.input) ? block.input : {},
        }
      }
    }

    return { toolName: "task", toolInput: {} }
  }

  private extractSubagentIdFromCompletionPath(pathValue: string): string {
    const normalized = pathValue.replace(/\\/g, "/")
    const marker = "/.cursor/subagents/"
    const markerIndex = normalized.indexOf(marker)
    if (markerIndex === -1) return ""
    const rest = normalized.slice(markerIndex + marker.length)
    return rest.split("/", 1)[0] || ""
  }

  private resolveBackgroundCompletionMetadata(
    conversationId: string,
    parsed: ParsedCursorRequest
  ): SubagentTaskMetadata[] {
    const completions = parsed.agentControlBackgroundTaskCompletions || []
    const byAgentId = new Map<string, SubagentTaskMetadata>()
    const maybeAdd = (agentId: string) => {
      if (!agentId || byAgentId.has(agentId)) return
      const metadata = this.subagentTaskRegistry.getMetadata(agentId)
      if (!metadata || metadata.parentConversationId !== conversationId) return
      byAgentId.set(agentId, metadata)
    }

    for (const completion of completions) {
      maybeAdd(completion.taskId)
      if (completion.threadId) maybeAdd(completion.threadId)
      if (completion.outputPath) {
        maybeAdd(
          this.extractSubagentIdFromCompletionPath(completion.outputPath)
        )
      }
    }

    return [...byAgentId.values()]
  }

  private isTerminalBackgroundTaskCompletion(
    completion: NonNullable<
      ParsedCursorRequest["agentControlBackgroundTaskCompletions"]
    >[number]
  ): boolean {
    if (completion.reason === 2) return false
    if (completion.status === 1 || completion.status === 2) return true
    if (completion.status === 3) return true
    return completion.reason === 1
  }

  private describeBackgroundTaskKind(kind?: number): string {
    switch (kind) {
      case 1:
        return "shell"
      case 2:
        return "subagent"
      case 0:
      case undefined:
        return "unspecified"
      default:
        return `unknown(${kind})`
    }
  }

  private describeBackgroundTaskStatus(status?: number): string {
    switch (status) {
      case 1:
        return "success"
      case 2:
        return "error"
      case 3:
        return "aborted"
      case 0:
      case undefined:
        return "unspecified"
      default:
        return `unknown(${status})`
    }
  }

  private truncateBackgroundTaskText(text: string, maxChars = 12000): string {
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`
  }

  private backgroundCompletionMatchesSubagent(
    completion: NonNullable<
      ParsedCursorRequest["agentControlBackgroundTaskCompletions"]
    >[number],
    metadata: SubagentTaskMetadata
  ): boolean {
    if (completion.taskId === metadata.agentId) return true
    if (completion.threadId === metadata.agentId) return true
    if (
      completion.outputPath &&
      this.extractSubagentIdFromCompletionPath(completion.outputPath) ===
        metadata.agentId
    ) {
      return true
    }
    return false
  }

  private renderGenericBackgroundCompletion(
    completion: NonNullable<
      ParsedCursorRequest["agentControlBackgroundTaskCompletions"]
    >[number]
  ): string {
    const lines = [
      "[background_task completed]",
      `taskId: ${completion.taskId}`,
      `kind: ${this.describeBackgroundTaskKind(completion.kind)}`,
      `status: ${this.describeBackgroundTaskStatus(completion.status)}`,
    ]
    if (completion.title) lines.push(`title: ${completion.title}`)
    if (completion.detail) lines.push(`detail: ${completion.detail}`)
    if (completion.outputPath)
      lines.push(`output_path: ${completion.outputPath}`)
    if (completion.threadId) lines.push(`thread_id: ${completion.threadId}`)
    return this.truncateBackgroundTaskText(lines.join("\n"), 4000)
  }

  private async collectBackgroundShellCompletionMessages(
    conversationId: string,
    completions: NonNullable<
      ParsedCursorRequest["agentControlBackgroundTaskCompletions"]
    >
  ): Promise<{
    messages: string[]
    handledTaskIds: Set<string>
  }> {
    const messages: string[] = []
    const handledTaskIds = new Set<string>()

    for (const completion of completions) {
      if (!this.isTerminalBackgroundTaskCompletion(completion)) continue
      const candidateIds = [
        completion.taskId,
        completion.threadId || "",
      ].filter((id) => id.trim().length > 0)
      let command: SessionBackgroundCommand | undefined
      for (const candidateId of candidateIds) {
        command = this.sessionManager.getBackgroundCommand(
          conversationId,
          candidateId
        )
        if (command) break
      }
      if (!command) {
        if (completion.kind === 1) {
          messages.push(this.renderGenericBackgroundCompletion(completion))
          handledTaskIds.add(completion.taskId)
        }
        continue
      }

      command =
        (await this.refreshBackgroundCommandTerminalOutput(
          conversationId,
          command.commandId
        )) || command
      if (command.status === "running") {
        const status = completion.status === 1 ? 0 : 1
        this.sessionManager.setBackgroundCommandExit(
          conversationId,
          command.commandId,
          status,
          completion.status === 3
        )
        command =
          this.sessionManager.getBackgroundCommand(
            conversationId,
            command.commandId
          ) || command
      }

      const rendered = await this.executeInlineCommandStatus(conversationId, {
        CommandId: command.commandId,
        OutputCharacterCount: 12000,
      })
      messages.push(
        this.truncateBackgroundTaskText(
          rendered.content.replace(
            "[command_status success]",
            "[background_shell completed]"
          )
        )
      )
      handledTaskIds.add(completion.taskId)
      if (completion.threadId) handledTaskIds.add(completion.threadId)
    }

    return { messages, handledTaskIds }
  }

  private updateBackgroundTaskSuccessHistory(
    session: ChatSession,
    parentToolCallId: string,
    taskSuccess: NonNullable<ToolCompletedExtraData["taskSuccess"]>
  ): void {
    let changed = false
    const safeTaskSuccess = this.toJsonSafe(taskSuccess)
    const nextMessages = session.messages.map((message) => {
      if (message.role !== "user" || !Array.isArray(message.content)) {
        return message
      }
      let messageChanged = false
      const nextContent = message.content.map((block) => {
        if (
          !this.isLooseRecord(block) ||
          block.type !== "tool_result" ||
          block.tool_use_id !== parentToolCallId
        ) {
          return block
        }
        const existingStructured = this.isLooseRecord(block.structuredContent)
          ? block.structuredContent
          : {}
        messageChanged = true
        changed = true
        return {
          ...block,
          structuredContent: {
            ...existingStructured,
            taskSuccess: safeTaskSuccess,
          },
        }
      })
      return messageChanged
        ? {
            ...message,
            content: nextContent as MessageContent,
          }
        : message
    })

    if (changed) {
      this.sessionManager.replaceMessages(session.conversationId, nextMessages)
    }
  }

  private async *handleBackgroundTaskCompletionAction(
    conversationId: string,
    parsed: ParsedCursorRequest,
    streamId?: string
  ): AsyncGenerator<Buffer, boolean> {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) return false

    const completions = parsed.agentControlBackgroundTaskCompletions || []
    const metadataList = this.resolveBackgroundCompletionMetadata(
      conversationId,
      parsed
    )
    const completionMessages: string[] = []
    const handledTaskIds = new Set<string>()
    for (const metadata of metadataList) {
      const parentToolCallId = metadata.parentToolCallId
      if (!parentToolCallId) continue

      const conversationSteps = Array.isArray(metadata.conversationSteps)
        ? metadata.conversationSteps.map((step) =>
            create(ConversationStepSchema, step as never)
          )
        : []
      if (conversationSteps.length === 0) {
        continue
      }

      const { toolName, toolInput } = this.findTaskToolUseForHistory(
        session,
        parentToolCallId
      )
      const transcriptPath = this.subagentTranscriptStore.getTranscriptPath(
        metadata.agentId
      )
      const resultPath = this.subagentTranscriptStore.getResultPath(
        metadata.agentId
      )
      const durationMs = metadata.durationMs ?? 0
      const taskSuccess: NonNullable<ToolCompletedExtraData["taskSuccess"]> = {
        agentId: metadata.agentId,
        isBackground: true,
        durationMs,
        transcriptPath,
        conversationSteps: conversationSteps as Array<Record<string, unknown>>,
      }

      this.updateBackgroundTaskSuccessHistory(
        session,
        parentToolCallId,
        taskSuccess
      )

      const resultText =
        metadata.status === "completed"
          ? metadata.finalText || "Background sub-agent completed."
          : metadata.errorMessage || `Background sub-agent ${metadata.status}.`
      this.recordCompletedBackgroundSubAgentMemory(session, {
        agentId: metadata.agentId,
        agentType: metadata.agentType,
        parentToolCallId,
        status: metadata.status,
        resultText,
        durationMs,
        transcriptPath,
        resultPath,
      })

      yield this.grpcService.createToolCallCompletedResponse(
        parentToolCallId,
        toolName,
        toolInput,
        resultText,
        undefined,
        "",
        { taskSuccess }
      )

      completionMessages.push(
        this.truncateBackgroundTaskText(
          [
            `[background_subagent ${metadata.status}]`,
            `agentId: ${metadata.agentId}`,
            `agentType: ${metadata.agentType}`,
            `parentToolCallId: ${parentToolCallId}`,
            `durationMs: ${durationMs}`,
            `transcript: ${transcriptPath}`,
            `result: ${resultPath}`,
            "",
            resultText,
          ].join("\n")
        )
      )

      for (const completion of completions) {
        if (this.backgroundCompletionMatchesSubagent(completion, metadata)) {
          handledTaskIds.add(completion.taskId)
          if (completion.threadId) handledTaskIds.add(completion.threadId)
        }
      }
    }

    const shellCompletion = await this.collectBackgroundShellCompletionMessages(
      conversationId,
      completions
    )
    for (const message of shellCompletion.messages) {
      completionMessages.push(message)
    }
    for (const taskId of shellCompletion.handledTaskIds) {
      handledTaskIds.add(taskId)
    }

    for (const completion of completions) {
      if (!this.isTerminalBackgroundTaskCompletion(completion)) continue
      if (handledTaskIds.has(completion.taskId)) continue
      if (completion.threadId && handledTaskIds.has(completion.threadId))
        continue
      completionMessages.push(
        this.renderGenericBackgroundCompletion(completion)
      )
      handledTaskIds.add(completion.taskId)
    }

    if (completionMessages.length === 0) {
      this.logger.log(
        `Background task completion produced no terminal notification: conversation=${conversationId} completions=${completions.length}`
      )
      return false
    }

    const continuationMessage = this.truncateBackgroundTaskText(
      ["[background_task_completion]", ...completionMessages].join("\n\n"),
      16000
    )
    yield this.grpcService.createUserMessageAppendedResponse(
      continuationMessage,
      `background_task_completion_${crypto.randomUUID()}`
    )
    return yield* this.continueAgentFromControlUserMessage(
      conversationId,
      parsed,
      continuationMessage,
      streamId,
      "background task completion"
    )
  }

  /**
   * Complete the sub-agent and emit result for the parent's task tool call.
   *
   * The `inlineContent` we hand back to the parent agent is intentionally
   * a *full report* — finalText + a compact per-tool summary + a list
   * of files the sub-agent touched — not just `finalText` on its own.
   *
   * Why: the parent agent's next LLM turn only sees what we put into the
   * inline tool_result for `task`. `conversationSteps` is rendered by
   * the IDE for human inspection, but it is NOT included in the message
   * history sent back to the model. If we serialised only `finalText`
   * and the sub-agent's actual work was carried out through tool calls
   * (which is the common case — a research sub-agent, a build sub-agent,
   * etc.), the parent agent loses visibility into what the sub-agent
   * actually discovered and degenerates to acting on a one-line
   * summary. Mirrors claude-code's AgentTool, which folds the
   * sub-agent's per-step transcript into a `<sub-agent-results>` block
   * in the parent's tool_result.
   *
   * The report shape is stable so downstream parsers (transcript
   * scrapers, evaluators) can rely on it:
   *
   *   <Final answer block, verbatim from the sub-agent>
   *
   *   ---
   *   Sub-agent execution summary:
   *   - turns: N
   *   - tool calls: N
   *   - duration: Nms
   *   - modified files: a, b, c    (omitted when none)
   *
   *   Tool calls:
   *   1. <name> — <one-line key result>
   *   2. ...                       (omitted when no tool calls)
   *
   * Background sub-agents are unchanged: the parent task tool was
   * settled at spawn time with a `taskSuccess { isBackground: true }`
   * envelope, and the actual work landing in
   * ~/.cursor/subagents/<id>/result.txt is consumed by the parent
   * later via `read_file`. We do not re-settle the task tool here.
   */
  private async *completeSubAgent(
    conversationId: string,
    subagentId: string,
    finalText: string
  ): AsyncGenerator<Buffer> {
    const subAgentCtx = this.sessionManager.getSubAgentContextById(
      conversationId,
      subagentId
    )
    if (!subAgentCtx) return

    const durationMs = Date.now() - subAgentCtx.startTime
    this.logger.log(
      `[SubAgent] Completed ${subAgentCtx.subagentId}: ` +
        `${subAgentCtx.turnCount} turns, ${subAgentCtx.toolCallCount} tool calls, ${durationMs}ms`
    )

    if (!subAgentCtx.isBackground) {
      yield this.grpcService.wrapAsTaskToolCallDelta(
        subAgentCtx.parentToolCallId,
        subAgentCtx.parentModelCallId,
        this.grpcService.buildInnerTurnEndedInteractionUpdate()
      )

      const report = this.buildSubAgentFinalReport(
        subAgentCtx,
        finalText,
        durationMs
      )
      yield* this.emitInlineToolResult(
        conversationId,
        subAgentCtx.parentToolCallId,
        report,
        { status: "success" },
        {
          taskSuccess: {
            agentId: subAgentCtx.subagentId,
            isBackground: false,
            durationMs,
            // Project the per-turn ConversationStep[] we accumulated so
            // the IDE renders the parent task bubble's expandable detail
            // panel (assistant text + tool calls per turn). Without this
            // the bubble shows just "Completed" with no breakdown — see
            // grpc service buildAssistantConversationStep /
            // buildToolCallConversationStep helpers.
            conversationSteps: subAgentCtx.conversationSteps as Array<
              Record<string, unknown>
            >,
          },
        }
      )
      this.recordSubAgentSessionMemory(conversationId, subAgentCtx, {
        status: "completed",
        finalText,
        report,
        durationMs,
      })
    } else {
      this.logger.log(
        `[SubAgent] Backgrounded ${subAgentCtx.subagentId} completed without re-settling parent tool call`
      )
    }

    this.sessionManager.clearSubAgentContext(
      conversationId,
      subAgentCtx.subagentId
    )
  }

  /**
   * Compose the inline_tool_result body the parent agent's next LLM
   * turn will receive for a foreground `task` tool call.
   *
   * Strategy:
   *   1. Surface `finalText` verbatim as the primary block. If empty
   *      (some models return only tool calls + an empty assistant
   *      message), substitute a stable placeholder so the parent does
   *      not see a literal empty string and treat it as failure.
   *   2. Append a `Sub-agent execution summary` block with metadata.
   *   3. Append a `Tool calls` enumeration extracted from
   *      `ctx.conversationSteps`. Each line is `<index>. <name> —
   *      <one-line summary>`; the per-tool summary is built by
   *      `summarizeSubAgentToolStep` and clipped to keep the parent
   *      context budget under control.
   *
   * The two trailing blocks are omitted when they are empty (no tool
   * calls / no modified files), to keep the report compact.
   */
  private buildSubAgentFinalReport(
    ctx: SubAgentContext,
    finalText: string,
    durationMs: number
  ): string {
    const trimmedFinal = (finalText || "").trim()
    const finalBlock =
      trimmedFinal.length > 0
        ? trimmedFinal
        : "[sub-agent completed without an explicit final answer]"

    const summaryLines: string[] = ["Sub-agent result metadata:"]
    summaryLines.push(`- agentId: ${ctx.subagentId}`)
    summaryLines.push(`- turns: ${ctx.turnCount}`)
    summaryLines.push(`- tool calls: ${ctx.toolCallCount}`)
    summaryLines.push(`- duration: ${durationMs}ms`)
    if (ctx.modifiedFiles.length > 0) {
      const filesPreview = ctx.modifiedFiles.slice(0, 20).join(", ")
      const overflow =
        ctx.modifiedFiles.length > 20
          ? ` (+${ctx.modifiedFiles.length - 20} more)`
          : ""
      summaryLines.push(`- modified files: ${filesPreview}${overflow}`)
    }

    const evidenceLines: string[] = []
    let toolIndex = 0
    for (const step of ctx.conversationSteps) {
      const summary = this.summarizeSubAgentToolStep(step)
      if (!summary) continue
      toolIndex += 1
      evidenceLines.push(`${toolIndex}. ${summary}`)
      if (toolIndex >= 6) {
        const remaining = ctx.toolCallCount - toolIndex
        if (remaining > 0) {
          evidenceLines.push(
            `… (${remaining} more tool calls kept in Cursor task details)`
          )
        }
        break
      }
    }

    const sections: string[] = [finalBlock]
    sections.push("---", summaryLines.join("\n"))
    if (evidenceLines.length > 0) {
      sections.push("Key tool evidence:\n" + evidenceLines.join("\n"))
    }
    return sections.join("\n\n")
  }

  private recordSubAgentSessionMemory(
    conversationId: string,
    ctx: SubAgentContext,
    options: {
      status: string
      finalText: string
      report: string
      durationMs: number
    }
  ): void {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) return
    this.upsertSubAgentSessionMemory(session, {
      agentId: ctx.subagentId,
      parentToolCallId: ctx.parentToolCallId,
      status: options.status,
      resultText: options.finalText,
      durationMs: options.durationMs,
      turnCount: ctx.turnCount,
      toolCallCount: ctx.toolCallCount,
      modifiedFiles: ctx.modifiedFiles,
      evidenceText: options.report,
    })
  }

  private recordCompletedBackgroundSubAgentMemory(
    session: ChatSession,
    options: {
      agentId: string
      agentType?: string
      parentToolCallId: string
      status: string
      resultText: string
      durationMs: number
      transcriptPath: string
      resultPath: string
    }
  ): void {
    this.upsertSubAgentSessionMemory(session, {
      agentId: options.agentId,
      agentType: options.agentType,
      parentToolCallId: options.parentToolCallId,
      status: options.status,
      resultText: options.resultText,
      durationMs: options.durationMs,
      transcriptPath: options.transcriptPath,
      resultPath: options.resultPath,
    })
  }

  /**
   * Record a sub-agent that was torn down before reaching a clean
   * completion (aborted by a new user turn, cancelled via /abort,
   * interrupted by stream-level recovery).
   *
   * Without this entry the parent agent has no signal that the
   * sub-agent ran at all on its next turn, and may re-spawn the same
   * task. claude-code achieves the same effect through the running
   * task_status attachment (`createAsyncAgentAttachmentsIfNeeded`);
   * we surface the breadcrumb directly in session memory because our
   * sub-agent context is cleared the moment we abort.
   *
   * `weight` is below the success path (96) so a successful retry of
   * the same agentId can supersede the abort entry on the next
   * compaction cycle. Returns silently when the sub-agent context
   * has no agentId (should not happen post-spawn, but keeps the
   * call-site cheap).
   */
  private recordAbortedSubAgentMemory(
    conversationId: string,
    ctx: SubAgentContext,
    status: "aborted" | "cancelled" | "interrupted",
    reason: string
  ): void {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) return
    const reasonText = (reason || "").trim()
    this.upsertSubAgentSessionMemory(session, {
      agentId: ctx.subagentId,
      parentToolCallId: ctx.parentToolCallId,
      status,
      durationMs: Math.max(0, Date.now() - ctx.startTime),
      turnCount: ctx.turnCount,
      toolCallCount: ctx.toolCallCount,
      modifiedFiles: ctx.modifiedFiles,
      resultText: reasonText
        ? `[sub-agent ${status}] ${reasonText}`
        : `[sub-agent ${status}]`,
      // Keep the entry below the success path so a clean rerun wins.
      weight: 80,
    })
  }

  private upsertSubAgentSessionMemory(
    session: ChatSession,
    options: {
      agentId: string
      agentType?: string
      parentToolCallId?: string
      status: string
      resultText?: string
      durationMs?: number
      turnCount?: number
      toolCallCount?: number
      modifiedFiles?: string[]
      evidenceText?: string
      transcriptPath?: string
      resultPath?: string
      /**
       * Relative weight for the new entry. Defaults to 96 (success
       * path). Abort/cancel/interrupt callers pass a lower weight so
       * a successful retry of the same agent can supersede the
       * abort entry on the next compaction cycle.
       */
      weight?: number
    }
  ): void {
    const sourceCompactionId = buildSubAgentMemorySourceCompactionId(
      options.agentId,
      options.parentToolCallId
    )
    if (!sourceCompactionId) {
      // No agentId AND no parentToolCallId — the entry would have no
      // stable dedup key and would accumulate forever. Skip.
      return
    }

    const evidence = options.evidenceText
      ? this.extractSubAgentEvidenceLines(options.evidenceText).join(" ")
      : ""
    const formatInput: SubAgentMemoryFormatInput = {
      agentId: options.agentId,
      agentType: options.agentType,
      status: options.status,
      turnCount: options.turnCount,
      toolCallCount: options.toolCallCount,
      durationMs: options.durationMs,
      modifiedFiles: options.modifiedFiles,
      resultText: options.resultText,
      evidenceText: evidence || undefined,
      transcriptPath: options.transcriptPath,
      resultPath: options.resultPath,
    }
    const text = formatSubAgentMemoryEntry(formatInput)
    if (!text) {
      // formatSubAgentMemoryEntry only returns null when agentId is
      // empty. We already guarded above via sourceCompactionId, but
      // if the caller relied on parentToolCallId fallback the
      // formatter still requires agentId — drop in that case rather
      // than emitting a malformed entry.
      return
    }

    // Match by stable sourceCompactionId. Earlier versions used
    // `text.includes("agentId=...")` which collided when (a) the
    // same agentId appeared inside another entry's evidence text,
    // or (b) the dedup key fell back to parentToolCallId and a
    // later update brought the real agentId.
    const existingIndex = session.contextState.sessionMemory.findIndex(
      (entry) =>
        entry.kind === "sub_agent" &&
        entry.sourceCompactionId === sourceCompactionId
    )
    const entry: ContextSessionMemoryEntry = {
      id:
        existingIndex >= 0
          ? session.contextState.sessionMemory[existingIndex]!.id
          : `subagent_${crypto.randomUUID()}`,
      kind: "sub_agent",
      text,
      sourceCompactionId,
      sourceRecordId: options.parentToolCallId,
      createdAt: Date.now(),
      weight:
        typeof options.weight === "number" && Number.isFinite(options.weight)
          ? Math.max(0, Math.floor(options.weight))
          : 96,
    }

    if (existingIndex >= 0) {
      session.contextState.sessionMemory[existingIndex] = entry
    } else {
      session.contextState.sessionMemory.push(entry)
    }
    session.contextState.sessionMemory = session.contextState.sessionMemory
      .sort((a, b) => b.weight - a.weight || b.createdAt - a.createdAt)
      .slice(0, 64)
      .sort((a, b) => a.createdAt - b.createdAt)
    this.sessionManager.markContextStateDirty(session.conversationId)
  }

  private extractSubAgentEvidenceLines(text: string): string[] {
    const lines = text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
    const start = lines.findIndex((line) =>
      /^(?:Key tool evidence:|Tool calls:)/i.test(line)
    )
    if (start < 0) return []
    return lines
      .slice(start + 1)
      .filter((line) => /^\d+\.\s+/.test(line))
      .slice(0, 6)
  }

  /**
   * Reduce a single `ConversationStep` proto blob (stored as
   * `unknown` because cursor-grpc.service's proto types are private to
   * that file) to a one-line summary the parent agent can use as
   * context. Returns `undefined` for non-toolCall steps (assistant
   * text, thinking) — those are reflected in `finalText`/the IDE
   * accordion already and would only inflate the parent context.
   *
   * Defensive shape access: we treat the step as a Record<string,
   * unknown> and walk through known fields. If any of them are missing
   * we fall back to a "(unknown tool)" placeholder rather than throw,
   * because step shape may evolve with the proto schema.
   */
  private summarizeSubAgentToolStep(step: unknown): string | undefined {
    if (!step || typeof step !== "object") return undefined
    const record = step as Record<string, unknown>
    const message = record.message
    if (!message || typeof message !== "object") return undefined
    const messageRecord = message as Record<string, unknown>
    if (messageRecord.case !== "toolCall") return undefined
    const toolCall = messageRecord.value
    if (!toolCall || typeof toolCall !== "object") return undefined
    const tcRecord = toolCall as Record<string, unknown>
    const tool = tcRecord.tool
    if (!tool || typeof tool !== "object") return undefined
    const toolRecord = tool as Record<string, unknown>

    // The proto oneof case (e.g. "shellToolCall", "readToolCall") tells
    // us which family this is; strip the trailing "ToolCall" suffix to
    // recover the user-facing name.
    const protoCase =
      typeof toolRecord.case === "string" ? toolRecord.case : "unknown"
    const userFacingName = protoCase
      .replace(/ToolCall$/i, "")
      .replace(/([A-Z])/g, (_match, ch: string) => `_${ch.toLowerCase()}`)
      .replace(/^_/, "")
      .replace(/_+/g, "_")
    const toolName = userFacingName.length > 0 ? userFacingName : protoCase

    const toolValue = toolRecord.value
    if (!toolValue || typeof toolValue !== "object") {
      return `${toolName} — (no payload)`
    }
    const valueRecord = toolValue as Record<string, unknown>

    // Best-effort extraction of args + result text. We DON'T try to
    // re-implement cursor-grpc.service's per-tool projection here —
    // doing so would couple this method to every ToolCall.tool oneof
    // case. Instead pluck the most useful generic fields and call it a
    // day; per-tool prettiness is the IDE accordion's job.
    const args =
      valueRecord.args && typeof valueRecord.args === "object"
        ? (valueRecord.args as Record<string, unknown>)
        : {}
    const argsBlurb = this.summarizeToolArgs(toolName, args)

    const result =
      valueRecord.result && typeof valueRecord.result === "object"
        ? (valueRecord.result as Record<string, unknown>)
        : undefined
    const resultBlurb = result ? this.summarizeToolResult(result) : ""

    const segments: string[] = []
    if (argsBlurb) segments.push(argsBlurb)
    if (resultBlurb) segments.push(resultBlurb)
    return segments.length > 0
      ? `${toolName} — ${segments.join(" → ")}`
      : `${toolName}`
  }

  /**
   * Generic "what did the agent ask for" string. Pulls a small set of
   * commonly-meaningful fields (path, query, command, …) and clips
   * each to keep the report compact.
   */
  private summarizeToolArgs(
    toolName: string,
    args: Record<string, unknown>
  ): string {
    const clip = (value: unknown, max = 80): string => {
      const text = typeof value === "string" ? value : JSON.stringify(value)
      if (typeof text !== "string") return ""
      const single = text.replace(/\s+/g, " ").trim()
      return single.length > max ? `${single.slice(0, max - 1)}…` : single
    }

    // Per-tool quick paths: keep the most useful identifier verbatim.
    if (toolName === "shell" && typeof args.command === "string") {
      return `cmd=${clip(args.command, 100)}`
    }
    if (
      (toolName === "read" || toolName === "edit" || toolName === "delete") &&
      typeof args.path === "string"
    ) {
      return `path=${args.path}`
    }
    if (toolName === "grep" && typeof args.pattern === "string") {
      return `pattern=${clip(args.pattern, 60)}`
    }
    if (
      (toolName === "web_search" ||
        toolName === "web_fetch" ||
        toolName === "sem_search") &&
      typeof args.query === "string"
    ) {
      return `query=${clip(args.query, 80)}`
    }
    if (toolName === "task" && typeof args.subagent_type === "string") {
      return `subagent_type=${args.subagent_type}`
    }

    // Generic fallback: collect the first 3 string-valued fields.
    const parts: string[] = []
    for (const [key, value] of Object.entries(args)) {
      if (parts.length >= 3) break
      if (typeof value === "string" && value.length > 0) {
        parts.push(`${key}=${clip(value, 60)}`)
      } else if (typeof value === "number" || typeof value === "boolean") {
        parts.push(`${key}=${String(value)}`)
      }
    }
    return parts.join(", ")
  }

  /**
   * Generic "what came back" string. Looks at the Result oneof's case
   * (success/error/rejected) and tries to surface a clipped success
   * field or the error message.
   */
  private summarizeToolResult(result: Record<string, unknown>): string {
    const resultOneOf = result.result
    if (!resultOneOf || typeof resultOneOf !== "object") return ""
    const oneOfRecord = resultOneOf as Record<string, unknown>
    const oneOfCase = oneOfRecord.case
    if (typeof oneOfCase !== "string") return ""

    const value =
      oneOfRecord.value && typeof oneOfRecord.value === "object"
        ? (oneOfRecord.value as Record<string, unknown>)
        : undefined

    const clip = (text: string, max = 160): string => {
      const single = text.replace(/\s+/g, " ").trim()
      return single.length > max ? `${single.slice(0, max - 1)}…` : single
    }

    if (oneOfCase === "success") {
      if (!value) return "ok"
      // Most success messages carry one of these "summary" fields.
      const candidate =
        (typeof value.summary === "string" && value.summary) ||
        (typeof value.text === "string" && value.text) ||
        (typeof value.content === "string" && value.content) ||
        (typeof value.markdown === "string" && value.markdown) ||
        (typeof value.output === "string" && value.output) ||
        ""
      if (candidate) return `ok: ${clip(candidate)}`
      // Numeric / structural success indicators.
      const total =
        typeof value.totalCount === "number" ? value.totalCount : undefined
      if (total !== undefined) return `ok (${total} items)`
      return "ok"
    }
    if (oneOfCase === "error") {
      const errorText =
        (value && typeof value.error === "string" && value.error) ||
        (value && typeof value.message === "string" && value.message) ||
        (value &&
          typeof value.errorMessage === "string" &&
          value.errorMessage) ||
        "error"
      return `error: ${clip(errorText)}`
    }
    if (oneOfCase === "rejected") {
      const reason =
        (value && typeof value.reason === "string" && value.reason) ||
        "rejected"
      return `rejected: ${clip(reason)}`
    }
    return oneOfCase
  }

  /**
   * Classify a tool name to its DeferredToolFamily, or null if it's not deferred.
   *
   * IMPORTANT: only tools whose semantics actually match the named family
   * may be listed here. Earlier versions wrongly mapped:
   *   - read_file        -> read_semsearch_files (ID-based, not path-based)
   *   - list_dir         -> file_search          (pattern-based, not dir listing)
   *   - file_search      -> file_search          (OK)
   *   - grep_search      -> semantic_search      (semantic, not regex)
   *   - codebase_search  -> semantic_search      (OK only for codebase_search)
   * Routing read_file/list_dir/grep_search through these inline executors
   * silently fed wrong-shaped inputs into the wrong tool, which is why the
   * sub-agent loop appeared to "do nothing" – the model received nonsense
   * results, gave up, and produced only meta-thinking text.
   *
   * Tools that require an ExecServerMessage round-trip (read_file,
   * list_directory, grep_search, edit_file_v2, run_terminal_command,
   * delete_file, etc.) are NOT deferred and MUST be excluded from this map.
   * Sub-agent surface separately filters tool definitions so the model is
   * never invited to call them.
   */
  private classifyDeferredToolFamily(
    toolName: string
  ): DeferredToolFamily | null {
    const DEFERRED_TOOL_MAP: Record<string, DeferredToolFamily> = {
      command_status: "command_status",
      web_search: "web_search",
      web_fetch: "web_fetch",
      read_url_content: "read_url_content",
      view_content_chunk: "view_content_chunk",
      fetch: "fetch",
      file_search: "file_search",
      glob_search: "file_search",
      semantic_search: "semantic_search",
      deep_search: "deep_search",
      codebase_search: "semantic_search",
      read_semsearch_files: "read_semsearch_files",
      read_todos: "read_todos",
      update_todos: "update_todos",
      reflect: "reflect",
      fetch_rules: "fetch_rules",
      search_symbols: "search_symbols",
      go_to_definition: "go_to_definition",
      knowledge_base: "knowledge_base",
      fetch_pull_request: "fetch_pull_request",
      fix_lints: "fix_lints",
      read_lints: "fix_lints",
      read_project: "read_project",
      update_project: "update_project",
      get_mcp_tools: "get_mcp_tools",
      list_mcp_resource_templates: "list_mcp_resource_templates",
      ai_attribution: "ai_attribution",
      await: "await_task",
      await_task: "await_task",
      // wait_agent / kill_agent — friendlier surface for the
      // run_in_background sub-agent lifecycle. wait_agent shares the
      // same registry-aware await flow as await_task; kill_agent is a
      // bridge-defined inline tool that calls SubagentTaskRegistry.kill.
      wait_agent: "await_task",
      kill_agent: "kill_agent",
      reapply: "reapply",
      apply_agent_diff: "apply_agent_diff",
      apply_patch: "apply_patch",
      report_bugfix_results: "report_bugfix_results",
      record_screen: "record_screen",
      computer_use: "computer_use",
      start_grind_execution: "start_grind_execution",
      start_grind_planning: "start_grind_planning",
      background_composer_followup: "background_composer_followup",
      create_diagram: "create_diagram",
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

  private async executeInlineGenerateImage(
    conversationId: string,
    input: Record<string, unknown>
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
    extraData?: ParsedToolResult["inlineExtraData"]
  }> {
    const prompt = this.pickFirstString(input, ["prompt", "description"]) || ""
    if (!prompt) {
      return {
        content: "[generate_image error] Missing required prompt",
        state: { status: "error", message: "missing prompt" },
      }
    }

    try {
      const session = this.sessionManager.getSession(conversationId)
      const filePath =
        this.pickFirstString(input, ["filePath", "file_path", "path"]) || ""
      const outputFormat =
        this.pickFirstString(input, ["outputFormat", "output_format"]) || "png"
      const referenceImagePaths =
        this.pickStringArray(input, ["referenceImagePaths"]).length > 0
          ? this.pickStringArray(input, ["referenceImagePaths"])
          : this.pickStringArray(input, ["reference_image_paths"])
      const projectRoot = session?.projectContext?.rootPath || process.cwd()
      const result = await this.imageGenerationService.generateImage({
        prompt,
        model: session?.model,
        conversationId,
        outputFormat,
        referenceImagePaths,
        projectRoot,
      })

      let savedPath = filePath
      if (filePath) {
        const absolutePath = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(projectRoot, filePath)
        const fsPromises = await import("fs/promises")
        await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true })
        await fsPromises.writeFile(
          absolutePath,
          Buffer.from(result.imageData, "base64")
        )
        savedPath = absolutePath
      }

      input.filePath = savedPath || filePath
      input.file_path = savedPath || filePath
      const revisedPromptLine = result.revisedPrompt
        ? `\nrevised_prompt: ${result.revisedPrompt}`
        : ""
      const pathLine = savedPath ? `\nfile_path: ${savedPath}` : ""
      const providerLine = result.provider
        ? `\nprovider: ${result.provider}`
        : ""
      return {
        content: `[generate_image success]${pathLine}${providerLine}${revisedPromptLine}`,
        state: { status: "success" },
        extraData: {
          generateImageSuccess: {
            filePath: savedPath || filePath,
            imageData: result.imageData,
          },
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: `[generate_image error] ${message}`,
        state: { status: "error", message },
      }
    }
  }

  private async findBackgroundCommandTranscriptPath(
    command: SessionBackgroundCommand
  ): Promise<string | undefined> {
    const terminalsFolder = command.terminalsFolder?.trim()
    if (!terminalsFolder) return undefined

    try {
      const fs = await import("fs/promises")
      const entries = await fs.readdir(terminalsFolder, {
        withFileTypes: true,
      })
      const commandId = command.commandId.trim()
      if (!commandId) return undefined

      const scoreEntry = (name: string): number => {
        const normalized = name.toLowerCase()
        if (
          normalized === `${commandId}.txt` ||
          normalized === `${commandId}.log`
        ) {
          return 5
        }
        if (
          normalized.startsWith(`${commandId}.`) ||
          normalized === commandId
        ) {
          return 4
        }
        if (normalized.includes(`-${commandId}.`)) {
          return 3
        }
        if (normalized.includes(commandId)) {
          return 2
        }
        return 0
      }

      const candidate = entries
        .filter((entry) => entry.isFile())
        .map((entry) => ({
          name: entry.name,
          score: scoreEntry(entry.name),
        }))
        .filter((entry) => entry.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score || left.name.localeCompare(right.name)
        )[0]

      return candidate ? path.join(terminalsFolder, candidate.name) : undefined
    } catch {
      return undefined
    }
  }

  private async refreshBackgroundCommandTerminalOutput(
    conversationId: string,
    commandId: string
  ): Promise<SessionBackgroundCommand | undefined> {
    let command = this.sessionManager.getBackgroundCommand(
      conversationId,
      commandId
    )
    if (!command) return undefined

    const transcriptPath =
      await this.findBackgroundCommandTranscriptPath(command)
    if (!transcriptPath) return command

    try {
      const fs = await import("fs/promises")
      const transcript = await fs.readFile(transcriptPath, "utf-8")
      const existingOutputLength =
        command.stdout.join("").length + command.stderr.join("").length

      if (command.lastTerminalFileLength === undefined) {
        this.sessionManager.updateBackgroundCommandTerminalFileLength(
          conversationId,
          commandId,
          transcript.length
        )
        if (existingOutputLength === 0 && transcript.length > 0) {
          this.sessionManager.appendBackgroundCommandOutput(
            conversationId,
            commandId,
            "stdout",
            transcript
          )
        }
        return this.sessionManager.getBackgroundCommand(
          conversationId,
          commandId
        )
      }

      if (transcript.length > command.lastTerminalFileLength) {
        const delta = transcript.slice(command.lastTerminalFileLength)
        if (delta) {
          this.sessionManager.appendBackgroundCommandOutput(
            conversationId,
            commandId,
            "stdout",
            delta
          )
        }
        this.sessionManager.updateBackgroundCommandTerminalFileLength(
          conversationId,
          commandId,
          transcript.length
        )
      }
    } catch {
      return command
    }

    command = this.sessionManager.getBackgroundCommand(
      conversationId,
      commandId
    )
    return command
  }

  private async executeInlineCommandStatus(
    conversationId: string,
    input: Record<string, unknown>
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    const commandId =
      this.pickFirstString(input, ["CommandId", "commandId", "command_id"]) ||
      ""
    if (!commandId) {
      return {
        content: "[command_status error] Missing required CommandId parameter",
        state: { status: "error", message: "missing CommandId" },
      }
    }

    const requestedOutputCharacterCount = this.pickFirstNumber(input, [
      "OutputCharacterCount",
      "outputCharacterCount",
      "output_character_count",
    ])
    const outputCharacterCount = Math.max(
      0,
      Math.min(20000, requestedOutputCharacterCount ?? 4000)
    )
    const requestedWaitDurationSeconds = this.pickFirstNumber(input, [
      "WaitDurationSeconds",
      "waitDurationSeconds",
      "wait_duration_seconds",
    ])
    const waitDurationSeconds = Math.max(
      0,
      Math.min(300, requestedWaitDurationSeconds ?? 0)
    )

    let command = this.sessionManager.getBackgroundCommand(
      conversationId,
      commandId
    )
    if (!command) {
      return {
        content: `[command_status error] Unknown CommandId: ${commandId}`,
        state: { status: "error", message: "unknown CommandId" },
      }
    }

    const deadline = Date.now() + waitDurationSeconds * 1000
    do {
      if (!command.terminalsFolder && command.status === "running") {
        break
      }
      command =
        (await this.refreshBackgroundCommandTerminalOutput(
          conversationId,
          commandId
        )) || command
      if (command.status !== "running" || Date.now() >= deadline) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    } while (waitDurationSeconds > 0)

    command =
      this.sessionManager.getBackgroundCommand(conversationId, commandId) ||
      command

    const statusLine =
      command.status === "running"
        ? "running"
        : command.status === "completed"
          ? "done"
          : command.status
    const combinedOutput =
      `${command.stdout.join("")}${command.stderr.length > 0 ? `\n[stderr]\n${command.stderr.join("")}` : ""}`.trim()
    const outputTail =
      outputCharacterCount > 0 && combinedOutput.length > outputCharacterCount
        ? combinedOutput.slice(-outputCharacterCount)
        : combinedOutput

    const lines = [
      "[command_status success]",
      `CommandId: ${command.commandId}`,
      `status: ${statusLine}`,
    ]
    if (command.command) {
      lines.push(`command: ${command.command}`)
    }
    if (command.cwd) {
      lines.push(`cwd: ${command.cwd}`)
    }
    if (typeof command.pid === "number") {
      lines.push(`pid: ${command.pid}`)
    }
    if (typeof command.exitCode === "number") {
      lines.push(`exit_code: ${command.exitCode}`)
    }
    if (combinedOutput.length > outputTail.length) {
      lines.push(
        `output_truncated: ${combinedOutput.length - outputTail.length} chars omitted`
      )
    }
    if (outputTail) {
      lines.push("", outputTail)
    }

    return {
      content: lines.join("\n"),
      state: { status: "success" },
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

  /**
   * Correct the MCP tool `name` field in sub-agent tool input so it
   * matches the IDE's registered tool name. Without this, composeMcpName
   * may produce a name like "context7-resolve-library-id" when the IDE
   * expects "user-context7-resolve-library-id", causing McpToolNotFound
   * and a permanently pending ExecClientMessage waiter.
   */
  private correctMcpToolInputName(
    session: ChatSession,
    input: Record<string, unknown>
  ): Record<string, unknown> {
    if (!session.mcpToolDefs?.length) return input

    // Try to resolve the name the same way grpcService.buildExecMessageOneOf
    // will — via resolveMcpCallFieldsFromContract.
    let composedName: string | undefined
    let resolvedToolName: string | undefined
    let resolvedProvider: string | undefined
    try {
      const resolved = resolveMcpCallFieldsFromContract(input)
      composedName = resolved.name
      resolvedToolName = resolved.toolName
      resolvedProvider = resolved.providerIdentifier
    } catch {
      return input
    }

    // Check if the composed name exists in the registry
    const registeredDef = resolveMcpToolDefinition(
      session.mcpToolDefs,
      composedName
    )
    if (registeredDef) {
      // Name is already correct
      return input
    }

    // Find the correct def by matching provider + toolName
    const correctedDef = session.mcpToolDefs.find((def) => {
      if (!def || typeof def.name !== "string") return false
      const defProvider = normalizeMcpToolIdentifier(
        def.providerIdentifier || ""
      )
      const defToolName = normalizeMcpToolIdentifier(def.toolName || "")
      const reqProvider = normalizeMcpToolIdentifier(resolvedProvider || "")
      const reqToolName = normalizeMcpToolIdentifier(resolvedToolName || "")
      return (
        defToolName === reqToolName &&
        (defProvider === reqProvider ||
          defProvider.includes(reqProvider) ||
          reqProvider.includes(defProvider))
      )
    })

    if (!correctedDef) return input

    this.logger.debug(
      `[SubAgent] MCP name correction: "${composedName}" -> ` +
        `"${correctedDef.name}" (provider="${correctedDef.providerIdentifier}")`
    )

    return {
      ...input,
      name: correctedDef.name,
      toolName: correctedDef.toolName || resolvedToolName,
      providerIdentifier: correctedDef.providerIdentifier || resolvedProvider,
    }
  }

  private resolveWorkspaceRoot(conversationId: string): string {
    const allowedRoots =
      this.sessionManager.listAllowedWorkspaceRoots(conversationId)
    const firstAllowed = allowedRoots[0]
    if (firstAllowed) return firstAllowed
    const session = this.sessionManager.getSession(conversationId)
    const root = session?.projectContext?.rootPath
    return typeof root === "string" && root.trim() !== "" ? root : process.cwd()
  }

  private resolveWorkspaceFilePath(
    conversationId: string,
    filePath: string
  ): string {
    const rootPath = this.resolveWorkspaceRoot(conversationId)
    return path.isAbsolute(filePath)
      ? normalizePathForBoundaryCheck(filePath)
      : normalizePathForBoundaryCheck(path.resolve(rootPath, filePath))
  }

  private listAllowedWorkspaceRootsForMessage(
    conversationId: string,
    allowedRootsOverride?: string[]
  ): string[] {
    if (allowedRootsOverride && allowedRootsOverride.length > 0) {
      return allowedRootsOverride
    }
    const roots = this.sessionManager.listAllowedWorkspaceRoots(conversationId)
    if (roots.length > 0) return roots
    return [this.resolveWorkspaceRoot(conversationId)]
  }

  private isPathWithinAllowedWorkspaceRoots(
    conversationId: string,
    candidatePath: string,
    allowedRootsOverride?: string[]
  ): boolean {
    return isPathWithinAllowedRoots(
      candidatePath,
      this.listAllowedWorkspaceRootsForMessage(
        conversationId,
        allowedRootsOverride
      )
    )
  }

  private formatAllowedWorkspaceRootsForError(
    conversationId: string,
    allowedRootsOverride?: string[]
  ): string {
    return this.listAllowedWorkspaceRootsForMessage(
      conversationId,
      allowedRootsOverride
    )
      .map((root) => `- ${root}`)
      .join("\n")
  }

  private formatAdditionalWorkingDirectoriesPrompt(
    allowedWorkspaceRoots: string[],
    primaryWorkspaceRoot?: string
  ): string {
    // Only inject roots that are genuinely "additional" — i.e. not
    // the primary workspace root the sub-agent already uses as cwd.
    // Including the primary root would waste tokens and mislead the
    // LLM into thinking it's an "extra" directory.
    const additional = primaryWorkspaceRoot
      ? allowedWorkspaceRoots.filter((root) => root !== primaryWorkspaceRoot)
      : allowedWorkspaceRoots
    if (additional.length === 0) return ""
    return (
      "\n\nAdditional working directories (you may read/search/list files in these paths):\n" +
      additional.map((root) => `- ${root}`).join("\n") +
      "\n"
    )
  }

  private async executeSubAgentBridgeInlineTool(
    conversationId: string,
    toolName: string,
    input: Record<string, unknown>,
    allowedRootsOverride?: string[]
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
    extraData?: ToolCompletedExtraData
  } | null> {
    switch (toolName) {
      case "grep_search":
        return this.executeInlineSubAgentGrepSearch(
          conversationId,
          input,
          allowedRootsOverride
        )
      case "read_file":
      case "read_file_v2":
        return this.executeInlineSubAgentReadFile(
          conversationId,
          input,
          allowedRootsOverride
        )
      case "list_directory":
      case "list_dir":
        return this.executeInlineSubAgentListDirectory(
          conversationId,
          input,
          allowedRootsOverride
        )
      case "run_terminal_command":
      case "run_terminal_command_v2":
        // Cursor IDE's ExecServerMessage shell path does not respond to
        // sub-agent owned tool calls (the IDE drops both shellArgs and
        // shellStreamArgs envelopes silently when the parent ownership
        // routes through SubagentExecBridge). Until we migrate to the
        // first-class subagentArgs / subagentResult protocol path
        // (which IDE-side cursor-agent-exec already implements — the
        // exec runs the whole sub-agent in-IDE so shell is just one of
        // its native tools), we execute run_terminal_command directly
        // inside the bridge process via child_process.spawn. This
        // mirrors claude-code's built-in BashTool: shell runs locally
        // in the agent runtime, not over an external IDE protocol.
        return this.executeInlineSubAgentRunTerminalCommand(
          conversationId,
          input
        )
      default:
        return null
    }
  }

  private buildSubAgentWorkspaceTarget(
    conversationId: string,
    requestedPath: string | undefined,
    fallbackToRoot: boolean,
    allowedRootsOverride?: string[]
  ):
    | { rootPath: string; absPath: string; displayPath: string }
    | { error: string; message: string } {
    const rootPath = this.resolveWorkspaceRoot(conversationId)
    const rawPath = requestedPath?.trim()
    if (!rawPath && !fallbackToRoot) {
      return { error: "missing path", message: "Missing required path" }
    }

    const absPath = rawPath
      ? this.resolveWorkspaceFilePath(conversationId, rawPath)
      : rootPath
    if (
      !this.isPathWithinAllowedWorkspaceRoots(
        conversationId,
        absPath,
        allowedRootsOverride
      )
    ) {
      return {
        error: "path outside workspace",
        message:
          `Path must stay within one of the allowed working directories: ${rawPath || absPath}\n\n` +
          `Allowed working directories:\n${this.formatAllowedWorkspaceRootsForError(conversationId, allowedRootsOverride)}\n\n` +
          `To grant access to another directory, add it to the Cursor workspace or call ` +
          `POST /api/context/${conversationId}/working-directories with { "paths": ["/path/to/dir"] }.`,
      }
    }

    const displayRoot =
      this.listAllowedWorkspaceRootsForMessage(
        conversationId,
        allowedRootsOverride
      ).find((root) => isPathWithinAllowedRoots(absPath, [root])) || rootPath
    const relPath = path
      .relative(path.resolve(displayRoot), path.resolve(absPath))
      .replace(/\\/g, "/")
    return {
      rootPath: displayRoot,
      absPath,
      displayPath: relPath.length > 0 ? relPath : ".",
    }
  }

  private executeInlineSubAgentGrepSearch(
    conversationId: string,
    input: Record<string, unknown>,
    allowedRootsOverride?: string[]
  ): {
    content: string
    state: { status: ToolResultStatus; message?: string }
    extraData?: ToolCompletedExtraData
  } {
    const query =
      this.pickFirstString(input, [
        "query",
        "Query",
        "pattern",
        "searchTerm",
        "search_term",
      ]) || ""
    if (!query) {
      return {
        content: "[grep_search error] Missing required query",
        state: { status: "error", message: "missing query" },
      }
    }

    const target = this.buildSubAgentWorkspaceTarget(
      conversationId,
      this.pickToolPath(input) || undefined,
      true,
      allowedRootsOverride
    )
    if ("error" in target) {
      return {
        content: `[grep_search error] ${target.message}`,
        state: { status: "error", message: target.error },
      }
    }

    const caseSensitive = this.pickFirstBoolean(input, [
      "case_sensitive",
      "caseSensitive",
    ])
    const targetArg =
      target.displayPath === "." ? "." : target.displayPath.replace(/\\/g, "/")
    const args = [
      "--line-number",
      "--column",
      "--no-heading",
      "--color",
      "never",
      "--hidden",
      "--max-columns",
      "240",
      "--max-count",
      "200",
      "--glob",
      "!.git/**",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!dist/**",
      "--glob",
      "!build/**",
      "--glob",
      "!.next/**",
    ]
    if (caseSensitive === false) {
      args.push("--ignore-case")
    }
    args.push("--", query, targetArg)

    const result = spawnSync("rg", args, {
      cwd: target.rootPath,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
    })
    if (result.error) {
      const message = result.error.message || "failed to execute ripgrep"
      return {
        content: `[grep_search error] ${message}`,
        state: { status: "error", message },
      }
    }

    const stdout = typeof result.stdout === "string" ? result.stdout : ""
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : ""
    if (result.status !== 0 && result.status !== 1) {
      const message = stderr || `ripgrep exited with ${result.status}`
      return {
        content: `[grep_search error] ${message}`,
        state: { status: "error", message },
      }
    }

    const lines = stdout.trimEnd() ? stdout.trimEnd().split(/\r?\n/) : []
    const previewLines = lines.slice(0, 120)
    const omitted = Math.max(0, lines.length - previewLines.length)
    input.query = query
    input.path = target.displayPath
    input.case_sensitive = caseSensitive
    input.matches = previewLines
    input.total_matches = lines.length
    input.totalMatches = lines.length
    input.truncated = omitted > 0

    const preview =
      previewLines.length > 0 ? previewLines.join("\n") : "- (no matches)"
    const omittedLine = omitted > 0 ? `\nomitted=${omitted}` : ""
    const workspaceResults = this.buildInlineSubAgentGrepWorkspaceResults(
      target.rootPath,
      previewLines
    )
    return {
      content:
        `[grep_search success] query=${query} path=${target.displayPath} ` +
        `total=${lines.length}${omittedLine}\n${preview}`,
      state: { status: "success" },
      extraData: {
        grepSuccess: {
          pattern: query,
          path: target.displayPath,
          outputMode: "content",
          workspaceResults,
        },
      },
    }
  }

  private buildInlineSubAgentGrepWorkspaceResults(
    workspaceKey: string,
    lines: string[]
  ): Record<string, unknown> {
    const resultsByFile = new Map<string, Array<Record<string, unknown>>>()
    for (const line of lines) {
      const match = /^(.+?):(\d+):(\d+):(.*)$/.exec(line)
      if (!match) continue
      const filePath = match[1] || ""
      if (!filePath) continue
      const lineNumber = Number(match[2] || 0)
      const content = match[4] || ""
      const matches = resultsByFile.get(filePath) || []
      matches.push({
        lineNumber,
        content,
        contentTruncated: false,
        isContextLine: false,
      })
      resultsByFile.set(filePath, matches)
    }

    return {
      [workspaceKey || "workspace"]: {
        result: {
          case: "content",
          value: {
            totalMatchedLines: lines.length,
            totalLines: lines.length,
            clientTruncated: false,
            ripgrepTruncated: false,
            matches: Array.from(resultsByFile.entries()).map(
              ([filePath, matches]) => ({
                file: filePath,
                matches,
              })
            ),
          },
        },
      },
    }
  }

  private executeInlineSubAgentReadFile(
    conversationId: string,
    input: Record<string, unknown>,
    allowedRootsOverride?: string[]
  ): {
    content: string
    state: { status: ToolResultStatus; message?: string }
    extraData?: ToolCompletedExtraData
  } {
    const target = this.buildSubAgentWorkspaceTarget(
      conversationId,
      this.pickToolPath(input) || undefined,
      false,
      allowedRootsOverride
    )
    if ("error" in target) {
      return {
        content: `[read_file error] ${target.message}`,
        state: { status: "error", message: target.error },
      }
    }

    try {
      const stat = statSync(target.absPath)
      if (!stat.isFile()) {
        return {
          content: `[read_file error] Path is not a file: ${target.displayPath}`,
          state: { status: "error", message: "path is not a file" },
        }
      }
      const content = readFileSync(target.absPath, "utf8")
      const lines = content.length > 0 ? content.split(/\r?\n/) : []
      const startLine = Math.max(
        1,
        this.pickFirstNumber(input, ["start_line", "startLine"]) || 1
      )
      const requestedEnd = this.pickFirstNumber(input, ["end_line", "endLine"])
      const endLine = Math.min(
        lines.length,
        requestedEnd || Math.min(lines.length, startLine + 399)
      )
      if (lines.length > 0 && endLine < startLine) {
        return {
          content: `[read_file error] Invalid line range: ${startLine}-${endLine}`,
          state: { status: "error", message: "invalid line range" },
        }
      }

      const selected = lines.slice(startLine - 1, endLine)
      const numbered = selected
        .map((line, index) => `${startLine + index}: ${line}`)
        .join("\n")
      input.path = target.displayPath
      input.start_line = startLine
      input.end_line = endLine
      input.total_lines = lines.length
      input.truncated =
        !requestedEnd && lines.length > 0 && endLine < lines.length

      const truncatedLine = input.truncated
        ? `\ntruncated=true next_start_line=${endLine + 1}`
        : ""
      return {
        content:
          `[read_file success] path=${target.displayPath} ` +
          `lines=${lines.length > 0 ? `${startLine}-${endLine}` : "0-0"} ` +
          `total_lines=${lines.length}${truncatedLine}\n` +
          (numbered || "- (empty file)"),
        state: { status: "success" },
        extraData: {
          readSuccess: {
            path: target.displayPath,
            content: selected.join("\n"),
            totalLines: lines.length,
            fileSize: stat.size,
            truncated: !!input.truncated,
            rangeApplied: startLine > 1 || requestedEnd != null,
          },
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: `[read_file error] ${message}`,
        state: { status: "error", message },
      }
    }
  }

  private async executeInlineSubAgentListDirectory(
    conversationId: string,
    input: Record<string, unknown>,
    allowedRootsOverride?: string[]
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
    extraData?: ToolCompletedExtraData
  }> {
    const target = this.buildSubAgentWorkspaceTarget(
      conversationId,
      this.pickToolPath(input) || ".",
      true,
      allowedRootsOverride
    )
    if ("error" in target) {
      return {
        content: `[list_directory error] ${target.message}`,
        state: { status: "error", message: target.error },
      }
    }

    try {
      const stat = statSync(target.absPath)
      if (!stat.isDirectory()) {
        return {
          content: `[list_directory error] Path is not a directory: ${target.displayPath}`,
          state: { status: "error", message: "path is not a directory" },
        }
      }

      const fs = await import("fs/promises")
      const recursive =
        this.pickFirstBoolean(input, ["recursive", "Recursive"]) || false
      const maxEntries = 200
      const skipDirs = new Set([
        ".git",
        "node_modules",
        "dist",
        "build",
        ".next",
      ])
      const entries: string[] = []
      const visit = async (
        absDir: string,
        relPrefix: string,
        depth: number
      ): Promise<void> => {
        if (entries.length >= maxEntries) return
        const dirEntries = await fs.readdir(absDir, { withFileTypes: true })
        dirEntries.sort((a, b) => a.name.localeCompare(b.name))
        for (const entry of dirEntries) {
          if (entries.length >= maxEntries) return
          const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
          if (entry.isDirectory()) {
            entries.push(`${rel}/`)
            if (recursive && depth < 3 && !skipDirs.has(entry.name)) {
              await visit(path.join(absDir, entry.name), rel, depth + 1)
            }
          } else {
            entries.push(rel)
          }
        }
      }
      await visit(target.absPath, "", 0)

      input.path = target.displayPath
      input.recursive = recursive
      input.entries = entries
      input.total_entries = entries.length
      input.totalEntries = entries.length
      input.truncated = entries.length >= maxEntries

      const preview =
        entries.length > 0
          ? entries.map((entry) => `- ${entry}`).join("\n")
          : "- (empty directory)"
      const truncatedLine = input.truncated ? "\ntruncated=true" : ""
      return {
        content:
          `[list_directory success] path=${target.displayPath} ` +
          `recursive=${recursive} entries=${entries.length}${truncatedLine}\n` +
          preview,
        state: { status: "success" },
        extraData: {
          lsDirectoryTreeRoot: this.buildInlineSubAgentLsDirectoryTreeRoot(
            target.absPath,
            entries
          ),
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: `[list_directory error] ${message}`,
        state: { status: "error", message },
      }
    }
  }

  /**
   * Sub-agent's `run_terminal_command` runs in-process via
   * child_process.spawn. We do this because Cursor IDE's
   * ExecServerMessage shell path silently drops sub-agent owned tool
   * calls (see comment at the dispatch site for the protocol-level
   * reason). Once we migrate sub-agent dispatch to the first-class
   * `subagentArgs` / `subagentResult` ExecServerMessage path the IDE
   * already implements, the entire sub-agent (LLM + tools, including
   * shell) will run in-IDE and this method becomes dead code.
   *
   * Behaviour matches what a top-level `run_terminal_command` user
   * expects:
   *   - command runs through `bash -c` so pipes / && / quoting work
   *   - cwd defaults to the workspace root, can be overridden by args
   *   - hard timeout (60s) so a runaway command does not pin the
   *     sub-agent indefinitely
   *   - stdout/stderr captured separately, truncated at 256KB each
   *   - exit code reported in the tool_result text the LLM sees
   *
   * Safety:
   *   - cwd is constrained to within the workspace root (no `cd ..`
   *     escape hatch via args), matching grep / read / list policy
   *   - PATH inherited from the bridge process so the sub-agent has
   *     access to the same binaries the user invoked the IDE with
   *   - no shell expansion of args beyond what `bash -c` itself does
   *     (the LLM owns the command string verbatim)
   */
  private async executeInlineSubAgentRunTerminalCommand(
    conversationId: string,
    input: Record<string, unknown>
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
    extraData?: ToolCompletedExtraData
  }> {
    const command = this.pickFirstString(input, ["command", "cmd"]) || ""
    if (!command.trim()) {
      return {
        content: "[run_terminal_command error] Missing required command",
        state: { status: "error", message: "missing command" },
      }
    }

    // Resolve cwd. If the model passed an explicit cwd we constrain it
    // to the workspace; otherwise default to the workspace root. This
    // is the same policy the read/grep/ls inline tools enforce so the
    // sub-agent can never poke around outside the project tree.
    const requestedCwd = this.pickFirstString(input, [
      "cwd",
      "workdir",
      "working_directory",
      "workingDirectory",
    ])
    const target = this.buildSubAgentWorkspaceTarget(
      conversationId,
      requestedCwd || undefined,
      true
    )
    if ("error" in target) {
      return {
        content: `[run_terminal_command error] ${target.message}`,
        state: { status: "error", message: target.error },
      }
    }

    // Verify cwd is a directory — child_process.spawn will fail with a
    // confusing ENOTDIR otherwise.
    try {
      const cwdStat = statSync(target.absPath)
      if (!cwdStat.isDirectory()) {
        return {
          content:
            `[run_terminal_command error] cwd is not a directory: ` +
            target.displayPath,
          state: { status: "error", message: "cwd is not a directory" },
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: `[run_terminal_command error] cwd does not exist: ${message}`,
        state: { status: "error", message },
      }
    }

    const HARD_TIMEOUT_MS = 60_000
    const MAX_STREAM_BYTES = 256 * 1024 // 256 KB per stream
    const startedAtMs = Date.now()

    type SpawnOutcome = {
      exitCode: number | null
      signal: NodeJS.Signals | null
      stdout: string
      stderr: string
      stdoutTruncated: boolean
      stderrTruncated: boolean
      timedOut: boolean
      spawnError?: Error
    }

    const outcome = await new Promise<SpawnOutcome>((resolve) => {
      const child = spawn("bash", ["-c", command], {
        cwd: target.absPath,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      })

      let stdout = ""
      let stderr = ""
      let stdoutTruncated = false
      let stderrTruncated = false
      let timedOut = false
      let settled = false

      const timer = setTimeout(() => {
        timedOut = true
        try {
          child.kill("SIGKILL")
        } catch {
          // best-effort kill; if the kill itself throws there's not
          // much we can do — the resolve below still fires off the
          // child's `close` event.
        }
      }, HARD_TIMEOUT_MS)

      const settle = (partial: Partial<SpawnOutcome>) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          exitCode: null,
          signal: null,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          timedOut,
          ...partial,
        })
      }

      child.stdout?.on("data", (data: Buffer) => {
        if (stdoutTruncated) return
        const remaining = MAX_STREAM_BYTES - stdout.length
        if (remaining <= 0) {
          stdoutTruncated = true
          return
        }
        const chunk = data.toString("utf8")
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining)
          stdoutTruncated = true
        } else {
          stdout += chunk
        }
      })
      child.stderr?.on("data", (data: Buffer) => {
        if (stderrTruncated) return
        const remaining = MAX_STREAM_BYTES - stderr.length
        if (remaining <= 0) {
          stderrTruncated = true
          return
        }
        const chunk = data.toString("utf8")
        if (chunk.length > remaining) {
          stderr += chunk.slice(0, remaining)
          stderrTruncated = true
        } else {
          stderr += chunk
        }
      })
      child.on("error", (err) => {
        // spawn-level error (e.g. ENOENT for `bash` itself) — settle
        // immediately rather than wait for `close`.
        settle({ spawnError: err })
      })
      child.on("close", (code, signal) => {
        settle({ exitCode: code, signal })
      })
    })

    const durationMs = Date.now() - startedAtMs
    input.command = command
    input.cwd = target.displayPath
    input.exit_code = outcome.exitCode
    input.exitCode = outcome.exitCode
    input.signal = outcome.signal
    input.duration_ms = durationMs
    input.durationMs = durationMs
    input.timed_out = outcome.timedOut
    input.timedOut = outcome.timedOut
    input.stdout_truncated = outcome.stdoutTruncated
    input.stdoutTruncated = outcome.stdoutTruncated
    input.stderr_truncated = outcome.stderrTruncated
    input.stderrTruncated = outcome.stderrTruncated

    if (outcome.spawnError) {
      const message = outcome.spawnError.message || "spawn failed"
      return {
        content: `[run_terminal_command error] ${message}`,
        state: { status: "error", message },
      }
    }

    if (outcome.timedOut) {
      const message = `command timed out after ${HARD_TIMEOUT_MS}ms`
      return {
        content:
          `[run_terminal_command error] ${message}\n` +
          this.formatSubAgentShellStreams(
            outcome.stdout,
            outcome.stderr,
            outcome.stdoutTruncated,
            outcome.stderrTruncated
          ),
        state: { status: "error", message },
      }
    }

    const exitCode = outcome.exitCode ?? -1
    const status: ToolResultStatus = exitCode === 0 ? "success" : "error"
    const headerStatus =
      status === "success" ? "success" : `failure exit_code=${exitCode}`
    const signalLine = outcome.signal ? ` signal=${outcome.signal}` : ""
    const header =
      `[run_terminal_command ${headerStatus}] cwd=${target.displayPath} ` +
      `duration_ms=${durationMs}${signalLine}`
    return {
      content: `${header}\n${this.formatSubAgentShellStreams(
        outcome.stdout,
        outcome.stderr,
        outcome.stdoutTruncated,
        outcome.stderrTruncated
      )}`,
      state: {
        status,
        message:
          status === "error" ? `command exited with ${exitCode}` : undefined,
      },
    }
  }

  /**
   * Format the captured stdout/stderr from an in-process sub-agent
   * shell invocation into a single block that's friendly for the LLM
   * to reason about. Mirrors the layout we use elsewhere for shell
   * results so the sub-agent's tool_result history looks consistent.
   */
  private formatSubAgentShellStreams(
    stdout: string,
    stderr: string,
    stdoutTruncated: boolean,
    stderrTruncated: boolean
  ): string {
    const parts: string[] = []
    if (stdout.length > 0) {
      parts.push("--- stdout ---")
      parts.push(stdout.trimEnd())
      if (stdoutTruncated) parts.push("(stdout truncated)")
    }
    if (stderr.length > 0) {
      parts.push("--- stderr ---")
      parts.push(stderr.trimEnd())
      if (stderrTruncated) parts.push("(stderr truncated)")
    }
    if (parts.length === 0) {
      parts.push("(no output)")
    }
    return parts.join("\n")
  }

  private buildInlineSubAgentLsDirectoryTreeRoot(
    absPath: string,
    entries: string[]
  ): Record<string, unknown> {
    const topLevelDirs = new Set<string>()
    const topLevelFiles = new Set<string>()
    const extensionCounts = new Map<string, number>()
    let fileCount = 0

    for (const entry of entries) {
      const normalized = entry.replace(/\\/g, "/")
      const topLevelName = normalized.replace(/\/.*$/g, "").replace(/\/$/g, "")
      if (!topLevelName) continue
      if (normalized.endsWith("/")) {
        topLevelDirs.add(topLevelName)
        continue
      }
      fileCount += 1
      if (!normalized.includes("/")) {
        topLevelFiles.add(topLevelName)
      }
      const ext = path.extname(normalized).replace(/^\./, "") || "(none)"
      extensionCounts.set(ext, (extensionCounts.get(ext) || 0) + 1)
    }

    return {
      absPath,
      childrenDirs: Array.from(topLevelDirs)
        .sort()
        .map((name) => ({
          name,
          absPath: path.join(absPath, name),
          childrenDirs: [],
          childrenFiles: [],
          childrenWereProcessed: false,
          fullSubtreeExtensionCounts: {},
          numFiles: 0,
        })),
      childrenFiles: Array.from(topLevelFiles)
        .sort()
        .map((name) => ({ name })),
      childrenWereProcessed: true,
      fullSubtreeExtensionCounts: Object.fromEntries(extensionCounts),
      numFiles: fileCount,
    }
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

  private executeInlineApplyPatch(
    conversationId: string,
    input: Record<string, unknown>
  ): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const patch = this.pickFirstString(input, ["patch", "diff", "input"]) || ""
    if (!patch) {
      return {
        content: "[apply_patch error] Missing patch payload",
        state: { status: "error", message: "missing patch" },
      }
    }

    const result = spawnSync("apply_patch", {
      cwd: this.resolveWorkspaceRoot(conversationId),
      input: patch,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    })

    if (result.error) {
      const message = result.error.message || "failed to execute apply_patch"
      input.applied = false
      input.exit_code = result.status ?? null
      input.stderr = message
      return {
        content: `[apply_patch error] ${message}`,
        state: { status: "error", message },
      }
    }

    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : ""
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : ""
    const succeeded = result.status === 0
    input.applied = succeeded
    input.exit_code = result.status ?? null
    input.stdout = stdout
    input.stderr = stderr

    const body =
      stdout ||
      stderr ||
      (succeeded ? "Patch applied successfully" : "Patch failed")
    return {
      content: body,
      state: {
        status: succeeded ? "success" : "error",
        message: succeeded ? undefined : body,
      },
    }
  }

  private executeInlineUpdatePlan(
    conversationId: string,
    input: Record<string, unknown>
  ): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const rawPlan = Array.isArray(input.plan) ? input.plan : []
    const nowTs = Date.now()
    const todos = rawPlan.flatMap((entry, index) => {
      if (!entry || typeof entry !== "object") return []
      const item = entry as Record<string, unknown>
      const step =
        this.pickFirstString(item, ["step", "content", "title", "name"]) || ""
      if (!step) return []
      return [
        {
          id:
            this.pickFirstString(item, ["id", "todo_id", "todoId"]) ||
            `plan_${index + 1}`,
          content: step,
          status: this.normalizeTodoStatus(item.status),
          createdAt: nowTs,
          updatedAt: nowTs,
          dependencies: this.pickStringArray(item, [
            "dependencies",
            "depends_on",
            "dependsOn",
          ]),
        },
      ]
    })

    if (todos.length === 0) {
      return {
        content: "[update_plan error] Missing required plan items",
        state: { status: "error", message: "missing plan items" },
      }
    }

    const todoWriteInput: Record<string, unknown> = {
      merge: false,
      todos,
    }
    const todoWriteResult = this.executeInlineTodoWrite(
      conversationId,
      todoWriteInput
    )
    input.explanation = this.pickFirstString(input, ["explanation"]) || ""
    input.todos = todoWriteInput.todos
    input.updated_todos = todoWriteInput.updated_todos
    input.updatedTodos = todoWriteInput.updatedTodos
    input.total_count = todoWriteInput.total_count
    input.totalCount = todoWriteInput.totalCount

    return {
      content:
        todoWriteResult.state.status === "success"
          ? "Plan updated"
          : todoWriteResult.content,
      state: todoWriteResult.state,
    }
  }

  private executeInlineListMcpResourceTemplates(
    input: Record<string, unknown>
  ): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const server =
      this.pickFirstString(input, ["server", "serverName", "server_name"]) || ""
    input.server = server
    input.templates = []
    input.total_count = 0
    input.totalCount = 0
    return {
      content: JSON.stringify(
        {
          total: 0,
          templates: [],
          ...(server ? { server } : {}),
        },
        null,
        2
      ),
      state: { status: "success" },
    }
  }

  private executeInlineViewImage(
    conversationId: string,
    input: Record<string, unknown>
  ): {
    content: string
    state: { status: ToolResultStatus; message?: string }
    historyContent?: ParsedToolResult["inlineHistoryContent"]
  } {
    const requestedPath = this.pickFirstString(input, ["path"]) || ""
    if (!requestedPath) {
      return {
        content: "[view_image error] Missing required path",
        state: { status: "error", message: "missing path" },
      }
    }

    const requestedDetail = this.pickFirstString(input, ["detail"]) || undefined
    if (requestedDetail && requestedDetail !== "original") {
      return {
        content:
          "view_image.detail only supports `original`; omit `detail` for default resized behavior",
        state: {
          status: "error",
          message:
            "view_image.detail only supports `original`; omit `detail` for default resized behavior",
        },
      }
    }

    const resolvedPath = this.resolveWorkspaceFilePath(
      conversationId,
      requestedPath
    )
    if (!this.isPathWithinAllowedWorkspaceRoots(conversationId, resolvedPath)) {
      return {
        content:
          `[view_image error] Path must stay within one of the allowed working directories: ${requestedPath}\n\n` +
          `Allowed working directories:\n${this.formatAllowedWorkspaceRootsForError(conversationId)}`,
        state: {
          status: "permission_denied",
          message: "path outside allowed working directories",
        },
      }
    }
    try {
      const stats = statSync(resolvedPath)
      if (!stats.isFile()) {
        return {
          content: `[view_image error] Not a file: ${resolvedPath}`,
          state: { status: "invalid_file", message: "not a file" },
        }
      }
      const imageBytes = readFileSync(resolvedPath)
      const imageBase64 = imageBytes.toString("base64")
      const mediaType = this.resolveImageMediaType(resolvedPath, imageBytes)
      input.path = resolvedPath
      input.exists = true
      input.file_size = stats.size
      if (requestedDetail === "original") {
        input.detail = "original"
      }
      return {
        content: `[view_image success] path=${resolvedPath}\nsize=${stats.size}`,
        state: { status: "success" },
        historyContent: [
          {
            type: "image",
            ...(requestedDetail === "original" ? { detail: "original" } : {}),
            source: {
              type: "base64",
              media_type: mediaType,
              data: imageBase64,
            },
          },
        ],
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: `[view_image error] ${message}`,
        state: { status: "file_not_found", message },
      }
    }
  }

  private executeInlineSpawnAgent(
    conversationId: string,
    input: Record<string, unknown>
  ): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const message = this.buildSyntheticCodexAgentMessage(input)
    if (!message) {
      return {
        content: "[spawn_agent error] Missing required message/items",
        state: { status: "error", message: "missing message/items" },
      }
    }

    const agentId = `codex-agent-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    const now = Date.now()
    const agentType =
      this.pickFirstString(input, ["agent_type", "agentType"]) || "default"
    const nickname =
      this.pickFirstString(input, ["nickname"]) ||
      `${agentType}-agent-${agentId.slice(-4)}`
    const model = this.pickFirstString(input, ["model"]) || ""

    const agent: SyntheticCodexAgentState = {
      agentId,
      conversationId,
      status: "completed",
      createdAt: now,
      updatedAt: now,
      nickname,
      agentType,
      model: model || undefined,
      message:
        "Asynchronous sub-agent execution is not available in this proxy runtime.",
      lastInput: message,
    }
    this.syntheticCodexAgents.set(agentId, agent)

    input.agent_id = agentId
    input.id = agentId
    input.nickname = nickname
    return {
      content:
        `[spawn_agent success]\n` +
        JSON.stringify(this.buildSyntheticCodexAgentPayload(agent), null, 2),
      state: { status: "success" },
    }
  }

  private executeInlineSendAgentInput(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const target = this.pickFirstString(input, ["target"]) || ""
    const agent = this.syntheticCodexAgents.get(target)
    if (!agent) {
      return {
        content: `[send_input error] Agent not found: ${target}`,
        state: { status: "error", message: "agent not found" },
      }
    }
    if (agent.status === "closed") {
      return {
        content: `[send_input error] Agent is closed: ${target}`,
        state: { status: "error", message: "agent is closed" },
      }
    }

    agent.lastInput = this.buildSyntheticCodexAgentMessage(input)
    agent.updatedAt = Date.now()
    this.syntheticCodexAgents.set(target, agent)
    return {
      content:
        `[send_input success]\n` +
        JSON.stringify(this.buildSyntheticCodexAgentPayload(agent), null, 2),
      state: { status: "success" },
    }
  }

  private executeInlineResumeAgent(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const id = this.pickFirstString(input, ["id"]) || ""
    const agent = this.syntheticCodexAgents.get(id)
    if (!agent) {
      return {
        content: `[resume_agent error] Agent not found: ${id}`,
        state: { status: "error", message: "agent not found" },
      }
    }
    if (agent.status === "closed") {
      agent.status = "completed"
    }
    agent.updatedAt = Date.now()
    this.syntheticCodexAgents.set(id, agent)
    return {
      content:
        `[resume_agent success]\n` +
        JSON.stringify(this.buildSyntheticCodexAgentPayload(agent), null, 2),
      state: { status: "success" },
    }
  }

  private executeInlineWaitAgent(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const targets = this.pickStringArray(input, ["targets", "target"])
    const matchedAgents = targets
      .map((target) => this.syntheticCodexAgents.get(target))
      .filter((agent): agent is SyntheticCodexAgentState => !!agent)

    if (matchedAgents.length === 0) {
      return {
        content: "[wait_agent error] Agent not found",
        state: { status: "error", message: "agent not found" },
      }
    }

    const completedAgent = matchedAgents.find(
      (agent) => agent.status === "completed" || agent.status === "closed"
    )
    if (!completedAgent) {
      return {
        content: `[wait_agent success]\n${JSON.stringify({ status: "" }, null, 2)}`,
        state: { status: "success" },
      }
    }

    return {
      content:
        `[wait_agent success]\n` +
        JSON.stringify(
          this.buildSyntheticCodexAgentPayload(completedAgent),
          null,
          2
        ),
      state: { status: "success" },
    }
  }

  private executeInlineCloseAgent(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const target = this.pickFirstString(input, ["target"]) || ""
    const agent = this.syntheticCodexAgents.get(target)
    if (!agent) {
      return {
        content: `[close_agent error] Agent not found: ${target}`,
        state: { status: "error", message: "agent not found" },
      }
    }

    agent.status = "closed"
    agent.updatedAt = Date.now()
    this.syntheticCodexAgents.set(target, agent)
    return {
      content:
        `[close_agent success]\n` +
        JSON.stringify(this.buildSyntheticCodexAgentPayload(agent), null, 2),
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
    const session = this.sessionManager.getSession(conversationId)
    const requestedSkillName = this.pickFirstString(input, [
      "skill_name",
      "skillName",
      "name",
    ])
    if (requestedSkillName) {
      const skill = this.cursorSkillsManager.findByName(
        session?.cursorRules,
        requestedSkillName
      )
      if (!skill || !session) {
        const message = `Cursor skill not found: ${requestedSkillName}`
        return {
          content: `[fetch_rules error] ${message}`,
          state: { status: "error", message },
        }
      }

      this.cursorSkillsManager.activate(session, skill.name, "fetch_rules")
      input.skill_name = skill.name
      input.path = skill.fullPath
      input.content = skill.content
      return {
        content:
          `[fetch_rules success] skill=${skill.name}\n` +
          (skill.fullPath
            ? `Base directory for this skill: ${path.dirname(skill.fullPath)}\n\n`
            : "") +
          skill.content,
        state: { status: "success" },
      }
    }

    const rootPath = this.resolveWorkspaceRoot(conversationId)
    const candidates = [
      ".cursor/rules",
      ".cursor/rules.md",
      ".cursorrules",
      ".cursor/AGENTS.md",
      "AGENTS.md",
      ".agent/rules.md",
    ]
    const diskRules: Array<{
      path: string
      content: string
      source: "workspace_disk"
    }> = []
    for (const candidate of candidates) {
      const snippet = await this.readWorkspaceFileSnippet(
        rootPath,
        candidate,
        3_500
      )
      if (snippet) {
        diskRules.push({ ...snippet, source: "workspace_disk" })
      }
    }

    const skillPolicy = this.cursorSkillsManager.resolvePolicy({
      rules: session?.cursorRules,
      selectedRulePaths: session?.selectedCursorRulePaths,
      selectedRuleNames: session?.selectedCursorRuleNames,
      activeSkillNames: session?.activeCursorSkillNames,
      projectRoot: session?.projectContext?.rootPath,
      contextPaths: (session?.codeChunks || []).map((chunk) => chunk.path),
    })

    // Surface every rule that is actually injected into the LLM system
    // prompt — `skillPolicy.promptRules` is the same source of truth used
    // by `resolveEffectiveRulesForPrompt`. Without this the agent's
    // `fetch_rules` self-inspection returns `total=0` even when the IDE
    // has injected `global` / `fileGlobbed` / `manuallyAttached` rules
    // that are constraining behaviour.
    const idePromptRules = (skillPolicy.promptRules || []).map((rule) => ({
      path: rule.fullPath || "(IDE-injected rule)",
      content: this.truncateText(rule.content || "", 3_500),
      source: "ide_injected" as const,
      type: rule.type?.type.case || "unknown",
    }))

    // Dedup by content so a rule that exists both on disk and in the
    // IDE-injected list isn't double-counted.
    const seenContent = new Set<string>()
    const allRules: Array<{
      path: string
      content: string
      source: "workspace_disk" | "ide_injected"
      type?: string
    }> = []
    for (const rule of [...diskRules, ...idePromptRules]) {
      const key = rule.content.trim()
      if (!key || seenContent.has(key)) continue
      seenContent.add(key)
      allRules.push(rule)
    }

    input.rules = allRules
    input.total_count = allRules.length
    input.totalCount = allRules.length
    input.path = allRules[0]?.path || ""

    // 当 LLM 提供 query/description 时，用 minisearch 给 Skill 列表打分排序，
    // 把最相关的 Skill 排在最前面，缓解「不知道自己不知道」的问题。
    const searchQuery = this.pickFirstString(input, [
      "query",
      "description",
      "task",
    ])
    const searchHits = searchQuery
      ? this.cursorSkillsManager.search(
          skillPolicy.availableSkills,
          searchQuery
        )
      : []
    const orderedSkills = searchHits.length
      ? this.reorderBySearchHits(skillPolicy.availableSkills, searchHits)
      : skillPolicy.availableSkills

    input.available_skills = orderedSkills.map((skill) => ({
      name: skill.name,
      active: skill.active,
      activation_reason: skill.activationReason,
      description: skill.description,
      when_to_use: skill.whenToUse,
      paths: skill.paths,
      path: skill.fullPath,
    }))
    if (searchHits.length > 0) {
      input.search_hits = searchHits.map((hit) => ({
        name: hit.skill.name,
        score: hit.score,
        matched_fields: hit.matchedFields,
      }))
    }

    const preview =
      allRules.length > 0
        ? allRules
            .map((rule) => {
              const header =
                rule.source === "ide_injected"
                  ? `[ide_injected${rule.type ? ` type=${rule.type}` : ""}] Path: ${rule.path}`
                  : `[workspace_disk] Path: ${rule.path}`
              return `${header}\n${rule.content}`
            })
            .join("\n\n---\n\n")
        : "- (no rules found)"
    const skillPreview =
      this.cursorSkillsManager.buildCatalogSection(orderedSkills)
    const searchPreview = searchHits.length
      ? "\n\nTop matches for query:\n" +
        searchHits
          .map(
            (hit, index) =>
              `${index + 1}. ${hit.skill.name} (score: ${hit.score.toFixed(2)}, matched: ${hit.matchedFields.join(",") || "n/a"})`
          )
          .join("\n")
      : ""

    return {
      content:
        `[fetch_rules success] total=${allRules.length}\n${preview}` +
        (skillPreview ? `\n\n${skillPreview}` : "") +
        searchPreview +
        (skillPolicy.availableSkills.length > 0
          ? "\nUse fetch_rules({ skill_name }) to load an inactive skill."
          : ""),
      state: { status: "success" },
    }
  }

  private reorderBySearchHits(
    skills: CursorSkillMetadata[],
    hits: ReadonlyArray<{ skill: CursorSkillMetadata }>
  ): CursorSkillMetadata[] {
    const hitNames = new Set(hits.map((hit) => hit.skill.name))
    const ranked = hits.map((hit) => hit.skill)
    const remaining = skills.filter((skill) => !hitNames.has(skill.name))
    return [...ranked, ...remaining]
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
    input: Record<string, unknown>,
    options?: { abortSignal?: AbortSignal }
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
      const doc = await this.fetchUrlDocument(url, options?.abortSignal)
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

  private async executeInlineAwaitTask(
    input: Record<string, unknown>
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
  }> {
    // Resolve the task identifier the parent agent passed in. We accept
    // both the proto field name (`task_id`) and the friendlier
    // `agentId` / `agent_id` aliases that show up when the model copies
    // the field straight from the spawn ack.
    const taskId =
      this.pickFirstString(input, [
        "task_id",
        "taskId",
        "agentId",
        "agent_id",
      ]) || ""
    if (!taskId) {
      return {
        content:
          "[await_task error] missing task_id (pass the agentId returned by " +
          "the original task tool call)",
        state: { status: "error", message: "missing task_id" },
      }
    }
    input.task_id = taskId

    // Optional polling timeout — defaults to a generous window so the
    // common case (parent waiting for a research task) does not bounce
    // every 30s. The tool resolves as soon as the registry's
    // donePromise settles, regardless of timeout.
    const blockUntilMs = (() => {
      const raw = input.block_until_ms ?? input.blockUntilMs ?? input.timeout_ms
      if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
        return Math.min(Math.floor(raw), 30 * 60 * 1000)
      }
      return 5 * 60 * 1000
    })()

    const metadataBeforeWait = this.subagentTaskRegistry.getMetadata(taskId)
    if (!metadataBeforeWait) {
      return {
        content:
          `[await_task error] no background sub-agent named '${taskId}' ` +
          `is known to the bridge. Did the spawn succeed and the parent " +
          "agent pass the exact agentId from its tool result?`,
        state: { status: "error", message: "unknown agentId" },
      }
    }

    if (!this.subagentTaskRegistry.isRunning(taskId)) {
      // Already terminal — return the recorded summary immediately.
      input.completed = true
      return {
        content: this.formatBackgroundSubagentAwaitResult(taskId),
        state: { status: "success" },
      }
    }

    // Race the registry's donePromise against the polling deadline.
    // When the deadline fires first, the still_running shape is what
    // the model gets — symmetric with claude-code's await semantics.
    const handles = this.subagentTaskRegistry.listRunning()
    const handle = handles.find((h) => h.agentId === taskId)
    if (!handle) {
      return {
        content: this.formatBackgroundSubagentAwaitResult(taskId),
        state: { status: "success" },
      }
    }

    type AwaitWinner = { kind: "done" } | { kind: "timeout" }
    const donePromise: Promise<AwaitWinner> = this.subagentTaskRegistry
      .awaitDone(taskId)
      .then(() => ({ kind: "done" as const }))
    const timeoutPromise: Promise<AwaitWinner> = new Promise((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" as const }), blockUntilMs)
    )
    const winner = await Promise.race([donePromise, timeoutPromise])
    if (winner.kind === "done") {
      input.completed = true
      return {
        content: this.formatBackgroundSubagentAwaitResult(taskId),
        state: { status: "success" },
      }
    }
    return {
      content: this.formatBackgroundSubagentStillRunning(taskId, blockUntilMs),
      state: { status: "success" },
    }
  }

  /** Format a terminal background sub-agent's metadata into the await
   * tool's user-visible content. Reads metadata.json so the most
   * recent state (including conversationSteps + finalText) is reported
   * verbatim. */
  private formatBackgroundSubagentAwaitResult(agentId: string): string {
    const metadata = this.subagentTaskRegistry.getMetadata(agentId)
    if (!metadata) {
      return `[await_task] ${agentId} unknown — no metadata on disk`
    }
    const lines = [
      `[await_task] ${agentId} ${metadata.status}`,
      `agentType: ${metadata.agentType}`,
      `turnCount: ${metadata.turnCount}`,
      `toolCallCount: ${metadata.toolCallCount}`,
      `durationMs: ${metadata.durationMs ?? "unknown"}`,
    ]
    if (metadata.errorMessage) lines.push(`error: ${metadata.errorMessage}`)
    if (metadata.finalText) {
      lines.push("")
      lines.push("--- FINAL TEXT ---")
      lines.push(metadata.finalText)
    }
    return lines.join("\n")
  }

  /** Format a still-running background sub-agent into the await tool's
   * timeout-fallback content. */
  private formatBackgroundSubagentStillRunning(
    agentId: string,
    waitedMs: number
  ): string {
    const metadata = this.subagentTaskRegistry.getMetadata(agentId)
    if (!metadata) {
      return `[await_task] ${agentId} still running (waited ${waitedMs}ms; no metadata available)`
    }
    return [
      `[await_task] ${agentId} still running after ${waitedMs}ms`,
      `agentType: ${metadata.agentType}`,
      `turnCount: ${metadata.turnCount}`,
      `toolCallCount: ${metadata.toolCallCount}`,
      `(transcript continues at ~/.cursor/subagents/${agentId}/transcript.jsonl)`,
    ].join("\n")
  }

  private executeInlineKillAgent(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const agentId =
      this.pickFirstString(input, [
        "agent_id",
        "agentId",
        "task_id",
        "taskId",
      ]) || ""
    if (!agentId) {
      return {
        content:
          "[kill_agent error] missing agent_id (pass the agentId returned by " +
          "the original task tool call)",
        state: { status: "error", message: "missing agent_id" },
      }
    }
    input.agent_id = agentId

    const killed = this.subagentTaskRegistry.kill(
      agentId,
      "killed by parent via kill_agent tool"
    )
    if (!killed) {
      const metadata = this.subagentTaskRegistry.getMetadata(agentId)
      if (!metadata) {
        return {
          content: `[kill_agent error] no background sub-agent named '${agentId}'`,
          state: { status: "error", message: "unknown agentId" },
        }
      }
      return {
        content: `[kill_agent] ${agentId} was already terminal (status=${metadata.status})`,
        state: { status: "success" },
      }
    }
    return {
      content:
        `[kill_agent] ${agentId} kill signal sent. The worker will halt at ` +
        `the next abort checkpoint and write a 'killed' terminal status to ` +
        `metadata.json. Use await_task or read_file metadata.json to confirm.`,
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

  private executeInlineGetMcpTools(
    conversationId: string,
    input: Record<string, unknown>
  ): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) {
      return {
        content: "[get_mcp_tools error] Session not found",
        state: { status: "error", message: "session not found" },
      }
    }

    const serverFilter =
      this.pickFirstString(input, [
        "server",
        "serverName",
        "server_name",
        "providerIdentifier",
        "provider_identifier",
      ]) || ""
    const toolNameFilter =
      this.pickFirstString(input, ["tool_name", "toolName", "name"]) || ""
    const pattern = this.pickFirstString(input, ["pattern", "query"]) || ""

    input.server = serverFilter
    input.tool_name = toolNameFilter
    input.pattern = pattern

    const normalizedServerFilter = normalizeMcpToolIdentifier(serverFilter)
    const normalizedToolNameFilter = normalizeMcpToolIdentifier(toolNameFilter)
    const normalizedPattern = normalizeMcpToolIdentifier(pattern)
    const lowerPattern = pattern.toLowerCase()
    const defs = session.mcpToolDefs || []

    const filteredDefs = defs.filter((def) => {
      const normalizedProvider = normalizeMcpToolIdentifier(
        def.providerIdentifier || ""
      )
      const normalizedToolName = normalizeMcpToolIdentifier(def.toolName || "")
      const normalizedName = normalizeMcpToolIdentifier(def.name || "")
      const matchesServer =
        !normalizedServerFilter ||
        normalizedProvider === normalizedServerFilter ||
        normalizedProvider.includes(normalizedServerFilter) ||
        normalizedServerFilter.includes(normalizedProvider)
      const matchesToolName =
        !normalizedToolNameFilter ||
        normalizedToolName === normalizedToolNameFilter ||
        normalizedToolName.includes(normalizedToolNameFilter) ||
        normalizedName === normalizedToolNameFilter

      if (!matchesServer || !matchesToolName) {
        return false
      }

      if (!pattern) {
        return true
      }

      const haystacks = [
        def.name || "",
        def.toolName || "",
        def.providerIdentifier || "",
        def.description || "",
      ]
      return haystacks.some((value) => {
        const lowered = value.toLowerCase()
        return (
          lowered.includes(lowerPattern) ||
          normalizeMcpToolIdentifier(value).includes(normalizedPattern)
        )
      })
    })

    const payload: Record<string, unknown> = {
      total: filteredDefs.length,
      tools: filteredDefs.map((def) => ({
        server: def.providerIdentifier,
        tool_name: def.toolName,
        name: def.name,
        description: def.description,
        input_schema: def.inputSchema || {
          type: "object",
          properties: {},
        },
      })),
    }

    if (serverFilter || toolNameFilter || pattern) {
      payload.filters = {
        ...(serverFilter ? { server: serverFilter } : {}),
        ...(toolNameFilter ? { tool_name: toolNameFilter } : {}),
        ...(pattern ? { pattern } : {}),
      }
    }

    return {
      content: JSON.stringify(payload, null, 2),
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

  /**
   * AI Attribution inline executor.
   *
   * The Cursor proto exposes `ai_attribution` as a client-side analysis tool
   * over `AiAttributionToolCall`. This proxy does not maintain the full AI
   * attribution index that Cursor's IDE backend uses to map historical
   * commits → AI-generated regions, so we cannot return real attribution
   * data. Returning a structured "no_data" success envelope is preferable
   * to the previous `unsupported deferred tool family` error because the
   * model can read the JSON and continue without retry-looping.
   */
  private executeInlineAiAttribution(input: Record<string, unknown>): {
    content: string
    state: { status: ToolResultStatus; message?: string }
  } {
    const filePaths = this.pickStringArray(input, [
      "file_paths",
      "filePaths",
      "paths",
    ])
    const startLine = this.pickFirstNumber(input, ["start_line", "startLine"])
    const endLine = this.pickFirstNumber(input, ["end_line", "endLine"])
    const commitHashes = this.pickStringArray(input, [
      "commit_hashes",
      "commitHashes",
    ])
    const outputMode =
      this.pickFirstString(input, ["output_mode", "outputMode"]) || ""
    const maxCommits = this.pickFirstNumber(input, [
      "max_commits",
      "maxCommits",
    ])
    const includeLineRanges = (() => {
      const raw = input["include_line_ranges"] ?? input["includeLineRanges"]
      if (typeof raw === "boolean") return raw
      if (typeof raw === "string")
        return raw.toLowerCase() === "true" || raw === "1"
      return undefined
    })()

    const payload = {
      tool: "ai_attribution",
      status: "no_data",
      reason:
        "ai_attribution index is not maintained by this proxy runtime; " +
        "no historical AI-vs-human commit mapping is available. " +
        "Returning empty attribution result rather than failing the tool call.",
      request: {
        ...(filePaths.length > 0 ? { file_paths: filePaths } : {}),
        ...(typeof startLine === "number" ? { start_line: startLine } : {}),
        ...(typeof endLine === "number" ? { end_line: endLine } : {}),
        ...(commitHashes.length > 0 ? { commit_hashes: commitHashes } : {}),
        ...(outputMode ? { output_mode: outputMode } : {}),
        ...(typeof maxCommits === "number" ? { max_commits: maxCommits } : {}),
        ...(typeof includeLineRanges === "boolean"
          ? { include_line_ranges: includeLineRanges }
          : {}),
      },
      attributions: [] as Array<Record<string, unknown>>,
    }

    return {
      content: JSON.stringify(payload, null, 2),
      state: { status: "success" },
    }
  }

  private async executeDeferredTool(
    conversationId: string,
    family: DeferredToolFamily,
    toolName: string,
    input: Record<string, unknown>,
    options?: { abortSignal?: AbortSignal }
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
    projection?: ParsedToolResult["inlineProjection"]
    historyContent?: ParsedToolResult["inlineHistoryContent"]
    extraData?: ParsedToolResult["inlineExtraData"]
  }> {
    if (family === "command_status") {
      return this.executeInlineCommandStatus(conversationId, input)
    }
    if (family === "read_todos") {
      return Promise.resolve(this.executeInlineTodoRead(conversationId, input))
    }
    if (family === "update_todos") {
      return Promise.resolve(this.executeInlineTodoWrite(conversationId, input))
    }
    if (family === "update_plan") {
      return Promise.resolve(
        this.executeInlineUpdatePlan(conversationId, input)
      )
    }
    if (family === "web_search" || family === "web_fetch") {
      return this.executeInlineWebTool(conversationId, toolName, input, options)
    }
    if (family === "list_mcp_resource_templates") {
      return Promise.resolve(this.executeInlineListMcpResourceTemplates(input))
    }
    if (family === "read_url_content") {
      return this.executeInlineReadUrlContent(conversationId, input, options)
    }
    if (family === "view_content_chunk") {
      return this.executeInlineViewContentChunk(conversationId, input)
    }
    if (family === "view_image") {
      return Promise.resolve(this.executeInlineViewImage(conversationId, input))
    }
    if (family === "fetch") {
      return this.executeInlineFetch(input, options)
    }
    if (family === "record_screen") {
      return Promise.resolve(this.executeInlineRecordScreen(input))
    }
    if (family === "computer_use") {
      return Promise.resolve(this.executeInlineComputerUse(input))
    }
    if (family === "exa_search") {
      return this.executeInlineExaSearch(conversationId, input, options)
    }
    if (family === "exa_fetch") {
      return this.executeInlineExaFetch(input, options)
    }
    if (family === "get_mcp_tools") {
      return Promise.resolve(
        this.executeInlineGetMcpTools(conversationId, input)
      )
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
    if (family === "spawn_agent") {
      return Promise.resolve(
        this.executeInlineSpawnAgent(conversationId, input)
      )
    }
    if (family === "send_input") {
      return Promise.resolve(this.executeInlineSendAgentInput(input))
    }
    if (family === "resume_agent") {
      return Promise.resolve(this.executeInlineResumeAgent(input))
    }
    if (family === "wait_agent") {
      return Promise.resolve(this.executeInlineWaitAgent(input))
    }
    if (family === "close_agent") {
      return Promise.resolve(this.executeInlineCloseAgent(input))
    }
    if (family === "apply_patch") {
      return Promise.resolve(
        this.executeInlineApplyPatch(conversationId, input)
      )
    }
    if (family === "apply_agent_diff") {
      return this.executeInlineApplyAgentDiff(input)
    }
    if (family === "generate_image") {
      return this.executeInlineGenerateImage(conversationId, input)
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
      return this.executeInlineFetchPullRequest(input, options)
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
    if (family === "await_task" || family === "await") {
      return this.executeInlineAwaitTask(input)
    }
    if (family === "kill_agent") {
      return this.executeInlineKillAgent(input)
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
    if (family === "ai_attribution") {
      return this.executeInlineAiAttribution(input)
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
    inlineProjection?: ParsedToolResult["inlineProjection"],
    resultCase = "inline_tool_result",
    inlineExtraData?: ParsedToolResult["inlineExtraData"],
    inlineHistoryContent?: ParsedToolResult["inlineHistoryContent"]
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
          resultCase,
          resultData: Buffer.alloc(0),
          inlineContent: content,
          inlineHistoryContent,
          inlineState: state,
          inlineProjection,
          inlineExtraData,
        },
      ],
    }
  }

  private async *emitInlineToolResult(
    conversationId: string,
    toolCallId: string,
    content: string,
    state: { status: ToolResultStatus; message?: string },
    inlineProjection?: ParsedToolResult["inlineProjection"],
    resultCase = "inline_tool_result",
    inlineExtraData?: ParsedToolResult["inlineExtraData"],
    options: HandleToolResultOptions = {},
    inlineHistoryContent?: ParsedToolResult["inlineHistoryContent"]
  ): AsyncGenerator<Buffer> {
    const syntheticRequest = this.buildSyntheticInlineToolRequest(
      toolCallId,
      content,
      state,
      inlineProjection,
      resultCase,
      inlineExtraData,
      inlineHistoryContent
    )
    yield* this.handleToolResult(conversationId, syntheticRequest, options)
  }

  private async *failPendingToolCallsWithProtocolError(
    conversationId: string,
    reason: string,
    candidateToolCallIds?: string[]
  ): AsyncGenerator<Buffer> {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) return

    const pendingIds = (
      candidateToolCallIds?.length
        ? Array.from(new Set(candidateToolCallIds))
        : Array.from(session.pendingToolCalls.keys())
    ).filter((pendingId) => session.pendingToolCalls.has(pendingId))
    if (pendingIds.length === 0) {
      this.logger.error(
        `Protocol error with no pending tool calls to fail: ${reason}`
      )
      return
    }

    const taskLikePendingIds = pendingIds.filter((pendingId) =>
      this.isTaskLikePendingToolCall(session.pendingToolCalls.get(pendingId))
    )
    if (taskLikePendingIds.length > 0) {
      const interruptedCount = this.interruptPendingToolCallsForRecovery(
        conversationId,
        taskLikePendingIds,
        reason
      )
      if (interruptedCount > 0) {
        this.logger.warn(
          `Protocol error converted ${interruptedCount} task-like pending tool call(s) into interrupted recovery state`
        )
      }
    }

    const remainingPendingIds = pendingIds.filter(
      (pendingId) => !taskLikePendingIds.includes(pendingId)
    )
    if (remainingPendingIds.length === 0) {
      return
    }

    this.logger.error(
      `Protocol error, failing ${remainingPendingIds.length} pending tool call(s): ${reason}`
    )
    for (const pendingId of remainingPendingIds) {
      if (!session.pendingToolCalls.has(pendingId)) continue
      yield* this.emitInlineToolResult(
        conversationId,
        pendingId,
        `[protocol error] ${reason}`,
        { status: "error", message: reason }
      )
    }
  }

  private getPendingToolCallIdsForStream(
    conversationId: string,
    streamId: string,
    candidateToolCallIds: string[]
  ): string[] {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) return []

    return candidateToolCallIds.filter((toolCallId) => {
      const pending = session.pendingToolCalls.get(toolCallId)
      return pending?.streamId === streamId
    })
  }

  private isBridgeLocalInputEofFallbackTool(toolName: string): boolean {
    return this.toolExecutionCoordinator.isBridgeLocalInputEofFallbackTool(
      toolName
    )
  }

  private async executeBridgeLocalInputEofFallbackTool(
    conversationId: string,
    pendingToolCall: PendingToolCall
  ): Promise<{
    content: string
    state: { status: ToolResultStatus; message?: string }
    extraData?: ToolCompletedExtraData
  } | null> {
    const input = { ...(pendingToolCall.toolInput || {}) }
    switch (pendingToolCall.toolName.trim().toLowerCase()) {
      case "read_file":
      case "read_file_v2":
        return this.executeInlineSubAgentReadFile(conversationId, input)
      case "list_directory":
      case "list_dir":
        return this.executeInlineSubAgentListDirectory(conversationId, input)
      case "grep_search":
        return this.executeInlineSubAgentGrepSearch(conversationId, input)
      case "view_content_chunk":
        return this.executeInlineViewContentChunk(conversationId, input)
      default:
        return null
    }
  }

  private async *recoverPendingToolCallsAfterInputEof(
    conversationId: string,
    streamId: string,
    candidateToolCallIds: string[]
  ): AsyncGenerator<Buffer, number> {
    const processedFallbackIds = new Set<string>()
    let unresolvedCount = 0

    for (let pass = 0; pass < 16; pass++) {
      const stillPending = this.getPendingToolCallIdsForStream(
        conversationId,
        streamId,
        candidateToolCallIds
      )
      if (stillPending.length === 0) return 0

      const session = this.sessionManager.getSession(conversationId)
      if (!session) return stillPending.length

      const recoveryPlan =
        this.toolExecutionCoordinator.buildInputEofRecoveryPlan(
          conversationId,
          streamId,
          stillPending
        )
      const localFallbackIds = recoveryPlan.bridgeLocalToolCallIds.filter(
        (toolCallId) => !processedFallbackIds.has(toolCallId)
      )

      if (localFallbackIds.length === 0) {
        unresolvedCount = recoveryPlan.unresolvedToolCallIds.length
        this.logger.warn(
          `BiDi input stream ended with ${stillPending.length} pending tool call(s); ` +
            `closing transport stream and preserving client-owned pending state for resumeAction: ` +
            `${stillPending.join(", ")}`
        )

        // A plain request-input EOF is a Cursor transport boundary. Client-owned
        // tools stay pending under the execution coordinator so a later
        // resumeAction can resolve the state without synthetic failure
        // tool_results corrupting the transcript.
        return unresolvedCount
      }

      this.logger.warn(
        `BiDi input stream ended with ${stillPending.length} pending tool call(s); ` +
          `resolving ${localFallbackIds.length} bridge-local read-only tool(s) ` +
          `in-process before closing: ${localFallbackIds.join(", ")}`
      )

      for (const toolCallId of localFallbackIds) {
        const activeSession = this.sessionManager.getSession(conversationId)
        const pendingToolCall = activeSession?.pendingToolCalls.get(toolCallId)
        if (!pendingToolCall) {
          processedFallbackIds.add(toolCallId)
          continue
        }

        const result = await this.executeBridgeLocalInputEofFallbackTool(
          conversationId,
          pendingToolCall
        )
        processedFallbackIds.add(toolCallId)
        if (!result) continue

        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          result.content,
          result.state,
          undefined,
          "inline_tool_result",
          result.extraData as ParsedToolResult["inlineExtraData"]
        )
      }

      const refreshed = this.sessionManager.getSession(conversationId)
      candidateToolCallIds = refreshed
        ? Array.from(refreshed.pendingToolCalls.keys())
        : []
      if (candidateToolCallIds.length === 0) return 0
    }

    const remaining = this.getPendingToolCallIdsForStream(
      conversationId,
      streamId,
      candidateToolCallIds
    )
    if (remaining.length > 0) {
      this.logger.warn(
        `BiDi input EOF local recovery reached pass limit; preserving ` +
          `${remaining.length} pending tool call(s): ${remaining.join(", ")}`
      )
    }
    return remaining.length
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

    if (family === "ask_question" || family === "request_user_input") {
      const interactionFamily =
        family === "request_user_input" ? "request_user_input" : "ask_question"
      switch (parsed.resultCase) {
        case "success": {
          const answers = this.normalizeAskQuestionProjectionAnswers(
            parsed.resultValue?.answers
          )
          const content =
            answers.length > 0
              ? `[${interactionFamily} success] ${JSON.stringify(answers)}`
              : `[${interactionFamily} success]`
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
            `[${interactionFamily} async] waiting for async completion`,
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
            `[${interactionFamily} rejected] ${reason}`,
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
            `[${interactionFamily} error] ${message}`,
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
          { status: "success" },
          undefined,
          "inline_tool_result"
        )
      } else {
        const message = this.extractInteractionErrorMessage(rawResponse)
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          `[create_plan error] ${message}`,
          { status: "error", message },
          undefined,
          "inline_tool_result"
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

    const resultPromise = this.executeDeferredTool(
      conversationId,
      family,
      toolName,
      toolInput
    ).then(
      (value) => ({ kind: "result" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error })
    )
    let result:
      | {
          content: string
          state: { status: ToolResultStatus; message?: string }
          projection?: ParsedToolResult["inlineProjection"]
          historyContent?: ParsedToolResult["inlineHistoryContent"]
          extraData?: ParsedToolResult["inlineExtraData"]
        }
      | undefined
    let heartbeatCount = 0
    while (!result) {
      const next = await Promise.race([
        resultPromise,
        new Promise<{ kind: "heartbeat" }>((resolve) => {
          setTimeout(() => resolve({ kind: "heartbeat" }), 5_000)
        }),
      ])

      if (next.kind === "heartbeat") {
        heartbeatCount++
        this.logger.debug(
          `Sending server heartbeat while waiting for ${family} interaction tool ${toolCallId} (${heartbeatCount})`
        )
        yield this.grpcService.createServerHeartbeatResponse()
        continue
      }

      if (next.kind === "error") {
        throw next.error
      }

      result = next.value
    }

    yield* this.emitInlineToolResult(
      conversationId,
      toolCallId,
      result.content,
      result.state,
      result.projection,
      family === "web_search"
        ? "web_search_inline_result"
        : family === "web_fetch"
          ? "web_fetch_inline_result"
          : "inline_tool_result",
      result.extraData,
      {},
      result.historyContent
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

    if (family === "request_user_input") {
      const askQuestionArgs = this.normalizeRequestUserInputInteractionArgs(
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

      // Build plan text: prefer explicit narrative fields only.
      // Do not mirror steps/todos into `plan`, otherwise Cursor's plan page
      // shows the same content twice: once in the plan body and again in todos.
      let plan =
        this.pickFirstString(input, ["plan", "overview"]) ||
        this.pickFirstString(input, ["description"]) ||
        ""
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

    // generate_image is an InteractionQuery in the Cursor protocol, not an ExecServerMessage.
    if (family === "generate_image") {
      const referenceImagePaths =
        this.pickStringArray(input, ["referenceImagePaths"]).length > 0
          ? this.pickStringArray(input, ["referenceImagePaths"])
          : this.pickStringArray(input, ["reference_image_paths"])
      return this.grpcService.createInteractionQueryResponse(
        interactionQueryId,
        "generateImageRequestQuery",
        {
          args: {
            description:
              this.pickFirstString(input, ["prompt", "description"]) || "",
            filePath:
              this.pickFirstString(input, ["filePath", "file_path"]) ||
              undefined,
            referenceImagePaths,
          },
          toolCallId,
        }
      )
    }

    if (family === "mcp_auth") {
      // Per agent.v1 proto: McpAuthRequestQuery { args: McpAuthArgs { server_identifier, tool_call_id } }
      // Accept both snake_case and camelCase identifiers from the model, plus
      // a few legacy aliases (serverName/server) for backward compatibility.
      const serverIdentifier =
        this.pickFirstString(input, [
          "server_identifier",
          "serverIdentifier",
          "serverName",
          "server_name",
          "server",
        ]) || ""
      const callIdFromInput =
        this.pickFirstString(input, ["tool_call_id", "toolCallId"]) || ""
      return this.grpcService.createInteractionQueryResponse(
        interactionQueryId,
        "mcpAuthRequestQuery",
        {
          args: {
            serverIdentifier,
            toolCallId: callIdFromInput || toolCallId,
          },
        }
      )
    }

    // InteractionQuery 补齐：pr_management
    if (family === "pr_management") {
      return this.grpcService.createInteractionQueryResponse(
        interactionQueryId,
        "prManagementRequestQuery",
        {
          args: {
            toolCallId,
            action: {
              case:
                this.pickFirstString(input, ["action_type", "actionType"]) ===
                "update_pr"
                  ? "updatePr"
                  : "createPr",
              value: {
                title: this.pickFirstString(input, ["title"]) || "",
                body:
                  this.pickFirstString(input, ["body", "description"]) || "",
                baseBranch:
                  this.pickFirstString(input, [
                    "baseBranch",
                    "base_branch",
                    "base",
                  ]) || "",
                headBranch:
                  this.pickFirstString(input, [
                    "headBranch",
                    "head_branch",
                    "head",
                  ]) || "",
              },
            },
          },
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

  /**
   * Bridge-internal handler for `discover_tool` calls.
   *
   * The model invokes `discover_tool({ tool_name })` to fetch the full
   * description + input_schema of any entry in the system prompt's
   * `<deferred_tools>` catalog.  We look the name up in the
   * session-scoped catalog snapshot, return the schema as the
   * tool_result, and add the name to `session.discoveredTools` so
   * subsequent turns include the full schema in the upstream `tools`
   * array (no further `discover_tool` calls needed for that tool).
   *
   * On cache miss / bad input we return a structured error pointing
   * the model at valid catalog names; the model is expected to retry
   * with a corrected name in the next turn.
   *
   * Why this lives here (not in `runDeferredToolIfNeeded`):
   *   - `runDeferredToolIfNeeded` dispatches **Cursor-protocol**
   *     deferred tools (web_search, exa_fetch, ...).  Those tools have
   *     real IDE-side counterparts and InteractionQuery routing.
   *   - `discover_tool` has no Cursor protocol presence.  It is a pure
   *     bridge construct — the model only knows about it because we
   *     advertise it in the `tools` array, and its result comes
   *     entirely from in-memory catalog state.
   */
  private async *handleDiscoverToolInvocation(
    conversationId: string,
    session: ChatSession,
    activeToolCall: ActiveToolCall,
    input: Record<string, unknown>
  ): AsyncGenerator<Buffer> {
    const catalog = new Map<string, DiscoverToolCatalogEntry>()
    for (const entry of session.deferredToolCatalog ?? []) {
      catalog.set(entry.name, {
        name: entry.name,
        description: entry.description,
        input_schema: entry.input_schema,
      })
    }

    const result = handleDiscoverToolCall(input, catalog)
    if (result.status === "success") {
      session.discoveredTools.add(result.tool_name)
      this.logger.log(
        `[discover_tool] session=${conversationId} promoted "${result.tool_name}" to core; session set size=${session.discoveredTools.size}`
      )
    } else {
      this.logger.warn(
        `[discover_tool] session=${conversationId} rejected request "${result.tool_name}": ${result.error}`
      )
    }

    const text = formatDiscoverToolResultText(result)
    yield* this.emitInlineToolResult(
      conversationId,
      activeToolCall.id,
      text,
      result.status === "success"
        ? { status: "success" }
        : { status: "error", message: result.error }
    )
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
    const readUrl = this.pickFirstString(input, ["url", "Url"]) || ""
    const documentId =
      this.pickFirstString(input, ["document_id", "documentId"]) || ""
    const position = this.pickFirstNumber(input, [
      "position",
      "chunk_position",
      "chunkPosition",
    ])
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

    if (family === "read_url_content" && !readUrl) {
      yield* this.emitInlineToolResult(
        conversationId,
        toolCallId,
        "[read_url_content error] Missing required Url parameter",
        { status: "error", message: "missing Url" }
      )
      return true
    }

    if (family === "view_content_chunk" && !documentId) {
      yield* this.emitInlineToolResult(
        conversationId,
        toolCallId,
        "[view_content_chunk error] Missing required document_id parameter",
        { status: "error", message: "missing document_id" }
      )
      return true
    }

    if (family === "view_content_chunk" && position === undefined) {
      yield* this.emitInlineToolResult(
        conversationId,
        toolCallId,
        "[view_content_chunk error] Missing required position parameter",
        { status: "error", message: "missing position" }
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

    if (family === "update_plan") {
      const planItems = Array.isArray(input.plan) ? input.plan : []
      if (planItems.length === 0) {
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          "[update_plan error] Missing required plan items",
          { status: "error", message: "missing plan items" }
        )
        return true
      }
    }

    if (family === "request_user_input") {
      const questions = Array.isArray(input.questions) ? input.questions : []
      if (questions.length === 0) {
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          "[request_user_input error] Missing required questions",
          { status: "error", message: "missing questions" }
        )
        return true
      }
    }

    if (family === "view_image") {
      const imagePath = this.pickFirstString(input, ["path"]) || ""
      if (!imagePath) {
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          "[view_image error] Missing required path",
          { status: "error", message: "missing path" }
        )
        return true
      }
    }

    if (family === "apply_patch") {
      const patch =
        this.pickFirstString(input, ["patch", "diff", "input"]) || ""
      if (!patch) {
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          "[apply_patch error] Missing required patch payload",
          { status: "error", message: "missing patch" }
        )
        return true
      }
    }

    if (family === "spawn_agent") {
      const message = this.buildSyntheticCodexAgentMessage(input)
      if (!message) {
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          "[spawn_agent error] Missing required message/items",
          { status: "error", message: "missing message/items" }
        )
        return true
      }
    }

    if (family === "send_input") {
      const target = this.pickFirstString(input, ["target"]) || ""
      const message = this.buildSyntheticCodexAgentMessage(input)
      if (!target) {
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          "[send_input error] Missing required target",
          { status: "error", message: "missing target" }
        )
        return true
      }
      if (!message) {
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          "[send_input error] Missing required message/items",
          { status: "error", message: "missing message/items" }
        )
        return true
      }
    }

    if (family === "resume_agent") {
      const id = this.pickFirstString(input, ["id"]) || ""
      if (!id) {
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          "[resume_agent error] Missing required id",
          { status: "error", message: "missing id" }
        )
        return true
      }
    }

    if (family === "wait_agent") {
      const targets = this.pickStringArray(input, ["targets", "target"])
      if (targets.length === 0) {
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          "[wait_agent error] Missing required targets",
          { status: "error", message: "missing targets" }
        )
        return true
      }
    }

    if (family === "close_agent") {
      const target = this.pickFirstString(input, ["target"]) || ""
      if (!target) {
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          "[close_agent error] Missing required target",
          { status: "error", message: "missing target" }
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

    if (family === "task") {
      // task tool dispatcher: branch on `run_in_background`. Background
      // mode immediately settles the parent task tool with a
      // `taskSuccess { agentId, isBackground: true }` projection so the
      // parent BiDi stream can close and the user can keep chatting; the
      // worker keeps running in SubagentBackgroundWorker and writes its
      // transcript / result to disk for later inspection. Mirrors
      // claude-code's `task(run_in_background=true)` semantics.
      const runInBackground = this.parseRunInBackgroundFlag(input)
      if (runInBackground) {
        yield* this.spawnBackgroundSubAgent(conversationId, toolCallId, input)
        return true
      }
      yield* this.executeSubAgentTask(conversationId, toolCallId, input)
      return true
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
        result.state,
        result.projection,
        "inline_tool_result",
        result.extraData,
        {},
        result.historyContent
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

  private shouldSuppressInternalToolLifecycleStarted(
    toolName: string,
    deferredToolFamily?: DeferredToolFamily
  ): boolean {
    return this.shouldSuppressInternalToolLifecycle(
      toolName,
      deferredToolFamily
    )
  }

  private shouldSuppressInternalToolLifecycleCompleted(
    toolName: string,
    deferredToolFamily?: DeferredToolFamily
  ): boolean {
    return this.shouldSuppressInternalToolLifecycle(
      toolName,
      deferredToolFamily
    )
  }

  private shouldSuppressInternalToolLifecycle(
    toolName: string,
    deferredToolFamily?: DeferredToolFamily
  ): boolean {
    return (
      this.describeInternalToolLifecycleSuppression(
        toolName,
        deferredToolFamily
      ) !== undefined
    )
  }

  private describeInternalToolLifecycleSuppression(
    toolName: string,
    deferredToolFamily?: DeferredToolFamily
  ):
    | {
        family?: DeferredToolFamily
        reason: string
      }
    | undefined {
    const family =
      deferredToolFamily || this.normalizeDeferredToolFamily(toolName)

    // Cursor protocol white-list: tools that have a dedicated ToolCall oneof
    // case in agent.v1 AND are rendered as their own UI card by the IDE
    // (todo list / plan tree / sub-agent task bubble / ...). Their lifecycle
    // MUST emit toolCallStarted / toolCallCompleted carrying the proto-typed
    // ToolCall envelope, otherwise the IDE never receives a render trigger
    // and either falls back to a generic "General Purpose" placeholder or
    // silently drops the card even though the underlying state was updated.
    //
    // Historically these were lumped with the rest of `DeferredToolFamily`
    // and got suppressed alongside `web_search` / `web_fetch` (which are
    // pure InteractionQuery tools without a UI-card ToolCall). The result
    // was a protocol-conformant InteractionQuery exchange but an empty UI.
    //
    // Keep `create_plan` here even though it also has an InteractionQuery
    // round-trip — InteractionQuery selects plan content, ToolCall renders
    // the plan card; both must fire.
    //
    // `task` is in this list because the parent task tool bubble's title
    // ("Explore" / "Bash" / "smoke-probe" / ...) and progress UX are
    // driven by the IDE consuming the parent TaskToolCall.args.subagentType
    // payload from toolCallStarted. The actual sub-agent body streams via
    // ToolCallDeltaUpdate(taskToolCallDelta) — that's a separate channel
    // anchored to the same callId.
    //
    // `read_todos` was historically here too, but as of Cursor v3.x the
    // IDE's `convertToolCallToBubbleData` switch (workbench.desktop.main.js,
    // function `zms`) explicitly throws "Unsupported tool type for bubble
    // translation: readTodosToolCall" — even though the proto oneof case is
    // defined and the inner ToolFormer enum (`xn.TODO_READ = 34`) plus its
    // "Reading todos" / "Read todos" status strings exist. The IDE simply
    // forgot to wire the readTodosToolCall envelope into the bubble
    // translator, falling back to the literal `[Tool: readTodosToolCall]`
    // textDelta. Until Cursor ships the missing case, we suppress the
    // lifecycle envelope on bridge side and let read_todos run inline so
    // the assistant text stream stays clean. The model still receives the
    // tool result through the normal inline_tool_result path.
    //
    // `generate_image` also needs both channels. The InteractionQuery only
    // carries the approval response; the actual image preview is rendered from
    // the GenerateImageToolCall result emitted in toolCallCompleted.
    const UI_CARD_TOOL_FAMILIES: ReadonlySet<DeferredToolFamily> =
      new Set<DeferredToolFamily>([
        "update_todos",
        "create_plan",
        "task",
        "generate_image",
      ])
    if (family && UI_CARD_TOOL_FAMILIES.has(family)) {
      return undefined
    }

    if (family) {
      return {
        family,
        reason: "bridge_inline_or_interaction_query_tool",
      }
    }

    if (this.isUiOnlyTruncatedToolName(toolName)) {
      return {
        reason: "unsupported_cursor_toolcall_ui_projection",
      }
    }

    return undefined
  }

  private isUiOnlyTruncatedToolName(toolName: string): boolean {
    const normalized = toolName.trim().toLowerCase()
    if (!normalized) return false
    const compact = normalized.replace(/[^a-z0-9]/g, "")
    return (
      normalized === "background_composer_followup" ||
      normalized === "canvas_destroy" ||
      normalized === "canvas_get_url" ||
      normalized === "canvas_register" ||
      normalized === "client_side_tool_v2_background_composer_followup" ||
      normalized === "fix_lints" ||
      normalized === "client_side_tool_v2_fix_lints" ||
      normalized === "client_side_tool_v2_update_project" ||
      normalized === "execute_hook" ||
      normalized === "force_background_shell" ||
      normalized === "force_background_subagent" ||
      normalized === "mcp_state_exec" ||
      normalized === "request_context" ||
      normalized === "subagent_await" ||
      normalized === "truncated" ||
      normalized === "truncated_tool_call" ||
      normalized === "update_project" ||
      normalized === "unknown" ||
      // discover_tool is purely bridge-internal — its result comes from
      // in-memory deferred-tool catalog state with no Cursor protocol
      // ToolCall mapping. Without this, lifecycle envelopes were emitted
      // with family="unknown" → the IDE rendered `[Tool: truncatedToolCall]`
      // labels in the assistant text stream every time the model called
      // discover_tool to resolve a deferred tool's schema.
      normalized === "discover_tool" ||
      compact === "backgroundcomposerfollowup" ||
      compact === "canvasdestroy" ||
      compact === "canvasgeturl" ||
      compact === "canvasregister" ||
      compact === "clientsidetoolv2backgroundcomposerfollowup" ||
      compact === "fixlints" ||
      compact === "clientsidetoolv2fixlints" ||
      compact === "clientsidetoolv2updateproject" ||
      compact === "executehook" ||
      compact === "forcebackgroundshell" ||
      compact === "forcebackgroundsubagent" ||
      compact === "mcpstateexec" ||
      compact === "requestcontext" ||
      compact === "subagentawait" ||
      compact === "truncated" ||
      compact === "truncatedtoolcall" ||
      compact === "updateproject" ||
      compact === "unknown" ||
      compact === "discovertool"
    )
  }

  private shouldEmitToolCallStarted(
    toolName: string,
    deferredToolFamily: DeferredToolFamily | undefined,
    _canDispatchExec: boolean
  ): boolean {
    return !this.shouldSuppressInternalToolLifecycleStarted(
      toolName,
      deferredToolFamily
    )
  }

  private appendAssistantTextBlock(
    blocks: MessageContentItem[],
    text: string
  ): void {
    if (!text) return

    const lastBlock = blocks[blocks.length - 1]
    if (lastBlock?.type === "text") {
      lastBlock.text += text
      return
    }

    blocks.push({
      type: "text",
      text,
    })
  }

  private startAssistantThinkingBlock(
    blocks: MessageContentItem[],
    signature?: string
  ): ThinkingContentItem {
    const block: ThinkingContentItem = {
      type: "thinking",
      thinking: "",
    }
    if (signature) {
      block.signature = signature
    }
    blocks.push(block)
    return block
  }

  private appendAssistantThinkingDelta(
    block: ThinkingContentItem | null,
    thinking: string
  ): void {
    if (!block || !thinking) {
      return
    }
    block.thinking += thinking
  }

  private setAssistantThinkingSignature(
    block: ThinkingContentItem | null,
    signature?: string
  ): void {
    if (!block || !signature) {
      return
    }
    block.signature = signature
  }

  private buildPreparedToolInvocation(
    session: ChatSession,
    toolCall: ActiveToolCall
  ): PreparedToolInvocation {
    const rawInput = this.parseToolInputJson(toolCall.inputJson)
    const canonicalInvocation = this.normalizeOfficialViewFileInvocation(
      session,
      this.canonicalizeToolInvocation(toolCall.name, rawInput)
    )
    const canonicalToolName = canonicalInvocation.toolName
    const input = canonicalInvocation.input
    const registeredValidatorError = this.runRegisteredToolInputValidator(
      session,
      canonicalToolName,
      input
    )
    const validationErrorMessage =
      canonicalInvocation.validationErrorMessage || registeredValidatorError
    const execDispatchResolution = validationErrorMessage
      ? { target: null, errorMessage: validationErrorMessage }
      : this.resolveExecDispatchTarget(session, canonicalToolName, input)
    const pathForSkillActivation = this.cursorSkillsManager.pickToolTargetPath(
      execDispatchResolution.target?.toolName || canonicalToolName,
      execDispatchResolution.target?.input || input
    )
    if (pathForSkillActivation) {
      this.cursorSkillsManager.activateForPath(
        session,
        pathForSkillActivation,
        `tool_path:${canonicalToolName}`
      )
    }
    const unrequestedCanvasError = validationErrorMessage
      ? null
      : this.cursorSkillsManager.guardToolAccess(
          session,
          execDispatchResolution.target?.toolName || canonicalToolName,
          execDispatchResolution.target?.input || input
        )
    const dispatchErrorMessage =
      validationErrorMessage ||
      unrequestedCanvasError ||
      execDispatchResolution.errorMessage
    const execDispatchTarget = unrequestedCanvasError
      ? null
      : execDispatchResolution.target
    const deferredToolFamily = dispatchErrorMessage
      ? undefined
      : execDispatchTarget && canonicalToolName === "generate_image"
        ? undefined
        : this.normalizeDeferredToolFamily(canonicalToolName)
    const historyToolName =
      canonicalInvocation.historyToolName || canonicalToolName
    const historyToolInput = this.compactToolInputForHistory(
      historyToolName,
      canonicalInvocation.historyToolInput || input
    )

    return {
      activeToolCall: toolCall,
      canonicalToolName,
      input,
      historyToolName,
      historyToolInput,
      codexToolCallType: this.resolveCodexToolCallType(
        historyToolName,
        canonicalToolName,
        execDispatchTarget?.toolName
      ),
      deferredToolFamily,
      execDispatchTarget: execDispatchTarget || undefined,
      dispatchErrorMessage,
      canDispatchExec: Boolean(execDispatchTarget),
      protocolToolName: execDispatchTarget?.toolName || canonicalToolName,
      protocolToolInput: execDispatchTarget?.input || input,
      protocolToolFamilyHint: execDispatchTarget?.toolFamilyHint,
    }
  }

  private appendPreparedToolUseBlock(
    blocks: MessageContentItem[],
    preparedTool: PreparedToolInvocation
  ): void {
    blocks.push({
      type: "tool_use",
      id: preparedTool.activeToolCall.id,
      name: preparedTool.historyToolName,
      input: preparedTool.historyToolInput,
      tool_call_type: preparedTool.codexToolCallType,
    })
  }

  private resolveCodexToolCallType(
    ...toolNames: Array<string | undefined>
  ): "function" | "custom" {
    for (const rawToolName of toolNames) {
      const normalizedToolName = (rawToolName || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
      if (normalizedToolName === "apply_patch") {
        return "custom"
      }
    }

    return "function"
  }

  private persistAssistantToolBatchMessage(
    conversationId: string,
    blocks: MessageContentItem[]
  ): void {
    if (blocks.length === 0) return

    const content: MessageContent =
      blocks.length === 1 && blocks[0]?.type === "text"
        ? blocks[0].text
        : blocks.map((block) => ({ ...block }))

    this.sessionManager.addMessage(conversationId, "assistant", content)
  }

  private getTopLevelAgentTurnState(
    session: ChatSession,
    conversationId: string
  ): SessionTopLevelAgentTurnState {
    if (!session.topLevelAgentTurnState) {
      session.topLevelAgentTurnState =
        this.createInitialTopLevelAgentTurnState()
      this.sessionManager.markSessionDirty(conversationId)
    }

    return session.topLevelAgentTurnState
  }

  private resetTopLevelAgentTurnState(
    session: ChatSession,
    conversationId: string
  ): void {
    // Investigation memory now lives in persistent context state rather than
    // per-turn top-level agent state.  Do not clear it here; let bounded
    // append/replace logic control retention so recent evidence can survive
    // across top-level turns within the same conversation.
    session.topLevelAgentTurnState = this.createInitialTopLevelAgentTurnState()
    this.sessionManager.markSessionDirty(conversationId)
  }

  private createInitialTopLevelAgentTurnState(): SessionTopLevelAgentTurnState {
    return {
      llmTurnCount: 1,
      readOnlyBatchCount: 0,
      hasMutatingToolCall: false,
      stalledReadOnlyContinuationCount: 0,
      continuationBudget: {
        continuationCount: 0,
        lastHistoryTokens: 0,
        lastDeltaTokens: 0,
        startedAt: Date.now(),
      },
      mutationBarrier: {
        mutatingBatchCount: 0,
        verificationReadOnlyBatchCount: 0,
        lastEditedPaths: [],
      },
    }
  }

  private clearReadOnlyContinuationTracking(
    state: SessionTopLevelAgentTurnState
  ): void {
    state.lastReadOnlyContinuationHistoryTokens = undefined
    state.stalledReadOnlyContinuationCount = 0
  }

  private resetMutationVerificationBarrier(
    state: SessionTopLevelAgentTurnState
  ): void {
    state.mutationBarrier.verificationReadOnlyBatchCount = 0
  }

  private notePreparedToolBatch(
    conversationId: string,
    session: ChatSession,
    assistantBlocks: MessageContentItem[],
    preparedTools: PreparedToolInvocation[]
  ): void {
    if (preparedTools.length === 0) return

    const state = this.getTopLevelAgentTurnState(session, conversationId)
    const assistantText = assistantBlocks
      .filter(
        (block): block is Extract<MessageContentItem, { type: "text" }> =>
          block.type === "text"
      )
      .map((block) => block.text)
      .join("")
      .trim()

    const tools = preparedTools.map((tool) => ({
      toolCallId: tool.activeToolCall.id,
      toolName: tool.protocolToolName,
      input: tool.protocolToolInput,
    }))
    const readOnly = tools.every((tool) =>
      this.isReadOnlyInvestigativeTool(tool.toolName, tool.input)
    )

    if (!readOnly) {
      state.hasMutatingToolCall = true
    }

    state.activeToolBatch = {
      batchId: crypto.randomUUID(),
      toolCallIds: tools.map((tool) => tool.toolCallId),
      assistantText,
      readOnly,
      startedAt: Date.now(),
      tools,
    }
    this.sessionManager.markSessionDirty(conversationId)
  }

  private recordCompletedToolResultInTopLevelState(
    conversationId: string,
    session: ChatSession,
    toolCallId: string,
    toolResultContent: string
  ): ContextInvestigationMemoryEntry | undefined {
    const state = this.getTopLevelAgentTurnState(session, conversationId)
    const activeBatch = state.activeToolBatch
    if (!activeBatch) {
      return undefined
    }

    const trackedTool = activeBatch.tools.find(
      (tool) => tool.toolCallId === toolCallId
    )
    if (!trackedTool) {
      return undefined
    }

    trackedTool.resultSummary =
      this.buildToolResultSummaryPreview(toolResultContent)

    const completed = activeBatch.tools.every(
      (tool) => typeof tool.resultSummary === "string"
    )
    if (!completed) {
      this.sessionManager.markSessionDirty(conversationId)
      return undefined
    }

    const summary = this.buildCompletedToolBatchSummary(activeBatch)
    this.sessionManager.appendInvestigationMemory(
      conversationId,
      summary,
      this.TOP_LEVEL_AGENT_SUMMARY_MEMORY_LIMIT
    )
    if (activeBatch.readOnly) {
      state.readOnlyBatchCount += 1
      if (state.mutationBarrier.lastEditedPaths.length > 0) {
        state.mutationBarrier.verificationReadOnlyBatchCount += 1
      }
    } else {
      state.readOnlyBatchCount = 0
      this.clearReadOnlyContinuationTracking(state)
      const editedPaths = this.extractMutatingFilePathsFromBatch(activeBatch)
      if (editedPaths.length > 0) {
        const uniquePaths = Array.from(new Set(editedPaths))
        state.mutationBarrier.mutatingBatchCount += 1
        state.mutationBarrier.lastEditedPaths = uniquePaths
        this.resetMutationVerificationBarrier(state)
      }
    }
    state.activeToolBatch = undefined
    this.sessionManager.markSessionDirty(conversationId)
    return summary
  }

  private extractMutatingFilePathsFromBatch(
    batch: SessionActiveToolBatch
  ): string[] {
    return batch.tools
      .filter((tool) => this.isMutatingFileTool(tool.toolName))
      .map((tool) => this.pickToolPath(tool.input))
      .filter((value): value is string => !!value)
  }

  private buildCompletedToolBatchSummary(
    batch: SessionActiveToolBatch
  ): ContextInvestigationMemoryEntry {
    const label = this.buildToolBatchLabel(batch)
    const detailLines = batch.tools
      .slice(0, this.TOOL_BATCH_SUMMARY_DETAILS_LIMIT)
      .map((tool) => {
        const inputSummary = this.summarizeToolInputForMemory(
          tool.toolName,
          tool.input
        )
        const resultSummary = tool.resultSummary || "completed"
        return `- ${tool.toolName}: ${inputSummary}; result=${resultSummary}`
      })
    const details = [
      batch.assistantText
        ? `Intent: ${this.truncateForToolSummary(batch.assistantText, 180)}`
        : "",
      ...detailLines,
      batch.tools.length > this.TOOL_BATCH_SUMMARY_DETAILS_LIMIT
        ? `- ...and ${batch.tools.length - this.TOOL_BATCH_SUMMARY_DETAILS_LIMIT} more tool result(s)`
        : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n")

    return {
      batchId: batch.batchId,
      label,
      details,
      toolCallIds: [...batch.toolCallIds],
      toolCount: batch.tools.length,
      readOnly: batch.readOnly,
      createdAt: Date.now(),
    }
  }

  private buildToolBatchLabel(batch: SessionActiveToolBatch): string {
    const counts = new Map<string, number>()
    for (const tool of batch.tools) {
      counts.set(tool.toolName, (counts.get(tool.toolName) || 0) + 1)
    }

    const dominantTool = Array.from(counts.entries()).sort(
      (a, b) => b[1] - a[1]
    )[0]?.[0]
    const firstTool = batch.tools[0]

    if (dominantTool === "read_file" || dominantTool === "read_file_v2") {
      const paths = batch.tools
        .map((tool) => this.pickToolPath(tool.input))
        .filter((value): value is string => !!value)
      if (paths.length > 0) {
        return `Read ${paths.slice(0, 2).join(", ")}${paths.length > 2 ? "..." : ""}`
      }
    }

    if (dominantTool === "grep_search") {
      const query = this.pickToolQuery(firstTool?.input)
      if (query) {
        return `Searched for ${this.truncateForToolSummary(query, 36)}`
      }
    }

    if (dominantTool === "run_terminal_command") {
      const command = this.pickShellCommand(firstTool?.input)
      if (command) {
        return `Ran ${this.truncateForToolSummary(command, 36)}`
      }
    }

    if (dominantTool === "exec_command") {
      const command = this.pickShellCommand(firstTool?.input)
      if (command) {
        return `Ran ${this.truncateForToolSummary(command, 36)}`
      }
    }

    if (dominantTool === "read_lints") {
      return "Read lint diagnostics"
    }

    return `Completed ${batch.tools.length} investigative tool call${batch.tools.length === 1 ? "" : "s"}`
  }

  private buildToolResultSummaryPreview(content: string): string {
    const compact = content.replace(/\s+/g, " ").trim()
    return this.truncateForToolSummary(compact, 160)
  }

  private summarizeToolInputForMemory(
    toolName: string,
    input: Record<string, unknown>
  ): string {
    const pathValue = this.pickToolPath(input)
    if (pathValue) {
      return `path=${pathValue}`
    }

    if (toolName === "grep_search") {
      const query = this.pickToolQuery(input)
      if (query) {
        return `query=${this.truncateForToolSummary(query, 60)}`
      }
    }

    if (toolName === "run_terminal_command" || toolName === "exec_command") {
      const command = this.pickShellCommand(input)
      if (command) {
        return `command=${this.truncateForToolSummary(command, 60)}`
      }
    }

    const serialized = JSON.stringify(input)
    return serialized
      ? this.truncateForToolSummary(serialized, 80)
      : "input=unknown"
  }

  private pickToolPath(
    input: Record<string, unknown> | undefined
  ): string | null {
    if (!input) return null
    const candidates = [
      input.path,
      input.SearchPath,
      input.searchPath,
      input.search_path,
      input.AbsolutePath,
      input.absolutePath,
      input.absolute_path,
      input.DirectoryPath,
      input.directoryPath,
      input.directory_path,
      input.TargetFile,
      input.targetFile,
      input.target_file,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim()
      }
    }
    return null
  }

  private pickToolQuery(
    input: Record<string, unknown> | undefined
  ): string | null {
    if (!input) return null
    const candidates = [
      input.query,
      input.Query,
      input.pattern,
      input.searchTerm,
      input.search_term,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim()
      }
    }
    return null
  }

  private pickShellCommand(
    input: Record<string, unknown> | undefined
  ): string | null {
    if (!input) return null
    const candidates = [input.command, input.cmd]
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim()
      }
    }
    return null
  }

  private latestUserExplicitlyRequestsShellExecution(
    session: ChatSession | undefined
  ): boolean {
    if (!session) return false
    const latestUserText =
      this.extractLatestUserPlainText(
        session.messages as Array<{
          role: "user" | "assistant"
          content: MessageContent
        }>
      ) || ""
    const normalized = latestUserText.trim().toLowerCase()
    if (!normalized) return false
    return (
      normalized.includes("run_terminal_command") ||
      normalized.includes("shell") ||
      normalized.includes("terminal") ||
      normalized.includes("命令行") ||
      normalized.includes("终端") ||
      normalized.includes("执行命令") ||
      normalized.includes("运行命令") ||
      normalized.includes("用命令")
    )
  }

  /**
   * Classify a shell command for "you should have used a dedicated tool"
   * intervention. Returns null when the command is either fine or its
   * intent is not a deterministic file write.
   *
   * Design philosophy (mirrors claude-code's BashTool, see
   * `claude-code/packages/builtin-tools/src/tools/BashTool/prompt.ts`):
   *
   *   - Hard-blocking shell read / search / discovery commands (cat,
   *     head, tail, ls, find, grep, rg) is hostile to the user. A model
   *     that wants to `wc -l file` should not be told "no, use
   *     read_file" — it should just run, because read_file cannot
   *     express line counting. claude-code's BashTool does NOT block
   *     these; it only **suggests** the dedicated tools via the system
   *     prompt and lets the model choose. We follow the same approach.
   *
   *   - File writes through shell (`echo > path`, `tee path`, `sed -i`
   *     etc.) are still discouraged when the target is a workspace
   *     file — the IDE cannot render the diff, the user cannot review
   *     the change, and the model loses its file-state cache. We keep
   *     this as a soft block, but with two corrections vs. the
   *     previous implementation:
   *
   *       1. Compound commands are split per-segment before pattern
   *          matching. `wc -l foo 2>/dev/null || echo bar; stat baz`
   *          previously matched the global "echo + > anywhere" regex
   *          and was rejected as a "file write through shell" — even
   *          though no segment writes a file. Per-segment classification
   *          fixes that false positive.
   *
   *       2. stderr-only redirections (`2>`, `2>>`) are not file
   *          writes for our purposes. They route stderr to /dev/null
   *          or a log file the user is already allowed to manage; the
   *          IDE diff path is not relevant.
   *
   *   - Real security validation (network device redirects to /dev/tcp,
   *     IFS injection, obfuscated flags, heredoc forging) is OUT OF
   *     SCOPE here — those belong in a separate validator and are not
   *     yet implemented in this bridge. claude-code's `bashSecurity.ts`
   *     is the reference implementation.
   */
  private classifyAvoidableShellCommand(
    command: string | null
  ): AvoidableShellCommandClassification | null {
    if (!command) return null
    const trimmed = command.trim()
    if (!trimmed) return null

    // Split the command into top-level segments separated by sequencing
    // operators. Each segment is classified independently — a write in
    // any segment trips the soft block, but a single segment's write
    // intent does not get inferred from tokens that live in a different
    // segment.
    const segments = this.splitShellCommandSegments(trimmed)
    if (segments.length === 0) {
      return null
    }

    for (const segment of segments) {
      const classification = this.classifySingleShellSegment(segment)
      if (classification) {
        return classification
      }
    }
    return null
  }

  /**
   * Per-segment classifier. Only file_write is recognized; read /
   * search / discovery shapes are intentionally allowed through (see
   * the rationale in classifyAvoidableShellCommand).
   */
  private classifySingleShellSegment(
    segmentRaw: string
  ): AvoidableShellCommandClassification | null {
    const segment = segmentRaw.trim()
    if (!segment) return null
    const normalized = segment.toLowerCase()

    // File writes through shell — soft block, with target whitelisting
    // for ephemeral / tmp / smoke paths so harmless cases pass through.
    //
    // The `>` / `>>` regex deliberately excludes `2>` / `2>>` (stderr
    // redirects) by anchoring the match to a non-digit boundary at the
    // start of the redirection token. `[^0-9&]` before the `>` allows
    // word-boundaries (space, end of identifier) but rejects
    // file-descriptor redirects like `2>` or `&>`.
    const looksLikeRedirectionWrite =
      /(^|\s)(?:cat|printf|echo)\b[^\n]*(?:^|[^\d&])>>?\s*[^&|;\s]+/.test(
        normalized
      )
    const looksLikeTeeWrite = /(^|\s)tee\s+(?:-[a-z]+\s+)*[^&|;\s]+/.test(
      normalized
    )
    const looksLikeInPlaceEdit =
      /(^|\s)(?:sed\b[^\n]*\s-i\b|perl\b[^\n]*\s-pi\b)/.test(normalized)
    const looksLikeProgrammaticWrite =
      /\b(?:writefilesync|writefile|write_text)\s*\(/.test(normalized) ||
      /\bopen\s*\([^)]*["'](?:w|a|x)\+?["']/.test(normalized)

    if (
      !looksLikeRedirectionWrite &&
      !looksLikeTeeWrite &&
      !looksLikeInPlaceEdit &&
      !looksLikeProgrammaticWrite
    ) {
      return null
    }

    // Best-effort target extraction across all write shapes:
    //   - shell redirection: `> path`, `>> path`, `tee path`
    //   - sed -i / perl -pi: target follows the last positional arg
    //   - programmatic writes: writeFileSync(<literal>, ...) etc.
    // If we can extract every target AND every target lives inside an
    // ephemeral / tmp / smoke area, allow the command through. Only
    // block when at least one target may be a workspace file or the
    // shape is too opaque to reason about.
    const targets = this.extractShellWriteTargets(segment)
    const programmaticTargets = looksLikeProgrammaticWrite
      ? this.extractProgrammaticWriteTargets(segment)
      : []
    const inPlaceTargets = looksLikeInPlaceEdit
      ? this.extractInPlaceEditTargets(segment)
      : []
    const allTargets = [...targets, ...programmaticTargets, ...inPlaceTargets]

    if (allTargets.length === 0) {
      // Could not prove safety — conservative block. Includes
      // sed -i / perl -pi / writeFileSync without a literal path.
      return {
        kind: "file_write",
        recommendedTool: "edit_file_v2",
        reason: "deterministic file write through shell",
      }
    }

    const allTargetsAreEphemeral = allTargets.every((target) =>
      this.isEphemeralWritePath(target)
    )
    if (allTargetsAreEphemeral) {
      return null
    }

    return {
      kind: "file_write",
      recommendedTool: "edit_file_v2",
      reason: "deterministic file write through shell",
    }
  }

  /**
   * Split a shell command on top-level sequencing operators
   * (`;`, `&&`, `||`, `|`) while respecting single quotes, double
   * quotes, and backslash escapes so operators inside a quoted string
   * are treated as literal text. Heredoc bodies are NOT inspected — a
   * heredoc that contains `;` does not split the surrounding command.
   *
   * Returns the segments in source order. Empty segments are dropped.
   * This is a heuristic split (not a full bash parser) — sufficient
   * for false-positive avoidance in classifyAvoidableShellCommand,
   * not sufficient for security-critical validation.
   */
  private splitShellCommandSegments(command: string): string[] {
    const segments: string[] = []
    let current = ""
    let i = 0
    let inSingle = false
    let inDouble = false
    while (i < command.length) {
      const ch = command[i]
      const next = command[i + 1]
      if (inSingle) {
        current += ch
        if (ch === "'") inSingle = false
        i++
        continue
      }
      if (inDouble) {
        if (ch === "\\" && next !== undefined) {
          current += ch + next
          i += 2
          continue
        }
        current += ch
        if (ch === '"') inDouble = false
        i++
        continue
      }
      if (ch === "\\" && next !== undefined) {
        current += ch + next
        i += 2
        continue
      }
      if (ch === "'") {
        inSingle = true
        current += ch
        i++
        continue
      }
      if (ch === '"') {
        inDouble = true
        current += ch
        i++
        continue
      }
      if (ch === ";") {
        if (current.trim()) segments.push(current)
        current = ""
        i++
        continue
      }
      if (ch === "&" && next === "&") {
        if (current.trim()) segments.push(current)
        current = ""
        i += 2
        continue
      }
      if (ch === "|" && next === "|") {
        if (current.trim()) segments.push(current)
        current = ""
        i += 2
        continue
      }
      if (ch === "|") {
        if (current.trim()) segments.push(current)
        current = ""
        i++
        continue
      }
      current += ch
      i++
    }
    if (current.trim()) segments.push(current)
    return segments
  }

  /**
   * Extract write target paths from a shell command string.
   *
   * Recognizes:
   *   - `> path` and `>> path` redirection targets
   *   - `tee [flags] path1 path2 ...`
   *
   * Quoted paths (`'..'`, `".."`) are unquoted. Variable expansions like
   * `$HOME` or `${TMPDIR}` are best-effort resolved against `process.env`.
   * Returns target paths in the original case so callers can match against
   * filesystem-sensitive prefixes.
   */
  private extractShellWriteTargets(command: string): string[] {
    const targets: string[] = []
    if (!command) return targets

    // 1. Redirections: capture the token following `>` or `>>`.
    const redirectionRegex = />>?\s*('([^']*)'|"([^"]*)"|([^\s;&|<>]+))/g
    let match: RegExpExecArray | null
    while ((match = redirectionRegex.exec(command)) !== null) {
      const raw = match[2] ?? match[3] ?? match[4] ?? ""
      if (raw) targets.push(raw)
    }

    // 2. tee: capture path arguments after optional flag-prefixed tokens.
    const teeRegex = /(^|[\n;&|])\s*tee\b([^\n;|&]*)/g
    while ((match = teeRegex.exec(command)) !== null) {
      const tail = match[2] || ""
      const tokens = tail
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0)
      for (const token of tokens) {
        if (token.startsWith("-")) continue
        const stripped = token.replace(/^['"]/, "").replace(/['"]$/, "")
        if (stripped.length > 0) targets.push(stripped)
      }
    }

    // 3. Best-effort env expansion. Any unresolvable ${VAR} stays in the
    //    string and will simply fail the whitelist check, which is what
    //    we want.
    return targets.map((target) =>
      target.replace(
        /\$\{?([A-Z_][A-Z0-9_]*)\}?/gi,
        (whole: string, name: string) => {
          const value = process.env[name]
          return typeof value === "string" && value.length > 0 ? value : whole
        }
      )
    )
  }

  /**
   * Best-effort target extraction for programmatic file writes inside
   * `node -e "..."` / `python -c "..."` / similar inline scripts.
   * Pattern matches:
   *   - writeFileSync("path", ...)        // node fs
   *   - writeFile("path", ...)            // node fs (callback / promise)
   *   - fs.writeFile{Sync,}("path", ...)  // explicit fs.* form
   *   - open("path", "w")                 // python / generic
   *   - Path("path").write_text(...)      // pathlib
   *
   * Quote style: ' " ` all accepted. Only the first string literal in
   * the call's argument list is treated as the target — that matches
   * every standard write API.
   *
   * Returns the empty list when no literal path could be extracted, in
   * which case classifyAvoidableShellCommand falls back to the
   * conservative block.
   */
  private extractProgrammaticWriteTargets(command: string): string[] {
    if (!command) return []
    const targets: string[] = []
    // writeFileSync / writeFile / write_text / fs.writeFile* — first
    // argument is the path. We accept identifiers prefixed with an
    // optional `fs.` so node's `require('fs').writeFileSync` form
    // matches.
    const writeFnRegex =
      /\b(?:fs\.)?(?:writeFile(?:Sync)?|write_text)\s*\(\s*(['"`])([^'"`]+)\1/gi
    let match: RegExpExecArray | null
    while ((match = writeFnRegex.exec(command)) !== null) {
      const literal = match[2]
      if (literal) targets.push(literal)
    }
    // open("path", "w" | "a" | "x") — second positional arg distinguishes
    // write mode from read; we already gated on the regex earlier so
    // capture the first arg unconditionally.
    const openRegex =
      /\bopen\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*(['"`])(?:w|a|x)\+?\3/gi
    while ((match = openRegex.exec(command)) !== null) {
      const literal = match[2]
      if (literal) targets.push(literal)
    }
    return targets
  }

  /**
   * Best-effort target extraction for `sed -i` / `perl -pi` in-place
   * edits. The target is the LAST positional argument. We strip flags
   * and the embedded edit script, then return whatever non-flag tokens
   * remain. Multiple targets (e.g. `sed -i 's/a/b/' f1 f2`) all get
   * captured.
   */
  private extractInPlaceEditTargets(command: string): string[] {
    if (!command) return []
    const targets: string[] = []
    // Match sed -i / perl -pi tail, then split on whitespace and keep
    // tokens that don't look like flags or quoted edit scripts.
    const inPlaceRegex =
      /(^|[\n;&|])\s*(?:sed\s+(?:-[a-z]+\s+)*-i\b|perl\s+(?:-[a-z]+\s+)*-pi\b)([^\n;|&]*)/g
    let match: RegExpExecArray | null
    while ((match = inPlaceRegex.exec(command)) !== null) {
      const tail = (match[2] || "").trim()
      // Strip the first quoted edit script (either form: 's/a/b/' or "s/a/b/")
      const withoutScript = tail.replace(/(^|\s)(['"])(?:[^'"\\]|\\.)*\2/, " ")
      const tokens = withoutScript
        .split(/\s+/)
        .map((token) => token.replace(/^['"]/, "").replace(/['"]$/, ""))
        .filter(
          (token) =>
            token.length > 0 && !token.startsWith("-") && !token.includes("=")
        )
      for (const token of tokens) {
        targets.push(token)
      }
    }
    return targets
  }

  /**
   * Determines whether a shell write target lives in a path that is safe to
   * write through the terminal (smoke / tmp / explicit ephemeral dirs).
   *
   * Anything inside `<repo>` should be routed through `edit_file_v2`, but a
   * pipeline like `... | jq ... > $TMPDIR/buf.json` is legitimate and should
   * not be rejected.
   */
  private isEphemeralWritePath(rawTarget: string): boolean {
    if (!rawTarget) return false
    let target = rawTarget.trim()
    // Strip surrounding quotes one more time defensively.
    if (
      (target.startsWith("'") && target.endsWith("'")) ||
      (target.startsWith('"') && target.endsWith('"'))
    ) {
      target = target.slice(1, -1)
    }
    if (!target) return false

    // Resolve ~ and ~user expansion to HOME.
    if (target === "~" || target.startsWith("~/")) {
      const home = process.env.HOME || os.homedir()
      target = path.join(home, target.slice(target === "~" ? 1 : 2))
    }

    // Reject obviously hostile destinations early.
    if (target.includes("\0")) return false

    let resolved: string
    try {
      resolved = path.resolve(target)
    } catch {
      return false
    }

    // Build the whitelist set.
    const home = process.env.HOME || os.homedir()
    const smokeDirEnv = process.env.AGENT_VIBES_SMOKE_DIR
    const defaultSmokeDir = path.resolve(home, ".agent-vibes", "smoke")
    const agentVibesDir = path.resolve(home, ".agent-vibes")
    const tmpDirEnv = process.env.TMPDIR
    const whitelist = new Set<string>(
      [
        smokeDirEnv && path.resolve(smokeDirEnv),
        defaultSmokeDir,
        // Allow the broader ~/.agent-vibes tree (logs/, runtime/) so
        // diagnostic captures from the agent are not blocked. This still
        // excludes the workspace.
        agentVibesDir,
        tmpDirEnv && path.resolve(tmpDirEnv),
        "/tmp",
        "/var/tmp",
        "/private/tmp",
        "/private/var/tmp",
      ].filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0
      )
    )

    for (const allowedRoot of whitelist) {
      if (resolved === allowedRoot) return true
      const prefix = allowedRoot.endsWith(path.sep)
        ? allowedRoot
        : `${allowedRoot}${path.sep}`
      if (resolved.startsWith(prefix)) return true
    }
    return false
  }

  private buildAvoidableShellDispatchError(
    session: ChatSession,
    normalizedToolName: string,
    input: Record<string, unknown>
  ): string | undefined {
    if (
      normalizedToolName !== "run_terminal_command" &&
      normalizedToolName !== "run_terminal_command_v2" &&
      normalizedToolName !== "exec_command" &&
      normalizedToolName !== "shell" &&
      normalizedToolName !== "run_command"
    ) {
      return undefined
    }

    if (this.latestUserExplicitlyRequestsShellExecution(session)) {
      return undefined
    }

    const command = this.pickShellCommand(input)
    const classification = this.classifyAvoidableShellCommand(command)
    if (!classification) {
      return undefined
    }

    const commandPreview = this.truncateForToolSummary(command || "", 220)
    // classification is currently always `kind: "file_write"` — the
    // read / search / discovery shapes are no longer hard-blocked
    // (they're steered via the system prompt instead). The
    // recommendation text reflects that single remaining case; if we
    // ever re-introduce other classifications they need their own
    // recommendation strings.
    const recommendation =
      "Use edit_file_v2. For a new file, call edit_file_v2 with search " +
      "set to an empty string and replace set to the full file content. " +
      "For an existing file, read_file first, then edit_file_v2 with a " +
      "small exact search snippet."
    const message =
      `run_terminal_command rejected: ${classification.reason}; ` +
      `${recommendation} command=${JSON.stringify(commandPreview)}`
    this.logger.warn(message)
    return message
  }

  private truncateForToolSummary(value: string, maxChars: number): string {
    const normalized = value.trim()
    if (normalized.length <= maxChars) {
      return normalized
    }
    return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
  }

  private isReadOnlyInvestigativeTool(
    toolName: string,
    input: Record<string, unknown>
  ): boolean {
    switch (toolName) {
      case "read_file":
      case "read_file_v2":
      case "grep_search":
      case "file_search":
      case "list_directory":
      case "read_lints":
      case "fetch_rules":
      case "read_todos":
      case "glob_search":
      case "web_search":
      case "web_fetch":
      case "command_status":
        return true
      case "exec_command":
        return this.isReadOnlyShellCommand(this.pickShellCommand(input))
      case "run_terminal_command":
      case "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2":
      case "run_terminal_command_v2":
      case "shell":
      case "run_command":
        return this.isReadOnlyShellCommand(this.pickShellCommand(input))
      default:
        return false
    }
  }

  private isReadOnlyShellCommand(command: string | null): boolean {
    if (!command) return false
    const normalized = command.trim().toLowerCase()
    if (
      /(^|[;&|])\s*(rm|mv|cp|touch|mkdir|rmdir|git\s+(add|commit|checkout|switch|reset|restore|apply)|npm\s+(install|publish)|pnpm\s+(add|install)|yarn\s+(add|install)|bun\s+add)\b/.test(
        normalized
      )
    ) {
      return false
    }
    if (this.classifyAvoidableShellCommand(command)?.kind === "file_write") {
      return false
    }
    if (/[^\d]>>?[^&|]/.test(normalized)) {
      return false
    }

    return /^(git\s+(diff|show|status|log|grep|ls-files)\b|rg\b|grep\b|sed\b|cat\b|head\b|tail\b|ls\b|find\b|fd\b|wc\b|nl\b|awk\b|cut\b|sort\b|uniq\b|jq\b|tree\b|stat\b|pwd\b|printf\b|echo\b|eslint\b|tsc\b|go\s+test\b|pytest\b|npm\s+(test|run\s+(test|lint|typecheck|types|check))\b|pnpm\s+(test|lint|typecheck|check)\b|yarn\s+(test|lint|typecheck)\b|bun\s+(test|run\s+(lint|typecheck))\b)/.test(
      normalized
    )
  }

  private buildTopLevelContinuationPromptBudgetSnapshot(
    conversationId: string,
    session: ChatSession,
    route: ModelRouteResult,
    toolDefinitions: ToolDefinition[],
    pendingToolUseIds: string[]
  ): {
    promptTokens: number
    availableHistoryBudgetTokens: number
  } {
    const protectedContextTokens = this.isCloudCodeBackend(route.backend)
      ? this.tokenCounter.countMessages(
          this.buildGoogleContextMessages(
            session,
            conversationId
          ) as UnifiedMessage[]
        )
      : 0
    const systemPrompt = this.isCloudCodeBackend(route.backend)
      ? this.buildGoogleSystemPrompt(session)
      : this.buildSystemPrompt(session, session.deferredToolCatalog)
    const budget = this.resolveMessageBudget(route.backend, {
      session,
      protectedContextTokens,
      systemPrompt,
      toolDefinitions,
      model: session.model,
    })
    const availableHistoryBudgetTokens = Math.max(
      1,
      budget.maxTokens - budget.systemPromptTokens
    )
    let promptMessages: Array<{
      role: "user" | "assistant"
      content: MessageContent
    }>
    try {
      promptMessages = this.truncateMessagesForBackend(
        session,
        route.backend,
        {
          maxTokens: budget.maxTokens,
          systemPromptTokens: budget.systemPromptTokens,
          autoCompactTokenLimit: budget.autoCompactTokenLimit,
          predictiveCompactTokenLimit: budget.predictiveCompactTokenLimit,
        },
        {
          contextLabel: `tool continuation preflight: ${conversationId}`,
          model: route.model,
          pendingToolUseIds,
          strategy: "reactive",
          dryRun: true,
        }
      )
    } catch (error) {
      if (error instanceof ContextProjectionBudgetExceededError) {
        this.logger.warn(
          `Tool continuation preflight exceeded context budget for ${conversationId}: ` +
            `projected=${error.estimatedTokens}, budget=${error.maxTokens}; ` +
            "continuing so the compact runner can prepare the request"
        )
        return {
          promptTokens: error.estimatedTokens,
          availableHistoryBudgetTokens: Math.max(1, error.maxTokens),
        }
      }
      throw error
    }
    return {
      promptTokens: promptMessages.length
        ? this.tokenCounter.countMessages(promptMessages as UnifiedMessage[])
        : 0,
      availableHistoryBudgetTokens,
    }
  }

  private buildTopLevelContinuationDecision(
    conversationId: string,
    session: ChatSession,
    route: ModelRouteResult,
    toolDefinitions: ToolDefinition[],
    pendingToolUseIds: string[],
    normalizedHistory: Array<{
      role: "user" | "assistant"
      content: MessageContent
    }>
  ): TopLevelContinuationDecision {
    const state = this.getTopLevelAgentTurnState(session, conversationId)
    const historyTokens =
      normalizedHistory.length > 0
        ? this.tokenCounter.countMessages(normalizedHistory as UnifiedMessage[])
        : 0
    const promptBudgetSnapshot =
      this.buildTopLevelContinuationPromptBudgetSnapshot(
        conversationId,
        session,
        route,
        toolDefinitions,
        pendingToolUseIds
      )
    const promptTokens = promptBudgetSnapshot.promptTokens
    const availableHistoryBudgetTokens =
      promptBudgetSnapshot.availableHistoryBudgetTokens
    const promptUtilization = promptTokens / availableHistoryBudgetTokens
    const continuationBudget = state.continuationBudget
    const promptDelta = Math.max(
      0,
      promptTokens - continuationBudget.lastHistoryTokens
    )
    continuationBudget.continuationCount += 1
    continuationBudget.lastDeltaTokens = promptDelta
    continuationBudget.lastHistoryTokens = promptTokens
    if (
      !Number.isFinite(continuationBudget.startedAt) ||
      continuationBudget.startedAt <= 0
    ) {
      continuationBudget.startedAt = Date.now()
    }

    const reasons: string[] = []
    if (
      state.readOnlyBatchCount >= this.TOP_LEVEL_AGENT_READONLY_ADVISORY_TURNS
    ) {
      reasons.push(`consecutive_read_only_batches=${state.readOnlyBatchCount}`)
    }
    if (promptUtilization >= this.TOP_LEVEL_AGENT_READONLY_ADVISORY_WATERMARK) {
      reasons.push(
        `projected_prompt_budget=${Math.round(promptUtilization * 100)}%`
      )
    }
    if (state.mutationBarrier.verificationReadOnlyBatchCount > 0) {
      reasons.push(
        `post_mutation_verification_batches=${state.mutationBarrier.verificationReadOnlyBatchCount}`
      )
    }

    // Advise-only mode (aligned with claude-code: no force-stop, no tool
    // filtering). The advisory prompt nudges the model toward synthesis but
    // leaves the full tool set available so edits / writes can still run.
    const adviseSynthesis =
      state.readOnlyBatchCount >=
        this.TOP_LEVEL_AGENT_READONLY_ADVISORY_TURNS ||
      promptUtilization >= this.TOP_LEVEL_AGENT_READONLY_ADVISORY_WATERMARK ||
      state.mutationBarrier.verificationReadOnlyBatchCount > 0
    this.sessionManager.markSessionDirty(conversationId)

    return {
      adviseSynthesis,
      historyTokens,
      promptTokens,
      availableHistoryBudgetTokens,
      continuationCount: continuationBudget.continuationCount,
      consecutiveReadOnlyBatches: state.readOnlyBatchCount,
      verificationReadOnlyBatches:
        state.mutationBarrier.verificationReadOnlyBatchCount,
      reasons,
    }
  }

  private buildTopLevelContinuationAdvisoryPrompt(
    session: ChatSession,
    _decision: TopLevelContinuationDecision
  ): string {
    const state = session.topLevelAgentTurnState
    const readOnlyTurns = state?.readOnlyBatchCount || 0
    const editedPaths = state?.mutationBarrier.lastEditedPaths || []
    const hasInvestigationMemory =
      session.contextState.investigationMemory.length > 0
    const lines =
      editedPaths.length > 0
        ? [
            `This top-level turn already produced successful edits for: ${editedPaths
              .map((pathValue) => path.basename(pathValue))
              .join(", ")}.`,
            state?.mutationBarrier.verificationReadOnlyBatchCount
              ? `A read-only verification batch has already happened ${state.mutationBarrier.verificationReadOnlyBatchCount} time(s) after the latest successful edit.`
              : "",
            "Prefer finishing now. If one more code or document change is genuinely required, make it as a single consolidated edit batch instead of another narrow follow-up edit.",
            "Do not keep re-reading or re-editing the same file unless the transcript already shows a concrete unresolved defect in the latest contents.",
          ]
        : [
            `The current top-level agent turn has already completed ${readOnlyTurns} read-only investigative tool batches.`,
            "Prefer synthesizing from the evidence already gathered instead of repeating equivalent investigative tool calls.",
            "If the task requires a report, artifact, or file edit, do that write now instead of saying that you will do it next.",
            "Only call another tool if it is materially necessary to reduce uncertainty or validate a concrete remaining hypothesis.",
            "Do not end the task early if meaningful work is still required; continue until you can complete the request or clearly explain the blocker.",
          ]
    if (hasInvestigationMemory) {
      lines.push(
        "A summary of recent investigative evidence should be visible in context attachments; prefer reusing it instead of rebuilding the same search/read batches."
      )
    }
    return lines.join("\n\n")
  }

  private createPendingToolCheckpointResponse(
    conversationId: string,
    session: ChatSession,
    checkpointModel: string,
    workspaceRootPath: string | undefined
  ): Buffer {
    const pendingToolCalls = Array.from(session.pendingToolCalls.values()).map(
      (toolCall) => ({
        id: toolCall.toolCallId,
        name: toolCall.toolName,
        input: toolCall.toolInput,
      })
    )

    const checkpointData = {
      messageBlobIds: session.messageBlobIds,
      pendingToolCalls,
      usedTokens: session.usedTokens,
      maxTokens: this.resolveCheckpointMaxTokens(session),
      workspaceUri: workspaceRootPath
        ? `file://${workspaceRootPath}`
        : undefined,
      readPaths: Array.from(session.readPaths),
      fileStates: Object.fromEntries(session.fileStates),
      turns: session.turns,
      todos: session.todos,
      compactionHistory: this.extractCompactionHistoryForCheckpoint(session),
    }

    return this.grpcService.createConversationCheckpointResponse(
      conversationId,
      checkpointModel,
      checkpointData
    )
  }

  /**
   * Extract the bridge-side compaction trail in the shape the proto
   * `ConversationStateStructure.summary_archives` field expects.
   *
   * Bridge keeps richer metadata on each commit
   * (`ContextCompactionCommit{strategy, epoch, ...}`), but the proto
   * archive only exposes `summary` + `window_tail`-equivalent
   * (`archivedMessageCount`). Other fields (`summarized_messages`,
   * `summary_message`) require pre-compaction message bytes the
   * bridge does not retain — see comment in
   * `cursor-grpc.service.ts.createConversationCheckpointResponse` for
   * why that's intentional.
   */
  private extractCompactionHistoryForCheckpoint(
    session: ChatSession
  ): Array<{ summary: string; archivedMessageCount: number }> {
    return session.contextState.compactionHistory.map((commit) => ({
      summary: commit.summary,
      archivedMessageCount: commit.archivedMessageCount,
    }))
  }

  private *registerPreparedToolInvocation(
    conversationId: string,
    session: ChatSession,
    streamId: string | undefined,
    preparedTool: PreparedToolInvocation
  ): Generator<Buffer> {
    const { activeToolCall } = preparedTool

    if (
      this.shouldAbortSupersededStream(
        conversationId,
        streamId,
        `tool register ${activeToolCall.id}`
      )
    ) {
      return
    }

    if (preparedTool.deferredToolFamily === "glob_search") {
      this.primeGlobDeferredInputForProtocol(
        conversationId,
        preparedTool.protocolToolInput
      )
    }

    this.sessionManager.addPendingToolCall(
      conversationId,
      activeToolCall.id,
      preparedTool.protocolToolName,
      preparedTool.protocolToolInput,
      preparedTool.protocolToolFamilyHint,
      activeToolCall.modelCallId,
      preparedTool.historyToolName,
      preparedTool.historyToolInput,
      preparedTool.codexToolCallType
    )

    this.toolExecutionCoordinator.registerPendingTool(
      conversationId,
      activeToolCall.id
    )

    if (this.isEditToolInvocation(preparedTool.protocolToolName)) {
      const editInvocationSummary = this.summarizeEditInvocationForLogs(
        preparedTool.protocolToolInput as ToolInputWithPath,
        {
          historyToolName: preparedTool.historyToolName,
          protocolToolName: preparedTool.protocolToolName,
        }
      )
      this.logger.debug(
        `Registered edit tool call: ${activeToolCall.id}` +
          (editInvocationSummary ? ` | ${editInvocationSummary}` : "")
      )
    }

    const stepId = this.sessionManager.incrementStepId(conversationId)
    const lifecycleSuppression = this.describeInternalToolLifecycleSuppression(
      preparedTool.protocolToolName,
      preparedTool.deferredToolFamily
    )
    const suppressLifecycle = Boolean(lifecycleSuppression)

    if (!suppressLifecycle) {
      yield this.grpcService.createStepStartedResponse(stepId)
    } else {
      this.logger.warn(
        `Suppressed Cursor ToolCall UI lifecycle for ${preparedTool.protocolToolName}` +
          (lifecycleSuppression?.family
            ? ` (family=${lifecycleSuppression.family})`
            : "") +
          `; reason=${lifecycleSuppression?.reason || "internal_tool"}; ` +
          "result remains in model history or a dedicated interaction query."
      )
    }

    if (
      !suppressLifecycle &&
      this.shouldEmitToolCallStarted(
        preparedTool.protocolToolName,
        preparedTool.deferredToolFamily,
        preparedTool.canDispatchExec
      ) &&
      !this.shouldProjectOfficialArtifactAsCursorUi(
        preparedTool.protocolToolName,
        preparedTool.protocolToolInput
      )
    ) {
      // UI-card sidecar label
      // ────────────────────
      // The Cursor IDE renders most ToolCall.tool oneof cases as their own
      // UI card by looking up a per-case display template. The four
      // "UI-card" families below were added more recently to the agent.v1
      // proto, and older IDE builds (and some renderer paths even on
      // current builds — e.g. nested sub-agent bubbles, history replay)
      // do not yet ship a template for them. When that lookup misses,
      // the IDE falls back to a raw label like `[Tool: readTodosToolCall]`
      // sitting flush against the previous text block, with no human
      // context attached.
      //
      // The protocol-conformant fix would live on the IDE side. From the
      // bridge we cannot change the renderer, but we *can* prepend a one-
      // line human-readable announcement via a `textDelta` so the user at
      // least sees `Reading todos...` / `Updating todos...` / `Creating
      // plan...` / `Running sub-agent task: <type>` next to the raw
      // label. On builds that *do* render the card, this text shows up
      // as a brief lead-in and is harmless.
      //
      // Intentionally limited to this whitelist — every other ToolCall
      // case already gets a proper card rendering, and adding a sidecar
      // label there would just add visual noise.
      const sidecarLabel = this.resolveUiCardSidecarLabel(
        preparedTool.protocolToolName,
        preparedTool.deferredToolFamily,
        preparedTool.protocolToolInput
      )
      if (sidecarLabel) {
        yield this.grpcService.createAgentTextResponse(`${sidecarLabel}\n`)
      }

      yield this.grpcService.createToolCallStartedResponse(
        activeToolCall.id,
        preparedTool.protocolToolName,
        preparedTool.protocolToolInput,
        preparedTool.protocolToolFamilyHint,
        activeToolCall.modelCallId
      )
      this.sessionManager.markPendingToolCallStarted(
        conversationId,
        activeToolCall.id
      )
    }
  }

  /**
   * Resolves a single-line human-readable sidecar label for the four
   * "UI-card" tool families (`read_todos` / `update_todos` / `create_plan`
   * / `task`) whose dedicated ToolCall oneof cases the Cursor IDE may not
   * have a renderer template for, causing the bubble to fall back to a
   * raw `[Tool: <case>]` label. Returns `undefined` for tools that already
   * have a proper card renderer or that we should not annotate.
   *
   * Kept on the connect-stream service (not the grpc service) because the
   * decision depends on the prepared tool input, which is a connect-stream
   * concept and not part of the lower grpc envelope builders.
   */
  private resolveUiCardSidecarLabel(
    toolName: string,
    deferredFamily: DeferredToolFamily | undefined,
    input: Record<string, unknown>
  ): string | undefined {
    const family =
      deferredFamily || this.normalizeDeferredToolFamily(toolName) || toolName
    switch (family) {
      case "read_todos": {
        const statusFilter = Array.isArray(input.status_filter)
          ? input.status_filter
          : Array.isArray(input.statusFilter)
            ? input.statusFilter
            : []
        const idFilter = Array.isArray(input.id_filter)
          ? input.id_filter
          : Array.isArray(input.idFilter)
            ? input.idFilter
            : []
        const filterParts: string[] = []
        if (statusFilter.length > 0) {
          filterParts.push(`status=${statusFilter.join("|")}`)
        }
        if (idFilter.length > 0) {
          const ids = idFilter
            .map((value: unknown) => String(value))
            .filter((value: string) => value.length > 0)
          if (ids.length > 0) {
            filterParts.push(
              `ids=${ids.length > 4 ? `${ids.slice(0, 4).join(",")}…` : ids.join(",")}`
            )
          }
        }
        return filterParts.length > 0
          ? `Reading todos (${filterParts.join(", ")})`
          : "Reading todos"
      }
      case "update_todos": {
        const merge =
          input.merge === true ||
          input.merge === "true" ||
          input.merge === 1 ||
          input.merge === "1"
        const todos = Array.isArray(input.todos) ? input.todos : []
        const count = todos.length
        return merge
          ? `Updating todos (merge=true, ${count} item${count === 1 ? "" : "s"})`
          : `Updating todos (replace, ${count} item${count === 1 ? "" : "s"})`
      }
      case "create_plan": {
        const title =
          (typeof input.title === "string" && input.title.trim()) ||
          (typeof input.name === "string" && input.name.trim()) ||
          ""
        return title
          ? `Creating plan: ${title.length > 80 ? `${title.slice(0, 80)}…` : title}`
          : "Creating plan"
      }
      case "task": {
        const subagentType =
          (typeof input.subagent_type === "string" && input.subagent_type) ||
          (typeof input.subagentType === "string" && input.subagentType) ||
          "general-purpose"
        const description =
          (typeof input.description === "string" && input.description.trim()) ||
          ""
        const runInBackground =
          input.run_in_background === true || input.runInBackground === true
        const prefix = runInBackground
          ? `Spawning background sub-agent (${subagentType})`
          : `Running sub-agent (${subagentType})`
        return description
          ? `${prefix}: ${description.length > 80 ? `${description.slice(0, 80)}…` : description}`
          : prefix
      }
      default:
        return undefined
    }
  }

  /**
   * Path-level edit serialization.
   *
   * 防止同一文件被并发 edit_file_v2 抢占覆盖：同 path 的下一个 edit 必须
   * 等前一个 edit 完成（read_result 或 write_result 走完 consume 出口、
   * ChatSessionManager.clearEditPathSlot 释放 holder）才能派发 readArgs。
   *
   * 设计参考：
   *  - claude-code 的 readFileState 时间戳防并发（写时验证 mtime）
   *  - codex 的 apply_patch 串行落盘（一次性原子写）
   *
   * Cursor 协议本身只对单 toolCallId 内的
   *   readArgs(id=N) -> read_result(id=N) -> writeArgs(id=N+1) -> write_result(id=N+1)
   * 有序，跨 toolCallId **无任何串行约束**。模型一次产生 N 个
   * edit_file_v2 时，N 个 readArgs 会并行到达 client，read_result 都返回
   * 原始文件，N 个 writeArgs 用各自基于原文件的 fileText 全量覆盖磁盘 ——
   * 最后一个 write 抹掉所有前序修改。
   *
   * 实现关键：串行化全部走 ChatSessionManager 的同步 API
   * （acquireOrQueueEdit / pickNextEditForPath），dispatch 路径上不允许
   * await 任何下游事件，否则会阻塞 BiDi 主 generator 的 input 消费栈，
   * 导致 read_result/write_result 永远到不了 detach 出口、形成死锁。
   */

  private async *dispatchExecMessagesForTool(
    conversationId: string,
    session: ChatSession,
    toolCall: ActiveToolCall,
    input: Record<string, unknown>,
    dispatchTarget: ExecDispatchTarget
  ): AsyncGenerator<Buffer> {
    if (this.isEditToolInvocation(dispatchTarget.toolName)) {
      const typedInput = dispatchTarget.input as ToolInputWithPath
      const editPath = String(typedInput.path || "")

      // 同 path 串行化：尝试同步获取 path 槽。若已有持有者则把当前 edit
      // 入队，等持有者完成后由 handleToolResult 出口的 picker 派发。
      // 不在这里 await —— 保持 generator 推进，input 端才能持续消费
      // read_result/write_result 推动持有者前进。
      const acquireResult = this.sessionManager.acquireOrQueueEdit(
        conversationId,
        toolCall.id,
        editPath
      )

      if (!acquireResult.acquired) {
        this.logger.log(
          `Queued edit ${toolCall.id} on path "${editPath || "(empty)"}": ` +
            `another edit currently holds the path slot`
        )
        // pending 已登记；execId 推迟到出队派发时再注册。
        return
      }

      yield* this.dispatchEditReadArgs(
        conversationId,
        session,
        toolCall.id,
        editPath
      )
      return
    }

    const execIdNumber = this.sessionManager.nextExecId(conversationId)
    const dispatchInput = this.isMcpServerScopedTool(dispatchTarget.toolName)
      ? this.normalizeMcpServerInInput(session, dispatchTarget.input)
      : dispatchTarget.input
    const toolCallBuffer = this.grpcService.createAgentToolCallResponse(
      dispatchTarget.toolName,
      toolCall.id,
      dispatchInput,
      execIdNumber
    )
    this.sessionManager.registerPendingToolExecId(
      conversationId,
      toolCall.id,
      execIdNumber
    )
    this.toolExecutionCoordinator.markRunning(conversationId, toolCall.id)
    yield toolCallBuffer
  }

  /**
   * Dispatch edit_file_v2 by computing the complete target file text in the
   * bridge, then asking Cursor to write it.
   *
   * Cursor Agent CLI accepts plain read_file ExecServerMessage envelopes, but
   * stalls when an editToolCall lifecycle is paired with a readArgs first step.
   * Keeping the read in-process avoids that protocol deadlock while preserving
   * Cursor as the writer of record through writeArgs/write_result.
   */
  private async *dispatchEditReadArgs(
    conversationId: string,
    session: ChatSession,
    toolCallId: string,
    editPath: string
  ): AsyncGenerator<Buffer> {
    const pendingToolCall = session?.pendingToolCalls.get(toolCallId)
    const typedInput = (pendingToolCall?.toolInput || {}) as ToolInputWithPath
    const resolvedEditPath = String(typedInput.path || editPath || "")
    const allowedWorkspaceRoots =
      this.sessionManager.listAllowedWorkspaceRoots(conversationId)
    if (allowedWorkspaceRoots.length === 0) {
      this.toolExecutionCoordinator.markRunning(conversationId, toolCallId)
      yield* this.emitInlineToolResult(
        conversationId,
        toolCallId,
        "[edit error] No workspace root is available for this conversation; refusing to write from the bridge process cwd.",
        { status: "error", message: "missing workspace root" }
      )
      return
    }
    const primaryWorkspaceRoot = allowedWorkspaceRoots[0] as string

    const resolvedHostPath = resolvedEditPath
      ? path.isAbsolute(resolvedEditPath)
        ? normalizePathForBoundaryCheck(resolvedEditPath)
        : normalizePathForBoundaryCheck(
            path.resolve(primaryWorkspaceRoot, resolvedEditPath)
          )
      : ""

    const snapshot = resolvedEditPath
      ? this.sessionManager.getLatestReadSnapshot(
          conversationId,
          resolvedEditPath,
          {
            requireCoverage: false,
          }
        )
      : undefined
    let beforeContent = snapshot?.content ?? ""
    if (
      beforeContent.length === 0 &&
      resolvedHostPath &&
      this.isPathWithinAllowedWorkspaceRoots(
        conversationId,
        resolvedHostPath,
        allowedWorkspaceRoots
      )
    ) {
      try {
        beforeContent = readFileSync(resolvedHostPath, "utf8")
      } catch (error) {
        const hasCreateContent =
          typeof typedInput.file_text === "string" ||
          typeof typedInput.replace === "string" ||
          typeof typedInput.new_text === "string"
        if (!hasCreateContent) {
          const message = error instanceof Error ? error.message : String(error)
          this.logger.warn(
            `Edit ${toolCallId} could not read "${resolvedHostPath}" before write: ${message}; using empty content`
          )
        }
      }
    } else if (beforeContent.length === 0 && resolvedHostPath) {
      this.logger.warn(
        `Edit ${toolCallId} host read skipped because path is outside allowed workspace roots: ${resolvedHostPath}`
      )
    }

    if (pendingToolCall) {
      pendingToolCall.beforeContent = beforeContent
      const computedEdit = this.applyEditInputToFileText(
        beforeContent,
        typedInput
      )
      pendingToolCall.editApplyWarning = computedEdit.warning
      pendingToolCall.editFailureContext = computedEdit.failureContext
      pendingToolCall.afterContent = computedEdit.fileText
      pendingToolCall.editNoopReason = computedEdit.noopReason
    }

    const nextContent = pendingToolCall?.afterContent ?? beforeContent
    this.toolExecutionCoordinator.markRunning(conversationId, toolCallId)

    if (!resolvedHostPath) {
      yield* this.emitInlineToolResult(
        conversationId,
        toolCallId,
        "[edit error] Missing path",
        { status: "error", message: "missing path" }
      )
      return
    }

    if (
      !this.isPathWithinAllowedWorkspaceRoots(
        conversationId,
        resolvedHostPath,
        allowedWorkspaceRoots
      )
    ) {
      yield* this.emitInlineToolResult(
        conversationId,
        toolCallId,
        `[edit error] Path must stay within one of the allowed working directories: ${resolvedEditPath}`,
        { status: "error", message: "path outside workspace" }
      )
      return
    }

    if (pendingToolCall?.editApplyWarning) {
      yield* this.emitInlineToolResult(
        conversationId,
        toolCallId,
        this.buildEditFailureToolResultContent(conversationId, pendingToolCall)
          .content,
        { status: "error", message: pendingToolCall.editApplyWarning }
      )
      return
    }

    if (!pendingToolCall?.editNoopReason) {
      try {
        mkdirSync(path.dirname(resolvedHostPath), { recursive: true })
        writeFileSync(resolvedHostPath, nextContent, "utf8")
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        yield* this.emitInlineToolResult(
          conversationId,
          toolCallId,
          `[edit error] ${message}`,
          { status: "error", message }
        )
        return
      }
    }

    const content = pendingToolCall?.editNoopReason
      ? `[edit applied: no-op]\npath: ${resolvedEditPath}\nreason: ${pendingToolCall.editNoopReason}`
      : `[edit applied]\npath: ${resolvedEditPath}\nbytes: ${nextContent.length}`
    this.logger.log(
      `Applied edit tool ${toolCallId} on path "${resolvedEditPath}" in bridge-owned file writer (${nextContent.length} bytes)`
    )
    yield* this.emitInlineToolResult(
      conversationId,
      toolCallId,
      content,
      { status: "success" },
      undefined,
      "inline_edit_result",
      {
        beforeContent,
        afterContent: nextContent,
        editSuccess: this.buildEditSuccessExtraData(
          resolvedEditPath,
          beforeContent,
          nextContent
        ),
      }
    )
  }

  /**
   * 一个 edit 完成（read_result 失败、write_result 成功 / 任意 detach 出口）
   * 后调用：从队列里弹出该 path 的下一个 edit，派发 readArgs。
   *
   * 设计上保证此调用是幂等且无副作用安全的：若没有队头，pick 返回 undefined，
   * 不 yield 任何消息。
   */
  private async *dispatchNextQueuedEditForPath(
    conversationId: string,
    path: string
  ): AsyncGenerator<Buffer> {
    const next = this.sessionManager.pickNextEditForPath(conversationId, path)
    if (!next) return

    const stillPending = this.sessionManager
      .getPendingToolCallIds(conversationId)
      .includes(next.toolCallId)
    if (!stillPending) {
      // 极端竞态：被清理掉了；让队列中下一个继续轮询。
      this.logger.warn(
        `Picked queued edit ${next.toolCallId} for path "${path}" but pending entry is gone; trying next`
      )
      yield* this.dispatchNextQueuedEditForPath(conversationId, path)
      return
    }

    this.logger.log(
      `Dequeued edit ${next.toolCallId} on path "${path}" for dispatch`
    )
    const session = this.sessionManager.getSession(conversationId)
    if (!session) return
    yield* this.dispatchEditReadArgs(
      conversationId,
      session,
      next.toolCallId,
      path
    )
  }

  private async *executePreparedToolInvocation(
    conversationId: string,
    session: ChatSession,
    streamId: string | undefined,
    preparedTool: PreparedToolInvocation
  ): AsyncGenerator<Buffer, ToolDispatchOutcome> {
    const { activeToolCall } = preparedTool

    if (
      this.shouldAbortSupersededStream(
        conversationId,
        streamId,
        `tool dispatch ${activeToolCall.id}`
      )
    ) {
      return "completed_inline"
    }

    // Bridge-internal `discover_tool`. The defer-loading mechanism (see
    // tools/tool-defer-policy.ts) trims low-frequency tools out of the
    // upstream payload and surfaces them via the <deferred_tools>
    // catalog in the system prompt.  When the model asks for one we
    // serve the call inline — the catalog is already on the session,
    // no upstream / IDE round-trip is needed.  On success we add the
    // requested name to session.discoveredTools so the next turn's
    // tools array includes the full schema.
    if (
      preparedTool.canonicalToolName === DISCOVER_TOOL_NAME ||
      preparedTool.protocolToolName === DISCOVER_TOOL_NAME
    ) {
      yield* this.handleDiscoverToolInvocation(
        conversationId,
        session,
        activeToolCall,
        preparedTool.input
      )
      return this.sessionManager
        .getPendingToolCallIds(conversationId)
        .includes(activeToolCall.id)
        ? "waiting_for_result"
        : "completed_inline"
    }

    if (
      !preparedTool.deferredToolFamily &&
      preparedTool.canDispatchExec &&
      preparedTool.execDispatchTarget
    ) {
      yield* this.dispatchExecMessagesForTool(
        conversationId,
        session,
        activeToolCall,
        preparedTool.input,
        preparedTool.execDispatchTarget
      )
      return "waiting_for_result"
    }

    if (preparedTool.deferredToolFamily) {
      yield* this.runDeferredToolIfNeeded(
        conversationId,
        activeToolCall.id,
        preparedTool.protocolToolName,
        preparedTool.protocolToolInput
      )
      return this.sessionManager
        .getPendingToolCallIds(conversationId)
        .includes(activeToolCall.id)
        ? "waiting_for_result"
        : "completed_inline"
    }

    if (!preparedTool.canDispatchExec) {
      const message =
        preparedTool.dispatchErrorMessage ||
        `tool "${activeToolCall.name}" is not executable via ExecServerMessage`
      this.logger.warn(
        preparedTool.dispatchErrorMessage ||
          `Tool "${activeToolCall.name}" has no ExecServerMessage mapping; using inline error completion`
      )
      yield* this.emitInlineToolResult(
        conversationId,
        activeToolCall.id,
        `[tool error] ${message}`,
        { status: "error", message }
      )
      return "completed_inline"
    }

    return "waiting_for_result"
  }

  private async *dispatchPreparedToolBatch(
    conversationId: string,
    session: ChatSession,
    streamId: string | undefined,
    checkpointModel: string,
    workspaceRootPath: string | undefined,
    assistantBlocks: MessageContentItem[],
    preparedTools: PreparedToolInvocation[]
  ): AsyncGenerator<Buffer, ToolDispatchOutcome> {
    if (preparedTools.length === 0) {
      return "completed_inline"
    }

    for (const preparedTool of preparedTools) {
      yield* this.registerPreparedToolInvocation(
        conversationId,
        session,
        streamId,
        preparedTool
      )
    }

    const registeredSession =
      this.sessionManager.getSession(conversationId) || session
    yield this.createPendingToolCheckpointResponse(
      conversationId,
      registeredSession,
      checkpointModel,
      workspaceRootPath
    )
    this.persistAssistantToolBatchMessage(conversationId, assistantBlocks)
    this.notePreparedToolBatch(
      conversationId,
      registeredSession,
      assistantBlocks,
      preparedTools
    )

    // Wire up the turn-level batch barrier: register ALL tool call IDs in the
    // batch so that shouldDeferToolBatchContinuation() can block continuation
    // until every tool (including inline-completed ones) has settled.
    const batchToolCallIds = preparedTools.map((tool) => tool.activeToolCall.id)
    const route = this.modelRouter.resolveModel(
      registeredSession.model || checkpointModel
    )
    this.sessionManager.startAssistantToolBatch(
      conversationId,
      route.backend,
      batchToolCallIds
    )

    // Concurrent dispatch fan-out
    // ──────────────────────────
    // The agent.v1 protocol allows a parent turn to emit N independent
    // tool_use blocks (and explicitly carries an `is_parallel_worker`
    // bit on SubagentStartRequestQuery for this exact case). Old
    // behaviour was to `yield* executePreparedToolInvocation` for each
    // tool sequentially, which blocked every subsequent tool — most
    // visibly any `task` (sub-agent) tool would queue up behind the
    // earlier ones, defeating the user-observed "parallel sub-agent"
    // expectation.
    //
    // New behaviour: each `executePreparedToolInvocation` runs as its
    // own consumer of a shared `BufferChannel<Buffer>`. We fork them
    // all at once via `pipeGeneratorIntoChannel`, then `for await` on
    // the channel and yield each buffer as it arrives. The channel
    // closes when every fork has finished (or one fails). This gives
    // us interleaved buffers in real wall-clock arrival order — the
    // BiDi sink writes them out as fast as they're produced, so the
    // IDE sees genuine parallel progress.
    //
    // Edit serialisation is preserved because `acquireOrQueueEdit` is a
    // synchronous `ChatSessionManager` API: two concurrent edits to the
    // same path race on the manager's mutex, the loser parks on the
    // queue and is dispatched later by the picker on result detach.
    // Other tool families (read_file, grep_search, web_search, task,
    // ...) have no such constraint and run fully in parallel.
    const channel = new BufferChannel<Buffer>()
    const outcomes = new Array<ToolDispatchOutcome>(preparedTools.length)
    const failures: unknown[] = []

    const forkSubGenerator = async (
      preparedTool: PreparedToolInvocation,
      index: number
    ): Promise<void> => {
      const subGenerator = this.executePreparedToolInvocation(
        conversationId,
        registeredSession,
        streamId,
        preparedTool
      )
      // Cannot use the simple `pipeGeneratorIntoChannel` helper here
      // because we also need the generator's terminal *return* value
      // (the per-tool ToolDispatchOutcome). The protocol-aware part
      // of the parent turn cares whether each tool already settled
      // inline (so it doesn't need to wait for an ExecClientMessage)
      // versus is awaiting an upstream IDE response.
      let next = await subGenerator.next()
      while (next.done !== true) {
        if (!channel.push(next.value)) {
          // Channel was closed mid-flight (early failure on a sibling).
          // Stop pumping; per-fork generator is closed via finally
          // below so any active resources are released.
          break
        }
        next = await subGenerator.next()
      }
      if (next.done) {
        outcomes[index] = next.value
      } else {
        // Channel was closed before we observed `done`; ensure the
        // generator's finally blocks run.
        try {
          await subGenerator.return(undefined as unknown as ToolDispatchOutcome)
        } catch (returnError) {
          // `return()` propagating an error is not actionable here —
          // the channel-close path that triggered us already records
          // the originating failure. Log and move on.
          this.logger.warn(
            `Sub-generator return() raised after channel close ` +
              `(${preparedTool.activeToolCall.id}): ${String(returnError)}`
          )
        }
        outcomes[index] = "completed_inline"
      }
    }

    const driveAll = async (): Promise<void> => {
      const settled = await Promise.allSettled(
        preparedTools.map((tool, index) => forkSubGenerator(tool, index))
      )
      for (const result of settled) {
        if (result.status === "rejected") {
          failures.push(result.reason)
        }
      }
    }

    // Kick off the fan-out and immediately start consuming the channel.
    // We don't await `driveAll` here — that would defeat the whole
    // point. Instead, schedule it and tie the channel close to its
    // completion via .finally.
    const drivePromise = driveAll().finally(() => {
      if (failures.length > 0) {
        // Surface the FIRST failure to the consumer; subsequent ones
        // are logged for diagnosis. This matches the previous
        // sequential semantics where a thrown sub-generator aborted
        // the whole batch.
        if (failures.length > 1) {
          for (let i = 1; i < failures.length; i++) {
            this.logger.warn(
              `[parallel-tool-dispatch] Additional failure ` +
                `(${i + 1}/${failures.length}): ${String(failures[i])}`
            )
          }
        }
        channel.error(failures[0])
      } else {
        channel.close()
      }
    })

    for await (const buffer of channel) {
      yield buffer
    }
    // Channel iteration ended (drained + closed). Wait for the drive
    // promise so we propagate the very last failure if any.
    await drivePromise

    if (failures.length > 0) {
      // Re-throw the first failure for caller visibility; this matches
      // the prior sequential behaviour where the throwing sub-generator
      // would propagate up `yield*`.
      throw failures[0]
    }

    const activeSession = this.sessionManager.getSession(conversationId)
    return activeSession && activeSession.pendingToolCalls.size > 0
      ? "waiting_for_result"
      : "completed_inline"
  }

  private *emitToolCompletedAndStep(
    conversationId: string,
    session: ChatSession,
    pendingToolCall: PendingToolCall,
    toolCallId: string,
    toolResultContent: string,
    stepStartTime: number,
    extraData?: ToolCompletedExtraData,
    toolInputOverride?: Record<string, unknown>
  ): Generator<Buffer> {
    const shouldSuppressStartedFallback =
      this.shouldSuppressInternalToolLifecycleStarted(pendingToolCall.toolName)

    if (!pendingToolCall.startedEmitted && !shouldSuppressStartedFallback) {
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
    } else if (shouldSuppressStartedFallback) {
      pendingToolCall.startedEmitted = true
    }

    this.sessionManager.recordCompletedToolCall(conversationId, pendingToolCall)

    const toolCompleted = this.grpcService.createToolCallCompletedResponse(
      toolCallId,
      pendingToolCall.toolName,
      toolInputOverride || pendingToolCall.toolInput,
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

  private *emitProjectedToolCompletedAndStep(
    conversationId: string,
    session: ChatSession,
    pendingToolCall: PendingToolCall,
    toolCallId: string,
    projectedToolName: string,
    projectedToolInput: Record<string, unknown>,
    toolResultContent: string,
    stepStartTime: number,
    extraData?: ToolCompletedExtraData
  ): Generator<Buffer> {
    const shouldSuppressStartedFallback =
      this.shouldSuppressInternalToolLifecycleStarted(projectedToolName)

    if (!pendingToolCall.startedEmitted && !shouldSuppressStartedFallback) {
      const startedFallback = this.grpcService.createToolCallStartedResponse(
        toolCallId,
        projectedToolName,
        projectedToolInput,
        undefined,
        pendingToolCall.modelCallId
      )
      yield startedFallback
      pendingToolCall.startedEmitted = true
    } else if (shouldSuppressStartedFallback) {
      pendingToolCall.startedEmitted = true
    }

    this.sessionManager.recordCompletedToolCall(conversationId, pendingToolCall)

    const toolCompleted = this.grpcService.createToolCallCompletedResponse(
      toolCallId,
      projectedToolName,
      projectedToolInput,
      toolResultContent,
      undefined,
      pendingToolCall.modelCallId,
      extraData
    )
    yield toolCompleted

    const durationMs = Date.now() - stepStartTime
    yield this.grpcService.createStepCompletedResponse(
      session.stepId,
      durationMs
    )
  }

  private *emitShellToolDelta(
    toolCallId: string,
    pendingToolCall: PendingToolCall | undefined,
    deltaType: "stdout" | "stderr",
    content: string
  ): Generator<Buffer> {
    if (!content) return

    const toolCallDelta = this.grpcService.createToolCallDeltaResponse(
      toolCallId,
      pendingToolCall?.toolName || "shell",
      deltaType,
      content,
      pendingToolCall?.modelCallId || ""
    )
    if (toolCallDelta.length > 0) {
      yield toolCallDelta
    }
  }

  private extractShellResultPayload(toolResult: ParsedToolResult): {
    stdout: string
    stderr: string
    exitCode: number
    outputLocation?: {
      filePath?: string
      sizeBytes?: bigint | number
      lineCount?: bigint | number
    }
    abortReason?: number
    localExecutionTimeMs?: number
    interleavedOutput?: string
    pid?: number
    shellId?: number
    terminalsFolder?: string
    requestedSandboxPolicy?: { type?: unknown } | null
    isBackground?: boolean
    description?: string
    classifierResult?: Record<string, unknown>
    closeStdin?: boolean
    fileOutputThresholdBytes?: bigint | number
    hardTimeout?: number
    timeoutBehavior?: number
    msToWait?: number
    backgroundReason?: number
    aborted?: boolean
  } | null {
    if (!toolResult.resultData || toolResult.resultData.length === 0) {
      return null
    }

    try {
      const execMsg = fromBinary(ExecClientMessageSchema, toolResult.resultData)
      if (execMsg.message.case !== "shellResult") {
        return null
      }

      const shellResult = execMsg.message.value.result
      if (shellResult.case === "success") {
        return {
          stdout: shellResult.value.stdout || "",
          stderr: shellResult.value.stderr || "",
          exitCode: shellResult.value.exitCode ?? 0,
          outputLocation: shellResult.value.outputLocation,
          interleavedOutput: shellResult.value.interleavedOutput,
          pid: shellResult.value.pid,
          shellId: shellResult.value.shellId,
          localExecutionTimeMs: shellResult.value.localExecutionTimeMs,
          msToWait: shellResult.value.msToWait,
          backgroundReason: shellResult.value.backgroundReason,
          requestedSandboxPolicy: execMsg.message.value.sandboxPolicy,
          isBackground: execMsg.message.value.isBackground,
          terminalsFolder: execMsg.message.value.terminalsFolder,
          description: undefined,
        }
      }
      if (shellResult.case === "failure") {
        return {
          stdout: shellResult.value.stdout || "",
          stderr: shellResult.value.stderr || "",
          exitCode: shellResult.value.exitCode ?? 1,
          outputLocation: shellResult.value.outputLocation,
          interleavedOutput: shellResult.value.interleavedOutput,
          abortReason: shellResult.value.abortReason,
          localExecutionTimeMs: shellResult.value.localExecutionTimeMs,
          aborted: shellResult.value.aborted,
          requestedSandboxPolicy: execMsg.message.value.sandboxPolicy,
          isBackground: execMsg.message.value.isBackground,
          terminalsFolder: execMsg.message.value.terminalsFolder,
          pid: execMsg.message.value.pid,
        }
      }
      if (shellResult.case === "rejected") {
        return {
          stdout: "",
          stderr: shellResult.value.reason || "",
          exitCode: 126,
          requestedSandboxPolicy: execMsg.message.value.sandboxPolicy,
          isBackground: execMsg.message.value.isBackground,
          terminalsFolder: execMsg.message.value.terminalsFolder,
          pid: execMsg.message.value.pid,
        }
      }
      if (shellResult.case === "permissionDenied") {
        return {
          stdout: "",
          stderr: shellResult.value.error || "",
          exitCode: 126,
          requestedSandboxPolicy: execMsg.message.value.sandboxPolicy,
          isBackground: execMsg.message.value.isBackground,
          terminalsFolder: execMsg.message.value.terminalsFolder,
          pid: execMsg.message.value.pid,
        }
      }
      if (shellResult.case === "spawnError") {
        return {
          stdout: "",
          stderr: shellResult.value.error || "",
          exitCode: 127,
          requestedSandboxPolicy: execMsg.message.value.sandboxPolicy,
          isBackground: execMsg.message.value.isBackground,
          terminalsFolder: execMsg.message.value.terminalsFolder,
          pid: execMsg.message.value.pid,
        }
      }
      if (shellResult.case === "timeout") {
        return {
          stdout: "",
          stderr: "",
          exitCode: 124,
          requestedSandboxPolicy: execMsg.message.value.sandboxPolicy,
          isBackground: execMsg.message.value.isBackground,
          terminalsFolder: execMsg.message.value.terminalsFolder,
          pid: execMsg.message.value.pid,
        }
      }
    } catch (error) {
      this.logger.error(`Failed to parse shell result: ${String(error)}`)
    }

    return null
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
    let streamId: string | undefined
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

        if (
          conversationId &&
          this.shouldAbortSupersededStream(
            conversationId,
            streamId,
            "incoming client message"
          )
        ) {
          return
        }

        // Handle Agent control messages (heartbeats, stream close)
        if (parsed.isAgentControlMessage) {
          // Resume/control requests may arrive first on a retried stream.
          // Bind the stream to conversationId early so subsequent tool results can be matched.
          if (!conversationId && parsed.conversationId) {
            conversationId = parsed.conversationId
            this.sessionManager.getOrCreateSession(conversationId, parsed)
            streamId = this.sessionManager.rotateStreamId(conversationId)
            this.abortBackendRequestsForSupersededStreams(
              conversationId,
              streamId,
              "control-first bidi stream attached"
            )
            const reboundCount =
              this.sessionManager.rebindPendingToolCallsToCurrentStream(
                conversationId
              )
            this.logger.log(
              `BiDi control stream attached to conversation: ${conversationId} ` +
                `(streamId=${this.summarizeStreamId(streamId)}, reboundPending=${reboundCount})`
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
          } else if (
            parsed.agentControlType === "cancelAction" &&
            conversationId
          ) {
            const shouldEndStream = yield* this.handleConversationCancelAction(
              conversationId,
              parsed
            )
            if (shouldEndStream) {
              return
            }
          } else if (
            parsed.agentControlType === "prewarm" &&
            parsed.model.trim().length > 0
          ) {
            try {
              const route = this.modelRouter.resolveModel(parsed.model)
              this.startProviderWarmup(
                route,
                parsed.conversationId || conversationId,
                "protocol-prewarm"
              )
            } catch (error) {
              this.logger.debug(
                `Skipped protocol prewarm for model=${parsed.model}: ${error instanceof Error ? error.message : String(error)}`
              )
            }
          } else if (
            parsed.agentControlType === "summarizeAction" &&
            conversationId
          ) {
            this.logger.log(`ConversationAction.summarize: ${conversationId}`)
            const shouldEndStream =
              yield* this.handleConversationSummarizeAction(conversationId)
            if (shouldEndStream) {
              return
            }
          } else if (
            parsed.agentControlType === "shellCommandAction" &&
            conversationId
          ) {
            const cmd = parsed.agentControlShellCommand
            this.logger.log(
              `ConversationAction.shellCommand: ${conversationId} command="${(cmd?.command || "").substring(0, 80)}" execId=${cmd?.execId || "(none)"}`
            )
          } else if (
            parsed.agentControlType === "startPlanAction" &&
            conversationId
          ) {
            this.logger.log(`ConversationAction.startPlan: ${conversationId}`)
          } else if (
            parsed.agentControlType === "executePlanAction" &&
            conversationId
          ) {
            this.logger.log(`ConversationAction.executePlan: ${conversationId}`)
          } else if (
            parsed.agentControlType === "asyncAskQuestionCompletionAction" &&
            conversationId
          ) {
            this.logger.log(
              `ConversationAction.asyncAskQuestionCompletion: ${conversationId} toolCallId=${parsed.agentControlToolCallId || "(none)"}`
            )
            const shouldEndStream =
              yield* this.handleAsyncAskQuestionCompletionAction(
                conversationId,
                parsed,
                streamId
              )
            if (shouldEndStream) {
              return
            }
          } else if (
            parsed.agentControlType === "cancelSubagentAction" &&
            conversationId
          ) {
            const cancelledCount = this.cancelActiveForegroundSubAgent(
              conversationId,
              "cancelSubagentAction",
              {
                targetSubagentId: parsed.agentControlSubagentId || undefined,
                includeBackground: true,
              }
            )
            this.logger.log(
              `ConversationAction.cancelSubagent: ${conversationId} ` +
                `subagentId=${parsed.agentControlSubagentId || "(none)"} ` +
                `cleared=${cancelledCount}`
            )
            if (cancelledCount > 0) {
              return
            }
          } else if (
            parsed.agentControlType === "backgroundTaskCompletionAction" &&
            conversationId
          ) {
            this.logger.log(
              `ConversationAction.backgroundTaskCompletion: ${conversationId}`
            )
            const shouldEndStream =
              yield* this.handleBackgroundTaskCompletionAction(
                conversationId,
                parsed,
                streamId
              )
            if (shouldEndStream) {
              return
            }
            const sessionAfterBackgroundCompletion =
              this.sessionManager.getSession(conversationId)
            if (this.hasPendingStreamWork(sessionAfterBackgroundCompletion)) {
              this.logger.log(
                `Background task completion waiting for ${this.describePendingStreamWork(
                  sessionAfterBackgroundCompletion
                )}`
              )
              continue
            }
            yield this.grpcService.createServerHeartbeatResponse()
            yield this.grpcService.createAgentTurnEndedResponse()
            return
          } else if (
            parsed.agentControlType === "backgroundShellAction" &&
            conversationId
          ) {
            const shouldEndStream = yield* this.handleBackgroundShellAction(
              conversationId,
              parsed
            )
            if (shouldEndStream) {
              return
            }
          } else if (
            parsed.agentControlType === "backgroundSubagentAction" &&
            conversationId
          ) {
            const shouldEndStream = yield* this.handleBackgroundSubagentAction(
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
            if (!this.hasPendingStreamWork(sessionAfterFailure)) {
              return
            }
            continue
          }

          const handledRecovery =
            yield* this.handleCloudCodeProtocolRecoveryInteractionResponse(
              conversationId,
              resolvedInteraction.payload,
              rawResponse
            )
          if (handledRecovery) {
            const sessionAfterRecovery =
              this.sessionManager.getSession(conversationId)
            if (!this.hasPendingStreamWork(sessionAfterRecovery)) {
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
            if (!this.hasPendingStreamWork(sessionAfterInline)) {
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
            yield* this.handleToolResult(conversationId, parsed, { streamId })
          } catch (error) {
            const sessionAfterToolError =
              this.sessionManager.getSession(conversationId)
            if (sessionAfterToolError) {
              const routeAfterToolError = this.modelRouter.resolveModel(
                sessionAfterToolError.model
              )
              const emittedRecovery =
                yield* this.maybeEmitCloudCodeProtocolRecoveryQuery(
                  conversationId,
                  routeAfterToolError.backend,
                  routeAfterToolError.model,
                  error
                )
              if (emittedRecovery) {
                continue
              }
            }
            this.logger.error(
              `Failed to handle tool result without tearing down stream: ${String(error)}`
            )
            continue
          }

          // After handleToolResult, check if we should end the stream
          // If there are no more pending tool calls, the turn is complete
          const sessionAfterTool =
            this.sessionManager.getSession(conversationId)
          if (!this.hasPendingStreamWork(sessionAfterTool)) {
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
              `Still waiting for ${this.describePendingStreamWork(sessionAfterTool)}`
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
            streamId = this.sessionManager.rotateStreamId(conversationId)
            this.abortBackendRequestsForSupersededStreams(
              conversationId,
              streamId,
              "new bidi stream attached"
            )

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
            // resumeAction is Cursor's reconnect path for tool calls whose
            // ExecServerMessage was already delivered on an earlier stream. Tool
            // execution duration is not bounded by the request-input EOF timing,
            // so do not age out pending calls here. Staleness is resolved by
            // explicit abort controls or by a later normal user turn before it
            // starts a new model request.
            const reboundCount =
              this.sessionManager.rebindPendingToolCallsToCurrentStream(
                conversationId!
              )
            if (reboundCount > 0) {
              this.logger.log(
                `resumeAction: rebound ${reboundCount} pending tool call(s) to current stream`
              )
            }
            const stillPending = this.sessionManager.getSession(conversationId!)
            if (stillPending && stillPending.pendingToolCalls.size > 0) {
              this.logger.log(
                `resumeAction attached to stream, waiting for ${stillPending.pendingToolCalls.size} pending tool result(s)`
              )
              continue
            }
            this.logger.log(
              `resumeAction: no pending tool calls remain, proceeding as new turn`
            )
          }
          if (!parsed.isResumeAction && sessionBeforeRun?.restartRecovery) {
            this.sessionManager.clearRestartRecovery(conversationId!)
            this.logger.warn(
              `Cleared stale restart recovery for ${conversationId} on a new user turn`
            )
          }
          if (sessionBeforeRun && sessionBeforeRun.pendingToolCalls.size > 0) {
            const currentPendingIds = Array.from(
              sessionBeforeRun.pendingToolCalls.keys()
            )
            // Only resumeAction is a protocol-level instruction to wait for
            // old pending tool results. A normal userMessageAction can still
            // carry conversation_state.pending_tool_calls from Cursor's saved
            // state, but treating that as "wait instead of answering" stalls
            // ordinary chat after a tool stream closes before the IDE returns
            // the result.
            const clearedCount = this.interruptPendingToolCallsForRecovery(
              conversationId!,
              currentPendingIds,
              "new user turn arrived before previous pending tool results completed"
            )
            this.logger.warn(
              `Interrupted ${clearedCount} pending tool call(s) from previous stream; proceeding with new user turn`
            )
          }

          // Handle run turn with the established conversationId.
          yield* this.handleChatMessage(conversationId!, parsed, streamId)

          // After handleChatMessage, check if there are pending tool calls
          // If there are, continue the loop to wait for tool results
          // If not, END THE STREAM - Cursor expects each turn to be a separate BiDi stream
          const session = this.sessionManager.getSession(conversationId!)
          if (this.hasPendingStreamWork(session)) {
            this.logger.log(
              `Waiting for ${this.describePendingStreamWork(session)}`
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

      if (conversationId) {
        const sessionAtStreamEnd =
          this.sessionManager.getSession(conversationId)
        const pendingIdsAtStreamEnd = sessionAtStreamEnd
          ? Array.from(sessionAtStreamEnd.pendingToolCalls.keys())
          : []
        if (pendingIdsAtStreamEnd.length > 0 && streamId) {
          // Cursor may close/replace an AgentService/Run HTTP/2 stream after
          // receiving ExecServerMessage while the IDE is still executing the
          // tool. The follow-up can arrive on a fresh resumeAction stream,
          // carrying conversation_state.pending_tool_calls. Treat plain input
          // EOF as a transport boundary, not as a user/tool abort.
          //
          // Explicit aborts still flow through execThrow/cancelAction. New
          // user-message turns with stale pending tools are handled above
          // before the next model request starts.
          yield* this.recoverPendingToolCallsAfterInputEof(
            conversationId,
            streamId,
            pendingIdsAtStreamEnd
          )
          const remainingPendingIds = this.getPendingToolCallIdsForStream(
            conversationId,
            streamId,
            Array.from(
              this.sessionManager
                .getSession(conversationId)
                ?.pendingToolCalls.keys() ?? []
            )
          )
          if (remainingPendingIds.length > 0) {
            this.logger.warn(
              `BiDi stream ended with ${remainingPendingIds.length} pending tool call(s); ` +
                `keeping pending state for resumeAction: ${remainingPendingIds.join(", ")}`
            )
          }
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
    } finally {
      if (conversationId && streamId) {
        this.abortBackendRequestsForStream(
          conversationId,
          streamId,
          "bidi stream closed"
        )
      }
    }
  }

  /**
   * Handle initial chat message
   * conversationId is now guaranteed to be set by handleBidiStream
   *
   * CCR-aligned turn handling:
   * - Stream the full assistant turn through message_stop when possible
   * - Accumulate the tool batch for that assistant turn before dispatch
   * - Persist assistant tool_use history once per turn, then continue after the full batch
   */
  private async *handleChatMessage(
    conversationId: string,
    parsed: ParsedCursorRequest,
    streamId?: string
  ): AsyncGenerator<Buffer> {
    // Get or create session with the provided conversationId
    let session = this.sessionManager.getOrCreateSession(conversationId, parsed)
    this.resetTopLevelAgentTurnState(session, conversationId)

    // Map Cursor model name to backend model name
    const effectiveModel = parsed.model?.trim() || session.model
    if (!parsed.model?.trim()) {
      parsed.model = effectiveModel
    }
    const route = this.modelRouter.resolveModel(effectiveModel)
    const backendModel = route.model
    this.logger.debug(
      `Mapped Cursor model "${effectiveModel}" to backend model "${backendModel}" (backend=${route.backend})`
    )
    this.startProviderWarmup(route, conversationId, "initial-chat")

    // Build message history
    // For multi-turn conversations, use session.messages (which includes history)
    // For first turn, session.messages will be initialized from parsed.conversation
    let rawMessages: Array<{
      role: "user" | "assistant"
      content: MessageContent
    }>
    let _usingSessionHistory = false

    if (session.messages.length > 0) {
      _usingSessionHistory = true
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
      session =
        this.cleanSessionHistoryForTransientAssistantInfrastructureMessages(
          session,
          `chat bootstrap: ${conversationId}`
        )
      rawMessages = session.messages
      this.logger.debug(
        `Using session history for ${conversationId}: ` +
          `messages=${rawMessages.length}, records=${session.messageRecords.length}, turns=${session.turns.length}, pending=${session.pendingToolCalls.size}`
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
      {
        pendingToolUseIds,
        conversationId,
        replacementState: session.contextState.toolResultReplacementState,
      }
    )
    this.sessionManager.replaceMessages(conversationId, rawMessages)
    session = this.sessionManager.getSession(conversationId) || session

    const useGoogleContextMessages = this.isCloudCodeBackend(route.backend)
    const contextMessages = useGoogleContextMessages
      ? this.buildGoogleContextMessages(parsed, conversationId)
      : []

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

    toolsToUse = this.optimizeImplicitCodexTools(route.backend, toolsToUse, {
      webSearchEnabled: parsed.useWeb,
      webFetchEnabled: parsed.useWeb,
    })

    const mcpToolDefs =
      parsed.mcpToolDefs && parsed.mcpToolDefs.length > 0
        ? parsed.mcpToolDefs
        : session.mcpToolDefs
    // Defer-loading split. Trim low-frequency / MCP tools out of the
    // upstream payload and surface them via a one-line catalog in the
    // system prompt; the model fetches full schemas on demand via the
    // bridge-internal `discover_tool` tool.  Strategy is per-backend
    // (kiro / google-claude / codex run aggressive defer; claude-api
    // stays off so prompt cache prefix remains stable).
    const deferStrategy = pickDeferStrategy(route.backend)
    const apiToolsResult = buildToolsForApiWithDefer(toolsToUse, {
      mcpToolDefs,
      backend: route.backend,
      subagentDefinitions: this.buildSubagentDefinitionsForToolPrompt(session),
      defer: {
        strategy: deferStrategy,
        discoveredTools: session.discoveredTools,
      },
    })
    const apiTools = apiToolsResult.tools
    // Snapshot the deferred catalog onto the session so the
    // `discover_tool` handler can serve schema lookups for whichever
    // names the model saw in the system prompt this turn.
    session.deferredToolCatalog = apiToolsResult.deferred

    // System prompt is built AFTER the defer split so we can advertise
    // the catalog to the model in the same prompt.  Google
    // (CloudCode) prompt ignores the catalog because that backend's
    // own request shape doesn't currently route through buildToolsForApi
    // anyway.
    const systemPrompt = useGoogleContextMessages
      ? this.buildGoogleSystemPrompt(parsed)
      : route.backend === "codex"
        ? this.buildCodexSystemPrompt(parsed, apiToolsResult.deferred)
        : this.buildSystemPrompt(parsed, apiToolsResult.deferred)

    // Apply truncation to stay within token limits
    const budget = this.resolveMessageBudget(route.backend, {
      parsed,
      session,
      protectedContextTokens: contextMessages.length
        ? this.tokenCounter.countMessages(contextMessages as UnifiedMessage[])
        : 0,
      systemPrompt,
      toolDefinitions: apiTools,
      model: session.model,
    })
    await this.prepareContextWithCompactRunner(session, route, budget, {
      contextLabel: `chat pre-send: ${conversationId}`,
      model: route.model,
      pendingToolUseIds,
      toolDefinitions: apiTools,
      strategy: "auto",
    })

    const messages = this.truncateMessagesForBackend(
      session,
      route.backend,
      {
        maxTokens: budget.maxTokens,
        systemPromptTokens: budget.systemPromptTokens,
        autoCompactTokenLimit: budget.autoCompactTokenLimit,
        predictiveCompactTokenLimit: budget.predictiveCompactTokenLimit,
      },
      {
        contextLabel: `chat pre-send: ${conversationId}`,
        model: route.model,
        pendingToolUseIds,
        strategy: "auto",
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

    const buildChatDtoForRoute = (
      streamRoute: ModelRouteResult,
      hints?: BackendStreamHints
    ) =>
      this.buildStreamingDtoForRoute(streamRoute, {
        model: session.model,
        promptContext: parsed,
        conversationId,
        session,
        toolDefinitions: apiTools,
        pendingToolUseIds,
        thinkingLevel: parsed.thinkingLevel,
        thinkingDetailsRequested: parsed.thinkingDetailsRequested,
        budgetOverride: hints?.budgetOverride,
        buildMessages: (routeBudget) =>
          this.truncateMessagesForBackend(
            session,
            streamRoute.backend,
            {
              maxTokens: routeBudget.maxTokens,
              systemPromptTokens: routeBudget.systemPromptTokens,
              autoCompactTokenLimit: routeBudget.autoCompactTokenLimit,
              predictiveCompactTokenLimit:
                routeBudget.predictiveCompactTokenLimit,
            },
            {
              contextLabel: `chat pre-send: ${conversationId}`,
              model: streamRoute.model,
              pendingToolUseIds,
              strategy: "auto",
            }
          ) as CreateMessageDto["messages"],
      })

    const buildChatCodexRequestForRoute = (
      streamRoute: ModelRouteResult,
      hints?: BackendStreamHints
    ) =>
      this.buildCodexStreamingRequestForRoute(streamRoute, {
        model: session.model,
        promptContext: parsed,
        conversationId,
        session,
        toolDefinitions: apiTools,
        pendingToolUseIds,
        thinkingLevel: parsed.thinkingLevel,
        thinkingDetailsRequested: parsed.thinkingDetailsRequested,
        budgetOverride: hints?.budgetOverride,
        buildMessages: (routeBudget) =>
          this.truncateMessagesForBackend(
            session,
            streamRoute.backend,
            {
              maxTokens: routeBudget.maxTokens,
              systemPromptTokens: routeBudget.systemPromptTokens,
              autoCompactTokenLimit: routeBudget.autoCompactTokenLimit,
              predictiveCompactTokenLimit:
                routeBudget.predictiveCompactTokenLimit,
            },
            {
              contextLabel: `chat pre-send: ${conversationId}`,
              model: streamRoute.model,
              pendingToolUseIds,
              strategy: "auto",
            }
          ) as CodexExecutionRequest["messages"],
      })

    this.logger.debug(`Added ${apiTools.length} tool definition(s) to request`)

    // Call backend API (routed based on model name)
    try {
      const stream = this.getBackendStream(route.model, {
        buildDtoForRoute: buildChatDtoForRoute,
        buildCodexRequestForRoute: buildChatCodexRequestForRoute,
        prepareContextForRoute: async (streamRoute, hints) => {
          const streamUseGoogleContextMessages = this.isCloudCodeBackend(
            streamRoute.backend
          )
          const streamContextMessages =
            streamUseGoogleContextMessages && conversationId
              ? this.buildGoogleContextMessages(parsed, conversationId)
              : []
          const streamSystemPrompt = streamUseGoogleContextMessages
            ? this.buildGoogleSystemPrompt(parsed)
            : streamRoute.backend === "codex"
              ? this.buildCodexSystemPrompt(parsed, apiToolsResult.deferred)
              : this.buildSystemPrompt(parsed, apiToolsResult.deferred)
          const streamBudget = this.resolveMessageBudget(streamRoute.backend, {
            parsed,
            session,
            protectedContextTokens: streamContextMessages.length
              ? this.tokenCounter.countMessages(
                  streamContextMessages as UnifiedMessage[]
                )
              : 0,
            systemPrompt: streamSystemPrompt,
            toolDefinitions: apiTools,
            model: session.model,
            budgetOverride: hints?.budgetOverride,
          })
          await this.prepareContextWithCompactRunner(
            session,
            streamRoute,
            streamBudget,
            {
              contextLabel: `chat pre-send: ${conversationId}`,
              model: streamRoute.model,
              pendingToolUseIds,
              toolDefinitions: apiTools,
              strategy: hints?.budgetOverride ? "reactive" : "auto",
            }
          )
        },
        streamAbortBinding:
          streamId && conversationId
            ? {
                conversationId,
                streamId,
              }
            : undefined,
        recoveryKey: `cursor:chat:${conversationId}`,
        recoveryAttachmentSnapshot:
          this.buildContextAttachmentSnapshot(session),
      })
      const outcome = yield* this.processAssistantTurnStream({
        conversationId,
        session,
        stream,
        streamId,
        checkpointModel: parsed.model,
        workspaceRootPath: parsed.projectContext?.rootPath,
        mode: "initial",
        emitInitialHeartbeat: true,
        emitTokenDeltas: true,
        streamAbortContext: "initial backend stream",
        messageStopAbortContext: "initial backend message_stop",
      })

      if (outcome.kind === "partial_without_message_stop") {
        this.logger.warn(
          `Initial backend stream exited without message_stop after ${outcome.accumulatedText.length} chars; finalizing defensively`
        )
        yield* this.finalizeInitialAssistantTurn(
          session,
          conversationId,
          outcome.accumulatedText,
          outcome.finalUsage
        )
      }
      if (outcome.kind !== "waiting_for_results") {
        yield* this.emitPendingContextSummaryUiUpdate(conversationId)
      }
    } catch (error) {
      if (error instanceof UpstreamRequestAbortedError) {
        this.logger.log(
          `Initial backend stream aborted for ${conversationId}: ${error.message}`
        )
        return
      }

      if (
        this.shouldAbortSupersededStream(
          conversationId,
          streamId,
          "initial backend error"
        )
      ) {
        return
      }

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

      if (conversationId) {
        const emittedRecovery =
          yield* this.maybeEmitCloudCodeProtocolRecoveryQuery(
            conversationId,
            route.backend,
            backendModel,
            error
          )
        if (emittedRecovery) {
          return
        }
      }

      // Instead of throwing (which causes Cursor to show generic "Internal Error"),
      // send a friendly error message as assistant text so the user sees what's wrong.
      const friendlyMessage = this.buildBackendErrorMessage(
        backendLabel,
        backendModel,
        errorMessage
      )
      yield* this.emitAgentFinalTextResponse(session, friendlyMessage)
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

    const emittedRecovery = yield* this.maybeEmitCloudCodeProtocolRecoveryQuery(
      conversationId,
      backend,
      context.backendModel,
      error
    )
    if (emittedRecovery) {
      this.logger.warn(
        `[PostToolContinuation] Emitted Cloud Code recovery query for ${conversationId}`
      )
      return true
    }

    // Send checkpoint before turn_ended (required for rollback consistency).
    // Matches the pattern in handleChatMessage, emitAgentFinalTextResponse,
    // and handleToolResultContinuation to ensure all turn-ending paths
    // produce a valid conversationCheckpointUpdate.
    const session = this.sessionManager.getSession(conversationId)
    if (session) {
      const completedTurn = this.recordCompletedTurnIfNeeded(
        session,
        true,
        `post-tool continuation error: ${conversationId}`
      )
      for (const blobMessage of completedTurn.blobMessages) {
        yield blobMessage
      }
      const completedSession = completedTurn.session

      const checkpoint = this.grpcService.createConversationCheckpointResponse(
        conversationId,
        completedSession.model,
        {
          messageBlobIds: completedSession.messageBlobIds,
          usedTokens: completedSession.usedTokens || 0,
          maxTokens: this.resolveCheckpointMaxTokens(completedSession),
          workspaceUri: completedSession.projectContext?.rootPath
            ? `file://${completedSession.projectContext.rootPath}`
            : undefined,
          readPaths: Array.from(completedSession.readPaths),
          fileStates: Object.fromEntries(completedSession.fileStates),
          turns: completedSession.turns,
          todos: completedSession.todos,
          compactionHistory:
            this.extractCompactionHistoryForCheckpoint(completedSession),
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
    return false
  }

  private handleBackgroundCommandShellStreamEvent(
    conversationId: string,
    toolCallId: string,
    execNumericId: number | undefined,
    resultData: Buffer
  ): boolean {
    let shellStream: ShellStream
    try {
      const execMsg = fromBinary(ExecClientMessageSchema, resultData)
      if (execMsg.message.case !== "shellStream") {
        return false
      }
      shellStream = execMsg.message.value
    } catch {
      return false
    }

    const backgroundCommand =
      this.sessionManager.findBackgroundCommandByToolCallId(
        conversationId,
        toolCallId
      ) ||
      (execNumericId
        ? this.sessionManager.findBackgroundCommandByExecId(
            conversationId,
            execNumericId
          )
        : undefined)
    if (!backgroundCommand) {
      return false
    }

    switch (shellStream.event.case) {
      case "stdout":
        if (shellStream.event.value.data) {
          this.sessionManager.appendBackgroundCommandOutput(
            conversationId,
            backgroundCommand.commandId,
            "stdout",
            shellStream.event.value.data
          )
        }
        return true
      case "stderr":
        if (shellStream.event.value.data) {
          this.sessionManager.appendBackgroundCommandOutput(
            conversationId,
            backgroundCommand.commandId,
            "stderr",
            shellStream.event.value.data
          )
        }
        return true
      case "exit":
        this.sessionManager.setBackgroundCommandExit(
          conversationId,
          backgroundCommand.commandId,
          shellStream.event.value.code ?? 0,
          Boolean(shellStream.event.value.aborted)
        )
        return true
      case "rejected":
      case "permissionDenied": {
        const message =
          (shellStream.event.value as { reason?: string; error?: string })
            .reason ||
          (shellStream.event.value as { reason?: string; error?: string })
            .error ||
          "background command failed"
        this.sessionManager.appendBackgroundCommandOutput(
          conversationId,
          backgroundCommand.commandId,
          "stderr",
          message
        )
        this.sessionManager.setBackgroundCommandExit(
          conversationId,
          backgroundCommand.commandId,
          126,
          false
        )
        return true
      }
      case "backgrounded":
      case "start":
        return true
      default:
        return false
    }
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
    const activePendingToolCall = session.pendingToolCalls.get(toolCallId)

    if (
      activePendingToolCall &&
      this.shouldAbortSupersededStream(
        conversationId,
        activePendingToolCall.streamId,
        `shell stream ${toolCallId}`
      )
    ) {
      return
    }

    // Initialize shell stream tracking if not already done
    if (!this.sessionManager.getShellOutput(conversationId, toolCallId)) {
      this.sessionManager.initShellStream(conversationId, toolCallId)
    }

    // Handle start event — emit ShellOutputDeltaUpdate so Cursor UI expands the shell panel
    if (eventCase === "start") {
      this.logger.debug(`Shell stream start for ${toolCallId}`)
      this.sessionManager.markShellStarted(conversationId, toolCallId)
      const startEvent = shellStream.event.value as {
        sandboxPolicy?: { type?: unknown } | null
      }
      yield this.grpcService.createShellOutputStartResponse(
        startEvent?.sandboxPolicy
      )
      return
    }

    // Handle stdout event - send real-time update via ShellOutputDeltaUpdate
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
        yield this.grpcService.createShellOutputStdoutResponse(data)
      }
      return
    }

    // Handle stderr event - send real-time update via ShellOutputDeltaUpdate
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
        yield this.grpcService.createShellOutputStderrResponse(data)
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
      const backgroundEvent = shellStream.event.value as {
        shellId: number
        command?: string
        workingDirectory?: string
        pid?: number
        msToWait?: number
        reason?: number
      }
      const shellOutput = this.sessionManager.getShellOutput(
        conversationId,
        toolCallId
      )
      const commandId = String(backgroundEvent.shellId)
      const stdout = shellOutput?.stdout || ""
      const stderr = shellOutput?.stderr || ""
      const combinedOutput =
        `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim()
      const pendingToolCall = session.pendingToolCalls.get(toolCallId)
      if (!pendingToolCall) {
        this.logger.warn(
          `No pending tool call found for backgrounded shell stream: ${toolCallId}`
        )
        return
      }

      this.sessionManager.registerBackgroundCommand(conversationId, {
        commandId,
        originToolCallId: toolCallId,
        execIds: pendingToolCall.execIds,
        command:
          backgroundEvent.command ||
          this.pickShellCommand(pendingToolCall.toolInput) ||
          "",
        cwd:
          backgroundEvent.workingDirectory ||
          this.pickFirstString(pendingToolCall.toolInput, [
            "cwd",
            "Cwd",
            "working_directory",
            "workingDirectory",
          ]) ||
          "",
        pid: backgroundEvent.pid,
        terminalsFolder: session.requestContextEnv?.terminalsFolder,
        stdout,
        stderr,
        msToWait: backgroundEvent.msToWait,
        backgroundReason: backgroundEvent.reason,
      })

      const content =
        combinedOutput ||
        `Command running in background (CommandId: ${commandId})`
      yield* this.emitInlineToolResult(
        conversationId,
        toolCallId,
        content,
        { status: "success" },
        undefined,
        undefined,
        {
          shellResult: {
            stdout,
            stderr,
            shellId: backgroundEvent.shellId,
            pid: backgroundEvent.pid,
            msToWait: backgroundEvent.msToWait,
            backgroundReason: backgroundEvent.reason,
            terminalsFolder: session.requestContextEnv?.terminalsFolder,
            isBackground: true,
          },
        }
      )
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

      // Emit ShellOutputDeltaUpdate exit event to UI
      yield this.grpcService.createShellOutputExitResponse(
        exitCode,
        exitAborted,
        exitCwd,
        shellStream.event.case === "exit"
          ? {
              outputLocation: shellStream.event.value.outputLocation,
              abortReason: shellStream.event.value.abortReason,
              localExecutionTimeMs:
                shellStream.event.value.localExecutionTimeMs,
            }
          : undefined
      )

      this.sessionManager.setShellExit(
        conversationId,
        toolCallId,
        exitCode,
        signal || undefined
      )

      // Get accumulated output
      const shellOutput = this.sessionManager.getShellOutput(
        conversationId,
        toolCallId
      )
      const fullOutput = shellOutput
        ? `${shellOutput.stdout}${shellOutput.stderr ? `\n[stderr]\n${shellOutput.stderr}` : ""}`
        : ""

      // NOW consume the pending tool call and complete it
      this.toolExecutionCoordinator.markCompleted(conversationId, toolCallId)
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
      const historyShellToolResultContent = this.storeToolResultForHistory(
        conversationId,
        toolCallId,
        pendingToolCall.toolName,
        adaptedToolResultContent,
        pendingToolCall.toolInput,
        session.contextState.toolResultReplacementState
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

      // Add tool result to message history before any supersession return.
      // Once the pending tool call is consumed, resumed streams need the
      // persisted tool_result to reconstruct state safely.
      this.appendToolResultWithIntegrity(
        session,
        toolCallId,
        pendingToolCall.toolName,
        pendingToolCall.toolInput,
        historyShellToolResultContent,
        undefined,
        pendingToolCall.codexToolCallType || "function"
      )

      if (
        this.shouldAbortSupersededStream(
          conversationId,
          pendingToolCall.streamId,
          `shell tool continuation ${toolCallId}`
        )
      ) {
        return
      }

      // Continue AI generation
      const route = this.modelRouter.resolveModel(session.model)
      const backendModel = route.model
      const backendLabel = route.backend
      const remainingPendingToolUseIds =
        this.sessionManager.getPendingToolCallIds(conversationId)
      this.startProviderWarmup(route, conversationId, "shell-continuation", {
        pendingToolUseIds: remainingPendingToolUseIds,
      })

      if (
        this.shouldDeferToolBatchContinuation(
          conversationId,
          route.backend,
          remainingPendingToolUseIds
        )
      ) {
        this.logger.log(
          `Deferring ${route.backend} shell continuation until ${remainingPendingToolUseIds.length} pending tool result(s) arrive`
        )
        return
      }

      if (
        !this.sessionManager.claimAssistantToolBatchContinuation(
          conversationId,
          route.backend,
          toolCallId
        )
      ) {
        this.logger.log(
          `Skipping duplicate ${route.backend} shell continuation for settled batch after ${toolCallId}`
        )
        return
      }

      let activeSession =
        this.cleanSessionHistoryForTransientAssistantInfrastructureMessages(
          session,
          `shell continuation bootstrap: ${conversationId}`
        )

      const toolsToUse = this.optimizeImplicitCodexTools(
        route.backend,
        activeSession.supportedTools || [],
        {
          webSearchEnabled: activeSession.useWeb,
          webFetchEnabled: activeSession.useWeb,
        }
      )
      if (toolsToUse.length === 0) {
        this.logger.warn(
          "Tool-result continuation running with empty supportedTools (strict mode)"
        )
      }

      const apiToolsResult = buildToolsForApiWithDefer(toolsToUse, {
        mcpToolDefs: activeSession.mcpToolDefs,
        backend: route.backend,
        subagentDefinitions:
          this.buildSubagentDefinitionsForToolPrompt(activeSession),
        defer: {
          strategy: pickDeferStrategy(route.backend),
          discoveredTools: activeSession.discoveredTools,
        },
      })
      const apiTools = apiToolsResult.tools
      activeSession.deferredToolCatalog = apiToolsResult.deferred

      const normalizedShellHistory = this.normalizeHistoryForBackend(
        activeSession.messages as Array<{
          role: "user" | "assistant"
          content: MessageContent
        }>,
        `shell continuation: ${conversationId}`,
        {
          pendingToolUseIds: remainingPendingToolUseIds,
          conversationId,
          replacementState:
            activeSession.contextState.toolResultReplacementState,
        }
      )
      this.sessionManager.replaceMessages(
        conversationId,
        normalizedShellHistory
      )
      activeSession =
        this.sessionManager.getSession(conversationId) || activeSession

      const buildShellContinuationDtoForRoute = (
        streamRoute: ModelRouteResult,
        hints?: BackendStreamHints
      ) =>
        this.buildStreamingDtoForRoute(streamRoute, {
          model: activeSession.model,
          promptContext: activeSession,
          conversationId,
          session: activeSession,
          toolDefinitions: apiTools,
          pendingToolUseIds: remainingPendingToolUseIds,
          thinkingLevel: activeSession.thinkingLevel,
          thinkingDetailsRequested: activeSession.thinkingDetailsRequested,
          budgetOverride: hints?.budgetOverride,
          buildMessages: (routeBudget) =>
            this.truncateMessagesForBackend(
              activeSession,
              streamRoute.backend,
              {
                maxTokens: routeBudget.maxTokens,
                systemPromptTokens: routeBudget.systemPromptTokens,
                autoCompactTokenLimit: routeBudget.autoCompactTokenLimit,
                predictiveCompactTokenLimit:
                  routeBudget.predictiveCompactTokenLimit,
              },
              {
                contextLabel: `shell continuation: ${conversationId}`,
                model: streamRoute.model,
                pendingToolUseIds: remainingPendingToolUseIds,
                strategy: "reactive",
              }
            ) as CreateMessageDto["messages"],
        })

      const buildShellContinuationCodexRequestForRoute = (
        streamRoute: ModelRouteResult,
        hints?: BackendStreamHints
      ) =>
        this.buildCodexStreamingRequestForRoute(streamRoute, {
          model: activeSession.model,
          promptContext: activeSession,
          conversationId,
          session: activeSession,
          toolDefinitions: apiTools,
          pendingToolUseIds: remainingPendingToolUseIds,
          thinkingLevel: activeSession.thinkingLevel,
          thinkingDetailsRequested: activeSession.thinkingDetailsRequested,
          budgetOverride: hints?.budgetOverride,
          buildMessages: (routeBudget) =>
            this.truncateMessagesForBackend(
              activeSession,
              streamRoute.backend,
              {
                maxTokens: routeBudget.maxTokens,
                systemPromptTokens: routeBudget.systemPromptTokens,
                autoCompactTokenLimit: routeBudget.autoCompactTokenLimit,
                predictiveCompactTokenLimit:
                  routeBudget.predictiveCompactTokenLimit,
              },
              {
                contextLabel: `shell continuation: ${conversationId}`,
                model: streamRoute.model,
                pendingToolUseIds: remainingPendingToolUseIds,
                strategy: "reactive",
              }
            ) as CodexExecutionRequest["messages"],
        })

      try {
        const stream = this.getBackendStream(route.model, {
          buildDtoForRoute: buildShellContinuationDtoForRoute,
          buildCodexRequestForRoute: buildShellContinuationCodexRequestForRoute,
          prepareContextForRoute: async (streamRoute, hints) => {
            const useGoogleMessages = this.isCloudCodeBackend(
              streamRoute.backend
            )
            const contextMessages = useGoogleMessages
              ? this.buildGoogleContextMessages(activeSession, conversationId)
              : []
            const systemPrompt = useGoogleMessages
              ? this.buildGoogleSystemPrompt(activeSession)
              : streamRoute.backend === "codex"
                ? this.buildCodexSystemPrompt(
                    activeSession,
                    activeSession.deferredToolCatalog
                  )
                : this.buildSystemPrompt(
                    activeSession,
                    activeSession.deferredToolCatalog
                  )
            const streamBudget = this.resolveMessageBudget(
              streamRoute.backend,
              {
                session: activeSession,
                protectedContextTokens: contextMessages.length
                  ? this.tokenCounter.countMessages(
                      contextMessages as UnifiedMessage[]
                    )
                  : 0,
                systemPrompt,
                toolDefinitions: apiTools,
                model: activeSession.model,
                budgetOverride: hints?.budgetOverride,
              }
            )
            await this.prepareContextWithCompactRunner(
              activeSession,
              streamRoute,
              streamBudget,
              {
                contextLabel: `shell continuation: ${conversationId}`,
                model: streamRoute.model,
                pendingToolUseIds: remainingPendingToolUseIds,
                toolDefinitions: apiTools,
                strategy: "reactive",
              }
            )
          },
          streamAbortBinding: pendingToolCall.streamId
            ? {
                conversationId,
                streamId: pendingToolCall.streamId,
              }
            : undefined,
          recoveryKey: `cursor:shell-continuation:${conversationId}`,
          recoveryAttachmentSnapshot:
            this.buildContextAttachmentSnapshot(activeSession),
        })
        const outcome = yield* this.processAssistantTurnStream({
          conversationId,
          session: activeSession,
          stream,
          streamId: pendingToolCall.streamId,
          checkpointModel: activeSession.model,
          workspaceRootPath: activeSession.projectContext?.rootPath,
          mode: "continuation",
          emitInitialHeartbeat: false,
          emitTokenDeltas: false,
          streamAbortContext: "shell continuation stream",
          messageStopAbortContext: "shell continuation message_stop",
        })

        if (outcome.kind === "partial_without_message_stop") {
          this.logger.warn(
            `Shell continuation stream exited without message_stop after ${outcome.accumulatedText.length} chars; finalizing defensively`
          )
          yield* this.finalizeAssistantContinuationTurn(
            activeSession,
            conversationId,
            outcome.accumulatedText || undefined,
            outcome.finalUsage
          )
        }
      } catch (error) {
        if (error instanceof UpstreamRequestAbortedError) {
          this.logger.log(
            `Shell continuation aborted for ${conversationId}: ${error.message}`
          )
          return
        }

        if (
          this.shouldAbortSupersededStream(
            conversationId,
            pendingToolCall.streamId,
            "shell continuation error"
          )
        ) {
          return
        }

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
    parsed: ParsedCursorRequest,
    options: HandleToolResultOptions = {}
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

    if (
      this.shouldAbortSupersededStream(
        conversationId,
        options.streamId,
        `tool result ${toolResult.toolCallId || "(pending)"}`
      )
    ) {
      return
    }

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

    if (toolResult.resultCase === "shell_stream") {
      const handledBackgroundShellEvent =
        this.handleBackgroundCommandShellStreamEvent(
          conversationId,
          toolCallId || "",
          execNumericId,
          toolResult.resultData
        )
      if (handledBackgroundShellEvent) {
        return
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

    // Sub-agent ownership check — if this pending tool call belongs to
    // a sub-agent's LLM turn (registered with subagentOwner via
    // executeSubAgentTask), forward the raw ExecClientMessage payload to
    // SubagentExecBridgeService and short-circuit. Without this, the
    // result would feed into the parent's tool-result continuation
    // pipeline, double-settling the parent task tool. The bridge
    // resolver unblocks the sub-agent worker which formats the result
    // for the sub-agent's own message history and continues its loop.
    const pendingForOwnerCheck = session.pendingToolCalls.get(toolCallId)
    if (pendingForOwnerCheck?.subagentOwner) {
      // Stream-aware sub-agent dispatch:
      //
      //   - shellStream chunks go through `deliverShellStreamChunk`,
      //     which buffers stdout/stderr until the terminal `exit`
      //     event and then resolves the waiter with the accumulated
      //     payload. Intermediate chunks (start / stdout / stderr) do
      //     NOT settle the waiter; they only update the buffer.
      //   - everything else (read_result / grep_result / shell_result
      //     when the IDE chose the synchronous shellArgs path / etc.)
      //     resolves immediately via deliverResult, same as before.
      //
      // We must short-circuit the parent's continuation pipeline in
      // BOTH cases — the sub-agent owns the tool call, even when the
      // chunk is intermediate.
      let delivered: boolean
      if (toolResult.resultCase === "shellStream") {
        delivered = this.subagentExecBridge.deliverShellStreamChunk(
          toolCallId,
          toolResult.resultData
        )
      } else {
        delivered = this.subagentExecBridge.deliverResult(toolCallId, {
          resultData: toolResult.resultData,
          resultCase: toolResult.resultCase,
        })
      }
      if (delivered) {
        this.logger.log(
          `Routed tool result ${toolCallId} (${toolResult.resultCase}) to ` +
            `sub-agent ${pendingForOwnerCheck.subagentOwner}; bypassing ` +
            `parent continuation pipeline.`
        )
        return
      }
      // Fall through if no waiter was registered — this means the
      // sub-agent worker raced ahead (e.g. abort) and the result is
      // orphaned. Consume the pending entry so it doesn't leak.
      this.logger.warn(
        `Sub-agent owner ${pendingForOwnerCheck.subagentOwner} had no waiter ` +
          `for ${toolCallId}; consuming pending entry to prevent leak.`
      )
      this.sessionManager.consumePendingToolCall(conversationId, toolCallId)
      return
    }

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
          editPending.editFailureContext = computedEdit.failureContext
          editPending.afterContent = computedEdit.fileText
          // No-op edits: search === replace. Not a failure — record on
          // the pending toolCall so the result formatter surfaces a
          // success result with a "no-op" lead-in instead of the legacy
          // `[edit_apply_failed]` banner.
          editPending.editNoopReason = computedEdit.noopReason
          if ((computedEdit.resolvedMatches?.length || 0) > 0) {
            const reconciled = computedEdit.resolvedMatches
              ?.map((match) => {
                const requestedRange =
                  match.requestedStartLine != null ||
                  match.requestedEndLine != null
                    ? `${match.requestedStartLine ?? "?"}-${match.requestedEndLine ?? "?"}`
                    : "file-wide"
                const matchedRange = `${match.matchedStartLine}-${match.matchedEndLine}`
                const chunkLabel =
                  typeof match.chunkIndex === "number"
                    ? `chunk ${match.chunkIndex + 1} `
                    : ""
                return `${chunkLabel}${requestedRange} -> ${matchedRange}`
              })
              .join(", ")
            this.logger.log(
              `Edit ${editPending.toolCallId} reconciled requested range to exact file match: ${reconciled}`
            )
          }

          if (computedEdit.noopReason) {
            // No-op edit (search === replace). Skip writeArgs, fall
            // through to result formatting; the result builder reads
            // editPending.editNoopReason and emits a friendly success
            // result instead of the legacy `[edit_apply_failed]`
            // banner.
            this.logger.log(
              `Edit ${editPending.toolCallId} is a no-op ` +
                `(${computedEdit.noopReason}); skipping writeArgs and ` +
                `completing with success`
            )
            // Fall through — caller will consume editPending and emit
            // toolCallCompleted with success status.
          } else if (computedEdit.warning) {
            const editInputSummary = this.summarizeEditInvocationForLogs(
              typedInput,
              {
                historyToolName: editPending.historyToolName,
                protocolToolName: editPending.toolName,
                failureContext: editPending.editFailureContext,
              }
            )
            this.logger.warn(
              `Edit apply warning for ${editPending.toolCallId}: ${computedEdit.warning}` +
                (editInputSummary ? ` | ${editInputSummary}` : "")
            )
            if (computedEdit.fileText === editPending.beforeContent) {
              this.logger.warn(
                `Skipping writeArgs for edit tool ${editPending.toolCallId} because the computed edit produced no safe file changes`
              )
              // Fall through and complete the tool with the read_result plus warning.
              // This avoids falsely reporting a successful write_result/no-op.
            } else {
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
          } else {
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
    }

    // Get the pending tool call (this also removes it from pendingToolCalls)
    this.toolExecutionCoordinator.markCompleted(conversationId, toolCallId)
    const pendingToolCall = this.sessionManager.consumePendingToolCall(
      conversationId,
      toolCallId
    )

    if (!pendingToolCall) {
      this.logger.warn(`No pending tool call found for: ${toolCallId}`)
      return
    }

    // Edit serialization handoff: as soon as the holder is consumed (regardless
    // of read_result vs write_result termination, success vs warning), the
    // detach出口 (chat-session.service.detachPendingToolCall →
    // clearEditPathSlot) has already released the path slot. Now dispatch
    // the next queued edit on that path so the read→write pipeline keeps
    // moving without waiting for any tool_result UI/lifecycle work.
    //
    // Aborted / synthetic consumption paths (execThrow, recovery, missing
    // tool output) explicitly opt out via dispatchNextQueuedEditOnConsume:
    // false, because the client stream is already torn down and the queued
    // edits will be drained by the same abort caller (which feeds aborted
    // tool results for every pending tool, including the queued ones).
    const allowDispatchNextEdit =
      options.dispatchNextQueuedEditOnConsume !== false
    if (
      allowDispatchNextEdit &&
      this.isEditToolInvocation(pendingToolCall.toolName) &&
      pendingToolCall.editPath
    ) {
      yield* this.dispatchNextQueuedEditForPath(
        conversationId,
        pendingToolCall.editPath
      )
    }

    // Update toolResult with the correct toolCallId
    toolResult.toolCallId = toolCallId

    // Format tool result content
    const rawToolResultContent = this.formatToolResult(toolResult)
    let toolResultState = this.deriveToolResultState(toolResult)
    this.maybeRecordReadSnapshot(
      conversationId,
      pendingToolCall,
      rawToolResultContent,
      toolResultState
    )
    if (
      toolResult.resultCase === "read_result" &&
      pendingToolCall.editApplyWarning
    ) {
      toolResultState = {
        status: "error",
        message: pendingToolCall.editApplyWarning,
      }
    }
    const editFailureProjection =
      pendingToolCall.editApplyWarning &&
      this.isEditToolInvocation(pendingToolCall.toolName)
        ? this.buildEditFailureToolResultContent(
            conversationId,
            pendingToolCall
          )
        : undefined
    let toolResultContent = editFailureProjection
      ? editFailureProjection.content
      : this.adaptToolResultForContext(
          pendingToolCall.toolName,
          pendingToolCall.toolInput,
          rawToolResultContent
        )
    const parsedShellResult = this.extractShellResultPayload(toolResult)
    const inlineShellResult =
      (toolResult.inlineExtraData?.shellResult as
        | ToolCompletedExtraData["shellResult"]
        | undefined) || undefined
    const effectiveShellResult = parsedShellResult || inlineShellResult
    if (
      pendingToolCall.editApplyWarning &&
      toolResultState?.status === "success"
    ) {
      toolResultContent =
        `${toolResultContent}\n\n` +
        `[edit_apply_warning] ${pendingToolCall.editApplyWarning}`
    }

    // No-op edit annotation. When `applyEditInputToFileText` collapsed
    // the edit to a literal no-op (search === replace), the dispatch
    // path skipped writeArgs and we land here with the read_result as
    // the only protocol-level outcome. Replace the result content with
    // a friendly success banner so the model can see at a glance that
    // the file was already in the desired state — and crucially does
    // NOT see `[edit_apply_failed]`, which would prompt a retry loop.
    if (
      pendingToolCall.editNoopReason &&
      this.isEditToolInvocation(pendingToolCall.toolName)
    ) {
      toolResultState = { status: "success" }
      const editPath =
        (typeof (pendingToolCall.toolInput as ToolInputWithPath).path ===
        "string"
          ? (pendingToolCall.toolInput as ToolInputWithPath).path
          : undefined) || "(unknown)"
      const noopExplanation =
        pendingToolCall.editNoopReason === "identical_search_replace"
          ? "search snippet matches replacement verbatim; file already in the desired state, no changes were written"
          : `no-op (${pendingToolCall.editNoopReason})`
      toolResultContent =
        `[edit applied: no-op]\n` +
        `path: ${editPath}\n` +
        `reason: ${noopExplanation}`
    }

    // CRITICAL: For Agent mode, send real-time feedback before completion
    // Send heartbeat to keep connection alive
    this.logger.debug("Agent mode: sending HeartbeatUpdate")
    const heartbeat = this.grpcService.createHeartbeatResponse()
    yield heartbeat

    // For run_terminal_command, stream shell output via ShellOutputDeltaUpdate.
    // Started/completed updates already cover lifecycle boundaries.
    if (
      pendingToolCall.toolName === "run_terminal_command" ||
      pendingToolCall.toolName === "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2"
    ) {
      // Emit start event so Cursor UI expands the shell panel
      yield this.grpcService.createShellOutputStartResponse()

      if (effectiveShellResult?.stdout) {
        this.logger.debug(
          `Agent mode: sending shell stdout delta (${effectiveShellResult.stdout.length} chars)`
        )
        yield this.grpcService.createShellOutputStdoutResponse(
          effectiveShellResult.stdout
        )
      }

      if (effectiveShellResult?.stderr) {
        this.logger.debug(
          `Agent mode: sending shell stderr delta (${effectiveShellResult.stderr.length} chars)`
        )
        yield this.grpcService.createShellOutputStderrResponse(
          effectiveShellResult.stderr
        )
      }

      if (
        !effectiveShellResult?.stdout &&
        !effectiveShellResult?.stderr &&
        toolResultContent.length > 0
      ) {
        this.logger.debug(
          `Agent mode: sending fallback shell stdout delta (${toolResultContent.length} chars)`
        )
        yield this.grpcService.createShellOutputStdoutResponse(
          toolResultContent
        )
      }

      if (!effectiveShellResult?.isBackground) {
        yield this.grpcService.createShellOutputExitResponse(
          effectiveShellResult?.exitCode ?? 0,
          Boolean(effectiveShellResult?.aborted),
          "",
          {
            outputLocation: effectiveShellResult?.outputLocation,
            abortReason: effectiveShellResult?.abortReason,
            localExecutionTimeMs: effectiveShellResult?.localExecutionTimeMs,
          }
        )
      }
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
    if (editFailureProjection?.context) {
      extraData = {
        ...(extraData || {}),
        editFailureContext: editFailureProjection.context,
      }
    }
    if (toolResult.inlineExtraData) {
      extraData = {
        ...(extraData || {}),
        ...(toolResult.inlineExtraData as Partial<ToolCompletedExtraData>),
      }
    }
    if (toolResult.inlineProjection?.askQuestionResult) {
      extraData = {
        ...(extraData || {}),
        askQuestionResult: toolResult.inlineProjection.askQuestionResult,
      }
    }
    if (toolResult.inlineProjection?.taskSuccess) {
      extraData = {
        ...(extraData || {}),
        taskSuccess: toolResult.inlineProjection.taskSuccess,
      }
    }

    let toolInputForProjection: Record<string, unknown> =
      pendingToolCall.toolInput
    if (toolResult.inlineProjection?.webSearchResult) {
      const projected = toolResult.inlineProjection.webSearchResult
      toolInputForProjection = {
        ...pendingToolCall.toolInput,
        ...(projected.query ? { query: projected.query } : {}),
        references: Array.isArray(projected.references)
          ? projected.references.map((reference) => ({
              title: reference.title || "",
              url: reference.url || "",
              chunk: reference.chunk || "",
            }))
          : [],
      }
    }
    if (toolResult.inlineProjection?.webFetchResult) {
      const projected = toolResult.inlineProjection.webFetchResult
      toolInputForProjection = {
        ...pendingToolCall.toolInput,
        ...(projected.url ? { url: projected.url } : {}),
      }
      toolResultContent =
        typeof projected.markdown === "string"
          ? projected.markdown
          : toolResultContent
    }
    const shouldBuildEditPreview =
      this.isEditToolInvocation(pendingToolCall.toolName) &&
      toolResultState?.status === "success" &&
      !pendingToolCall.editApplyWarning

    if (shouldBuildEditPreview) {
      const toolInput = pendingToolCall.toolInput as ToolInputWithPath
      const filePath = toolInput.path
      if (filePath && typeof filePath === "string") {
        const resolvedFilePath = this.resolveWorkspaceFilePath(
          conversationId,
          filePath
        )

        // Resolve afterContent from the client-supplied write_result.
        //
        // Cursor's edit_file tool runs through a two-step protocol on the
        // client (read_result → writeArgs → write_result). The write_result
        // payload's `WriteSuccess.fileContentAfterWrite` field carries the
        // exact bytes the client wrote to disk. That is the only value that
        // is guaranteed to match what the user actually sees in the editor —
        // independently of where the bridge is running. Reading the bridge
        // host's local fs only happens to work in legacy single-host setups
        // and produces nonsensical diffs in SSH remote-development workflows
        // because the file does not exist on the bridge host (see issue #5).
        let afterContent: string | undefined = pendingToolCall.afterContent
        let afterSource =
          pendingToolCall.afterContent !== undefined
            ? "computed_edit"
            : "missing"
        if (
          toolResult.resultCase === "write_result" &&
          toolResult.resultData &&
          toolResult.resultData.length > 0
        ) {
          try {
            const execMsg = fromBinary(
              ExecClientMessageSchema,
              toolResult.resultData
            )
            if (
              execMsg.message.case === "writeResult" &&
              execMsg.message.value.result.case === "success"
            ) {
              const writeSuccess = execMsg.message.value.result.value
              if (typeof writeSuccess.fileContentAfterWrite === "string") {
                afterContent = writeSuccess.fileContentAfterWrite
                afterSource = "write_result"
              }
            }
          } catch (err) {
            this.logger.debug(
              `Failed to extract write_result.fileContentAfterWrite: ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }

        // Fallback: legacy single-host mode where the bridge can read the
        // workspace file directly. Skipped in SSH remote-development because
        // the file lives on the remote host.
        if (afterContent === undefined) {
          try {
            const fs = await import("fs/promises")
            afterContent = await fs.readFile(resolvedFilePath, "utf-8")
            afterSource = "host_fs"
          } catch (readError) {
            const errMessage =
              readError instanceof Error ? readError.message : String(readError)
            this.logger.debug(
              `Local fs unavailable for edit result (${resolvedFilePath}): ${errMessage}`
            )
          }
        }

        // beforeContent is captured during the read_result phase (see the
        // `editPending.beforeContent = readSuccessContent` branch in
        // handleToolResult). That value is the client-reported pre-edit
        // content, so it always matches afterContent's scope (whole file).
        // No fs / read-snapshot fallbacks here — both are inferior to the
        // protocol-supplied truth and would re-introduce the inconsistent
        // before/after pairs that produced "-507 / +1" hallucinations.
        const beforeContent = pendingToolCall.beforeContent
        const beforeSource =
          typeof beforeContent === "string" ? "captured_pre_edit" : "missing"

        const haveBefore = typeof beforeContent === "string"
        const haveAfter = typeof afterContent === "string"

        if (haveBefore && haveAfter) {
          const resolvedBefore = beforeContent
          const resolvedAfter = afterContent as string
          extraData = {
            ...(extraData || {}),
            beforeContent: resolvedBefore,
            afterContent: resolvedAfter,
            editSuccess: this.buildEditSuccessExtraData(
              filePath,
              resolvedBefore,
              resolvedAfter
            ),
          }
          this.logger.debug(
            `Prepared edit diff data: ${resolvedFilePath} ` +
              `(before=${resolvedBefore.length} bytes via ${beforeSource}, ` +
              `after=${resolvedAfter.length} bytes via ${afterSource})`
          )
          this.sessionManager.addFileState(
            conversationId,
            resolvedFilePath,
            resolvedBefore,
            resolvedAfter
          )
        } else {
          // Skip the synthetic diff payload so history does not display a
          // bogus "-N/+M" line delta. The textual tool result is preserved.
          this.logger.debug(
            `Skipping edit diff payload for ${pendingToolCall.toolCallId}: ` +
              `before=${beforeSource}, after=${afterSource}`
          )
        }
      }
    } else if (this.isEditToolInvocation(pendingToolCall.toolName)) {
      this.logger.debug(
        `Skipping edit diff payload for ${pendingToolCall.toolCallId} because the edit did not complete successfully`
      )
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
      pendingToolCall.toolName ===
        "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2" ||
      pendingToolCall.toolName === "run_terminal_command_v2" ||
      pendingToolCall.toolName === "run_terminal_command" ||
      pendingToolCall.toolName === "shell" ||
      pendingToolCall.toolName === "run_command"
    ) {
      // Extract ShellResult details for correct UI display
      if (effectiveShellResult) {
        extraData = {
          ...(extraData || {}),
          shellResult: {
            stdout: effectiveShellResult.stdout || toolResultContent,
            stderr: effectiveShellResult.stderr,
            exitCode: effectiveShellResult.exitCode,
            outputLocation: effectiveShellResult.outputLocation,
            abortReason: effectiveShellResult.abortReason,
            localExecutionTimeMs: effectiveShellResult.localExecutionTimeMs,
            interleavedOutput: effectiveShellResult.interleavedOutput,
            pid: effectiveShellResult.pid,
            shellId: effectiveShellResult.shellId,
            terminalsFolder: effectiveShellResult.terminalsFolder,
            requestedSandboxPolicy: effectiveShellResult.requestedSandboxPolicy,
            isBackground: effectiveShellResult.isBackground,
            description: effectiveShellResult.description,
            classifierResult: effectiveShellResult.classifierResult,
            closeStdin: effectiveShellResult.closeStdin,
            fileOutputThresholdBytes:
              effectiveShellResult.fileOutputThresholdBytes,
            hardTimeout: effectiveShellResult.hardTimeout,
            timeoutBehavior: effectiveShellResult.timeoutBehavior,
            msToWait: effectiveShellResult.msToWait,
            backgroundReason: effectiveShellResult.backgroundReason,
            aborted: effectiveShellResult.aborted,
          },
        }
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
        if (
          execMsg.message.case === "readResult" ||
          execMsg.message.case === "redactedReadResult"
        ) {
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
                rangeApplied: readResult.value.rangeApplied,
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
          } else if (listResult.case === "error") {
            // Graceful degrade for "tool-only" MCP servers.
            //
            // Some MCP servers register tools but expose no `resources`
            // surface. The MCP runtime answers list_resources with
            //   `Server "X" not found`
            // for those servers, even though they ARE mounted. From the
            // agent's perspective that is misleading: the MCP channel is
            // healthy, the server simply has no resources.
            //
            // Heuristic: if the requested server is a known mounted server
            // in this session (provider identifier appears in mcpToolDefs),
            // and the error message looks like a "not found" envelope,
            // rewrite the result to a success with `resources: []`. The
            // model can then continue without retry-looping or wrongly
            // concluding that the entire MCP channel is broken.
            const requestedServer =
              this.pickFirstString(pendingToolCall.toolInput, [
                "serverName",
                "server",
                "server_name",
              ]) || ""
            const errorMessage =
              typeof listResult.value?.error === "string"
                ? listResult.value.error
                : ""
            const looksLikeNotFound =
              /server\s+"[^"]*"\s+not\s+found/i.test(errorMessage) ||
              /not\s+found/i.test(errorMessage)
            const session = this.sessionManager.getSession(conversationId)
            // Mounted server set: each def's IDE-registry key (computed
            // once at parse time in `cursor-request-parser.ts`).
            // Falls back to the raw `providerIdentifier` when a def
            // didn't yield a usable key. The set drives the degrade
            // heuristic below so we only rewrite "not found" → empty
            // success when the requested server actually IS mounted in
            // this session (i.e. healthy tool-only server with no
            // resource surface). Genuine "server unmounted" errors are
            // preserved verbatim — mirrors claude-code's
            // ListMcpResourcesTool contract of letting the model see
            // the available-servers hint and self-correct.
            const mountedProviders = new Set<string>()
            for (const def of session?.mcpToolDefs || []) {
              const key = (
                def?.ideRegistryKey ||
                def?.providerIdentifier ||
                ""
              ).trim()
              if (!key) continue
              const normalized = normalizeMcpToolIdentifier(key)
              if (normalized) mountedProviders.add(normalized)
            }
            const normalizedRequested =
              normalizeMcpToolIdentifier(requestedServer)
            const requestedServerIsMounted =
              normalizedRequested.length > 0 &&
              mountedProviders.has(normalizedRequested)

            if (looksLikeNotFound && requestedServerIsMounted) {
              this.logger.debug(
                `list_mcp_resources: rewriting "${errorMessage}" to empty ` +
                  `success for tool-only MCP server "${requestedServer}"`
              )
              extraData = {
                ...(extraData || {}),
                listMcpResourcesSuccess: {
                  resources: [],
                },
              }
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

    if (
      pendingToolCall.toolName === "write_shell_stdin" ||
      pendingToolCall.historyToolName === "send_command_input"
    ) {
      const shellId = extraData?.writeShellStdinSuccess?.shellId
      const terminalLength =
        extraData?.writeShellStdinSuccess?.terminalFileLengthBeforeInputWritten
      if (typeof shellId === "number" && typeof terminalLength === "number") {
        this.sessionManager.updateBackgroundCommandTerminalFileLength(
          conversationId,
          String(shellId),
          terminalLength
        )
      }
    }

    const artifactUiProjection =
      pendingToolCall.toolName === "edit_file_v2" ||
      pendingToolCall.toolName === "edit"
        ? this.buildCursorArtifactUiProjection(
            conversationId,
            pendingToolCall,
            extraData?.afterContent || ""
          )
        : null

    // Send ToolCallCompleted + StepCompleted using unified lifecycle projection.
    if (artifactUiProjection) {
      yield* this.emitProjectedToolCompletedAndStep(
        conversationId,
        session,
        pendingToolCall,
        toolCallId,
        artifactUiProjection.toolName,
        artifactUiProjection.toolInput,
        artifactUiProjection.content,
        stepStartTime,
        {
          ...(extraData || {}),
          toolResultState: artifactUiProjection.toolResultState,
        }
      )
      toolResultContent = artifactUiProjection.content
      toolResultState = artifactUiProjection.toolResultState
      toolInputForProjection = artifactUiProjection.toolInput
    } else if (
      this.shouldSuppressInternalToolLifecycleCompleted(
        pendingToolCall.toolName,
        this.normalizeDeferredToolFamily(pendingToolCall.toolName)
      )
    ) {
      const lifecycleSuppression =
        this.describeInternalToolLifecycleSuppression(
          pendingToolCall.toolName,
          this.normalizeDeferredToolFamily(pendingToolCall.toolName)
        )
      this.sessionManager.recordCompletedToolCall(
        conversationId,
        pendingToolCall
      )
      this.logger.warn(
        `Suppressed Cursor ToolCall completion for ${pendingToolCall.toolName}` +
          (lifecycleSuppression?.family
            ? ` (family=${lifecycleSuppression.family})`
            : "") +
          `; reason=${lifecycleSuppression?.reason || "internal_tool"}; ` +
          `result_status=${toolResultState?.status || "unknown"}; ` +
          "result content remains in model history."
      )
    } else {
      yield* this.emitToolCompletedAndStep(
        conversationId,
        session,
        pendingToolCall,
        toolCallId,
        toolResultContent,
        stepStartTime,
        extraData,
        toolInputForProjection
      )
    }

    // CRITICAL: Immediately add tool_result to message history
    // NOTE: The assistant message with tool_use was already added in handleChatMessage
    // We only need to add the user message with tool_result here
    this.logger.log(`Adding tool_result to message history and continuing AI`)

    // Add user message with this single tool result.
    // For inline web tools, keep history content compact and source-focused so
    // the conversation transcript better matches Cursor's native tool_result
    // shape instead of dumping the entire fetched body/search blob back inline.
    const historyToolName =
      pendingToolCall.historyToolName || pendingToolCall.toolName
    const historyToolInput =
      pendingToolCall.historyToolInput || pendingToolCall.toolInput
    let historyToolResultContent = this.formatToolResultForHistory(
      historyToolName,
      historyToolInput,
      toolResultContent,
      toolResultState,
      extraData
    )
    let historyToolResultPayload: string | Array<Record<string, unknown>> =
      toolResult.inlineHistoryContent ?? historyToolResultContent
    if (typeof historyToolResultPayload === "string") {
      historyToolResultPayload = this.storeToolResultForHistory(
        conversationId,
        toolCallId,
        historyToolName,
        historyToolResultPayload,
        historyToolInput,
        session.contextState.toolResultReplacementState
      )
      historyToolResultContent = historyToolResultPayload
    }
    const historyToolStructuredContent = this.buildStructuredHistoryToolResult(
      pendingToolCall,
      historyToolResultContent,
      toolResultState,
      extraData
    )
    // Persist tool_result before any supersession return. At this point the
    // pending tool call has already been consumed, so dropping the history
    // write would strand resumed streams without either pending state or a
    // persisted tool_result to continue from.
    this.appendToolResultWithIntegrity(
      session,
      toolCallId,
      historyToolName,
      historyToolInput,
      historyToolResultPayload,
      historyToolStructuredContent,
      pendingToolCall.codexToolCallType || "function"
    )

    const completedBatchSummary = this.recordCompletedToolResultInTopLevelState(
      conversationId,
      session,
      toolCallId,
      historyToolResultContent
    )
    if (completedBatchSummary) {
      this.logger.debug(
        `Recorded internal tool-batch summary for working memory: ${completedBatchSummary.label}`
      )
    }

    if (options.continueGeneration === false) {
      this.logger.log(
        `Tool result finalized without AI continuation: ${toolCallId}`
      )
      return
    }

    if (
      this.shouldAbortSupersededStream(
        conversationId,
        options.streamId,
        `tool continuation dispatch ${toolCallId}`
      )
    ) {
      return
    }

    try {
      // Continue AI generation immediately for backends that allow partial
      // tool-result continuation. Cloud Code must wait until the current
      // assistant tool batch is fully closed.
      // Map Cursor model name to backend model name
      const route = this.modelRouter.resolveModel(session.model)
      const backendModel = route.model
      const remainingPendingToolUseIds =
        this.sessionManager.getPendingToolCallIds(conversationId)
      this.startProviderWarmup(route, conversationId, "tool-continuation", {
        pendingToolUseIds: remainingPendingToolUseIds,
      })
      this.logger.debug(
        `Mapped Cursor model "${session.model}" to backend model "${backendModel}" for tool result continuation (backend=${route.backend})`
      )

      if (
        this.shouldDeferToolBatchContinuation(
          conversationId,
          route.backend,
          remainingPendingToolUseIds
        )
      ) {
        this.logger.log(
          `Deferring ${route.backend} tool continuation until ${remainingPendingToolUseIds.length} pending tool result(s) arrive`
        )
        return
      }

      if (
        !this.sessionManager.claimAssistantToolBatchContinuation(
          conversationId,
          route.backend,
          toolCallId
        )
      ) {
        this.logger.log(
          `Skipping duplicate ${route.backend} tool continuation for settled batch after ${toolCallId}`
        )
        return
      }

      let activeSession =
        this.cleanSessionHistoryForTransientAssistantInfrastructureMessages(
          session,
          `tool continuation bootstrap: ${conversationId}`
        )

      const topLevelTurnState = this.getTopLevelAgentTurnState(
        activeSession,
        conversationId
      )
      topLevelTurnState.llmTurnCount += 1
      const toolsForContinuation = this.optimizeImplicitCodexTools(
        route.backend,
        activeSession.supportedTools || [],
        {
          webSearchEnabled: activeSession.useWeb,
          webFetchEnabled: activeSession.useWeb,
        }
      )
      if (toolsForContinuation.length === 0) {
        this.logger.warn(
          "Continuation generation running with empty supportedTools (strict mode)"
        )
      }

      const allContinuationToolsResult = buildToolsForApiWithDefer(
        toolsForContinuation,
        {
          mcpToolDefs: activeSession.mcpToolDefs,
          backend: route.backend,
          subagentDefinitions:
            this.buildSubagentDefinitionsForToolPrompt(activeSession),
          defer: {
            strategy: pickDeferStrategy(route.backend),
            discoveredTools: activeSession.discoveredTools,
          },
        }
      )
      const allContinuationTools = allContinuationToolsResult.tools
      activeSession.deferredToolCatalog = allContinuationToolsResult.deferred
      const normalizedContinuationHistory = this.normalizeHistoryForBackend(
        activeSession.messages as Array<{
          role: "user" | "assistant"
          content: MessageContent
        }>,
        `tool continuation: ${conversationId}`,
        {
          pendingToolUseIds: remainingPendingToolUseIds,
          conversationId,
          replacementState:
            activeSession.contextState.toolResultReplacementState,
        }
      )
      this.sessionManager.replaceMessages(
        conversationId,
        normalizedContinuationHistory
      )
      activeSession =
        this.sessionManager.getSession(conversationId) || activeSession

      const continuationDecision = this.buildTopLevelContinuationDecision(
        conversationId,
        activeSession,
        route,
        allContinuationTools,
        remainingPendingToolUseIds,
        normalizedContinuationHistory
      )
      const adviseSynthesis = continuationDecision.adviseSynthesis
      const continuationTools = allContinuationTools
      if (adviseSynthesis) {
        this.logger.warn(
          `Top-level agent turn advising synthesis after ${continuationDecision.consecutiveReadOnlyBatches} consecutive read-only batches; ` +
            `history=${continuationDecision.historyTokens}, prompt=${continuationDecision.promptTokens}/${continuationDecision.availableHistoryBudgetTokens} tokens, ` +
            `continuations=${continuationDecision.continuationCount}, reasons=${continuationDecision.reasons.join(", ") || "continuation_budget"}`
        )
      }
      this.sessionManager.markSessionDirty(conversationId)

      const synthesisAdvisoryPrompt = adviseSynthesis
        ? this.buildTopLevelContinuationAdvisoryPrompt(
            activeSession,
            continuationDecision
          )
        : undefined
      const additionalSystemPrompt = synthesisAdvisoryPrompt

      const buildContinuationDtoForRoute = (
        streamRoute: ModelRouteResult,
        hints?: BackendStreamHints
      ) =>
        this.buildStreamingDtoForRoute(streamRoute, {
          model: activeSession.model,
          promptContext: activeSession,
          conversationId,
          session: activeSession,
          toolDefinitions: continuationTools,
          additionalSystemPrompt,
          pendingToolUseIds: remainingPendingToolUseIds,
          thinkingLevel: activeSession.thinkingLevel,
          thinkingDetailsRequested: activeSession.thinkingDetailsRequested,
          budgetOverride: hints?.budgetOverride,
          buildMessages: (routeBudget) =>
            this.truncateMessagesForBackend(
              activeSession,
              streamRoute.backend,
              {
                maxTokens: routeBudget.maxTokens,
                systemPromptTokens: routeBudget.systemPromptTokens,
                autoCompactTokenLimit: routeBudget.autoCompactTokenLimit,
                predictiveCompactTokenLimit:
                  routeBudget.predictiveCompactTokenLimit,
              },
              {
                contextLabel: `tool continuation: ${conversationId}`,
                model: streamRoute.model,
                pendingToolUseIds: remainingPendingToolUseIds,
                strategy: "reactive",
              }
            ) as CreateMessageDto["messages"],
        })

      const buildContinuationCodexRequestForRoute = (
        streamRoute: ModelRouteResult,
        hints?: BackendStreamHints
      ) =>
        this.buildCodexStreamingRequestForRoute(streamRoute, {
          model: activeSession.model,
          promptContext: activeSession,
          conversationId,
          session: activeSession,
          toolDefinitions: continuationTools,
          additionalSystemPrompt,
          pendingToolUseIds: remainingPendingToolUseIds,
          thinkingLevel: activeSession.thinkingLevel,
          thinkingDetailsRequested: activeSession.thinkingDetailsRequested,
          budgetOverride: hints?.budgetOverride,
          buildMessages: (routeBudget) =>
            this.truncateMessagesForBackend(
              activeSession,
              streamRoute.backend,
              {
                maxTokens: routeBudget.maxTokens,
                systemPromptTokens: routeBudget.systemPromptTokens,
                autoCompactTokenLimit: routeBudget.autoCompactTokenLimit,
                predictiveCompactTokenLimit:
                  routeBudget.predictiveCompactTokenLimit,
              },
              {
                contextLabel: `tool continuation: ${conversationId}`,
                model: streamRoute.model,
                pendingToolUseIds: remainingPendingToolUseIds,
                strategy: "reactive",
              }
            ) as CodexExecutionRequest["messages"],
        })

      // Stream the continuation - may include more tool calls (routed based on model)
      const stream = this.getBackendStream(route.model, {
        buildDtoForRoute: buildContinuationDtoForRoute,
        buildCodexRequestForRoute: buildContinuationCodexRequestForRoute,
        prepareContextForRoute: async (streamRoute, hints) => {
          const useGoogleMessages = this.isCloudCodeBackend(streamRoute.backend)
          const contextMessages = useGoogleMessages
            ? this.buildGoogleContextMessages(activeSession, conversationId)
            : []
          const baseSystemPrompt = useGoogleMessages
            ? this.buildGoogleSystemPrompt(activeSession)
            : streamRoute.backend === "codex"
              ? this.buildCodexSystemPrompt(
                  activeSession,
                  activeSession.deferredToolCatalog
                )
              : this.buildSystemPrompt(
                  activeSession,
                  activeSession.deferredToolCatalog
                )
          const systemPrompt = additionalSystemPrompt
            ? [baseSystemPrompt, additionalSystemPrompt]
                .filter(
                  (part) => typeof part === "string" && part.trim().length > 0
                )
                .join("\n\n")
            : baseSystemPrompt
          const streamBudget = this.resolveMessageBudget(streamRoute.backend, {
            session: activeSession,
            protectedContextTokens: contextMessages.length
              ? this.tokenCounter.countMessages(
                  contextMessages as UnifiedMessage[]
                )
              : 0,
            systemPrompt,
            toolDefinitions: continuationTools,
            model: activeSession.model,
            budgetOverride: hints?.budgetOverride,
          })
          await this.prepareContextWithCompactRunner(
            activeSession,
            streamRoute,
            streamBudget,
            {
              contextLabel: `tool continuation: ${conversationId}`,
              model: streamRoute.model,
              pendingToolUseIds: remainingPendingToolUseIds,
              toolDefinitions: continuationTools,
              strategy: "reactive",
            }
          )
        },
        streamAbortBinding: options.streamId
          ? {
              conversationId,
              streamId: options.streamId,
            }
          : undefined,
        recoveryKey: `cursor:tool-continuation:${conversationId}`,
        recoveryAttachmentSnapshot:
          this.buildContextAttachmentSnapshot(activeSession),
      })
      const outcome = yield* this.processAssistantTurnStream({
        conversationId,
        session: activeSession,
        stream,
        streamId: options.streamId,
        checkpointModel: activeSession.model,
        workspaceRootPath: activeSession.projectContext?.rootPath,
        mode: "continuation",
        emitInitialHeartbeat: true,
        emitTokenDeltas: true,
        streamAbortContext: "tool continuation stream",
        messageStopAbortContext: "tool continuation message_stop",
      })

      if (outcome.kind === "empty") {
        this.logger.warn(
          `[Empty Stream] Continuation returned empty response for ${conversationId}; retrying once`
        )

        // Retry: rebuild and resend the same continuation request
        try {
          const retryStream = this.getBackendStream(route.model, {
            buildDtoForRoute: buildContinuationDtoForRoute,
            buildCodexRequestForRoute: buildContinuationCodexRequestForRoute,
            prepareContextForRoute: async (streamRoute, hints) => {
              const useGoogleMessages = this.isCloudCodeBackend(
                streamRoute.backend
              )
              const contextMessages = useGoogleMessages
                ? this.buildGoogleContextMessages(activeSession, conversationId)
                : []
              const baseSystemPrompt = useGoogleMessages
                ? this.buildGoogleSystemPrompt(activeSession)
                : streamRoute.backend === "codex"
                  ? this.buildCodexSystemPrompt(
                      activeSession,
                      activeSession.deferredToolCatalog
                    )
                  : this.buildSystemPrompt(
                      activeSession,
                      activeSession.deferredToolCatalog
                    )
              const systemPrompt = additionalSystemPrompt
                ? [baseSystemPrompt, additionalSystemPrompt]
                    .filter(
                      (part) =>
                        typeof part === "string" && part.trim().length > 0
                    )
                    .join("\n\n")
                : baseSystemPrompt
              const streamBudget = this.resolveMessageBudget(
                streamRoute.backend,
                {
                  session: activeSession,
                  protectedContextTokens: contextMessages.length
                    ? this.tokenCounter.countMessages(
                        contextMessages as UnifiedMessage[]
                      )
                    : 0,
                  systemPrompt,
                  toolDefinitions: continuationTools,
                  model: activeSession.model,
                  budgetOverride: hints?.budgetOverride,
                }
              )
              await this.prepareContextWithCompactRunner(
                activeSession,
                streamRoute,
                streamBudget,
                {
                  contextLabel: `tool continuation retry: ${conversationId}`,
                  model: streamRoute.model,
                  pendingToolUseIds: remainingPendingToolUseIds,
                  toolDefinitions: continuationTools,
                  strategy: "reactive",
                }
              )
            },
            streamAbortBinding: options.streamId
              ? {
                  conversationId,
                  streamId: options.streamId,
                }
              : undefined,
            recoveryKey: `cursor:tool-continuation:${conversationId}`,
            recoveryAttachmentSnapshot:
              this.buildContextAttachmentSnapshot(activeSession),
          })
          const retryOutcome = yield* this.processAssistantTurnStream({
            conversationId,
            session: activeSession,
            stream: retryStream,
            streamId: options.streamId,
            checkpointModel: activeSession.model,
            workspaceRootPath: activeSession.projectContext?.rootPath,
            mode: "continuation",
            emitInitialHeartbeat: false,
            emitTokenDeltas: true,
            streamAbortContext: "tool continuation retry stream",
            messageStopAbortContext: "tool continuation retry message_stop",
          })

          if (retryOutcome.kind === "partial_without_message_stop") {
            this.logger.warn(
              `[Retry] Stream exited after text output without message_stop for ${conversationId}; finalizing turn defensively`
            )
            yield* this.finalizeAssistantContinuationTurn(
              activeSession,
              conversationId,
              retryOutcome.accumulatedText || undefined,
              retryOutcome.finalUsage
            )
            return
          }

          if (retryOutcome.kind !== "empty") {
            if (retryOutcome.kind !== "waiting_for_results") {
              yield* this.emitPendingContextSummaryUiUpdate(conversationId)
            }
            return
          }
        } catch (retryError) {
          if (retryError instanceof UpstreamRequestAbortedError) {
            this.logger.log(
              `Tool continuation retry aborted for ${conversationId}: ${retryError.message}`
            )
            return
          }
          this.logger.warn(`[Empty Stream] Retry failed: ${String(retryError)}`)
        }

        // Both attempts returned empty — emit fallback text to maintain
        // protocol integrity. Without this, Cursor receives no assistant
        // output and opens a new chat window.
        if (
          this.shouldAbortSupersededStream(
            conversationId,
            options.streamId,
            "tool continuation empty-stream fallback"
          )
        ) {
          return
        }
        this.logger.warn(
          `[Empty Stream] Both attempts returned empty for ${conversationId}; emitting fallback text response`
        )
        yield* this.emitAgentFinalTextResponse(
          session,
          "I'll continue from here. What would you like me to do next?"
        )
        return
      }

      if (outcome.kind === "partial_without_message_stop") {
        this.logger.warn(
          `Continuation stream exited after text output without message_stop for ${conversationId}; finalizing turn defensively`
        )
        yield* this.finalizeAssistantContinuationTurn(
          activeSession,
          conversationId,
          outcome.accumulatedText || undefined,
          outcome.finalUsage
        )
        yield* this.emitPendingContextSummaryUiUpdate(conversationId)
        return
      }

      if (outcome.kind !== "waiting_for_results") {
        yield* this.emitPendingContextSummaryUiUpdate(conversationId)
      }
      return
    } catch (error) {
      if (error instanceof UpstreamRequestAbortedError) {
        this.logger.log(
          `Tool continuation aborted for ${conversationId}: ${error.message}`
        )
        return
      }

      if (
        this.shouldAbortSupersededStream(
          conversationId,
          options.streamId,
          "tool continuation error"
        )
      ) {
        return
      }

      const repaired = this.repairMissingToolOutputProtocolState(
        conversationId,
        `tool continuation: ${conversationId}`,
        error
      )
      if (repaired) {
        this.logger.warn(
          `[PostToolContinuation] Repaired tool protocol state for ${conversationId} after backend rejection`
        )
      }
      yield* this.emitPostToolContinuationError(
        conversationId,
        this.modelRouter.resolveModel(session.model).backend,
        error,
        {
          toolCallId,
          toolName: pendingToolCall.toolName,
          cursorModel: session.model,
          backendModel: this.modelRouter.resolveModel(session.model).model,
        }
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
      // falls through — SubagentAwaitResult: complete、RecordScreenResult: saveSuccess/discardSuccess
      case "complete":
      case "stillRunning":
      case "saveSuccess":
      case "discardSuccess":
        return { status: "success", message }
      case "failure":
        return { status: "failure", message }
      case "error":
      case "fileBusy":
      case "noSpace":
      // falls through — McpResult: toolNotFound、SubagentAwaitResult: notFound
      case "toolNotFound":
      case "notFound":
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

      if (msgCase === "readResult" || msgCase === "redactedReadResult") {
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

      // 非标准结构 Result：没有 oneOf result 字段，generic 路径无法处理
      if (
        msgCase === "forceBackgroundShellResult" ||
        msgCase === "forceBackgroundSubagentResult"
      ) {
        // ForceBackgroundShellResult { status: enum(0=UNSPECIFIED, 1=ACCEPTED, 2=NOT_FOUND) }
        const statusEnum = (execMsg.message.value as { status?: number }).status
        if (statusEnum === 1) return { status: "success" }
        if (statusEnum === 2) return { status: "error", message: "not found" }
        return { status: "error", message: "unspecified status" }
      }
      if (msgCase === "executeHookResult") {
        // ExecuteHookResult { response: ExecuteHookResponse }
        // 有 response 就表示成功
        return { status: "success" }
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

      // ──── Read Result / Redacted Read Result ────
      if (msgCase === "readResult" || msgCase === "redactedReadResult") {
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

      // ──── List MCP Resources Result ────
      if (msgCase === "listMcpResourcesExecResult") {
        return this.formatListMcpResourcesResultTyped(execMsg.message.value)
      }

      // ──── Read MCP Resource Result ────
      if (msgCase === "readMcpResourceExecResult") {
        return this.formatReadMcpResourceResultTyped(execMsg.message.value)
      }

      // ──── 非标准结构 Result 专门格式化 ────

      // ForceBackgroundShellResult / ForceBackgroundSubagentResult: { status: enum }
      if (
        msgCase === "forceBackgroundShellResult" ||
        msgCase === "forceBackgroundSubagentResult"
      ) {
        const statusEnum = (execMsg.message.value as { status?: number }).status
        const label =
          msgCase === "forceBackgroundShellResult"
            ? "forceBackgroundShell"
            : "forceBackgroundSubagent"
        if (statusEnum === 1) return `[${label}] accepted`
        if (statusEnum === 2) return `[${label}] not found`
        return `[${label}] status=${statusEnum ?? "unspecified"}`
      }

      // ExecuteHookResult: { response: ExecuteHookResponse }
      if (msgCase === "executeHookResult") {
        const payload = execMsg.message.value as {
          response?: { response?: { case?: string; value?: unknown } }
        }
        const hookCase = payload.response?.response?.case || "(unknown)"
        return `[executeHook] response=${hookCase}`
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

  private resolveImageMediaType(
    filePath: string,
    fileBytes?: Uint8Array
  ): string {
    const ext = path.extname(filePath).toLowerCase()
    if (ext === ".png") return "image/png"
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
    if (ext === ".gif") return "image/gif"
    if (ext === ".webp") return "image/webp"
    if (ext === ".svg") return "image/svg+xml"

    if (fileBytes && fileBytes.length >= 12) {
      if (
        fileBytes[0] === 0x89 &&
        fileBytes[1] === 0x50 &&
        fileBytes[2] === 0x4e &&
        fileBytes[3] === 0x47
      ) {
        return "image/png"
      }
      if (fileBytes[0] === 0xff && fileBytes[1] === 0xd8) {
        return "image/jpeg"
      }
      if (
        fileBytes[0] === 0x47 &&
        fileBytes[1] === 0x49 &&
        fileBytes[2] === 0x46
      ) {
        return "image/gif"
      }
      if (
        fileBytes[0] === 0x52 &&
        fileBytes[1] === 0x49 &&
        fileBytes[2] === 0x46 &&
        fileBytes[3] === 0x46 &&
        fileBytes[8] === 0x57 &&
        fileBytes[9] === 0x45 &&
        fileBytes[10] === 0x42 &&
        fileBytes[11] === 0x50
      ) {
        return "image/webp"
      }
    }

    return "application/octet-stream"
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
        let omittedLines = 0
        const appendPreviewLine = (line: string) => {
          if (lines.length < this.GREP_RESULT_PREVIEW_MAX_LINES) {
            lines.push(line)
            return
          }
          omittedLines++
        }
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
                      appendPreviewLine(
                        `${fileMatch.file}:${m.lineNumber}:${m.content}`
                      )
                    }
                  }
                }
              }
            }
            if (contentResult.totalMatchedLines) {
              appendPreviewLine(
                `(${contentResult.totalMatchedLines} total matched lines)`
              )
            }
          } else if (ur.result.case === "files") {
            // GrepFilesResult { files: string[] }
            const filesResult = ur.result.value
            if (filesResult.files) {
              for (const file of filesResult.files) {
                appendPreviewLine(file)
              }
            }
            if (filesResult.totalFiles) {
              appendPreviewLine(`(${filesResult.totalFiles} total files)`)
            }
          } else if (ur.result.case === "count") {
            // GrepCountResult { counts: GrepFileCount[] }
            const countResult = ur.result.value
            if (countResult.counts) {
              for (const c of countResult.counts) {
                appendPreviewLine(`${c.file}: ${c.count} matches`)
              }
            }
            if (countResult.totalMatches) {
              appendPreviewLine(
                `(${countResult.totalMatches} total matches in ${countResult.totalFiles} files)`
              )
            }
          }
        }
        if (omittedLines > 0) {
          const note = `(... ${omittedLines} additional grep output lines omitted from preview)`
          if (lines.length >= this.GREP_RESULT_PREVIEW_MAX_LINES) {
            lines[this.GREP_RESULT_PREVIEW_MAX_LINES - 1] = note
          } else {
            lines.push(note)
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
   * Format ListMcpResourcesExecResult into a model-friendly string.
   *
   * Preserves enough context for the model to disambiguate between three
   * common error shapes the IDE returns through this oneof:
   *  - success with empty resources (server mounted, exposes 0 resources)
   *  - error: server unreachable / generic transport failure
   *  - rejected: user policy / safety hook denied the call
   *
   * Notably the IDE wraps `Server "X" not found` into the `error` arm even when
   * the server is actually mounted but exposes no resource surface. That edge
   * case is recognized upstream (see the listMcpResourcesExecResult branch in
   * handleToolResult) and rewritten into an empty success before this
   * formatter sees it; if it still reaches here, propagate the message
   * verbatim so the model can decide whether to retry on a different server.
   */
  private formatListMcpResourcesResultTyped(
    result: ListMcpResourcesExecResult
  ): string {
    const r = result.result
    if (r.case === "success") {
      const resources = Array.isArray(r.value.resources)
        ? r.value.resources
        : []
      if (resources.length === 0) {
        return "[list_mcp_resources success] no resources exposed by this server"
      }
      const lines = [
        `[list_mcp_resources success] ${resources.length} resource(s)`,
      ]
      const maxItems = 50
      for (const resource of resources.slice(0, maxItems)) {
        const uri = resource.uri || "(no uri)"
        const name = resource.name ? ` ${resource.name}` : ""
        const description = resource.description
          ? ` — ${resource.description}`
          : ""
        lines.push(`- ${uri}${name}${description}`)
      }
      if (resources.length > maxItems) {
        lines.push(
          `... ${resources.length - maxItems} more resource(s) truncated`
        )
      }
      return lines.join("\n")
    }
    if (r.case === "error") {
      return `[list_mcp_resources error] ${r.value.error || "Unknown error"}`
    }
    if (r.case === "rejected") {
      return `[list_mcp_resources rejected] ${r.value.reason || "Call rejected"}`
    }
    return "list_mcp_resources completed"
  }

  /**
   * Format ReadMcpResourceExecResult into a model-friendly string.
   *
   * Distinguishes the four oneof arms with explicit error wording so the
   * model can tell apart "this URI isn't published by the server" (notFound)
   * from "the server rejected the read" (rejected) from "transport / runtime
   * error" (error). Without these distinctions the model previously got a
   * generic `[file not found] <uri>` fallback that masked policy denials and
   * generic MCP failures behind a misleading `read_file` style envelope.
   */
  private formatReadMcpResourceResultTyped(
    result: ReadMcpResourceExecResult
  ): string {
    const r = result.result
    if (r.case === "success") {
      const v = r.value
      const uri = v.uri || ""
      const mimeType = v.mimeType ? ` (${v.mimeType})` : ""
      const downloadPath = v.downloadPath ? `\nsaved to: ${v.downloadPath}` : ""
      const header = `[read_mcp_resource success] ${uri}${mimeType}${downloadPath}`
      const content = v.content
      if (content.case === "text" && typeof content.value === "string") {
        return `${header}\n\n${content.value}`
      }
      if (content.case === "blob" && content.value) {
        const length = content.value.length || 0
        return `${header}\n\n[binary content: ${length} bytes]`
      }
      return header
    }
    if (r.case === "error") {
      const uri = r.value.uri ? ` (uri: ${r.value.uri})` : ""
      return `[read_mcp_resource error]${uri} ${r.value.error || "Unknown error"}`
    }
    if (r.case === "rejected") {
      const uri = r.value.uri ? ` (uri: ${r.value.uri})` : ""
      return `[read_mcp_resource rejected]${uri} ${r.value.reason || "Call rejected"}`
    }
    if (r.case === "notFound") {
      // Distinguish from a `[file not found]` fallback. notFound here means the
      // MCP server is reachable and accepted the call, but does not publish
      // the requested resource URI; this is a server-surface mismatch, not a
      // filesystem error. Including the URI helps the model decide whether to
      // retry against a different server or list resources first.
      return `[read_mcp_resource not_found] resource "${r.value.uri || "(no uri)"}" is not published by the server`
    }
    return "read_mcp_resource completed"
  }

  /**
   * Global language instruction injected into all model routes.
   * Ensures the model always responds in the same language as the user.
   */
  private static readonly LANGUAGE_INSTRUCTION = [
    "Language usage rules:",
    "- Always respond in the same language the user is writing in.",
    "- Your internal thinking and reasoning (think/thought blocks) must also use the user's language.",
    "- Match the user's language consistently throughout the entire conversation, including explanations, summaries, and follow-up questions.",
    "- Do not switch languages unless the user explicitly asks you to.",
    "- Exception: code comments and commit messages default to English unless the user specifies otherwise.",
  ].join("\n")

  /**
   * Build system prompt from context.
   *
   * Optional `deferredCatalog` argument: when defer-loading is enabled
   * (see `tools/tool-defer-policy.ts`), the cursor-connect-stream layer
   * splits the tool surface into a slim core sent to the upstream and a
   * larger "deferred" set the model can pull on demand via the
   * `discover_tool` tool.  Passing the deferred catalog here causes us
   * to append a `<deferred_tools>` section at the end of the prompt
   * with a one-line index of every available deferred tool, so the
   * model knows what's reachable without paying the full schema cost.
   */
  private buildSystemPrompt(
    context: PromptContext,
    deferredCatalog?: DeferredToolDescriptor[]
  ): string {
    const parts: string[] = []

    if (context.customSystemPrompt) {
      parts.push(context.customSystemPrompt)
    }

    parts.push(this.buildCursorToolUsageSection())

    const cursorSkillPolicy =
      this.cursorSkillsManager.resolvePolicyForPrompt(context)
    const cursorRulesSection = this.buildCursorRulesSection(
      this.resolveEffectiveRulesForPrompt(context, cursorSkillPolicy)
    )
    if (cursorRulesSection) {
      parts.push(cursorRulesSection)
    }
    const cursorSkillsSection = this.cursorSkillsManager.buildCatalogSection(
      cursorSkillPolicy.availableSkills
    )
    if (cursorSkillsSection) {
      parts.push(cursorSkillsSection)
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

    const deferredSection = this.buildDeferredToolsSection(deferredCatalog)
    if (deferredSection) {
      parts.push(deferredSection)
    }

    parts.push(CursorConnectStreamService.LANGUAGE_INSTRUCTION)

    return parts.join("\n\n")
  }

  /**
   * Render the `<deferred_tools>` system-prompt section.  Returns
   * `undefined` when there is nothing to advertise so the caller can
   * skip the join.
   *
   * Layout:
   *   <deferred_tools>
   *   Additional tools are available but not loaded by default. To use
   *   any of them, call `discover_tool({ tool_name: "<name>" })` first;
   *   the bridge will return the full schema and load the tool for the
   *   rest of this session. Names are case-sensitive.
   *
   *   - tool_name: one-line description
   *   - ...
   *   </deferred_tools>
   *
   * The instructional preamble is intentionally short (≤ 60 tokens):
   * each catalog line is ≤ ~50 tokens, so even with 50 deferred tools
   * the section costs ~2.5K tokens — about half the savings vs. the
   * 7K-token schemas we trimmed.
   */
  private buildDeferredToolsSection(
    deferredCatalog?: DeferredToolDescriptor[]
  ): string | undefined {
    if (!deferredCatalog || deferredCatalog.length === 0) return undefined
    const lines: string[] = []
    lines.push("<deferred_tools>")
    lines.push(
      "Additional tools are available but their full schemas are not " +
        "loaded by default to save context. To use any of the tools below, " +
        'call `discover_tool({ tool_name: "<exact_name>" })` first. ' +
        "The bridge returns the full schema and the tool stays loaded for " +
        "the rest of this session — you only need to discover each tool " +
        "once. Names are case-sensitive; do not invent names that aren't " +
        "in this list."
    )
    lines.push("")
    for (const entry of [...deferredCatalog].sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const summary = entry.oneLineDescription || "(no description)"
      lines.push(`- ${entry.name}: ${summary}`)
    }
    lines.push("</deferred_tools>")
    return lines.join("\n")
  }

  private buildCodexSystemPrompt(
    context: PromptContext,
    deferredCatalog?: DeferredToolDescriptor[]
  ): string {
    const parts: string[] = []

    if (context.customSystemPrompt) {
      parts.push(context.customSystemPrompt)
    }

    parts.push(this.buildCodexToolUsageSection())

    const cursorSkillPolicy =
      this.cursorSkillsManager.resolvePolicyForPrompt(context)
    const cursorRulesSection = this.buildCursorRulesSection(
      this.resolveEffectiveRulesForPrompt(context, cursorSkillPolicy)
    )
    if (cursorRulesSection) {
      parts.push(cursorRulesSection)
    }
    const cursorSkillsSection = this.cursorSkillsManager.buildCatalogSection(
      cursorSkillPolicy.availableSkills
    )
    if (cursorSkillsSection) {
      parts.push(cursorSkillsSection)
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

    const deferredSection = this.buildDeferredToolsSection(deferredCatalog)
    if (deferredSection) {
      parts.push(deferredSection)
    }

    parts.push(CursorConnectStreamService.LANGUAGE_INSTRUCTION)

    return parts.join("\n\n")
  }

  private buildGoogleSystemPrompt(context: PromptContext): string {
    const parts: string[] = []
    if (context.customSystemPrompt) {
      parts.push(context.customSystemPrompt)
    }
    parts.push(this.buildGoogleToolUsageSection())
    parts.push(this.buildGooglePlanningOverrideSection())
    if (context.explicitContext) {
      parts.push("Explicit Context:\n" + context.explicitContext)
    }
    // Language instruction is injected via the interleaved thinking hint in
    // google.service.ts, so we skip it here to avoid duplicate injection.
    return parts.join("\n\n")
  }

  private buildCursorToolUsageSection(): string {
    return [
      "Using your tools:",
      "- Prefer dedicated tools over run_terminal_command when one fits the task. Dedicated tools keep the session structured and reviewable, and the IDE renders their output natively.",
      "- To inspect file contents, prefer read_file over cat, sed, head, or tail.",
      "- To search file contents, prefer grep_search over grep or rg.",
      "- To discover files or inspect directory contents, prefer glob_search, file_search, or list_directory over find or ls.",
      "- To edit or create files, prefer edit_file_v2 over sed, awk, perl, python, cat heredoc, tee, or echo redirection. To create a new file, call edit_file_v2 with search set to an empty string and replace set to the full file content. To replace every occurrence of a string in a file, set replace_all: true; otherwise the edit fails when search matches more than once.",
      "- Before editing an existing file, read the file in the current conversation and copy a small unique search snippet verbatim from read_file output. Do not include any display-only line number prefixes.",
      "- run_terminal_command remains the right choice for build/test execution, system commands, scripts that compute or verify something, or work that no structured tool can express. The bridge will block shell file writes whose targets land inside the workspace; ephemeral paths (/tmp, smoke fixtures, OS temp dirs) and read-only commands run normally.",
      "- If the task already requires a report, artifact, or file edit and you have enough evidence, perform that write now instead of only saying that you will do it next.",
      "- If multiple tool calls are independent, make them in parallel. If one depends on another, run them sequentially.",
    ].join("\n")
  }

  private buildCodexToolUsageSection(): string {
    return [
      "Using your tools:",
      "- Prefer dedicated tools over run_terminal_command when one fits the task. Dedicated tools keep the session structured and reviewable, and the IDE renders their output natively.",
      "- To inspect file contents, prefer read_file over cat, sed, head, or tail.",
      "- To search file contents, prefer grep_search over grep or rg.",
      "- To discover files or inspect directory contents, prefer glob_search, file_search, or list_directory over find or ls.",
      "- To edit or create files, prefer edit_file_v2 over sed, awk, perl, python, cat heredoc, tee, or echo redirection. To create a new file, call edit_file_v2 with search set to an empty string and replace set to the full file content. To replace every occurrence of a string in a file, set replace_all: true; otherwise the edit fails when search matches more than once.",
      "- Before editing an existing file, read the file in the current conversation and copy a small unique search snippet verbatim from read_file output. Do not include any display-only line number prefixes.",
      "- If you need to continue an existing shell session, use write_shell_stdin instead of starting a fresh run_terminal_command.",
      "- Prefer MCP resources over web_search when the required context is available from a configured MCP server.",
      "- run_terminal_command remains the right choice for build/test execution, system commands, scripts that compute or verify something, or work that no structured tool can express. The bridge will block shell file writes whose targets land inside the workspace; ephemeral paths (/tmp, smoke fixtures, OS temp dirs) and read-only commands run normally.",
      "- If the task already requires a report, artifact, or file edit and you have enough evidence, perform that write now instead of only saying that you will do it next.",
      "- If multiple tool calls are independent, make them in parallel. If one depends on another, run them sequentially.",
    ].join("\n")
  }

  private buildGoogleToolUsageSection(): string {
    return [
      "Using your tools:",
      "- Do NOT use run_command when a relevant dedicated tool is available. This is critical because dedicated tools keep the session structured and reviewable.",
      "- To inspect file contents, use view_file instead of cat, sed, head, or tail.",
      "- To search file contents, use grep_search instead of grep or rg.",
      "- To inspect directory contents, use list_dir instead of ls or find.",
      "- To edit existing files, use replace_file_content or multi_replace_file_content instead of sed, awk, perl, python, or shell patching.",
      "- To create new files, use write_to_file instead of cat with heredoc, echo redirection, or other shell-based file creation.",
      "- Before editing, call view_file in the current conversation and copy a small unique TargetContent verbatim from the file text only. Do not include any display-only line number prefixes.",
      "- If the task already requires a report, artifact, or file edit and you have enough evidence, perform that write now instead of only saying that you will do it next.",
      "- Reserve run_command for build/test execution, system commands, or tasks where no structured tool can express the work.",
      "- If multiple tool calls are independent, make them in parallel. If one depends on another, run them sequentially.",
      "",
      "Code analysis and research discipline:",
      "- BEFORE making any code change, you MUST first use tools to thoroughly understand the full architecture and call chain involved. Read the actual source — do NOT rely on thinking or memory to infer how code works.",
      "- Trace call chains end-to-end: for any function or method you plan to modify, use grep_search to find ALL callers and callees, then view_file each one. Understand the complete caller → target → downstream path before changing anything.",
      "- Read type definitions, interfaces, and data contracts that govern the code you are touching. Use grep_search to locate them, then view_file to understand the shape and invariants.",
      "- When exploring an unfamiliar area, follow this sequence: list_dir to map the directory structure → grep_search to locate key symbols and entry points → view_file to read implementations and understand design intent. Do this iteratively until the full picture is clear.",
      "- Make parallel tool calls to gather information from multiple files simultaneously. Cross-cutting concerns (e.g., a type used across 5 files) should be investigated in bulk, not one file at a time.",
      "- Do not guess file paths, function signatures, data flows, or call relationships. Look them up. A wrong assumption that propagates into an edit is far more costly than an extra tool call.",
      "- If a change touches a boundary between components (e.g., an interface, a shared type, a protocol contract), read BOTH sides of the boundary before editing either side.",
    ].join("\n")
  }

  private buildGooglePlanningOverrideSection(): string {
    return [
      "Planning mode override:",
      "- Do NOT create implementation_plan.md or walkthrough.md files. Present your implementation plan and walkthrough directly in the conversation response instead.",
      "- task.md is still allowed as a file artifact for tracking progress during execution.",
    ].join("\n")
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

    const cursorSkillPolicy =
      this.cursorSkillsManager.resolvePolicyForPrompt(context)
    const ruleContents = this.resolveEffectiveRuleContentsForPrompt(
      context,
      cursorSkillPolicy
    )
    if (ruleContents.length > 0) {
      contextMessages.push({
        role: "user",
        content: "<user_rules>\n" + ruleContents.join("\n") + "\n</user_rules>",
      })
    } else {
      contextMessages.push({
        role: "user",
        content:
          "<user_rules>\nThe user has not defined any custom rules.\n</user_rules>",
      })
    }
    const cursorSkillsSection = this.cursorSkillsManager.buildCatalogSection(
      cursorSkillPolicy.availableSkills
    )
    if (cursorSkillsSection) {
      contextMessages.push({
        role: "user",
        content: `<cursor_skills>\n${cursorSkillsSection}\n</cursor_skills>`,
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
        "If there is an obvious task from the user, proceed directly on that task without spending turns on task-boundary bookkeeping.",
        "Only rely on tools that are actually present in this request; do not mention or depend on absent meta-tools.",
        "</no_active_task_reminder>",
        "</EPHEMERAL_MESSAGE>",
      ]
      contextMessages.push({ role: "user", content: ephLines.join("\n") })
    }

    return contextMessages
  }

  private truncateText(text: string, maxChars: number): string {
    const normalized = text.replace(/\s+/g, " ").trim()
    if (normalized.length <= maxChars) {
      return normalized
    }
    return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
  }

  private resolveEffectiveRulesForPrompt(
    context: PromptContext,
    skillPolicy = this.cursorSkillsManager.resolvePolicyForPrompt(context)
  ): Array<CursorRule | string> {
    const cursorRules = skillPolicy.promptRules
    const kbRules = this.knowledgeBaseService
      .list()
      .map((item) => item.knowledge?.trim() ?? "")
      .filter((content) => content.length > 0)

    const seen = new Set<string>()
    const merged: Array<CursorRule | string> = []
    for (const rule of [...cursorRules, ...kbRules]) {
      const content = this.getCursorRuleContent(rule).trim()
      if (!content) {
        continue
      }
      if (seen.has(content)) {
        continue
      }
      seen.add(content)
      merged.push(rule)
    }
    return merged
  }

  private resolveEffectiveRuleContentsForPrompt(
    context: PromptContext,
    skillPolicy = this.cursorSkillsManager.resolvePolicyForPrompt(context)
  ): string[] {
    return this.resolveEffectiveRulesForPrompt(context, skillPolicy)
      .map((rule) => this.getCursorRuleContent(rule).trim())
      .filter((content) => content.length > 0)
  }

  private getCursorRuleContent(rule: CursorRule | string): string {
    return typeof rule === "string" ? rule : (rule.content ?? "")
  }

  private buildCursorRulesSection(
    rules?: Array<CursorRule | string>
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
   * Build backend-agnostic thinking intent for Cursor requests.
   *
   * The intent stays semantic at this layer and is serialized by each backend
   * into its own wire format later.
   */
  private buildCursorThinkingIntent(
    thinkingLevel: number,
    model: string,
    requestedEffort?: string
  ) {
    return buildThinkingIntentFromCursorRequest({
      model,
      thinkingLevel,
      requestedEffort,
    })
  }

  private resolveRequestedReasoningEffort(
    requestedModelParameters?: Record<string, string>
  ): string | undefined {
    if (!requestedModelParameters) {
      return undefined
    }

    const exactIds = [
      "thinking",
      "reasoning",
      "reasoning_effort",
      "thinking_effort",
      "effort_mode",
      "cloud_agent_effort_mode",
      "prompt_effort_level",
      "effort",
    ]

    for (const id of exactIds) {
      const normalized = this.normalizeRequestedReasoningEffort(
        requestedModelParameters[id]
      )
      if (normalized) {
        return normalized
      }
    }

    for (const [id, rawValue] of Object.entries(requestedModelParameters)) {
      const looksLikeReasoningControl =
        id.includes("reason") ||
        id.includes("think") ||
        (id.includes("effort") && !id.includes("discovery"))
      if (!looksLikeReasoningControl) {
        continue
      }

      const normalized = this.normalizeRequestedReasoningEffort(rawValue)
      if (normalized) {
        return normalized
      }
    }

    return undefined
  }

  private resolveRequestedCodexServiceTier(
    requestedModelParameters?: Record<string, string>
  ): string | undefined {
    const defaultServiceTier = this.codexService.getDefaultServiceTier()
    if (!requestedModelParameters) {
      return defaultServiceTier
    }

    const normalizeValue = (rawValue?: string): string | undefined => {
      if (!rawValue) {
        return undefined
      }

      const normalized = rawValue
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")

      switch (normalized) {
        case "priority":
        case "fast":
        case "true":
        case "on":
        case "enabled":
        case "1":
          return "priority"
        default:
          return undefined
      }
    }

    const exactIds = ["service_tier", "fast_mode", "fast"]
    for (const id of exactIds) {
      const resolved = normalizeValue(requestedModelParameters[id])
      if (resolved) {
        return resolved
      }
    }

    for (const [id, rawValue] of Object.entries(requestedModelParameters)) {
      if (
        !id.includes("fast") &&
        !id.includes("tier") &&
        !id.includes("speed")
      ) {
        continue
      }
      const resolved = normalizeValue(rawValue)
      if (resolved) {
        return resolved
      }
    }

    return defaultServiceTier
  }

  private shouldSuppressThinkingSummaryForRoute(
    backend: BackendType,
    requestedModelParameters: Record<string, string> | undefined,
    explicitSuppress?: boolean
  ): boolean {
    if (explicitSuppress === true) {
      return true
    }
    if (backend !== "codex") {
      return false
    }
    return (
      this.resolveRequestedCodexServiceTier(requestedModelParameters) ===
      "priority"
    )
  }

  private normalizeRequestedReasoningEffort(
    rawValue?: string
  ): RequestedThinkingEffort | undefined {
    return normalizeRequestedThinkingEffort(rawValue)
  }

  // buildToolDefinitions removed — now using buildToolsForApi from cursor-tool-mapper.ts

  /**
   * Generate conversation ID
   */
  private generateConversationId(): string {
    return `conv_${Date.now()}_${Math.random().toString(36).substring(7)}`
  }
}
